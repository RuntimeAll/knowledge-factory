/**
 * 前瞻新流程 + 排重红灯 + 变式族谱 —— REG-E1 / E2 / E3（AI:PRD-005 · 005-D）
 *
 * C 组钉的是「一份料投进管道会被怎么判」；本文件钉的是**这条产线流程本身**：
 *
 *   REG-E1  出册干跑：recipe → 选题（searchQuestions）→ 全库排重断言 →
 *           登记 dry-run，全链绿且**库零变化**。
 *   REG-E2  已售题拦截：一份新册料里混进一道**已售天卷的真题**，
 *           出册前置闸必须拦下，且回执要**指名撞了哪本册子第几题**（不是只报一个 qid）。
 *   REG-E3  族谱完整：变式 → 母题的血缘链可达；且全库口径
 *           「模型有生成题就必须有血缘上游」，违者红。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 E3 为什么放**回归清单**、不放对账六项（这条决定要写明，免得下一个人来回搬）
 *
 *   对账 C1~C6 是 `PRD-026/M1-数据模型.md §5「孤儿对账」`的机读镜像，
 *   `core/integrity.ts` 文件头写着「逐条对照实现，**不多不少**」。
 *   往里塞第七项 = 改正本 —— 得先动 M1，那不是 005 这张卡该顺手干的事。
 *
 *   更要紧的是这两件事**性质不同**：
 *     · 对账问的是「数据自不自洽」：引用悬没悬空、向量混没混版、题单数与登记对不对得上。
 *       红了 = 数据坏了，处置是查哪一步写漏了。
 *     · E3 问的是「工艺纪律有没有被遵守」：用一个说不出母题的模型去生成题并入库。
 *       数据是完全自洽的（外键都在、没有悬挂），红了 = **人该去补母题**，
 *       而不是去修数据。
 *   把后者塞进对账，会让「对账见红」这句话的含义变成两种东西的并集，
 *   而红旗条、REG-A1 的退出码、metric_event 的 red 列表全都建立在前一种含义上。
 *
 *   代价（如实记）：对账是每次跑 integrity-check 都会做的体检，回归是收卡/改动才跑。
 *   所以 E3 抓到断链的时机比对账晚。这个代价接受 —— 断链不会让任何结论当场变错。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 三关全部打**真库**且**零写**：
 *    E1/E2 只调 `assertNoSoldDuplicates`（只读）与 `runIngestBatch(dryRun)`；
 *    E3 只 SELECT。每关跑前跑后各数一遍行，断言全等 —— 「没写」得数得出来。
 * 🔴 E1 的夹具（`reg-e1-出册干跑-20260813.json`）是 005-D 用产线 DSL 真出的一卷，
 *    **永不入库**：投过库的料再拿来跑排重必然撞自己，那这一关就永远红。
 *    它哪天真红了，说明库里灌进了同题（或查重的尺子变了）—— 红得有意义，
 *    正确反应是去查那批题，不是回来换夹具。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  assertNoSoldDuplicates,
  convertPunchIngest,
  getCoreDb,
  getLineage,
  matchKeyOfStem,
  runIngestBatch,
  type CoreDbHandle,
} from "~/core";

// ---------------------------------------------------------------------------
// 夹具与常量
// ---------------------------------------------------------------------------

interface 题单行 {
  no: number;
  q: string;
  ans: string;
  anchor: string;
  kp_group: string;
}

const 夹具 = (name: string): 题单行[] =>
  JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", name), "utf8"),
  ) as 题单行[];

const 映射 = (name: string): Record<string, string> => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "dicts", name), "utf8"),
  ) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("_") && typeof v === "string") out[k] = v;
  }
  return out;
};

const E1 = "reg-e1-出册干跑-20260813.json";
const E2 = "reg-e2-已售题拦截-20260813.json";

/** 🔴 E2 的期望归因：夹具第 2 题是从这本已售天卷里逐字取出来的 */
const E2_册 = "群打卡第01期·绝对值压轴突破·day4";
const E2_题号 = 1;

/** 混合运算七考点（名字取自 kp 映射表，id 到库里查——两头都不硬编码） */
const 七码 = ["sign", "abs", "pow", "dist", "fracdec", "order", "paren"];

/** 族谱样例：母题的题面（005-D 的 4 道变式挂在它归纳出的模型下） */
const 母题题面 = "若 |x-3|=5，则 x=________。";
const 母题模型 = "已知绝对值求数";

let h: CoreDbHandle;

/** 一把「有没有写过库」的尺子：几张会被录题动到的表的行数 */
async function 计数(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [
    "question",
    "question_kp",
    "question_tag",
    "question_vec",
    "ingest_batch",
    "quarantine",
    "audit_log",
    "sku_item",
    "asset",
    "exam_model",
  ]) {
    const r = await h.client.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number((r.rows[0] as unknown as { n: number }).n);
  }
  return out;
}

beforeAll(async () => {
  h = await getCoreDb();
});

// ---------------------------------------------------------------------------
// REG-E1 出册干跑
// ---------------------------------------------------------------------------

