/**
 * 检索评测（AI:PRD-004 · 004-D）—— 回归清单 D 组三条的载体。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 用法
 *   pnpm exec tsx --env-file=.env scripts/eval-retrieval.ts
 *       常规模式：跑全量评测集 → 与基准比对。**任一总指标比基准低超过 0.02
 *       （或负样本误命中变多）→ 退出码 1 + 写一条 metric_event(kind='eval_regression_red')**。
 *
 *   pnpm exec tsx --env-file=.env scripts/eval-retrieval.ts --baseline
 *       立基准：结果写 metric_event(kind='eval_baseline') + 落
 *       tests/fixtures/eval-baseline-20260813.json（入 git = 回归基准）。
 *
 *   pnpm exec tsx --env-file=.env scripts/eval-retrieval.ts --audit-sources [--n 20]
 *       REG-D2：取最近 N 条 kind='search' 的**真实**打点，按打点里回显的参数重放，
 *       断言每条命中都带 sources 来源标注、且语意轴贡献计数从打点里取得出来。
 *
 *   附加：--json 只吐 JSON（给脚本吃）。
 *
 * ── 🔴 三条纪律 ─────────────────────────────────────────────────────────────
 *  ① **评测不许污染真查询日志**：全程 `searchQuestions(..., {metric:false})`。
 *     评测集是从 metric_event 的真查询里抽的（M0·Q9），要是评测自己也往里写，
 *     下一轮就会从自己的回声里抽料——评测集会慢慢变成「系统喜欢的查询」的集合。
 *  ② **本脚本一行检索实现都不改**：它只观测。评测红了就红了，红的意思是
 *     「检索行为变了」，该去看是改对了还是改坏了，不是回来调评测。
 *  ③ **IDCG 取自全部已判相关**（不只是系统返回的那些）⇒ 召不回来的相关题会
 *     实实在在压低 NDCG。这条是评测有没有牙的分界线：只拿返回结果算理想序，
 *     那么「只返回 1 条且正好相关」也能拿满分，等于给漏召回发奖。
 *
 * ── 指标口径 ───────────────────────────────────────────────────────────────
 *   NDCG@10   gain = 2^grade - 1（grade∈{2,1}⇒{3,1}），折损 1/log2(rank+1)；
 *             IDCG = 全部已判相关按 grade 降序取前 10 的 DCG。
 *   MRR       第一条相关（grade≥1）命中的名次倒数，10 条内没有则记 0。
 *   命中率     top-10 里至少有一条相关的查询占比。
 *   召回@10    |相关∩top10| / |相关|，逐查询算再取平均（macro）。
 *   负样本     单独统计：期望零命中，返回几条就记几条**误命中**，不进上面四项。
 *
 * ── 分轴归因（「语意轴贡献计数」的出处，M1 §5③ 的原料）───────────────────
 *   逐条命中看 sources：fts / vector / kp / sqlOnly 各自出现多少次，其中
 *   **独占**（这条命中只有这一条轴召回）多少次，独占里**判为相关的**多少次。
 *   🔴 语意轴的退出判据看的是最后那个数，而且要看「多轴查询」那一栏——
 *      纯语意查询里向量当然是独占的，那不说明任何事。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeCoreDb,
  getCoreDb,
  logMetric,
  searchQuestions,
  type HitSources,
  type SearchParams,
  type SearchResult,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const 仓根 = join(import.meta.dirname, "..");
const 评测集路径 = join(仓根, "tests/fixtures/retrieval-eval-20260813.json");
const 基准路径 = join(仓根, "tests/fixtures/eval-baseline-20260813.json");

/** 指标算到第几名 */
const K = 10;

/**
 * 允许的指标退化幅度。
 * 🔴 不是 0：向量轴是浮点余弦，换机器/换 onnxruntime 小版本时末位名次可能抖一格，
 *    严格 0 容忍会变成一个天天假红的闸（而红旗麻木比没有闸更危险）。
 *    0.02 是「一条查询里换一个名次」量级，真把一条轴改坏了会远远超过它。
 */
