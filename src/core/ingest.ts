/**
 * core/ingest.ts —— 录题管道（AI:PRD-003 · 003-C）
 *
 * `runIngestBatch(payload)` 是**批量入题的唯一入口**：一次调用 = 一个 ingest_batch，
 * 页页有账（每题每闸的结论都留在 gate_report_json 里）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 两相设计（为什么不是「边过闸边写」）
 *
 *   相一 · 零写：契约 → 逐题变换（剥指令词/清前缀/算 match_key）→ 侧车批量
 *          （分词 + 实算，各一个 python 进程）→ 读库解析考点/查重/核模型 → 跑十道闸。
 *   相二 · 单事务：ingest_batch(open) → source_doc → 逐题落库 → 隔离 → 工单 → committed。
 *
 *   分相的理由是**锁的量级差三个数量级**：
 *     - 侧车一次 0.4~3 秒（jieba 载词典 + sympy 求值），考点解析是几十次 SELECT；
 *     - SQLite 是**单写者**，相二一开 BEGIN IMMEDIATE 就把全库的写锁攥在手里。
 *   要是把侧车放进事务里，一批 60 道题就意味着写锁被攥住好几秒 —— 期间任何
 *   别的 core 写（哪怕是 resolve_kp 顺手入个队列）都只能 SQLITE_BUSY 等着。
 *   所以：慢的、可重算的、只读的，全部前置；事务里只剩 INSERT。
 *
 *   代价（诚实标注）：相一读到的库状态与相二写入时的库状态之间有个窗口。
 *   本地单人单进程，这个窗口里不会有第二个写者；真出现并发，查重闸漏掉的那道
 *   重复题会在 INSERT 时撞 `idx_q_matchkey` 唯一索引 —— **整批回滚，不会脏**。
 *   闸是提前告诉你、给人话，索引才是最后那道物理防线。
 *
 * 🔴 红灯题**不落 question**：进 quarantine（带 why + 原样 payload），
 *    人改完重喂即可。一道坏题不连累同批的好题（punch-console 那边是整册跳过）。
 *
 * 🔴 dryRun：只跑相一，返回完整 gate_report，**库与磁盘零变化**（005 产线接入要用）。
 *    这也是为什么考点解析一律 `enqueue:false`、配图相一只算 hash 不拷文件。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 给后续卡的纪律：**任何改 stem/answer/analysis 的写路径，必须在同一事务里
 *      调 `writeQuestionFts`**（004 的 updateQuestion、审查队列页的改判、
 *      将来的批量重整，一个都不例外）。
 *
 *      方案甲把 FTS 的 INSERT/UPDATE 触发器撤了（0004 migration），
 *      同步职责从库里搬到了写侧 —— 漏一次的后果是：那道题 SQL 轴查得到、
 *      向量轴查得到、**FTS 轴永远查不到**，而且没有任何报错。
 *      机器闸 = 对账 C1(f)（question(pending/active) 的 id 集 ≡ question_fts 的 id 集），
 *      漏了会亮红旗；但红旗是事后，纪律是事前。
 *
 *      同理：把一道题的 status 迁出 pending/active（退役/隔离）时，
 *      要同事务删掉它的 FTS 行，否则 C1(f) 反向也会红。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";

import {
  asset,
  ingestBatch,
  question,
  questionFigure,
  questionKp,
  questionTag,
  quarantine,
  reviewQueue,
  sourceDoc,
} from "~/server/db/schema";
import { type AuditActor, sha256Hex, stableStringify } from "./audit";
import { backupNow, dbUrlToPath, type BackupResult } from "./backup";
import { getCoreDb, type CoreDbHandle, type CoreTx } from "./db";
import { writeQuestionFts } from "./fts";
import { runGates, type Gate, type GateFail, type GateReport } from "./gates";
import {
  checkContract,
  INGEST_CONTRACT_CODE,
  ingestContractGate,
} from "./gates/ingest-contract.gate";
import {
  ingestCalcGate,
  isCalcCandidate,
  isLineVerifyCandidate,
} from "./gates/ingest-calc.gate";
import {
  emptyDerived,
  type IngestBatchCtx,
  type IngestItemCtx,
  type ItemDerived,
} from "./gates/ingest-context";
import { ingestDedupGate, matchKeyOf } from "./gates/ingest-dedup.gate";
import { ingestFigureGate } from "./gates/ingest-figure.gate";
import {
  ingestInstructionGate,
  stripLeadInstruction,
} from "./gates/ingest-instruction.gate";
import { ingestKpGate } from "./gates/ingest-kp.gate";
import { ingestPlaceholderGate } from "./gates/ingest-placeholder.gate";
import { cleanStemPrefix, ingestPrefixGate } from "./gates/ingest-prefix.gate";
import { ingestProvenanceGate } from "./gates/ingest-provenance.gate";
import { ingestSolutionGradeGate } from "./gates/ingest-solution-grade.gate";
import { newId } from "./ids";
import { assetsDirFor, rowRefId } from "./integrity";
import {
  KB_INGEST_CONTRACT,
  type KbIngestItem,
  type KbIngestPayload,
} from "./ingest-schema";
import {
  calcVerify,
  lineVerify,
  segmentTexts,
  type SidecarOptions,
} from "./sidecar";
import { nowLocalISO } from "./time";
import { withCoreWrite, type RowRef } from "./write";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export const INGEST_ERROR_CODES = [
  /** 契约结构错 —— 整批拒，一道题都不入库 */
  INGEST_CONTRACT_CODE,
] as const;

