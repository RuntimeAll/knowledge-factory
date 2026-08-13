/**
 * app/api/mcp/tools.ts —— MCP 工具实现层
 *   · 三个系统工具 health / integrity_check / backup_now（AI:PRD-001 · WP5）
 *   · 两个考点工具 resolve_kp / kp_context（AI:PRD-002 · 002-C）
 *   · 三个录题工具 kb_ingest / propose_question / get_ingest_batch（AI:PRD-003 · 003-D）
 *   · 两个检索工具 search_questions / get_question（AI:PRD-004 · 004-B）
 *
 * 为什么和 route.ts 分家：route.ts 是「注册表」，只负责把工具挂到 mcp-handler 上；
 * 真正的入参 schema、错误分类、返回外壳全在这儿 —— 这样单测能直接调函数，
 * 不用为了测一句 try/catch 去起一个 HTTP 服务（tests/mcp.test.ts 就是这么测的）。
 *
 * 🔴 依赖红线：本文件在 src/app/** 下，只准 import `~/core`（ESLint 已做成红灯）。
 *    工具是壳，逻辑在 core —— 壳里绝不许自己开库、自己写行。
 *
 * ── 返回外壳（三工具统一） ───────────────────────────────────────────────
 *   成功：{ ok: true,  tool, data: <core 的原始报告，一个字段不删> }
 *   失败：{ ok: false, code, message, recoverable }      ← REG-G2 错误契约口径
 *
 * 🔴 外壳的 ok ≠ 业务结论的 ok。这两层必须分开看：
 *      envelope.ok  = 「这次调用跑通了吗」（跑通=true，异常=false）
 *      data.ok      = 「体检/对账的结论是好是坏」（对账见红时 data.ok=false）
 *    所以 integrity_check 查出红旗时，返回的是 `{ok:true, data:{ok:false,…}}` 且
 *    **不带 isError** —— 那是一次成功的调用，只不过结论难看。把它标成 isError
 *    会让 agent 以为工具坏了去重试，而不是去修数据。
 *
 * 🔴 绝不让异常裸穿：任何 throw 都在这里被收成上面那个 shape 再返回，
 *    transport 层不会看到 500。agent 拿到 500 只能干瞪眼，拿到 code 才能自愈。
 */
import { z } from "zod";

import {
  IngestError,
  KgError,
  KpNotFoundError,
  QueueError,
  RetrievalError,
  backupNow,
  getIngestBatch,
  getQuestion,
  health,
  ingestPayloadSchema,
  integrityCheck,
  itemReds,
  kpContext,
  proposeItemSchema,
  proposeQuestion,
  resolveKp,
  runIngestBatch,
  searchParamsSchema,
  searchQuestions,
  sourceDocSchema,
  type BackupResult,
  type HealthReport,
  type IngestBatchRecord,
  type IngestCounts,
  type IntegrityReport,
  type KpCandidate,
  type KpContextCard,
  type PrecheckRed,
  type ProposeQuestionResult,
  type QuestionCard,
  type ResolveKpResult,
  type SearchHit,
  type SearchResult,
} from "~/core";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 调用跑通了 */
export interface ToolOk<T> {
  ok: true;
  tool: ToolName;
  data: T;
}

/**
 * 调用没跑通（REG-G2 错误契约的最小集：code / message / recoverable）。
 *
 * 🔴 candidates 是 KP_NOT_FOUND 专用的**自愈料**（AI:PRD-002 · 002-C）：
 *    agent 编了个 kp_id，光说「不存在」等于让它干瞪眼；把最近似的真考点
 *    塞进错误体里，它下一步就能自己改对（REG-B4 / 验收 2-2 的正主）。
 *    系统三工具仍然不产生它 —— 它们的失败只有「环境不对」一类。
 */
export interface ToolErr {
  ok: false;
  tool: ToolName;
  /** 稳定错误码，见 TOOL_ERROR_CODES */
  code: ToolErrorCode;
  /** 人话 + 可操作：说清楚怎么才能跑通 */
  message: string;
  /** 能不能原样重试一次就过；false = 停下来改环境/叫人 */
  recoverable: boolean;
  /** 只在 KP_NOT_FOUND 时带：最近似的真考点（可能为空数组，见 message） */
  candidates?: KpCandidate[];
}

