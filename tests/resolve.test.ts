/**
 * 考点解析闸（AI:PRD-002 · 002-C）
 *
 * 沿用既有范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**
 * （audit_log 是 append-only，往真库插一行就再也拿不出来）。
 *
 * 测试在精不在多，只钉六件必须永远成立的事：
 *   ① 四路命中与打分次序：exact-name / exact-alias / prefix / trigram
 *      —— 精确压前缀、前缀压模糊，同名 alias 交叉时两个考点都当候选（不武断）；
 *   ② 编造的 kp_id 两形态：可读文本 → 带候选；纯 ULID 形状 → 空候选 + 引导文案；
 *   ③ 低置信入队列，同 query 不重复开工单；
 *   ④ 🔴 MATCH 注入：query 里塞 `"` `*` `(` `OR` 不报错、也拼不出语法（不多召回一条）；
 *   ⑤ kp_fts 触发器：加别名 / 改名 / 合并 / 退役后词条同步（merged 壳词条消失）；
 *   ⑥ C2 扩面：err_code_map / kp_edge / exam_model 指向 merged 考点 → 对账红。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KpNotFoundError,
  addKpAlias,
  createCoreDb,
  createKp,
  integrityCheck,
  kpContext,
  mergeKp,
  newId,
  nowLocalISO,
  readWriteGate,
  removeKpAlias,
  renameKp,
  resolveKp,
  retireKp,
  rowRefId,
  verifyAuditChain,
  withCoreWrite,
  type CoreDbHandle,
  type RowRef,
} from "~/core";
import { errCodeMap, errorCause, examModel, kpEdge } from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
/**
 * 🔴 副本的资产仓指回**真库的** data/assets：VACUUM INTO 只搬库不搬图，
 *    不指过去的话 C1(c)「有登记行找不到文件」会当场假红（003-E 起真库有资产行了）。
 *    这里只读目录清单，不写一个字节。
 */
