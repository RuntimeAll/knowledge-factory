/**
 * 终审台 · 读侧（AI:PRD-009 · 设计稿 §一 D-A）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **同名异库警示（每个接线文件头都要重申一遍）**
 *      本文件读的是 **圣域 `订阅特训/_产线/审核.db`**（批改线正本，G-1 红线只读），
 *      **不是** `举一反三产物/资料库.db`（punch 库），
 *      **也不是** 本产品自己的 `knowledge-factory/data/资料库.db`。
 *      三个库都叫得出「资料/审核」，混一个就是把别人产线的账当自己的读。
 *
 * 🔴 全文件**零写**：一律走 core 的 `getGradingDb()`（mode=ro 三道锁，
 *    非 SELECT/WITH/PRAGMA 在发到库之前就抛）。写在 `./spawn.ts`，
 *    而且那边也不写库 —— 它 spawn 圣域自己的 `审核库.py`。
 *
 * 🔴 查询口径**照抄** `审核库.py` 的 `pending()` / `confirmed()`：
 *      pending  → `status IN ('pending','rework')`，`ORDER BY student, day`
 *      confirmed→ `status='confirmed'`，`ORDER BY confirmed_at DESC, id DESC LIMIT 10`
 *    两处都不加自己的过滤条件 —— 列表少一条批次，人就少审一批。
 *
 * 🔴 与审核台 `/api/pending` 的**两处刻意差异**（都是补它的缺，不是改口径）：
 *      ① `error_kp` 在这里就 `JSON.parse` 好（它只 parse 了 `lines`，前端还得再 parse 一次）；
 *      ② 载荷多带 `exported_at` / `auto` / `batchId` / 照片在不在盘上 ——
 *         它的 `pending()` 是显式白名单，这几项取不到，看板与终审就对不上账。
 *    判定相关的字段一个没动，一个没加。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 server only：用 node:fs + core 的 node:sqlite 句柄，client 组件一律不许 import 它。
 */
import { existsSync, readFileSync } from "node:fs";

import { getGradingDb } from "~/core";
import {
  DOUBT_VERDICT_PRE,
  REVIEW_CONFIRMED_LIMIT,
  type ReviewBatchBrief,
  type ReviewBatchDetail,
  type ReviewConfirmedRow,
  type ReviewFeedback,
  type ReviewItem,
  type ReviewKpDict,
  type ReviewPhoto,
} from "../shared";
import { errKpFile, photoFileOf } from "../paths";

/** 错误原文（不缩写、不美化） */
export function 原文(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ---------------------------------------------------------------------------
// 库行 → 契约对象
// ---------------------------------------------------------------------------

interface BatchRow {
  id: number;
  student: string;
  day: number;
  status: string | null;
  round: number | null;
  created_at: string | null;
  confirmed_at: string | null;
  exported_at: string | null;
  auto: string | null;
}

interface ItemRow {
  qno: number;
  verdict_pre: string | null;
  verdict_final: string | null;
  needs_human: number | null;
  confidence: number | null;
  answer_raw: string | null;
  ref_ans: string | null;
  lines: string | null;
  note: string | null;
  error_kp: string | null;
  page: number | null;
  qtext: string | null;
}

/** 🔴 批次列显式列名（不用 `SELECT *`：库里还挂着 `task_id` 那条从没人写过的死列） */
const 批次列 =
  "id, student, day, status, round, created_at, confirmed_at, exported_at, auto";

const 逐题列 =
  "qno, verdict_pre, verdict_final, needs_human, confidence, " +
  "answer_raw, ref_ans, lines, note, error_kp, page, qtext";

/** items.lines：库里存 JSON 数组字符串；坏 JSON 不吞，原文挂 linesRaw */
function 读行(raw: string | null): {
  lines: string[];
  linesRaw: string | null;
} {
  if (raw === null || raw.trim() === "") return { lines: [], linesRaw: raw };
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) {
      return { lines: v.map((x) => String(x)), linesRaw: raw };
    }
    return { lines: [], linesRaw: raw };
  } catch {
    return { lines: [], linesRaw: raw };
  }
}

/**
 * items.error_kp 三态：
 *   NULL   → null（页面整段不显示）
 *   `[]`   → []（页面显示「不归因(非技能失分)」）
 *   有码   → string[]（按 err_kp.json 翻中文）
 * 坏 JSON → null + errorKpError（🔴 不静默当成「没错因」）
 */
