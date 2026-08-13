/**
 * core/gradebridge.ts —— 学情挂桥读侧视图（AI:PRD-006 · 006-B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 G-1 红线：本文件**全程零写**。对圣域（审核.db）只有 SELECT（经 mode=ro 的
 *      物理只读句柄），对本库也只有 SELECT。这里一行 withCoreWrite 都不该出现 ——
 *      出现了就是有人在读侧偷偷落缓存，而缓存与真相漂开是最难查的一类错。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 桥怎么搭（M1 审查修正后的口径，006 备料全量核过） ─────────────────────
 *
 *   审核.db batches ──(student, day)──▶ 审核.db slots ──task_id──▶ 我方 grading_task_map
 *                 └──(batch_id)──▶ 我方 grading_batch_link ──task_id──┘        │
 *                                                                            sku_id
 *                                                                              ▼
 *                          我方 sku_item(ord = qno) ──▶ question ──▶ question_kp
 *
 *   🔴 桥键是 `slots(student, day)`，**绝不是 `batches.task_id`** —— 那一列 10 行全 NULL，
 *      是从未被写入的死列（M1 审查结论，006 备料实测坐实）。
 *   🔴 `slots.day` 是「该学员自己的第 N 次打卡」，`tasks.day` 是「该线的第 N 天」，
 *      两者不等（batch 10：学员 day=2 ↔ 线 day=1）。取题单一律用 `tasks.sheet`，
 *      **别拿 day 去拼路径**。
 *   🔴 同一学员同一天可能交两条线（洛天熙 08-11 交了混合运算 + 整式），
 *      所以桥必须落到 slot 粒度，不能按 (student, 日期) 归并。
 *   🔴 `grading_batch_link` 是人工补录桥，**不是一次性迁移**：直批链（L1 静默）
 *      绕过 收卷.py，不写 slots，每天都会产生新孤儿（备料 R6）。
 *   🔴 挂不上桥的批次**如实列明细，不静默丢**（M1：不登记的任务=学情算不到考点，
 *      但明细里看得见）。所有对外的统计一律带 matched/total 覆盖口径。
 *
 * ── 判定口径三条（2026-08-13 用户拍板；正本 = `订阅特训/_产线/批改标准.md` §二之〇
 *    与 `需求沉淀-2026-08-13-无人值守流水线.md` §一。本文件的聚合逐条按它算） ──
 *
 *   ① **空题算失分**：题面在卷上、整题未作答 → 圣域已落 `verdict_final='×'`。
 *      读侧不必特判：它自然进错误率的分子与分母。
 *      🔴 漏抄（卷上连题面都没有）≠ 空题 → `verdict_final='skip'`，**整条摘掉**，
 *      不进分子也不进分母（batch 10 因此是 16/19 而不是 16/20）。
 *   ② **订正对了算对**：判定看订正后结果 → `verdict_final='√'` 即算对，
 *      **哪怕它带着 error_kp 码**（第一遍的错因留作诊断）。
 *      🔴 由此：「有码 = 错题」是**错判据**，读侧一律以 verdict_final 判对错、
 *         以 error_kp 判归因，两件事解耦。
 *   ③ **抄错题面按所抄算**：复锚后 `verdict_final='√'`，why 落 note。
 *      这类码只是抄写提醒，**不算错因**，本文件从错因分布里剔除并单列计数。
 *      🔴 匹配的是 `直批.py:242-246` 写进 note 的**代码真字符串**
 *      （`抄错题面（题单：` / `只提醒抄写`），不是文档里的口语说法「抄写提醒」——
 *      按口语写 LIKE 永远匹配不到，这是个安静的坑（备料 R5）。
 *
 * ── error_kp 三形态（M1 · R-GR-R2；🔴 语义分开，绝不并列） ────────────────
 *
 *   带码 `'["pow","sign"]'` → **展开归因**（json_each 口径；这里在 JS 侧解析，等价）
 *   `'[]'`                  → **判×拒绝归因**：明确说了「错的不属于本题所挂考点」，
 *                             per_kp 里该题所挂的码**一个都不扣**（batch10 q19 就是这样）
 *   `NULL`                  → **未给归因**（老批次/未走归因链）：兜底档，
 *                             per_kp 里该题所挂的码**全扣**
 *   🔴 把 NULL 当 `[]` 会让 10 道错题的考点凭空「算对」（现库 ×且NULL 有 10 行，
 *      是 ×且'[]' 的三倍多）。两者必须分列，不许合并。
 */
import { asc, eq, inArray } from "drizzle-orm";

import {
  errCodeMap,
  errorCause,
  gradingBatchLink,
  gradingTaskMap,
  kp,
  questionKp,
  roster,
  skuItem,
} from "~/server/db/schema";
import { getCoreDb, type CoreDbHandle } from "./db";
import { getGradingDb } from "./grading";

// ---------------------------------------------------------------------------
// 口径常量（🔴 改这里等于改口径，改之前先看文件头的正本指针）
// ---------------------------------------------------------------------------

/**
 * 🔴 「抄写提醒」在 note 里的**代码真字符串**（`订阅特训/_产线/直批.py:242-246`）：
 *
 * ```python
 * r['why'] = ('抄错题面（题单：%s ／ 卷面抄成：%s），按他抄的那道题算：%s'
 *             % (..., '结果无误，判对（只提醒抄写）' if machine == '√' else '仍然算错'))
 * ```
 *
 * 🔴 文档里的「抄写提醒」四个字**在代码里不存在**，按它写 LIKE 是零命中（备料 R5）。
 *    现库 0 命中属正常：口径③ 的代码路径 2026-08-13 才上线，至今未触发。
 */
export const COPY_REMINDER_MARKERS = [
  "抄错题面（题单：",
  "只提醒抄写",
] as const;

