/**
 * core/retrieval.ts —— 三路检索管线（AI:PRD-004 · 004-B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 一句话：**一套入口、双出口**。MCP 的 `search_questions` 与将来的题库检索页
 * （004-C）走的是本文件同一个 {@link searchQuestions}——不是"页面一套、工具一套"。
 * 两套实现意味着两套口径，而"页面上看得见的题，agent 查不到"是最难查的一类故障。
 *
 * ── 三条轴与它们的分工 ──────────────────────────────────────────────────────
 *   ① SQL 轴（硬过滤）：考点 / 难度 / 题型 / 判档 / 版本 / 状态 / 排除名单 / 录入批次。
 *      **它先跑，产出候选 id 集**——这是"能不能要"的问题，答案非黑即白。
 *   ② FTS 轴（关键词）：`question_fts` MATCH，jieba 分词后逐 token 显式 AND。
 *   ③ 向量轴（语意）：`question_vec` 余弦近邻。
 *   ②③ **只在候选集内排名**，不各自扫全库再交集——那样两条轴会各自"用掉"
 *      自己的 top-N 预算去排一堆最终会被硬过滤扔掉的题，召回凭空变浅。
 *
 * ── 🔴 MATCH 永不接受调用方拼串 ─────────────────────────────────────────────
 *   入参全结构化（{@link searchParamsSchema} 校验），关键词那一路走
 *   `ftsQuery()`：jieba 切 token → 每个 token 单独转义成 FTS5 字符串字面量 →
 *   显式 AND 连。于是 `"` `*` `(` `NEAR` `OR` 全退化成普通字符。
 *   ⛔ 本文件里不该出现任何形如 `MATCH '${x}'` 的东西。
 *
 * ── 🔴 RRF（Reciprocal Rank Fusion，k=60）────────────────────────────────────
 *   score(d) = Σ_轴 1/(60 + rank_轴(d))，rank 从 1 起，d 不在某轴的召回里就不加那一项。
 *
 *   为什么是 RRF 而不是"加权求和 bm25 与余弦"：**两条轴的分数不可通约**。
 *   bm25 是批内相对的负数、余弦是 [-1,1] 的绝对值，硬凑权重等于凭感觉调参，
 *   而且换一批数据就得重调。RRF 只吃**名次**，天然免疫量纲，也免疫离群分数。
 *   k=60 是原论文（Cormack 2009）的默认值，作用是压低头部名次的差距
 *   （第 1 名与第 2 名之比 61:62 而不是 1:2），让"两轴都排得靠前"胜过
 *   "一轴第 1、另一轴榜上无名"。
 *
 *   单轴激活时 score 仍按同式算——1/(60+rank) 在 rank 上单调递减，
 *   所以"按 rrfScore 降序"与"按该轴名次升序"是同一个序，不必分支。
 *   零轴激活（纯标签检索）时没有名次可言，回 SQL 的 created_at 稳定序，
 *   每条标 `sources.sqlOnly`。
 *
 * ── 🔴 C3 联动：语意轴会降级，但绝不静默 ───────────────────────────────────
 *   `question_vec` 里混着两个模型的向量时，近邻在数学上就是无意义的——
 *   而表面完全正常（有结果、有分数、排序像模像样）。所以查询前先做一次
 *   极廉价的 `SELECT DISTINCT embed_model_ver`：混版 / 与 env 不符 / 模型没装，
 *   一律**自动降级为纯 FTS**，并在 `warnings` 里把原因写成人话。
 *   降级不是报错（检索照常出结果），但用的人必须知道少了一条轴。
 *
 * ── 🔴 kpAutoResolve：考点用词自动落靶 = **第四条召回轴**（004-C 追加）──────
 *   人（和 agent）张口就是「去绝对值」「绝对值压轴」——那是**考点的说法**，
 *   不是题面里会出现的字。硬塞进 FTS 只会零命中（题面里根本没有「去绝对值」四个字），
 *   而库里明明有 3 道挂在「绝对值的化简与去号」名下的题。
 *
 *   开了 `kpAutoResolve` 时：keywords 先过一次 {@link resolveKp}，
 *   **只认 confidence=1.0 的精确名/别名命中**（前缀 0.9、trigram 0.5 一律不算——
 *   "沾边"也算就等于让一个模糊判断去改检索口径），命中的考点变成第 ④ 条**召回轴**：
 *   候选集里挂着这些考点的题按稳定序进名次表，和 FTS/向量一起走 RRF。
 *   一词多考点（『绝对值压轴』是四个考点的共用别名）**全部并入**——any-of 语义。
 *
 *   🔴🔴 **落靶绝不动硬过滤（不并进 kpIds）**，这是本设计最要紧的一条。
 *      并进 kpIds 就成了**交集**，于是落靶能把本来查得到的题**删掉**：
 *      实测「立方根」——考点『立方根的概念与开立方运算』存在但身上一道题都没挂，
 *      并进 kpIds 后候选集直接归零，而纯字面本来能查到 4 道真题（题面里有"立方根"三个字）。
 *      「帮你理解得更好」的功能反手删掉 4 道真结果，是比零命中更坏的故障——
 *      它静默、而且只有恰好知道那 4 道题存在的人才发现得了。
 *      作为**并集的召回轴**则只会加、不会减：字面中的照中，考点挂的也一并召回，
 *      两边都中的题靠 RRF 自然排到最前（sources 里两枚徽章都在）。
 *
 * ── 收尾打点（M1 · Q9）─────────────────────────────────────────────────────
 *   每次检索落一条 `metric_event(kind='search')`：参数摘要 + 各轴命中数 + 降级标记。
 *   004-D 的评测集**从这里抽真实查询**，不另造假数据。
 *   🔴 打点是一次库写（走 withCoreWrite 留审计行）；页面/脚本要纯读就传 `metric:false`。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { z } from "zod";

import { getCoreDb, type CoreDbHandle } from "./db";
import { embedTexts } from "./embed";
import { ftsQuery } from "./fts";
import { matchKeyOf } from "./gates/ingest-dedup.gate";
import { QTYPES, SOLUTION_GRADES } from "./ingest-schema";
import { KgError, resolveMergedKp } from "./kg";
import { logMetric } from "./metrics";
import { resolveKp } from "./resolve";
import { stripHtmlForSeg } from "./segment";
import { cosineTopK, vecAxisStatus, VecError } from "./vec";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** RRF 的 k（Cormack 2009 默认值）。改它等于改融合口径，改前先想清楚为什么 */
export const RRF_K = 60;

/** 不传 limit 时返回几条 */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * 不传 statuses 时看哪些状态的题。
 * 🔴 `quarantine`/`rejected`/`retired` 默认不进检索——它们是"进不了库"或"退役"的题，
 *    出题时看见它们只会浪费判断力。要看得显式传。
 */
export const DEFAULT_STATUSES = ["active", "pending"] as const;

/**
 * 🔴 M1 · Q11：`no_solution`（连解析都没有的题）**默认排除出检索**。
 *    理由：检索是给"要拿去用"的场景服务的，没解答的题拿到手还是得现解，
 *    混在结果里只会稀释 top-N。要看它必须显式把 'no_solution' 写进 solutionGrade。
 */
export const DEFAULT_SOLUTION_GRADES = [
  "calc_verified",
  "analysis_only",
] as const;