const 真资产目录 = join(process.cwd(), "data", "assets");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 每个 describe 一份一次性副本（tag 唯一） */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-resolve-${process.pid}-${tag}.db`);
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

beforeAll(() => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  // Windows 句柄释放晚于 close()，删不掉不算失败（只是 %TEMP% 里的一次性副本）
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      try {
        if (existsSync(p)) rmSync(p, { force: true });
      } catch {
        /* 随它去 */
      }
    }
  }
});

async function 行<T>(h: CoreDbHandle, sql: string): Promise<T[]> {
  const r = await h.client.execute(sql);
  return r.rows as unknown as T[];
}

async function 计数(h: CoreDbHandle, table: string, where = "1=1") {
  const rows = await 行<{ c: number }>(
    h,
    `SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`,
  );
  return Number(rows[0]?.c ?? 0);
}

/** 词表里这个考点的词条（kind + term） */
async function 词条(h: CoreDbHandle, kpId: string) {
  return 行<{ kind: string; term: string }>(
    h,
    `SELECT kind, term FROM kp_fts WHERE kp_id='${kpId}' ORDER BY kind, term`,
  );
}

// ---------------------------------------------------------------------------
// ① 四路命中与打分
// ---------------------------------------------------------------------------

describe("① 四路命中：exact-name / exact-alias / prefix / trigram", () => {
  let h: CoreDbHandle;
  /** 绝对值 / 绝对值的化简与压轴 / 有理数加减法则 / 一个 merged 壳 */
  let 绝对值 = "";
  let 压轴 = "";
  let 有理数 = "";
  let 壳 = "";

  beforeAll(async () => {
    h = await 造副本("hit");
    绝对值 = (await createKp({ name: "绝对值" }, { handle: h })).id;
    压轴 = (await createKp({ name: "绝对值的化简与压轴" }, { handle: h })).id;
    有理数 = (await createKp({ name: "有理数加减法则" }, { handle: h })).id;

    // 🔴 同名别名交叉：'取绝对值' 同时指向两个考点 —— resolve 该给两个候选，不武断
    await addKpAlias(绝对值, "取绝对值", { handle: h });
    await addKpAlias(压轴, "取绝对值", { handle: h });

    // merged 壳：旧名字要能问出落点
    壳 = (await createKp({ name: "绝对值(重复录的)" }, { handle: h })).id;
    await mergeKp(壳, 绝对值, { handle: h });
  });

  it("exact-name = 1.0 且排第一；同一 query 的模糊命中排在后面", async () => {
    // 🔴 limit 放大：002 导底后真库里带「绝对值」的考点有十几个，默认 8 条会把本例
    //    新建的长考点挤出候选。本例钉的是**排序口径**（精确压模糊），不是「前 8 名有谁」。
    const r = await resolveKp("绝对值", { handle: h, limit: 100 });
    expect(r.query).toBe("绝对值");
    expect(r.lowConfidence).toBe(false);

    const top = r.candidates[0]!;
    expect(top.kpId).toBe(绝对值);
    expect(top.confidence).toBe(1);
    expect(top.matchedVia).toBe("exact-name");

    // 「绝对值的化简与压轴」也该在候选里（子串命中），但分数明确更低
    const 次 = r.candidates.find((c) => c.kpId === 压轴);
    expect(次, "子串命中的长考点该在候选里").toBeDefined();
    expect(次!.confidence).toBeLessThan(top.confidence);
    // 🔴 排序：分数降序
    const 分数 = r.candidates.map((c) => c.confidence);
    expect([...分数].sort((a, b) => b - a)).toEqual(分数);
  });

  it("exact-alias = 1.0，同名别名交叉时两个考点都是候选（不武断挑一个）", async () => {
    const r = await resolveKp("取绝对值", { handle: h });
    const 命中 = r.candidates.filter((c) => c.confidence === 1);
    expect(命中.map((c) => c.kpId).sort()).toEqual([绝对值, 压轴].sort());
    for (const c of 命中) {
      expect(c.matchedVia).toBe("exact-alias");
      expect(c.aliasHit).toBe("取绝对值");
    }
    expect(r.lowConfidence).toBe(false);
  });

  it("prefix ∈ [0.85, 0.95]，压得过同一条的模糊分", async () => {
    const r = await resolveKp("有理数加", { handle: h });
    const c = r.candidates.find((x) => x.kpId === 有理数)!;
    expect(c.matchedVia).toBe("prefix");
    expect(c.confidence).toBeGreaterThanOrEqual(0.85);
    expect(c.confidence).toBeLessThanOrEqual(0.95);
  });

  it("trigram 子串 ∈ [0.3, 0.8]（前缀够不着的中段命中）", async () => {
    const r = await resolveKp("化简与压轴", { handle: h });
    const c = r.candidates.find((x) => x.kpId === 压轴)!;
    expect(c.matchedVia).toBe("trigram");
    expect(c.confidence).toBeGreaterThanOrEqual(0.3);
    expect(c.confidence).toBeLessThanOrEqual(0.8);
  });

  it("🔴 query < 3 字：trigram 恒空，退 LIKE 前缀/包含路照样有候选", async () => {
    const r = await resolveKp("加减", { handle: h, enqueue: false });
    expect(r.candidates.map((c) => c.kpId)).toContain(有理数);
  });

  it("🔴 命中 merged 壳 → 落到活跃考点并标 resolvedFrom（旧名照样问得出落点）", async () => {
    const r = await resolveKp("绝对值(重复录的)", { handle: h });
    const c = r.candidates[0]!;
    expect(c.kpId).toBe(绝对值);
    expect(c.status).toBe("active");
    expect(c.resolvedFrom?.id).toBe(壳);
    expect(c.resolvedFrom?.hops).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("kp_context：卡片包 + 教材落点 + 反查链；传 merged 壳自动追链", async () => {
    const card = await kpContext(绝对值, { handle: h });
    expect(card.kp.id).toBe(绝对值);
    expect(card.aliases).toContain("取绝对值");
    expect(card.mergedFrom?.map((m) => m.id)).toEqual([壳]);
    expect(card.counts.questions).toBe(0);
    expect(card.resolvedThrough).toBeUndefined();

    const 经壳 = await kpContext(壳, { handle: h });
    expect(经壳.kp.id).toBe(绝对值);
    expect(经壳.resolvedThrough?.originalId).toBe(壳);
    expect(经壳.resolvedThrough?.hops).toBe(1);
  });

  it("闸静息、审计链接得上（读侧那笔入队列也没把闸留开）", async () => {
    expect(await readWriteGate(h)).toBe(0);
    const chain = await verifyAuditChain(h);
    expect(chain.ok, chain.reason).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ② 编造的 kp_id
// ---------------------------------------------------------------------------

describe("② 编造 kp_id：带得出候选就带，带不出也要指路", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("fake-id");
    await createKp({ name: "绝对值的化简与压轴" }, { handle: h });
  });

  it("kp_绝对值压轴（可读文本）→ KP_NOT_FOUND 且 candidates 非空", async () => {
    const e = await kpContext("kp_绝对值压轴", { handle: h }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(KpNotFoundError);
    const err = e as KpNotFoundError;
    expect(err.code).toBe("KP_NOT_FOUND");
    expect(err.candidates.length).toBeGreaterThan(0);
    expect(err.message).toContain("绝对值压轴"); // 从 id 里读出来的词要写在脸上
    expect(err.message).toContain(err.candidates[0]!.kpId);
  });

  it("kp_<ULID 形状但库里没有> → candidates 空 + 引导用 resolve_kp", async () => {
    const 假 = newId("kp"); // 真 ULID 形状，只是没这行
    const e = await kpContext(假, { handle: h }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KpNotFoundError);
    const err = e as KpNotFoundError;
    expect(err.candidates).toEqual([]);
    expect(err.message).toContain("resolve_kp");
  });

  it("找不到人也不许悄悄开工单（兜底那一查 enqueue:false）", async () => {
    // 🔴 只数本组关心的那一类：003-E 之后真库里本来就有别的类别的工单（图审等），
    //    副本自然也带着它们 —— 数总数会把别人的工单算到本组头上。
    expect(await 计数(h, "review_queue", "kind = 'kp低置信'")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 低置信入队列
// ---------------------------------------------------------------------------

describe("③ 低置信 → review_queue，同 query 不重复开", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("queue");
    await createKp({ name: "有理数加减法则" }, { handle: h });
  });

  // 🔴 挑「初中数学 KG 里绝不可能有」的高数词做查询：002 导底后真库有 415 个考点，
  //    原来用的「完全平方公式」已经能模糊命中（`通过对完全平方公式变形求值` conf=0.665），
  //    本组要造的是**零候选**那一路，词得选在词表覆盖面之外。
  const 词表外 = "洛必达法则";

  it("查一个词表里没有的说法 → 开一张 kp低置信 工单", async () => {
    const r = await resolveKp(词表外, { handle: h });
    expect(r.candidates).toEqual([]);
    expect(r.lowConfidence).toBe(true);
    expect(r.queued?.created).toBe(true);

    const rows = await 行<{
      id: string;
      kind: string;
      state: string;
      payload_json: string;
      reason: string;
    }>(
      h,
      // 🔴 只取本组这一类（副本里带着真库既有的其它工单）
      "SELECT id, kind, state, payload_json, reason FROM review_queue WHERE kind = 'kp低置信' ORDER BY id",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("kp低置信");
    expect(rows[0]!.state).toBe("open");
    expect(rows[0]!.id).toBe(r.queued!.id);
    const payload = JSON.parse(rows[0]!.payload_json) as { query: string };
    expect(payload.query).toBe(词表外);
    expect(rows[0]!.reason).toContain(词表外);
  });

  it("🔴 再查同一个词 → 不重复入队（未决工单去重）", async () => {
    const r = await resolveKp(词表外, { handle: h });
    expect(r.queued?.created).toBe(false);
    expect(await 计数(h, "review_queue", "kind = 'kp低置信'")).toBe(1);
  });

  it("换个词 → 另开一张（去重只按 query，不是一刀切）", async () => {
    const r = await resolveKp("十字相乘", { handle: h });
    expect(r.queued?.created).toBe(true);
    expect(await 计数(h, "review_queue", "kind = 'kp低置信'")).toBe(2);
  });

  it("入队列那笔走的是 core 写路径：闸静息 + 审计链接得上 + C1 覆盖不漏", async () => {
    expect(await readWriteGate(h)).toBe(0);
    const chain = await verifyAuditChain(h);
    expect(chain.ok, chain.reason).toBe(true);
    const report = await integrityCheck({
      handle: h,
      metric: false,
      assetsDir: 真资产目录,
    });
    const c1 = report.checks.find((c) => c.id === "C1")!;
    expect(c1.stats?.a_无审计覆盖行, c1.details.join("\n")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ④ MATCH 注入
// ---------------------------------------------------------------------------

describe("④ FTS MATCH 注入：语法字符只能当普通字符", () => {
  let h: CoreDbHandle;
  let 有理数 = "";

  beforeAll(async () => {
    h = await 造副本("inject");
    await createKp({ name: "绝对值的化简" }, { handle: h });
    有理数 = (await createKp({ name: "有理数加减法则" }, { handle: h })).id;
  });

  it('query 含 " * ( : OR NEAR 一律不报错', async () => {
    for (const bad of [
      '绝对值"',
      "绝对值*",
      "绝对值 (化简)",
      "绝对值 NEAR 化简",
      'term:"绝对值"',
      "绝对值^2",
      "*",
    ]) {
      const r = await resolveKp(bad, { handle: h, enqueue: false });
      expect(Array.isArray(r.candidates), `query=${bad}`).toBe(true);
    }
  });

  it('🔴 拼不出 OR：`绝对值" OR "有理数` 召不回「有理数加减法则」', async () => {
    const r = await resolveKp('绝对值" OR "有理数', {
      handle: h,
      enqueue: false,
    });
    expect(r.candidates.map((c) => c.kpId)).not.toContain(有理数);
  });

  it("闸静息（注入没把库写坏，也没开着闸）", async () => {
    expect(await readWriteGate(h)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ⑤ kp_fts 触发器
// ---------------------------------------------------------------------------

describe("⑤ kp_fts 同步触发器：词表跟着正表走", () => {
  let h: CoreDbHandle;

  beforeAll(async () => {
    h = await 造副本("trigger");
  });

  it("建考点 → 名字进词表；加别名 → 别名进词表", async () => {
    const k = (await createKp({ name: "一元一次方程" }, { handle: h })).id;
    expect(await 词条(h, k)).toEqual([{ kind: "name", term: "一元一次方程" }]);

    await addKpAlias(k, "解方程", { handle: h });
    expect(await 词条(h, k)).toEqual([
      { kind: "alias", term: "解方程" },
      { kind: "name", term: "一元一次方程" },
    ]);
  });

  it("改名 → 词表跟着改，别名词条不受牵连", async () => {
    const k = (await createKp({ name: "旧名字" }, { handle: h })).id;
    await addKpAlias(k, "别名不动", { handle: h });
    await renameKp(k, "新名字", { handle: h });
    expect(await 词条(h, k)).toEqual([
      { kind: "alias", term: "别名不动" },
      { kind: "name", term: "新名字" },
    ]);
  });

  it("🔴 合并 → 壳的词条全消失，别名跟着落到目标（重挂走的是 UPDATE）", async () => {
    const from = (await createKp({ name: "重复的绝对值" }, { handle: h })).id;
    const to = (await createKp({ name: "绝对值" }, { handle: h })).id;
    await addKpAlias(from, "绝对值压轴", { handle: h });

    await mergeKp(from, to, { handle: h });

    expect(await 词条(h, from)).toEqual([]);
    expect(await 词条(h, to)).toEqual([
      { kind: "alias", term: "绝对值压轴" },
      { kind: "name", term: "绝对值" },
    ]);
    // 壳不该再被检索命中：查它的旧名只会经落点回来，不会返回壳本身
    const r = await resolveKp("重复的绝对值", { handle: h, enqueue: false });
    expect(r.candidates.map((c) => c.kpId)).not.toContain(from);
  });

  it("退役 → 词条消失（连同它名下的别名）", async () => {
    const k = (await createKp({ name: "要退役的考点" }, { handle: h })).id;
    await retireKp(k, { handle: h });
    expect(await 词条(h, k)).toEqual([]);
    const r = await resolveKp("要退役的考点", { handle: h, enqueue: false });
    expect(r.candidates).toEqual([]);
  });

  it("删别名 → 只掉那一条词条", async () => {
    const k = (await createKp({ name: "带两个别名" }, { handle: h })).id;
    await addKpAlias(k, "别名甲", { handle: h });
    await addKpAlias(k, "别名乙", { handle: h });
    await removeKpAlias(k, "别名甲", { handle: h });
    expect((await 词条(h, k)).map((x) => x.term)).toEqual([
      "别名乙",
      "带两个别名",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⑥ C2 扩面
// ---------------------------------------------------------------------------

describe("⑥ 对账 C2 扩面：err_code_map / kp_edge / exam_model 指向 merged 考点要红", () => {
  it("造两条悬挂引用 → C2 红，且 stats 逐表说得出是谁", async () => {
    const h = await 造副本("c2");
    const 壳 = (await createKp({ name: "被合掉的" }, { handle: h })).id;
    const 落点 = (await createKp({ name: "合并目标" }, { handle: h })).id;
    const 旁观 = (await createKp({ name: "旁边的考点" }, { handle: h })).id;
    await mergeKp(壳, 落点, { handle: h });

    // 合并之后再往壳上挂 —— 正是 merge 原语「漏挂一张表」时库里会留下的形状
    const cause = newId("ec");
    await withCoreWrite(
      { actor: "system", tool: "test_seed_dangling" },
      async (tx) => {
        const refs: RowRef[] = [];
        await tx
          .insert(errorCause)
          .values({ id: cause, name: "漏负号", status: "active" });
        refs.push({ table: "error_cause", id: cause, op: "insert" });

        await tx.insert(errCodeMap).values({
          kpId: 壳,
          errCode: "JSZ-FH-01",
          causeId: cause,
          mappedBy: "test",
          mappedAt: nowLocalISO(),
        });
        refs.push({
          table: "err_code_map",
          id: rowRefId(壳, "JSZ-FH-01"),
          op: "insert",
        });

        await tx
          .insert(kpEdge)
          .values({ fromKp: 旁观, toKp: 壳, type: "prereq" });
        refs.push({
          table: "kp_edge",
          id: rowRefId(旁观, 壳, "prereq"),
          op: "insert",
        });
        return refs;
      },
      h,
    );

    const report = await integrityCheck({
      handle: h,
      metric: false,
      assetsDir: 真资产目录,
    });
    const c2 = report.checks.find((c) => c.id === "C2")!;
    expect(c2.ok).toBe(false);
    expect(c2.level).toBe("red");
    expect(c2.stats?.err_code_map).toBe(1);
    expect(c2.stats?.kp_edge).toBe(1); // 🔴 两端只要有一端坏就算这条边坏
    expect(c2.stats?.合计).toBe(2);
    expect(c2.details.join("\n")).toContain(壳);
    // 老四表照旧绿
    expect(c2.stats?.question_kp).toBe(0);
    expect(c2.stats?.kp_alias).toBe(0);
  });

  it("exam_model 指向 merged 考点 → C2 红（002-B2 补：解题模型挂在合并壳上不许静默）", async () => {
    const h = await 造副本("c2-em");
    const 壳 = (await createKp({ name: "被合掉的模型考点" }, { handle: h })).id;
    const 落点 = (await createKp({ name: "模型合并目标" }, { handle: h })).id;
    await mergeKp(壳, 落点, { handle: h });

    // 合并之后再往壳上挂模型 —— mergeKp 第 ④ 步（exam_model 改指）漏做时库里的形状
    const em = newId("em");
    await withCoreWrite(
      { actor: "system", tool: "test_seed_dangling_model" },
      async (tx) => {
        await tx.insert(examModel).values({
          id: em,
          kpId: 壳,
          name: "绝对值分类讨论·三段式",
          status: "active",
          createdAt: nowLocalISO(),
        });
        return [{ table: "exam_model", id: em, op: "insert" }];
      },
      h,
    );

    const c2 = (
      await integrityCheck({ handle: h, metric: false, assetsDir: 真资产目录 })
    ).checks.find((c) => c.id === "C2")!;
    expect(c2.ok).toBe(false);
    expect(c2.level).toBe("red");
    expect(c2.stats?.exam_model).toBe(1);
    expect(c2.stats?.合计).toBe(1);
    expect(c2.details.join("\n")).toContain(壳);
  });
});
