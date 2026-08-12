/**
 * 建库结构闸（AI:PRD-001 · WP2）
 *
 * 这份测试是「库长成什么样」的机器断言，正本 = PRD-026/M1-数据模型.md §3/§5。
 * 后续卡只填数据不改结构 —— 这里红了就说明有人动了地基。
 *
 * 两段：
 *   ① 结构断言：直读真库 data/资料库.db 的 sqlite_master（只 SELECT，不写）。
 *      🔴 用【全等】而不是【包含】：多一张表也红。这是 G-2 红线（冻结物零建表）的机器版。
 *   ② 行为断言：VACUUM INTO 出一份一次性副本再动手。
 *      不在真库上造脏数据 —— 尤其 audit_log 是 append-only，插进去就删不掉了。
 *      顺带这也真跑了一遍备份主路（VACUUM INTO），FTS 自含式的理由就建立在它上面。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 期望清单（手写正本；改结构必须同步改这里，改不动就是结构不该改）
// ---------------------------------------------------------------------------

/** 六域 32 张普通表 = M1 §3 A~G 逐表终稿 */
const 普通表 = [
  // A 域 · KG 双层（6）
  "kp",
  "kp_alias",
  "kp_edge",
  "edition_tree",
  "edition_node",
  "node_kp_map",
  // B 域 · 题目（8）
  "question",
  "question_kp",
  "question_tag",
  "question_figure",
  "question_vec",
  "asset",
  "source_doc",
  "source_page",
  // C 域 · 考察模型（1）
  "exam_model",
  // D 域 · 错因（4）
  "error_cause",
  "kp_error",
  "cause_example",
  "err_code_map",
  // E 域 · 生产登记（7）
  "ingest_batch",
  "quarantine",
  "sku",
  "sku_item",
  "sku_output",
  "grading_task_map",
  "grading_batch_link",
  // F 域 · 学情连接（1）—— 🔴 只有 roster，圣域 batches/items/slots/tasks/feedback 绝不在本库
  "roster",
  // G 域 · 系统（5）
  "review_queue",
  "ledger",
  "ledger_ref",
  "audit_log",
  "metric_event",
] as const;

/** FTS5 虚拟表 + SQLite 自建的 5 张影子表 */
const FTS家族 = [
  "question_fts",
  "question_fts_config",
  "question_fts_content",
  "question_fts_data",
  "question_fts_docsize",
  "question_fts_idx",
] as const;

/** 🆕 AI:PRD-002 · 002-C：考点词表 kp_fts（trigram）+ 它的 5 张影子表 */
const KP_FTS家族 = [
  "kp_fts",
  "kp_fts_config",
  "kp_fts_content",
  "kp_fts_data",
  "kp_fts_docsize",
  "kp_fts_idx",
] as const;

/** 机制表：写令牌 / drizzle 迁移账 / AUTOINCREMENT 序列（audit_log.seq + metric_event.id 触发 SQLite 自建） */
const 机制表 = [
  "_write_gate",
  "__drizzle_migrations",
  "sqlite_sequence",
] as const;

/** M1 §5 的 9 条索引；带 where 的是部分索引，值=期望出现在 DDL 里的 WHERE 片段 */
const 索引期望: Record<string, string | null> = {
  idx_q_status_diff: null,
  idx_qkp_kp: null,
  idx_qkp_primary: "is_primary=1",
  idx_q_matchkey: "status IN ('pending','active')",
  idx_tag: null,
  idx_ledger_ref: null,
  idx_queue_open: "state='open'",
  idx_alias: null,
  idx_edtree_active: "status='active'",
};

/** FTS 同步触发器：question 三只 + 🆕 kp 词表六只（kp 三 + kp_alias 三） */
const FTS触发器 = [
  "trg_question_fts_ai",
  "trg_question_fts_au",
  "trg_question_fts_ad",
  "trg_kp_fts_ai",
  "trg_kp_fts_au",
  "trg_kp_fts_ad",
  "trg_kp_alias_fts_ai",
  "trg_kp_alias_fts_au",
  "trg_kp_alias_fts_ad",
] as const;