/** question.status 的建表 CHECK（一字不差） */
export const QUESTION_STATUSES = [
  "pending",
  "active",
  "quarantine",
  "rejected",
  "retired",
] as const;

/** 命中列表里题面截多长（全文走 getQuestion，wire 上不驮全文） */
export const STEM_BRIEF_CHARS = 140;

/**
 * FTS 一次最多扫多少行再回来做交集。
 * 🔴 这是**已知的规模边界**，不是拍脑袋：本产品是本地单人库（当下 60 题，
 *    可预见的量级在万），MATCH 全量回来做交集比"把几千个候选 id 塞进 IN(...)"
 *    简单得多、也没有 SQLITE_MAX_VARIABLE_NUMBER 的坑。真扫到上限会在
 *    warnings 里如实说"可能有截断"，而不是悄悄少给几条。
 */
export const FTS_SCAN_CAP = 5000;

/**
 * 向量轴在候选集内取多深（RRF 要的是"够深的名次表"，不是最终 top-N）。
 *
 * 🔴🔴 **深度不许跟 limit 走**（2026-08-14 修 · AI:PRD-008 验收缺陷）：
 *    旧实现是 `max(limit*5, 100)`，而 {@link SearchResult.total} = 融合表长度 ⇒
 *    同一条查询把 limit 从 20 调到 100，`total` 就从 100 变成 500 ——
 *    页面为了翻页把 limit 越调越大，于是"命中数"变成了**页码的函数**
 *    （实测 /api/questions?sem=绝对值 翻到第 5 页，页脚从"共 100 条"长到"共 500 条"）。
 *    「一次查询命中多少条」必须是查询的属性，翻页不许改它。
 *
 * 🔴 改成"候选集内全量"（上限 {@link VECTOR_AXIS_DEPTH}），与 FTS 轴同口径 ——
 *    FTS 轴本来就是把候选集内的全部命中排进名次表，语意轴没有理由只排前 100。
 *    代价近乎为零：{@link cosineTopK} 在白名单模式下**本来就要对每个候选点积一次**，
 *    深度只影响最后那一刀 slice。
 */
export const VECTOR_AXIS_DEPTH = 5000;

function 向量深度(candidateCount: number): number {
  return Math.min(candidateCount, VECTOR_AXIS_DEPTH);
}

/** IN(...) 一次塞多少个参数（hydrate 时分批，别撞变量数上限） */
const IN_CHUNK = 400;

/**
 * kpAutoResolve 时向 resolveKp 要几条候选。
 * 🔴 比默认的 8 宽：一词多考点是常态（『绝对值压轴』当下就挂着 4 个考点），
 *    截在 8 会让「全部并入」变成「并入前 8 个」——而那个截断没人看得见。
 */
const KP_AUTO_LIMIT = 20;

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

export const RETRIEVAL_ERROR_CODES = [
  /** 入参没过 zod（难度区间反了、状态不认识…）——改参数再来 */
  "INVALID_INPUT",
  /** 指名道姓要的那道题库里没有 */
  "QUESTION_NOT_FOUND",
] as const;

export type RetrievalErrorCode = (typeof RETRIEVAL_ERROR_CODES)[number];

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  /**
   * 🔴 QUESTION_NOT_FOUND 专用，且**恒为空数组**（不是忘了填）：
   *    考点 id 里常常还能读出人话（`kp_绝对值` → "绝对值"），所以 kpContext
   *    能从编造的 id 里反推候选；题 id 是纯 ULID，`q_01KZVF40T06F21857EWW015M89`
   *    里一个语义字符都没有，硬猜只会给出误导。给不出就如实给不出，
   *    但 message 必须写清楚下一步该调什么（search_questions）。
   */
  readonly candidates: readonly never[] = [];
  readonly questionId?: string;

  constructor(code: RetrievalErrorCode, message: string, questionId?: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
    if (questionId !== undefined) this.questionId = questionId;
  }
}

// ---------------------------------------------------------------------------
// 入参契约
// ---------------------------------------------------------------------------

const 难度区间 = z
  .object({
    min: z.number().int().min(1).max(5).optional(),
    max: z.number().int().min(1).max(5).optional(),
  })
  .refine((d) => d.min === undefined || d.max === undefined || d.min <= d.max, {
    message: "difficulty.min 不能大于 difficulty.max",
  });

/**
 * 检索入参（**全结构化**）。
 *
 * 🔴 这里没有、也永远不会有"raw"/"sql"/"match" 之类的透传口子：
 *    调用方能表达的一切都必须落在这张表里。加一个字段是一次显式决定，
 *    留一个透传口子是一次不可见的授权。
 */
export const searchParamsSchema = z.object({
  kpIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("考点 id（any-of：命中任一即可）；merged 壳会自动折叠到活跃落点"),
  primaryOnly: z
    .boolean()
    .optional()
    .describe("只认主考点（question_kp.is_primary=1）。默认 false = 主副都算"),
  difficulty: 难度区间.optional().describe("难度闭区间 [min,max]，1~5"),
  qtype: z.array(z.enum(QTYPES)).optional().describe("题型（any-of）"),
  solutionGrade: z
    .array(z.enum(SOLUTION_GRADES))
    .optional()
    .describe("解答成色（any-of）。不传 = 排除 no_solution（M1 Q11）"),
  editionScope: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("教材版本：NULL(通用) 与该值都返回"),
  keywords: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("FTS 轴：jieba 分词后逐 token AND；零命中自动降级 OR 重试一次"),
  kpAutoResolve: z
    .boolean()
    .optional()
    .describe(
      "keywords 若是个**考点用词**（『去绝对值』），额外开一条考点标签召回轴（不动硬过滤，只加召回）；" +
        "只认 confidence=1.0 的精确名/别名，多义词全并入（any-of）。默认 false",
    ),
  semanticQuery: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("语意轴：句向量余弦近邻（可与 keywords 同时给，走 RRF 融合）"),
  excludeQuestionIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("排除这些题（组卷排重场景）"),
  /**
   * 🆕 2026-08-14（AI:PRD-008 验收缺陷 · 设计稿 §二·2 逐项列了「录入批次」这一维）：
   * 硬过滤到某一次投料。它是**真过滤**（question.ingest_batch_id），不是窗口内筛。
   */
  ingestBatchIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "录入批次（any-of，id 形如 batch_01J…，来自 kb_ingest 返回 / get_ingest_batch）：只看这几次投料进来的题",
    ),
  statuses: z
    .array(z.enum(QUESTION_STATUSES))
    .optional()
    .describe("题目状态（any-of）。默认 ['active','pending']"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("返回几条，默认 20"),
});

export type SearchParams = z.input<typeof searchParamsSchema>;
type 归一参数 = z.output<typeof searchParamsSchema>;

export interface SearchOptions {
  handle?: CoreDbHandle;
  /** 🔴 false = 不落 metric_event（页面预览 / 单测 / 脚本用）。默认 true */
  metric?: boolean;
}

// ---------------------------------------------------------------------------
// 返回契约
// ---------------------------------------------------------------------------

