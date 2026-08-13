/**
 * 三路检索闸（AI:PRD-004 · 004-B · core/retrieval.ts + resolve 的 knn-vote 路）
 *
 * 沿用既有范式：**真库只 SELECT，凡是要改数据的用例全在 VACUUM INTO 出来的副本上跑**
 * （searchQuestions 默认还会落一条 metric_event，那也是写——所以只读用例一律 metric:false）。
 *
 * 🔴 测试在精不在多。只钉「这条管线错了会静默出错结论」的那几件事：
 *   ① SQL 硬过滤：组合条件 / 默认排除 no_solution / merged kp 折叠 / excludeIds；
 *   ② FTS 轴：AND 命中、AND 空退 OR 且标 degraded、MATCH 语法字符注入不进来；
 *   ③ 向量轴：findSimilar 自反排除 + 金标近邻（004-A 实测的 |x-3|=5 那组）；
 *   ④ RRF：纯函数手算对拍 + 真查询里 rrfScore 与名次自洽；
 *   ⑤ C3 降级：副本把一行 embed_model_ver 改花 → 语意轴降级 + warnings 说人话；
 *   ⑥ getQuestion 红绿；⑦ knn-vote 红绿；⑧ metric_event 真落 kind='search'。
 *
 * 🔴 ③④⑤⑦ 要真跑模型（models/ 不在 git 里）。没装就整组跳过，
 *    跳过理由里写重建命令 ——「CI 上没模型」与「模型坏了」是两回事。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KNN_CONF_MAX,
  KNN_CONF_MIN,
  RRF_K,
  RetrievalError,
  checkDuplicate,
  createCoreDb,
  createKp,
  embedStatus,
  findSimilarQuestions,
  getQuestion,
  mergeKp,
  newId,
  nowLocalISO,
  resolveKp,
  rrfFuse,
  searchQuestions,
  withCoreWrite,
  type CoreDbHandle,
  type SearchResult,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

const 装了 = embedStatus();
const 跳过理由 = 装了.ok
  ? ""
  : "（模型没装，跳过；重建：powershell -File scripts/fetch-embed-model.ps1）";

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-retr-${process.pid}-${tag}.db`);
  if (existsSync(p)) rmSync(p, { force: true });
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  副本清单.push(p);
  const h = await createCoreDb(fileUrl(p));
  句柄清单.push(h);
  return h;
}

async function 行<T>(
  h: CoreDbHandle,
  sqlText: string,
  args: (string | number)[] = [],
): Promise<T[]> {
  return (await h.client.execute({ sql: sqlText, args }))
    .rows as unknown as T[];
}

/** 按名字查一个真考点的 id（金标不写死 id：id 是 ULID，重灌库就变） */
async function 考点id(h: CoreDbHandle, name: string): Promise<string> {
  const r = await 行<{ id: string }>(h, "SELECT id FROM kp WHERE name = ?", [
    name,
  ]);
  expect(r[0], `库里没有考点「${name}」——金标的前提变了`).toBeTruthy();
  return String(r[0]!.id);
}

/** 按题面前缀查一道真题的 id */
async function 题id(h: CoreDbHandle, 前缀: string): Promise<string> {
  const r = await 行<{ id: string }>(
    h,
    "SELECT id FROM question WHERE stem LIKE ? ORDER BY id LIMIT 1",
    [`${前缀}%`],
  );
  expect(r[0], `库里没有以「${前缀}」开头的题——金标的前提变了`).toBeTruthy();
  return String(r[0]!.id);
}

afterAll(() => {
  for (const h of 句柄清单) h.close();
  // Windows 句柄释放晚于 close()，删不掉不算失败（只是 %TEMP% 里的一次性副本）
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(base + suffix, { force: true });
      } catch {
        /* 随它去 */
      }
    }
  }
});

// ---------------------------------------------------------------------------
// ① SQL 硬过滤
// ---------------------------------------------------------------------------

