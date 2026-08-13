/**
 * 题库检索页的公共小件（AI:PRD-004 · 004-C）
 *
 * 🔴 单独一个文件的理由与 kg/shared.ts 相同：page.tsx 是 server component，
 *    这里放的是**纯函数**（URL ↔ 表单状态互转、来源徽章），可以直接单测，
 *    不必为了验一条 URL 拼接去起一个浏览器。
 *
 * ── 🔴 URL 即状态 ───────────────────────────────────────────────────────────
 *   本页全部走 GET 表单：条件都在地址栏里，于是一次检索**可收藏、可分享、可后退**。
 *   代价是所有状态都得能编码进 query string（多选用重复键 `kp=a&kp=b`），
 *   收益是页面零 client 状态 —— 与全站「server component + 现算」的路子一致。
 *
 * ── 🔴 `f=1` 那个隐藏字段是干什么的 ─────────────────────────────────────────
 *   HTML 的 checkbox **没勾就压根不提交**，于是「首屏（什么都没查）」与
 *   「查过了，但把『含次考点』取消了」在 URL 上长得一模一样（都没有 sub 键）。
 *   表单里挂一个恒为 1 的隐藏 `f`，就能把这两件事分开：
 *   没有 f = 没提交过，走默认值；有 f = 用户表过态，缺席的勾就是真的没勾。
 */
import type { HitSources } from "~/core";

/** 返回几条（下拉里给这三档就够，本地库总共也才几十题） */
export const LIMIT_CHOICES = [10, 20, 50] as const;
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * 判档下拉的四个选项 → solutionGrade 入参。
 * 🔴 `""`（默认）是**不传**，让 core 的默认口径说了算（排除 no_solution，M1 Q11），
 *    而不是在页面里抄一份 ['calc_verified','analysis_only'] —— 抄出来的那份迟早跟 core 漂。
 */
export const GRADE_CHOICES = [
  { key: "", label: "默认（实算过 + 仅解析）" },
  { key: "calc", label: "只看实算过 calc_verified" },
  { key: "analysis", label: "只看仅解析 analysis_only" },
  { key: "all", label: "全部三档（含无解析）" },
] as const;

export type GradeChoice = (typeof GRADE_CHOICES)[number]["key"];

export const GRADE_TO_PARAM: Record<GradeChoice, string[] | undefined> = {
  "": undefined,
  calc: ["calc_verified"],
  analysis: ["analysis_only"],
  all: ["calc_verified", "analysis_only", "no_solution"],
};

/** 页面的检索表单状态（= URL 的另一种写法） */
export interface SearchForm {
  /** 🔴 表单提交过没有（见文件头 §f=1）；false ⇒ 勾选类字段走默认值 */
  submitted: boolean;
  /** 已选中的考点 id（chip） */
  kpIds: string[];
  /** 考点搜索框里的词（用来出候选，本身不参与过滤） */
  kpq: string;
  /** FTS 轴 */
  keywords: string;
  /** 向量轴 */
  semantic: string;
  qtypes: string[];
  grade: GradeChoice;
  /** 含次考点（= primaryOnly 的反义）。默认 true = 主副都算 */
  includeSub: boolean;
  limit: number;
  /** 非空 ⇒ 走「找相似」模式（findSimilarQuestions），条件面板不参与 */
  similar: string;
}

type SP = Record<string, string | string[] | undefined>;

/** searchParams 取一个标量（Next 给的可能是数组） */
export function one(sp: SP, key: string): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