/** 命中是**哪条轴**给的（人一眼看出"为什么它在这儿"） */
export interface HitSources {
  /** FTS 轴：批内名次（1 起）+ bm25 原值（越负越相关） */
  fts?: { rank: number; score: number };
  /** 语意轴：批内名次 + 余弦相似度 */
  vector?: { rank: number; score: number };
  /**
   * 🔴 考点标签轴（kpAutoResolve 落靶来的）：这道题**挂着**关键词落靶到的考点。
   * 没有相关性分数可言（挂了就是挂了），rank = 候选集稳定序里的位次。
   */
  kp?: { rank: number; kpIds: string[] };
  /** 一条轴都没激活：这条纯粹是 SQL 硬过滤的产物，没有"相关性"可言 */
  sqlOnly?: true;
}

export interface QuestionKpBrief {
  kpId: string;
  name: string;
  isPrimary: boolean;
}

/**
 * 一条「关键词落靶成考点」的记录（`kpAutoResolve` 的回显）。
 *
 * 🔴 必须回显：不然用户只看到「我查的是关键词，结果按考点过滤了」这件事**没发生过**——
 *    命中数对不上、以为是 FTS 的功劳，下次换个说法查不到就无从判断哪儿变了。
 */
export interface KpAutoResolved {
  /** 拿去落靶的词（= keywords 原串，未分词） */
  query: string;
  kpId: string;
  name: string;
  /** 命中的是考点名还是别名 */
  via: "exact-name" | "exact-alias";
  /** via='exact-alias' 时：命中的是哪条别名 */
  aliasHit?: string;
}

export interface SearchHit {
  questionId: string;
  /** 题面摘要（剥 HTML、截断）。🔴 全文走 getQuestion，别在命中列表里驮全文 */
  stemBrief: string;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  provType: string;
  editionScope: string | null;
  reviewRequired: boolean;
  kps: QuestionKpBrief[];
  /** RRF 融合分（零轴时恒为 0） */
  rrfScore: number;
  sources: HitSources;
}

export interface SearchAxes {
  sql: { count: number };
  fts: {
    active: boolean;
    /** 与候选集取交后的命中数 */
    count: number;
    /** 🔴 true = AND 一条都没中，已自动退成 OR 再查一次 */
    degraded: boolean;
    op: "and" | "or" | null;
    tokens: string[];
  };
  vector: {
    active: boolean;
    count: number;
    /** 语意轴用的是哪个模型版本（降级时为 null） */
    modelVer: string | null;
  };
  /** 🔴 考点标签轴（kpAutoResolve）：落靶到哪几个考点、在候选集内召回了几条 */
  kpAuto: { active: boolean; count: number; kpIds: string[] };
}