export type ToolPayload<T> = ToolOk<T> | ToolErr;

export type ToolName =
  | "health"
  | "integrity_check"
  | "backup_now"
  | "resolve_kp"
  | "kp_context"
  | "kb_ingest"
  | "propose_question"
  | "get_ingest_batch"
  | "search_questions"
  | "get_question";

export const TOOL_NAMES: readonly ToolName[] = [
  "health",
  "integrity_check",
  "backup_now",
  "resolve_kp",
  "kp_context",
  "kb_ingest",
  "propose_question",
  "get_ingest_batch",
  "search_questions",
  "get_question",
];

/**
 * 错误码表（稳定枚举，改文案时别顺手改它）：
 *   CONFIG_MISSING  环境变量没配（DATABASE_URL / GRADING_DB_URL）——改 .env 再来
 *   DB_UNREACHABLE  库文件打不开（路径不对 / 文件不在 / 权限）——不是重试能好的
 *   DB_BUSY         库被别人锁着（SQLITE_BUSY）——过一会儿重试有戏
 *   IO_ERROR        磁盘侧失败（备份目录写不进、异地目录不可达）
 *   KP_NOT_FOUND    🆕 考点 id 库里没有（多半是编的）——错误体里带 candidates
 *   INVALID_INPUT   🆕 入参没过校验（空查询串 / 契约结构错）——改参数再来
 *   NOT_FOUND       🆕 指名道姓要的那行东西库里没有（batch_id 写错之类）
 *   QUESTION_NOT_FOUND 🆕 题 id 库里没有。🔴 与 KP_NOT_FOUND 不同，它**给不出 candidates**：
 *                   考点 id 里常能读出人话（`kp_绝对值`→"绝对值"）所以猜得出近似的，
 *                   题 id 是纯 ULID，一个语义字符都没有，硬猜只会误导 ——
 *                   如实留空 + 在 message 里指路（改调 search_questions）。
 *   INTERNAL        没归到上面任何一类的意外
 */