/**
 * 复合键拼串的分隔符 = NUL。
 * 🔴 用 `|` 或空格都可能被数据本身撞上（代号、考点名、码里出现分隔符 = 两个不同的键
 *    拼出同一个串，统计悄悄并成一堆）。NUL 在这些字段里不可能出现。
 * 🔴 与 integrity.ts 的 `ROW_KEY_SEP`（审计 rowRef 用 `|`）是两回事：那是**要给人看**
 *    的行标识，这里是纯进程内的 Map key，不落库、不出 wire。
 */
const K = "\u0000";

/** 判定值（圣域 items.verdict_final 的实际取值面） */
export const VERDICT_OK = "√";
export const VERDICT_WRONG = "×";
export const VERDICT_SKIP = "skip";

/** 读侧聚合的口径注释（页面/工具原样displays，省得每处各写一句各不相同） */
export const RATE_RUBRIC: readonly string[] = [
  "口径①：空题算失分 —— 圣域已落 verdict_final='×'，它进错误率的分子与分母；漏抄落 'skip'，整条摘掉（不进分子也不进分母）。",
  "口径②：订正对了算对 —— verdict_final='√' 即算对，哪怕带着 error_kp 码（第一遍诊断留作分析）。🔴「有码=错题」是错判据。",
  "口径③：抄错题面按所抄算 —— 复锚后判 √，note 里带「抄错题面（题单：」／「只提醒抄写」，这类码不计入错因分布，单列。",
  "正本：订阅特训/_产线/批改标准.md §二之〇 + 需求沉淀-2026-08-13-无人值守流水线.md §一（2026-08-13 用户拍板）。",
];

// ---------------------------------------------------------------------------
// 桥（公共层）
// ---------------------------------------------------------------------------

export interface BridgeTask {
  taskId: number;
  date: string | null;
  line: string | null;
  book: string | null;
  /** 🔴 该线的第几天（≠ slots.day 学员自己的第几次） */
  day: number | null;
  nq: number | null;
  kind: string | null;
  /** 题单正本路径（🔴 取题单认它，别拿 day 拼） */
  sheet: string | null;
}

export interface BridgedBatch {
  batchId: number;
  /** 🔴 学员代号（圣域口径，真名从不落盘） */
  student: string | null;
  /** 🔴 学员自己的第几次打卡（≠ tasks.day） */
  day: number | null;
  status: string | null;
  round: number | null;
  /** 'L1静默' = 无人值守放行；NULL = 人工点的（08-13 上线的列） */
  auto: string | null;
  exportedAt: string | null;
  /** 挂上桥了吗 */
  matched: boolean;
  /** 从哪条路挂上的：slots 主路 / grading_batch_link 人工补录桥 */
  via: "slots" | "link" | null;
  taskId: number | null;
  skuId: string | null;
  task: BridgeTask | null;
  /** 🔴 没挂上时说清楚为什么（不静默丢） */
  why: string | null;
}

export interface BridgeReport {
  batches: BridgedBatch[];
  /** 挂上桥的批次数 */
  matched: number;
  /** 圣域侧批次总数（覆盖率的分母） */
  total: number;
  /** "30.0%"，无批次时 "n/a" */
  coverage: string;
  /** 挂不上桥的明细（= batches.filter(!matched)，摆出来省得调用方自己筛） */
  unmatched: BridgedBatch[];
  warnings: string[];
}

export interface BridgeOptions {
  handle?: CoreDbHandle;
  gradingUrl?: string;
  /** 只看某个学员代号 */
  student?: string;
  /** 只看某条线（tasks.line，如 '七上混合运算'）——未挂桥批次不带线名，会被滤掉 */
  line?: string;
}

/**
 * 桥的**唯一实现**：批次 → 任务 → 天卷 SKU。
 *
 * 🔴 对账 C5 与本文件三个视图共用它（005 时 C5 里那份内联逻辑已改为调这里）。
 *    两份桥迟早各自漂一点，而「对账说挂上了、报告说没挂上」这种矛盾最难查。
 */