describe("① SQL 硬过滤：候选集是「能不能要」的问题，答案非黑即白", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("sql");
  });

  it("kp + 题型组合：交集，且每条命中都真挂着那个考点", async () => {
    const kp = await 考点id(h, "绝对值的性质与非负性");

    const 只按考点 = await searchQuestions(
      { kpIds: [kp], limit: 100 },
      { handle: h, metric: false },
    );
    const 加题型 = await searchQuestions(
      { kpIds: [kp], qtype: ["填空"], limit: 100 },
      { handle: h, metric: false },
    );

    expect(只按考点.candidateCount).toBeGreaterThan(0);
    // 加一个条件只会更少，绝不会更多
    expect(加题型.candidateCount).toBeLessThan(只按考点.candidateCount);
    expect(加题型.candidateCount).toBeGreaterThan(0);
    for (const hit of 加题型.hits) {
      expect(hit.qtype).toBe("填空");
      expect(hit.kps.map((k) => k.kpId)).toContain(kp);
    }
    // 零轴 ⇒ 每条都该标 sqlOnly（没有"相关性"可言，别装作有）
    expect(加题型.hits.every((x) => x.sources.sqlOnly === true)).toBe(true);
    expect(加题型.hits.every((x) => x.rrfScore === 0)).toBe(true);
    expect(加题型.axes.fts.active).toBe(false);
    expect(加题型.axes.vector.active).toBe(false);
  });

  it("🔴 默认排除 no_solution（M1 Q11）；显式传才看得见", async () => {
    // 造一道 no_solution 的题（真库里当下一条都没有，不造就等于没测这条）
    const id = newId("q");
    await withCoreWrite(
      { actor: "system", tool: "test-seed", args: { id } },
      async (tx) => {
        await tx.run(
          sql`INSERT INTO question(id, stem, status, solution_grade, prov_type, created_by, created_at)
              VALUES (${id}, '一道连解析都没有的题：随便算点什么。', 'active', 'no_solution', 'manual', 'retrieval-test', ${nowLocalISO()})`,
        );
        return [{ table: "question", id, op: "insert" as const }];
      },
      h,
    );

    const 默认 = await searchQuestions(
      { limit: 200 },
      { handle: h, metric: false },
    );
    expect(默认.hits.map((x) => x.questionId)).not.toContain(id);
    expect(默认.query.solutionGrade).toEqual([
      "calc_verified",
      "analysis_only",
    ]);

    const 显式 = await searchQuestions(
      { solutionGrade: ["no_solution"], limit: 200 },
      { handle: h, metric: false },
    );
    expect(显式.hits.map((x) => x.questionId)).toContain(id);
    expect(显式.hits.every((x) => x.solutionGrade === "no_solution")).toBe(
      true,
    );
  });

  it("🔴 merged 考点自动折叠：用旧壳 id 查，拿到的是落点考点的题", async () => {
    const 真 = await 考点id(h, "绝对值的性质与非负性");
    const 壳 = (
      await createKp({ name: "绝对值非负性(重复录的)" }, { handle: h })
    ).id;
    await mergeKp(壳, 真, { handle: h });

    const 按真 = await searchQuestions(
      { kpIds: [真], limit: 100 },
      { handle: h, metric: false },
    );
    const 按壳 = await searchQuestions(
      { kpIds: [壳], limit: 100 },
      { handle: h, metric: false },
    );

    // 🔴 不折叠的话这里会静默零命中——题早跟着合并挂到新 id 上了
    expect(按壳.query.kpIds).toEqual([真]);
    expect(按壳.query.kpFolded).toEqual([{ from: 壳, to: 真 }]);
    expect(按壳.candidateCount).toBe(按真.candidateCount);
    expect(按壳.hits.map((x) => x.questionId)).toEqual(
      按真.hits.map((x) => x.questionId),
    );
  });

  it("excludeQuestionIds：排掉的那条真不见了，其余顺序不动（组卷排重要用）", async () => {
    const 全 = await searchQuestions(
      { qtype: ["计算"], limit: 100 },
      { handle: h, metric: false },
    );
    expect(全.hits.length).toBeGreaterThan(2);
    const 排掉 = 全.hits[0]!.questionId;

    const 少一条 = await searchQuestions(
      { qtype: ["计算"], excludeQuestionIds: [排掉], limit: 100 },
      { handle: h, metric: false },
    );
    expect(少一条.candidateCount).toBe(全.candidateCount - 1);
    expect(少一条.hits.map((x) => x.questionId)).not.toContain(排掉);
    expect(少一条.query.excludeCount).toBe(1);
    // 稳定序：去掉头一条，剩下的顺序原样
    expect(少一条.hits.map((x) => x.questionId)).toEqual(
      全.hits.slice(1).map((x) => x.questionId),
    );
  });

  it("入参不合法当场拒（难度区间反了）——不许静默当成没传", async () => {
    await expect(
      searchQuestions(
        { difficulty: { min: 4, max: 2 } },
        { handle: h, metric: false },
      ),
    ).rejects.toThrow(RetrievalError);
  });
});