export const TOOL_ERROR_CODES = [
  "CONFIG_MISSING",
  "DB_UNREACHABLE",
  "DB_BUSY",
  "IO_ERROR",
  "KP_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "INVALID_INPUT",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// 入参 schema（zod v4；registerTool 吃的是完整 Standard Schema，不是裸 shape）
// ---------------------------------------------------------------------------

export const healthInput = z.object({
  deep: z
    .boolean()
    .optional()
    .describe(
      "顺带全量重算审计链（行多会慢）。默认 false，只报链尾游标，毫秒级返回。",
    ),
});

/** 无入参。仍显式给一个空对象 schema：tools/list 里 inputSchema 缺席会让部分客户端犯难。 */
export const integrityCheckInput = z.object({});

/**
 * 🔴 只暴露三个 reason。'pre-restore' 是恢复演练（scripts/restore-drill.ts）
 *    动手前的保命快照，属于人跑的流程，不给 agent 当日常按钮。
 */
export const backupNowInput = z.object({
  reason: z
    .enum(["daily", "batch", "manual"])
    .optional()
    .describe(
      "快照缘由：daily=每日 / batch=批次提交后 / manual=临时手动。默认 manual。",
    ),
});

export const resolveKpInput = z.object({
  query: z
    .string()
    .describe(
      "要找的考点，一句人话就行：'绝对值' / '一元一次方程' / '有理数加减'。" +
        "支持子串模糊（查'绝对值'能命中'绝对值的化简'），也支持别名。",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("返回几条候选，默认 8。"),
});

export const kpContextInput = z.object({
  kp_id: z
    .string()
    .describe(
      "考点 id（形如 kp_01J…）。🔴 必须是 resolve_kp 给的真 id，不许自己编。",
    ),
});

// ── AI:PRD-003 · 003-D 录题三工具 ──────────────────────────────────────────

/**
 * kb-ingest/v1 的 payload **原样**当入参，只多挂一个 dry_run。
 *
 * 🔴 复用 core 的 zod 正本（`ingest-schema.ts`），不在这儿抄一份字段表 ——
 *    抄出来的那份迟早跟契约漂。加新键用 `.extend()` 是允许的
 *    （zod v4 只禁止在带 refinement 的对象上**覆盖已有键**）。
 */
export const kbIngestInput = ingestPayloadSchema.extend({
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "只验不写：跑完全套闸、返回逐题结论，但库与磁盘一个字节都不动。默认 false。",
    ),
});

export const proposeQuestionInput = z.object({
  item: proposeItemSchema.describe(
    "一道题（kb-ingest/v1 的 items[] 元素；单题时 seq 可省）。",
  ),
  source: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("喂料方标识（skill/脚本@版本）。默认 propose@agent。"),
  source_doc: sourceDocSchema
    .optional()
    .describe("批级源文档；prov.type='scan' 时必给。"),
  note: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("写给审的人的一句话：这题哪儿来的、为什么值得收。"),
});

export const getIngestBatchInput = z.object({
  batch_id: z
    .string()
    .trim()
    .min(1)
    .describe("批 id（形如 batch_01J…），来自 kb_ingest 的返回。"),
});

// ── AI:PRD-004 · 004-B 检索两工具 ──────────────────────────────────────────

/**
 * 检索入参 = core 契约正本（`retrieval.ts` 的 zod）**原样**，一个字段都不在这儿抄。
 *
 * 🔴 与 kb_ingest 同一条纪律：抄出来的第二份迟早跟正本漂，
 *    而"工具 schema 说能传、core 不认"这种漂移只有 agent 撞上了才发现。
 */
export const searchQuestionsInput = searchParamsSchema;

export const getQuestionInput = z.object({
  question_id: z
    .string()
    .trim()
    .min(1)
    .describe(
      "题 id（形如 q_01KZ…）。🔴 必须来自 search_questions 的返回，不许自己编——" +
        "题 id 是纯 ULID，编错了系统连「最像的候选」都给不出（只能让你重新查一遍）。",
    ),
});

export type HealthArgs = z.infer<typeof healthInput>;
export type IntegrityCheckArgs = z.infer<typeof integrityCheckInput>;
export type BackupNowArgs = z.infer<typeof backupNowInput>;
export type ResolveKpArgs = z.infer<typeof resolveKpInput>;
export type KpContextArgs = z.infer<typeof kpContextInput>;
export type KbIngestArgs = z.infer<typeof kbIngestInput>;
export type ProposeQuestionArgs = z.infer<typeof proposeQuestionInput>;
export type GetIngestBatchArgs = z.infer<typeof getIngestBatchInput>;
export type SearchQuestionsArgs = z.infer<typeof searchQuestionsInput>;
export type GetQuestionArgs = z.infer<typeof getQuestionInput>;

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

function textOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // cause 常是另一个 Error（libsql 把底层 SQLITE_* 藏在这儿），
  // 不带上就只剩一句「failed to connect」这种没用的外皮。
  const cause =
    e.cause instanceof Error
      ? e.cause.message
      : typeof e.cause === "string"
        ? e.cause
        : e.cause == null
          ? ""
          : JSON.stringify(e.cause);
  return cause ? `${e.message} (cause: ${cause})` : e.message;
}

/**
 * 把一个异常翻译成错误契约。
 *
 * 匹配靠错误文本 —— libsql/node 抛的东西没有统一的 code 字段可认，
 * 与其假装有，不如把匹配规则摊在这里让人能改。归不了类就 INTERNAL，
 * 但 message 一定带上原文，不吞。
 */
