/**
 * GET /api/questions —— 题目管理页（/question）的取数口（AI:PRD-008 · 地基）
 *
 * 🔴 检索层只有一个入口：本路由调的是 core 的 {@link searchQuestions}，
 *    和 MCP 的 search_questions 是**同一个函数、同一套默认口径**
 *    （「页面看得见的题 agent 查不到」是最难查的一类故障，从源头堵死）。
 * 🔴 零写：`metric:false` —— 表格翻页/刷新是浏览动作，不该往 metric_event 里灌
 *    「真实查询」（那是 004-D 评测集的原料，掺水就废了），也就不会留审计行。
 * 🔴 app 层不许碰 db：本文件只 import `~/core`（eslint 红线，见 eslint.config.js）。
 *
 * ── 分页怎么做到「真」的（🔴 这里有一处 core 的现实约束，别绕过去当没有）──────
 *   `searchQuestions` 的 limit 上限 200，且**没有 offset**（zod 契约里就没这个字段）。
 *   于是本路由分两种情形：
 *     ① 纯条件浏览（没给关键词/语意）：顺序是 SQL 的稳定序（created_at, id），
 *        可以靠 `excludeQuestionIds` 把已取回的排掉、一轮一轮往后翻 —— 结果与
 *        「offset 翻页」等价，642 题翻到最后一页也是准的（最多 {@link MAX_ROUNDS} 轮）。
 *     ② 关键词/语意检索（相关性序）：**不做跨窗拼接**。RRF 的名次是在候选集内算的，
 *        排掉前 200 条再算一次，名次会重排，拼出来的第 11 页既可能漏也可能重。
 *        所以这种情形只给前 200 条，并在返回里 `capped:true` 如实说明——
 *        少给结果不可怕，悄悄给错顺序才可怕。
 *   → 彻底解法是给 core 的 searchParamsSchema 加一个 offset（连带改 MCP 漂移闸断言），
 *     那是一次显式的契约变更，不在本卡「地基」范围内（见交接说明的遗留问题）。
 *
 *   🔴🔴 相关性检索时 limit **恒取 CAP**，不跟页号走（2026-08-14 修 · 验收判红）：
 *     以前是 `limit = min(CAP, page*pageSize)`，而 core 的 `total` 是融合名次表的长度，
 *     曾经跟着 limit 变大 ⇒ 同一条查询翻到第 5 页，页脚从「共 100 条」变成「共 500 条」。
 *     core 那一半已经修好（向量轴深度不再绑 limit，见 retrieval.ts 的 VECTOR_AXIS_DEPTH），
 *     这里也一并钉死：**取多少条与在第几页无关**，页只是对同一个窗口切片。
 *
 * ── 排序（列头点击）───────────────────────────────────────────────────────
 *   core 没有 order by 这一维（检索的序是相关性/稳定序）。所以排序在本路由**对取回的
 *   窗口**做，并且一旦要排序就**先把窗口取尽**（否则"第 5 页"会是"前 100 条排完的第 5 页"，
 *   那是错的）。取不尽（撞上 MAX_ROUNDS×CAP 或相关性 CAP）时 `capped:true` 照旧上墙。
 *
 * ── 来源（prov_type）筛选为什么是「窗口内过滤」────────────────────────────────
 *   core 的硬过滤没有 prov_type 这一维（考点/难度/题型/判档/版本/状态/排除名单）。
 *   本路由在取回的结果上过滤，并把 `provWindow` 标出来：纯条件浏览时会先把全量取尽
 *   （所以总数是准的），相关性检索时只在那 200 条里过滤（总数按窗口口径，页面上写明）。
 */
import { NextResponse } from "next/server";
import { decodeTime } from "ulid";

import { parseSort, sortWindow } from "~/lib/sort-window";
import {
  PROV_TYPES,
  QTYPES,
  QUESTION_STATUSES,
  SOLUTION_GRADES,
  nowLocalISO,
  searchQuestions,
  type SearchHit,
  type SearchParams,
} from "~/core";
import type { QuestionListResponse, QuestionRow } from "~/app/question/shared";

export const dynamic = "force-dynamic";