// ---------------------------------------------------------------------------
// ② FTS 轴
// ---------------------------------------------------------------------------

describe("② FTS 轴：字面对得上", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("fts");
  });

  it("AND 命中：单词全中，每条都带 fts 来源与名次", async () => {
    const r = await searchQuestions(
      { keywords: "最小值", limit: 10 },
      { handle: h, metric: false },
    );
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.axes.fts.op).toBe("and");
    expect(r.axes.fts.degraded).toBe(false);
    expect(r.degraded).toBe(false);
    expect(r.axes.fts.tokens).toEqual(["最小值"]);
    r.hits.forEach((hit, i) => {
      expect(hit.sources.fts?.rank).toBe(i + 1);
      expect(hit.sources.sqlOnly).toBeUndefined();
      // 单轴 ⇒ rrfScore 就是 1/(60+rank)
      expect(hit.rrfScore).toBeCloseTo(1 / (RRF_K + i + 1), 6);
    });
  });

  it("🔴 AND 一条不中 → 自动退 OR，且**必须**标 degraded + 写进 warnings", async () => {
    const r = await searchQuestions(
      { keywords: "绝对值 化简", limit: 10 },
      { handle: h, metric: false },
    );
    expect(r.axes.fts.tokens).toEqual(["绝对值", "化简"]);
    expect(r.axes.fts.op).toBe("or");
    expect(r.axes.fts.degraded).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    // 🔴 不标出来的话，用户会以为这就是 AND 的结果，从而对系统精度产生错误印象
    expect(r.warnings.join("\n")).toMatch(/退成 OR/);
  });

  it("🔴 MATCH 语法字符注入不进来：不抛、不炸、也不放全库出来", async () => {
    const 毒 = [
      '绝对值" OR "1"="1',
      "最小值*",
      "(NEAR 最小值)",
      '"',
      "最小值 OR 立方根",
    ];
    const 全库 = (
      await searchQuestions({ limit: 200 }, { handle: h, metric: false })
    ).candidateCount;

    for (const kw of 毒) {
      const r = await searchQuestions(
        { keywords: kw, limit: 200 },
        { handle: h, metric: false },
      );
      // 🔴 关键断言：语法字符被当成普通字符 ⇒ 命中数**远小于**全库，
      //    而不是"引号闭合了一个恒真条件"把整库倒出来
      expect(r.total).toBeLessThan(全库);
      expect(r.candidateCount).toBe(全库); // 硬过滤没被影响
    }
  });
});

// ---------------------------------------------------------------------------
// ③ 向量轴金标
// ---------------------------------------------------------------------------

