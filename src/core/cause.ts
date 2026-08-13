/**
 * core/cause.ts —— 错因域写原语 + 读侧（AI:PRD-006 · 006-B）
 *
 * 错因域四张表（M1 §3.D）在 001 建库时就建好了，一直空着。本文件是它们的门：
 *
 *   error_cause    错因实体（「去括号：括号前是负号时每一项都要变号」这种一句话能说清的东西）
 *   kp_error       考点 ↔ 错因候选集（M1：判错因的候选 = 主考点的挂载集）
 *   cause_example  错因 ↔ 诊断例题（每错因 ≥2 道，🔴 软闸：提示不硬拦）
 *   err_code_map   🔴 **复合键 (kp_id, err_code)** ：产线七码 → 错因实体的翻译表
 *   roster         学员维度表（🔴 只落代号）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 err_code_map 为什么非得是复合键（M1 · D-12，006 备料 §四实证）
 *
 *   产线的错因词表（`订阅特训/_产线/err_kp.json` v1.0.0）自我声明的 scope 只有
 *   「七上 有理数混合运算」，但产线**把这七码借给了整式线和绝对值线**：
 *
 *     dist 在混合运算线 = 运算律简算（分配律正逆用/提公因数/凑整）
 *     dist 在整式线     = 去括号（每项变号）／合并同类项    ← 同一个码，两回事
 *
 *   实证链：题单 `kp_group` 分别写「运算律简算」与「去括号/合并同类项」；
 *   产线自己的 `render_feedback._mastery()` 在有效码 <3 时会退到 kp_group 重算，
 *   已交付报告（洛天熙 第02天）印的是「合并同类项 6/6 ／ 去括号 8/8」，
 *   **不是**「运算律简算 14/14」—— 渲染层早就把 dist 当两个实体在用了。
 *
 *   所以翻译表的键必须是 (考点, 码) 而不是 (码)：同一个 `dist`，挂在
 *   kp「有理数运算的简便技巧」下是一个错因，挂在 kp「去括号法则」下是另一个。
 *   单键表会把「绝对值几何意义不会」和「脱号时忘判正负」并成一个数。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 写全部走 withCoreWrite（唯一写入口）：错因域四表 + roster 都在 AUDITED_TABLES 里，
 *    漏报一行 rowRefs = 对账 C1(a) 当场红旗。复合键行的 rowRef.id 一律用 rowRefId() 拼，
 *    别手写 `a|b`（读侧 idExpr 的口径在 integrity.ts，两边必须同一把尺子）。
 *
 * 🔴 kpRef 一律**精确解析**（复用 model.ts 的 resolveKpRef，与录题闸③ 同一条尺子）：
 *    错因挂错考点 = 群错误率把两种能力并成一个数，比挂错一道题影响面大。
 *
 * 🔴 种子数据的灌入不在本文件的职责里（那是 006-C 的活）。本文件只提供原语，
 *    并保证「错因域全空」时读侧函数照样给得出诚实的空形态。
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  causeExample,
  errCodeMap,
  errorCause,
  kp,
  kpError,
  question,
  roster,
} from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import { newId } from "./ids";
import { rowRefId } from "./integrity";
import { ModelError, resolveKpRef, type ResolvedKpRef } from "./model";
import { type KpCandidate } from "./resolve";
import { stemBrief } from "./retrieval";
import { nowLocalISO } from "./time";
import { withCoreWrite, type RowRef } from "./write";

// ---------------------------------------------------------------------------
// 契约（字典值与建表 CHECK 一字不差）
// ---------------------------------------------------------------------------

/** error_cause.status 的 CHECK 全集 */
export const CAUSE_STATUSES = ["active", "retired"] as const;
export type CauseStatus = (typeof CAUSE_STATUSES)[number];

/** roster.status 的 CHECK 全集 */
export const ROSTER_STATUSES = ["active", "paused", "closed"] as const;
export type RosterStatus = (typeof ROSTER_STATUSES)[number];