export class IngestError extends Error {
  readonly code: string;
  /** 原始的闸失败（错误契约 shape，直接可回给 agent） */
  readonly gate: GateFail;
  constructor(gate: GateFail) {
    super(gate.message);
    this.name = "IngestError";
    this.code = gate.code;
    this.gate = gate;
  }
}

/** 逐题的账：过了哪几道闸、剥了什么、判成什么、落成哪一行 */
export interface IngestItemReport {
  seq: number;
  verdict: "accepted" | "rejected";
  /** 落库题 id（rejected 或 dryRun 时为 null） */
  questionId: string | null;
  /** 十道闸逐项结果（页页有账：过了的也留一行） */
  gates: GateReport;
  /** 第一处红灯（rejected 时必有） */
  failure: GateFail | null;
  /** 被剥掉的片段（指令词闸 + 前缀闸） */
  stripped: string[];
  /** 抽检标记（解析图） */
  sampled: string[];
  /** 不拦路但要人看见的事 */
  notes: string[];
  matchKey: string;
  solutionGrade: string | null;
  /** 实算三态（没送去算 = null） */
  calcVerdict: string | null;
  /** 逐行恒等三态（没送去校 = null；003-E） */
  lineVerdict: string | null;
  kpIds: string[];
  primaryKpId: string | null;
  /** 需人审（有题干图） */
  reviewRequired: boolean;
}

export interface IngestGateReport {
  ok: boolean;
  contractVer: string;
  source: string;
  /** 闸①（批级）的账 */
  contract: GateReport;
  items: IngestItemReport[];
  counts: IngestCounts;
}

export interface IngestCounts {
  total: number;
  /** 落库题数（含需人审的） */
  accepted: number;
  /** accepted 里需人审的那部分（🔴 是子集，不是另一堆） */
  queued: number;
  /** 进隔离的题数 */
  rejected: number;
}

export interface RunIngestOptions {
  /** 审计里的 actor，默认 'agent' */
  actor?: AuditActor;
  /** 只跑相一：返回完整 gate_report，库与磁盘零变化 */
  dryRun?: boolean;
  handle?: CoreDbHandle;
  /** 资产仓根，默认 = 库文件同级的 assets/ */
  assetsDir?: string;
  /** 侧车选项（换解释器/调超时；批量本身已经在管道里做了，别在外面循环） */
  sidecar?: SidecarOptions;
  /** 收批后出快照，默认 true（dryRun 恒不备份） */
  backup?: boolean;
}

export interface IngestResult {
  /** dryRun 时为 null */
  batchId: string | null;
  contractVer: string;
  source: string;
  counts: IngestCounts;
  gateReport: IngestGateReport;
  /** 落库题 id（按 seq 顺序） */
  questionIds: string[];
  /** 开的人审工单 id */
  queueIds: string[];
  /** 隔离行 id */
  quarantineIds: string[];
  dryRun: boolean;
  backup: BackupResult | null;
}

/** 逐题闸（闸①契约是批级的，单独跑；这里是②~⑩，顺序即报告顺序） */
export const ITEM_GATES: ReadonlyArray<Gate<IngestItemCtx>> = [
  ingestProvenanceGate,
  ingestKpGate,
  ingestInstructionGate,
  ingestPrefixGate,
  ingestPlaceholderGate,
  ingestDedupGate,
  ingestCalcGate,
  ingestSolutionGradeGate,
  ingestFigureGate,
];