/** searchParams 取全部值（多选用重复键，如 `kp=a&kp=b`） */
export function many(sp: SP, key: string): string[] {
  const v = sp[key];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

function 认识的档(s: string): GradeChoice {
  return GRADE_CHOICES.some((g) => g.key === s) ? (s as GradeChoice) : "";
}

/** URL → 表单状态（认不出来的值一律回默认，不抛：地址栏是人能手改的地方） */
export function parseForm(sp: SP): SearchForm {
  const submitted = one(sp, "f") === "1";
  const limitRaw = Number(one(sp, "limit"));
  return {
    submitted,
    kpIds: [...new Set(many(sp, "kp"))],
    kpq: one(sp, "kpq"),
    keywords: one(sp, "kw"),
    semantic: one(sp, "sem"),
    qtypes: [...new Set(many(sp, "qt"))],
    grade: 认识的档(one(sp, "sg")),
    // 🔴 没提交过 ⇒ 默认勾上（主副考点都算）；提交过 ⇒ 缺席就是真的没勾
    includeSub: submitted ? many(sp, "sub").includes("1") : true,
    limit: (LIMIT_CHOICES as readonly number[]).includes(limitRaw)
      ? limitRaw
      : DEFAULT_PAGE_LIMIT,
    similar: one(sp, "similar"),
  };
}

/** 表单状态 → query string（空值不写进 URL，地址栏别被一串 `&kw=&sem=` 塞满） */
export function toParams(f: SearchForm): URLSearchParams {
  const p = new URLSearchParams();
  p.set("f", "1");
  for (const id of f.kpIds) p.append("kp", id);
  if (f.kpq) p.set("kpq", f.kpq);
  if (f.keywords) p.set("kw", f.keywords);
  if (f.semantic) p.set("sem", f.semantic);
  for (const q of f.qtypes) p.append("qt", q);
  if (f.grade) p.set("sg", f.grade);
  if (f.includeSub) p.set("sub", "1");
  if (f.limit !== DEFAULT_PAGE_LIMIT) p.set("limit", String(f.limit));
  if (f.similar) p.set("similar", f.similar);
  return p;
}

/** 在当前表单上改几个键 → 新的 /search 链接（chip 的 × 、候选的「选它」都用它） */
export function searchUrl(
  f: SearchForm,
  patch: Partial<SearchForm> = {},
): string {
  return `/search?${toParams({ ...f, ...patch }).toString()}`;
}

/**
 * 这次到底算不算「查了点什么」。
 *
 * 🔴 它决定要不要落 metric_event：首屏空表单（谁点开页面都会触发一次）落进去
 *    就是给 004-D 的评测集掺水 —— 那些行既不代表真实查询意图，还会淹掉真查询。
 * 🔴 `includeSub`/`limit` 不算条件：它们改的是**怎么看**，不是**看什么**。
 */
export function hasCondition(f: SearchForm): boolean {
  return (
    f.kpIds.length > 0 ||
    f.keywords.length > 0 ||
    f.semantic.length > 0 ||
    f.qtypes.length > 0 ||
    f.grade !== "" ||
    f.similar.length > 0
  );
}

/** 一枚命中来源徽章 */
export interface SourceBadge {
  label: string;
  tone: "g" | "n";
  /** 鼠标悬停的原值（bm25 是负数、余弦是 0~1，摆在徽章上太吵） */
  title: string;
}

/**
 * 命中来源 → 徽章（人一眼看出「为什么它在这儿」）。
 *
 * 🔴 多轴命中就是**多枚**徽章，不合成一枚：RRF 分能说明"综合排第几"，
 *    但说不出"字面中了、语意中了、还是挂着那个考点" —— 而挑题的人要的正是后者。
 * 🔴 `仅条件` 用中性灰：一条召回轴都没激活时它没有相关性可言，
 *    跟"排到第 1 名"用同一种绿会误导。
 */
export function sourceBadges(sources: HitSources): SourceBadge[] {
  const out: SourceBadge[] = [];
  if (sources.fts) {
    out.push({
      label: `FTS #${sources.fts.rank}`,
      tone: "g",
      title: `关键词轴（字面）批内第 ${sources.fts.rank} 名，bm25=${sources.fts.score}（越负越相关）`,
    });
  }
  if (sources.vector) {
    out.push({
      label: `语意 ${sources.vector.score}`,
      tone: "g",
      title: `语意轴（句向量）批内第 ${sources.vector.rank} 名，余弦=${sources.vector.score}`,
    });
  }
  if (sources.kp) {
    out.push({
      label: `考点 #${sources.kp.rank}`,
      tone: "g",
      title:
        "考点标签轴：你敲的关键词落靶成了考点，这道题挂着它（挂了就是挂了，没有相关性分数；" +
        `名次 ${sources.kp.rank} 是候选集里的稳定序）`,
    });
  }
  if (sources.sqlOnly) {
    out.push({
      label: "仅条件",
      tone: "n",
      title:
        "两条召回轴都没给出名次——这条纯粹是标签硬过滤的产物，没有相关性排名（顺序 = 入库序）",
    });
  }
  return out;
}

/**
 * 多于一条轴命中时才值得把 RRF 分摆出来 —— 单轴时它与名次一一对应，是废话。
 * （三条召回轴：字面 fts / 语意 vector / 考点标签 kp）
 */
export function showRrf(sources: HitSources): boolean {
  return [sources.fts, sources.vector, sources.kp].filter(Boolean).length > 1;
}