/**
 * 🔴 反向名单：冻结物一张都不许在库里长出来。
 * 录入台页级状态机 / 批改写侧（圣域）/ 代审 / 变式收编 / 被 D-2、D-4 否掉的表。
 * （下面的全等断言已经覆盖，这条是「说人话」的第二道，红起来一眼知道犯的是哪条）
 */
const 冻结物黑名单 = [
  "batches",
  "items",
  "slots",
  "tasks",
  "feedback",
  "review_page",
  "ocr_page",
  "ocr_task",
  "legacy_question",
  "paper",
  "paper_item",
  "proposal",
  "student_fact",
  "posts", // t3 脚手架示例表，必须已删干净
  "knowledge-factory_post",
] as const;

const 全部期望表 = [...普通表, ...FTS家族, ...KP_FTS家族, ...机制表].sort();

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本路径 = join(tmpdir(), `kf-schema-test-${process.pid}.db`);

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

let 真库: Client;
let 副本: Client;

type MasterRow = { name: string; type: string; sql: string | null };

async function master(c: Client, type: string): Promise<MasterRow[]> {
  const r = await c.execute({
    sql: "SELECT name, type, sql FROM sqlite_master WHERE type = ? ORDER BY name",
    args: [type],
  });
  return r.rows as unknown as MasterRow[];
}

beforeAll(async () => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
  真库 = createClient({ url: fileUrl(真库路径) });

  // 一次性副本：VACUUM INTO 是完整的、含 WAL 已提交内容的干净拷贝
  if (existsSync(副本路径)) rmSync(副本路径);
  await 真库.execute(`VACUUM INTO '${副本路径.replace(/'/g, "''")}'`);
  副本 = createClient({ url: fileUrl(副本路径) });
});