/**
 * 🔴 软闸线：M1 说「每错因 ≥2 诊断例题」。
 *    低于它**只提示不拦**——一个错因刚建出来的时候必然只有 0/1 道例题，
 *    硬拦等于让人没法开工；但少于两道就没法说「这类错长什么样」，所以得一直提醒。
 */
export const CAUSE_EXAMPLE_MIN = 2;

/**
 * 稳定错误码（MCP/页面照它翻人话，改文案别顺手改码）：
 *   INVALID_INPUT      入参没过 zod
 *   CAUSE_NOT_FOUND    错因 id 查无
 *   CAUSE_RETIRED      错因已退役，不许再往上挂新东西
 *   KP_NOT_FOUND       考点查无（错误体里带 candidates）
 *   KP_AMBIGUOUS       一个说法精确命中多个考点 —— 让人指明 kp_id
 *   KP_NOT_ACTIVE      考点不是 active
 *   QUESTION_NOT_FOUND 例题 id 查无
 *   MAP_TAKEN          🔴 (kp_id, err_code) 已经映射过别的错因 —— 改判走先 unmap
 *   MAP_NOT_FOUND      要解的映射本来就不存在
 *   LINK_TAKEN         kp_error / cause_example 这一对已经挂过
 */
export const CAUSE_ERROR_CODES = [
  "INVALID_INPUT",
  "CAUSE_NOT_FOUND",
  "CAUSE_RETIRED",
  "KP_NOT_FOUND",
  "KP_AMBIGUOUS",
  "KP_NOT_ACTIVE",
  "QUESTION_NOT_FOUND",
  "MAP_TAKEN",
  "MAP_NOT_FOUND",
  "LINK_TAKEN",
] as const;
export type CauseErrorCode = (typeof CAUSE_ERROR_CODES)[number];

export class CauseError extends Error {
  readonly code: CauseErrorCode;
  /** KP_NOT_FOUND / KP_AMBIGUOUS 时带：最近似（或全部精确命中）的考点 */
  readonly candidates?: KpCandidate[];
  constructor(
    code: CauseErrorCode,
    message: string,
    candidates?: KpCandidate[],
  ) {
    super(message);
    this.name = "CauseError";
    this.code = code;
    if (candidates) this.candidates = candidates;
  }
}

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new CauseError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

/**
 * kpRef → 真考点，**复用 model.ts 的那把尺子**（只认精确命中 + merged 自动追链）。
 *
 * 🔴 为什么不在这儿再写一遍：两份解析器迟早各自漂一点，而「模型挂考点」与
 *    「错因挂考点」漂开之后，同一句话在两个地方解析成不同考点 —— 这种事只有
 *    出了错才发现。翻译只发生在错误类型上（ModelError → CauseError，码与候选原样带过来）。
 */
async function 解析考点(h: CoreDbHandle, ref: string): Promise<ResolvedKpRef> {
  try {
    return await resolveKpRef(h, ref);
  } catch (e) {
    if (e instanceof ModelError) {
      const code: CauseErrorCode =
        e.code === "KP_NOT_FOUND"
          ? "KP_NOT_FOUND"
          : e.code === "KP_AMBIGUOUS"
            ? "KP_AMBIGUOUS"
            : e.code === "KP_NOT_ACTIVE"
              ? "KP_NOT_ACTIVE"
              : "INVALID_INPUT";
      throw new CauseError(code, e.message, e.candidates);
    }
    throw e;
  }
}

const 错因id = z
  .string()
  .trim()
  .refine(
    (s) => /^ec_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "错因 id 形状不对：应形如 ec_<26位ULID>",
  );

const 题id = z.string().trim().min(1, "题 id 不能为空");

// ---------------------------------------------------------------------------
// ① error_cause：建 / 退役
// ---------------------------------------------------------------------------

export interface CreateErrorCauseInput {
  /** 错因名（一句话能说清「错在哪」，例：「去括号：括号前是负号时每一项都要变号」） */
  name: string;
  /** 展开说明：什么样的题会踩、踩了长什么样 */
  desc?: string;
  /**
   * 种子来源编码。
   * 🔴 备料实证：**MaE55 在本工作区没有正本**（六个搜索面零命中实体定义，
   *    只有 PRD 文档里的名字引用）。所以现阶段的合法写法是 `err_kp:v1.0.0/<code>`
   *    这类**指得回去**的来源串；🔴 绝不许凭 "MaE55" 这个名字编 55 个码。
   */
  seedCode?: string;
  status?: CauseStatus;
  actor?: AuditActor;
  handle?: CoreDbHandle;
}