const 容忍 = 0.02;

/** --audit-sources 默认看最近几条真打点 */
const 默认审计条数 = 20;

// ---------------------------------------------------------------------------
// 评测集契约
// ---------------------------------------------------------------------------

interface 判定 {
  questionId: string;
  grade: 1 | 2;
}

interface 评测条目 {
  id: string;
  scenario: string;
  source: string;
  query: SearchParams;
  judgedBy: string;
  judgeNote: string;
  relevant: 判定[];
  /** true = 负样本：期望零命中，返回几条记几条误命中 */
  negative?: boolean;
}

interface 评测集 {
  version: string;
  builtAt: string;
  queries: 评测条目[];
}

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

function gain(grade: number): number {
  return Math.pow(2, grade) - 1;
}

function dcg(grades: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < grades.length; i++) {
    s += gain(grades[i]!) / Math.log2(i + 2);
  }
  return s;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

interface 单条结果 {
  id: string;
  negative: boolean;
  scenario: string;
  /** 命中的题 id（截到 K 之前的完整返回） */
  returned: string[];
  /** 相关判定总数 */
  relevantTotal: number;
  ndcg10: number;
  rr: number;
  hit: boolean;
  recall10: number;
  /** 负样本专用：误命中条数 */
  falseHits: number;
  axes: {
    fts: boolean;
    vector: boolean;
    kpAuto: boolean;
    candidateCount: number;
    total: number;
  };
  degraded: boolean;
  warnings: string[];
  ms: number;
}

function 评一条(item: 评测条目, r: SearchResult): 单条结果 {
  const ids = r.hits.map((h) => h.questionId);
  const 档 = new Map<string, number>(
    item.relevant.map((x) => [x.questionId, x.grade]),
  );
  const topK = ids.slice(0, K);
  const topK档 = topK.map((id) => 档.get(id) ?? 0);

  const 理想 = [...item.relevant]
    .map((x) => x.grade)
    .sort((a, b) => b - a)
    .slice(0, K);
  const idcg = dcg(理想);
  const ndcg = idcg === 0 ? 0 : dcg(topK档) / idcg;

  const 首个相关 = topK档.findIndex((g) => g > 0);
  const rr = 首个相关 === -1 ? 0 : 1 / (首个相关 + 1);
  const 命中数 = topK档.filter((g) => g > 0).length;

  return {
    id: item.id,
    negative: item.negative === true,
    scenario: item.scenario,
    returned: ids,
    relevantTotal: item.relevant.length,
    ndcg10: round4(ndcg),
    rr: round4(rr),
    hit: 命中数 > 0,
    recall10:
      item.relevant.length === 0 ? 0 : round4(命中数 / item.relevant.length),
    falseHits: item.negative === true ? ids.length : 0,
    axes: {
      fts: r.axes.fts.active,
      vector: r.axes.vector.active,
      kpAuto: r.axes.kpAuto.active,
      candidateCount: r.candidateCount,
      total: r.total,
    },
    degraded: r.degraded,
    warnings: r.warnings,
    ms: r.ms,
  };
}

// ---------------------------------------------------------------------------
// 分轴归因
// ---------------------------------------------------------------------------

type 轴名 = "fts" | "vector" | "kp" | "sqlOnly";
const 轴清单: 轴名[] = ["fts", "vector", "kp", "sqlOnly"];

interface 轴统计 {
  /** 这条轴召回了多少条命中（含与别的轴共同召回的） */
  hits: number;
  /** 其中「只有这一条轴召回」的有多少条 */
  sole: number;
  /** 独占命中里判为相关（grade≥1）的有多少条 —— 🔴 这条轴到底带来了什么 */
  soleRelevant: number;
  /** 只统计**多轴同时激活**的查询：独占且相关的有多少条（语意轴退出判据看这个） */
  soleRelevantMultiAxis: number;
}