/** 新题一律先落 pending（转正走审查队列，不在本管道里） */
const NEW_QUESTION_STATUS = "pending";

// ---------------------------------------------------------------------------
// 相一：零写
// ---------------------------------------------------------------------------

/** 逐题变换（纯函数串起来：剥指令词 → 清前缀 → 算查重键） */
function 变换(item: KbIngestItem): ItemDerived {
  const d = emptyDerived();
  const ins = stripLeadInstruction(item.stem);
  d.stemStripped = ins.text.trim();
  d.stripped.push(...ins.stripped);

  const cl = cleanStemPrefix(d.stemStripped);
  d.stemClean = cl.text;
  d.stripped.push(...cl.stripped);

  d.matchKey = matchKeyOf(d.stemClean);
  return d;
}

/**
 * 侧车分词：一次进程吃整批。
 * 🔴 写侧一律 `mode:'search'`（总指挥拍板 2026-08-12）——长词再切、多留 token；
 *    查侧用 exact。这个方向不能反：查询 token 是索引 token 的子集才只会多命中不会漏
 *    （反过来就是静默查不全，见 fts.ts 文件头的两条召回缺口）。
 */
async function 分词(
  payload: KbIngestPayload,
  derived: ItemDerived[],
  opts: SidecarOptions,
): Promise<void> {
  const inputs: { id: string; text: string }[] = [];
  payload.items.forEach((item, i) => {
    inputs.push({ id: `s${i}`, text: derived[i]!.stemClean });
    if (item.answer !== null) inputs.push({ id: `a${i}`, text: item.answer });
    if (item.analysis !== null)
      inputs.push({ id: `n${i}`, text: item.analysis });
  });
  const out = await segmentTexts(inputs, { ...opts, mode: "search" });
  const byId = new Map(out.map((r) => [r.id, r.segmented]));
  payload.items.forEach((_item, i) => {
    const d = derived[i]!;
    d.stemPlainSeg = byId.get(`s${i}`) ?? "";
    d.answerSeg = byId.get(`a${i}`) ?? "";
    d.analysisSeg = byId.get(`n${i}`) ?? "";
  });
}

/** 侧车实算：一次进程吃整批（只送候选题，见 isCalcCandidate） */
async function 实算(
  payload: KbIngestPayload,
  derived: ItemDerived[],
  opts: SidecarOptions,
): Promise<void> {
  const items: { id: string; stem: string; answer: string }[] = [];
  payload.items.forEach((item, i) => {
    if (!isCalcCandidate(item, derived[i]!.stemStripped)) return;
    items.push({
      id: String(i),
      // 🔴 送**剥完指令词**的题面：侧车自己也会剥一层，但它剥的是它那份词表，
      //    两边都剥不会错（幂等），只剥一边可能漏。
      stem: derived[i]!.stemStripped,
      answer: item.answer ?? "",
    });
  });
  const out = await calcVerify(items, opts);
  const byId = new Map(out.map((r) => [r.id, r]));
  payload.items.forEach((_item, i) => {
    derived[i]!.calc = byId.get(String(i)) ?? null;
  });
}

/**
 * 侧车逐行恒等：一次进程吃整批（只送 qtype='计算' 且有解析的题）。
 *
 * 🔴 单独一趟进程，不并进 实算()：两者的入参与判据完全不同（一个吃 stem+answer
 *    验最终值，一个吃 analysis 验每一行），合成一个 op 只会让两边的口径互相牵连。
 *    代价是多起一个 python 进程（~0.3s）——一批一次，不是一题一次。
 */
async function 逐行(
  payload: KbIngestPayload,
  derived: ItemDerived[],
  opts: SidecarOptions,
): Promise<void> {
  const items: { id: string; analysis: string }[] = [];
  payload.items.forEach((item, i) => {
    if (!isLineVerifyCandidate(item)) return;
    items.push({ id: String(i), analysis: item.analysis ?? "" });
  });
  const out = await lineVerify(items, opts);
  const byId = new Map(out.map((r) => [r.id, r]));
  payload.items.forEach((_item, i) => {
    derived[i]!.lineVerify = byId.get(String(i)) ?? null;
  });
}