export interface CreateErrorCauseResult {
  causeId: string;
  name: string;
  desc: string | null;
  seedCode: string | null;
  status: CauseStatus;
  seq: number;
}

const 建错因入参 = z.object({
  name: z.string().trim().min(1, "错因名不能为空"),
  desc: z.string().trim().min(1).optional(),
  seedCode: z.string().trim().min(1).optional(),
  status: z.enum(CAUSE_STATUSES).optional(),
});

/** 建一个错因实体。 */
export async function createErrorCause(
  input: CreateErrorCauseInput,
): Promise<CreateErrorCauseResult> {
  const v = parseInput(建错因入参, {
    name: input.name,
    desc: input.desc,
    seedCode: input.seedCode,
    status: input.status,
  });
  const causeId = newId("ec");
  const status: CauseStatus = v.status ?? "active";

  const receipt = await withCoreWrite(
    {
      actor: input.actor ?? "agent",
      tool: "createErrorCause",
      args: { causeId, name: v.name, seedCode: v.seedCode ?? null },
    },
    async (tx) => {
      await tx.insert(errorCause).values({
        id: causeId,
        name: v.name,
        desc: v.desc ?? null,
        seedCode: v.seedCode ?? null,
        status,
      });
      const refs: RowRef[] = [
        { table: "error_cause", id: causeId, op: "insert" },
      ];
      return refs;
    },
    input.handle,
  );

  return {
    causeId,
    name: v.name,
    desc: v.desc ?? null,
    seedCode: v.seedCode ?? null,
    status,
    seq: receipt.seq,
  };
}

export interface RetireCauseResult {
  causeId: string;
  name: string;
  status: CauseStatus;
  seq: number;
}

/**
 * 退役一个错因。
 * 🔴 行不删：已经归因过的历史统计要还查得出来「当时算的是哪个错因」。
 *    退役后既有映射仍在，只是不该再往上挂新东西（mapErrCode/mapKpError 会拒）。
 */
export async function retireCause(
  causeId: string,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<RetireCauseResult> {
  const id = parseInput(错因id, causeId);
  const h = opts.handle ?? (await getCoreDb());
  const 行 = await 取错因(h, id);

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "retireCause",
      args: { causeId: id },
    },
    async (tx) => {
      await tx
        .update(errorCause)
        .set({ status: "retired" })
        .where(eq(errorCause.id, id));
      const refs: RowRef[] = [{ table: "error_cause", id, op: "update" }];
      return refs;
    },
    opts.handle,
  );

  return { causeId: id, name: 行.name, status: "retired", seq: receipt.seq };
}

async function 取错因(
  h: CoreDbHandle,
  id: string,
): Promise<{ id: string; name: string; status: string | null }> {
  const r = await h.db
    .select({
      id: errorCause.id,
      name: errorCause.name,
      status: errorCause.status,
    })
    .from(errorCause)
    .where(eq(errorCause.id, id))
    .limit(1);
  const row = r[0];
  if (!row) {
    throw new CauseError(
      "CAUSE_NOT_FOUND",
      `错因 ${id} 不在库里 —— id 来自 createErrorCause / listCauses 的返回，禁编造。`,
    );
  }
  return row;
}