/** searchQuestions 的 limit 上限（core zod: max(200)） */
const CAP = 200;
/** 链式翻页最多跑几轮（6×200=1200 条，远超本地库当下体量；防呆用） */
const MAX_ROUNDS = 6;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 取重复键（?qt=计算&qt=填空），只留在白名单里的值 —— 地址栏是人能手改的地方 */
function pick(
  sp: URLSearchParams,
  key: string,
  allow: readonly string[],
): string[] {
  return [...new Set(sp.getAll(key).map((s) => s.trim()))].filter((v) =>
    allow.includes(v),
  );
}

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/**
 * 入库时间 = 题 id 里那枚 ULID 的时刻。
 * 🔴 为什么不用 question.created_at：SearchHit 的契约里没有它（core 的检索命中
 *    只驮摘要面）。而 id 是入库那一刻发的号（ids.ts），实测与 created_at 秒级一致，
 *    所以列头写明「由 ULID 解出」——如实标注来源，不假装是 created_at 那一列。
 */
function ulidTime(id: string): string | null {
  const ulid = id.slice(-26);
  try {
    return nowLocalISO(new Date(decodeTime(ulid)));
  } catch {
    return null;
  }
}

/** 命中来源徽章（多轴命中就是多枚，不合成一枚——见 search/shared.ts 的口径） */
function badges(h: SearchHit): string[] {
  const out: string[] = [];
  if (h.sources.fts) out.push(`字面 #${h.sources.fts.rank}`);
  if (h.sources.vector) out.push(`语意 ${h.sources.vector.score}`);
  if (h.sources.kp) out.push(`考点 #${h.sources.kp.rank}`);
  if (h.sources.sqlOnly) out.push("仅条件");
  return out;
}