describe.skipIf(!装了.ok)(`③ 向量轴金标${跳过理由}`, () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("vec");
  });

  it("🔴 findSimilar：自反排除 + 近邻合理（004-A 实测的 |x-3|=5 那组）", async () => {
    const 源 = await 题id(h, "若 |x-3|=5");
    const r = await findSimilarQuestions(源, {
      limit: 5,
      handle: h,
      metric: false,
    });

    // 自反排除：它自己不许出现（否则 top1 恒是自己，白占一个名额）
    expect(r.hits.map((x) => x.questionId)).not.toContain(源);
    expect(r.hits.length).toBe(5);
    expect(r.degraded).toBe(false);
    expect(r.modelVer).toBe("bge-small-zh-v1.5");

    // 分数降序
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1]!.score).toBeGreaterThanOrEqual(r.hits[i]!.score);
    }

    // 🔴 金标：这两道「同一类：已知绝对值求原数」必须排在最前
    //    （只钉序与下限，不钉小数——分数是模型的事，序才是能力的事）
    const 前二 = r.hits.slice(0, 2).map((x) => x.stemBrief);
    expect(前二[0]).toContain("|x+3|=|5-x|");
    expect(前二[1]).toContain("|5-x|=|-6|");
    expect(r.hits[0]!.score).toBeGreaterThan(0.9);
    expect(r.hits[1]!.score).toBeGreaterThan(0.85);
    expect(r.hits[0]!.kps[0]?.name).toBe("已知绝对值求原数");
  });

  it("findSimilar 查无此题 → QUESTION_NOT_FOUND，不是空结果", async () => {
    const e = await findSimilarQuestions(newId("q"), {
      handle: h,
      metric: false,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RetrievalError);
    expect((e as RetrievalError).code).toBe("QUESTION_NOT_FOUND");
  });

  it("checkDuplicate：match_key 硬撞 + 语义近邻，两层分开给（不合成一个分数）", async () => {
    const 源 = await 题id(h, "若 |x-3|=5");
    const 原文 = (
      await 行<{ stem: string }>(h, "SELECT stem FROM question WHERE id = ?", [
        源,
      ])
    )[0]!.stem;

    const d = await checkDuplicate(原文, { handle: h, limit: 3 });
    expect(d.matchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(d.exact.map((x) => x.questionId)).toEqual([源]);
    expect(d.similar[0]!.questionId).toBe(源);
    expect(d.similar[0]!.score).toBeCloseTo(1, 2);
    expect(d.similar.length).toBe(3);

    // 库里没有的题面：硬撞为空，但语义近邻照给（"像"和"是同一道"是两回事）
    const 新 = await checkDuplicate("若 |x-11|=17，则 x=________。", {
      handle: h,
      limit: 3,
    });
    expect(新.exact).toEqual([]);
    expect(新.similar.length).toBe(3);
    expect(新.similar[0]!.score).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------------------
// ④ RRF
// ---------------------------------------------------------------------------

describe("④ RRF k=60：融合序可手算复现", () => {
  it("🔴 手算对拍：两轴各自 top1 不同时，「两轴都靠前」胜出", () => {
    // A：FTS 第 1、向量第 3    B：FTS 第 2、向量第 1    C：只在向量第 2
    const fused = rrfFuse({
      fts: [
        { questionId: "q_A", rank: 1, score: -3.5 },
        { questionId: "q_B", rank: 2, score: -2.1 },
      ],
      vector: [
        { questionId: "q_B", rank: 1, score: 0.71 },
        { questionId: "q_C", rank: 2, score: 0.66 },
        { questionId: "q_A", rank: 3, score: 0.6 },
      ],
    });

    const A = 1 / 61 + 1 / 63; // 0.0322659…
    const B = 1 / 62 + 1 / 61; // 0.0325224…
    const C = 1 / 62; // 0.0161290…
    expect(B).toBeGreaterThan(A); // ← 这条不成立的话 k=60 就白选了

    expect(fused.map((x) => x.questionId)).toEqual(["q_B", "q_A", "q_C"]);
    expect(fused[0]!.rrfScore).toBeCloseTo(B, 6);
    expect(fused[1]!.rrfScore).toBeCloseTo(A, 6);
    expect(fused[2]!.rrfScore).toBeCloseTo(C, 6);

    // 来源标注：两轴都命中的要两格都有，只命中一轴的只有一格
    expect(fused[0]!.sources).toEqual({
      fts: { rank: 2, score: -2.1 },
      vector: { rank: 1, score: 0.71 },
    });
    expect(fused[2]!.sources).toEqual({ vector: { rank: 2, score: 0.66 } });
    expect(fused[2]!.sources.fts).toBeUndefined();
  });

  it("同分按 questionId 升序 —— 排序确定，金标才立得住", () => {
    const fused = rrfFuse({
      fts: [
        { questionId: "q_zzz", rank: 1, score: -1 },
        { questionId: "q_aaa", rank: 1, score: -1 },
      ],
    });
    expect(fused.map((x) => x.questionId)).toEqual(["q_aaa", "q_zzz"]);
  });
});

describe.skipIf(!装了.ok)(`④b RRF 真查询：分数与名次自洽${跳过理由}`, () => {
  let h: CoreDbHandle;
  let r: SearchResult;

  beforeAll(async () => {
    h = await 造副本("rrf");
    r = await searchQuestions(
      {
        keywords: "绝对值",
        semanticQuery: "含字母的绝对值怎么分类讨论正负",
        limit: 6,
      },
      { handle: h, metric: false },
    );
  });

  it("两轴都激活，命中带来源标注，rrfScore = Σ 1/(60+rank) 可复算", () => {
    expect(r.axes.fts.active).toBe(true);
    expect(r.axes.vector.active).toBe(true);
    expect(r.axes.vector.modelVer).toBe("bge-small-zh-v1.5");
    expect(r.hits.length).toBe(6);

    for (const hit of r.hits) {
      const 应有 =
        (hit.sources.fts ? 1 / (RRF_K + hit.sources.fts.rank) : 0) +
        (hit.sources.vector ? 1 / (RRF_K + hit.sources.vector.rank) : 0);
      expect(hit.rrfScore).toBeCloseTo(应有, 6);
      // 至少有一条轴说得出话（零轴那条路走的是 sqlOnly，不该出现在这儿）
      expect(hit.sources.fts ?? hit.sources.vector).toBeTruthy();
      expect(hit.sources.sqlOnly).toBeUndefined();
    }

    // 融合序 = rrfScore 降序
    for (let i = 1; i < r.hits.length; i++) {
      expect(r.hits[i - 1]!.rrfScore).toBeGreaterThanOrEqual(
        r.hits[i]!.rrfScore,
      );
    }
    // 🔴 两轴都命中的那几条必须排在只命中一轴的前面（RRF 存在的全部理由）
    const 双轴 = r.hits.filter((x) => x.sources.fts && x.sources.vector).length;
    expect(双轴).toBeGreaterThan(0);
    expect(
      r.hits.slice(0, 双轴).every((x) => x.sources.fts && x.sources.vector),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑤ C3 降级
// ---------------------------------------------------------------------------

describe.skipIf(!装了.ok)(`⑤ C3 混版 → 语意轴降级${跳过理由}`, () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("c3");
    // 🔴 把一行的向量版本改花（question_vec 有防裸写触发器 ⇒ 必须开闸走 core 写）
    const 谁 = (
      await 行<{ question_id: string }>(
        h,
        "SELECT question_id FROM question_vec ORDER BY question_id LIMIT 1",
      )
    )[0]!.question_id;
    await withCoreWrite(
      { actor: "system", tool: "test-c3", args: { 谁 } },
      async (tx) => {
        await tx.run(
          sql`UPDATE question_vec SET embed_model_ver = 'bge-base-zh-v1.5' WHERE question_id = ${谁}`,
        );
        return [
          { table: "question_vec", id: String(谁), op: "update" as const },
        ];
      },
      h,
    );
  });

  it("🔴 语意轴自动关掉、FTS 照常出结果，且 warnings 里说清楚为什么", async () => {
    const r = await searchQuestions(
      { keywords: "最小值", semanticQuery: "求最小值的题", limit: 5 },
      { handle: h, metric: false },
    );

    expect(r.axes.vector.active).toBe(false);
    expect(r.axes.vector.modelVer).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.warnings.join("\n")).toContain("语意轴已降级");
    expect(r.warnings.join("\n")).toContain("C3");

    // 🔴 降级不是报错：FTS 那条轴照常干活，结果照常可用
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((x) => x.sources.fts && !x.sources.vector)).toBe(true);
  });

  it("findSimilar 撞上混版：不抛，回空 hits + degraded + 人话", async () => {
    const 源 = await 题id(h, "若 |x-3|=5");
    const r = await findSimilarQuestions(源, {
      limit: 3,
      handle: h,
      metric: false,
    });
    expect(r.degraded).toBe(true);
    expect(r.hits).toEqual([]);
    expect(r.warnings.join("\n")).toContain("语意轴已降级");
  });

  it("knn-vote 跟着自动关（C3 不绿就别投票）", async () => {
    const r = await resolveKp("绝对值里含参数怎么讨论", {
      handle: h,
      enqueue: false,
    });
    expect(r.knn.ran).toBe(false);
    expect(r.knn.skipped).toContain("语意轴已降级");
    expect(r.warnings.join("\n")).toContain("近邻投票没跑");
  });
});

// ---------------------------------------------------------------------------
// ⑥ getQuestion
// ---------------------------------------------------------------------------

describe("⑥ getQuestion：全量卡片 / 查无此题要指路", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("card");
  });

  it("绿：正本三段 + 考点(带主标) + 标签 + provenance 细节 + 批次", async () => {
    const id = await 题id(h, "若 |x-3|=5");
    const card = await getQuestion(id, { handle: h });

    expect(card.id).toBe(id);
    expect(card.stem).toContain("|x-3|=5");
    expect(card.qtype).toBe("填空");
    expect(card.solutionGrade).toBe("analysis_only");
    expect(card.status).toBe("pending");

    // 主考点恰一个，且排在最前
    const 主 = card.kps.filter((k) => k.isPrimary);
    expect(主.length).toBe(1);
    expect(card.kps[0]!.isPrimary).toBe(true);
    expect(主[0]!.name).toBe("已知绝对值求原数");

    expect(card.tags.length).toBeGreaterThan(0);
    // pipeline 型 ⇒ pipelineRef 必有；管道来料 ⇒ 批次挂得上
    expect(card.provenance.type).toBe("pipeline");
    expect(card.provenance.pipelineRef).toBeTruthy();
    expect(card.provenance.batch?.contractVer).toBe("kb-ingest/v1");
    expect(card.hasVector).toBe(true);
  });

  it("🔴 红：编造的 id → QUESTION_NOT_FOUND，且 message 指路 search_questions", async () => {
    const 假 = newId("q");
    const e = await getQuestion(假, { handle: h }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RetrievalError);
    const err = e as RetrievalError;
    expect(err.code).toBe("QUESTION_NOT_FOUND");
    expect(err.message).toContain(假);
    // 🔴 给不出候选就如实给不出，但必须写清楚下一步调什么
    expect(err.candidates).toEqual([]);
    expect(err.message).toContain("search_questions");
  });
});

// ---------------------------------------------------------------------------
// ⑦ knn-vote
// ---------------------------------------------------------------------------

describe.skipIf(!装了.ok)(`⑦ resolve_kp 第五路 knn-vote${跳过理由}`, () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("knn");
  });

  it("🔴 绿：词表里完全没有的自然语句，靠已打标近邻题投出合理候选", async () => {
    // 这句话词表里没有、也没有这条别名 —— 四路必然空手
    const r = await resolveKp("怎么把含字母的绝对值拆开讨论正负", {
      handle: h,
      enqueue: false,
    });

    expect(r.knn.ran).toBe(true);
    expect(r.knn.supportQuestions).toBeGreaterThan(0);
    expect(r.candidates.length).toBeGreaterThan(0);

    const top = r.candidates[0]!;
    expect(top.matchedVia).toBe("knn-vote");
    // 🔴 封顶：旁证再一致也够不着"确定"
    expect(top.confidence).toBeGreaterThanOrEqual(KNN_CONF_MIN);
    expect(top.confidence).toBeLessThanOrEqual(KNN_CONF_MAX);
    // 🔴 aliasHit 留空（这一路压根没经过任何别名，填什么都是编的）
    expect(top.aliasHit).toBeUndefined();
    expect(top.evidence?.supportQuestions).toBeGreaterThan(0);
    expect(top.evidence?.sampleQuestionIds.length).toBeGreaterThan(0);
    // 候选本身是真考点（不是投票投出来的幻觉）
    expect(["draft", "active"]).toContain(top.status);
    expect(
      (
        await 行<{ c: number }>(h, "SELECT COUNT(*) c FROM kp WHERE id = ?", [
          top.kpId,
        ])
      )[0]!.c,
    ).toBe(1);

    // 🔴 lowConfidence 不被旁证按灭：这条队列是「词表的缺口清单」
    expect(r.lowConfidence).toBe(true);
  });

  it("🔴 四路命中时 knn 完全不跑（省掉载模型的 0.5s）", async () => {
    const r = await resolveKp("绝对值", { handle: h, enqueue: false });
    expect(r.lowConfidence).toBe(false);
    expect(r.knn.ran).toBe(false);
    expect(r.knn.skipped).toContain("四路");
    expect(r.candidates.every((c) => c.matchedVia !== "knn-vote")).toBe(true);
  });

  it("🔴 红：库外的词投不出东西来（余弦下限拦住「硬凑几个最像的」）", async () => {
    // 高数词，本库（初中数学）里语义上离得很远
    const r = await resolveKp("洛必达法则", { handle: h, enqueue: false });
    expect(r.knn.ran).toBe(true);
    expect(r.knn.supportQuestions).toBe(0);
    expect(r.candidates).toEqual([]);
    expect(r.lowConfidence).toBe(true);
  });

  it("knn:false 显式关掉", async () => {
    const r = await resolveKp("怎么把含字母的绝对值拆开讨论正负", {
      handle: h,
      enqueue: false,
      knn: false,
    });
    expect(r.knn.ran).toBe(false);
    expect(r.knn.skipped).toContain("knn:false");
    expect(r.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 打点
// ---------------------------------------------------------------------------

describe("⑧ metric_event：每次检索都留痕（004-D 评测集的原料）", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("metric");
  });

  it("🔴 落一条 kind='search'，参数与各轴命中数都记在 value_json 里", async () => {
    const 前 = (
      await 行<{ c: number }>(
        h,
        "SELECT COUNT(*) c FROM metric_event WHERE kind = 'search'",
      )
    )[0]!.c;

    const r = await searchQuestions(
      { keywords: "最小值", qtype: ["填空"], limit: 3 },
      { handle: h },
    );

    const rows = await 行<{ value_json: string }>(
      h,
      "SELECT value_json FROM metric_event WHERE kind = 'search' ORDER BY id DESC LIMIT 1",
    );
    expect(
      (
        await 行<{ c: number }>(
          h,
          "SELECT COUNT(*) c FROM metric_event WHERE kind = 'search'",
        )
      )[0]!.c,
    ).toBe(前 + 1);

    const v = JSON.parse(rows[0]!.value_json) as {
      params: { keywords: string; qtype: string[]; limit: number };
      total: number;
      returned: number;
      axes: { fts: { active: boolean; count: number; op: string } };
      degraded: boolean;
    };
    expect(v.params.keywords).toBe("最小值");
    expect(v.params.qtype).toEqual(["填空"]);
    expect(v.total).toBe(r.total);
    expect(v.returned).toBe(r.hits.length);
    expect(v.axes.fts.active).toBe(true);
    expect(v.axes.fts.op).toBe("and");
    expect(v.degraded).toBe(false);
  });

  it("metric:false 时一条都不落（页面预览/脚本用的纯读口）", async () => {
    const 前 = (
      await 行<{ c: number }>(
        h,
        "SELECT COUNT(*) c FROM metric_event WHERE kind = 'search'",
      )
    )[0]!.c;
    await searchQuestions({ keywords: "立方根" }, { handle: h, metric: false });
    expect(
      (
        await 行<{ c: number }>(
          h,
          "SELECT COUNT(*) c FROM metric_event WHERE kind = 'search'",
        )
      )[0]!.c,
    ).toBe(前);
  });
});