export interface SearchResult {
  /** 归一后的参数摘要（回显：agent 能看出系统"到底按什么在查"） */
  query: {
    /** 🔴 参与**硬过滤**的考点（只有调用方显式传的；落靶来的不在这儿，见 kpAutoResolved） */
    kpIds: string[];
    /** 折叠前 → 折叠后（只在真发生折叠时非空） */
    kpFolded: { from: string; to: string }[];
    /** 开没开关键词落靶 */
    kpAutoResolve: boolean;
    /**
     * 🔴 keywords 落靶到了哪几个考点（没开或没精确命中时为空数组）。
     * 它们走的是**召回轴**（axes.kpAuto），不进 kpIds 那条硬过滤。
     */
    kpAutoResolved: KpAutoResolved[];
    primaryOnly: boolean;
    difficulty: { min?: number; max?: number } | null;
    qtype: string[];
    solutionGrade: string[];
    editionScope: string | null;
    keywords: string | null;
    semanticQuery: string | null;
    excludeCount: number;
    /** 硬过滤到哪几次投料（空 = 不限批次） */
    ingestBatchIds: string[];
    statuses: string[];
    limit: number;
  };
  hits: SearchHit[];
  /**
   * 融合后命中总数（**截断前**；hits 只有 limit 条）。
   * 🔴 它是**查询的属性**，与 limit 无关 —— 同一条查询换个 limit，total 必须一样
   *    （历史上不是：向量轴深度曾绑在 limit 上，见 {@link VECTOR_AXIS_DEPTH}）。
   */
  total: number;
  /** SQL 硬过滤留下的候选数 */
  candidateCount: number;
  axes: SearchAxes;
  /**
   * 结果不是「两条轴照常融合」出来的——任一发生即 true：
   * FTS 退过 OR / 语意轴被降级 / 落靶后关键词轴零命中退回了标签轴。
   */
  degraded: boolean;
  /** 🔴 降级/截断一律写在这儿，绝不静默 */
  warnings: string[];
  ms: number;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type Args = Array<string | number | null>;

async function q<T>(
  h: CoreDbHandle,
  sql: string,
  args: Args = [],
): Promise<T[]> {
  const r = await h.client.execute({ sql, args });
  return r.rows as unknown as T[];
}

/** `?,?,?`（n 个） */
function 占位(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/** 保留 6 位小数（RRF 分很小，3 位不够分辨；JSON 里也不至于拖一串浮点尾巴） */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** 题面摘要：剥 HTML（LaTeX 留着，那是数学本身）+ 按码点截断 */
export function stemBrief(
  stem: string | null | undefined,
  chars = STEM_BRIEF_CHARS,
): string {
  const s = stripHtmlForSeg(stem).replace(/\s+/g, " ").trim();
  const cp = Array.from(s);
  return cp.length <= chars ? s : cp.slice(0, chars).join("") + "…";
}

/** 分批跑 IN(...) 查询，结果拼起来 */
async function 分批查<T>(
  h: CoreDbHandle,
  ids: readonly string[],
  build: (占位串: string) => string,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...(await q<T>(h, build(占位(chunk.length)), [...chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① SQL 轴：硬过滤出候选 id
// ---------------------------------------------------------------------------

interface 折叠结果 {
  kpIds: string[];
  folded: { from: string; to: string }[];
  warnings: string[];
}

/**
 * kpIds 折叠：merged 壳 → 活跃落点。
 * 🔴 不折叠的话，"用旧考点 id 查题"会静默零命中——题早就跟着合并挂到新 id 上了。
 */
async function 折叠考点(
  h: CoreDbHandle,
  ids: readonly string[],
): Promise<折叠结果> {
  const out: string[] = [];
  const seen = new Set<string>();
  const folded: { from: string; to: string }[] = [];
  const warnings: string[] = [];

  for (const id of ids) {
    let landed = id;
    try {
      const r = await resolveMergedKp(h, id);
      landed = r.id;
      if (r.hops > 0) folded.push({ from: id, to: r.id });
    } catch (e) {
      // 🔴 链断 / 考点不存在不许吞：这一条不参与过滤，但必须让人看见
      warnings.push(
        `考点 ${id} 追链失败，本次过滤忽略它：${
          e instanceof KgError || e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }
    if (!seen.has(landed)) {
      seen.add(landed);
      out.push(landed);
    }
  }
  return { kpIds: out, folded, warnings };
}

/**
 * 关键词 → 精确命中的考点（`kpAutoResolve` 的实现，见文件头 §kpAutoResolve）。
 *
 * 🔴 只收 `confidence === 1`（exact-name / exact-alias）。前缀 0.9、trigram 0.5
 *    那些"沾边"的一律不要：并入 kpIds 是**改硬过滤**，而硬过滤是非黑即白的判断，
 *    拿一个"大概是这个考点"去缩候选集，缩掉的题用户永远不会知道自己没看见。
 * 🔴 `enqueue:false`：这是检索的顺手一查，不是 agent 在正经问考点——
 *    没把握也不该往人的待办队列里塞工单（页面每敲一次回车就塞一张，队列就废了）。
 * 🔴 `knn:false`：只认 1.0，而 knn-vote 封顶 0.65 —— 它的结果一条都用不上，
 *    却要为每次检索付一次载模型的钱。
 * 🔴 落靶失败不抛：检索照常走字面轴，但原因写进 warnings（静默 = 以后没人知道它没跑）。
 */
async function 关键词落靶(
  h: CoreDbHandle,
  keywords: string,
): Promise<{ hits: KpAutoResolved[]; warnings: string[] }> {
  try {
    const r = await resolveKp(keywords, {
      handle: h,
      enqueue: false,
      knn: false,
      limit: KP_AUTO_LIMIT,
    });
    const hits: KpAutoResolved[] = [];
    for (const c of r.candidates) {
      if (c.confidence < 1) continue;
      if (c.matchedVia !== "exact-name" && c.matchedVia !== "exact-alias") {
        continue;
      }
      hits.push({
        query: keywords,
        kpId: c.kpId,
        name: c.name,
        via: c.matchedVia,
        ...(c.aliasHit ? { aliasHit: c.aliasHit } : {}),
      });
    }
    return { hits, warnings: [] };
  } catch (e) {
    return {
      hits: [],
      warnings: [
        `关键词「${keywords}」自动落靶考点失败，本次只走字面轴：${
          e instanceof Error ? e.message : String(e)
        }`,
      ],
    };
  }
}

interface 候选行 {
  id: string;
}

/**
 * 硬过滤 → 候选 id 集（**稳定序**：created_at 升序，同刻按 id 升序）。
 *
 * 🔴 难度用闭区间且 NULL 不入选：SQL 三值逻辑下 `NULL BETWEEN 3 AND 3` 是 NULL
 *    （不是 false 也不是 true），行会被 WHERE 滤掉——这正是想要的语义
 *    （"没打过档的题"不该混进"我要 3 档"的结果里）。
 *    ⚠️ 当下库里 difficulty 全 NULL（打档是后续的活），所以任何难度过滤都会零命中，
 *       那是数据还没到位，不是本函数错了。
 * 🔴 editionScope 命中 NULL 与等值两种：NULL = 版本通用（M1 Q12），
 *    查"浙教"时通用题当然也该出来。
 */
async function 硬过滤(
  h: CoreDbHandle,
  p: 归一参数,
  kpIds: readonly string[],
): Promise<string[]> {
  const where: string[] = [];
  const args: Args = [];

  const statuses = p.statuses ?? [...DEFAULT_STATUSES];
  where.push(`q.status IN (${占位(statuses.length)})`);
  args.push(...statuses);

  const grades = p.solutionGrade ?? [...DEFAULT_SOLUTION_GRADES];
  where.push(`q.solution_grade IN (${占位(grades.length)})`);
  args.push(...grades);

  if (p.qtype && p.qtype.length > 0) {
    where.push(`q.qtype IN (${占位(p.qtype.length)})`);
    args.push(...p.qtype);
  }

  if (p.difficulty?.min !== undefined) {
    where.push("q.difficulty >= ?");
    args.push(p.difficulty.min);
  }
  if (p.difficulty?.max !== undefined) {
    where.push("q.difficulty <= ?");
    args.push(p.difficulty.max);
  }

  if (p.editionScope !== undefined) {
    where.push("(q.edition_scope IS NULL OR q.edition_scope = ?)");
    args.push(p.editionScope);
  }

  if (kpIds.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM question_kp qk
                WHERE qk.question_id = q.id
                  AND qk.kp_id IN (${占位(kpIds.length)})
                  ${p.primaryOnly === true ? "AND qk.is_primary = 1" : ""})`,
    );
    args.push(...kpIds);
  }

  const excl = p.excludeQuestionIds ?? [];
  if (excl.length > 0) {
    where.push(`q.id NOT IN (${占位(excl.length)})`);
    args.push(...excl);
  }

  const batches = p.ingestBatchIds ?? [];
  if (batches.length > 0) {
    where.push(`q.ingest_batch_id IN (${占位(batches.length)})`);
    args.push(...batches);
  }

  const rows = await q<候选行>(
    h,
    `SELECT q.id AS id
       FROM question q
      WHERE ${where.join("\n        AND ")}
      ORDER BY IFNULL(q.created_at, ''), q.id`,
    args,
  );
  return rows.map((r) => String(r.id));
}

// ---------------------------------------------------------------------------
// ② FTS 轴
// ---------------------------------------------------------------------------

/** 一条轴的一个召回：谁、第几名、原始分（bm25 或余弦） */
export interface AxisHit {
  questionId: string;
  rank: number;
  score: number;
}

interface FTS结果 {
  hits: AxisHit[];
  degraded: boolean;
  op: "and" | "or";
  tokens: string[];
  warnings: string[];
}

/**
 * 关键词 → 候选集内的名次表。
 *
 * 🔴 **AND 零命中自动退 OR，且退了必须标出来**。全 AND 是对的默认
 *    （"去括号 化简"应该两个都沾边），但用户多打一个词就整页空白是很糟的体验；
 *    退成 OR 至少给出"沾一个边"的结果。不标 degraded 的话，用户会以为
 *    这就是 AND 的结果，从而对系统的精度产生错误印象——比空结果更坏。
 */
async function FTS轴(
  h: CoreDbHandle,
  keywords: string,
  候选: ReadonlySet<string>,
): Promise<FTS结果> {
  const warnings: string[] = [];

  const 跑一次 = async (
    op: "and" | "or",
  ): Promise<{ hits: AxisHit[]; tokens: string[] }> => {
    const plan = await ftsQuery(keywords, { op });
    if (!plan.match) return { hits: [], tokens: plan.tokens };
    const rows = await q<{ question_id: string; s: number }>(
      h,
      `SELECT question_id, bm25(question_fts) AS s
         FROM question_fts
        WHERE question_fts MATCH ?
        ORDER BY s
        LIMIT ?`,
      [plan.match, FTS_SCAN_CAP],
    );
    if (rows.length >= FTS_SCAN_CAP) {
      warnings.push(
        `FTS 扫描到达上限 ${FTS_SCAN_CAP} 行，候选集内可能有召回被截断` +
          "（题量涨上来了，该把 MATCH 改成候选集内查了）。",
      );
    }
    const hits: AxisHit[] = [];
    for (const r of rows) {
      const id = String(r.question_id);
      if (!候选.has(id)) continue;
      hits.push({ questionId: id, rank: hits.length + 1, score: Number(r.s) });
    }
    return { hits, tokens: plan.tokens };
  };

  const and = await 跑一次("and");
  if (and.hits.length > 0 || 候选.size === 0) {
    return {
      hits: and.hits,
      degraded: false,
      op: "and",
      tokens: and.tokens,
      warnings,
    };
  }

  const or = await 跑一次("or");
  if (or.hits.length > 0) {
    warnings.push(
      `关键词「${keywords}」全词 AND 在候选集内一条都没命中，已自动退成 OR（命中任一词）再查一次——` +
        "结果已标 degraded，精度按「沾一个边」读。",
    );
  }
  return {
    hits: or.hits,
    degraded: or.hits.length > 0,
    op: or.hits.length > 0 ? "or" : "and",
    tokens: or.tokens.length > 0 ? or.tokens : and.tokens,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ④ 考点标签轴（kpAutoResolve 落靶来的；见文件头 §kpAutoResolve）
// ---------------------------------------------------------------------------

/** 一条考点轴召回：谁、第几名、是被哪几个落靶考点挂着的 */
export interface KpAxisHit {
  questionId: string;
  rank: number;
  kpIds: string[];
}

/**
 * 落靶考点 → 候选集内的名次表。
 *
 * 🔴 名次按**候选集的稳定序**（created_at 升序）走，不是"相关度序"——挂着就是挂着，
 *    考点标签上没有强弱可言。硬编一个分数出来只会让人误以为这里有相关性判断。
 * 🔴 `primaryOnly` 与 kpIds 那条硬过滤同口径：勾了「只认主考点」，这条轴也只认主考点，
 *    否则同一个开关在两个地方是两种意思。
 */
async function 考点轴(
  h: CoreDbHandle,
  kpIds: readonly string[],
  候选: readonly string[],
  primaryOnly: boolean,
): Promise<KpAxisHit[]> {
  if (kpIds.length === 0 || 候选.length === 0) return [];

  const rows = await q<{ question_id: string; kp_id: string }>(
    h,
    `SELECT question_id, kp_id
       FROM question_kp
      WHERE kp_id IN (${占位(kpIds.length)})
        ${primaryOnly ? "AND is_primary = 1" : ""}`,
    [...kpIds],
  );

  const 挂着 = new Map<string, string[]>();
  for (const r of rows) {
    const qid = String(r.question_id);
    const list = 挂着.get(qid) ?? [];
    list.push(String(r.kp_id));
    挂着.set(qid, list);
  }

  const hits: KpAxisHit[] = [];
  for (const id of 候选) {
    const kps = 挂着.get(id);
    if (!kps) continue;
    hits.push({ questionId: id, rank: hits.length + 1, kpIds: kps });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// ③ 向量轴
// ---------------------------------------------------------------------------

interface 向量结果 {
  hits: AxisHit[];
  modelVer: string | null;
  degraded: boolean;
  warnings: string[];
}

async function 向量轴(
  h: CoreDbHandle,
  semanticQuery: string,
  候选: readonly string[],
): Promise<向量结果> {
  const st = await vecAxisStatus(h);
  if (!st.ok) {
    return {
      hits: [],
      modelVer: null,
      degraded: true,
      warnings: [st.reason ?? "语意轴已降级（原因不明）"],
    };
  }
  if (候选.length === 0) {
    return { hits: [], modelVer: st.modelVer, degraded: false, warnings: [] };
  }

  try {
    const [qv] = await embedTexts([semanticQuery]);
    const 深 = 向量深度(候选.length);
    const top = await cosineTopK(qv!, {
      ids: 候选,
      limit: 深,
      handle: h,
    });
    return {
      hits: top.map((t, i) => ({
        questionId: t.questionId,
        rank: i + 1,
        score: round4(t.score),
      })),
      modelVer: st.modelVer,
      degraded: false,
      // 🔴 截断了就说：名次表没铺满候选集，末尾那批题这次没进语意轴（不是"它们不像"）
      warnings:
        候选.length > 深
          ? [
              `语意轴名次表截到 ${深} 条（候选 ${候选.length} 条）——` +
                "排在后面的候选这次没进语意轴，收窄条件即可让它们进来。",
            ]
          : [],
    };
  } catch (e) {
    // 🔴 兜底：前置闸过了但推理/索引仍炸（并发回填、模型文件被换…）。
    //    检索照常出 FTS 结果，但降级理由必须原样带出去。
    const why =
      e instanceof VecError || e instanceof Error ? e.message : String(e);
    return {
      hits: [],
      modelVer: null,
      degraded: true,
      warnings: [`语意轴已降级为纯 FTS：${why}`],
    };
  }
}

// ---------------------------------------------------------------------------
// RRF 融合
// ---------------------------------------------------------------------------

export interface FusedRow {
  questionId: string;
  rrfScore: number;
  sources: HitSources;
}

/**
 * RRF：把若干条"名次表"融成一张。
 *
 * ```
 * score(d) = Σ_轴 1/(RRF_K + rank_轴(d))
 * ```
 *
 * 🔴 排序**确定且可手算**：先按 rrfScore 降序，同分按 questionId 升序
 *    （ULID 单调 ⇒ 同分时谁在前永远一样）。金标测试要的就是这个。
 *
 * 手算对拍（两轴，K=60）：
 *   A 在 FTS 第 1、向量第 3 → 1/61 + 1/63 = 0.016393 + 0.015873 = 0.032266
 *   B 在 FTS 第 2、向量第 1 → 1/62 + 1/61 = 0.016129 + 0.016393 = 0.032522
 *   ⇒ B 排在 A 前面。"两轴都靠前"胜过"一轴第一、另一轴第三"，这正是 k=60 想要的效果。
 */
export function rrfFuse(axes: {
  fts?: readonly AxisHit[];
  vector?: readonly AxisHit[];
  /** 🔴 考点标签轴（kpAutoResolve）：没有分数，只有名次 —— RRF 只吃名次，正好 */
  kp?: readonly KpAxisHit[];
}): FusedRow[] {
  const acc = new Map<string, { score: number; sources: HitSources }>();
  const 取 = (id: string) => acc.get(id) ?? { score: 0, sources: {} };

  const 吃一轴 = (
    hits: readonly AxisHit[] | undefined,
    key: "fts" | "vector",
  ): void => {
    if (!hits) return;
    for (const hit of hits) {
      const cur = 取(hit.questionId);
      cur.score += 1 / (RRF_K + hit.rank);
      cur.sources[key] = { rank: hit.rank, score: hit.score };
      acc.set(hit.questionId, cur);
    }
  };

  吃一轴(axes.fts, "fts");
  吃一轴(axes.vector, "vector");
  for (const hit of axes.kp ?? []) {
    const cur = 取(hit.questionId);
    cur.score += 1 / (RRF_K + hit.rank);
    cur.sources.kp = { rank: hit.rank, kpIds: hit.kpIds };
    acc.set(hit.questionId, cur);
  }

  return [...acc.entries()]
    .map(([questionId, v]) => ({
      questionId,
      rrfScore: round6(v.score),
      sources: v.sources,
    }))
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        (a.questionId < b.questionId
          ? -1
          : a.questionId > b.questionId
            ? 1
            : 0),
    );
}

// ---------------------------------------------------------------------------
// hydrate：id → 摘要卡
// ---------------------------------------------------------------------------

interface 题摘要行 {
  id: string;
  stem: string;
  qtype: string | null;
  difficulty: number | null;
  solution_grade: string;
  status: string;
  prov_type: string;
  edition_scope: string | null;
  review_required: number | null;
}

async function 取摘要(
  h: CoreDbHandle,
  ids: readonly string[],
): Promise<Map<string, SearchHit>> {
  const out = new Map<string, SearchHit>();
  if (ids.length === 0) return out;

  const rows = await 分批查<题摘要行>(
    h,
    ids,
    (ph) => `SELECT id, stem, qtype, difficulty, solution_grade, status,
                    prov_type, edition_scope, review_required
               FROM question WHERE id IN (${ph})`,
  );
  for (const r of rows) {
    out.set(String(r.id), {
      questionId: String(r.id),
      stemBrief: stemBrief(r.stem),
      qtype: r.qtype,
      difficulty: r.difficulty === null ? null : Number(r.difficulty),
      solutionGrade: String(r.solution_grade),
      status: String(r.status),
      provType: String(r.prov_type),
      editionScope: r.edition_scope,
      reviewRequired: Number(r.review_required ?? 0) === 1,
      kps: [],
      rrfScore: 0,
      sources: {},
    });
  }

  const kps = await 分批查<{
    question_id: string;
    kp_id: string;
    name: string;
    is_primary: number | null;
  }>(
    h,
    ids,
    (ph) => `SELECT qk.question_id, qk.kp_id, k.name, qk.is_primary
               FROM question_kp qk JOIN kp k ON k.id = qk.kp_id
              WHERE qk.question_id IN (${ph})
              ORDER BY qk.is_primary DESC, k.name`,
  );
  for (const r of kps) {
    out.get(String(r.question_id))?.kps.push({
      kpId: String(r.kp_id),
      name: String(r.name),
      isPrimary: Number(r.is_primary ?? 0) === 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 🔴 主入口
// ---------------------------------------------------------------------------

/**
 * 三路检索（**页面与 MCP 工具共用的唯一入口**）。
 *
 * 执行序（不许乱）：
 *   1. zod 校验 → 2. 关键词落靶（kpAutoResolve，**只出召回轴、不动过滤**）→
 *   3. kpIds 折叠 → 4. SQL 硬过滤出候选 id 集 →
 *   5. FTS / 向量 / 考点标签**在候选集内**各自出名次表 → 6. RRF 融合 →
 *   7. 截 limit → 8. hydrate 摘要 → 9. logMetric。
 *
 * ```ts
 * await searchQuestions({
 *   kpIds: ["kp_01KZV…"],           // 绝对值的性质与非负性
 *   qtype: ["填空"],
 *   keywords: "去绝对值",
 *   kpAutoResolve: true,            // 「去绝对值」是考点别名 ⇒ 多开一条考点召回轴
 *   semanticQuery: "含字母的绝对值怎么分类讨论",
 *   limit: 5,
 * });
 * ```
 */
export async function searchQuestions(
  params: SearchParams,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const t0 = Date.now();

  const parsed = searchParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new RetrievalError("INVALID_INPUT", z.prettifyError(parsed.error));
  }
  const p = parsed.data;
  const limit = p.limit ?? DEFAULT_SEARCH_LIMIT;
  const h = options.handle ?? (await getCoreDb());
  const warnings: string[] = [];

  // ── ② 关键词落靶（只在显式开了 kpAutoResolve 且真给了 keywords 时跑）────────
  const 落靶 =
    p.kpAutoResolve === true && p.keywords !== undefined
      ? await 关键词落靶(h, p.keywords)
      : { hits: [] as KpAutoResolved[], warnings: [] as string[] };
  warnings.push(...落靶.warnings);

  // ── ③ 考点折叠（🔴 只折调用方显式传的：落靶来的走召回轴，不进硬过滤）────────
  const 折叠 = await 折叠考点(h, p.kpIds ?? []);
  warnings.push(...折叠.warnings);

  // ── ④ SQL 硬过滤 ──────────────────────────────────────────────────────────
  const 候选 = await 硬过滤(h, p, 折叠.kpIds);
  const 候选集 = new Set(候选);

  // ── ⑤ 三条召回轴（只在候选集内）──────────────────────────────────────────
  const ftsOn = p.keywords !== undefined;
  const vecOn = p.semanticQuery !== undefined;
  const kpAxisOn = 落靶.hits.length > 0;

  const fts = ftsOn
    ? await FTS轴(h, p.keywords!, 候选集)
    : {
        hits: [],
        degraded: false,
        op: null,
        tokens: [],
        warnings: [] as string[],
      };
  warnings.push(...fts.warnings);

  const vec = vecOn
    ? await 向量轴(h, p.semanticQuery!, 候选)
    : { hits: [], modelVer: null, degraded: false, warnings: [] as string[] };
  warnings.push(...vec.warnings);

  const kpAxis = kpAxisOn
    ? await 考点轴(
        h,
        落靶.hits.map((x) => x.kpId),
        候选,
        p.primaryOnly === true,
      )
    : [];

  // ── ⑥ 融合 ────────────────────────────────────────────────────────────────
  // 🔴 只把**真跑起来了**的轴喂进 RRF：语意轴降级时它是"没有这条轴"，
  //    不是"这条轴一条都没召回"——后者会让 sources 里凭空多一个空壳。
  const vecReallyOn = vecOn && !vec.degraded;
  let fused: FusedRow[];
  if (ftsOn || vecReallyOn || kpAxisOn) {
    fused = rrfFuse({
      ...(ftsOn ? { fts: fts.hits } : {}),
      ...(vecReallyOn ? { vector: vec.hits } : {}),
      ...(kpAxisOn ? { kp: kpAxis } : {}),
    });
  } else {
    // 零轴：没有"相关性"可言，回硬过滤的稳定序
    fused = 候选.map((id) => ({
      questionId: id,
      rrfScore: 0,
      sources: { sqlOnly: true as const },
    }));
  }

  const total = fused.length;
  const 页 = fused.slice(0, limit);

  // ── ⑦ hydrate ────────────────────────────────────────────────────────────
  const 摘要 = await 取摘要(
    h,
    页.map((f) => f.questionId),
  );
  const hits: SearchHit[] = [];
  for (const f of 页) {
    const card = 摘要.get(f.questionId);
    if (!card) continue; // 并发删题；不该发生，但不为它炸整次检索
    card.rrfScore = f.rrfScore;
    card.sources = f.sources;
    hits.push(card);
  }

  const degraded = fts.degraded || (vecOn && vec.degraded);
  const ms = Date.now() - t0;

  const result: SearchResult = {
    query: {
      kpIds: 折叠.kpIds,
      kpFolded: 折叠.folded,
      kpAutoResolve: p.kpAutoResolve === true,
      kpAutoResolved: 落靶.hits,
      primaryOnly: p.primaryOnly === true,
      difficulty: p.difficulty ?? null,
      qtype: p.qtype ?? [],
      solutionGrade: p.solutionGrade ?? [...DEFAULT_SOLUTION_GRADES],
      editionScope: p.editionScope ?? null,
      keywords: p.keywords ?? null,
      semanticQuery: p.semanticQuery ?? null,
      excludeCount: (p.excludeQuestionIds ?? []).length,
      ingestBatchIds: p.ingestBatchIds ?? [],
      statuses: p.statuses ?? [...DEFAULT_STATUSES],
      limit,
    },
    hits,
    total,
    candidateCount: 候选.length,
    axes: {
      sql: { count: 候选.length },
      fts: {
        active: ftsOn,
        count: fts.hits.length,
        degraded: fts.degraded,
        op: fts.op,
        tokens: fts.tokens,
      },
      vector: {
        active: vecReallyOn,
        count: vec.hits.length,
        modelVer: vec.modelVer,
      },
      kpAuto: {
        active: kpAxisOn,
        count: kpAxis.length,
        kpIds: 落靶.hits.map((x) => x.kpId),
      },
    },
    degraded,
    warnings,
    ms,
  };

  // ── ⑧ 打点（Q9 的原料：评测集从真实查询里抽，不另造）───────────────────
  if (options.metric !== false) {
    await logMetric(
      "search",
      null,
      {
        params: result.query,
        candidateCount: result.candidateCount,
        total: result.total,
        returned: hits.length,
        axes: {
          fts: {
            active: ftsOn,
            count: fts.hits.length,
            degraded: fts.degraded,
            op: fts.op,
          },
          vector: { active: vecReallyOn, count: vec.hits.length },
          kpAuto: { active: kpAxisOn, count: kpAxis.length },
        },
        degraded,
        warnings: warnings.length,
        ms,
      },
      h,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// 「找与这道题相似的」
// ---------------------------------------------------------------------------

export interface SimilarHit {
  questionId: string;
  stemBrief: string;
  /** 余弦相似度（库内向量已 L2 归一 ⇒ 就是点积） */
  score: number;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  kps: QuestionKpBrief[];
}

export interface SimilarResult {
  questionId: string;
  /** 拿来当查询的那道题（题面摘要） */
  stemBrief: string;
  hits: SimilarHit[];
  modelVer: string | null;
  degraded: boolean;
  warnings: string[];
  ms: number;
}

export interface SimilarOptions {
  limit?: number;
  handle?: CoreDbHandle;
  metric?: boolean;
}

/**
 * 找与某道题最像的题（**验收 4-1 的第三条路**）。
 *
 * 🔴 用它的 `stem` 现算一次查询向量，而不是直接读 `question_vec` 里那条：
 *    读库里那条会快一点点，但一旦这道题的向量还没回填（C1(b) 的 warn 态），
 *    就得在"报错"和"返回空"之间二选一，两个都不好。现算永远有得算。
 * 🔴 排除自身——不然 top1 恒是它自己（相似度 1.0），白占一个名额。
 */
export async function findSimilarQuestions(
  questionId: string,
  options: SimilarOptions = {},
): Promise<SimilarResult> {
  const t0 = Date.now();
  const id = String(questionId ?? "").trim();
  if (!id) throw new RetrievalError("INVALID_INPUT", "question_id 不能为空");

  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const h = options.handle ?? (await getCoreDb());

  const row = (
    await q<{ id: string; stem: string }>(
      h,
      "SELECT id, stem FROM question WHERE id = ?",
      [id],
    )
  )[0];
  if (!row) throw 查无此题(id);

  const st = await vecAxisStatus(h);
  if (!st.ok) {
    return {
      questionId: id,
      stemBrief: stemBrief(row.stem),
      hits: [],
      modelVer: null,
      degraded: true,
      warnings: [st.reason ?? "语意轴已降级（原因不明）"],
      ms: Date.now() - t0,
    };
  }

  const [qv] = await embedTexts([row.stem]);
  // 多取一条：自身几乎必然在 top1，排掉之后仍要凑够 limit
  const top = (await cosineTopK(qv!, { limit: limit + 1, handle: h })).filter(
    (t) => t.questionId !== id,
  );
  const 页 = top.slice(0, limit);

  const 摘要 = await 取摘要(
    h,
    页.map((t) => t.questionId),
  );
  const hits: SimilarHit[] = [];
  for (const t of 页) {
    const c = 摘要.get(t.questionId);
    if (!c) continue;
    hits.push({
      questionId: c.questionId,
      stemBrief: c.stemBrief,
      score: round4(t.score),
      qtype: c.qtype,
      difficulty: c.difficulty,
      solutionGrade: c.solutionGrade,
      status: c.status,
      kps: c.kps,
    });
  }

  const ms = Date.now() - t0;
  if (options.metric !== false) {
    await logMetric(
      "search",
      id,
      { mode: "similar", limit, returned: hits.length, ms },
      h,
    );
  }

  return {
    questionId: id,
    stemBrief: stemBrief(row.stem),
    hits,
    modelVer: st.modelVer,
    degraded: false,
    warnings: [],
    ms,
  };
}

// ---------------------------------------------------------------------------
// 查重帮手（005 库级排重闸的地基）
// ---------------------------------------------------------------------------

export interface DuplicateExactHit {
  questionId: string;
  stemBrief: string;
  status: string;
  solutionGrade: string;
}

export interface DuplicateResult {
  /** 规范化题面的 sha256（= question.match_key 的口径，与录题闸⑦同一个函数） */
  matchKey: string;
  /** 🔴 match_key 撞上的（pending/active 里唯一，所以最多一条）——**这是硬重复** */
  exact: DuplicateExactHit[];
  /** 语义最近的几条（可能只是像，不是重复；给人判断，不做自动裁决） */
  similar: SimilarHit[];
  modelVer: string | null;
  degraded: boolean;
  warnings: string[];
}

export interface CheckDuplicateOptions {
  limit?: number;
  handle?: CoreDbHandle;
}

/**
 * 「这题库里有没有」——match_key 精确撞 + 向量 top-N 相似，一次都给出来。
 *
 * 🔴 两个结果层次不同，绝不合成一个"重复分数"：
 *      exact   = 规范化后**一模一样**，这是事实判断（录题闸⑦拿它拒批）；
 *      similar = 像，程度由余弦说话，**是不是重复得人来判**。
 *    把它们揉成一个分数，等于让一个阈值去替人做"这算不算同一道题"的判断，
 *    而那个判断本来就没有普适阈值。
 */
export async function checkDuplicate(
  stemText: string,
  options: CheckDuplicateOptions = {},
): Promise<DuplicateResult> {
  const s = String(stemText ?? "").trim();
  if (!s) throw new RetrievalError("INVALID_INPUT", "stem 不能为空");

  const h = options.handle ?? (await getCoreDb());
  const limit = Math.max(1, Math.trunc(options.limit ?? 3));
  const key = matchKeyOf(s);

  const exactRows = await q<{
    id: string;
    stem: string;
    status: string;
    solution_grade: string;
  }>(
    h,
    `SELECT id, stem, status, solution_grade
       FROM question
      WHERE match_key = ? AND status IN ('pending','active')
      ORDER BY id`,
    [key],
  );
  const exact: DuplicateExactHit[] = exactRows.map((r) => ({
    questionId: String(r.id),
    stemBrief: stemBrief(r.stem),
    status: String(r.status),
    solutionGrade: String(r.solution_grade),
  }));

  const st = await vecAxisStatus(h);
  if (!st.ok) {
    return {
      matchKey: key,
      exact,
      similar: [],
      modelVer: null,
      degraded: true,
      warnings: [st.reason ?? "语意轴已降级（原因不明）"],
    };
  }

  const [qv] = await embedTexts([s]);
  const top = await cosineTopK(qv!, { limit, handle: h });
  const 摘要 = await 取摘要(
    h,
    top.map((t) => t.questionId),
  );
  const similar: SimilarHit[] = [];
  for (const t of top) {
    const c = 摘要.get(t.questionId);
    if (!c) continue;
    similar.push({
      questionId: c.questionId,
      stemBrief: c.stemBrief,
      score: round4(t.score),
      qtype: c.qtype,
      difficulty: c.difficulty,
      solutionGrade: c.solutionGrade,
      status: c.status,
      kps: c.kps,
    });
  }

  return {
    matchKey: key,
    exact,
    similar,
    modelVer: st.modelVer,
    degraded: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// getQuestion：一道题的全量卡片
// ---------------------------------------------------------------------------

export interface QuestionFigureView {
  id: string;
  role: string | null;
  reviewState: string | null;
  assetId: string | null;
  /** 资产内容哈希（拿它走 /api/asset/[hash] 取字节） */
  hash: string | null;
  path: string | null;
  bytes: number | null;
  kind: string | null;
}

export interface QuestionProvenance {
  /** scan / model / pipeline / manual */
  type: string;
  /** scan：源文档 + 页码 */
  sourceDoc?: {
    id: string;
    title: string;
    kind: string | null;
    pages: number | null;
    path: string | null;
    hash: string | null;
  };
  pageNo?: number;
  /** model：由哪个考察模型生成 */
  model?: { id: string; name: string; kpId: string; status: string };
  /** pipeline：产线标识（脚本名@版本 + 参数摘要） */
  pipelineRef?: string;
  /** manual：谁手录的 */
  createdBy?: string;
  /** 管道来料：哪一批 */
  batch?: {
    id: string;
    source: string;
    contractVer: string;
    status: string | null;
    createdAt: string | null;
    committedAt: string | null;
  };
}

export interface QuestionCard {
  id: string;
  /** 正本（LaTeX 混排，渲染要用） */
  stem: string;
  answer: string | null;
  analysis: string | null;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  reviewRequired: boolean;
  matchKey: string | null;
  editionScope: string | null;
  kps: QuestionKpBrief[];
  tags: string[];
  figures: QuestionFigureView[];
  provenance: QuestionProvenance;
  hasVector: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GetQuestionOptions {
  handle?: CoreDbHandle;
}

function 查无此题(id: string): RetrievalError {
  return new RetrievalError(
    "QUESTION_NOT_FOUND",
    `题 ${id} 不在库里。` +
      "🔴 题 id 是纯 ULID，里面读不出任何语义，所以这里给不出「最像的候选」（给了也是瞎猜）。" +
      "下一步：用 search_questions 按考点/关键词/语意把它找出来，拿返回里的 questionId 再调一次。",
    id,
  );
}

/**
 * 一道题的全量卡片：正本三段 + 考点 + 标签 + 配图（含审核态）+ provenance 四型细节。
 *
 * 🔴 查无此题 → 抛 {@link RetrievalError}(QUESTION_NOT_FOUND)，
 *    message 里写清楚"下一步调 search_questions"（REG-G2 的自愈口径）。
 */
export async function getQuestion(
  questionId: string,
  options: GetQuestionOptions = {},
): Promise<QuestionCard> {
  const id = String(questionId ?? "").trim();
  if (!id) throw new RetrievalError("INVALID_INPUT", "question_id 不能为空");
  const h = options.handle ?? (await getCoreDb());

  const row = (
    await q<{
      id: string;
      stem: string;
      answer: string | null;
      analysis: string | null;
      qtype: string | null;
      difficulty: number | null;
      status: string;
      solution_grade: string;
      review_required: number | null;
      match_key: string | null;
      prov_type: string;
      source_doc_id: string | null;
      source_page_no: number | null;
      model_id: string | null;
      pipeline_ref: string | null;
      ingest_batch_id: string | null;
      edition_scope: string | null;
      created_by: string | null;
      created_at: string | null;
      updated_at: string | null;
    }>(h, "SELECT * FROM question WHERE id = ?", [id])
  )[0];
  if (!row) throw 查无此题(id);

  const kps = (
    await q<{ kp_id: string; name: string; is_primary: number | null }>(
      h,
      `SELECT qk.kp_id, k.name, qk.is_primary
         FROM question_kp qk JOIN kp k ON k.id = qk.kp_id
        WHERE qk.question_id = ?
        ORDER BY qk.is_primary DESC, k.name`,
      [id],
    )
  ).map((r) => ({
    kpId: String(r.kp_id),
    name: String(r.name),
    isPrimary: Number(r.is_primary ?? 0) === 1,
  }));

  const tags = (
    await q<{ tag: string }>(
      h,
      "SELECT tag FROM question_tag WHERE question_id = ? ORDER BY tag",
      [id],
    )
  ).map((r) => String(r.tag));

  const figures = (
    await q<{
      id: string;
      role: string | null;
      review_state: string | null;
      asset_id: string | null;
      hash: string | null;
      path: string | null;
      bytes: number | null;
      kind: string | null;
    }>(
      h,
      `SELECT f.id, f.role, f.review_state, f.asset_id,
              a.hash, a.path, a.bytes, a.kind
         FROM question_figure f LEFT JOIN asset a ON a.id = f.asset_id
        WHERE f.question_id = ?
        ORDER BY f.role, f.id`,
      [id],
    )
  ).map((r) => ({
    id: String(r.id),
    role: r.role,
    reviewState: r.review_state,
    assetId: r.asset_id,
    hash: r.hash,
    path: r.path,
    bytes: r.bytes === null ? null : Number(r.bytes),
    kind: r.kind,
  }));

  // ── provenance 四型：按 prov_type 只填该型该有的那几格 ────────────────────
  const provenance: QuestionProvenance = { type: String(row.prov_type) };

  if (row.source_doc_id) {
    const d = (
      await q<{
        id: string;
        title: string;
        kind: string | null;
        pages: number | null;
        path: string | null;
        hash: string | null;
      }>(
        h,
        "SELECT id, title, kind, pages, path, hash FROM source_doc WHERE id = ?",
        [row.source_doc_id],
      )
    )[0];
    if (d) {
      provenance.sourceDoc = {
        id: String(d.id),
        title: String(d.title),
        kind: d.kind,
        pages: d.pages === null ? null : Number(d.pages),
        path: d.path,
        hash: d.hash,
      };
    }
  }
  if (row.source_page_no !== null) {
    provenance.pageNo = Number(row.source_page_no);
  }
  if (row.model_id) {
    const m = (
      await q<{ id: string; name: string; kp_id: string; status: string }>(
        h,
        "SELECT id, name, kp_id, status FROM exam_model WHERE id = ?",
        [row.model_id],
      )
    )[0];
    if (m) {
      provenance.model = {
        id: String(m.id),
        name: String(m.name),
        kpId: String(m.kp_id),
        status: String(m.status),
      };
    }
  }
  if (row.pipeline_ref) provenance.pipelineRef = row.pipeline_ref;
  if (row.created_by) provenance.createdBy = row.created_by;
  if (row.ingest_batch_id) {
    const b = (
      await q<{
        id: string;
        source: string;
        contract_ver: string;
        status: string | null;
        created_at: string | null;
        committed_at: string | null;
      }>(
        h,
        `SELECT id, source, contract_ver, status, created_at, committed_at
           FROM ingest_batch WHERE id = ?`,
        [row.ingest_batch_id],
      )
    )[0];
    if (b) {
      provenance.batch = {
        id: String(b.id),
        source: String(b.source),
        contractVer: String(b.contract_ver),
        status: b.status,
        createdAt: b.created_at,
        committedAt: b.committed_at,
      };
    }
  }

  const hasVector =
    (
      await q<{ c: number | bigint }>(
        h,
        "SELECT COUNT(*) AS c FROM question_vec WHERE question_id = ?",
        [id],
      )
    ).map((r) => Number(r.c))[0] === 1;

  return {
    id: String(row.id),
    stem: String(row.stem),
    answer: row.answer,
    analysis: row.analysis,
    qtype: row.qtype,
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    solutionGrade: String(row.solution_grade),
    status: String(row.status),
    reviewRequired: Number(row.review_required ?? 0) === 1,
    matchKey: row.match_key,
    editionScope: row.edition_scope,
    kps,
    tags,
    figures,
    provenance,
    hasVector,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