function 逐题报告(
  item: KbIngestItem,
  d: ItemDerived,
  report: GateReport,
): IngestItemReport {
  const failure = report.firstFailure ?? null;
  return {
    seq: item.seq,
    verdict: failure ? "rejected" : "accepted",
    questionId: null,
    gates: report,
    failure,
    stripped: d.stripped,
    sampled: d.sampled,
    notes: d.notes,
    matchKey: d.matchKey,
    solutionGrade: d.solutionGrade,
    calcVerdict: d.calc?.verdict ?? null,
    lineVerdict: d.lineVerify?.verdict ?? null,
    kpIds: d.kps.map((k) => k.kpId),
    primaryKpId: d.kps.find((k) => k.isPrimary)?.kpId ?? null,
    reviewRequired: d.reviewRequired,
  };
}

// ---------------------------------------------------------------------------
// 相二：单事务
// ---------------------------------------------------------------------------

/** 找/建 source_doc（同 hash 视为同一份文档，跨批复用一行） */
async function 登记源文档(
  tx: CoreTx,
  payload: KbIngestPayload,
  rowRefs: RowRef[],
): Promise<string | null> {
  const doc = payload.sourceDoc;
  if (!doc) return null;

  const 已有 = await tx
    .select({ id: sourceDoc.id })
    .from(sourceDoc)
    .where(
      doc.hash
        ? eq(sourceDoc.hash, doc.hash)
        : and(eq(sourceDoc.title, doc.title), eq(sourceDoc.kind, doc.kind)),
    )
    .limit(1);
  if (已有[0]?.id) return 已有[0].id;

  const id = newId("doc");
  await tx.insert(sourceDoc).values({
    id,
    title: doc.title,
    kind: doc.kind,
    path: doc.path ?? null,
    hash: doc.hash ?? null,
    pages: doc.pages ?? null,
    note: doc.note ?? null,
    createdAt: nowLocalISO(),
  });
  rowRefs.push({ table: "source_doc", id, op: "insert" });
  return id;
}

/** 找/建 asset（内容寻址：同 hash 全库一行） */
async function 登记资产(
  tx: CoreTx,
  plan: { hash: string; fileName: string; ext: string; bytes: number },
  rowRefs: RowRef[],
): Promise<string> {
  const 已有 = await tx
    .select({ id: asset.id })
    .from(asset)
    .where(eq(asset.hash, plan.hash))
    .limit(1);
  if (已有[0]?.id) return 已有[0].id;

  const id = newId("asset");
  await tx.insert(asset).values({
    id,
    path: plan.fileName,
    hash: plan.hash,
    kind: plan.ext.replace(/^\./, "") || null,
    bytes: plan.bytes,
    createdAt: nowLocalISO(),
  });
  rowRefs.push({ table: "asset", id, op: "insert" });
  return id;
}

/**
 * 审计行里的 gate_results_json：**逐题小结**，不是整份详账。
 *
 * 🔴 详账（每题每闸一行、含被剥片段与实算细节）落 `ingest_batch.gate_report_json`；
 *    审计链是 append-only 的，把一份 60 题 × 9 闸的大 JSON 复制进去，
 *    既撑大链、又没有第二个读者。这里只留「哪几道被拒、被哪道闸拒的」——
 *    正是事后翻审计时真正要问的问题；要看详情顺着 batchId 去 ingest_batch。
 */
function 逐题小结(items: IngestItemReport[]): GateReport {
  const failed = items.filter((i) => i.verdict === "rejected");
  return {
    ok: failed.length === 0,
    total: items.length,
    passed: items.length - failed.length,
    failed: failed.length,
    skipped: 0,
    items: items.map((i) => ({
      name: `seq=${i.seq}`,
      result: i.failure ?? { ok: true as const },
      ms: i.gates.items.reduce((s, g) => s + g.ms, 0),
    })),
    ...(failed[0]?.failure ? { firstFailure: failed[0].failure } : {}),
  };
}

/** punch 兼容位 → 来源标签（位置是坐标，不是题目属性，所以进 tag 不进列） */
export function punchPosTag(pos: {
  day: number;
  section: string;
  seq: number;
}): string {
  return `src:d${pos.day}-s${pos.section.replace(/\s+/g, "")}-q${pos.seq}`;
}

// ---------------------------------------------------------------------------
// 总入口
// ---------------------------------------------------------------------------