export function classifyToolError(tool: ToolName, e: unknown): ToolErr {
  // 🔴 先认业务异常：它们自带稳定 code，别让下面的文本匹配去猜。
  if (e instanceof KpNotFoundError) {
    return {
      ok: false,
      tool,
      code: "KP_NOT_FOUND",
      message: e.message,
      // 可重试 = 「换个 id 再调一次就有戏」，候选就在下面
      recoverable: true,
      candidates: e.candidates,
    };
  }
  // 🔴 契约结构错（整批拒）= 喂料方自己改得对的事 ⇒ INVALID_INPUT + 可重试。
  //    闸的人话（缺哪个字段、该长什么样）原样带出去，别缩成一句「参数错误」。
  if (e instanceof IngestError) {
    return {
      ok: false,
      tool,
      code: "INVALID_INPUT",
      message: `${tool} 契约不合格[${e.code}]：${e.message}`,
      recoverable: true,
    };
  }
  // 🔴 检索侧的两个稳定码直接映射；QUESTION_NOT_FOUND 恒带一个**空** candidates，
  //    这样 agent 的处理分支与 KP_NOT_FOUND 一致（都读 candidates），
  //    而"空"本身就是如实的信息：题 id 无从模糊匹配，只能回去重查。
  if (e instanceof RetrievalError) {
    return {
      ok: false,
      tool,
      code:
        e.code === "QUESTION_NOT_FOUND"
          ? "QUESTION_NOT_FOUND"
          : "INVALID_INPUT",
      message: `${tool} 失败[${e.code}]：${e.message}`,
      recoverable: true,
      ...(e.code === "QUESTION_NOT_FOUND" ? { candidates: [] } : {}),
    };
  }
  if (e instanceof QueueError) {
    const code: ToolErrorCode =
      e.code === "INVALID_INPUT"
        ? "INVALID_INPUT"
        : e.code === "QUEUE_NOT_FOUND" || e.code === "QUARANTINE_NOT_FOUND"
          ? "NOT_FOUND"
          : "INTERNAL";
    return {
      ok: false,
      tool,
      // 队列的稳定码一律带进 message：翻不成工具码的那些（KIND_MISMATCH /
      // ALREADY_DECIDED …）落 INTERNAL，但读的人得知道 core 到底判了什么
      message: `${tool} 失败[${e.code}]：${e.message}`,
      code,
      recoverable: code !== "INTERNAL",
    };
  }
  if (e instanceof KgError) {
    const code: ToolErrorCode =
      e.code === "KP_NOT_FOUND"
        ? "KP_NOT_FOUND"
        : e.code === "INVALID_INPUT"
          ? "INVALID_INPUT"
          : "INTERNAL";
    return {
      ok: false,
      tool,
      code,
      // KgError 的 code 一律带进 message：翻不成工具码的那些（MERGE_* / TREE_* …）
      // 落 INTERNAL，但读的人得知道 core 到底判了什么
      message: `${tool} 失败[${e.code}]：${e.message}`,
      recoverable: code !== "INTERNAL",
    };
  }

  const raw = textOf(e);
  const lower = raw.toLowerCase();

  let code: ToolErrorCode = "INTERNAL";
  let hint = "";
  let recoverable = false;

  if (/DATABASE_URL|GRADING_DB_URL/.test(raw)) {
    code = "CONFIG_MISSING";
    hint =
      "改 .env 配好这个变量（改完要重启 dev server，Next 不热读 .env），再调一次。";
  } else if (
    lower.includes("sqlite_busy") ||
    lower.includes("database is locked")
  ) {
    code = "DB_BUSY";
    recoverable = true;
    hint =
      "库被别的写事务占着。等几秒原样重试；反复不好就查是不是有人开了闸没关。";
  } else if (
    lower.includes("sqlite_cantopen") ||
    lower.includes("unable to open") ||
    lower.includes("enoent") ||
    lower.includes("no such file") ||
    raw.includes("只支持 file:")
  ) {
    code = "DB_UNREACHABLE";
    hint =
      "库文件路径不对或文件不在。核对 .env 的 DATABASE_URL 与 data/ 下的实际文件名。";
  } else if (
    lower.includes("eacces") ||
    lower.includes("eperm") ||
    lower.includes("enospc") ||
    lower.includes("ebusy")
  ) {
    code = "IO_ERROR";
    hint =
      "磁盘侧失败（权限/占用/空间）。看看备份目录能不能写、盘还有没有空间。";
  } else {
    hint =
      "没归到已知类别，按原文排查；反复出现就把它加进 classifyToolError 的规则表。";
  }

  return {
    ok: false,
    tool,
    code,
    message: `${tool} 失败：${raw}${hint ? ` —— ${hint}` : ""}`,
    recoverable,
  };
}

async function run<T>(
  tool: ToolName,
  body: () => Promise<T>,
): Promise<ToolPayload<T>> {
  try {
    return { ok: true, tool, data: await body() };
  } catch (e) {
    return classifyToolError(tool, e);
  }
}

// ---------------------------------------------------------------------------
// 三个工具
// ---------------------------------------------------------------------------

/** 本地体检：库可达 / 表数 / 审计链尾 / 静息闸 / journal_mode。 */
export function runHealth(
  args: HealthArgs = {},
): Promise<ToolPayload<HealthReport>> {
  return run("health", () => health({ deep: args.deep ?? false }));
}

