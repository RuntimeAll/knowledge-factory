/**
 * 备份 / 对账 / 圣域只读（AI:PRD-001 · WP4）
 *
 * 沿用既有范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**。
 * 圣域 审核.db 更是只读——本文件对它只有 SELECT，一个字节都不写。
 *
 * 测试在精不在多，每道闸一红一绿：
 *   ① backupNow：快照打得开、行数与主库一致（备份本身也留了审计行）
 *   ② integrityCheck：空库六项无 red（C5 挂桥覆盖率按真圣域数据可能 warn，不算红）
 *   ③ 红旗三连：C1e 闸没关 / C2 悬挂引用 / C4a 圣域 schema 对不上
 *   ④ 🔴 圣域三道锁：没 mode=ro 不给连、非只读语句发不出去
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertGradingUrl,
  assertReadOnlyStatement,
  backupNow,
  createCoreDb,
  getGradingDb,
  gradingSchemaSnapshot,
  integrityCheck,
  newId,
  nowLocalISO,
  rowRefId,
  withCoreWrite,
  type CheckId,
  type CheckResult,
  type CoreDbHandle,
  type IntegrityReport,
} from "~/core";
import { kp, kpAlias } from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 每个用例一份一次性副本（tag 唯一）；备份产物落副本同级的 backup/ */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-wp4-${process.pid}-${tag}.db`);
  if (existsSync(p)) rmSync(p, { force: true });
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  副本清单.push(p);
  return createCoreDb(fileUrl(p));
}

function pick(report: IntegrityReport, id: CheckId): CheckResult {
  const c = report.checks.find((x) => x.id === id);
  expect(c, `报告里没有 ${id}`).toBeDefined();
  return c!;
}

/** red = 不 ok 且级别为 red；warn 不算 */
function reds(report: IntegrityReport): CheckId[] {
  return report.checks
    .filter((c) => !c.ok && c.level === "red")
    .map((c) => c.id);
}

beforeAll(() => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
});

afterAll(() => {
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

describe("① backupNow", () => {
  it("快照打得开、表数行数对得上，且备份自己留了审计行", async () => {
    const h = await 造副本("backup");
    try {
      // 先经 core 写一行，好让快照里有点内容可比
      await withCoreWrite(
        { actor: "system", tool: "test_seed", args: { n: 1 } },
        async (tx) => {
          await tx.insert(kp).values({
            id: newId("kp"),
            name: "被备份的考点",
            status: "active",
          });
          return [{ table: "kp", id: "seed", op: "insert" as const }];
        },
        h,
      );

      // 🔴 一律与基线比：真库跑过备份/对账就带着 metric + 审计行，副本自然继承
      const before = await h.client.execute(
        "SELECT (SELECT COUNT(*) FROM kp) AS kp, (SELECT COUNT(*) FROM audit_log) AS al, (SELECT COUNT(*) FROM metric_event) AS me",
      );
      const row = before.rows[0] as unknown as {
        kp: number;
        al: number;
        me: number;
      };

      const r = await backupNow({ reason: "manual" }, h);

      expect(existsSync(r.path)).toBe(true);
      expect(r.bytes).toBeGreaterThan(0);
      expect(r.tables).toBe(41); // WP2 基线：32 普通 + 6 FTS 家族 + 3 机制
      expect(r.snapshotRowCounts.kp).toBe(Number(row.kp));
      expect(r.snapshotRowCounts.audit_log).toBe(Number(row.al));
      // 没配异地就如实说跳过，不假装
      expect(r.remote).toBe("skipped(BACKUP_REMOTE_DIR unset)");
      expect(r.remotePath).toBeUndefined();

      // 🔴 备份完成后 logMetric → 主库比快照多一条审计行 + 一条 metric
      const after = await h.client.execute(
        "SELECT (SELECT COUNT(*) FROM audit_log) AS al, (SELECT COUNT(*) FROM metric_event) AS me",
      );
      const a = after.rows[0] as unknown as { al: number; me: number };
      expect(Number(a.al)).toBe(Number(row.al) + 1);
      expect(Number(a.me)).toBe(Number(row.me) + 1);

      // 快照真的能当库开
      const snap = createClient({ url: fileUrl(r.path) });
      try {
        const c = await snap.execute("SELECT COUNT(*) AS c FROM kp");
        expect(Number((c.rows[0] as unknown as { c: number }).c)).toBe(
          Number(row.kp),
        );
      } finally {
        snap.close();
      }
      副本清单.push(r.path);
    } finally {
      h.close();
    }
  });
});

describe("② integrityCheck · 空库", () => {
  it("六项跑通、无 red（C5 按真圣域数据可能 warn，warn 不拦）", async () => {
    const h = await 造副本("clean");
    try {
      const report = await integrityCheck({ handle: h });

      expect(report.checks.map((c) => c.id)).toEqual([
        "C1",
        "C2",
        "C3",
        "C4",
        "C5",
        "C6",
      ]);
      expect(
        reds(report),
        `不该有 red：${JSON.stringify(reds(report))}`,
      ).toEqual([]);
      expect(report.ok).toBe(true);
      expect(pick(report, "C1").ok).toBe(true);
      expect(pick(report, "C1").stats?.e_write_gate).toBe(0);
      expect(pick(report, "C4").ok).toBe(true); // 圣域 schema 与契约附件一致
      expect(pick(report, "C5").level).toBe("warn"); // 名义级别就是 warn
      expect(pick(report, "C6").ok).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("③ 红旗（每道闸一红）", () => {
  it("C1e：静息闸被裸 SQL 掰成 1 → red", async () => {
    const h = await 造副本("gate");
    try {
      // 裸连接把闸掰开（_write_gate 自己没有触发器——core 靠它开闸，给它上闸=自锁死）
      const 裸 = createClient({ url: h.url });
      try {
        await 裸.execute("UPDATE _write_gate SET allowed=1 WHERE id=1");
      } finally {
        裸.close();
      }

      const report = await integrityCheck({ handle: h });
      const c1 = pick(report, "C1");
      expect(c1.ok).toBe(false);
      expect(c1.level).toBe("red");
      expect(c1.stats?.e_write_gate).toBe(1);
      expect(c1.details.join("\n")).toContain("_write_gate.allowed=1");
      expect(report.ok).toBe(false);
      expect(reds(report)).toContain("C1");
    } finally {
      h.close();
    }
  });

  it("C2：kp_alias 指向 merged 考点 → red（且 C1a 仍绿，因为造数据也走 core）", async () => {
    const h = await 造副本("dangling");
    try {
      const 活 = newId("kp");
      const 并掉的 = newId("kp");
      const alias = "被合并考点的旧别名";

      await withCoreWrite(
        { actor: "human", tool: "test_make_dangling" },
        async (tx) => {
          await tx.insert(kp).values({
            id: 活,
            name: "合并目标",
            status: "active",
            createdAt: nowLocalISO(),
          });
          await tx.insert(kp).values({
            id: 并掉的,
            name: "被合并的",
            status: "merged",
            mergedInto: 活,
            createdAt: nowLocalISO(),
          });
          // 🔴 merge_kp 原语本该把这条别名重挂到「合并目标」，这里故意漏挂
          await tx.insert(kpAlias).values({ kpId: 并掉的, alias });
          return [
            { table: "kp", id: 活, op: "insert" as const },
            { table: "kp", id: 并掉的, op: "insert" as const },
            // 复合主键行的 id 口径 = rowRefId(各主键段)
            {
              table: "kp_alias",
              id: rowRefId(并掉的, alias),
              op: "insert" as const,
            },
          ];
        },
        h,
      );

      const report = await integrityCheck({ handle: h });
      const c2 = pick(report, "C2");
      expect(c2.ok).toBe(false);
      expect(c2.level).toBe("red");
      expect(c2.stats?.kp_alias).toBe(1);
      expect(c2.details.join("\n")).toContain("merged");
      // 造数据走了 core ⇒ 审计覆盖闭合，C1 不该被连累
      expect(pick(report, "C1").ok).toBe(true);
      expect(reds(report)).toEqual(["C2"]);
    } finally {
      h.close();
    }
  });

  it("C4a：契约附件里的 schemaHash 被篡改 → red", async () => {
    const h = await 造副本("snapshot");
    const 假快照 = join(tmpdir(), `kf-wp4-${process.pid}-fake-snapshot.json`);
    try {
      const real = await gradingSchemaSnapshot();
      writeFileSync(
        假快照,
        JSON.stringify({ ...real, schemaHash: "0".repeat(64) }, null, 2),
        "utf8",
      );

      const report = await integrityCheck({ handle: h, snapshotPath: 假快照 });
      const c4 = pick(report, "C4");
      expect(c4.ok).toBe(false);
      expect(c4.level).toBe("red");
      expect(c4.details.join("\n")).toContain("圣域 schema 变了");
      // 处置口径必须写在报告里：人工重新评估，不是自动跟进
      expect(c4.details.join("\n")).toContain("人工重新快照");
      expect(reds(report)).toEqual(["C4"]);
    } finally {
      h.close();
      try {
        rmSync(假快照, { force: true });
      } catch {
        /* 一次性文件 */
      }
    }
  });
});

describe("④ 🔴 圣域只读三道锁（G-1）", () => {
  it("声明锁：连接串没有 mode=ro 一律拒连，且不替人补", () => {
    expect(() => assertGradingUrl("file:D:/x/审核.db")).toThrow(/mode=ro/);
    expect(() => assertGradingUrl("")).toThrow(/GRADING_DB_URL/);
    expect(() => assertGradingUrl("sqlite:///x?mode=ro")).toThrow(/file:/);
    // 带了才给过，并解析出落地路径
    expect(assertGradingUrl("file:D:/x/审核.db?mode=ro")).toBe("D:/x/审核.db");
  });

  it("语句锁：只放行 SELECT/WITH/PRAGMA，写语句与多语句发不出去", async () => {
    for (const bad of [
      "INSERT INTO tasks(date) VALUES('x')",
      "UPDATE tasks SET nq=0",
      "DELETE FROM items",
      "CREATE TABLE zz(a)",
      "SELECT 1; DROP TABLE tasks",
    ]) {
      expect(() => assertReadOnlyStatement(bad), bad).toThrow(/圣域只读/);
    }
    expect(() => assertReadOnlyStatement("SELECT 1")).not.toThrow();
    expect(() => assertReadOnlyStatement("PRAGMA journal_mode")).not.toThrow();

    // 物理锁：真连上去也只读得到东西（这里顺带证明圣域连得通）
    const g = await getGradingDb();
    const rows = g.query<{ c: number }>("SELECT COUNT(*) AS c FROM tasks");
    expect(Number(rows[0]?.c)).toBeGreaterThanOrEqual(0);
    expect(() => g.query("DELETE FROM items")).toThrow(/圣域只读/);
  });
});
