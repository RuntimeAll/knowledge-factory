/**
 * core/model.ts —— 考察模型（exam_model）的提议 / 转正 / 驳回（AI:PRD-005 · 005-B）
 *
 * 「考察模型」= 一类题的出题法：题干模板 + 变量约束 + 错误模型 + 现役 DSL 指针。
 * 备料 §2 的实况是：五个 `qbank.py` 里躺着 62 个模板函数、26 个可登记的模型候选，
 * 全部**散在各册的 `_源/`**，库里 `exam_model` 一行都没有。本文件是它们进库的门。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 一条主线：**提议 ≠ 可用**
 *
 *   proposeModel  → status='proposed' + 一张 kind='模型转正' 的待审工单
 *   activateModel → 单事务：模型 active + activated_at + 工单 passed
 *   rejectModel   → 单事务：模型 deprecated + 工单 rejected（必须写理由）
 *
 *   为什么非要人点一下：`question.prov.type='model'` 的题，闸②会去查它引用的模型
 *   **是不是 active**（`PROV_MODEL_NOT_ACTIVE`）。也就是说「转正」这一下，
 *   等于批准「此后这个模型生成的题可以进库」。这个批准不该由提议者自己给自己发。
 *
 *   🔴 驳回落 `deprecated` 而不是留在 `proposed`：工单一关，proposed 的模型就再也
 *   没有一条能把它扶正的路（activateModel 只认 open 工单），留着它就是一具僵尸行 ——
 *   而 deprecated 是有语义的「看过了、不采纳」。行不删（血缘与「为什么否」要留得下来），
 *   要翻案就 proposeModel 重开一张卡，理由写清楚。
 *
 * 🔴 kp 一律 resolve 出来，禁编造（与录题闸③同一条尺子：**只认精确命中**）。
 *    模型挂错考点 = 按考点召回模型时悄悄召回错的一族，比挂错一道题影响面大得多。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { examModel, question, reviewQueue } from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import { isId, newId } from "./ids";
import { resolveMergedKp } from "./kg";
import { resolveKp, type KpCandidate } from "./resolve";
import { nowLocalISO } from "./time";
import { withCoreWrite, type RowRef } from "./write";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export const MODEL_STATUSES = ["proposed", "active", "deprecated"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** 待审工单的类别（建表 CHECK 里已有这一项，见 core/queue.ts 的 QUEUE_KINDS） */
export const MODEL_QUEUE_KIND = "模型转正";

/**
 * 稳定错误码：
 *   INVALID_INPUT       入参没过 zod
 *   KP_NOT_FOUND        考点查无（错误体里带 candidates）
 *   KP_AMBIGUOUS        一个说法精确命中了多个考点 —— 让人指明 kp_id
 *   KP_NOT_ACTIVE       考点不是 active（draft/retired/merged 追链后仍不活跃）
 *   MODEL_NOT_FOUND     模型 id 查无
 *   QUESTION_NOT_FOUND  originQids 里有不存在的题（血缘上游必须是真题）
 *   QUEUE_NOT_FOUND     工单不存在
 *   QUEUE_KIND_MISMATCH 拿模型链去处置别类工单
 *   QUEUE_ALREADY_DECIDED 工单已终态
 *   QUEUE_PAYLOAD_BAD   工单指不到模型（ref_id 空/模型被删）
 */