/** 对账六项 C1~C6（含圣域 审核.db 只读的 C4/C5）。 */
export function runIntegrityCheck(
  _args: IntegrityCheckArgs = {},
): Promise<ToolPayload<IntegrityReport>> {
  return run("integrity_check", () => integrityCheck());
}

/** VACUUM INTO 快照（+ 配了 BACKUP_REMOTE_DIR 就再复制一份异地）。 */
export function runBackupNow(
  args: BackupNowArgs = {},
): Promise<ToolPayload<BackupResult>> {
  return run("backup_now", () =>
    backupNow({ reason: args.reason ?? "manual" }),
  );
}

/** 一句人话 → 候选考点（考点的唯一入口）。 */
export function runResolveKp(
  args: ResolveKpArgs,
): Promise<ToolPayload<ResolveKpResult>> {
  return run("resolve_kp", () =>
    resolveKp(args.query, { limit: args.limit, actor: "agent" }),
  );
}

/** 一个考点 → 卡片包（口径 / 别名 / 教材落点 / 挂载计数）。 */
export function runKpContext(
  args: KpContextArgs,
): Promise<ToolPayload<KpContextCard>> {
  return run("kp_context", () => kpContext(args.kp_id));
}

// ---------------------------------------------------------------------------
// 录题三工具（AI:PRD-003 · 003-D）
// ---------------------------------------------------------------------------

/** 逐题小结（wire 上给这个，全账留库里 —— 60 题 × 9 闸的详账没人在对话里读） */
export interface KbIngestItemBrief {
  seq: number;
  /**
   * accepted     落库了，干净
   * needs_review 落库了，但带题干图 ⇒ 已开图审工单，审完才算数
   * rejected     没落库，进了隔离区（改完走 get_ingest_batch 看账、或在队列页改判重投）
   */
  verdict: "accepted" | "needs_review" | "rejected";
  questionId: string | null;
  reds: PrecheckRed[];
}

export interface KbIngestData {
  batchId: string | null;
  dryRun: boolean;
  contractVer: string;
  source: string;
  counts: IngestCounts;
  perItem: KbIngestItemBrief[];
  questionIds: string[];
  /** 开出来的人审工单（题干图必审） */
  queueIds: string[];
  /** 进隔离区的行 */
  quarantineIds: string[];
  backupPath: string | null;
  /** 🔴 明确告诉 agent 全账在哪 —— 不然它只会以为「报告就这么多」 */
  fullReport: string;
}

/**
 * 批量录题（唯一入口）。
 * 🔴 逐题小结上 wire，全账落 `ingest_batch.gate_report_json`（get_ingest_batch 取）。
 */
export function runKbIngest(
  args: KbIngestArgs,
): Promise<ToolPayload<KbIngestData>> {
  return run("kb_ingest", async () => {
    const { dry_run: dryRun, ...payload } = args;
    const r = await runIngestBatch(payload, {
      actor: "agent",
      dryRun: dryRun === true,
    });
    return {
      batchId: r.batchId,
      dryRun: r.dryRun,
      contractVer: r.contractVer,
      source: r.source,
      counts: r.counts,
      perItem: r.gateReport.items.map((it) => ({
        seq: it.seq,
        verdict:
          it.verdict === "rejected"
            ? ("rejected" as const)
            : it.reviewRequired
              ? ("needs_review" as const)
              : ("accepted" as const),
        questionId: it.questionId,
        reds: itemReds(it),
      })),
      questionIds: r.questionIds,
      queueIds: r.queueIds,
      quarantineIds: r.quarantineIds,
      backupPath: r.backup?.path ?? null,
      fullReport: r.batchId
        ? `逐题逐闸全账在库里：get_ingest_batch({batch_id:"${r.batchId}"})`
        : "dry_run 不落批，全账只在这次返回里（要留账就去掉 dry_run 真跑一次）",
    };
  });
}

/** 提议一道题（提议态，人审转正）。 */
export function runProposeQuestion(
  args: ProposeQuestionArgs,
): Promise<ToolPayload<ProposeQuestionResult>> {
  return run("propose_question", () =>
    proposeQuestion({
      item: args.item,
      source: args.source,
      sourceDoc: args.source_doc,
      note: args.note,
      actor: "agent",
    }),
  );
}