/**
 * 跑一批录题。
 *
 * ```ts
 * const r = await runIngestBatch(payload, { actor: "agent" });
 * // r.counts => { total: 3, accepted: 2, queued: 0, rejected: 1 }
 * // r.gateReport.items[0].gates.items => 九道逐题闸各一行
 * ```
 *
 * @throws IngestError 契约结构错（整批拒，库零变化）
 */
export async function runIngestBatch(
  raw: unknown,
  options: RunIngestOptions = {},
): Promise<IngestResult> {
  // ── 闸①：契约（结构错 = 整批拒，不进逐题）──────────────────────────────────
  const contractReport = await runGates([ingestContractGate], raw);
  const checked = checkContract(raw);
  if (!checked.ok) throw new IngestError(checked.result);
  const payload = checked.payload;

  const h = options.handle ?? (await getCoreDb());
  const dbPath = dbUrlToPath(h.url);
  const assetsDir = options.assetsDir ?? assetsDirFor(dbPath);
  const dryRun = options.dryRun === true;

  // ── 相一 ────────────────────────────────────────────────────────────────
  const derived = payload.items.map(变换);
  const keyOwner = new Map<string, number>();
  payload.items.forEach((item, i) => {
    const k = derived[i]!.matchKey;
    if (!keyOwner.has(k)) keyOwner.set(k, item.seq);
  });

  await 分词(payload, derived, options.sidecar ?? {});
  await 实算(payload, derived, options.sidecar ?? {});
  await 逐行(payload, derived, options.sidecar ?? {});

  const batchCtx: IngestBatchCtx = {
    handle: h,
    payload,
    keyOwner,
    assetsDir,
  };

  const itemReports: IngestItemReport[] = [];
  for (const [i, item] of payload.items.entries()) {
    const d = derived[i]!;
    const ctx: IngestItemCtx = {
      seq: item.seq,
      item,
      derived: d,
      batch: batchCtx,
    };
    const report = await runGates(ITEM_GATES, ctx);
    itemReports.push(逐题报告(item, d, report));
  }

  const accepted = itemReports.filter((r) => r.verdict === "accepted");
  const rejected = itemReports.filter((r) => r.verdict === "rejected");
  const counts: IngestCounts = {
    total: itemReports.length,
    accepted: accepted.length,
    queued: accepted.filter((r) => r.reviewRequired).length,
    rejected: rejected.length,
  };

  const gateReport: IngestGateReport = {
    ok: rejected.length === 0,
    contractVer: KB_INGEST_CONTRACT,
    source: payload.source,
    contract: contractReport,
    items: itemReports,
    counts,
  };

  if (dryRun) {
    return {
      batchId: null,
      contractVer: KB_INGEST_CONTRACT,
      source: payload.source,
      counts,
      gateReport,
      questionIds: [],
      queueIds: [],
      quarantineIds: [],
      dryRun: true,
      backup: null,
    };
  }

  // ── 相二前置：把图拷进资产仓 ────────────────────────────────────────────
  // 🔴 文件系统不是事务的一部分，只能补偿：事务挂了就把**本次新拷的**删掉
  //    （已经存在的同 hash 文件是别的批的，动不得）。
  const 新拷文件: string[] = [];
  mkdirSync(assetsDir, { recursive: true });
  for (const r of accepted) {
    const d = derived[payload.items.findIndex((it) => it.seq === r.seq)]!;
    for (const p of d.figures) {
      const target = join(assetsDir, p.fileName);
      if (existsSync(target)) continue;
      copyFileSync(p.srcPath, target);
      新拷文件.push(target);
    }
  }

  const batchId = newId("batch");
  const now = nowLocalISO();
  const payloadHash = sha256Hex(stableStringify(payload));
  const questionIds: string[] = [];
  const queueIds: string[] = [];
  const quarantineIds: string[] = [];

  try {
    await withCoreWrite(
      {
        actor: options.actor ?? "agent",
        tool: "runIngestBatch",
        args: { batchId, source: payload.source, n: counts.total },
        gateReport: 逐题小结(itemReports),
      },
      async (tx) => {
        const rowRefs: RowRef[] = [];

        // ① 批（先 open：question.ingest_batch_id 有外键，得先有这一行）
        await tx.insert(ingestBatch).values({
          id: batchId,
          contractVer: KB_INGEST_CONTRACT,
          source: payload.source,
          payloadHash,
          nTotal: counts.total,
          nAccepted: counts.accepted,
          nQueued: counts.queued,
          nRejected: counts.rejected,
          status: "open",
          createdAt: now,
        });
        rowRefs.push({ table: "ingest_batch", id: batchId, op: "insert" });

        // ② 源文档
        const docId = await 登记源文档(tx, payload, rowRefs);

        // ③ 逐题
        for (const rep of itemReports) {
          const idx = payload.items.findIndex((it) => it.seq === rep.seq);
          const item = payload.items[idx]!;
          const d = derived[idx]!;

          if (rep.verdict === "rejected") {
            const qid = newId("qr");
            await tx.insert(quarantine).values({
              id: qid,
              batchId,
              payloadJson: JSON.stringify(item),
              why: `${rep.failure?.code}: ${rep.failure?.message}`,
              createdAt: now,
            });
            rowRefs.push({ table: "quarantine", id: qid, op: "insert" });
            quarantineIds.push(qid);
            rep.questionId = null;
            continue;
          }

          const qid = newId("q");
          await tx.insert(question).values({
            id: qid,
            stem: d.stemClean,
            stemPlain: d.stemPlainSeg,
            answer: item.answer,
            analysis: item.analysis,
            qtype: item.qtype ?? null,
            difficulty: item.difficulty ?? null,
            status: NEW_QUESTION_STATUS,
            solutionGrade: d.solutionGrade ?? "analysis_only",
            reviewRequired: d.reviewRequired ? 1 : 0,
            matchKey: d.matchKey,
            provType: item.prov.type,
            sourceDocId: docId,
            sourcePageNo: item.prov.page ?? null,
            modelId: item.prov.modelId ?? null,
            pipelineRef: item.prov.pipelineRef ?? null,
            ingestBatchId: batchId,
            editionScope: item.editionScope ?? null,
            createdBy: item.prov.createdBy ?? null,
            createdAt: now,
            updatedAt: now,
          });
          rowRefs.push({ table: "question", id: qid, op: "insert" });
          questionIds.push(qid);
          rep.questionId = qid;

          // 考点
          for (const k of d.kps) {
            await tx.insert(questionKp).values({
              questionId: qid,
              kpId: k.kpId,
              isPrimary: k.isPrimary ? 1 : 0,
            });
            rowRefs.push({
              table: "question_kp",
              id: rowRefId(qid, k.kpId),
              op: "insert",
            });
          }

          // 标签（自由标签 + punch 位置位）
          const tags = new Set(item.tags ?? []);
          if (item.punchPos) tags.add(punchPosTag(item.punchPos));
          for (const t of tags) {
            await tx.insert(questionTag).values({ questionId: qid, tag: t });
            rowRefs.push({
              table: "question_tag",
              id: rowRefId(qid, t),
              op: "insert",
            });
          }

          // 配图（asset 内容寻址复用 + question_figure 分级审核）
          for (const p of d.figures) {
            const assetId = await 登记资产(tx, p, rowRefs);
            const figId = newId("fig");
            await tx.insert(questionFigure).values({
              id: figId,
              questionId: qid,
              assetId,
              role: p.role,
              reviewState: "pending",
            });
            rowRefs.push({
              table: "question_figure",
              id: figId,
              op: "insert",
            });
          }

          // 🔴 FTS 写侧投影（方案甲）——与正表同事务，漏一次 = 那题此后 FTS 查不到
          await writeQuestionFts(tx, {
            questionId: qid,
            stemPlain: d.stemPlainSeg,
            answerSeg: d.answerSeg,
            analysisSeg: d.analysisSeg,
          });

          // 题干图 ⇒ 人审工单
          if (d.reviewRequired) {
            const rqId = newId("rq");
            await tx.insert(reviewQueue).values({
              id: rqId,
              kind: "图片",
              refType: "question",
              refId: qid,
              payloadJson: JSON.stringify({
                batchId,
                seq: item.seq,
                figures: d.figures
                  .filter((f) => f.role === "stem")
                  .map((f) => f.fileName),
              }),
              reason:
                `seq=${item.seq} 带 ${d.figures.filter((f) => f.role === "stem").length} 张题干图，` +
                "入库即必审（题干图错 = 题目本身错，不抽检）。核对图与题面是否对得上、图是不是这道题的图。",
              state: "open",
              createdAt: now,
            });
            rowRefs.push({ table: "review_queue", id: rqId, op: "insert" });
            queueIds.push(rqId);
          }
        }

        // ④ 收批：committed + 全套账
        await tx.run(
          sql`UPDATE ingest_batch
                 SET status = 'committed',
                     committed_at = ${now},
                     gate_report_json = ${JSON.stringify(gateReport)}
               WHERE id = ${batchId}`,
        );

        return rowRefs;
      },
      h,
    );
  } catch (e) {
    // 事务回滚了 ⇒ 把本次新拷的图删掉，别留下「有文件查不到登记行」（对账 C1c 红旗）
    for (const f of 新拷文件) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* 删不掉只留一个孤儿文件，C1c 会亮红旗提醒人清 —— 不因此掩盖原始异常 */
      }
    }
    throw e;
  }

  // ── 收批后备份（事务外：VACUUM INTO 不能在事务里跑）────────────────────────
  const backup =
    options.backup === false ? null : await backupNow({ reason: "batch" }, h);

  return {
    batchId,
    contractVer: KB_INGEST_CONTRACT,
    source: payload.source,
    counts,
    gateReport,
    questionIds,
    queueIds,
    quarantineIds,
    dryRun: false,
    backup,
  };
}

