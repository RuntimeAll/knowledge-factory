/**
 * SKU 登记原语 / 考察模型链 / 出册前置闸（AI:PRD-005 · 005-B）
 *
 * 沿用既有范式：**真库只 SELECT，写行为全在 VACUUM INTO 出来的副本上跑**；
 * 圣域（审核.db）全程只读，用的是真表真行（tasks/batches 都是收卷.py 建的，我们只读）。
 *
 * 钉五件事：
 *   ① SKU 三原语的红绿：装题撞位/撞题/编造题 id 一律**人话**拦下；
 *   ② 🔴 幽灵映射防线：task_id 不存在就拒；登记进去的 task_id 必须**等于给的那个**
 *      （不是 rowid 自增出来的号）——这是 001 疑问附录留下的那条纪律的机器背书；
 *   ③ 模型链 propose → activate 全链，且 activated_at 只在转正时写；
 *   ④ 🔴 联通验证：**未 active 的模型**生成的题会被录题闸② 挡在库外（PROV_MODEL_NOT_ACTIVE），
 *      转正之后同一道题就过得了 —— 「转正 = 批准它的题可以进库」这句话有机器背书；
 *   ⑤ 出册前置闸：撞已售的题要**带出撞了哪本册子**（不是只说撞了某个 id）。
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ModelError,
  SkuError,
  activateModel,
  addSkuItems,
  assertNoSoldDuplicates,
  createCoreDb,
  getModel,
  getSku,
  linkGradingBatch,
  listModels,
  listSkus,
  mapGradingTask,
  proposeModel,
  registerSku,
  registerSkuOutput,
  rejectModel,
  runIngestBatch,
  setSkuStatus,
  type CoreDbHandle,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
let h: CoreDbHandle;
let 沙盒 = "";
/** 副本里真实存在的题（从库里捞，不硬编码 id） */
let 题: { id: string; stem: string }[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

beforeAll(async () => {
  沙盒 = join(tmpdir(), `kf-sku-${process.pid}`);
  rmSync(沙盒, { recursive: true, force: true });
  mkdirSync(沙盒, { recursive: true });

  const p = join(沙盒, "资料库.db");
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  // 资产一起拷（对账 C1(c) 的口径：快照该带着它的资产走）
  const 真资产 = join(process.cwd(), "data", "assets");
  if (existsSync(真资产))
    cpSync(真资产, join(沙盒, "assets"), { recursive: true });

  h = await createCoreDb(fileUrl(p));

  // 🔴 副本里清空 grading_task_map（005-C 之后真库里 30 条天卷全挂上了桥）。
  //    本文件验的是**挂桥原语本身**的红绿，前提是「圣域的 task 还没被登记过」：
  //    ① 「拒 = 零写」那条要数得出表里一行不留；
  //    ② 「真 task 挂得上 / 1 task = 1 天卷 / 1 册 = 1 task」三条要有**两个空闲 task**
  //       才摆得开（挂上 task1 → 再拿 task1 挂别的册子应 TASK_TAKEN → 再拿 task2 挂同一本
  //       册子应 SKU_TAKEN）。真库里已经没有空闲 task 了，清空副本 = 恢复这个前提。
  //    🔴 清的是副本，真库一个字节不动；圣域（审核.db）全程只读，本来就没动过。
  await h.client.execute("UPDATE _write_gate SET allowed=1 WHERE id=1");
  try {
    await h.client.execute("DELETE FROM grading_task_map");
  } finally {
    await h.client.execute("UPDATE _write_gate SET allowed=0 WHERE id=1");
  }

  // 🔴 只挑**没进过任何册子**的题：题[0..2] 后面会被装进单测册子，
  //    题[3] 一直留着当「库存题」的样本（⑤ 那条要断言它的 skus 是空数组）。
  //    005-C 把产线存量接进库并建了册，库里前几道题现在都挂在册子上了 ——
  //    再按 `ORDER BY id LIMIT 5` 硬取，题[3] 就不是库存题了。
  const r = await h.client.execute(
    `SELECT id, stem FROM question q
      WHERE q.status IN ('pending','active')
        AND NOT EXISTS (SELECT 1 FROM sku_item si WHERE si.question_id = q.id)
      ORDER BY q.id LIMIT 5`,
  );
  题 = (r.rows as unknown as { id: string; stem: string }[]).map((x) => ({
    id: String(x.id),
    stem: String(x.stem),
  }));
  expect(
    题.length,
    "库里没有 4 道「没进过任何册子」的题了 —— 本文件的夹具前提要重想",
  ).toBeGreaterThanOrEqual(4);
});

afterAll(() => {
  try {
    h?.close();
    if (沙盒) rmSync(沙盒, { recursive: true, force: true });
  } catch {
    /* Windows 句柄释放晚于 close()，删不掉不算失败 */
  }
});

// ---------------------------------------------------------------------------

describe("① SKU 三原语（建册 / 装题 / 登记产出）", () => {
  it("建册默认 draft（登记≠上架），改态留审计", async () => {
    const s = await registerSku({
      type: "打卡",
      name: "单测·绝对值十天打卡",
      recipeJson: { 天数: 10, 每天: 12 },
      layout: "two_col_spread",
      editionCtx: "人教七上",
      handle: h,
    });
    expect(s.skuId).toMatch(/^sku_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(s.status).toBe("draft");

    const 改 = await setSkuStatus(s.skuId, "active", {
      handle: h,
      note: "开卖",
    });
    expect([改.from, 改.to]).toEqual(["draft", "active"]);

    const card = await getSku(s.skuId, { handle: h });
    expect(card?.status).toBe("active");
    expect(card?.editionCtx).toBe("人教七上");
    expect(card?.counts).toEqual({ items: 0, outputs: 0 });
  });

  it("装题：题存在才装得进去；ord 与 question 撞了都给人话", async () => {
    const s = await registerSku({ type: "卷", name: "单测·装题卷", handle: h });

    const r = await addSkuItems(
      s.skuId,
      [
        { questionId: 题[0]!.id, ord: 1 },
        { questionId: 题[1]!.id, ord: 2 },
      ],
      { handle: h },
    );
    expect(r.total).toBe(2);

    // 🔴 位次被占：报的是「第几位坐着谁」，不是 SQLite 的 UNIQUE 原文
    await expect(
      addSkuItems(s.skuId, [{ questionId: 题[2]!.id, ord: 1 }], { handle: h }),
    ).rejects.toMatchObject({ code: "ORD_TAKEN" });
    await addSkuItems(s.skuId, [{ questionId: 题[2]!.id, ord: 3 }], {
      handle: h,
    }).catch(() => null);

    // 🔴 同一本册里一道题只装一次
    await expect(
      addSkuItems(s.skuId, [{ questionId: 题[0]!.id, ord: 9 }], { handle: h }),
    ).rejects.toMatchObject({ code: "QUESTION_TAKEN" });

    // 🔴 编造的题 id 一律拒（sku_item 不许挂空题位）
    await expect(
      addSkuItems(
        s.skuId,
        [{ questionId: "q_01KZ我编的0000000000000000", ord: 20 }],
        { handle: h },
      ),
    ).rejects.toMatchObject({ code: "QUESTION_NOT_FOUND" });

    // 批内自撞也拦（同一次调用里给了两个一样的 ord）
    await expect(
      addSkuItems(
        s.skuId,
        [
          { questionId: 题[0]!.id, ord: 30 },
          { questionId: 题[1]!.id, ord: 30 },
        ],
        { handle: h },
      ),
    ).rejects.toBeInstanceOf(SkuError);

    const card = await getSku(s.skuId, { handle: h });
    expect(card?.items.map((i) => i.ord)).toEqual([1, 2, 3]);
    expect(card?.items[0]?.stemBrief?.length).toBeGreaterThan(0);
  });

  it("登记产出：内容寻址进资产仓，同 hash 复用不重复占盘", async () => {
    const s = await registerSku({
      type: "专项",
      name: "单测·产出册",
      handle: h,
    });
    const 件 = join(沙盒, "单测题目卷.pdf");
    writeFileSync(件, "%PDF-1.4 单测用的假 PDF\n");

    const o1 = await registerSkuOutput(s.skuId, {
      kind: "pdf_q",
      filePath: 件,
      note: "网盘发的就是这份",
      handle: h,
      assetsDir: join(沙盒, "assets"),
    });
    expect(o1.reused).toBe(false);
    expect(o1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(沙盒, "assets", o1.fileName))).toBe(true);

    // 同一份文件再登记一次（换个角色）：asset 复用同一行，文件不再拷第二份
    const o2 = await registerSkuOutput(s.skuId, {
      kind: "其他",
      filePath: 件,
      handle: h,
      assetsDir: join(沙盒, "assets"),
    });
    expect(o2.reused).toBe(true);
    expect(o2.assetId).toBe(o1.assetId);

    const card = await getSku(s.skuId, { handle: h });
    expect(card?.counts.outputs).toBe(2);
    expect(card?.outputs[0]?.note).toBe("网盘发的就是这份");

    // 文件不在盘上 = 当场拒（别让「还没出件就先登记」蒙混过去）
    await expect(
      registerSkuOutput(s.skuId, {
        kind: "pdf_a",
        filePath: join(沙盒, "根本没有这份.pdf"),
        handle: h,
      }),
    ).rejects.toMatchObject({ code: "FILE_MISSING" });
  });

  it("listSkus 数得出题数/产出数/挂没挂桥", async () => {
    const list = await listSkus({ handle: h, limit: 50 });
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((x) => x.items === 3)).toBe(true);
    expect(list.some((x) => x.outputs === 2)).toBe(true);
  });
});