function 读错因(raw: string | null): {
  errorKp: string[] | null;
  errorKpRaw: string | null;
  errorKpError?: string;
} {
  if (raw === null) return { errorKp: null, errorKpRaw: null };
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) {
      return {
        errorKp: null,
        errorKpRaw: raw,
        errorKpError: "error_kp 不是 JSON 数组",
      };
    }
    return { errorKp: v.map((x) => String(x)), errorKpRaw: raw };
  } catch (e) {
    return { errorKp: null, errorKpRaw: raw, errorKpError: 原文(e) };
  }
}

function 转题(r: ItemRow): ReviewItem {
  const { lines, linesRaw } = 读行(r.lines);
  return {
    qno: Number(r.qno),
    page: Number(r.page ?? 1) || 1,
    qtext: r.qtext,
    refAns: r.ref_ans,
    answerRaw: r.answer_raw,
    lines,
    linesRaw,
    note: r.note,
    ...读错因(r.error_kp),
    verdictPre: r.verdict_pre,
    verdictFinal: r.verdict_final,
    needsHuman: Number(r.needs_human ?? 0) === 1,
    confidence: r.confidence === null ? null : Number(r.confidence),
  };
}

/** 存疑口径与看板一致：预判 ∈ {?,doubt,missing} 或 needs_human=1 */
export function 存疑(it: ReviewItem): boolean {
  return (
    (it.verdictPre !== null &&
      (DOUBT_VERDICT_PRE as readonly string[]).includes(it.verdictPre)) ||
    it.needsHuman
  );
}

function 转批次(
  b: BatchRow,
  items: ReviewItem[],
  feedback: ReviewFeedback[],
): ReviewBatchBrief {
  const doubt = items.filter(存疑);
  return {
    key: `b${Number(b.id)}`,
    batchId: Number(b.id),
    student: b.student,
    day: Number(b.day),
    status: b.status ?? "",
    round: Number(b.round ?? 1) || 1,
    createdAt: b.created_at,
    confirmedAt: b.confirmed_at,
    exportedAt: b.exported_at,
    auto: b.auto,
    itemCount: items.length,
    doubtCount: doubt.length,
    doubtQnos: doubt.map((it) => it.qno),
    judgedCount: items.filter((it) => it.verdictFinal !== null).length,
    pages: [...new Set(items.map((it) => it.page))].sort((x, y) => x - y),
    feedbackCount: feedback.length,
    openFeedbackCount: feedback.filter((f) => f.resolvedAt === null).length,
  };
}

// ---------------------------------------------------------------------------
// 读侧三个口子
// ---------------------------------------------------------------------------

export interface ReviewQueueResult {
  batches: ReviewBatchBrief[];
  confirmed: ReviewConfirmedRow[];
  gradingDbPath: string;
  warnings: string[];
}

/**
 * 待审队列（= 审核台首屏）+ 页尾「近期已确认」。
 * 🔴 一次连接取完，`status IN ('pending','rework')` 一个字不改。
 */
export async function reviewQueue(): Promise<ReviewQueueResult> {
  const g = await getGradingDb();
  const warnings: string[] = [];

  const rows = g.query<BatchRow>(
    `SELECT ${批次列} FROM batches WHERE status IN ('pending','rework') ` +
      "ORDER BY student, day",
  );

  const batches: ReviewBatchBrief[] = rows.map((b) => {
    const items = g
      .query<ItemRow>(
        `SELECT ${逐题列} FROM items WHERE batch_id=? ORDER BY qno`,
        [Number(b.id)],
      )
      .map(转题);
    const fb = 读反馈(g, Number(b.id));
    if (items.length === 0) {
      warnings.push(
        `批次 #${Number(b.id)}（${b.student} 第${Number(b.day)}天）一道题都没有 —— ` +
          "多半是 ingest/直批 建了批次但判定还没回来，终审无从审起。",
      );
    }
    return 转批次(b, items, fb);
  });

  const confirmed = g
    .query<{
      id: number;
      student: string;
      day: number;
      confirmed_at: string | null;
      round: number | null;
      auto: string | null;
    }>(
      "SELECT id, student, day, confirmed_at, round, auto FROM batches " +
        "WHERE status='confirmed' ORDER BY confirmed_at DESC, id DESC LIMIT ?",
      [REVIEW_CONFIRMED_LIMIT],
    )
    .map((b) => ({
      key: `c${Number(b.id)}`,
      student: b.student,
      day: Number(b.day),
      confirmedAt: b.confirmed_at,
      round: Number(b.round ?? 1) || 1,
      auto: b.auto,
    }));

  return { batches, confirmed, gradingDbPath: g.path, warnings };
}

