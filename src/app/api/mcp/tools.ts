/**
 * app/api/mcp/tools.ts —— MCP 工具实现层
 *   · 三个系统工具 health / integrity_check / backup_now（AI:PRD-001 · WP5）
 *   · 两个考点工具 resolve_kp / kp_context（AI:PRD-002 · 002-C）
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
  KgError,
  KpNotFoundError,
  backupNow,
  health,
  integrityCheck,
  kpContext,
  resolveKp,
  type BackupResult,
  type HealthReport,
  type IntegrityReport,
  type KpCandidate,
  type KpContextCard,
  type ResolveKpResult,
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
  "health" | "integrity_check" | "backup_now" | "resolve_kp" | "kp_context";

export const TOOL_NAMES: readonly ToolName[] = [
  "health",
  "integrity_check",
  "backup_now",
  "resolve_kp",
  "kp_context",
];

/**
 * 错误码表（稳定枚举，改文案时别顺手改它）：
 *   CONFIG_MISSING  环境变量没配（DATABASE_URL / GRADING_DB_URL）——改 .env 再来
 *   DB_UNREACHABLE  库文件打不开（路径不对 / 文件不在 / 权限）——不是重试能好的
 *   DB_BUSY         库被别人锁着（SQLITE_BUSY）——过一会儿重试有戏
 *   IO_ERROR        磁盘侧失败（备份目录写不进、异地目录不可达）
 *   KP_NOT_FOUND    🆕 考点 id 库里没有（多半是编的）——错误体里带 candidates
 *   INVALID_INPUT   🆕 入参没过校验（空查询串之类）——改参数再来
 *   INTERNAL        没归到上面任何一类的意外
 */
export const TOOL_ERROR_CODES = [
  "CONFIG_MISSING",
  "DB_UNREACHABLE",
  "DB_BUSY",
  "IO_ERROR",
  "KP_NOT_FOUND",
  "INVALID_INPUT",
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

export type HealthArgs = z.infer<typeof healthInput>;
export type IntegrityCheckArgs = z.infer<typeof integrityCheckInput>;
export type BackupNowArgs = z.infer<typeof backupNowInput>;
export type ResolveKpArgs = z.infer<typeof resolveKpInput>;
export type KpContextArgs = z.infer<typeof kpContextInput>;

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