export async function bridgeBatches(
  opts: BridgeOptions = {},
): Promise<BridgeReport> {
  const h = opts.handle ?? (await getCoreDb());
  const g = await getGradingDb(opts.gradingUrl);
  const warnings: string[] = [];

  // 🔴 列名显式写全（需求卡定的纪律）：圣域会演进（08-13 刚加了 batches.auto），
  //    SELECT * 会在加列那天悄悄改变返回形状。
  const batches = g.query<{
    id: number;
    student: string | null;
    day: number | null;
    status: string | null;
    round: number | null;
    auto: string | null;
    exported_at: string | null;
  }>(
    "SELECT id, student, day, status, round, auto, exported_at FROM batches ORDER BY id",
  );
  const slots = g.query<{
    task_id: number | null;
    student: string | null;
    day: number | null;
  }>("SELECT task_id, student, day FROM slots");
  const tasks = g.query<{
    id: number;
    date: string | null;
    line: string | null;
    book: string | null;
    day: number | null;
    nq: number | null;
    kind: string | null;
    sheet: string | null;
  }>("SELECT id, date, line, book, day, nq, kind, sheet FROM tasks");

  const taskById = new Map<number, BridgeTask>(
    tasks.map((t) => [
      Number(t.id),
      {
        taskId: Number(t.id),
        date: t.date,
        line: t.line,
        book: t.book,
        day: t.day === null ? null : Number(t.day),
        nq: t.nq === null ? null : Number(t.nq),
        kind: t.kind,
        sheet: t.sheet,
      },
    ]),
  );

  const mapRows = await h.db
    .select({ taskId: gradingTaskMap.taskId, skuId: gradingTaskMap.skuId })
    .from(gradingTaskMap);
  const skuByTask = new Map(mapRows.map((r) => [Number(r.taskId), r.skuId]));

  const linkRows = await h.db
    .select({
      batchId: gradingBatchLink.batchId,
      taskId: gradingBatchLink.taskId,
    })
    .from(gradingBatchLink);
  const linkByBatch = new Map(
    linkRows.map((r) => [Number(r.batchId), Number(r.taskId)]),
  );

  // 桥键 = (student, day)。\u0000 做分隔符：代号里不可能出现 NUL，拼串撞不了。
  const slotKey = new Map<string, number>();
  for (const s of slots) {
    if (s.task_id === null) continue;
    slotKey.set(`${s.student ?? ""}${K}${s.day ?? ""}`, Number(s.task_id));
  }

  const out: BridgedBatch[] = [];
  for (const b of batches) {
    if (opts.student && b.student !== opts.student) continue;

    const viaSlot = slotKey.get(`${b.student ?? ""}${K}${b.day ?? ""}`);
    const viaLink = linkByBatch.get(Number(b.id));
    const slotOk = viaSlot !== undefined && skuByTask.has(viaSlot);
    const linkOk = viaLink !== undefined && skuByTask.has(viaLink);
    const taskId = slotOk ? viaSlot : linkOk ? viaLink : null;

    const why =
      taskId !== null
        ? null
        : viaSlot !== undefined
          ? `slots→task_id=${viaSlot}，但该 task 未登记 grading_task_map` +
            (taskById.get(viaSlot)?.kind === "兜底"
              ? "（task 是「兜底」：学校卷/自备册，本体上没有题单 —— 按 M1 诚实边界不建桥、不编造考点归因）"
              : "")
          : viaLink !== undefined
            ? `补录桥→task_id=${viaLink}，但该 task 未登记 grading_task_map`
            : "slots 与补录桥两路都查不到（多半是直批链没走收卷.py，没写 slots —— 用 linkGradingBatch 人工补录）";

    out.push({
      batchId: Number(b.id),
      student: b.student,
      day: b.day === null ? null : Number(b.day),
      status: b.status,
      round: b.round === null ? null : Number(b.round),
      auto: b.auto,
      exportedAt: b.exported_at,
      matched: taskId !== null,
      via: taskId === null ? null : slotOk ? "slots" : "link",
      taskId,
      skuId: taskId === null ? null : (skuByTask.get(taskId) ?? null),
      task: taskId === null ? null : (taskById.get(taskId) ?? null),
      why,
    });
  }

  // 🔴 line 过滤只在**挂上桥之后**才谈得上（未挂桥的批次没有线名）——
  //    滤掉的那些要如实说一声，否则 total 变小会让覆盖率虚高。
  let 结果 = out;
  if (opts.line) {
    const 全量 = out.length;
    结果 = out.filter((b) => b.task?.line === opts.line);
    const 丢掉 = 全量 - 结果.length;
    if (丢掉 > 0) {
      warnings.push(
        `按线名「${opts.line}」过滤后少了 ${丢掉} 个批次 —— 其中包含**所有未挂桥的批次**` +
          "（它们没有线名，天然被滤掉）。要看全量覆盖口径请不要传 line。",
      );
    }
  }

  const matched = 结果.filter((b) => b.matched).length;
  const total = 结果.length;
  return {
    batches: 结果,
    matched,
    total,
    coverage: total === 0 ? "n/a" : `${((matched / total) * 100).toFixed(1)}%`,
    unmatched: 结果.filter((b) => !b.matched),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 逐题：桥的下半截（items ⨝ sku_item(ord=qno) → question → question_kp）
// ---------------------------------------------------------------------------

/** error_kp 的三形态 */
export type CauseForm =
  /** 带码：展开归因 */
  | "coded"
  /** '[]'：判×拒绝归因（错的不属于本题所挂考点） */
  | "unattributed"
  /** NULL：未给归因（老批次/未走归因链）—— 🔴 与 '[]' 语义不同 */
  | "unrecorded";

export interface BridgedItemKp {
  kpId: string;
  name: string;
  isPrimary: boolean;
}

export interface BridgedItem {
  batchId: number;
  student: string | null;
  /** 学员自己的第几次打卡 */
  day: number | null;
  taskId: number;
  line: string | null;
  skuId: string;
  qno: number;
  verdictPre: string | null;
  verdictFinal: string | null;
  /** verdict_final='√' */
  ok: boolean;
  /** verdict_final='×' */
  wrong: boolean;
  /** verdict_final='skip'（漏抄）—— 🔴 整条摘掉，不进任何分母 */
  skipped: boolean;
  note: string | null;
  /** error_kp 原样（诊断用，别自己再解析一遍） */
  errorKpRaw: string | null;
  /** 解析出来的码（三形态里只有 coded 非空） */
  errorCodes: string[];
  causeForm: CauseForm;
  /** 🔴 口径③：note 命中抄写提醒 —— 这题的码不算错因 */
  copyReminder: boolean;
  /** 对位到的题（ord=qno）；题单短于 items 时为 null */
  questionId: string | null;
  /** 题单挂载的考点 —— 🔴 per_kp 的**分母**来自这里，不是 error_kp */
  kps: BridgedItemKp[];
}

export interface BridgedItemsResult {
  bridge: BridgeReport;
  items: BridgedItem[];
  warnings: string[];
}

function 解析形态(raw: string | null): {
  form: CauseForm;
  codes: string[];
  malformed: boolean;
} {
  if (raw === null) return { form: "unrecorded", codes: [], malformed: false };
  const s = raw.trim();
  // 空串不是 '[]'：产线没写过它，出现了就是脏数据。当作「未记录」（兜底档），
  // 但要在 warnings 里说一声 —— 静默归类是把脏数据洗白。
  if (s === "") return { form: "unrecorded", codes: [], malformed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { form: "unrecorded", codes: [], malformed: true };
  }
  if (!Array.isArray(parsed)) {
    return { form: "unrecorded", codes: [], malformed: true };
  }
  const codes = parsed
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (codes.length === 0) {
    return { form: "unattributed", codes: [], malformed: false };
  }
  return { form: "coded", codes, malformed: false };
}

/** 🔴 口径③：note 里带的是代码真字符串，不是文档里的口语说法 */
export function isCopyReminderNote(note: string | null): boolean {
  if (!note) return false;
  return COPY_REMINDER_MARKERS.some((m) => note.includes(m));
}

/**
 * 挂桥链的逐题事实（三个视图的公共取数层）。
 * 🔴 全程只读；未挂桥的批次不产出 item，但它们在 `bridge.unmatched` 里看得见。
 */
export async function bridgedItems(
  opts: BridgeOptions = {},
): Promise<BridgedItemsResult> {
  const h = opts.handle ?? (await getCoreDb());
  const g = await getGradingDb(opts.gradingUrl);
  const bridge = await bridgeBatches(opts);
  const warnings = [...bridge.warnings];

  const 挂上的 = bridge.batches.filter((b) => b.matched && b.skuId);
  if (挂上的.length === 0) return { bridge, items: [], warnings };

  // 题单：sku_id → ord → question_id（一次取全，别按批次 N+1 次查）
  const skuIds = [...new Set(挂上的.map((b) => b.skuId!))];
  const 位 = await h.db
    .select({
      skuId: skuItem.skuId,
      ord: skuItem.ord,
      questionId: skuItem.questionId,
    })
    .from(skuItem)
    .where(inArray(skuItem.skuId, skuIds));
  const 题位 = new Map<string, string | null>();
  for (const r of 位) 题位.set(`${r.skuId}${K}${r.ord}`, r.questionId);

  // 题 → 考点（🔴 per_kp 的分母来源）
  const qids = [
    ...new Set(位.map((r) => r.questionId).filter((x): x is string => !!x)),
  ];
  const 考点 = new Map<string, BridgedItemKp[]>();
  if (qids.length > 0) {
    const rows = await h.db
      .select({
        questionId: questionKp.questionId,
        kpId: questionKp.kpId,
        name: kp.name,
        isPrimary: questionKp.isPrimary,
      })
      .from(questionKp)
      .innerJoin(kp, eq(kp.id, questionKp.kpId))
      .where(inArray(questionKp.questionId, qids))
      .orderBy(asc(questionKp.questionId));
    for (const r of rows) {
      const arr = 考点.get(r.questionId) ?? [];
      arr.push({
        kpId: r.kpId,
        name: r.name,
        isPrimary: Number(r.isPrimary ?? 0) === 1,
      });
      考点.set(r.questionId, arr);
    }
  }

  const items: BridgedItem[] = [];
  let malformed = 0;
  let 缺位 = 0;
  let 无考点 = 0;

  for (const b of 挂上的) {
    const rows = g.query<{
      batch_id: number;
      qno: number;
      verdict_pre: string | null;
      verdict_final: string | null;
      note: string | null;
      error_kp: string | null;
    }>(
      "SELECT batch_id, qno, verdict_pre, verdict_final, note, error_kp " +
        "FROM items WHERE batch_id = ? ORDER BY qno",
      [b.batchId],
    );
    for (const r of rows) {
      const qno = Number(r.qno);
      const questionId = 题位.get(`${b.skuId}${K}${qno}`) ?? null;
      if (!questionId) 缺位 += 1;
      const kps = questionId ? (考点.get(questionId) ?? []) : [];
      if (questionId && kps.length === 0) 无考点 += 1;
      const f = 解析形态(r.error_kp);
      if (f.malformed) malformed += 1;
      items.push({
        batchId: b.batchId,
        student: b.student,
        day: b.day,
        taskId: b.taskId!,
        line: b.task?.line ?? null,
        skuId: b.skuId!,
        qno,
        verdictPre: r.verdict_pre,
        verdictFinal: r.verdict_final,
        ok: r.verdict_final === VERDICT_OK,
        wrong: r.verdict_final === VERDICT_WRONG,
        skipped: r.verdict_final === VERDICT_SKIP,
        note: r.note,
        errorKpRaw: r.error_kp,
        errorCodes: f.codes,
        causeForm: f.form,
        copyReminder: isCopyReminderNote(r.note),
        questionId,
        kps,
      });
    }
  }

  if (malformed > 0) {
    warnings.push(
      `${malformed} 行 items.error_kp 既不是 NULL 也不是合法 JSON 数组（空串/坏串）——` +
        "已按「未记录」兜底档处理（该题所挂考点全扣），🔴 但这是脏数据，别当正常形态。",
    );
  }
  if (缺位 > 0) {
    warnings.push(
      `${缺位} 条作答在题单里找不到对位的题（sku_item.ord = items.qno 对不上）——` +
        "多半是登记的题单比实际卷短。这些行照常进对错统计，但算不到考点上。",
    );
  }
  if (无考点 > 0) {
    warnings.push(
      `${无考点} 条作答对位到的题**没挂任何考点** —— 它们进不了 per_kp/群错误率的分母。`,
    );
  }

  return { bridge, items, warnings };
}

// ---------------------------------------------------------------------------
// 视图① 考点群错误率
// ---------------------------------------------------------------------------

export interface KpErrorRateRow {
  kpId: string;
  kpName: string;
  /** 错题次：verdict_final='×' 的 (题, 考点) 对数 */
  wrong: number;
  /** 总题次：非 skip 的 (题, 考点) 对数 —— 🔴 一题挂 N 个考点就算 N 次 */
  total: number;
  /** wrong/total，total=0 时 null */
  rate: number | null;
  /** 做过这个考点的学员数（代号去重） */
  students: number;
  /** 涉及批次数 */
  batches: number;
}

export interface CoverageView {
  /** 挂上桥的批次数 */
  matched: number;
  /** 批次总数 */
  total: number;
  /** "30.0%" / "n/a" */
  rate: string;
  /** 🔴 挂不上桥的明细（不静默丢） */
  unmatched: {
    batchId: number;
    student: string | null;
    day: number | null;
    auto: string | null;
    why: string | null;
  }[];
}

export interface KpGroupErrorRateResult {
  rows: KpErrorRateRow[];
  /** 🔴 必带：这个数字是在多大的样本面上算出来的 */
  coverage: CoverageView;
  /** 参与统计的题次总数（样本量，别把 1 例算成 100%） */
  sampleItems: number;
  rubric: readonly string[];
  warnings: string[];
}

function 覆盖(bridge: BridgeReport): CoverageView {
  return {
    matched: bridge.matched,
    total: bridge.total,
    rate: bridge.coverage,
    unmatched: bridge.unmatched.map((b) => ({
      batchId: b.batchId,
      student: b.student,
      day: b.day,
      auto: b.auto,
      why: b.why,
    })),
  };
}

/**
 * 考点群错误率：按考点聚合「错题次 / 总题次 / 学生数」。
 *
 * 🔴 分子分母按判定口径三条算：`×`（含空题，口径①）进分子；`√`（含订正对了、
 *    含抄错按所抄算，口径②③）算对；`skip`（漏抄）整条摘掉。
 * 🔴 **必带 matched/total 覆盖口径** —— 群错误率是本卡的纯新增能力，
 *    批改线没有对应实现、没有对数基准，唯一能自证的就是「样本面说得清楚」。
 */
export async function kpGroupErrorRate(
  opts: BridgeOptions & { kpIds?: string[] } = {},
): Promise<KpGroupErrorRateResult> {
  const { bridge, items, warnings } = await bridgedItems(opts);
  const 只看 = opts.kpIds && opts.kpIds.length > 0 ? new Set(opts.kpIds) : null;

  const acc = new Map<
    string,
    {
      name: string;
      wrong: number;
      total: number;
      students: Set<string>;
      batches: Set<number>;
    }
  >();
  let sampleItems = 0;

  for (const it of items) {
    if (it.skipped) continue; // 口径①：漏抄整条摘掉
    sampleItems += 1;
    for (const k of it.kps) {
      if (只看 && !只看.has(k.kpId)) continue;
      const e = acc.get(k.kpId) ?? {
        name: k.name,
        wrong: 0,
        total: 0,
        students: new Set<string>(),
        batches: new Set<number>(),
      };
      e.total += 1;
      if (it.wrong) e.wrong += 1;
      if (it.student) e.students.add(it.student);
      e.batches.add(it.batchId);
      acc.set(k.kpId, e);
    }
  }

  const rows: KpErrorRateRow[] = [...acc.entries()]
    .map(([kpId, e]) => ({
      kpId,
      kpName: e.name,
      wrong: e.wrong,
      total: e.total,
      rate: e.total === 0 ? null : e.wrong / e.total,
      students: e.students.size,
      batches: e.batches.size,
    }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);

  const w = [...warnings];
  if (bridge.matched === 0 && bridge.total > 0) {
    w.push(
      `覆盖 0/${bridge.total} —— 一个批次都没挂上桥，群错误率在这个样本面上算不出来。` +
        "明细见 coverage.unmatched（不是「没有错误」，是「没有数据」）。",
    );
  }

  return {
    rows,
    coverage: 覆盖(bridge),
    sampleItems,
    rubric: RATE_RUBRIC,
    warnings: w,
  };
}

// ---------------------------------------------------------------------------
// 视图② 学生已做题集
// ---------------------------------------------------------------------------

export interface StudentDoneSetResult {
  code: string;
  /** 🔴 直接喂 searchQuestions 的 excludeQuestionIds */
  questionIds: string[];
  /** 有判定记录的题次（含 skip） */
  gradedItems: number;
  coverage: CoverageView;
  warnings: string[];
}

/**
 * 某学员**已做题集**（挂桥链聚合）。
 *
 * 用途：选题时排除已做 —— `searchQuestions({ excludeQuestionIds: r.questionIds })`。
 *
 * 🔴 「已做」= 这道题在他交过、且已判过的卷子上（含判 skip 的漏抄题：题发出去了，
 *    再发一遍没意义）。**未挂桥批次上做过的题算不出来**，所以 coverage 必看：
 *    覆盖不全时这个集合是**偏小**的（会把做过的题当没做过再发一次）。
 */
export async function studentDoneSet(
  code: string,
  opts: Omit<BridgeOptions, "student"> = {},
): Promise<StudentDoneSetResult> {
  const { bridge, items, warnings } = await bridgedItems({
    ...opts,
    student: code,
  });
  const ids = new Set<string>();
  for (const it of items) if (it.questionId) ids.add(it.questionId);

  const w = [...warnings];
  if (bridge.unmatched.length > 0) {
    w.push(
      `该学员有 ${bridge.unmatched.length} 个批次没挂上桥（明细见 coverage.unmatched）——` +
        "那几卷做过的题**不在**这个集合里，排除已做会漏。",
    );
  }

  return {
    code,
    questionIds: [...ids].sort(),
    gradedItems: items.length,
    coverage: 覆盖(bridge),
    warnings: w,
  };
}

// ---------------------------------------------------------------------------
// 视图③ 错因分布
// ---------------------------------------------------------------------------

export interface CauseDistRow {
  causeId: string;
  causeName: string;
  causeStatus: string | null;
  kpId: string;
  kpName: string;
  errCode: string;
  /** 命中次数（码次，不是题次：一题两码算两次） */
  count: number;
  students: number;
  batches: number;
}

export interface UnmappedCode {
  kpId: string;
  kpName: string;
  errCode: string;
  count: number;
  /** 最多 6 条样本，指得回去 */
  sample: { batchId: number; qno: number }[];
}

export interface FormBucket {
  count: number;
  sample: { batchId: number; qno: number; student: string | null }[];
}

export interface CauseDistributionResult {
  /** 归因分布（已经过 err_code_map 翻译的） */
  rows: CauseDistRow[];
  /** 🔴 三形态之二：判×且 error_kp='[]' —— 明确拒绝归因，**不是**没归因 */
  unattributed: FormBucket;
  /** 🔴 三形态之三：判×且 error_kp IS NULL —— 未给归因（老批次），与 '[]' 语义不同 */
  unrecorded: FormBucket;
  /** 口径③：抄写提醒，这些码剔除出错因分布，单列 */
  copyReminder: { count: number; codes: { errCode: string; count: number }[] };
  /**
   * 🔴🔴 红旗：展开后 (kp_id, err_code) 在 err_code_map 里查不到映射的码。
   *    **不静默丢** —— 丢了就等于「这些错没发生过」，而它们恰恰是最该补映射的地方。
   *    非空时 warnings 里也有一条；REG-F 有断言盯着它。
   */
  unmapped: UnmappedCode[];
  coverage: CoverageView;
  /** 参与统计的码次总数（样本量） */
  sampleCodes: number;
  rubric: readonly string[];
  warnings: string[];
}

/**
 * 错因分布：`items.error_kp` 展开 ⨝ 题主考点 ⨝ `err_code_map(kp_id, err_code)` ⨝ `error_cause`。
 *
 * 🔴 **三形态分列**（带码展开 / '[]' 拒绝归因 / NULL 未记录），绝不并成一个「没归因」。
 * 🔴 展开后查不到映射的 (考点, 码) 进 `unmapped` 红旗，不静默丢。
 * 🔴 归因与判定**解耦**：`√` 的题也可能带码（订正对了/抄错按所抄算），
 *    所以这里的分布不是「错题分布」，是「错因码分布」。抄写提醒那类单独剔出去。
 */
export async function causeDistribution(
  opts: BridgeOptions & { kpId?: string } = {},
): Promise<CauseDistributionResult> {
  const h = opts.handle ?? (await getCoreDb());
  const { bridge, items, warnings } = await bridgedItems(opts);

  // 翻译表一次取全（错因域全空时这里就是两张空表 —— 于是所有码进 unmapped，
  // 这正是「还没铺映射」的诚实形态，不是故障）
  const maps = await h.db
    .select({
      kpId: errCodeMap.kpId,
      errCode: errCodeMap.errCode,
      causeId: errCodeMap.causeId,
      causeName: errorCause.name,
      causeStatus: errorCause.status,
      kpName: kp.name,
    })
    .from(errCodeMap)
    .innerJoin(errorCause, eq(errorCause.id, errCodeMap.causeId))
    .innerJoin(kp, eq(kp.id, errCodeMap.kpId));
  const 译 = new Map(
    maps.map((m) => [`${m.kpId}${K}${m.errCode}`, m] as const),
  );

  const acc = new Map<
    string,
    {
      row: Omit<CauseDistRow, "count" | "students" | "batches">;
      count: number;
      students: Set<string>;
      batches: Set<number>;
    }
  >();
  const unmapped = new Map<
    string,
    {
      kpId: string;
      kpName: string;
      errCode: string;
      count: number;
      sample: { batchId: number; qno: number }[];
    }
  >();
  const 抄写 = new Map<string, number>();
  let 抄写次 = 0;
  const 拒绝: FormBucket = { count: 0, sample: [] };
  const 未给: FormBucket = { count: 0, sample: [] };
  let sampleCodes = 0;
  const 只看 = opts.kpId ?? null;

  for (const it of items) {
    if (it.skipped) continue;
    // 🔴 kpId 过滤要在**进桶之前**做，三个桶一视同仁：
    //    只筛 rows 而让 unattributed/unrecorded 保持全局，会让考点页上出现
    //    「本考点归因 0 条、未归因 1 条」这种自相矛盾的读数（那 1 条根本是别的考点的题）。
    if (只看 && !it.kps.some((k) => k.kpId === 只看)) continue;

    // 三形态之二/之三：只在**判×**时才有诊断意义（判√ 的空码是转录默认值）
    if (it.wrong && it.causeForm === "unattributed") {
      拒绝.count += 1;
      if (拒绝.sample.length < 6)
        拒绝.sample.push({
          batchId: it.batchId,
          qno: it.qno,
          student: it.student,
        });
      continue;
    }
    if (it.wrong && it.causeForm === "unrecorded") {
      未给.count += 1;
      if (未给.sample.length < 6)
        未给.sample.push({
          batchId: it.batchId,
          qno: it.qno,
          student: it.student,
        });
      continue;
    }
    if (it.causeForm !== "coded") continue;

    // 口径③：抄写提醒的码不算错因，单列
    if (it.copyReminder) {
      for (const c of it.errorCodes) {
        抄写.set(c, (抄写.get(c) ?? 0) + 1);
        抄写次 += 1;
      }
      continue;
    }

    // 🔴 码归到**题的主考点**上（没有主考点就退到全部挂载考点 —— 一题一码在
    //    多考点题上无从分辨该算谁，退化时按全部算并在 warnings 里说明）
    const 主 = it.kps.filter((k) => k.isPrimary);
    const 落点 = 主.length > 0 ? 主 : it.kps;
    for (const c of it.errorCodes) {
      for (const k of 落点) {
        if (只看 && k.kpId !== 只看) continue;
        sampleCodes += 1;
        const hit = 译.get(`${k.kpId}${K}${c}`);
        if (!hit) {
          const key = `${k.kpId}${K}${c}`;
          const u = unmapped.get(key) ?? {
            kpId: k.kpId,
            kpName: k.name,
            errCode: c,
            count: 0,
            sample: [],
          };
          u.count += 1;
          if (u.sample.length < 6)
            u.sample.push({ batchId: it.batchId, qno: it.qno });
          unmapped.set(key, u);
          continue;
        }
        const key = `${hit.causeId}${K}${k.kpId}${K}${c}`;
        const e = acc.get(key) ?? {
          row: {
            causeId: hit.causeId,
            causeName: hit.causeName,
            causeStatus: hit.causeStatus,
            kpId: k.kpId,
            kpName: k.name,
            errCode: c,
          },
          count: 0,
          students: new Set<string>(),
          batches: new Set<number>(),
        };
        e.count += 1;
        if (it.student) e.students.add(it.student);
        e.batches.add(it.batchId);
        acc.set(key, e);
      }
    }
  }

  const rows: CauseDistRow[] = [...acc.values()]
    .map((e) => ({
      ...e.row,
      count: e.count,
      students: e.students.size,
      batches: e.batches.size,
    }))
    .sort(
      (a, b) => b.count - a.count || a.causeName.localeCompare(b.causeName),
    );

  const u = [...unmapped.values()].sort((a, b) => b.count - a.count);
  const w = [...warnings];
  if (u.length > 0) {
    w.push(
      `🔴 ${u.length} 组 (考点, 码) 查不到 err_code_map 映射，共 ${u.reduce((s, x) => s + x.count, 0)} 个码次 ——` +
        "这些错**没有被静默丢掉**，都摆在 unmapped 里（带样本 batch/qno）。" +
        "处置：给这些 (考点, 码) 铺映射（mapErrCode），或确认这个码在这个考点下确实没有语义。",
    );
  }
  if (maps.length === 0) {
    w.push(
      "err_code_map 一条映射都没有 —— 错因分布必然全空、所有码都进 unmapped。" +
        "这是「种子还没灌」的诚实形态（灌种子是 006-C 的活），不是故障。",
    );
  }

  return {
    rows,
    unattributed: 拒绝,
    unrecorded: 未给,
    copyReminder: {
      count: 抄写次,
      codes: [...抄写.entries()]
        .map(([errCode, count]) => ({ errCode, count }))
        .sort((a, b) => b.count - a.count),
    },
    unmapped: u,
    coverage: 覆盖(bridge),
    sampleCodes,
    rubric: RATE_RUBRIC,
    warnings: w,
  };
}

// ---------------------------------------------------------------------------
// 视图④ 学生学情数据包（学情报告的取数入口）
// ---------------------------------------------------------------------------

export interface StudentBatchView {
  batchId: number;
  day: number | null;
  status: string | null;
  round: number | null;
  auto: string | null;
  exportedAt: string | null;
  matched: boolean;
  via: "slots" | "link" | null;
  taskId: number | null;
  line: string | null;
  /** 🔴 题单正本路径（取题单认它） */
  sheet: string | null;
  skuId: string | null;
  why: string | null;
  /** 🔴 题数口径：total = 判定行数 − skip；报告头条分数用它（16/19 而不是 16/20） */
  score: { ok: number; wrong: number; skip: number; total: number } | null;
}

export interface StudentKpRow {
  kpId: string;
  kpName: string;
  /** 对 —— 逐字复现产线 `批改.py:102-108` / `render_feedback._mastery()` 的公式 */
  ok: number;
  /** 总（分母 = 题单挂载，不是 error_kp） */
  total: number;
  /** 因 error_kp IS NULL 走兜底档「全扣」的题次（说清楚这个数是怎么来的） */
  fallbackAll: number;
}

export interface StudentViewResult {
  code: string;
  /** roster 维度行（没登记就是 null —— 不编造） */
  roster: {
    code: string;
    alias: string | null;
    grade: string | null;
    editionCtx: string | null;
    status: string | null;
    joinedAt: string | null;
    note: string | null;
  } | null;
  /** 已做题集规模（详单走 studentDoneSet） */
  done: { count: number; questionIds: string[] };
  /** 逐批次（🔴 含未挂桥的，如实列出） */
  batches: StudentBatchView[];
  /** 考点掌握（替换点③：报告「考点掌握情况」那一块的数） */
  perKp: StudentKpRow[];
  /** 错因汇总（替换点②的料） */
  causes: CauseDistributionResult;
  coverage: CoverageView;
  rubric: readonly string[];
  warnings: string[];
}

/**
 * 一个学员的学情数据包 —— **学情报告的取数入口**（验收 6-4 的替换点①②③）。
 *
 * 🔴 `perKp` 逐字复现产线公式（`批改.py:102-108`，与 `render_feedback._mastery()` 同一份）：
 *
 * ```
 * for m in marks:                 # 已剔除 skip
 *     ekp = m['error_kp']
 *     for k in m['kp']:           # 🔴 分母来自【题单的考点挂载】
 *         per_kp[k][1] += 1
 *         per_kp[k][0] += 1 if (m['ok'] or (ekp is not None and k not in ekp)) else 0
 * ```
 *
 * 三条不可改的语义：
 *   1. **分母 = 题单挂载**（我方 = `sku_item→question→question_kp`）。光有 error_kp 算不出掌握度。
 *   2. **错因归位不连坐**：一题挂 3 个考点只错 1 个，另外 2 个这题算对。
 *   3. `NULL` 与 `[]` **不同**：NULL=没信息→该题所挂考点全扣；`[]`=明确拒绝归因→一个都不扣。
 *
 * 🔴 「码是否命中某考点」经 `err_code_map(kp_id, err_code)` 判定。映射还没铺时，
 *    带码错题会退化成「谁都不扣」，同时 `causes.unmapped` 亮红旗 —— 宁可退化得看得见，
 *    也不要猜一个考点扣下去。
 *
 * 🔴 本函数**不出报告文案**：英雄卡结论、错题诊断措辞仍由学情报告 skill 写
 *    （记忆正本：英雄卡必须是真结论，来源 作答稿.json）。这里只交数据。
 */
export async function getStudentView(
  code: string,
  opts: Omit<BridgeOptions, "student"> = {},
): Promise<StudentViewResult> {
  const h = opts.handle ?? (await getCoreDb());
  const g = await getGradingDb(opts.gradingUrl);
  const o = { ...opts, student: code };
  const { bridge, items, warnings } = await bridgedItems(o);

  const 名册 = await h.db
    .select()
    .from(roster)
    .where(eq(roster.code, code))
    .limit(1);

  // 逐批次：挂上桥的用 items 算分；没挂桥的也得如实列出来（含它自己的判定计数）
  const byBatch = new Map<number, BridgedItem[]>();
  for (const it of items) {
    const arr = byBatch.get(it.batchId) ?? [];
    arr.push(it);
    byBatch.set(it.batchId, arr);
  }

  const batches: StudentBatchView[] = bridge.batches.map((b) => {
    let score: StudentBatchView["score"] = null;
    if (b.matched) {
      const arr = byBatch.get(b.batchId) ?? [];
      const ok = arr.filter((x) => x.ok).length;
      const wrong = arr.filter((x) => x.wrong).length;
      const skip = arr.filter((x) => x.skipped).length;
      score = { ok, wrong, skip, total: arr.length - skip };
    } else {
      // 🔴 没挂桥 ≠ 没数据：分数照样算得出（items 在圣域里），
      //    只是**算不到考点上**。如实给分数，别让这几卷在页面上显示成空白。
      const rows = g.query<{ verdict_final: string | null }>(
        "SELECT verdict_final FROM items WHERE batch_id = ?",
        [b.batchId],
      );
      const ok = rows.filter((r) => r.verdict_final === VERDICT_OK).length;
      const wrong = rows.filter(
        (r) => r.verdict_final === VERDICT_WRONG,
      ).length;
      const skip = rows.filter((r) => r.verdict_final === VERDICT_SKIP).length;
      score = { ok, wrong, skip, total: rows.length - skip };
    }
    return {
      batchId: b.batchId,
      day: b.day,
      status: b.status,
      round: b.round,
      auto: b.auto,
      exportedAt: b.exportedAt,
      matched: b.matched,
      via: b.via,
      taskId: b.taskId,
      line: b.task?.line ?? null,
      sheet: b.task?.sheet ?? null,
      skuId: b.skuId,
      why: b.why,
      score,
    };
  });

  // per_kp：产线公式的逐字移植
  const maps = await h.db
    .select({ kpId: errCodeMap.kpId, errCode: errCodeMap.errCode })
    .from(errCodeMap);
  const 映射面 = new Set(maps.map((m) => `${m.kpId}${K}${m.errCode}`));

  const perAcc = new Map<
    string,
    { name: string; ok: number; total: number; fallbackAll: number }
  >();
  for (const it of items) {
    if (it.skipped) continue; // 口径①：漏抄整条摘掉
    for (const k of it.kps) {
      const e = perAcc.get(k.kpId) ?? {
        name: k.name,
        ok: 0,
        total: 0,
        fallbackAll: 0,
      };
      e.total += 1;
      let 算对: boolean;
      if (it.ok) {
        算对 = true; // 口径②：订正对了算对（哪怕带码）
      } else if (it.causeForm === "unrecorded") {
        算对 = false; // 兜底档：没信息 → 该题所挂考点全扣
        e.fallbackAll += 1;
      } else if (it.causeForm === "unattributed") {
        算对 = true; // '[]' 明确拒绝归因 → 一个码都不扣
      } else {
        // 带码：只扣**被本题某个码命中**的那个考点（不连坐）
        算对 = !it.errorCodes.some((c) => 映射面.has(`${k.kpId}${K}${c}`));
      }
      if (算对) e.ok += 1;
      perAcc.set(k.kpId, e);
    }
  }
  const perKp: StudentKpRow[] = [...perAcc.entries()]
    .map(([kpId, e]) => ({
      kpId,
      kpName: e.name,
      ok: e.ok,
      total: e.total,
      fallbackAll: e.fallbackAll,
    }))
    .sort((a, b) => a.ok / a.total - b.ok / b.total || b.total - a.total);

  const causes = await causeDistribution(o);
  const doneIds = [
    ...new Set(items.map((i) => i.questionId).filter((x): x is string => !!x)),
  ].sort();

  const w = [...warnings];
  if (!名册[0]) {
    w.push(
      `roster 里没有代号「${code}」—— 数据照常算（学情事实全在圣域，roster 只是维度表），` +
        "但选题台/交付指向拿不到年级与版本上下文。要补就调 upsertRoster（🔴 只落代号，不落真名）。",
    );
  }
  if (bridge.matched < bridge.total) {
    w.push(
      `该学员 ${bridge.total} 个批次里有 ${bridge.total - bridge.matched} 个没挂上桥：` +
        "它们的分数照常给（batches[].score），但**算不到考点上**（perKp 不含它们）。" +
        "报告里若要用 perKp，得说清这一点。",
    );
  }
  if (映射面.size === 0) {
    w.push(
      "err_code_map 为空：带码的错题在 perKp 里退化成「谁都不扣」（宁可退化得看得见，也不猜一个考点扣下去）。" +
        "红旗见 causes.unmapped。",
    );
  }

  return {
    code,
    roster: 名册[0] ?? null,
    done: { count: doneIds.length, questionIds: doneIds },
    batches,
    perKp,
    causes,
    coverage: 覆盖(bridge),
    rubric: RATE_RUBRIC,
    warnings: w,
  };
}