function 读反馈(
  g: { query<T>(sql: string, params?: unknown[]): T[] },
  batchId: number,
): ReviewFeedback[] {
  return g
    .query<{
      round: number | null;
      body: string;
      created_at: string | null;
      resolved_at: string | null;
    }>(
      "SELECT round, body, created_at, resolved_at FROM feedback " +
        "WHERE batch_id=? ORDER BY id DESC",
      [batchId],
    )
    .map((f) => ({
      round: f.round === null ? null : Number(f.round),
      body: f.body,
      createdAt: f.created_at,
      resolvedAt: f.resolved_at,
    }));
}

export interface ReviewBatchResult {
  detail: ReviewBatchDetail | null;
  gradingDbPath: string;
  warnings: string[];
}

/**
 * 一个批次的全貌（逐题 + 反馈 + 每页原图在不在盘上）。
 *
 * 🔴 **不限 status**：审核台首屏只列 pending/rework，但本产品的看板每一行都要能点进来
 *    （打磨检查单 §4「看到即可达」）。已 confirmed 的批次照样打得开，只是页面转成
 *    只读态并说明为什么 —— 「点进去打不开」比「打开了不能改」难受得多。
 */
export async function reviewBatch(
  student: string,
  day: number,
): Promise<ReviewBatchResult> {
  const g = await getGradingDb();
  const warnings: string[] = [];

  const rows = g.query<BatchRow>(
    `SELECT ${批次列} FROM batches WHERE student=? AND day=?`,
    [student, day],
  );
  const b = rows[0];
  if (!b) return { detail: null, gradingDbPath: g.path, warnings };

  const items = g
    .query<ItemRow>(
      `SELECT ${逐题列} FROM items WHERE batch_id=? ORDER BY qno`,
      [Number(b.id)],
    )
    .map(转题);
  const feedback = 读反馈(g, Number(b.id));
  const brief = 转批次(b, items, feedback);

  // 🔴 页号来自 items.page，不是扫目录：库说有第 3 页而盘上没有，那是「照片缺了」
  //    这条事实，页面要说出来（少列一页就把它藏了）。
  const photos: ReviewPhoto[] = brief.pages.map((p) => {
    const path = photoFileOf(student, day, p);
    const exists = existsSync(path);
    if (!exists) {
      warnings.push(
        `第 ${p} 页原图不在盘上：${path}（库里有第 ${p} 页的题，照片却找不到 —— ` +
          "对着原卷核判定这一步就断了，先去看一眼收件/收卷那一段。)",
      );
    }
    return { page: p, exists, path };
  });

  for (const it of items) {
    if (it.errorKpError) {
      warnings.push(
        `第 ${it.qno} 题的 error_kp 解析不了（${it.errorKpError}）：${it.errorKpRaw ?? ""}`,
      );
    }
  }

  return {
    detail: { ...brief, items, feedback, photos },
    gradingDbPath: g.path,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 错因考点词表（正本 = _产线/err_kp.json）
// ---------------------------------------------------------------------------

/**
 * 读错因码 → 中文。
 * 🔴 读不到 / 形状不对 → `ok:false` + 原文错误，**绝不退化成空表**
 *    （err_kp.py 的原话就是这条）。页面照样把码原样印出来，并把这句报错顶上去。
 */
export function reviewKpDict(): ReviewKpDict {
  const path = errKpFile();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        version: null,
        path,
        cn: {},
        error: `词表正本顶层不是对象：${path}`,
      };
    }
    const d = parsed as Record<string, unknown>;
    const codes = d.codes;
    if (!Array.isArray(codes) || codes.length === 0) {
      return {
        ok: false,
        version: null,
        path,
        cn: {},
        error: `词表正本 ${path} 里没有 codes 列表（错因码翻不成中文，页面只能印码）`,
      };
    }
    const cn: Record<string, string> = {};
    for (const c of codes) {
      if (typeof c !== "object" || c === null) continue;
      const o = c as Record<string, unknown>;
      if (typeof o.code === "string" && typeof o.cn === "string") {
        cn[o.code] = o.cn;
      }
    }
    return {
      ok: true,
      version: typeof d.version === "string" ? d.version : null,
      path,
      cn,
    };
  } catch (e) {
    return {
      ok: false,
      version: null,
      path,
      cn: {},
      error:
        `错因考点词表正本读不出来：${path}（${原文(e)}）—— ` +
        "🔴 不退化成空词表（那会让「不归因」和「翻不出中文」看起来一模一样），" +
        "页面改印原始码。",
    };
  }
}