function 空轴统计(): 轴统计 {
  return { hits: 0, sole: 0, soleRelevant: 0, soleRelevantMultiAxis: 0 };
}

function 轴们(s: HitSources): 轴名[] {
  return 轴清单.filter((k) => s[k] !== undefined);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

interface 总表 {
  evalSet: string;
  evalSetVersion: string;
  takenAt: string;
  overall: {
    queries: number;
    ndcg10: number;
    mrr: number;
    hitRate: number;
    recall10: number;
  };
  negatives: { queries: number; falseHits: number; dirtyQueries: string[] };
  axes: Record<轴名, 轴统计> & { multiAxisQueries: number };
  perQuery: Record<
    string,
    { ndcg10: number; rr: number; hit: boolean; recall10: number }
  >;
}

/** 参与红/绿判定的四个总指标（都是「越大越好」） */
const 总指标键 = ["ndcg10", "mrr", "hitRate", "recall10"] as const;
type 总指标键 = (typeof 总指标键)[number];

// ---------------------------------------------------------------------------
// 主流程：跑全量
// ---------------------------------------------------------------------------

async function 跑全量(): Promise<{ 表: 总表; 明细: 单条结果[] }> {
  const set = JSON.parse(readFileSync(评测集路径, "utf8")) as 评测集;

  // 🔴 先验题 id 全是真的：评测集里写错一个 id，它会永远算作「没召回」，
  //    于是基线被一个手滑压低，而且没人看得出来。宁可当场拒跑。
  await 校验题id(set);

  const 明细: 单条结果[] = [];
  const 轴表: Record<轴名, 轴统计> = {
    fts: 空轴统计(),
    vector: 空轴统计(),
    kp: 空轴统计(),
    sqlOnly: 空轴统计(),
  };
  let 多轴查询数 = 0;

  for (const item of set.queries) {
    // 🔴 metric:false —— 见文件头纪律①
    const r = await searchQuestions(item.query, { metric: false });
    const 判 = 评一条(item, r);
    明细.push(判);

    const 档 = new Map<string, number>(
      item.relevant.map((x) => [x.questionId, x.grade]),
    );
    const 激活轴数 =
      (r.axes.fts.active ? 1 : 0) +
      (r.axes.vector.active ? 1 : 0) +
      (r.axes.kpAuto.active ? 1 : 0);
    const 多轴 = 激活轴数 >= 2;
    if (多轴) 多轴查询数++;

    for (const h of r.hits) {
      const ks = 轴们(h.sources);
      const 相关 = (档.get(h.questionId) ?? 0) > 0;
      for (const k of ks) {
        const st = 轴表[k];
        st.hits++;
        if (ks.length === 1) {
          st.sole++;
          if (相关) {
            st.soleRelevant++;
            if (多轴) st.soleRelevantMultiAxis++;
          }
        }
      }
    }
  }

  const 正样本 = 明细.filter((x) => !x.negative);
  const 负样本 = 明细.filter((x) => x.negative);
  const 平均 = (f: (x: 单条结果) => number): number =>
    正样本.length === 0
      ? 0
      : round4(正样本.reduce((s, x) => s + f(x), 0) / 正样本.length);

  const 表: 总表 = {
    evalSet: "retrieval-eval-20260813.json",
    evalSetVersion: set.version,
    takenAt: new Date().toISOString(),
    overall: {
      queries: 正样本.length,
      ndcg10: 平均((x) => x.ndcg10),
      mrr: 平均((x) => x.rr),
      hitRate: 平均((x) => (x.hit ? 1 : 0)),
      recall10: 平均((x) => x.recall10),
    },
    negatives: {
      queries: 负样本.length,
      falseHits: 负样本.reduce((s, x) => s + x.falseHits, 0),
      dirtyQueries: 负样本.filter((x) => x.falseHits > 0).map((x) => x.id),
    },
    axes: { ...轴表, multiAxisQueries: 多轴查询数 },
    perQuery: Object.fromEntries(
      明细.map((x) => [
        x.id,
        { ndcg10: x.ndcg10, rr: x.rr, hit: x.hit, recall10: x.recall10 },
      ]),
    ),
  };

  return { 表, 明细 };
}

/**
 * 评测集里的每个 questionId 都得在库里。
 * 🔴 用 searchQuestions 全量拉一次（statuses/solutionGrade 全开）而不是裸 SQL：
 *    脚本也走同一个公共面，省得再开一条读库的路。
 */
async function 校验题id(set: 评测集): Promise<void> {
  const 全库 = await searchQuestions(
    {
      statuses: ["pending", "active", "quarantine", "rejected", "retired"],
      solutionGrade: ["calc_verified", "analysis_only", "no_solution"],
      limit: 200,
    },
    { metric: false },
  );
  const 在库 = new Set(全库.hits.map((h) => h.questionId));
  const 坏的: string[] = [];
  for (const q of set.queries) {
    for (const r of q.relevant) {
      if (!在库.has(r.questionId)) 坏的.push(`${q.id} → ${r.questionId}`);
    }
  }
  if (全库.total > 全库.hits.length) {
    throw new Error(
      `校验题 id：库里有 ${全库.total} 题但一次只拉回 ${全库.hits.length} 条（limit 上限 200），` +
        "题量涨过 200 了，本函数得改成分页拉。",
    );
  }
  if (坏的.length > 0) {
    throw new Error(
      `评测集里有 ${坏的.length} 个 questionId 不在库里（写错一个 id = 永远算漏召回，会静默压低基线）：\n  ` +
        坏的.join("\n  "),
    );
  }
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

function 打印(表: 总表, 明细: 单条结果[], 基准: 总表 | null): string {
  const L: string[] = [];
  const bar = "=".repeat(78);
  L.push(bar);
  L.push(`检索评测 · ${表.evalSet}（${表.evalSetVersion}） · ${表.takenAt}`);
  L.push(bar);

  L.push("");
  L.push("逐条明细（* = 负样本，期望零命中）");
  L.push(
    "  " +
      "id".padEnd(5) +
      "NDCG@10".padStart(8) +
      "RR".padStart(7) +
      "召回".padStart(7) +
      "相关".padStart(5) +
      "返回".padStart(5) +
      "  轴          场景",
  );
  for (const d of 明细) {
    const 轴 =
      [
        d.axes.fts ? "字面" : "",
        d.axes.vector ? "语意" : "",
        d.axes.kpAuto ? "考点" : "",
      ]
        .filter(Boolean)
        .join("+") || "纯标签";
    const 标 = d.negative ? "*" : " ";
    L.push(
      "  " +
        (d.id + 标).padEnd(5) +
        (d.negative ? "-" : d.ndcg10.toFixed(4)).padStart(8) +
        (d.negative ? "-" : d.rr.toFixed(3)).padStart(7) +
        (d.negative ? "-" : d.recall10.toFixed(3)).padStart(7) +
        String(d.relevantTotal).padStart(5) +
        String(d.returned.length).padStart(5) +
        "  " +
        轴.padEnd(11) +
        " " +
        d.scenario,
    );
    if (d.negative && d.falseHits > 0) {
      L.push(`        🔴 误命中 ${d.falseHits} 条：${d.returned.join(", ")}`);
    }
    if (d.warnings.length > 0) {
      for (const w of d.warnings) L.push(`        ⚠ ${w}`);
    }
  }

  L.push("");
  L.push("-".repeat(78));
  L.push("分轴归因（sources 聚合；「独占」= 这条命中只有该轴召回）");
  L.push(
    "  " +
      "轴".padEnd(10) +
      "命中".padStart(6) +
      "独占".padStart(6) +
      "独占且相关".padStart(12) +
      "多轴查询内独占且相关".padStart(22),
  );
  const 轴名映射: Record<轴名, string> = {
    fts: "字面 fts",
    vector: "语意 vector",
    kp: "考点 kp",
    sqlOnly: "纯标签 sql",
  };
  for (const k of 轴清单) {
    const s = 表.axes[k];
    L.push(
      "  " +
        轴名映射[k].padEnd(10) +
        String(s.hits).padStart(6) +
        String(s.sole).padStart(6) +
        String(s.soleRelevant).padStart(12) +
        String(s.soleRelevantMultiAxis).padStart(22),
    );
  }
  L.push(
    `  （多轴同时激活的查询：${表.axes.multiAxisQueries} 条；` +
      "🔴 语意轴退出判据看最后一列——纯语意查询里向量当然独占，那不说明任何事)",
  );

  L.push("");
  L.push("-".repeat(78));
  L.push(
    `总表（正样本 ${表.overall.queries} 条）  ` +
      `NDCG@10=${表.overall.ndcg10.toFixed(4)}  ` +
      `MRR=${表.overall.mrr.toFixed(4)}  ` +
      `命中率=${表.overall.hitRate.toFixed(4)}  ` +
      `召回@10=${表.overall.recall10.toFixed(4)}`,
  );
  L.push(
    `负样本 ${表.negatives.queries} 条  误命中=${表.negatives.falseHits}` +
      (表.negatives.dirtyQueries.length > 0
        ? `（${表.negatives.dirtyQueries.join("、")}）`
        : "（干净）"),
  );

  if (基准) {
    L.push("");
    L.push(`与基准比对（基准取于 ${基准.takenAt}，容忍 ${容忍}）`);
    for (const k of 总指标键) {
      const now = 表.overall[k];
      const base = 基准.overall[k];
      const d = round4(now - base);
      const 判 =
        d < -容忍
          ? "🔴 下降超容忍"
          : d < 0
            ? "略降（容忍内）"
            : d > 0
              ? "上升"
              : "持平";
      L.push(
        `  ${k.padEnd(9)} 现值 ${now.toFixed(4)}  基准 ${base.toFixed(4)}  Δ ${d >= 0 ? "+" : ""}${d.toFixed(4)}  ${判}`,
      );
    }
    const dh = 表.negatives.falseHits - 基准.negatives.falseHits;
    L.push(
      `  ${"负样本误命中".padEnd(9)} 现值 ${表.negatives.falseHits}  基准 ${基准.negatives.falseHits}  Δ ${dh >= 0 ? "+" : ""}${dh}  ${dh > 0 ? "🔴 变多" : "OK"}`,
    );
  }
  L.push(bar);
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// REG-D2：最近 N 条真打点重放，验来源标注
// ---------------------------------------------------------------------------

interface 打点行 {
  id: number;
  ts: string;
  value_json: string;
}

/** 打点里回显的 query 摘要 → 可以再跑一次的 SearchParams */
function 参数还原(p: Record<string, unknown>): SearchParams | null {
  const 取数组 = (k: string): string[] | undefined => {
    const v = p[k];
    return Array.isArray(v) && v.length > 0 ? (v as string[]) : undefined;
  };
  const 取串 = (k: string): string | undefined => {
    const v = p[k];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  const out: Record<string, unknown> = {};
  const kpIds = 取数组("kpIds");
  if (kpIds) out.kpIds = kpIds;
  const qtype = 取数组("qtype");
  if (qtype) out.qtype = qtype;
  const grades = 取数组("solutionGrade");
  if (grades) out.solutionGrade = grades;
  const statuses = 取数组("statuses");
  if (statuses) out.statuses = statuses;
  const kw = 取串("keywords");
  if (kw) out.keywords = kw;
  const sq = 取串("semanticQuery");
  if (sq) out.semanticQuery = sq;
  const ed = 取串("editionScope");
  if (ed) out.editionScope = ed;
  if (p.primaryOnly === true) out.primaryOnly = true;
  if (p.kpAutoResolve === true) out.kpAutoResolve = true;
  if (typeof p.limit === "number") out.limit = p.limit;
  const d = p.difficulty;
  if (d && typeof d === "object") out.difficulty = d;
  // 🔴 excludeQuestionIds 还原不了：打点只留了 excludeCount（id 清单不进指标载荷）。
  //    重放因此可能多出几条命中——本关只验「命中带不带 sources」，不比对条数，无碍。
  return Object.keys(out).length > 0 ? out : null;
}

async function 审计来源标注(n: number): Promise<{ ok: boolean; text: string }> {
  const h = await getCoreDb();
  const rows = (
    await h.client.execute({
      sql: `SELECT id, ts, value_json FROM metric_event
             WHERE kind = 'search' ORDER BY id DESC LIMIT ?`,
      args: [n],
    })
  ).rows as unknown as 打点行[];

  const L: string[] = [];
  L.push("=".repeat(78));
  L.push(
    `REG-D2 · 最近 ${rows.length} 条真实检索打点：来源标注 + 语意轴贡献计数`,
  );
  L.push("=".repeat(78));

  if (rows.length === 0) {
    return {
      ok: false,
      text:
        L.join("\n") +
        "\n🔴 一条 kind='search' 打点都没有——检索根本没被用过，或者打点被关掉了。",
    };
  }

  let 红 = 0;
  let 重放条数 = 0;
  let 无sources = 0;
  let 语意贡献合计 = 0;
  let 有语意计数的行 = 0;

  for (const row of rows) {
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(row.value_json) as Record<string, unknown>;
    } catch {
      红++;
      L.push(`  #${row.id} 🔴 value_json 不是合法 JSON`);
      continue;
    }

    // ① 语意轴贡献计数从打点里取得出来（findSimilar 的打点没有 axes，跳过）
    const axes = v.axes as Record<string, { count?: unknown }> | undefined;
    if (axes?.vector) {
      const c = axes.vector.count;
      if (typeof c !== "number") {
        红++;
        L.push(
          `  #${row.id} 🔴 axes.vector.count 不是数字（语意轴贡献计数取不到）`,
        );
        continue;
      }
      语意贡献合计 += c;
      有语意计数的行++;
    }

    // ② 按打点回显的参数重放，断言每条命中都带 sources
    const params = 参数还原((v.params ?? {}) as Record<string, unknown>);
    if (!params) {
      const mode = typeof v.mode === "string" ? v.mode : "?";
      L.push(`  #${row.id} ${row.ts} 跳过（mode=${mode}，无可重放参数）`);
      continue;
    }
    let r: SearchResult;
    try {
      r = await searchQuestions(params, { metric: false });
    } catch (e) {
      红++;
      L.push(
        `  #${row.id} 🔴 重放炸了：${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    重放条数++;
    const 裸 = r.hits.filter((x) => 轴们(x.sources).length === 0);
    无sources += 裸.length;
    if (裸.length > 0) 红++;
    L.push(
      `  #${row.id} ${row.ts}  重放命中 ${r.hits.length} 条，` +
        `带来源 ${r.hits.length - 裸.length} 条${裸.length > 0 ? ` 🔴 裸命中 ${裸.length} 条` : ""}` +
        `　轴：${[r.axes.fts.active ? "字面" : "", r.axes.vector.active ? "语意" : "", r.axes.kpAuto.active ? "考点" : ""].filter(Boolean).join("+") || "纯标签"}` +
        `　vector.count=${r.axes.vector.count}`,
    );
  }

  L.push("-".repeat(78));
  L.push(
    `重放 ${重放条数} 条查询，裸命中（无 sources）${无sources} 条；` +
      `语意轴贡献计数可取的打点 ${有语意计数的行} 条，合计召回 ${语意贡献合计} 次`,
  );
  L.push(
    红 === 0 ? "结论：绿（每条命中都带来源标注）" : `结论：🔴 ${红} 条不合格`,
  );
  L.push("=".repeat(78));
  return { ok: 红 === 0, text: L.join("\n") };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function 读基准(): 总表 | null {
  try {
    return JSON.parse(readFileSync(基准路径, "utf8")) as 总表;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");

  // ── REG-D2 ────────────────────────────────────────────────────────────────
  if (argv.includes("--audit-sources")) {
    const i = argv.indexOf("--n");
    const n = i >= 0 ? Number(argv[i + 1]) : 默认审计条数;
    const r = await 审计来源标注(
      Number.isFinite(n) && n > 0 ? Math.trunc(n) : 默认审计条数,
    );
    process.stdout.write(r.text + "\n");
    await closeCoreDb();
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  const 立基准 = argv.includes("--baseline");
  const { 表, 明细 } = await 跑全量();
  const 基准 = 立基准 ? null : 读基准();

  if (asJson) {
    process.stdout.write(JSON.stringify({ 表, 明细 }, null, 2) + "\n");
  } else {
    process.stdout.write(打印(表, 明细, 基准) + "\n");
  }

  if (立基准) {
    writeFileSync(基准路径, JSON.stringify(表, null, 2) + "\n", "utf8");
    const receipt = await logMetric("eval_baseline", null, 表);
    process.stdout.write(
      `\n基准已落：${基准路径}\n` +
        `metric_event(kind='eval_baseline') id=${receipt.id} 审计 seq=${receipt.seq}\n`,
    );
    await closeCoreDb();
    process.exitCode = 0;
    return;
  }

  if (!基准) {
    process.stdout.write(
      "\n🔴 没有基准文件（tests/fixtures/eval-baseline-20260813.json）——" +
        "先跑一次 `--baseline` 立基准。\n",
    );
    await closeCoreDb();
    process.exitCode = 2;
    return;
  }

  // ── 红/绿判定 ─────────────────────────────────────────────────────────────
  const 跌: { metric: string; now: number; base: number; delta: number }[] = [];
  for (const k of 总指标键) {
    const now = 表.overall[k];
    const base = 基准.overall[k];
    const delta = round4(now - base);
    if (delta < -容忍) 跌.push({ metric: k, now, base, delta });
  }
  const 误命中变多 =
    表.negatives.falseHits > 基准.negatives.falseHits
      ? {
          metric: "negatives.falseHits",
          now: 表.negatives.falseHits,
          base: 基准.negatives.falseHits,
          delta: 表.negatives.falseHits - 基准.negatives.falseHits,
        }
      : null;

  if (跌.length === 0 && !误命中变多) {
    process.stdout.write("\n结论：绿（无指标跌破容忍，负样本没变脏）\n");
    await closeCoreDb();
    process.exitCode = 0;
    return;
  }

  const 全部问题 = [...跌, ...(误命中变多 ? [误命中变多] : [])];
  const receipt = await logMetric("eval_regression_red", null, {
    evalSet: 表.evalSet,
    tolerance: 容忍,
    drops: 全部问题,
    current: { overall: 表.overall, negatives: 表.negatives },
    baseline: { overall: 基准.overall, negatives: 基准.negatives },
  });
  process.stdout.write(
    "\n结论：🔴 检索回归红了\n" +
      全部问题
        .map(
          (d) =>
            `  ${d.metric}：现值 ${d.now} < 基准 ${d.base}（Δ ${d.delta}，容忍 ${容忍}）`,
        )
        .join("\n") +
      `\nmetric_event(kind='eval_regression_red') id=${receipt.id} 审计 seq=${receipt.seq}\n` +
      "🔴 别顺手重立基准把红旗按灭——先弄清是检索改对了还是改坏了。\n",
  );
  await closeCoreDb();
  process.exitCode = 1;
}

void main();