afterAll(async () => {
  真库?.close();
  副本?.close();
  // Windows 上句柄释放晚于 close() 返回，删不掉就重试几次；
  // 实在删不掉也不让测试红——那只是 %TEMP% 里的一个一次性副本。
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = 副本路径 + suffix;
    for (let i = 0; i < 5 && existsSync(p); i++) {
      try {
        rmSync(p, { force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

// ---------------------------------------------------------------------------
// ① 结构断言
// ---------------------------------------------------------------------------

describe("① 表清单（G-2 红线：冻结物零建表）", () => {
  it("32 张普通表一张不少", async () => {
    const 实有 = new Set((await master(真库, "table")).map((r) => r.name));
    for (const t of 普通表) expect(实有.has(t), `缺表：${t}`).toBe(true);
    expect(普通表.length).toBe(32);
  });

  it("question_fts / kp_fts + 影子表 + _write_gate 都在", async () => {
    const 实有 = new Set((await master(真库, "table")).map((r) => r.name));
    for (const t of [...FTS家族, ...KP_FTS家族, "_write_gate"])
      expect(实有.has(t), `缺：${t}`).toBe(true);
  });

  it("🔴 表集合【全等】期望清单——多一张都红", async () => {
    const 实有 = (await master(真库, "table")).map((r) => r.name).sort();
    expect(实有).toEqual(全部期望表);
    expect(实有.length).toBe(47); // 32 普通 + 6 question_fts 家族 + 6 kp_fts 家族 + 3 机制
  });

  it("🔴 kp_fts 用的是 trigram（词表要子串模糊命中，不是分词）", async () => {
    const ddl =
      (await master(真库, "table")).find((r) => r.name === "kp_fts")?.sql ?? "";
    expect(ddl).toContain("trigram");
    expect(
      ddl,
      "词表若走 unicode61，查「绝对值」就命中不了「绝对值的化简」",
    ).not.toContain("unicode61");
  });

  it("🔴 冻结物（录入台状态机 / 批改写侧 / 被否掉的表）一张都没有", async () => {
    const 实有 = new Set((await master(真库, "table")).map((r) => r.name));
    for (const t of 冻结物黑名单)
      expect(实有.has(t), `冻结物竟然建出来了：${t}`).toBe(false);
  });
});

describe("② 索引（M1 §5 九条）", () => {
  it("9 条命名索引全在", async () => {
    const 实有 = new Set((await master(真库, "index")).map((r) => r.name));
    for (const name of Object.keys(索引期望))
      expect(实有.has(name), `缺索引：${name}`).toBe(true);
    expect(Object.keys(索引期望).length).toBe(9);
  });

  it("3 条部分索引真的带上了 WHERE（漏了=约束形同虚设）", async () => {
    const byName = new Map(
      (await master(真库, "index")).map((r) => [r.name, r.sql ?? ""]),
    );
    for (const [name, where] of Object.entries(索引期望)) {
      if (where === null) continue;
      const ddl = byName.get(name) ?? "";
      expect(ddl, `${name} 的 DDL 里没有 WHERE ${where}`).toContain(
        `WHERE ${where}`,
      );
    }
  });

  it("主考点唯一 / 查重键唯一 / 活跃树唯一 都是 UNIQUE", async () => {
    const byName = new Map(
      (await master(真库, "index")).map((r) => [r.name, r.sql ?? ""]),
    );
    for (const name of [
      "idx_qkp_primary",
      "idx_q_matchkey",
      "idx_edtree_active",
    ]) {
      expect(byName.get(name) ?? "", `${name} 不是 UNIQUE`).toContain(
        "CREATE UNIQUE INDEX",
      );
    }
  });
});

describe("③ 触发器（64 只防裸写 + 9 只 FTS 同步）", () => {
  it("32 张表 × 2 只防裸写触发器全在，且集合全等", async () => {
    const 实有 = (await master(真库, "trigger")).map((r) => r.name).sort();
    const 期望 = [
      ...普通表.flatMap((t) => [
        `trg_${t}_no_bare_update`,
        `trg_${t}_no_bare_delete`,
      ]),
      ...FTS触发器,
    ].sort();
    expect(实有).toEqual(期望);
    expect(实有.length).toBe(73); // 64 + 3(question_fts) + 6(kp_fts)
  });

  it("audit_log 的两只是无条件 RAISE（没有 WHEN 令牌条件）", async () => {
    const byName = new Map(
      (await master(真库, "trigger")).map((r) => [r.name, r.sql ?? ""]),
    );
    for (const n of [
      "trg_audit_log_no_bare_update",
      "trg_audit_log_no_bare_delete",
    ]) {
      const ddl = byName.get(n) ?? "";
      expect(ddl).toContain("RAISE(ABORT");
      expect(ddl, `${n} 竟然看令牌——审计链必须绝对 append-only`).not.toContain(
        "_write_gate",
      );
    }
  });

  it("其余 31 张表的触发器都挂在令牌上", async () => {
    const byName = new Map(
      (await master(真库, "trigger")).map((r) => [r.name, r.sql ?? ""]),
    );
    for (const t of 普通表) {
      if (t === "audit_log") continue;
      for (const op of ["update", "delete"]) {
        const ddl = byName.get(`trg_${t}_no_bare_${op}`) ?? "";
        expect(ddl, `trg_${t}_no_bare_${op} 没接令牌`).toContain(
          "WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0",
        );
      }
    }
  });

  it("_write_gate 自己没有闸（有的话 core 开不了闸，自锁死）", async () => {
    const 实有 = (await master(真库, "trigger")).map((r) => r.name);
    expect(实有.some((n) => n.includes("_write_gate"))).toBe(false);
  });

  it("写令牌初值 = 0（常闭）", async () => {
    const r = await 真库.execute("SELECT allowed FROM _write_gate WHERE id=1");
    expect(r.rows.length).toBe(1);
    expect(Number((r.rows[0] as unknown as { allowed: number }).allowed)).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// ② 行为断言（一次性副本上跑）
// ---------------------------------------------------------------------------

async function 开闸(c: Client, on: boolean): Promise<void> {
  await c.execute({
    sql: "UPDATE _write_gate SET allowed = ? WHERE id=1",
    args: [on ? 1 : 0],
  });
}

describe("④ 防裸写闸的真实行为", () => {
  it("闸关着：INSERT 放行，UPDATE / DELETE 被 RAISE 打回", async () => {
    await 副本.execute(
      "INSERT INTO roster(code, alias, status) VALUES ('test_stu_1','闸测试','active')",
    );
    const n = await 副本.execute("SELECT COUNT(*) c FROM roster");
    expect(Number((n.rows[0] as unknown as { c: number }).c)).toBe(1);

    await expect(
      副本.execute("UPDATE roster SET alias='改了' WHERE code='test_stu_1'"),
    ).rejects.toThrow(/裸/);
    await expect(
      副本.execute("DELETE FROM roster WHERE code='test_stu_1'"),
    ).rejects.toThrow(/裸/);

    // 报错信息要说得出是哪张表
    await expect(
      副本.execute("UPDATE roster SET alias='改了' WHERE code='test_stu_1'"),
    ).rejects.toThrow(/roster/);

    // 打回意味着数据没变
    const after = await 副本.execute(
      "SELECT alias FROM roster WHERE code='test_stu_1'",
    );
    expect((after.rows[0] as unknown as { alias: string }).alias).toBe(
      "闸测试",
    );
  });

  it("开闸后 UPDATE / DELETE 通过，闸再关回去", async () => {
    await 开闸(副本, true);
    await 副本.execute(
      "UPDATE roster SET alias='开闸改的' WHERE code='test_stu_1'",
    );
    const r = await 副本.execute(
      "SELECT alias FROM roster WHERE code='test_stu_1'",
    );
    expect((r.rows[0] as unknown as { alias: string }).alias).toBe("开闸改的");

    await 副本.execute("DELETE FROM roster WHERE code='test_stu_1'");
    const n = await 副本.execute("SELECT COUNT(*) c FROM roster");
    expect(Number((n.rows[0] as unknown as { c: number }).c)).toBe(0);

    await 开闸(副本, false);
    const g = await 副本.execute("SELECT allowed FROM _write_gate WHERE id=1");
    expect(Number((g.rows[0] as unknown as { allowed: number }).allowed)).toBe(
      0,
    );
  });

  it("🔴 audit_log：开着闸也改不动、删不掉（append-only）", async () => {
    // 🔴 不假设「真库是空的」：库是活的，跑过备份/对账就有审计行了（WP4 起）。
    //    自己插一行、拿回它的 seq 再针对那一行验，才是与基线无关的断言。
    const ins = await 副本.execute(
      "INSERT INTO audit_log(ts, actor, tool, prev_hash) VALUES ('2026-08-12T00:00:00','system','test','GENESIS') RETURNING seq",
    );
    const seq = Number((ins.rows[0] as unknown as { seq: number }).seq);

    await 开闸(副本, true);
    await expect(
      副本.execute(`UPDATE audit_log SET tool='篡改' WHERE seq=${seq}`),
    ).rejects.toThrow(/append-only/);
    await expect(
      副本.execute(`DELETE FROM audit_log WHERE seq=${seq}`),
    ).rejects.toThrow(/append-only/);
    await 开闸(副本, false);

    const r = await 副本.execute(`SELECT tool FROM audit_log WHERE seq=${seq}`);
    expect((r.rows[0] as unknown as { tool: string }).tool).toBe("test");
  });
});

describe("⑤ FTS5 同步触发器的真实行为", () => {
  const qid = "q_TESTULID0000000000000001";

  it("INSERT question → question_fts 自动落一行", async () => {
    await 副本.execute({
      sql: `INSERT INTO question(id, stem, stem_plain, answer, analysis, status, solution_grade, prov_type, created_by)
            VALUES (?, '计算 $1+1$', '计算 1 + 1', '2', '凑十法', 'active', 'calc_verified', 'manual', 'test')`,
      args: [qid],
    });
    const r = await 副本.execute({
      sql: "SELECT stem_plain, answer, analysis FROM question_fts WHERE question_id = ?",
      args: [qid],
    });
    expect(r.rows.length).toBe(1);
    const row = r.rows[0] as unknown as {
      stem_plain: string;
      answer: string;
      analysis: string;
    };
    expect(row.stem_plain).toBe("计算 1 + 1");
    expect(row.answer).toBe("2");
    expect(row.analysis).toBe("凑十法");
  });

  it("MATCH 查得到（自含式 FTS 的意义就在这）", async () => {
    const r = await 副本.execute({
      sql: "SELECT question_id FROM question_fts WHERE question_fts MATCH ?",
      args: ["凑十法"],
    });
    expect(
      r.rows.map((x) => (x as unknown as { question_id: string }).question_id),
    ).toContain(qid);
  });

  it("UPDATE 三列 → FTS 跟着改；DELETE → FTS 跟着删（都要先开闸）", async () => {
    await 开闸(副本, true);
    await 副本.execute({
      sql: "UPDATE question SET stem_plain = ?, analysis = ? WHERE id = ?",
      args: ["计算 2 + 3", "分解法", qid],
    });
    const u = await 副本.execute({
      sql: "SELECT stem_plain, analysis FROM question_fts WHERE question_id = ?",
      args: [qid],
    });
    expect(u.rows.length).toBe(1);
    expect((u.rows[0] as unknown as { stem_plain: string }).stem_plain).toBe(
      "计算 2 + 3",
    );
    expect((u.rows[0] as unknown as { analysis: string }).analysis).toBe(
      "分解法",
    );

    await 副本.execute({
      sql: "DELETE FROM question WHERE id = ?",
      args: [qid],
    });
    const d = await 副本.execute({
      sql: "SELECT COUNT(*) c FROM question_fts WHERE question_id = ?",
      args: [qid],
    });
    expect(Number((d.rows[0] as unknown as { c: number }).c)).toBe(0);
    await 开闸(副本, false);
  });
});

// ---------------------------------------------------------------------------
// ③ 关键 CHECK 约束抽验（provenance 硬闸是 M1 的核心断言）
// ---------------------------------------------------------------------------

describe("⑥ provenance 硬闸 CHECK 真的会拦", () => {
  it("prov_type='scan' 缺 source_doc_id/page_no → 被 CHECK 拦", async () => {
    await expect(
      副本.execute(
        `INSERT INTO question(id, stem, status, solution_grade, prov_type)
         VALUES ('q_BAD_SCAN','x','pending','no_solution','scan')`,
      ),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("prov_type='manual' 缺 created_by → 被 CHECK 拦（manual 不是无条件逃逸阀）", async () => {
    await expect(
      副本.execute(
        `INSERT INTO question(id, stem, status, solution_grade, prov_type)
         VALUES ('q_BAD_MANUAL','x','pending','no_solution','manual')`,
      ),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("kp.status='merged' 缺 merged_into → 被 CHECK 拦", async () => {
    await expect(
      副本.execute(
        `INSERT INTO kp(id, name, status) VALUES ('kp_BAD','坏考点','merged')`,
      ),
    ).rejects.toThrow(/CHECK|constraint/i);
  });

  it("同一 (subject, edition, grade_sem) 只允许一棵 active 树", async () => {
    await 副本.execute(
      `INSERT INTO edition_tree(id, subject, edition, grade_sem, version, status)
       VALUES ('et_1','数学','浙教','七上',1,'active')`,
    );
    await expect(
      副本.execute(
        `INSERT INTO edition_tree(id, subject, edition, grade_sem, version, status)
         VALUES ('et_2','数学','浙教','七上',2,'active')`,
      ),
    ).rejects.toThrow(/UNIQUE|constraint/i);
    // 换成 readonly 就放行（部分索引只管 active）
    await 副本.execute(
      `INSERT INTO edition_tree(id, subject, edition, grade_sem, version, status)
       VALUES ('et_3','数学','浙教','七上',3,'readonly')`,
    );
  });

  it("一道题至多一个主考点（idx_qkp_primary 部分唯一索引）", async () => {
    await 副本.execute(
      `INSERT INTO question(id, stem, status, solution_grade, prov_type, created_by)
       VALUES ('q_PK1','x','active','no_solution','manual','test')`,
    );
    await 副本.execute(
      `INSERT INTO kp(id, name, status) VALUES ('kp_1','考点一','active')`,
    );
    await 副本.execute(
      `INSERT INTO kp(id, name, status) VALUES ('kp_2','考点二','active')`,
    );
    await 副本.execute(
      `INSERT INTO question_kp(question_id, kp_id, is_primary) VALUES ('q_PK1','kp_1',1)`,
    );
    // 次考点可以再挂
    await 副本.execute(
      `INSERT INTO question_kp(question_id, kp_id, is_primary) VALUES ('q_PK1','kp_2',0)`,
    );
    // 第二个主考点不行
    await expect(
      副本.execute(
        `INSERT INTO question_kp(question_id, kp_id, is_primary) VALUES ('q_PK1','kp_2',1)`,
      ),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });
});