/** 取一次录题批的全账（批行 + gate_report_json 全量 + 隔离计数）。 */
export function runGetIngestBatch(
  args: GetIngestBatchArgs,
): Promise<ToolPayload<IngestBatchRecord>> {
  return run("get_ingest_batch", async () => {
    const rec = await getIngestBatch(args.batch_id);
    if (!rec) {
      // 🔴 查无此批不是「空结果」而是「你给的 id 不对」：报 NOT_FOUND，
      //    回一个空壳会让 agent 以为批跑了但没账。
      throw new QueueError(
        "QUEUE_NOT_FOUND",
        `批 ${args.batch_id} 不在库里 —— 核对 kb_ingest 返回的 batchId（dry_run 不落批，没有 id）。`,
      );
    }
    return rec;
  });
}

// ---------------------------------------------------------------------------
// 检索两工具（AI:PRD-004 · 004-B）
// ---------------------------------------------------------------------------

/**
 * wire 上的一条命中（**瘦身版**）。
 *
 * 🔴 为什么不把 core 的 SearchHit 原样吐出去：命中列表是给 agent「挑」用的，
 *    一次 20 条 × 全文，对话窗口直接被题面淹没。这里只留「够不够格点开看」
 *    所需的字段，全文一律走 get_question —— 与 kb_ingest「小结上 wire、
 *    全账留库里」是同一条纪律。
 */
export interface SearchQuestionsBrief {
  questionId: string;
  stemBrief: string;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  /** 考点名（主考点在前，带 ★ 标） */
  kps: string[];
  rrfScore: number;
  /** 🔴 命中来源：哪条轴、第几名（"为什么它在这儿"看得见） */
  sources: SearchHit["sources"];
}

export interface SearchQuestionsData {
  query: SearchResult["query"];
  total: number;
  candidateCount: number;
  axes: SearchResult["axes"];
  degraded: boolean;
  warnings: string[];
  ms: number;
  hits: SearchQuestionsBrief[];
  /** 🔴 明确告诉 agent 全文在哪 —— 不然它只会以为「就这些了」 */
  fullText: string;
}

function 瘦身(h: SearchHit): SearchQuestionsBrief {
  return {
    questionId: h.questionId,
    stemBrief: h.stemBrief,
    qtype: h.qtype,
    difficulty: h.difficulty,
    solutionGrade: h.solutionGrade,
    status: h.status,
    kps: h.kps.map((k) => (k.isPrimary ? `★${k.name}` : k.name)),
    rrfScore: h.rrfScore,
    sources: h.sources,
  };
}

/** 三路检索（题库的唯一查询入口）。 */
export function runSearchQuestions(
  args: SearchQuestionsArgs,
): Promise<ToolPayload<SearchQuestionsData>> {
  return run("search_questions", async () => {
    const r = await searchQuestions(args);
    return {
      query: r.query,
      total: r.total,
      candidateCount: r.candidateCount,
      axes: r.axes,
      degraded: r.degraded,
      warnings: r.warnings,
      ms: r.ms,
      hits: r.hits.map(瘦身),
      fullText:
        r.hits.length > 0
          ? `题面/答案/解析全文走 get_question({question_id:"${r.hits[0]!.questionId}"})`
          : "本次零命中：放宽条件（去掉难度/题型）或换个说法再查；keywords 走字面、semanticQuery 走语意，两个都给会自动 RRF 融合。",
    };
  });
}

/** 一道题的全量卡片。 */
export function runGetQuestion(
  args: GetQuestionArgs,
): Promise<ToolPayload<QuestionCard>> {
  return run("get_question", () => getQuestion(args.question_id));
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/**
 * JSON.stringify 的 replacer：BigInt → Number/String。
 *
 * 🔴 libsql 的 COUNT(*) 有时回 bigint，裸 stringify 会抛
 *    「Do not know how to serialize a BigInt」—— 那才是真会变成 transport 500 的坑
 *    （异常发生在 catch 之外的序列化阶段）。安全范围内转 number，超了转字符串保精度。
 */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

export function payloadToText(payload: ToolPayload<unknown>): string {
  return JSON.stringify(payload, jsonSafe, 2);
}
