/**
 * KG 写原语闸（AI:PRD-002 · 002-A）
 *
 * 沿用既有范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**
 * （audit_log 是 append-only，往真库插一行就再也拿不出来）。
 *
 * 测试在精不在多，只钉五件必须永远成立的事：
 *   ① mergeKp 正常路：五张引用表 + exam_model 全量重挂、主考点显式裁决不被静默吞、
 *      from 壳留 merged_into、对账 C2 绿（且 C1a 审计覆盖一条不漏）；
 *   ② mergeKp 拒绝路：目标不是 active 一律拒（防环断链）、from 已合并报得出指向；
 *   ③ resolveMergedKp：两级链追得到活跃考点；人工造出来的环报错而不是死循环；
 *   ④ 版本树：同册第二棵 active 被部分唯一索引拒；status 必填（不给 = 悄悄绕开那道索引）；
 *   ⑤ importKgBatch：坏行整批回滚、零残留。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addEditionNode,
  addKpAlias,
  createCoreDb,
  createEditionTree,
  createKp,
  importKgBatch,
  integrityCheck,
  mapNodeKp,
  mergeKp,
  newId,
  nowLocalISO,
  readWriteGate,
  resolveMergedKp,
  retireKp,
  rowRefId,
  setTreeStatus,
  verifyAuditChain,
  withCoreWrite,
  writeQuestionFts,
  type CheckId,
  type CoreDbHandle,
  type CreateEditionTreeInput,
  type IntegrityReport,
  type RowRef,
} from "~/core";
import {
  errCodeMap,
  errorCause,
  examModel,
  kpError,
  question,
  questionKp,
} from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 每个 describe 一份一次性副本（tag 唯一） */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-kg-${process.pid}-${tag}.db`);
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

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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

function pick(report: IntegrityReport, id: CheckId) {
  const c = report.checks.find((x) => x.id === id);
  expect(c, `报告里没有 ${id}`).toBeDefined();
  return c!;
}

function reds(report: IntegrityReport): CheckId[] {
  return report.checks
    .filter((c) => !c.ok && c.level === "red")
    .map((c) => c.id);
}

/**
 * 造几道题（走 core，rowRefs 如实报，好让 C1a 保持绿）。
 *
 * 🔴 2026-08-12（AI:PRD-003）补 writeQuestionFts：对账新增了 C1(f)「FTS 投影对齐」——
 *    写 question 却不写投影，那题就是 FTS 查不到的半失效行，对账会红。
 *    这不是测试的将就，正是那条纪律本身：**写题的每一条路径都要同事务写投影**。
 */
async function 造题(h: CoreDbHandle, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => newId("q"));
  await withCoreWrite(
    { actor: "system", tool: "test_seed_questions" },
    async (tx) => {
      const refs: RowRef[] = [];
      for (const id of ids) {
        await tx.insert(question).values({
          id,
          stem: `测试题 ${id}`,
          stemPlain: `测试题 ${id}`,
          status: "active",
          solutionGrade: "analysis_only",
          provType: "manual",
          createdBy: "test",
          createdAt: nowLocalISO(),
        });
        await writeQuestionFts(tx, {
          questionId: id,
          stemPlain: `测试题 ${id}`,
        });
        refs.push({ table: "question", id, op: "insert" });
      }
      return refs;
    },
    h,
  );
  return ids;
}

// ---------------------------------------------------------------------------
// ① mergeKp 正常路
// ---------------------------------------------------------------------------

describe("① mergeKp 正常路（D-11 全量语义）", () => {
  let h: CoreDbHandle;
  /** 被合并的重复考点 / 合并目标 */
  let from = "";
  let to = "";
  /** q1：只挂 from 且是主考点；q2：两侧都挂、from 侧才是主；q3：两侧都挂、to 侧是主 */
  let q1 = "";
  let q2 = "";
  let q3 = "";
  let node = "";
  let cause = "";
  let model = "";

  beforeAll(async () => {
    h = await 造副本("merge-ok");

    from = (await createKp({ name: "绝对值(重复录的)" }, { handle: h })).id;
    to = (await createKp({ name: "绝对值" }, { handle: h })).id;

    const tree = (
      await createEditionTree(
        {
          subject: "数学",
          edition: "人教",
          gradeSem: "七上",
          status: "active",
        },
        { handle: h },
      )
    ).id;
    node = (
      await addEditionNode(
        { treeId: tree, level: 2, name: "1.2.4 绝对值", sort: 4 },
        { handle: h },
      )
    ).id;

    [q1, q2, q3] = (await 造题(h, 3)) as [string, string, string];
    cause = newId("ec");
    model = newId("em");

    // 别名：'压轴' 只在 from（要改挂）；'取绝对值' 两边都有（要去重）
    await addKpAlias(from, "绝对值压轴", { handle: h });
    await addKpAlias(from, "取绝对值", { handle: h });
    await addKpAlias(to, "取绝对值", { handle: h });
    // 章节映射：只有 from 挂着 → 要改挂
    await mapNodeKp(node, from, { handle: h });

    await withCoreWrite(
      { actor: "system", tool: "test_seed_refs" },
      async (tx) => {
        const refs: RowRef[] = [];

        // question_kp：🔴 一题至多一个 primary（部分唯一索引 idx_qkp_primary），
        // 所以「两侧同题都是 primary」在库里根本造不出来，见文件末尾的说明。
        await tx
          .insert(questionKp)
          .values({ questionId: q1, kpId: from, isPrimary: 1 });
        await tx
          .insert(questionKp)
          .values({ questionId: q2, kpId: from, isPrimary: 1 });
        await tx
          .insert(questionKp)
          .values({ questionId: q2, kpId: to, isPrimary: 0 });
        await tx
          .insert(questionKp)
          .values({ questionId: q3, kpId: from, isPrimary: 0 });
        await tx
          .insert(questionKp)
          .values({ questionId: q3, kpId: to, isPrimary: 1 });
        for (const [q, k] of [
          [q1, from],
          [q2, from],
          [q2, to],
          [q3, from],
          [q3, to],
        ] as const) {
          refs.push({
            table: "question_kp",
            id: rowRefId(q, k),
            op: "insert",
          });
        }

        // 错因候选集 + 七码映射 + 考察模型，全挂在 from 上
        await tx
          .insert(errorCause)
          .values({ id: cause, name: "漏负号", status: "active" });
        refs.push({ table: "error_cause", id: cause, op: "insert" });
        await tx.insert(kpError).values({ kpId: from, causeId: cause });
        refs.push({
          table: "kp_error",
          id: rowRefId(from, cause),
          op: "insert",
        });
        await tx.insert(errCodeMap).values({
          kpId: from,
          errCode: "JSZ-FH-01",
          causeId: cause,
          mappedBy: "test",
          mappedAt: nowLocalISO(),
        });
        refs.push({
          table: "err_code_map",
          id: rowRefId(from, "JSZ-FH-01"),
          op: "insert",
        });
        await tx.insert(examModel).values({
          id: model,
          kpId: from,
          name: "绝对值化简模型",
          status: "active",
        });
        refs.push({ table: "exam_model", id: model, op: "insert" });

        return refs;
      },
      h,
    );
  });

  it("四表 + err_code_map 全量重挂到 to，from 侧一行不剩", async () => {
    const r = await mergeKp(from, to, {
      actor: "human",
      note: "治理页合并向导",
      handle: h,
    });

    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
    expect(r.seq).toBeGreaterThan(0);

    // from 侧清空
    expect(await 计数(h, "question_kp", `kp_id='${from}'`)).toBe(0);
    expect(await 计数(h, "kp_alias", `kp_id='${from}'`)).toBe(0);
    expect(await 计数(h, "node_kp_map", `kp_id='${from}'`)).toBe(0);
    expect(await 计数(h, "kp_error", `kp_id='${from}'`)).toBe(0);
    expect(await 计数(h, "err_code_map", `kp_id='${from}'`)).toBe(0);

    // to 侧收齐：三道题各一行、两条别名（'取绝对值' 去重不重复）、映射/错因/七码各一条
    expect(await 计数(h, "question_kp", `kp_id='${to}'`)).toBe(3);
    expect(await 计数(h, "kp_alias", `kp_id='${to}'`)).toBe(2);
    expect(
      await 计数(h, "node_kp_map", `node_id='${node}' AND kp_id='${to}'`),
    ).toBe(1);
    expect(
      await 计数(h, "kp_error", `kp_id='${to}' AND cause_id='${cause}'`),
    ).toBe(1);
    expect(
      await 计数(h, "err_code_map", `kp_id='${to}' AND err_code='JSZ-FH-01'`),
    ).toBe(1);

    // 计数账目：改挂 vs 去重，逐表有账
    expect(r.moved.question_kp).toBe(1); // 只有 q1 是「to 侧没有」的
    expect(r.dropped.question_kp).toBe(2); // q2 / q3 两侧都有
    expect(r.moved.kp_alias).toBe(1);
    expect(r.dropped.kp_alias).toBe(1);
    expect(r.moved.node_kp_map).toBe(1);
    expect(r.moved.kp_error).toBe(1);
    expect(r.moved.err_code_map).toBe(1);
    expect(r.moved.exam_model).toBe(1);
  });

  it("🔴 主考点显式裁决：一个跟着搬、一个把 to 侧次行提为主，没有被静默吞", async () => {
    const rows = await 行<{ question_id: string; is_primary: number }>(
      h,
      `SELECT question_id, is_primary FROM question_kp WHERE kp_id='${to}' ORDER BY question_id`,
    );
    const 主 = new Map(rows.map((r) => [r.question_id, Number(r.is_primary)]));

    // q1：to 侧原本没这题 → 整行改挂，primary 原样跟着走
    expect(主.get(q1)).toBe(1);
    // q2：to 侧原有次行 → 🔴 显式提为主（naive 的 INSERT OR IGNORE 会把这题的主考点丢掉）
    expect(主.get(q2)).toBe(1);
    // q3：from 侧本来就不是主，to 侧的主不动
    expect(主.get(q3)).toBe(1);

    // 一题至多一个主考点这条底线仍然成立
    const 多主 = await 行<{ c: number }>(
      h,
      "SELECT COUNT(*) AS c FROM (SELECT question_id FROM question_kp WHERE is_primary=1 GROUP BY question_id HAVING COUNT(*)>1)",
    );
    expect(Number(多主[0]?.c ?? 0)).toBe(0);
  });

  it("exam_model 改指 + from 壳留 merged_into（旧 id 反查得到落点）", async () => {
    const m = await 行<{ kp_id: string }>(
      h,
      `SELECT kp_id FROM exam_model WHERE id='${model}'`,
    );
    expect(m[0]?.kp_id).toBe(to);

    const shell = await 行<{ status: string; merged_into: string }>(
      h,
      `SELECT status, merged_into FROM kp WHERE id='${from}'`,
    );
    expect(shell[0]?.status).toBe("merged");
    expect(shell[0]?.merged_into).toBe(to);

    const 落点 = await resolveMergedKp(h, from);
    expect(落点.id).toBe(to);
    expect(落点.hops).toBe(1);
    expect(落点.status).toBe("active");
  });

  it("对账：C2 悬挂引用绿、C1a 审计覆盖一行不漏、闸静息、链接得上", async () => {
    const report = await integrityCheck({ handle: h, metric: false });

    const c2 = pick(report, "C2");
    expect(c2.ok, c2.details.join("\n")).toBe(true);
    expect(c2.stats?.合计).toBe(0);

    // 🔴 rowRefs 少报一条 = 那行成孤儿 = C1a 红。这里等于反证「改挂的新键也报了」
    const c1 = pick(report, "C1");
    expect(c1.stats?.a_无审计覆盖行, c1.details.join("\n")).toBe(0);
    // 造的题没配向量（C1b warn），warn 不算红旗
    expect(reds(report)).toEqual([]);

    expect(await readWriteGate(h)).toBe(0);
    const chain = await verifyAuditChain(h);
    expect(chain.ok, chain.reason).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ② mergeKp 拒绝路
// ---------------------------------------------------------------------------

describe("② mergeKp 拒绝路（目标必须 active，防环断链）", () => {
  let h: CoreDbHandle;
  let 活: string;
  let 壳: string;
  let 退役: string;

  beforeAll(async () => {
    h = await 造副本("merge-reject");
    活 = (await createKp({ name: "合并目标" }, { handle: h })).id;
    壳 = (await createKp({ name: "先被合掉的" }, { handle: h })).id;
    退役 = (await createKp({ name: "退役了的" }, { handle: h })).id;
    await mergeKp(壳, 活, { handle: h });
    await retireKp(退役, { handle: h });
  });

  it("to 是 merged → 拒（合到壳上=造环断链）", async () => {
    const 新 = (await createKp({ name: "新来的" }, { handle: h })).id;
    await expect(mergeKp(新, 壳, { handle: h })).rejects.toMatchObject({
      code: "MERGE_TARGET_NOT_ACTIVE",
    });
    // 拒了就一行都不许动
    const row = await 行<{ status: string }>(
      h,
      `SELECT status FROM kp WHERE id='${新}'`,
    );
    expect(row[0]?.status).toBe("active");
  });

  it("to 是 retired → 拒", async () => {
    const 新 = (await createKp({ name: "另一个新来的" }, { handle: h })).id;
    await expect(mergeKp(新, 退役, { handle: h })).rejects.toMatchObject({
      code: "MERGE_TARGET_NOT_ACTIVE",
    });
  });

  it("from 已合并过 → 报错并带出指向", async () => {
    await expect(mergeKp(壳, 活, { handle: h })).rejects.toMatchObject({
      code: "KP_ALREADY_MERGED",
    });
    await expect(mergeKp(壳, 活, { handle: h })).rejects.toThrow(活);
  });

  it("from == to → 拒；闸仍静息", async () => {
    await expect(mergeKp(活, 活, { handle: h })).rejects.toMatchObject({
      code: "MERGE_SELF",
    });
    expect(await readWriteGate(h)).toBe(0);
  });

  it("retireKp：还有活引用就拒，force 才放行（force 会留 C2 红旗）", async () => {
    const k = (await createKp({ name: "带别名的考点" }, { handle: h })).id;
    await addKpAlias(k, "它的别名", { handle: h });

    await expect(retireKp(k, { handle: h })).rejects.toMatchObject({
      code: "KP_HAS_REFS",
    });
    const 仍在 = await 行<{ status: string }>(
      h,
      `SELECT status FROM kp WHERE id='${k}'`,
    );
    expect(仍在[0]?.status).toBe("active");

    const r = await retireKp(k, { force: true, handle: h });
    expect(r.refs.kp_alias).toBe(1);
    const 退了 = await 行<{ status: string }>(
      h,
      `SELECT status FROM kp WHERE id='${k}'`,
    );
    expect(退了[0]?.status).toBe("retired");
    // 诚实：强退留下的正是 C2 要抓的悬挂引用
    const c2 = pick(await integrityCheck({ handle: h, metric: false }), "C2");
    expect(c2.ok).toBe(false);
    expect(c2.stats?.kp_alias).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ③ resolveMergedKp
// ---------------------------------------------------------------------------

describe("③ resolveMergedKp 追链", () => {
  it("两级链一路追到活跃考点", async () => {
    const h = await 造副本("resolve-chain");
    const a = (await createKp({ name: "A(最早的重复)" }, { handle: h })).id;
    const b = (await createKp({ name: "B(中间那个)" }, { handle: h })).id;
    const c = (await createKp({ name: "C(最终落点)" }, { handle: h })).id;

    await mergeKp(a, b, { handle: h }); // A → B
    await mergeKp(b, c, { handle: h }); // B → C（A 的链因此变成两级）

    const r = await resolveMergedKp(h, a);
    expect(r.id).toBe(c);
    expect(r.status).toBe("active");
    expect(r.hops).toBe(2);
    expect(r.chain).toEqual([a, b, c]);

    // 本来就活跃的考点：0 跳，原样返回
    const 自己 = await resolveMergedKp(h, c);
    expect(自己.id).toBe(c);
    expect(自己.hops).toBe(0);
  });

  it("🔴 人工掰出来的环：报错，不是死循环", async () => {
    const h = await 造副本("resolve-cycle");
    const x = (await createKp({ name: "X" }, { handle: h })).id;
    const y = (await createKp({ name: "Y" }, { handle: h })).id;
    await mergeKp(x, y, { handle: h }); // X → Y

    // 经 core 造不出环（mergeKp 要求目标 active）——只能开闸手改，模拟「库被绕过写坏」
    const 裸 = createClient({ url: h.url });
    try {
      await 裸.execute("UPDATE _write_gate SET allowed=1 WHERE id=1");
      await 裸.execute(
        `UPDATE kp SET status='merged', merged_into='${x}' WHERE id='${y}'`,
      );
      await 裸.execute("UPDATE _write_gate SET allowed=0 WHERE id=1");
    } finally {
      裸.close();
    }

    await expect(resolveMergedKp(h, x)).rejects.toMatchObject({
      code: "MERGE_CHAIN_CYCLE",
    });
    await expect(resolveMergedKp(h, x)).rejects.toThrow(/→/);
  });
});

// ---------------------------------------------------------------------------
// ④ 版本树
// ---------------------------------------------------------------------------

describe("④ 版本树：一册至多一棵活跃树", () => {
  let h: CoreDbHandle;
  beforeAll(async () => {
    h = await 造副本("tree");
  });

  it("同 (subject, edition, gradeSem) 第二棵 active 被部分唯一索引拒", async () => {
    await createEditionTree(
      { subject: "数学", edition: "浙教", gradeSem: "七上", status: "active" },
      { handle: h },
    );

    const 第二棵 = () =>
      createEditionTree(
        {
          subject: "数学",
          edition: "浙教",
          gradeSem: "七上",
          version: 2,
          status: "active",
        },
        { handle: h },
      );
    // 拒它的是库里的部分唯一索引（不是代码里另抄一份判据）；core 只把报错翻成人话，
    // 原文照带 —— 🔴 两道唯一闸的报错差别只在列清单带不带 edition_tree.version
    await expect(第二棵()).rejects.toMatchObject({
      code: "TREE_ACTIVE_CONFLICT",
    });
    await expect(第二棵()).rejects.toThrow(
      /UNIQUE constraint failed: edition_tree\.subject, edition_tree\.edition, edition_tree\.grade_sem\)/,
    );

    // 版本号真撞车（同册同 version）报的是另一个码，不混为一谈
    await expect(
      createEditionTree(
        {
          subject: "数学",
          edition: "浙教",
          gradeSem: "七上",
          version: 1,
          status: "readonly",
        },
        { handle: h },
      ),
    ).rejects.toMatchObject({ code: "TREE_DUPLICATE" });

    // 归档树（readonly）不占活跃位，同册可以并存
    const 归档 = await createEditionTree(
      {
        subject: "数学",
        edition: "浙教",
        gradeSem: "七上",
        version: 2,
        status: "readonly",
      },
      { handle: h },
    );
    expect(
      await 计数(h, "edition_tree", "subject='数学' AND edition='浙教'"),
    ).toBe(2);

    // 直接把归档树切回 active 会撞位，且报得出是哪棵占着
    await expect(
      setTreeStatus(归档.id, "active", { handle: h }),
    ).rejects.toMatchObject({ code: "TREE_ACTIVE_CONFLICT" });
  });

  it("🔴 status 必填：不给 = 悄悄绕开活跃树唯一索引，zod 当场拒", async () => {
    await expect(
      createEditionTree(
        // 故意不传 status（TS 端拦得住，这里测的是 JS/MCP 侧调进来的运行期闸）
        {
          subject: "科学",
          edition: "浙教",
          gradeSem: "八下",
        } as CreateEditionTreeInput,
        { handle: h },
      ),
    ).rejects.toThrow(/status/);

    expect(await 计数(h, "edition_tree", "subject='科学'")).toBe(0);
  });

  it("readonly 树不再长节点；父子不许跨树认亲", async () => {
    const 活树 = await createEditionTree(
      { subject: "数学", edition: "人教", gradeSem: "八上", status: "active" },
      { handle: h },
    );
    const 章 = await addEditionNode(
      { treeId: 活树.id, level: 1, name: "第一章 三角形", sort: 1 },
      { handle: h },
    );
    await addEditionNode(
      {
        treeId: 活树.id,
        parentId: 章.id,
        level: 2,
        name: "1.1 全等三角形",
        sort: 1,
      },
      { handle: h },
    );

    const 归档树 = await createEditionTree(
      {
        subject: "数学",
        edition: "人教",
        gradeSem: "八上",
        version: 2,
        status: "readonly",
      },
      { handle: h },
    );
    await expect(
      addEditionNode(
        { treeId: 归档树.id, level: 1, name: "旧版第一章" },
        { handle: h },
      ),
    ).rejects.toMatchObject({ code: "TREE_NOT_ACTIVE" });

    const 另一棵 = await createEditionTree(
      { subject: "数学", edition: "人教", gradeSem: "九上", status: "active" },
      { handle: h },
    );
    await expect(
      addEditionNode(
        { treeId: 另一棵.id, parentId: 章.id, level: 2, name: "串味节点" },
        { handle: h },
      ),
    ).rejects.toMatchObject({ code: "NODE_TREE_MISMATCH" });
  });
});

// ---------------------------------------------------------------------------
// ⑤ importKgBatch
// ---------------------------------------------------------------------------

describe("⑤ importKgBatch 全进或全不进", () => {
  let h: CoreDbHandle;
  beforeAll(async () => {
    h = await 造副本("import");
  });

  it("正常一批：考点 + 树 + 父子节点（乱序也排得对）+ 别名 + 映射一次落库", async () => {
    // 🔴 计数一律「与基线相对」：副本是从真库 VACUUM 出来的，002 导底后它自带
    //    415 考点 / 108 节点 / 490 映射 —— 写死绝对数的断言在有存量的库上必假红。
    const 前 = {
      kp: await 计数(h, "kp"),
      node: await 计数(h, "edition_node"),
      map: await 计数(h, "node_kp_map"),
      alias: await 计数(h, "kp_alias"),
    };
    const kp1 = newId("kp");
    const kp2 = newId("kp");
    const tree = newId("tree");
    const 章 = newId("node");
    const 节 = newId("node");

    const r = await importKgBatch(
      {
        kps: [
          {
            id: kp1,
            name: "有理数加减",
            gradeBand: "初中",
            domain: "数与代数",
          },
          { id: kp2, name: "有理数乘除", gradeBand: "初中" },
        ],
        aliases: [
          { kpId: kp1, alias: "有理数加法" },
          { kpId: kp1, alias: "有理数减法" },
        ],
        tree: {
          id: tree,
          subject: "数学",
          edition: "人教",
          gradeSem: "七上",
          status: "active",
        },
        // 🔴 故意把子节点写在父节点前面：拓扑排序得自己把父挪到前面，否则外键当场炸
        nodes: [
          {
            id: 节,
            treeId: tree,
            parentId: 章,
            level: 2,
            name: "1.3 有理数的加减法",
            sort: 3,
          },
          { id: 章, treeId: tree, level: 1, name: "第一章 有理数", sort: 1 },
        ],
        maps: [
          { nodeId: 节, kpId: kp1 },
          { nodeId: 节, kpId: kp2 },
        ],
      },
      { handle: h, note: "导底试跑" },
    );

    expect(r.counts).toEqual({
      kps: 2,
      aliases: 2,
      trees: 1,
      nodes: 2,
      maps: 2,
    });
    expect(await 计数(h, "kp")).toBe(前.kp + 2);
    expect(await 计数(h, "edition_node")).toBe(前.node + 2);
    expect(await 计数(h, "node_kp_map")).toBe(前.map + 2);
    expect(await 计数(h, "kp_alias")).toBe(前.alias + 2);

    // 一批 = 一条审计行，rowRefs 全量（7 行业务 = 2 kp + 1 tree + 2 node + 2 alias… + 2 map）
    expect(r.rowRefs).toHaveLength(9);
    const c1 = pick(await integrityCheck({ handle: h, metric: false }), "C1");
    expect(c1.stats?.a_无审计覆盖行, c1.details.join("\n")).toBe(0);
  });

  it("🔴 一条坏行（map 指向不存在的考点）→ 整批回滚，零残留", async () => {
    const 前 = {
      kp: await 计数(h, "kp"),
      tree: await 计数(h, "edition_tree"),
      node: await 计数(h, "edition_node"),
      map: await 计数(h, "node_kp_map"),
      audit: await 计数(h, "audit_log"),
    };

    const 好考点 = newId("kp");
    const 坏考点 = newId("kp"); // 谁都没建过它
    const tree = newId("tree");
    const node = newId("node");

    await expect(
      importKgBatch(
        {
          kps: [{ id: 好考点, name: "整式加减" }],
          tree: {
            id: tree,
            subject: "数学",
            edition: "人教",
            gradeSem: "七下",
            status: "active",
          },
          nodes: [{ id: node, treeId: tree, level: 1, name: "第二章 整式" }],
          maps: [
            { nodeId: node, kpId: 好考点 },
            { nodeId: node, kpId: 坏考点 }, // ← 坏行在最后：前面几段已经写进事务了
          ],
        },
        { handle: h },
      ),
    ).rejects.toMatchObject({ code: "BATCH_BAD_ROW" });

    // 🔴 半棵树比没有树坏得多：连审计行都不许留下
    expect(await 计数(h, "kp")).toBe(前.kp);
    expect(await 计数(h, "edition_tree")).toBe(前.tree);
    expect(await 计数(h, "edition_node")).toBe(前.node);
    expect(await 计数(h, "node_kp_map")).toBe(前.map);
    expect(await 计数(h, "audit_log")).toBe(前.audit);
    expect(await readWriteGate(h)).toBe(0);
  });
});