// ---------------------------------------------------------------------------
// 读侧：一次批的全账（AI:PRD-003 · 003-D）
// ---------------------------------------------------------------------------

export interface IngestBatchRecord {
  id: string;
  contractVer: string;
  source: string;
  payloadHash: string | null;
  counts: IngestCounts;
  status: string | null;
  createdAt: string | null;
  committedAt: string | null;
  /**
   * 逐题逐闸详账（`ingest_batch.gate_report_json` 解析后）。
   * 🔴 解析不动就给 null，同时把原文放在 gateReportRaw —— 老批/脏行不该让读侧炸。
   */
  gateReport: IngestGateReport | null;
  gateReportRaw: string | null;
  /** 落库题（按 id 序） */
  questionIds: string[];
  /** 这一批的隔离行 */
  quarantine: {
    total: number;
    open: number;
    resolved: number;
    /** 未结的隔离行 id（最多 50 条，够定位就行） */
    openIds: string[];
  };
}

/**
 * 取一次录题批的全账：批行 + gate_report_json 全量 + 关联隔离计数。
 *
 * 🔴 只读。给 MCP 的 `get_ingest_batch` 与页面共用一条路 ——
 *    「网站看到什么，agent 就看到什么」这句话不是口号，是同一个函数。
 */
export async function getIngestBatch(
  batchId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<IngestBatchRecord | null> {
  const id = (batchId ?? "").trim();
  if (!id) return null;
  const h = opts.handle ?? (await getCoreDb());

  const rows = await h.db
    .select()
    .from(ingestBatch)
    .where(eq(ingestBatch.id, id));
  const b = rows[0];
  if (!b) return null;

  let parsed: IngestGateReport | null = null;
  if (b.gateReportJson) {
    try {
      parsed = JSON.parse(b.gateReportJson) as IngestGateReport;
    } catch {
      parsed = null; // 脏行：原文照给（gateReportRaw），别让读侧炸
    }
  }

  const qs = await h.db
    .select({ id: question.id })
    .from(question)
    .where(eq(question.ingestBatchId, id));

  const qr = await h.db
    .select({
      id: quarantine.id,
      resolvedAt: quarantine.resolvedAt,
    })
    .from(quarantine)
    .where(eq(quarantine.batchId, id));
  const open = qr.filter((r) => !r.resolvedAt);

  return {
    id: b.id,
    contractVer: b.contractVer,
    source: b.source,
    payloadHash: b.payloadHash,
    counts: {
      total: Number(b.nTotal ?? 0),
      accepted: Number(b.nAccepted ?? 0),
      queued: Number(b.nQueued ?? 0),
      rejected: Number(b.nRejected ?? 0),
    },
    status: b.status,
    createdAt: b.createdAt,
    committedAt: b.committedAt,
    gateReport: parsed,
    gateReportRaw: b.gateReportJson,
    questionIds: qs.map((q) => q.id).sort(),
    quarantine: {
      total: qr.length,
      open: open.length,
      resolved: qr.length - open.length,
      openIds: open.slice(0, 50).map((r) => r.id),
    },
  };
}