describe("REG-E1 出册干跑（recipe → 选题 → 全库排重 → 登记 dry-run）", () => {
  it("四步全链绿，且库零变化", async () => {
    const 前 = await 计数();
    const rows = 夹具(E1);
    expect(rows.length).toBe(20);

    // ── ① recipe → 选题：七考点在库里都有存量（选题轴活着）────────────────
    const 名 = 七码.map((c) => 映射("qunjuan-anchor-kp.map.json")[c]!);
    const 占位 = 名.map(() => "?").join(",");
    const kp = (
      await h.client.execute({
        sql: `SELECT id, name FROM kp WHERE name IN (${占位}) AND status='active'`,
        args: 名,
      })
    ).rows as unknown as { id: string; name: string }[];
    expect(kp.length).toBe(7);

    // 🔴 选题这一步走 searchQuestions 的同一条硬过滤（考点 any-of），
    //    这里只断言「这七个考点下确实有可选的题」——具体选哪几道是出卷器的事。
    const 存量 = (
      await h.client.execute({
        sql:
          `SELECT COUNT(DISTINCT question_id) AS n FROM question_kp ` +
          `WHERE kp_id IN (${kp.map(() => "?").join(",")})`,
        args: kp.map((k) => k.id),
      })
    ).rows[0] as unknown as { n: number };
    expect(Number(存量.n)).toBeGreaterThan(0);

    // ── ② 转换：产线题单 → kb-ingest/v1，prov 经 modelMap 升格成 model ─────
    const conv = convertPunchIngest(rows, {
      filePath: `tests/fixtures/${E1}`,
      sourceDoc: { title: "REG-E1 出册干跑夹具", kind: "群卷" },
      qtype: "计算",
      kpMap: 映射("qunjuan-anchor-kp.map.json"),
      modelMap: 映射("qunjuan-anchor-model.map.json"),
      pipelineRef: "REG-E1@夹具重放",
    });
    expect(conv.failed).toEqual([]);
    expect(conv.units.length).toBe(1);
    const payload = conv.units[0]!.payload;
    expect(payload.items.length).toBe(20);
    // 🔴 20 题**全部**带 modelId：漏一条就是 modelMap 没覆盖到某个 anchor
    expect(payload.items.filter((i) => i.prov.type === "model").length).toBe(
      20,
    );
    expect(payload.items.every((i) => (i.prov.modelId ?? "") !== "")).toBe(
      true,
    );
    // pipelineRef 与 modelId 并存（血缘两头都留着）
    expect(payload.items.every((i) => (i.prov.pipelineRef ?? "") !== "")).toBe(
      true,
    );

    // ── ③ 全库排重断言：这卷干净（夹具永不入库，所以它该一直干净）─────────
    const dup = await assertNoSoldDuplicates(
      rows.map((r) => ({ seq: r.no, stem: r.q })),
      { handle: h },
    );
    expect(dup.checked).toBe(20);
    expect(dup.collisions).toEqual([]);
    expect(dup.ok).toBe(true);

    // ── ④ 登记 dry-run：全套闸跑一遍，一道不拒 ────────────────────────────
    const r = await runIngestBatch(payload, {
      actor: "agent",
      dryRun: true,
      handle: h,
      backup: false,
    });
    expect(r.dryRun).toBe(true);
    expect(r.counts.total).toBe(20);
    expect(r.counts.rejected).toBe(0);
    expect(r.counts.accepted).toBe(20);

    expect(await 计数()).toEqual(前);
  });
});

// ---------------------------------------------------------------------------
// REG-E2 已售题拦截
// ---------------------------------------------------------------------------

describe("REG-E2 已售题拦截（撞了要说得出撞的是哪本册子第几题）", () => {
  it("混进一道已售真题 ⇒ 拦下 + 归因到册子 + 零落库", async () => {
    const 前 = await 计数();
    const rows = 夹具(E2);
    expect(rows.length).toBe(3);

    const dup = await assertNoSoldDuplicates(
      rows.map((r) => ({ seq: r.no, stem: r.q })),
      { handle: h },
    );

    expect(dup.ok).toBe(false);
    expect(dup.checked).toBe(3);
    // 🔴 只拦第 2 题：另外两道是干净的，一颗老鼠屎不许把整锅端了当红灯
    expect(dup.collisions.map((c) => c.seq)).toEqual([2]);

    const hit = dup.collisions[0]!.hits[0]!;
    expect(hit.questionId).toMatch(/^q_[0-9A-HJKMNP-TV-Z]{26}$/);
    // 🔴 归因：撞的是**哪本册子的第几题**，不是只报一个 id
    const owner = hit.skus.find((s) => s.name === E2_册);
    expect(owner, `撞单没归因到《${E2_册}》`).toBeTruthy();
    expect(owner!.ord).toBe(E2_题号);
    expect(owner!.type).toBe("卷");
    expect(owner!.status).toBe("active");

    // 语义轴同时也认出它（相似度 1 = 逐字同题）——只报不拦那条口径还在
    const 满分 = dup.similar.find((s) => s.seq === 2 && s.score === 1);
    expect(满分?.questionId).toBe(hit.questionId);

    expect(await 计数()).toEqual(前);
  });

  it("同一道题走 MCP check_duplicate，第二份回执归因一致", async () => {
    // 🔴 走的是 MCP 工具层那个函数本身（`/api/mcp` 的 check_duplicate 调的就是它），
    //    不是 core 的 checkDuplicate —— 验的正是「agent 从 MCP 问一次，
    //    拿到的归因与出册前置闸说的是同一件事」。
    const 前 = await 计数();
    const rows = 夹具(E2);
    const { runCheckDuplicate } = await import("~/app/api/mcp/tools");
    const p = await runCheckDuplicate({ stem: rows[1]!.q });

    expect(p.ok).toBe(true);
    const d = p.ok ? p.data : null;
    expect(d?.collision).toBe(true);
    expect(d?.matchKey).toBe(matchKeyOfStem(rows[1]!.q));
    expect(d?.hits[0]?.skus.some((s) => s.name === E2_册)).toBe(true);
    expect(d?.hits[0]?.skus.find((s) => s.name === E2_册)?.ord).toBe(E2_题号);

    expect(await 计数()).toEqual(前);
  });
});