export const MODEL_ERROR_CODES = [
  "INVALID_INPUT",
  "KP_NOT_FOUND",
  "KP_AMBIGUOUS",
  "KP_NOT_ACTIVE",
  "MODEL_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "QUEUE_NOT_FOUND",
  "QUEUE_KIND_MISMATCH",
  "QUEUE_ALREADY_DECIDED",
  "QUEUE_PAYLOAD_BAD",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  /** KP_NOT_FOUND / KP_AMBIGUOUS 时带：最近似（或全部精确命中）的考点 */
  readonly candidates?: KpCandidate[];
  constructor(
    code: ModelErrorCode,
    message: string,
    candidates?: KpCandidate[],
  ) {
    super(message);
    this.name = "ModelError";
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
    throw new ModelError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

const 队列id = z
  .string()
  .trim()
  .refine(
    (s) => /^rq_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "工单 id 形状不对：应形如 rq_<26位ULID>",
  );

const 署名 = z.string().trim().min(1, "处置人不能为空（谁办的必须留名）");

// ---------------------------------------------------------------------------
// 考点解析（与录题闸③同一条尺子）
// ---------------------------------------------------------------------------

export interface ResolvedKpRef {
  kpId: string;
  name: string;
  /** 经 merged 壳追链落地时记一笔 */
  resolvedFrom?: { id: string; name: string; hops: number };
}

/**
 * `kpRef` → 真考点。
 * 🔴 名字这条路**只认 confidence=1.0**（名/别名全等）：像不算数。
 */
export async function resolveKpRef(
  h: CoreDbHandle,
  ref: string,
): Promise<ResolvedKpRef> {
  const s = (ref ?? "").trim();
  if (!s) throw new ModelError("INVALID_INPUT", "kpRef 不能为空");

  const 查 = async (id: string) => {
    const r = await h.client.execute({
      sql: "SELECT id, name, status FROM kp WHERE id = ?",
      args: [id],
    });
    return (
      (r.rows[0] as unknown as { id: string; name: string; status: string }) ??
      null
    );
  };

  if (isId(s, "kp")) {
    const row = await 查(s);
    if (!row) {
      throw new ModelError(
        "KP_NOT_FOUND",
        `kp_id=${s} 在库里查无此考点（🔴 id 一律 resolve 出来，禁编造）。先调 resolve_kp。`,
      );
    }
    let 落点 = row;
    let resolvedFrom: ResolvedKpRef["resolvedFrom"];
    if (row.status === "merged") {
      const landed = await resolveMergedKp(h, row.id);
      const 行 = await 查(landed.id);
      if (!行) {
        throw new ModelError(
          "KP_NOT_FOUND",
          `${s} 是 merged 壳，追链落到 ${landed.id}，但那一行也不在库里（数据坏了，先看 KG 治理页）。`,
        );
      }
      落点 = 行;
      resolvedFrom = { id: row.id, name: row.name, hops: landed.hops };
    }
    if (落点.status !== "active") {
      throw new ModelError(
        "KP_NOT_ACTIVE",
        `考点「${落点.name}」(${落点.id}) 的 status='${落点.status}'，不是 active —— 先转正再往上挂模型。`,
      );
    }
    return {
      kpId: 落点.id,
      name: 落点.name,
      ...(resolvedFrom ? { resolvedFrom } : {}),
    };
  }

  const r = await resolveKp(s, {
    handle: h,
    limit: 8,
    enqueue: false,
    knn: false,
  });
  const 精确 = r.candidates.filter((c) => c.confidence >= 1);
  if (精确.length === 0) {
    throw new ModelError(
      "KP_NOT_FOUND",
      `「${s}」没有**精确**命中任何考点` +
        (r.candidates.length > 0
          ? `（最像的是「${r.candidates[0]?.name}」，置信 ${r.candidates[0]?.confidence}）——` +
            "登记模型只认名/别名全等：模型挂错考点，按考点召回时会悄悄召回错的一族。"
          : " —— 词表里没有这个说法。要么换个说法，要么这个考点还没建。"),
      r.candidates.slice(0, 5),
    );
  }
  if (精确.length > 1) {
    throw new ModelError(
      "KP_AMBIGUOUS",
      `「${s}」精确命中了 ${精确.length} 个考点 —— 机器替你挑就是瞎猜，从候选里挑一个直接传 kp_id。`,
      精确,
    );
  }
  const hit = 精确[0]!;
  if (hit.status !== "active") {
    throw new ModelError(
      "KP_NOT_ACTIVE",
      `「${s}」命中考点「${hit.name}」(${hit.kpId})，但 status='${hit.status}'，不是 active —— 先转正。`,
    );
  }
  return {
    kpId: hit.kpId,
    name: hit.name,
    ...(hit.resolvedFrom ? { resolvedFrom: hit.resolvedFrom } : {}),
  };
}

// ---------------------------------------------------------------------------
// ① 提议
// ---------------------------------------------------------------------------

export interface ProposeModelInput {
  /** 考点名 / 别名 / kp_id（🔴 一律 resolve，只认精确命中） */
  kpRef: string;
  name: string;
  /** 现役 DSL 指针：`<册>/_源/qbank.py#类名或函数名`（收编前的桥） */
  dslRef: string;
  stemTemplate?: string;
  /** 变量约束（域/步长/互斥），对象或 JSON 串 */
  varSpecJson?: unknown;
  /** 错误模型（预置错因 → err 关联），对象或 JSON 串 */
  errorModelJson?: unknown;
  difficulty?: number;
  /** 从哪些真题归纳出来（血缘上游，必须是库里真的题 id） */
  originQids?: string[];
  /** 提议人写给审的人的一句话 */
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
}

export interface ProposeModelResult {
  modelId: string;
  queueId: string;
  kp: ResolvedKpRef;
  name: string;
  status: "proposed";
  createdAt: string;
  seq: number;
}

const 提议入参 = z.object({
  kpRef: z.string().trim().min(1, "kpRef 不能为空（模型必须归位到考点下）"),
  name: z.string().trim().min(1, "模型名不能为空"),
  dslRef: z
    .string()
    .trim()
    .min(
      1,
      "dslRef 不能为空 —— 🔴 现役 DSL 指针是这张卡的意义所在（模型收编前，" +
        "「哪个脚本的哪个类真会出这类题」是唯一能重跑的线索）",
    ),
  stemTemplate: z.string().trim().min(1).optional(),
  varSpecJson: z.unknown().optional(),
  errorModelJson: z.unknown().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  originQids: z.array(z.string().trim().min(1)).optional(),
  note: z.string().trim().min(1).optional(),
});

function jsonCol(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  return JSON.stringify(v);
}

/**
 * 提议一个考察模型（落 proposed + 开一张 kind='模型转正' 的待审工单）。
 *
 * 🔴 两笔写在**同一个事务**里（模型行 + 工单行）：只落其中一半的话，
 *    要么有个谁也扶不正的孤儿模型，要么有张指不到模型的空工单。
 */
export async function proposeModel(
  input: ProposeModelInput,
): Promise<ProposeModelResult> {
  const v = parseInput(提议入参, {
    kpRef: input.kpRef,
    name: input.name,
    dslRef: input.dslRef,
    stemTemplate: input.stemTemplate,
    varSpecJson: input.varSpecJson,
    errorModelJson: input.errorModelJson,
    difficulty: input.difficulty,
    originQids: input.originQids,
    note: input.note,
  });
  const h = input.handle ?? (await getCoreDb());

  const kp = await resolveKpRef(h, v.kpRef);

  // 血缘上游必须是真题（编一个 q_ id 挂上去，日后没人查得出它本来指谁）
  const origins = [...new Set(v.originQids ?? [])];
  if (origins.length > 0) {
    const 有的 = await h.db
      .select({ id: question.id })
      .from(question)
      .where(inArray(question.id, origins));
    const 有 = new Set(有的.map((r) => r.id));
    const 缺 = origins.filter((x) => !有.has(x));
    if (缺.length > 0) {
      throw new ModelError(
        "QUESTION_NOT_FOUND",
        `originQids 里这些题查无此行：${缺.slice(0, 8).join("、")}${缺.length > 8 ? " …" : ""}` +
          " —— 血缘上游得是库里真的题（题 id 来自 search_questions / kb_ingest 的返回）。",
      );
    }
  }

  const modelId = newId("em");
  const queueId = newId("rq");
  const ts = nowLocalISO();

  const 全量 = {
    modelId,
    kpId: kp.kpId,
    kpName: kp.name,
    name: v.name,
    dslRef: v.dslRef,
    stemTemplate: v.stemTemplate ?? null,
    varSpec: v.varSpecJson ?? null,
    errorModel: v.errorModelJson ?? null,
    difficulty: v.difficulty ?? null,
    originQids: origins,
    ...(v.note ? { note: v.note } : {}),
  };

  const receipt = await withCoreWrite(
    {
      actor: input.actor ?? "agent",
      tool: "proposeModel",
      args: { modelId, queueId, kpId: kp.kpId, name: v.name },
    },
    async (tx) => {
      const rowRefs: RowRef[] = [];
      await tx.insert(examModel).values({
        id: modelId,
        kpId: kp.kpId,
        name: v.name,
        stemTemplate: v.stemTemplate ?? null,
        varSpecJson: jsonCol(v.varSpecJson),
        errorModelJson: jsonCol(v.errorModelJson),
        dslRef: v.dslRef,
        difficulty: v.difficulty ?? null,
        status: "proposed",
        originQidsJson: origins.length > 0 ? JSON.stringify(origins) : null,
        createdAt: ts,
        activatedAt: null,
      });
      rowRefs.push({ table: "exam_model", id: modelId, op: "insert" });

      await tx.insert(reviewQueue).values({
        id: queueId,
        kind: MODEL_QUEUE_KIND,
        refType: "exam_model",
        refId: modelId,
        payloadJson: JSON.stringify(全量),
        reason:
          `提议登记考察模型「${v.name}」，归位考点「${kp.name}」(${kp.kpId})，DSL=${v.dslRef}。` +
          `🔴 转正 = 批准「此后这个模型生成的题可以进库」（录题闸② 只认 active 模型）。` +
          (origins.length > 0 ? `血缘上游 ${origins.length} 道真题。` : "") +
          (v.note ? `\n提议人附言：${v.note}` : ""),
        state: "open",
        createdAt: ts,
      });
      rowRefs.push({ table: "review_queue", id: queueId, op: "insert" });
      return rowRefs;
    },
    input.handle,
  );

  return {
    modelId,
    queueId,
    kp,
    name: v.name,
    status: "proposed",
    createdAt: ts,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// ② 转正 / ③ 驳回
// ---------------------------------------------------------------------------

export interface ModelVerdictResult {
  queueId: string;
  modelId: string;
  name: string;
  from: string;
  to: ModelStatus;
  verdict: "passed" | "rejected";
  by: string;
  verdictAt: string;
  seq: number;
}

/**
 * 模型链两路的共同事务体。
 *
 * 🔴 **工单读取放在事务里**（不像 review.ts 的图审链先读后写）：模型转正是
 *    「读工单态 → 改模型态 → 关工单」的读改写序列，两个标签页同时点转正时，
 *    在事务外读到的 open 可能已经过期。SQLite 单写者 + BEGIN IMMEDIATE ⇒
 *    在事务里读，第二个人只会看到 already-decided，不会双双写成功。
 */
async function 裁模型(
  queueId: string,
  verdict: "passed" | "rejected",
  opts: {
    by: string;
    note?: string;
    actor?: AuditActor;
    handle?: CoreDbHandle;
  },
): Promise<ModelVerdictResult> {
  const qid = parseInput(队列id, queueId);
  const by = parseInput(署名, opts.by);
  const note = (opts.note ?? "").trim();
  if (verdict === "rejected" && !note) {
    throw new ModelError(
      "INVALID_INPUT",
      "驳回必须写理由（这个模型为什么不采纳？落 verdict_note，下次同样的提议才不会再来一遍）",
    );
  }

  const ts = nowLocalISO();
  const to: ModelStatus = verdict === "passed" ? "active" : "deprecated";
  let modelId = "";
  let modelName = "";
  let from = "";

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: verdict === "passed" ? "activateModel" : "rejectModel",
      args: { queueId: qid, verdict, by, note: note || null },
    },
    async (tx) => {
      const rows = await tx
        .select()
        .from(reviewQueue)
        .where(eq(reviewQueue.id, qid));
      const item = rows[0];
      if (!item) {
        throw new ModelError("QUEUE_NOT_FOUND", `工单 ${qid} 不存在`);
      }
      if (item.kind !== MODEL_QUEUE_KIND) {
        throw new ModelError(
          "QUEUE_KIND_MISMATCH",
          `工单 ${qid} 是「${item.kind ?? "未分类"}」，不是「${MODEL_QUEUE_KIND}」——` +
            "处置原语与工单类别一一对应，别拿这条去走那条链。",
        );
      }
      if (item.state !== "open") {
        throw new ModelError(
          "QUEUE_ALREADY_DECIDED",
          `工单 ${qid} 已经是 ${item.state} 了` +
            `（${item.verdictBy ?? "未记名"} 于 ${item.verdictAt ?? "时间未知"} 裁的）` +
            "——终态不重裁，要翻案请 proposeModel 重开一张卡。",
        );
      }
      if (!item.refId) {
        throw new ModelError(
          "QUEUE_PAYLOAD_BAD",
          `工单 ${qid} 没有 ref_id（指不到模型）—— 这条不是 proposeModel 开的，人工核对后另行处置。`,
        );
      }

      const ms = await tx
        .select()
        .from(examModel)
        .where(eq(examModel.id, item.refId));
      const m = ms[0];
      if (!m) {
        throw new ModelError(
          "MODEL_NOT_FOUND",
          `工单 ${qid} 指向的模型 ${item.refId} 不在 exam_model 里（被删了？）—— 先人工核对。`,
        );
      }
      modelId = m.id;
      modelName = m.name;
      from = m.status;

      await tx
        .update(examModel)
        .set({
          status: to,
          // 🔴 activated_at 只在转正时写；驳回不碰它（它记的是「什么时候开始可用」）
          ...(verdict === "passed" ? { activatedAt: ts } : {}),
        })
        .where(eq(examModel.id, m.id));

      await tx
        .update(reviewQueue)
        .set({
          state: verdict,
          verdictBy: by,
          verdictNote:
            note ||
            (verdict === "passed"
              ? `模型「${m.name}」转正 → active（此后它生成的题可入库）`
              : null),
          verdictAt: ts,
        })
        .where(eq(reviewQueue.id, qid));

      return [
        { table: "exam_model", id: m.id, op: "update" as const },
        { table: "review_queue", id: qid, op: "update" as const },
      ];
    },
    opts.handle,
  );

  return {
    queueId: qid,
    modelId,
    name: modelName,
    from,
    to,
    verdict,
    by,
    verdictAt: ts,
    seq: receipt.seq,
  };
}

/**
 * 转正：模型 `active` + `activated_at`，工单判过 —— **单事务**。
 * 🔴 转正之后，`prov.type='model'` 引用它的题才过得了录题闸②。
 */
export function activateModel(
  queueId: string,
  opts: {
    by: string;
    note?: string;
    actor?: AuditActor;
    handle?: CoreDbHandle;
  },
): Promise<ModelVerdictResult> {
  return 裁模型(queueId, "passed", opts);
}

/**
 * 驳回：模型落 `deprecated`（不删行），工单驳回（🔴 必须写理由）—— 单事务。
 * 理由见文件头：留在 proposed 就成了谁也扶不正的僵尸行。
 */
export function rejectModel(
  queueId: string,
  opts: { by: string; note: string; actor?: AuditActor; handle?: CoreDbHandle },
): Promise<ModelVerdictResult> {
  return 裁模型(queueId, "rejected", opts);
}

// ---------------------------------------------------------------------------
// 读侧
// ---------------------------------------------------------------------------

export interface ModelCard {
  id: string;
  kpId: string;
  kpName: string | null;
  name: string;
  stemTemplate: string | null;
  varSpecJson: string | null;
  errorModelJson: string | null;
  dslRef: string | null;
  difficulty: number | null;
  status: string;
  originQids: string[];
  createdAt: string | null;
  activatedAt: string | null;
  /** 用这个模型生成的题有多少道（question.model_id） */
  questionCount: number;
  /** 还开着的转正工单（没有就是 null） */
  openQueueId: string | null;
}

/** 一个模型的全貌。只读。 */
export async function getModel(
  modelId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<ModelCard | null> {
  const id = (modelId ?? "").trim();
  if (!id) return null;
  const h = opts.handle ?? (await getCoreDb());

  /** 一行的形状（🔴 显式声明：拿 Record<string, unknown> 硬 String() 会把对象变 [object Object]） */
  interface 模型行 {
    id: string;
    kp_id: string;
    kp_name: string | null;
    name: string;
    stem_template: string | null;
    var_spec_json: string | null;
    error_model_json: string | null;
    dsl_ref: string | null;
    difficulty: number | null;
    status: string;
    origin_qids_json: string | null;
    created_at: string | null;
    activated_at: string | null;
    n_q: number | null;
    open_q: string | null;
  }

  const r = await h.client.execute({
    sql: `SELECT m.*, k.name AS kp_name,
                 (SELECT COUNT(*) FROM question q WHERE q.model_id = m.id) AS n_q,
                 (SELECT rq.id FROM review_queue rq
                   WHERE rq.ref_id = m.id AND rq.kind = ? AND rq.state = 'open'
                   ORDER BY rq.created_at DESC LIMIT 1) AS open_q
            FROM exam_model m LEFT JOIN kp k ON k.id = m.kp_id
           WHERE m.id = ?`,
    args: [MODEL_QUEUE_KIND, id],
  });
  const row = (r.rows[0] as unknown as 模型行 | undefined) ?? null;
  if (!row) return null;

  let originQids: string[] = [];
  if (typeof row.origin_qids_json === "string") {
    try {
      const parsed: unknown = JSON.parse(row.origin_qids_json);
      if (Array.isArray(parsed)) originQids = parsed.map((x) => String(x));
    } catch {
      originQids = [];
    }
  }

  return {
    id: row.id,
    kpId: row.kp_id,
    kpName: row.kp_name,
    name: row.name,
    stemTemplate: row.stem_template,
    varSpecJson: row.var_spec_json,
    errorModelJson: row.error_model_json,
    dslRef: row.dsl_ref,
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    status: row.status,
    originQids,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    questionCount: Number(row.n_q ?? 0),
    openQueueId: row.open_q,
  };
}

export interface ListModelsOptions {
  kpId?: string;
  status?: ModelStatus;
  /** 默认 50，上限 500 */
  limit?: number;
  handle?: CoreDbHandle;
}

export interface ModelBrief {
  id: string;
  kpId: string;
  name: string;
  status: string;
  dslRef: string | null;
  difficulty: number | null;
  createdAt: string | null;
  activatedAt: string | null;
}

/** 列模型（新的在前）。只读。 */
export async function listModels(
  opts: ListModelsOptions = {},
): Promise<ModelBrief[]> {
  const v = parseInput(
    z.object({
      kpId: z.string().trim().min(1).optional(),
      status: z.enum(MODEL_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    { kpId: opts.kpId, status: opts.status, limit: opts.limit },
  );
  const h = opts.handle ?? (await getCoreDb());

  const 条件 = [
    ...(v.kpId ? [eq(examModel.kpId, v.kpId)] : []),
    ...(v.status ? [eq(examModel.status, v.status)] : []),
  ];
  const rows = await h.db
    .select()
    .from(examModel)
    .where(条件.length > 0 ? and(...条件) : undefined)
    .orderBy(desc(examModel.createdAt), desc(examModel.id))
    .limit(v.limit);

  return rows.map((m) => ({
    id: m.id,
    kpId: m.kpId,
    name: m.name,
    status: m.status,
    dslRef: m.dslRef,
    difficulty: m.difficulty === null ? null : Number(m.difficulty),
    createdAt: m.createdAt,
    activatedAt: m.activatedAt,
  }));
}