async function 取活错因(h: CoreDbHandle, id: string) {
  const row = await 取错因(h, id);
  if (row.status === "retired") {
    throw new CauseError(
      "CAUSE_RETIRED",
      `错因「${row.name}」(${id}) 已退役 —— 退役的错因不再接新挂载。要复用就新建一个，理由写进 desc。`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// ② kp_error：考点 ↔ 错因候选集
// ---------------------------------------------------------------------------

export interface KpErrorResult {
  kpId: string;
  kpName: string;
  causeId: string;
  causeName: string;
  seq: number;
}

/**
 * 把错因挂到考点的候选集上。
 * 🔴 M1 的判据：**判错因的候选集 = 主考点的挂载集** —— 这张表决定了
 *    「这道题错了，可能是因为什么」的候选面。挂多了噪声，挂少了漏判。
 */
export async function mapKpError(
  kpRef: string,
  causeId: string,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<KpErrorResult> {
  const cid = parseInput(错因id, causeId);
  const h = opts.handle ?? (await getCoreDb());
  const 因 = await 取活错因(h, cid);
  const 点 = await 解析考点(h, kpRef);

  const 已挂 = await h.db
    .select({ kpId: kpError.kpId })
    .from(kpError)
    .where(and(eq(kpError.kpId, 点.kpId), eq(kpError.causeId, cid)))
    .limit(1);
  if (已挂[0]) {
    throw new CauseError(
      "LINK_TAKEN",
      `考点「${点.name}」(${点.kpId}) 上已经挂着错因「${因.name}」(${cid}) 了 —— 不必重复挂。`,
    );
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "mapKpError",
      args: { kpId: 点.kpId, causeId: cid },
    },
    async (tx) => {
      await tx.insert(kpError).values({ kpId: 点.kpId, causeId: cid });
      const refs: RowRef[] = [
        { table: "kp_error", id: rowRefId(点.kpId, cid), op: "insert" },
      ];
      return refs;
    },
    opts.handle,
  );

  return {
    kpId: 点.kpId,
    kpName: 点.name,
    causeId: cid,
    causeName: 因.name,
    seq: receipt.seq,
  };
}

/** 摘掉一条考点↔错因挂载（候选集收窄）。 */
export async function unmapKpError(
  kpRef: string,
  causeId: string,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<KpErrorResult> {
  const cid = parseInput(错因id, causeId);
  const h = opts.handle ?? (await getCoreDb());
  const 因 = await 取错因(h, cid);
  const 点 = await 解析考点(h, kpRef);

  const 已挂 = await h.db
    .select({ kpId: kpError.kpId })
    .from(kpError)
    .where(and(eq(kpError.kpId, 点.kpId), eq(kpError.causeId, cid)))
    .limit(1);
  if (!已挂[0]) {
    throw new CauseError(
      "MAP_NOT_FOUND",
      `考点「${点.name}」(${点.kpId}) 上本来就没挂错因 ${cid} —— 没什么可摘的。`,
    );
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "unmapKpError",
      args: { kpId: 点.kpId, causeId: cid },
    },
    async (tx) => {
      await tx
        .delete(kpError)
        .where(and(eq(kpError.kpId, 点.kpId), eq(kpError.causeId, cid)));
      const refs: RowRef[] = [
        { table: "kp_error", id: rowRefId(点.kpId, cid), op: "delete" },
      ];
      return refs;
    },
    opts.handle,
  );

  return {
    kpId: 点.kpId,
    kpName: 点.name,
    causeId: cid,
    causeName: 因.name,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// ③ cause_example：错因 ↔ 诊断例题（软闸）
// ---------------------------------------------------------------------------

export interface AddCauseExampleResult {
  causeId: string;
  causeName: string;
  questionId: string;
  stemBrief: string;
  /** 挂完之后这个错因一共有几道例题 */
  exampleCount: number;
  /**
   * 🔴 软闸产物：例题不足 CAUSE_EXAMPLE_MIN 时这里有一句提示，**但不拦**。
   *    调用方（工具/页面）该把它显示出来，别吞掉。
   */
  warnings: string[];
  seq: number;
}

/**
 * 给错因挂一道诊断例题。
 * 🔴 软闸：挂完仍不足 2 道就在 warnings 里说一句 —— 少于两道，
 *    「这类错长什么样」没法讲清，但也不该因此拦住第一道。
 */
export async function addCauseExample(
  causeId: string,
  questionId: string,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<AddCauseExampleResult> {
  const cid = parseInput(错因id, causeId);
  const qid = parseInput(题id, questionId);
  const h = opts.handle ?? (await getCoreDb());
  const 因 = await 取活错因(h, cid);

  const q = await h.db
    .select({ id: question.id, stem: question.stem })
    .from(question)
    .where(eq(question.id, qid))
    .limit(1);
  if (!q[0]) {
    throw new CauseError(
      "QUESTION_NOT_FOUND",
      `题 ${qid} 在库里查无此行 —— 例题得是真题（id 来自 search_questions / kb_ingest）。`,
    );
  }

  const 已有 = await h.db
    .select({ questionId: causeExample.questionId })
    .from(causeExample)
    .where(eq(causeExample.causeId, cid));
  if (已有.some((r) => r.questionId === qid)) {
    throw new CauseError(
      "LINK_TAKEN",
      `题 ${qid} 已经是错因「${因.name}」的例题了。`,
    );
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "addCauseExample",
      args: { causeId: cid, questionId: qid },
    },
    async (tx) => {
      await tx.insert(causeExample).values({ causeId: cid, questionId: qid });
      const refs: RowRef[] = [
        { table: "cause_example", id: rowRefId(cid, qid), op: "insert" },
      ];
      return refs;
    },
    opts.handle,
  );

  const exampleCount = 已有.length + 1;
  const warnings: string[] =
    exampleCount < CAUSE_EXAMPLE_MIN
      ? [
          `错因「${因.name}」现在只有 ${exampleCount} 道例题（M1 口径 ≥${CAUSE_EXAMPLE_MIN}）——` +
            "少于两道就讲不清「这类错长什么样」。🔴 这是软闸：不拦你，但别忘了补。",
        ]
      : [];

  return {
    causeId: cid,
    causeName: 因.name,
    questionId: qid,
    stemBrief: stemBrief(q[0].stem ?? ""),
    exampleCount,
    warnings,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// ④ err_code_map：产线七码 → 错因实体（🔴 复合键）
// ---------------------------------------------------------------------------

export interface MapErrCodeResult {
  kpId: string;
  kpName: string;
  errCode: string;
  causeId: string;
  causeName: string;
  mappedBy: string | null;
  mappedAt: string;
  seq: number;
}

const 错因码 = z
  .string()
  .trim()
  .min(1, "err_code 不能为空")
  .max(64, "err_code 太长了，产线的码都是 sign/order/pow 这种短串");

/**
 * 登记一条 (考点, 产线码) → 错因 的翻译。
 *
 * 🔴 **同键重复不静默覆盖**：撞了就抛 MAP_TAKEN 并把现值写在 message 里，
 *    改判请先 unmapErrCode 再 map。理由：这张表是历史统计的解释器 ——
 *    悄悄改一条映射，等于把过去所有报表的口径也改了，而没有任何地方会提到这件事。
 *    先摘后挂 = 两条审计行，翻账能看见「什么时候改的、从谁改到谁」。
 */
export async function mapErrCode(
  kpRef: string,
  errCode: string,
  causeId: string,
  opts: {
    /** 谁定的这条映射（人名/脚本名），落 err_code_map.mapped_by */
    by?: string;
    actor?: AuditActor;
    handle?: CoreDbHandle;
  } = {},
): Promise<MapErrCodeResult> {
  const cid = parseInput(错因id, causeId);
  const code = parseInput(错因码, errCode);
  const h = opts.handle ?? (await getCoreDb());
  const 因 = await 取活错因(h, cid);
  const 点 = await 解析考点(h, kpRef);

  const 旧 = await h.db
    .select({
      causeId: errCodeMap.causeId,
      mappedBy: errCodeMap.mappedBy,
      mappedAt: errCodeMap.mappedAt,
    })
    .from(errCodeMap)
    .where(and(eq(errCodeMap.kpId, 点.kpId), eq(errCodeMap.errCode, code)))
    .limit(1);
  if (旧[0]) {
    const 旧因 = await h.db
      .select({ name: errorCause.name })
      .from(errorCause)
      .where(eq(errorCause.id, 旧[0].causeId))
      .limit(1);
    throw new CauseError(
      "MAP_TAKEN",
      `(kp=${点.name}[${点.kpId}], err_code='${code}') 已经映射到错因` +
        `「${旧因[0]?.name ?? "（错因行不见了）"}」(${旧[0].causeId})` +
        `${旧[0].mappedBy ? `，由 ${旧[0].mappedBy}` : ""}${旧[0].mappedAt ? ` 于 ${旧[0].mappedAt}` : ""} 定的。` +
        "🔴 改判请先 unmapErrCode 再 map（先摘后挂 = 两条审计行，翻账能看见改动）—— 这里不覆盖。",
    );
  }

  const mappedAt = nowLocalISO();
  const mappedBy = opts.by?.trim() ?? null;

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "mapErrCode",
      args: { kpId: 点.kpId, errCode: code, causeId: cid },
    },
    async (tx) => {
      await tx.insert(errCodeMap).values({
        kpId: 点.kpId,
        errCode: code,
        causeId: cid,
        mappedBy,
        mappedAt,
      });
      const refs: RowRef[] = [
        { table: "err_code_map", id: rowRefId(点.kpId, code), op: "insert" },
      ];
      return refs;
    },
    opts.handle,
  );

  return {
    kpId: 点.kpId,
    kpName: 点.name,
    errCode: code,
    causeId: cid,
    causeName: 因.name,
    mappedBy,
    mappedAt,
    seq: receipt.seq,
  };
}

/** 摘掉一条 (考点, 码) → 错因 映射（改判的第一步）。 */
export async function unmapErrCode(
  kpRef: string,
  errCode: string,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<{
  kpId: string;
  kpName: string;
  errCode: string;
  /** 摘掉前指向谁（翻账用） */
  causeId: string;
  seq: number;
}> {
  const code = parseInput(错因码, errCode);
  const h = opts.handle ?? (await getCoreDb());
  const 点 = await 解析考点(h, kpRef);

  const 旧 = await h.db
    .select({ causeId: errCodeMap.causeId })
    .from(errCodeMap)
    .where(and(eq(errCodeMap.kpId, 点.kpId), eq(errCodeMap.errCode, code)))
    .limit(1);
  if (!旧[0]) {
    throw new CauseError(
      "MAP_NOT_FOUND",
      `(kp=${点.name}[${点.kpId}], err_code='${code}') 本来就没有映射 —— 没什么可摘的。`,
    );
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "unmapErrCode",
      args: { kpId: 点.kpId, errCode: code },
    },
    async (tx) => {
      await tx
        .delete(errCodeMap)
        .where(and(eq(errCodeMap.kpId, 点.kpId), eq(errCodeMap.errCode, code)));
      const refs: RowRef[] = [
        { table: "err_code_map", id: rowRefId(点.kpId, code), op: "delete" },
      ];
      return refs;
    },
    opts.handle,
  );

  return {
    kpId: 点.kpId,
    kpName: 点.name,
    errCode: code,
    causeId: 旧[0].causeId,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// ⑤ roster：学员维度表
// ---------------------------------------------------------------------------

export interface UpsertRosterInput {
  /**
   * 🔴🔴 **学员代号，绝不落真名**。
   *    口径与圣域 batches.student / slots.student 完全一致（「小崽子」「鼻涕虫」这种），
   *    挂桥就是靠这个字符串对上的 —— 写成真名不只是隐私问题，桥当场断。
   *    真名只存在于用户自己的通讯录里，本产品任何一张表、任何一次落盘都不碰。
   */
  code: string;
  /** 备注性称呼（🔴 同样不许写真名；写「初一 A 班那个」这类线内叫法） */
  alias?: string;
  grade?: string;
  /** Q12 版本上下文：这个学员按哪个版本教材学（'人教七上'） */
  editionCtx?: string;
  status?: RosterStatus;
  joinedAt?: string;
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
}

export interface UpsertRosterResult {
  code: string;
  created: boolean;
  alias: string | null;
  grade: string | null;
  editionCtx: string | null;
  status: RosterStatus;
  joinedAt: string | null;
  note: string | null;
  seq: number;
}

const 名册入参 = z.object({
  code: z.string().trim().min(1, "学员代号不能为空（🔴 代号，不是真名）"),
  alias: z.string().trim().min(1).optional(),
  grade: z.string().trim().min(1).optional(),
  editionCtx: z.string().trim().min(1).optional(),
  status: z.enum(ROSTER_STATUSES).optional(),
  joinedAt: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
});

/**
 * 建/改一条学员维度行（幂等：有就更新，没有就建）。
 *
 * 🔴 roster 是**纯维度表**（M1 · D-1）：学情事实（对错/错因/轮次）一个字都不复制进来，
 *    全部只读现算自圣域。这张表只回答「有哪些学员、他按哪个版本学、还在不在」。
 */
export async function upsertRoster(
  input: UpsertRosterInput,
): Promise<UpsertRosterResult> {
  const v = parseInput(名册入参, {
    code: input.code,
    alias: input.alias,
    grade: input.grade,
    editionCtx: input.editionCtx,
    status: input.status,
    joinedAt: input.joinedAt,
    note: input.note,
  });
  const h = input.handle ?? (await getCoreDb());

  const 旧 = await h.db
    .select()
    .from(roster)
    .where(eq(roster.code, v.code))
    .limit(1);
  const 有 = 旧[0];
  const created = !有;

  const 值 = {
    alias: v.alias ?? 有?.alias ?? null,
    grade: v.grade ?? 有?.grade ?? null,
    editionCtx: v.editionCtx ?? 有?.editionCtx ?? null,
    status: (v.status ?? 有?.status ?? "active") as RosterStatus,
    joinedAt: v.joinedAt ?? 有?.joinedAt ?? nowLocalISO(),
    note: v.note ?? 有?.note ?? null,
  };

  const receipt = await withCoreWrite(
    {
      actor: input.actor ?? "agent",
      tool: "upsertRoster",
      args: { code: v.code, created },
    },
    async (tx) => {
      if (created) {
        await tx.insert(roster).values({ code: v.code, ...值 });
      } else {
        await tx.update(roster).set(值).where(eq(roster.code, v.code));
      }
      const refs: RowRef[] = [
        { table: "roster", id: v.code, op: created ? "insert" : "update" },
      ];
      return refs;
    },
    input.handle,
  );

  return { code: v.code, created, ...值, seq: receipt.seq };
}

// ---------------------------------------------------------------------------
// 读侧
// ---------------------------------------------------------------------------

export interface CauseBrief {
  causeId: string;
  name: string;
  desc: string | null;
  seedCode: string | null;
  status: string | null;
  /** 挂了几个考点 / 几道例题 / 几条码映射 */
  counts: { kps: number; examples: number; errCodes: number };
}

export interface ListCausesOptions {
  status?: CauseStatus;
  /** 只看挂在某个考点候选集上的错因（走 kp_error） */
  kpId?: string;
  limit?: number;
  handle?: CoreDbHandle;
}

/** 列错因（错因域全空时如实回空数组）。 */
export async function listCauses(
  opts: ListCausesOptions = {},
): Promise<CauseBrief[]> {
  const h = opts.handle ?? (await getCoreDb());
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));

  let ids: string[] | null = null;
  if (opts.kpId) {
    const rows = await h.db
      .select({ causeId: kpError.causeId })
      .from(kpError)
      .where(eq(kpError.kpId, opts.kpId));
    ids = rows.map((r) => r.causeId);
    if (ids.length === 0) return [];
  }

  const where = [
    ...(opts.status ? [eq(errorCause.status, opts.status)] : []),
    ...(ids ? [inArray(errorCause.id, ids)] : []),
  ];
  const rows = await h.db
    .select()
    .from(errorCause)
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(asc(errorCause.name))
    .limit(limit);
  if (rows.length === 0) return [];

  const rowIds = rows.map((r) => r.id);
  const kps = await h.db
    .select({ causeId: kpError.causeId })
    .from(kpError)
    .where(inArray(kpError.causeId, rowIds));
  const exs = await h.db
    .select({ causeId: causeExample.causeId })
    .from(causeExample)
    .where(inArray(causeExample.causeId, rowIds));
  const maps = await h.db
    .select({ causeId: errCodeMap.causeId })
    .from(errCodeMap)
    .where(inArray(errCodeMap.causeId, rowIds));
  const 数 = (arr: { causeId: string }[], id: string) =>
    arr.filter((x) => x.causeId === id).length;

  return rows.map((r) => ({
    causeId: r.id,
    name: r.name,
    desc: r.desc,
    seedCode: r.seedCode,
    status: r.status,
    counts: {
      kps: 数(kps, r.id),
      examples: 数(exs, r.id),
      errCodes: 数(maps, r.id),
    },
  }));
}

export interface CauseCard {
  cause: {
    causeId: string;
    name: string;
    desc: string | null;
    seedCode: string | null;
    status: string | null;
  };
  /** 挂在哪些考点的候选集上 */
  kps: { kpId: string; name: string; status: string | null }[];
  /** 诊断例题 */
  examples: { questionId: string; stemBrief: string; status: string | null }[];
  /** 哪些 (考点, 码) 翻译到它 */
  errCodes: {
    kpId: string;
    kpName: string;
    errCode: string;
    mappedBy: string | null;
    mappedAt: string | null;
  }[];
  /** 🔴 软闸提示（例题不足 2 道）——页面/工具该显示出来 */
  warnings: string[];
}

/** 一个错因的全貌（例题 + 挂载 + 码映射）。 */
export async function getCause(
  causeId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<CauseCard> {
  const id = parseInput(错因id, causeId);
  const h = opts.handle ?? (await getCoreDb());
  const 行 = await h.db
    .select()
    .from(errorCause)
    .where(eq(errorCause.id, id))
    .limit(1);
  const c = 行[0];
  if (!c) {
    throw new CauseError("CAUSE_NOT_FOUND", `错因 ${id} 不在库里。`);
  }

  const kps = await h.db
    .select({ kpId: kp.id, name: kp.name, status: kp.status })
    .from(kpError)
    .innerJoin(kp, eq(kp.id, kpError.kpId))
    .where(eq(kpError.causeId, id))
    .orderBy(asc(kp.name));

  const exs = await h.db
    .select({
      questionId: question.id,
      stem: question.stem,
      status: question.status,
    })
    .from(causeExample)
    .innerJoin(question, eq(question.id, causeExample.questionId))
    .where(eq(causeExample.causeId, id))
    .orderBy(asc(question.id));

  const maps = await h.db
    .select({
      kpId: errCodeMap.kpId,
      kpName: kp.name,
      errCode: errCodeMap.errCode,
      mappedBy: errCodeMap.mappedBy,
      mappedAt: errCodeMap.mappedAt,
    })
    .from(errCodeMap)
    .innerJoin(kp, eq(kp.id, errCodeMap.kpId))
    .where(eq(errCodeMap.causeId, id))
    .orderBy(asc(errCodeMap.errCode));

  const warnings =
    exs.length < CAUSE_EXAMPLE_MIN
      ? [
          `错因「${c.name}」只有 ${exs.length} 道诊断例题（M1 口径 ≥${CAUSE_EXAMPLE_MIN}）——` +
            "软闸：不拦，但少于两道就讲不清这类错长什么样。",
        ]
      : [];

  return {
    cause: {
      causeId: c.id,
      name: c.name,
      desc: c.desc,
      seedCode: c.seedCode,
      status: c.status,
    },
    kps,
    examples: exs.map((e) => ({
      questionId: e.questionId,
      stemBrief: stemBrief(e.stem ?? ""),
      status: e.status,
    })),
    errCodes: maps,
    warnings,
  };
}

/** 列学员名册（选题台/学情页的取数面；🔴 全是代号）。 */
export async function listRoster(
  opts: { status?: RosterStatus; handle?: CoreDbHandle } = {},
): Promise<
  {
    code: string;
    alias: string | null;
    grade: string | null;
    editionCtx: string | null;
    status: string | null;
    joinedAt: string | null;
    note: string | null;
  }[]
> {
  const h = opts.handle ?? (await getCoreDb());
  return h.db
    .select()
    .from(roster)
    .where(opts.status ? eq(roster.status, opts.status) : undefined)
    .orderBy(asc(roster.code));
}