// ---------------------------------------------------------------------------
// REG-E3 族谱完整
// ---------------------------------------------------------------------------

describe("REG-E3 族谱完整（变式 → 母题可达；模型有生成题就必须有血缘上游）", () => {
  it("E3a 变式 ↔ 母题双向可达（getLineage 两侧都接得上）", async () => {
    const 前 = await 计数();

    const 母 = (
      await h.client.execute({
        sql: "SELECT id FROM question WHERE match_key = ? AND status IN ('pending','active')",
        args: [matchKeyOfStem(母题题面)],
      })
    ).rows[0] as unknown as { id: string } | undefined;
    expect(母, `母题不在库里：${母题题面}`).toBeTruthy();

    // 母题侧：由它归纳出的模型 → 该模型派生的变式
    const 母谱 = await getLineage(母!.id, { handle: h });
    const 模 = 母谱.originOf.find((m) => m.name === 母题模型);
    expect(
      模,
      `母题没有被任何模型认作上游（期望「${母题模型}」）`,
    ).toBeTruthy();
    expect(模!.dslRef, "模型没有 dsl_ref —— 指不回真生成器").toBeTruthy();
    expect(模!.derivedTotal).toBeGreaterThanOrEqual(4);

    // 变式侧：随便挑一道派生题，回链必须指回同一个模型、同一道母题
    const 变 = 模!.derived[0]!;
    const 变谱 = await getLineage(变.questionId, { handle: h });
    expect(变谱.bornOf?.modelId).toBe(模!.modelId);
    expect(变谱.bornOf?.origins.map((o) => o.questionId)).toContain(母!.id);
    // 兄弟里不该有自己
    expect(变谱.bornOf?.siblings.map((s) => s.questionId)).not.toContain(
      变.questionId,
    );
    expect(变谱.bornOf!.siblingTotal).toBe(模!.derivedTotal - 1);

    expect(await 计数()).toEqual(前);
  });

  it("E3b 全库：凡是生成过题的模型，origin_qids_json 都不许为空", async () => {
    const 前 = await 计数();

    // 🔴 「首铺未用的模型」不受这条约束：它还没拿去出题，说不出母题是正常的。
    //    受约束的是**已经在出题**的模型 —— 它出的每一道题都挂着它的 id。
    const 断链 = (
      await h.client.execute(
        `SELECT m.id, m.name,
                (SELECT COUNT(*) FROM question q WHERE q.model_id = m.id) AS n_q
           FROM exam_model m
          WHERE n_q > 0
            AND (m.origin_qids_json IS NULL
                 OR json_array_length(m.origin_qids_json) = 0)
          ORDER BY m.name`,
      )
    ).rows as unknown as { id: string; name: string; n_q: number }[];

    expect(
      断链.map((r) => `${r.name}(${r.id}) 生成了 ${r.n_q} 道题却没有母题`),
      "🔴 有模型在出题却说不出自己照着什么归纳的 —— 补法：scripts/model-origins-*.ts / core 的 setModelOrigins",
    ).toEqual([]);

    // 反向也钉一条：origin 里指的题必须真在库里（指一个死 id 等于没指）
    const 悬空 = (
      await h.client.execute(
        `SELECT m.id, m.name, je.value AS qid
           FROM exam_model m, json_each(m.origin_qids_json) je
          WHERE m.origin_qids_json IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM question q WHERE q.id = je.value)`,
      )
    ).rows as unknown as { name: string; qid: string }[];
    expect(
      悬空.map((r) => `${r.name} 的母题 ${r.qid} 查无此行`),
      "🔴 origin_qids_json 指到了不存在的题",
    ).toEqual([]);

    expect(await 计数()).toEqual(前);
  });
});
