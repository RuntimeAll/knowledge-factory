/**
 * core/review.ts —— 审查队列的三条处置链（AI:PRD-003 · 003-D）
 *
 * 002-D 的队列只解决了「裁一下」（open → passed/rejected）。可 003 的管道会往队列里
 * 扔三种**带活儿**的工单 —— 光表个态没用，得真把事办了：
 *
 *   ① 图片工单（kind='图片'）   passFigureReview / rejectFigureReview
 *        题干图入库即必审。通过 = 图判 passed，**该题所有题干图都过了才摘掉
 *        question.review_required** —— 一张图过了就宣布整题免审，是审核形同虚设。
 *   ② 新题草稿（kind='新题草稿'） proposeQuestion / promoteDraftQuestion
 *        agent 会话里零星录的题先进提议态；人点「转正」才真跑管道入库。
 *   ③ 隔离区（quarantine 表）    resolveQuarantine
 *        红灯题的收容所。人改完 payload 重投，或判它废弃。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条纪律
 *
 * ① **写全部经 withCoreWrite**（图片链是单事务：改图 + 摘 review_required + 裁工单
 *    要么一起成、要么一起不成 —— 分开写就可能出现「图判过了、题还挂着必审」）。
 *
 * ② **转正 / 重投一律先 dryRun 再真跑**。理由不是谨慎，是**别把隔离区变成日志**：
 *    runIngestBatch 遇红灯会开一条新的 quarantine 行；要是每次「改一版重试」都真跑，
 *    改五版就多五条隔离行，人从此分不清哪条是本体。先 dryRun：红了就零写返回、
 *    页面把新红灯摊开给人看（🔴 不吞），绿了才真跑。
 *
 * ③ **管道自己的账不复述**。转正/重投把整份 IngestResult 原样端回去（含 batchId 与
 *    逐题逐闸报告），页面与 MCP 想看什么自己取 —— 这里绝不另编一套「简化结论」。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  asset,
  quarantine,
  question,
  questionFigure,
  reviewQueue,
} from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import { newId } from "./ids";
import {
  runIngestBatch,
  type IngestGateReport,
  type IngestItemReport,
  type IngestResult,
} from "./ingest";
import { KB_INGEST_CONTRACT } from "./ingest-schema";
import {
  QueueError,
  getQueueItem,
  verdictQueueItem,
  type QueueItem,
  type QueueVerdictResult,
} from "./queue";
import { nowLocalISO } from "./time";
import { withCoreWrite, type RowRef } from "./write";

// ---------------------------------------------------------------------------
// 公共
// ---------------------------------------------------------------------------

const 队列id = z
  .string()
  .trim()
  .refine(
    (s) => /^rq_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "工单 id 形状不对：应形如 rq_<26位ULID>",
  );

const 隔离id = z
  .string()
  .trim()
  .refine(
    (s) => /^qr_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "隔离行 id 形状不对：应形如 qr_<26位ULID>",
  );

const 署名 = z.string().trim().min(1, "处置人不能为空（谁办的必须留名）");

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new QueueError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

/** 取工单并断言「是这一类、还开着」——三条链的共同前置 */
async function 取待办工单(
  id: string,
  kind: string,
  handle?: CoreDbHandle,
): Promise<QueueItem> {
  const item = await getQueueItem(id, { handle });
  if (!item) throw new QueueError("QUEUE_NOT_FOUND", `工单 ${id} 不存在`);
  if (item.kind !== kind) {
    throw new QueueError(
      "QUEUE_KIND_MISMATCH",
      `工单 ${id} 是「${item.kind ?? "未分类"}」，不是「${kind}」——` +
        "处置原语与工单类别一一对应，别拿这条去走那条链。",
    );
  }
  if (item.state !== "open") {
    throw new QueueError(
      "QUEUE_ALREADY_DECIDED",
      `工单 ${id} 已经是 ${item.state} 了` +
        `（${item.verdictBy ?? "未记名"} 于 ${item.verdictAt ?? "时间未知"} 裁的）` +
        "——终态不重裁，要翻案请另开工单说明理由",
    );
  }
  return item;
}