describe("② 🔴 幽灵映射防线（grading_task_map / grading_batch_link）", () => {
  it("task_id 在圣域查无此行 ⇒ 拒（并把最近几条真任务列出来）", async () => {
    const s = await registerSku({
      type: "卷",
      name: "单测·挂桥卷A",
      handle: h,
    });
    await expect(
      mapGradingTask(999999, s.skuId, { handle: h }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    // 库里一行都不许留下（拒 = 零写）
    const n = await h.client.execute("SELECT COUNT(*) c FROM grading_task_map");
    expect(Number((n.rows[0] as unknown as { c: number }).c)).toBe(0);
  });

  it("真 task 挂得上，且落库的 task_id **等于给的那个**（不是自增号）", async () => {
    const s = await registerSku({
      type: "卷",
      name: "单测·挂桥卷B",
      handle: h,
    });
    await addSkuItems(s.skuId, [{ questionId: 题[0]!.id, ord: 1 }], {
      handle: h,
    });

    const r = await mapGradingTask(1, s.skuId, { handle: h, note: "单测" });
    expect(r.taskId).toBe(1);
    expect(r.task.line).toBeTruthy(); // 圣域真读到了这条任务
    // 🔴 nq 对不上不拦，但照实说（本册只装了 1 题，真任务是 20 题）
    expect(r.nqCheck.ok).toBe(false);
    expect(r.nqCheck.note).toContain("C4(c)");

    const row = await h.client.execute(
      "SELECT task_id, sku_id FROM grading_task_map",
    );
    expect(row.rows.length).toBe(1);
    expect(
      Number((row.rows[0] as unknown as { task_id: number }).task_id),
    ).toBe(1);

    // 1 task = 1 天卷：再拿同一个 task 挂别的册子要被拦
    const s2 = await registerSku({
      type: "卷",
      name: "单测·挂桥卷C",
      handle: h,
    });
    await expect(
      mapGradingTask(1, s2.skuId, { handle: h }),
    ).rejects.toMatchObject({ code: "TASK_TAKEN" });
    // 同一本册子也不能挂两个 task
    await expect(
      mapGradingTask(2, s.skuId, { handle: h }),
    ).rejects.toMatchObject({ code: "SKU_TAKEN" });

    expect((await getSku(s.skuId, { handle: h }))?.taskMap?.taskId).toBe(1);
  });

  it("补录桥同款纪律：batch/task 两端都查只读侧", async () => {
    await expect(
      linkGradingBatch(999999, 1, { handle: h }),
    ).rejects.toMatchObject({ code: "BATCH_NOT_FOUND" });
    await expect(
      linkGradingBatch(3, 999999, { handle: h }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });

    const r = await linkGradingBatch(3, 1, { handle: h, note: "单测补录" });
    expect([r.batchId, r.taskId]).toEqual([3, 1]);
    expect(r.batch.student).toBeTruthy();
    await expect(linkGradingBatch(3, 2, { handle: h })).rejects.toMatchObject({
      code: "BATCH_TAKEN",
    });

    const row = await h.client.execute(
      "SELECT batch_id, task_id FROM grading_batch_link",
    );
    expect(
      Number((row.rows[0] as unknown as { batch_id: number }).batch_id),
    ).toBe(3);
  });
});

describe("③④ 模型链 propose → activate，且与录题闸② 联通", () => {
  /** 一道干净的模型生成题（考点真、题面不撞库、不触发实算闸） */
  const 模型题 = (modelId: string) => ({
    contract: "kb-ingest/v1",
    source: "sku-model.test@1",
    items: [
      {
        seq: 1,
        stem: "已知 |x+7|=12，则 x=________。",
        answer: "x=5 或 x=-19",
        qtype: "填空",
        kps: [{ ref: "已知绝对值求原数" }],
        prov: { type: "model", modelId },
      },
    ],
  });

  it("提议：落 proposed + 开一张 kind='模型转正' 的工单（同一事务）", async () => {
    const r = await proposeModel({
      kpRef: "已知绝对值求原数",
      name: "单测·已知绝对值求原数（一次型）",
      dslRef: "七上绝对值压轴突破/_源/qbank.py#T1_abs_eq",
      stemTemplate: "已知 |x+{a}|={b}，则 x=____。",
      varSpecJson: { a: [1, 20], b: [1, 30] },
      originQids: [题[0]!.id],
      handle: h,
    });
    expect(r.status).toBe("proposed");
    expect(r.kp.kpId).toMatch(/^kp_/);

    const m = await getModel(r.modelId, { handle: h });
    expect(m?.status).toBe("proposed");
    expect(m?.activatedAt).toBeNull();
    expect(m?.openQueueId).toBe(r.queueId);
    expect(m?.originQids).toEqual([题[0]!.id]);

    const q = await h.client.execute({
      sql: "SELECT kind, state, ref_type, ref_id FROM review_queue WHERE id = ?",
      args: [r.queueId],
    });
    expect(q.rows[0]).toMatchObject({
      kind: "模型转正",
      state: "open",
      ref_type: "exam_model",
      ref_id: r.modelId,
    });
  });

  it("🔴 未 active 的模型生成的题 → 录题闸② 直接拦（PROV_MODEL_NOT_ACTIVE）", async () => {
    const p = await proposeModel({
      kpRef: "已知绝对值求原数",
      name: "单测·联通验证模型",
      dslRef: "单测/_源/qbank.py#T_probe",
      handle: h,
    });

    const 前 = await runIngestBatch(模型题(p.modelId), {
      handle: h,
      dryRun: true,
      actor: "agent",
    });
    expect(前.counts.rejected).toBe(1);
    expect(前.gateReport.items[0]!.failure?.code).toBe("PROV_MODEL_NOT_ACTIVE");

    // ── 转正（单事务：模型 active + activated_at + 工单 passed）──────────────
    const v = await activateModel(p.queueId, { by: "单测审的人", handle: h });
    expect([v.from, v.to]).toEqual(["proposed", "active"]);

    const m = await getModel(p.modelId, { handle: h });
    expect(m?.status).toBe("active");
    expect(m?.activatedAt).toBeTruthy();
    expect(m?.openQueueId).toBeNull();
    const q = await h.client.execute({
      sql: "SELECT state, verdict_by FROM review_queue WHERE id = ?",
      args: [p.queueId],
    });
    expect(q.rows[0]).toMatchObject({
      state: "passed",
      verdict_by: "单测审的人",
    });

    // 🔴 同一道题，转正后闸② 放行（这就是「转正=批准它的题可以进库」的机器背书）
    const 后 = await runIngestBatch(模型题(p.modelId), {
      handle: h,
      dryRun: true,
      actor: "agent",
    });
    expect(后.counts.accepted).toBe(1);
    expect(
      后.gateReport.items[0]!.gates.items.find((g) => g.name.includes("来源"))
        ?.result.ok,
    ).toBe(true);

    // 终态不重裁
    await expect(
      activateModel(p.queueId, { by: "另一个人", handle: h }),
    ).rejects.toMatchObject({ code: "QUEUE_ALREADY_DECIDED" });
  });

  it("驳回：模型落 deprecated（不删行）+ 工单 rejected，且必须写理由", async () => {
    const p = await proposeModel({
      kpRef: "已知绝对值求原数",
      name: "单测·会被驳回的模型",
      dslRef: "单测/_源/qbank.py#T_bad",
      handle: h,
    });
    await expect(
      rejectModel(p.queueId, { by: "审的人", note: "  ", handle: h }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const v = await rejectModel(p.queueId, {
      by: "审的人",
      note: "参数空间与已有模型重叠，先合并再提",
      handle: h,
    });
    expect(v.to).toBe("deprecated");
    const m = await getModel(p.modelId, { handle: h });
    expect(m?.status).toBe("deprecated");
    expect(m?.activatedAt).toBeNull(); // 🔴 驳回不碰 activated_at
  });

  it("考点编造/不精确 ⇒ 拒，且错误体里带候选（照着改成真 id 就能自愈）", async () => {
    await expect(
      proposeModel({
        kpRef: "绝对值宇宙无敌考点",
        name: "单测·瞎挂考点",
        dslRef: "x#y",
        handle: h,
      }),
    ).rejects.toBeInstanceOf(ModelError);

    await expect(
      proposeModel({
        kpRef: "kp_01KZ我编的0000000000000000",
        name: "单测·编 id",
        dslRef: "x#y",
        handle: h,
      }),
    ).rejects.toMatchObject({ code: "KP_NOT_FOUND" });

    // originQids 里编一个题 id 也拒（血缘上游必须是真题）
    await expect(
      proposeModel({
        kpRef: "已知绝对值求原数",
        name: "单测·假血缘",
        dslRef: "x#y",
        originQids: ["q_01KZ我编的0000000000000000"],
        handle: h,
      }),
    ).rejects.toMatchObject({ code: "QUESTION_NOT_FOUND" });

    // 🔴 只数**本文件造的**那些：副本里带着 005-C 首铺的 22 个 active 模型，
    //    拿全库计数当断言，等于把「库里有多少存量模型」写死进单测。
    const 活 = (
      await listModels({ status: "active", handle: h, limit: 500 })
    ).filter((m) => m.name.startsWith("单测·"));
    expect(活.length).toBe(1);
  });
});

describe("⑤ 出册前置闸：撞已售要说得出撞了哪本册子", () => {
  it("撞库里的题 ⇒ 不 ok，且带出「哪本册子·第几题·什么态」", async () => {
    // 先把那道题装进一本"已在售"的册子
    const s = await registerSku({
      type: "打卡",
      name: "单测·已售的那本",
      status: "active",
      handle: h,
    });
    await addSkuItems(s.skuId, [{ questionId: 题[0]!.id, ord: 37 }], {
      handle: h,
    });

    const r = await assertNoSoldDuplicates(
      [
        { seq: 1, stem: 题[0]!.stem }, // 逐字同题面 ⇒ 硬撞
        { seq: 2, stem: "单测·这道题库里绝对没有：求 2026 的各位数字之和。" },
      ],
      { handle: h, similar: false },
    );

    expect(r.ok).toBe(false);
    expect(r.checked).toBe(2);
    expect(r.collisions.length).toBe(1);
    const c = r.collisions[0]!;
    expect(c.seq).toBe(1);
    expect(c.hits[0]!.questionId).toBe(题[0]!.id);
    // 🔴 一道题可能同时在好几本册子里（复用是合法生产）——**每一本都要报出来**
    expect(c.hits[0]!.skus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "单测·已售的那本",
          type: "打卡",
          status: "active",
          ord: 37,
        }),
      ]),
    );
    expect(c.hits[0]!.skus.length).toBeGreaterThanOrEqual(2); // 前面那本装题卷也算
  });

  it("撞的是**库存题**（没进过册子）照样报，skus 为空数组", async () => {
    const r = await assertNoSoldDuplicates([{ stem: 题[3]!.stem }], {
      handle: h,
      similar: false,
    });
    expect(r.ok).toBe(false);
    expect(r.collisions[0]!.hits[0]!.skus).toEqual([]);
  });

  it("题面前缀/指令词不影响判定（与管道同一把尺子算 match_key）", async () => {
    // 🔴 管道入库前会剥掉「1．」这类前缀再算键；断言这边少剥一层就会假绿
    const r = await assertNoSoldDuplicates([{ stem: `1．${题[0]!.stem}` }], {
      handle: h,
      similar: false,
    });
    expect(r.ok).toBe(false);
  });

  it("干净的一批 ⇒ ok:true（不因为「查过」就总说有问题）", async () => {
    const r = await assertNoSoldDuplicates(
      [{ stem: "单测·全新题：把 2026 写成两个质数之和的所有写法有几种？" }],
      { handle: h, similar: false },
    );
    expect(r.ok).toBe(true);
    expect(r.collisions).toEqual([]);
    expect(r.degraded).toBe(true); // similar:false 时如实说「语意轴没查」
  });
});