/** 可排序的列（白名单；口径与两条排序纪律见 ~/lib/sort-window） */
const SORT_FIELDS = [
  "stemBrief",
  "qtype",
  "difficulty",
  "solutionGrade",
  "provType",
  "status",
  "ingestedAt",
  "id",
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_OF: Record<SortField, (r: QuestionRow) => string | number | null> = {
  stemBrief: (r) => r.stemBrief,
  qtype: (r) => r.qtype,
  difficulty: (r) => r.difficulty,
  solutionGrade: (r) => r.solutionGrade,
  provType: (r) => r.provType,
  status: (r) => r.status,
  ingestedAt: (r) => r.ingestedAt,
  id: (r) => r.id,
};

function toRow(h: SearchHit): QuestionRow {
  return {
    id: h.questionId,
    stemBrief: h.stemBrief,
    qtype: h.qtype,
    difficulty: h.difficulty,
    solutionGrade: h.solutionGrade,
    status: h.status,
    provType: h.provType,
    editionScope: h.editionScope,
    reviewRequired: h.reviewRequired,
    kps: h.kps,
    ingestedAt: ulidTime(h.questionId),
    badges: badges(h),
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;

  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const kw = (sp.get("kw") ?? "").trim();
  const sem = (sp.get("sem") ?? "").trim();
  const kpIds = [...new Set(sp.getAll("kp").map((s) => s.trim()))].filter(
    Boolean,
  );
  const qtype = pick(sp, "qt", QTYPES);
  const statuses = pick(sp, "st", QUESTION_STATUSES);
  const grades = pick(sp, "sg", SOLUTION_GRADES);
  const provs = pick(sp, "pv", PROV_TYPES);
  // 🆕 录入批次：core 现在有这一维硬过滤（question.ingest_batch_id），不再是窗口内筛
  const batchIds = [...new Set(sp.getAll("batch").map((s) => s.trim()))].filter(
    Boolean,
  );

  const sort = parseSort<SortField>(sp, SORT_FIELDS);

  const base: SearchParams = {
    ...(kpIds.length > 0 ? { kpIds } : {}),
    ...(kw ? { keywords: kw, kpAutoResolve: true } : {}),
    ...(sem ? { semanticQuery: sem } : {}),
    ...(qtype.length > 0 ? { qtype: qtype as SearchParams["qtype"] } : {}),
    ...(statuses.length > 0
      ? { statuses: statuses as SearchParams["statuses"] }
      : {}),
    ...(grades.length > 0
      ? { solutionGrade: grades as SearchParams["solutionGrade"] }
      : {}),
    ...(batchIds.length > 0 ? { ingestBatchIds: batchIds } : {}),
  };

  /** 关键词/语意任一在 = 相关性序（见文件头 §分页） */
  const axisActive = Boolean(kw || sem);
  /** 来源筛选是本路由做的窗口内过滤（core 硬过滤没有这一维） */
  const provFilter = provs.length > 0 && provs.length < PROV_TYPES.length;
  const need = page * pageSize;
  /**
   * 要取多少条：
   *   · 来源筛选 / 排序 ⇒ 必须取尽（否则总数或名次都是"前 N 条里的"，那是错的）
   *   · 相关性检索 ⇒ 恒取 CAP（🔴 不跟页号走，见文件头：total 不许随页号膨胀）
   *   · 其余 ⇒ 按需取
   */
  const target =
    provFilter || sort !== null
      ? MAX_ROUNDS * CAP
      : axisActive
        ? CAP
        : need;

  try {
    const first = await searchQuestions(
      { ...base, limit: Math.min(CAP, Math.max(target, 1)) },
      { metric: false },
    );
    const hits: SearchHit[] = [...first.hits];
    const coreTotal = first.total;
    let rounds = 1;
    let capped = false;

    while (hits.length < target && hits.length < coreTotal) {
      if (axisActive) {
        // 🔴 相关性序不跨窗拼接（拼出来的顺序是错的，见文件头）
        capped = true;
        break;
      }
      if (rounds >= MAX_ROUNDS) {
        capped = true;
        break;
      }
      const r = await searchQuestions(
        {
          ...base,
          limit: CAP,
          excludeQuestionIds: hits.map((h) => h.questionId),
        },
        { metric: false },
      );
      rounds += 1;
      if (r.hits.length === 0) break;
      hits.push(...r.hits);
    }

    // 🔴 相关性序只给前 CAP 条（不跨窗拼接，见文件头）：命中比窗口多就**如实标 capped**。
    //    以前这一条是靠 while 循环里那个 break 顺带设上的；现在 limit 恒取 CAP、
    //    循环压根不进，忘了这一句的话第 11 页会静默变成空表（总数还写着 642）。
    if (axisActive && coreTotal > hits.length) capped = true;

    const filtered = provFilter
      ? hits.filter((h) => provs.includes(h.provType))
      : hits;
    const exhausted = hits.length >= coreTotal;
    const total = provFilter
      ? filtered.length
      : capped
        ? Math.min(coreTotal, hits.length)
        : coreTotal;

    const rows = filtered.map(toRow);
    // 🔴 排序在切页**之前**（且上面已把窗口取尽），不然翻页翻的是"排完前 N 条"
    if (sort) sortWindow(rows, SORT_OF[sort.field], sort.desc);

    const start = (page - 1) * pageSize;
    const body: QuestionListResponse = {
      ok: true,
      data: rows.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      meta: {
        coreTotal,
        candidateCount: first.candidateCount,
        fetched: hits.length,
        rounds,
        capped,
        cap: CAP,
        provFilter,
        provWindow: provFilter && !exhausted,
        sort,
        batchIds,
        degraded: first.degraded,
        warnings: first.warnings,
        ms: first.ms,
        axes: {
          fts: {
            active: first.axes.fts.active,
            count: first.axes.fts.count,
            degraded: first.axes.fts.degraded,
            op: first.axes.fts.op,
            tokens: first.axes.fts.tokens,
          },
          vector: {
            active: first.axes.vector.active,
            count: first.axes.vector.count,
            modelVer: first.axes.vector.modelVer,
          },
          kpAuto: {
            active: first.axes.kpAuto.active,
            count: first.axes.kpAuto.count,
            names: first.query.kpAutoResolved.map((k) => k.name),
          },
        },
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    // 🔴 报错原文照登：本地工具页，藏错误没有任何好处（页面会把它摆在表格上方）
    const body: QuestionListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      page,
      pageSize,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