/** payload_json → 对象；不是合法 JSON 对象就报 QUEUE_PAYLOAD_BAD（不猜、不兜底） */
function 解析payload(item: QueueItem): Record<string, unknown> {
  if (!item.payloadJson) {
    throw new QueueError(
      "QUEUE_PAYLOAD_BAD",
      `工单 ${item.id} 没有 payload_json —— 处置这类工单要靠它，先人工核对这条工单怎么来的。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.payloadJson);
  } catch (e) {
    throw new QueueError(
      "QUEUE_PAYLOAD_BAD",
      `工单 ${item.id} 的 payload_json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QueueError(
      "QUEUE_PAYLOAD_BAD",
      `工单 ${item.id} 的 payload_json 不是一个对象`,
    );
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 预检小结（转正/重投/提议共用）
// ---------------------------------------------------------------------------

/** 一处红灯（哪道闸、什么码、怎么改） */
export interface PrecheckRed {
  gate: string;
  code: string;
  message: string;
}

/**
 * 单题预检小结。
 * 🔴 是**小结**不是详账：全套逐闸报告在 IngestResult.gateReport（转正后还落
 *    ingest_batch.gate_report_json）。wire 上给小结、库里留全账，是 003 一贯口径。
 */
export interface PrecheckSummary {
  ok: boolean;
  verdict: "accepted" | "rejected";
  reds: PrecheckRed[];
  /** 被剥掉的片段（指令词闸 + 前缀闸） */
  stripped: string[];
  /** 不拦路但要人看见的事 */
  notes: string[];
  matchKey: string;
  solutionGrade: string | null;
  calcVerdict: string | null;
  kpIds: string[];
  primaryKpId: string | null;
  /** 有题干图 ⇒ 入库即必审 */
  reviewRequired: boolean;
}

/**
 * 一道题的红灯清单（哪道闸、什么码、怎么改）。
 * 🔴 逐题小结的公共零件：MCP 的 kb_ingest 逐题给它、页面的草稿卡给它、
 *    precheckOf 也用它 —— 三处一套口径，不许各写各的。
 */
export function itemReds(item: IngestItemReport): PrecheckRed[] {
  return item.gates.items
    .filter((g) => !g.result.ok)
    .map((g) => ({
      gate: g.name,
      code: g.result.ok ? "" : g.result.code,
      message: g.result.ok ? "" : g.result.message,
    }));
}

/** IngestGateReport（单题批）→ 小结 */
export function precheckOf(report: IngestGateReport): PrecheckSummary {
  const it = report.items[0];
  if (!it) {
    return {
      ok: false,
      verdict: "rejected",
      reds: [
        {
          gate: "①契约",
          code: report.contract.firstFailure?.code ?? "EMPTY_BATCH",
          message: report.contract.firstFailure?.message ?? "批里一道题都没有",
        },
      ],
      stripped: [],
      notes: [],
      matchKey: "",
      solutionGrade: null,
      calcVerdict: null,
      kpIds: [],
      primaryKpId: null,
      reviewRequired: false,
    };
  }
  return {
    ok: it.verdict === "accepted",
    verdict: it.verdict,
    reds: itemReds(it),
    stripped: it.stripped,
    notes: it.notes,
    matchKey: it.matchKey,
    solutionGrade: it.solutionGrade,
    calcVerdict: it.calcVerdict,
    kpIds: it.kpIds,
    primaryKpId: it.primaryKpId,
    reviewRequired: it.reviewRequired,
  };
}

/** 单题 → 一个合法的 kb-ingest/v1 单题批（seq 缺省补 1） */
function 单题批(
  item: Record<string, unknown>,
  meta: { source: string; sourceDoc?: unknown },
): Record<string, unknown> {
  return {
    contract: KB_INGEST_CONTRACT,
    source: meta.source,
    ...(meta.sourceDoc ? { sourceDoc: meta.sourceDoc } : {}),
    items: [{ ...item, seq: typeof item.seq === "number" ? item.seq : 1 }],
  };
}

function 要一个题对象(v: unknown, 谁: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new QueueError(
      "INVALID_INPUT",
      `${谁} 得是一个题对象（kb-ingest/v1 的 items[] 元素形状）`,
    );
  }
  return v as Record<string, unknown>;
}

interface 预检产物 {
  result: IngestResult;
  precheck: PrecheckSummary;
}

/** 跑一遍零写预检（dryRun：库与磁盘一个字节都不动） */
async function 预检(
  item: Record<string, unknown>,
  meta: { source: string; sourceDoc?: unknown },
  opts: { handle?: CoreDbHandle; assetsDir?: string },
): Promise<预检产物> {
  const result = await runIngestBatch(单题批(item, meta), {
    actor: "human",
    dryRun: true,
    handle: opts.handle,
    assetsDir: opts.assetsDir,
  });
  return { result, precheck: precheckOf(result.gateReport) };
}

// ---------------------------------------------------------------------------
// ① 图片工单
// ---------------------------------------------------------------------------

export interface FigureView {
  id: string;
  role: string | null;
  reviewState: string | null;
  assetId: string | null;
  /** 内容 hash —— 页面按它去 /api/asset/<hash> 取图 */
  hash: string | null;
  path: string | null;
  kind: string | null;
  bytes: number | null;
}

export interface FigureReviewCard {
  item: QueueItem;
  question: {
    id: string;
    stem: string;
    answer: string | null;
    analysis: string | null;
    status: string;
    reviewRequired: number;
  } | null;
  figures: FigureView[];
}

/**
 * 图审工单的卡片包：工单 + 题（题面要跟图对着看）+ 该题所有配图（含 hash）。
 * 🔴 只读。工单指不到题（ref_id 空/题被删）时 question=null —— 页面照实说，别装作有。
 */
export async function getFigureReviewCard(
  queueId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<FigureReviewCard> {
  const qid = parseInput(队列id, queueId);
  const h = opts.handle ?? (await getCoreDb());
  const item = await getQueueItem(qid, { handle: h });
  if (!item) throw new QueueError("QUEUE_NOT_FOUND", `工单 ${qid} 不存在`);

  if (!item.refId) return { item, question: null, figures: [] };

  const qrows = await h.db
    .select({
      id: question.id,
      stem: question.stem,
      answer: question.answer,
      analysis: question.analysis,
      status: question.status,
      reviewRequired: question.reviewRequired,
    })
    .from(question)
    .where(eq(question.id, item.refId));
  const q = qrows[0];

  const figures = await h.db
    .select({
      id: questionFigure.id,
      role: questionFigure.role,
      reviewState: questionFigure.reviewState,
      assetId: questionFigure.assetId,
      hash: asset.hash,
      path: asset.path,
      kind: asset.kind,
      bytes: asset.bytes,
    })
    .from(questionFigure)
    .leftJoin(asset, eq(questionFigure.assetId, asset.id))
    .where(eq(questionFigure.questionId, item.refId));

  return {
    item,
    question: q
      ? {
          id: q.id,
          stem: q.stem,
          answer: q.answer,
          analysis: q.analysis,
          status: q.status,
          reviewRequired: Number(q.reviewRequired ?? 0),
        }
      : null,
    figures,
  };
}

export interface FigureReviewOptions {
  /** 🔴 谁审的，必填且落库 */
  by: string;
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
}

export interface FigureReviewResult {
  queueId: string;
  questionId: string;
  verdict: "passed" | "rejected";
  /** 这次动了哪几张图 */
  figureIds: string[];
  /** 处置后该题的 review_required（0=已摘掉必审） */
  reviewRequired: 0 | 1;
  verdictAt: string;
  /** 审计行序号 */
  seq: number;
}

/** 图审两路的共同事务体（pass/reject 只差三处，抽出来免得两份逻辑各自漂） */
async function 图审(
  queueId: string,
  verdict: "passed" | "rejected",
  opts: FigureReviewOptions,
): Promise<FigureReviewResult> {
  const qid = parseInput(队列id, queueId);
  const by = parseInput(署名, opts.by);
  const note = (opts.note ?? "").trim();
  if (verdict === "rejected" && !note) {
    throw new QueueError(
      "INVALID_INPUT",
      "驳回图审必须写理由（图哪儿不对？落 verdict_note，人后续照它处理）",
    );
  }
  const item = await 取待办工单(qid, "图片", opts.handle);
  const questionId = item.refId;
  if (!questionId) {
    throw new QueueError(
      "QUEUE_PAYLOAD_BAD",
      `图审工单 ${qid} 没有 ref_id（指不到题）—— 这条工单不是管道开的，人工核对后另行处置。`,
    );
  }

  const ts = nowLocalISO();
  const 新态 = verdict === "passed" ? "passed" : "rejected";
  let 动过的图: string[] = [];
  let 剩余必审: 0 | 1 = 1;

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: verdict === "passed" ? "passFigureReview" : "rejectFigureReview",
      args: { queueId: qid, questionId, verdict, by, note: note || null },
    },
    async (tx) => {
      const rowRefs: RowRef[] = [];

      // 🔴 只动**题干图**：解析图走抽检，从来不进这张工单，别顺手一起判了
      const figs = await tx
        .select({
          id: questionFigure.id,
          state: questionFigure.reviewState,
        })
        .from(questionFigure)
        .where(
          and(
            eq(questionFigure.questionId, questionId),
            eq(questionFigure.role, "stem"),
          ),
        );
      if (figs.length === 0) {
        throw new QueueError(
          "QUEUE_PAYLOAD_BAD",
          `题 ${questionId} 身上一张题干图都没有，这条图审工单无从审起（题被改过？先人工核对）。`,
        );
      }

      const 待判 = figs.filter((f) => f.state === "pending");
      for (const f of 待判) {
        await tx
          .update(questionFigure)
          .set({ reviewState: 新态 })
          .where(eq(questionFigure.id, f.id));
        rowRefs.push({
          table: "question_figure",
          id: f.id,
          op: "update",
        });
      }
      动过的图 = 待判.map((f) => f.id);

      // 🔴 全部题干图都 passed 才摘掉必审：一张过了就宣布整题免审 = 审核形同虚设
      const 判后 = figs.map((f) => (f.state === "pending" ? 新态 : f.state));
      const 全过 = 判后.every((s) => s === "passed");
      剩余必审 = 全过 ? 0 : 1;
      if (全过) {
        await tx
          .update(question)
          .set({ reviewRequired: 0, updatedAt: ts })
          .where(eq(question.id, questionId));
        rowRefs.push({ table: "question", id: questionId, op: "update" });
      }
      // 🔴 驳回**不动** question.review_required（题继续挂着必审，人后续处理），
      //    也不自动隔离 —— 自动把一道已入库的题挪走，人就再也找不到它了。

      await tx
        .update(reviewQueue)
        .set({
          state: verdict,
          verdictBy: by,
          verdictNote:
            note ||
            (verdict === "passed"
              ? `题干图 ${待判.length} 张核对通过${全过 ? "，该题已摘掉必审" : ""}`
              : null),
          verdictAt: ts,
        })
        .where(eq(reviewQueue.id, qid));
      rowRefs.push({ table: "review_queue", id: qid, op: "update" });

      // 🔴 没动 stem/answer/analysis ⇒ 不必写 question_fts（方案甲的纪律只管改文本的路径）
      return rowRefs;
    },
    opts.handle,
  );

  return {
    queueId: qid,
    questionId,
    verdict,
    figureIds: 动过的图,
    reviewRequired: 剩余必审,
    verdictAt: ts,
    seq: receipt.seq,
  };
}

/**
 * 图审通过：题干图判 passed；**该题所有题干图都过了**才把 question.review_required 摘成 0，
 * 工单一并判过。全程**单事务**（withCoreWrite），要么一起成、要么一起不成。
 */
export function passFigureReview(
  queueId: string,
  opts: FigureReviewOptions,
): Promise<FigureReviewResult> {
  return 图审(queueId, "passed", opts);
}

/**
 * 图审驳回：题干图判 rejected、工单驳回（必须写理由）。
 * 🔴 题**保持** review_required=1，也不自动隔离 —— 图不对该怎么办（换图/改题/退役）
 *    是人的决定，系统替他决定只会让题不声不响地消失。
 */
export function rejectFigureReview(
  queueId: string,
  opts: FigureReviewOptions,
): Promise<FigureReviewResult> {
  return 图审(queueId, "rejected", opts);
}

// ---------------------------------------------------------------------------
// ② 新题草稿
// ---------------------------------------------------------------------------

export interface ProposeQuestionInput {
  /** 单题（kb-ingest/v1 的 items[] 元素；seq 可省，单题批自动补 1） */
  item: unknown;
  /** 喂料方标识，默认 'propose@agent' */
  source?: string;
  /** 批级源文档（scan 型来源要它） */
  sourceDoc?: unknown;
  /** 提议人写给审的人的一句话 */
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
  assetsDir?: string;
}

export interface ProposeQuestionResult {
  queueId: string;
  precheck: PrecheckSummary;
  seq: number;
}

/** 草稿工单的 payload 正身（转正时按它重建单题批） */
export interface DraftPayload {
  item: Record<string, unknown>;
  source: string;
  sourceDoc?: unknown;
  precheck: PrecheckSummary;
  note?: string;
}

/**
 * 提议一道题（agent 会话零星录题的入口）。
 *
 * 🔴 **提议 ≠ 入库**：这里只跑零写预检 + 开一张 kind='新题草稿' 工单。
 *    预检红了照样开工单（红的让人看着改），只有**契约结构错**才直接抛回给 agent
 *    ——形状错是喂料方自己能改对的事，塞进队列等于让人替 agent 补 JSON。
 */
export async function proposeQuestion(
  input: ProposeQuestionInput,
): Promise<ProposeQuestionResult> {
  const item = 要一个题对象(input.item, "item");
  const source = (input.source ?? "").trim() || "propose@agent";
  const { precheck } = await 预检(
    item,
    { source, sourceDoc: input.sourceDoc },
    { handle: input.handle, assetsDir: input.assetsDir },
  );

  const queueId = newId("rq");
  const ts = nowLocalISO();
  const payload: DraftPayload = {
    item,
    source,
    ...(input.sourceDoc ? { sourceDoc: input.sourceDoc } : {}),
    precheck,
    ...(input.note ? { note: input.note } : {}),
  };

  const 摘要 = precheck.ok
    ? "预检全绿：点「转正」即按同一条管道入库。"
    : `预检有 ${precheck.reds.length} 处红灯：${precheck.reds
        .map((r) => `${r.gate}[${r.code}]`)
        .join("、")} —— 改完再转正（转正前会重跑一遍闸）。`;

  const receipt = await withCoreWrite(
    {
      actor: input.actor ?? "agent",
      tool: "proposeQuestion",
      args: { queueId, source, ok: precheck.ok },
    },
    async (tx) => {
      await tx.insert(reviewQueue).values({
        id: queueId,
        kind: "新题草稿",
        refType: null,
        refId: null,
        payloadJson: JSON.stringify(payload),
        reason:
          `agent 提议入库一道题（source=${source}）。${摘要}` +
          (input.note ? `\n提议人附言：${input.note}` : ""),
        state: "open",
        createdAt: ts,
      });
      return [{ table: "review_queue", id: queueId, op: "insert" as const }];
    },
    input.handle,
  );

  return { queueId, precheck, seq: receipt.seq };
}

/** 草稿工单读侧：payload 拆成「题 + 预检」两半给页面 */
export interface DraftCard {
  item: QueueItem;
  draft: DraftPayload;
}

export async function getDraftCard(
  queueId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<DraftCard> {
  const qid = parseInput(队列id, queueId);
  const item = await getQueueItem(qid, { handle: opts.handle });
  if (!item) throw new QueueError("QUEUE_NOT_FOUND", `工单 ${qid} 不存在`);
  return { item, draft: 读草稿(item) };
}

function 读草稿(item: QueueItem): DraftPayload {
  const p = 解析payload(item);
  const draftItem = 要一个题对象(p.item, `工单 ${item.id} 的 payload.item`);
  return {
    item: draftItem,
    source:
      typeof p.source === "string" && p.source.trim()
        ? p.source
        : "propose@agent",
    ...(p.sourceDoc ? { sourceDoc: p.sourceDoc } : {}),
    precheck: (p.precheck ?? null) as unknown as PrecheckSummary,
    ...(typeof p.note === "string" ? { note: p.note } : {}),
  };
}

export interface PromoteDraftOptions {
  by: string;
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
  assetsDir?: string;
  /** 转正后出快照，默认跟管道走（true） */
  backup?: boolean;
}

export interface PromoteDraftResult {
  queueId: string;
  /** 真入库了吗 */
  promoted: boolean;
  questionId: string | null;
  batchId: string | null;
  /** 这次跑管道的完整账（红了也给全 —— 页面照它把新红灯摊开） */
  ingest: IngestResult;
  precheck: PrecheckSummary;
  /** promoted=false 时为 null（工单保持 open） */
  verdict: QueueVerdictResult | null;
}

/**
 * 草稿转正：以工单 payload 为**单题批**跑 runIngestBatch（actor='human'），
 * 成了就把工单判过、verdict_note 记下落库的 question id。
 *
 * 🔴 又红了 = 工单**保持 open**、零写返回，页面展示新红灯（不吞、也不悄悄隔离）。
 *    实现上先 dryRun 再真跑（见文件头纪律②）。
 *
 * 🔴 两笔写不是一个事务（管道自己是一个事务，裁决是另一个）：
 *    先入库、后裁决。中途失败（多半是另一个标签页已经裁过了）会停在
 *    「题已入库、工单还开着」—— 可查可补；反过来（先裁后入库）失败才真难受：
 *    工单结了、题没进来，而队列里再也没有这条线索。
 */
export async function promoteDraftQuestion(
  queueId: string,
  opts: PromoteDraftOptions,
): Promise<PromoteDraftResult> {
  const qid = parseInput(队列id, queueId);
  const by = parseInput(署名, opts.by);
  const item = await 取待办工单(qid, "新题草稿", opts.handle);
  const draft = 读草稿(item);

  const meta = { source: draft.source, sourceDoc: draft.sourceDoc };
  const 干跑 = await 预检(draft.item, meta, {
    handle: opts.handle,
    assetsDir: opts.assetsDir,
  });
  if (!干跑.precheck.ok) {
    return {
      queueId: qid,
      promoted: false,
      questionId: null,
      batchId: null,
      ingest: 干跑.result,
      precheck: 干跑.precheck,
      verdict: null,
    };
  }

  const ingest = await runIngestBatch(单题批(draft.item, meta), {
    actor: opts.actor ?? "human",
    handle: opts.handle,
    assetsDir: opts.assetsDir,
    ...(opts.backup === undefined ? {} : { backup: opts.backup }),
  });
  const precheck = precheckOf(ingest.gateReport);
  const questionId = ingest.questionIds[0] ?? null;

  if (!questionId) {
    // dryRun 绿、真跑红：库状态在两次之间变了（并发/另一边刚录了同题）。
    // 🔴 工单保持 open，把真跑的账端回去 —— 这时候管道已经开了隔离行，人看得见。
    return {
      queueId: qid,
      promoted: false,
      questionId: null,
      batchId: ingest.batchId,
      ingest,
      precheck,
      verdict: null,
    };
  }

  const verdict = await verdictQueueItem(qid, "passed", {
    by,
    note:
      (opts.note?.trim() ? `${opts.note.trim()}；` : "") +
      `已转正入库 → ${questionId}（批 ${ingest.batchId}）` +
      (precheck.reviewRequired ? "；该题带题干图，另开了图审工单" : ""),
    actor: opts.actor ?? "human",
    handle: opts.handle,
  });

  return {
    queueId: qid,
    promoted: true,
    questionId,
    batchId: ingest.batchId,
    ingest,
    precheck,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// ③ 隔离区
// ---------------------------------------------------------------------------

export interface QuarantineRow {
  id: string;
  batchId: string | null;
  payloadJson: string;
  why: string;
  createdAt: string | null;
  resolvedAt: string | null;
}

export interface ListQuarantineOptions {
  /** 默认 'open'（resolved_at IS NULL） */
  state?: "open" | "resolved" | "all";
  /** 默认 100，上限 500 */
  limit?: number;
  handle?: CoreDbHandle;
}

/** 列隔离行（新的在前）。只读。 */
export async function listQuarantine(
  opts: ListQuarantineOptions = {},
): Promise<QuarantineRow[]> {
  const v = parseInput(
    z.object({
      state: z.enum(["open", "resolved", "all"]).default("open"),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    { state: opts.state, limit: opts.limit },
  );
  const h = opts.handle ?? (await getCoreDb());

  const rows = await h.db
    .select()
    .from(quarantine)
    .where(
      v.state === "open"
        ? isNull(quarantine.resolvedAt)
        : v.state === "resolved"
          ? sql`${quarantine.resolvedAt} IS NOT NULL`
          : undefined,
    )
    .orderBy(desc(quarantine.createdAt), desc(quarantine.id))
    .limit(v.limit);

  return rows.map((r) => ({
    id: r.id,
    batchId: r.batchId,
    payloadJson: r.payloadJson,
    why: r.why,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  }));
}

/** 取一条隔离行；没有就 null */
export async function getQuarantineRow(
  id: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<QuarantineRow | null> {
  const qid = parseInput(隔离id, id);
  const h = opts.handle ?? (await getCoreDb());
  const rows = await h.db
    .select()
    .from(quarantine)
    .where(eq(quarantine.id, qid));
  const r = rows[0];
  return r
    ? {
        id: r.id,
        batchId: r.batchId,
        payloadJson: r.payloadJson,
        why: r.why,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      }
    : null;
}

export interface ResolveQuarantineOptions {
  /** reingest=改判重投 / discard=废弃 */
  action: "reingest" | "discard";
  /** 改过的单题 payload（不传 = 用库里存的原样重投）；discard 时忽略 */
  editedPayload?: unknown;
  by: string;
  /** 处置理由（discard 必填：废弃一道题总得说清为什么） */
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
  assetsDir?: string;
  backup?: boolean;
}

export interface ResolveQuarantineResult {
  id: string;
  action: "reingest" | "discard";
  /** 这条隔离行结掉了吗（重投又红 = false，行不动） */
  resolved: boolean;
  questionId: string | null;
  batchId: string | null;
  /** discard 时为 null；reingest 时是这次跑管道的完整账（红了也给全） */
  ingest: IngestResult | null;
  precheck: PrecheckSummary | null;
  resolvedAt: string | null;
  /** 结案那笔写的审计行序号（没结案为 null） */
  seq: number | null;
}

/** 处置痕迹追加到 why（quarantine 没有 note 列，M1 不改 schema —— 这一行就是它的处置日志） */
function 处置行(ts: string, by: string, 说明: string): string {
  return `\n【处置】${ts} ${by}：${说明}`;
}

/**
 * 处置一条隔离行。
 *
 *   reingest 改判重投：拿（改过的）单题 payload 重跑管道。
 *     🔴 先 dryRun：还红就**零写返回**（resolved=false + 新红灯全账），
 *        绝不因为「重试了五次」在隔离区多长五行。
 *     绿了才真跑 → 落库 → 原隔离行标 resolved_at，并往 why 追一行处置痕迹。
 *   discard 废弃：只标 resolved_at + why 追一行「废弃：理由」，题不入库。
 *
 * 🔴 已结的隔离行不重复处置（QUARANTINE_ALREADY_RESOLVED）——
 *    resolved_at 一旦有值，它记的就是「谁在什么时候按什么方式结的」，覆盖它等于抹账。
 */
export async function resolveQuarantine(
  id: string,
  opts: ResolveQuarantineOptions,
): Promise<ResolveQuarantineResult> {
  const qid = parseInput(隔离id, id);
  const by = parseInput(署名, opts.by);
  const action = parseInput(z.enum(["reingest", "discard"]), opts.action);
  const note = (opts.note ?? "").trim();
  if (action === "discard" && !note) {
    throw new QueueError(
      "INVALID_INPUT",
      "废弃必须写理由（这道题为什么不要了？落 quarantine.why 的处置行，日后翻账看得见）",
    );
  }

  const row = await getQuarantineRow(qid, { handle: opts.handle });
  if (!row) {
    throw new QueueError("QUARANTINE_NOT_FOUND", `隔离行 ${qid} 不存在`);
  }
  if (row.resolvedAt) {
    throw new QueueError(
      "QUARANTINE_ALREADY_RESOLVED",
      `隔离行 ${qid} 已经在 ${row.resolvedAt} 结过了 —— 不重复处置。` +
        "要再录一遍这道题，直接走 kb_ingest / propose_question。",
    );
  }

  // ── 废弃：一笔写就完事 ────────────────────────────────────────────────
  if (action === "discard") {
    const ts = nowLocalISO();
    const receipt = await withCoreWrite(
      {
        actor: opts.actor ?? "human",
        tool: "resolveQuarantine",
        args: { id: qid, action, by, note },
      },
      async (tx) => {
        await tx
          .update(quarantine)
          .set({
            resolvedAt: ts,
            why: row.why + 处置行(ts, by, `废弃：${note}`),
          })
          .where(eq(quarantine.id, qid));
        return [{ table: "quarantine", id: qid, op: "update" as const }];
      },
      opts.handle,
    );
    return {
      id: qid,
      action,
      resolved: true,
      questionId: null,
      batchId: null,
      ingest: null,
      precheck: null,
      resolvedAt: ts,
      seq: receipt.seq,
    };
  }

  // ── 改判重投 ────────────────────────────────────────────────────────
  const 原样 = (() => {
    try {
      return JSON.parse(row.payloadJson) as unknown;
    } catch {
      return null;
    }
  })();
  const 新料 = 要一个题对象(
    opts.editedPayload ?? 原样,
    opts.editedPayload === undefined
      ? `隔离行 ${qid} 的 payload_json`
      : "editedPayload",
  );
  const meta = {
    source: `quarantine-reingest@${qid}`,
    sourceDoc: await 原批源文档(qid, row.batchId, opts.handle),
  };

  const 干跑 = await 预检(新料, meta, {
    handle: opts.handle,
    assetsDir: opts.assetsDir,
  });
  if (!干跑.precheck.ok) {
    return {
      id: qid,
      action,
      resolved: false,
      questionId: null,
      batchId: null,
      ingest: 干跑.result,
      precheck: 干跑.precheck,
      resolvedAt: null,
      seq: null,
    };
  }

  const ingest = await runIngestBatch(单题批(新料, meta), {
    actor: opts.actor ?? "human",
    handle: opts.handle,
    assetsDir: opts.assetsDir,
    ...(opts.backup === undefined ? {} : { backup: opts.backup }),
  });
  const precheck = precheckOf(ingest.gateReport);
  const questionId = ingest.questionIds[0] ?? null;
  if (!questionId) {
    // dryRun 绿、真跑红（库在两次之间变了）：原行不结，新账原样端回
    return {
      id: qid,
      action,
      resolved: false,
      questionId: null,
      batchId: ingest.batchId,
      ingest,
      precheck,
      resolvedAt: null,
      seq: null,
    };
  }

  const ts = nowLocalISO();
  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "resolveQuarantine",
      args: { id: qid, action, by, questionId, batchId: ingest.batchId },
    },
    async (tx) => {
      await tx
        .update(quarantine)
        .set({
          resolvedAt: ts,
          why:
            row.why +
            处置行(
              ts,
              by,
              `改判重投 → ${questionId}（批 ${ingest.batchId}）${note ? `；${note}` : ""}`,
            ),
        })
        .where(eq(quarantine.id, qid));
      return [{ table: "quarantine", id: qid, op: "update" as const }];
    },
    opts.handle,
  );

  return {
    id: qid,
    action,
    resolved: true,
    questionId,
    batchId: ingest.batchId,
    ingest,
    precheck,
    resolvedAt: ts,
    seq: receipt.seq,
  };
}

/**
 * 找回原批的源文档（重投时带上，scan 型来源才过得了闸②，且 source_doc 跨批复用同一行）。
 *
 * 🔴 只能从**同批已落库的题**反查 —— ingest_batch 只留 payload 的 hash，不留正文。
 *    找不到就返回 undefined（原批整批都被拒的情况），此时 scan 型题需要人在
 *    editedPayload 里改成别的来源，或补 sourceDoc 后走 kb_ingest。
 */
async function 原批源文档(
  qid: string,
  batchId: string | null,
  handle?: CoreDbHandle,
): Promise<Record<string, unknown> | undefined> {
  if (!batchId) return undefined;
  const h = handle ?? (await getCoreDb());
  const r = await h.client.execute({
    sql: `SELECT d.title AS title, d.kind AS kind, d.path AS path, d.hash AS hash, d.pages AS pages
            FROM question q JOIN source_doc d ON d.id = q.source_doc_id
           WHERE q.ingest_batch_id = ? AND q.source_doc_id IS NOT NULL
           LIMIT 1`,
    args: [batchId],
  });
  const row = r.rows[0] as unknown as
    | {
        title: string;
        kind: string | null;
        path: string | null;
        hash: string | null;
        pages: number | null;
      }
    | undefined;
  if (!row) {
    void qid;
    return undefined;
  }
  return {
    title: row.title,
    kind: row.kind ?? "其他",
    ...(row.path ? { path: row.path } : {}),
    ...(row.hash ? { hash: row.hash } : {}),
    ...(row.pages ? { pages: row.pages } : {}),
  };
}
