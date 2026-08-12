/**
 * core 业务层闸（AI:PRD-001 · WP3）
 *
 * 沿用 schema.test.ts 的范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**。
 * audit_log 是 append-only 的，往真库里插一行就再也拿不出来了。
 *
 * 精选不堆量，只钉五件必须永远成立的事：
 *   ① withCoreWrite 正常路：业务行 + 审计行同事务落地，闸自己关回 0；
 *   ② withCoreWrite 异常路：回滚得干净——业务没写、审计没长、闸=0（不留敞开的闸）；
 *   ③ 审计链：创世口径 + 规范化串口径（字面量钉死）+ 篡改必被 verifyAuditChain 抓到；
 *   ④ 裸写：不经 core 直接 UPDATE 一律被触发器打回；
 *   ⑤ ids / time 形状。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUDIT_CHAIN_VERSION,
  AUDIT_GENESIS_HASH,
  AUDIT_GENESIS_SEED,
  canonicalAuditString,
  createCoreDb,
  digestArgs,
  health,
  ID_PREFIXES,
  isId,
  isLocalISO,
  logMetric,
  newId,
  nowLocalISO,
  parseIdPrefix,
  readWriteGate,
  runGates,
  sha256Hex,
  verifyAuditChain,
  withCoreWrite,
  type CoreDbHandle,
  type Gate,
} from "~/core";
import { roster } from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 每份副本一个文件；forge 测试要单独一份（伪造行会把链永久弄断） */
const 副本清单: string[] = [];

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-core-test-${process.pid}-${tag}.db`);
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

let 主副本: CoreDbHandle;
/** 裸连接：模拟「agent 拿 sqlite3 直连上来乱改」 */
let 裸连接: Client;

beforeAll(async () => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
  主副本 = await 造副本("main");
  裸连接 = createClient({ url: 主副本.url });
});

afterAll(() => {
  裸连接?.close();
  主副本?.close();
  // Windows 句柄释放晚于 close()（libsql 每开一次事务还会换一条连接），删不掉不算失败
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      for (let i = 0; i < 5 && existsSync(p); i++) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* 只是 %TEMP% 里的一次性副本，删不掉就算了 */
        }
      }
    }
  }
});

async function 计数(handle: CoreDbHandle, table: string): Promise<number> {
  const r = await handle.client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number((r.rows[0] as unknown as { c: number }).c);
}

// ---------------------------------------------------------------------------

/**
 * 🔴 本文件所有断言一律「与基线相对」，不假设真库是空的：
 *    库是活的——WP4 起，跑一次备份/对账就会留下 metric + 审计行，
 *    副本自然带着它们。写死 seq=1 / count=1 的断言会被自己的产品行为打红。
 */
let 首笔审计seq = 0;

describe("① withCoreWrite 正常路", () => {
  it("业务行 + 审计行同事务落地，闸自己关回 0", async () => {
    const before = await 计数(主副本, "audit_log");

    const receipt = await withCoreWrite(
      { actor: "agent", tool: "test_upsert_roster", args: { code: "stu_a" } },
      async (tx) => {
        await tx
          .insert(roster)
          .values({ code: "stu_a", alias: "甲同学", status: "active" });
        return [{ table: "roster", id: "stu_a", op: "insert" as const }];
      },
      主副本,
    );

    expect(receipt.seq).toBeGreaterThan(0);
    expect(await 计数(主副本, "roster")).toBe(1);
    expect(await 计数(主副本, "audit_log")).toBe(before + 1);
    // 🔴 静息态永远 0
    expect(await readWriteGate(主副本)).toBe(0);
    首笔审计seq = receipt.seq;
  });

  it("链首 prev_hash = 创世哈希；本次写的那行 args/rowRefs 如实落库", async () => {
    // 链首那行永远该带创世哈希（不管它是不是本次写的）
    const head = await 主副本.client.execute(
      "SELECT prev_hash FROM audit_log ORDER BY seq LIMIT 1",
    );
    expect((head.rows[0] as unknown as { prev_hash: string }).prev_hash).toBe(
      AUDIT_GENESIS_HASH,
    );

    // 本次写的那行按 seq 精确取（不假设它就是 seq=1）
    const r = await 主副本.client.execute(
      `SELECT seq, actor, tool, args_digest, row_refs_json, gate_results_json, prev_hash, hmac FROM audit_log WHERE seq=${首笔审计seq}`,
    );
    const row = r.rows[0] as unknown as {
      seq: number;
      actor: string;
      tool: string;
      args_digest: string;
      row_refs_json: string;
      gate_results_json: string | null;
      prev_hash: string;
      hmac: string | null;
    };
    expect(Number(row.seq)).toBe(首笔审计seq);
    expect(row.actor).toBe("agent");
    expect(row.tool).toBe("test_upsert_roster");
    expect(row.args_digest).toBe(digestArgs({ code: "stu_a" }));
    expect(JSON.parse(row.row_refs_json)).toEqual([
      { table: "roster", id: "stu_a", op: "insert" },
    ]);
    // 没跑闸就是 null，不拿 "{}" 冒充跑过；hmac 本卡留 NULL（默认纯链）
    expect(row.gate_results_json).toBeNull();
    expect(row.hmac).toBeNull();
  });

  it("闸开着时 UPDATE 能过：改一行 roster + 链继续接得上", async () => {
    await withCoreWrite(
      { actor: "human", tool: "test_rename_roster" },
      async (tx) => {
        await tx.run(sql`UPDATE roster SET alias='甲改名' WHERE code='stu_a'`);
        return [{ table: "roster", id: "stu_a", op: "update" as const }];
      },
      主副本,
    );

    const r = await 主副本.client.execute(
      "SELECT alias FROM roster WHERE code='stu_a'",
    );
    expect((r.rows[0] as unknown as { alias: string }).alias).toBe("甲改名");

    const chain = await verifyAuditChain(主副本);
    expect(chain.ok, chain.reason).toBe(true);
    expect(chain.checkedRows).toBe(await 计数(主副本, "audit_log"));
  });

  it("logMetric 也走同一条写路：metric_event +1 且必留审计行", async () => {
    const beforeAudit = await 计数(主副本, "audit_log");
    const beforeMetric = await 计数(主副本, "metric_event");
    const m = await logMetric("gate_pass", "stu_a", { n: 1 }, 主副本);
    expect(m.id).toBeGreaterThan(0);
    expect(await 计数(主副本, "metric_event")).toBe(beforeMetric + 1);
    expect(await 计数(主副本, "audit_log")).toBe(beforeAudit + 1);
    expect(await readWriteGate(主副本)).toBe(0);
  });

  it("health()：闸静息、链尾对得上、journal_mode 如实上报", async () => {
    const h = await health({ deep: true }, 主副本);
    expect(h.ok).toBe(true);
    expect(h.gateResting).toBe(true);
    expect(h.writeGate).toBe(0);
    expect(h.tableCount).toBe(41); // WP2 基线：32 普通 + 6 FTS 家族 + 3 机制
    expect(h.auditHeadSeq).toBe(await 计数(主副本, "audit_log"));
    expect(h.foreignKeys).toBe(true);
    expect(h.busyTimeoutMs).toBe(5000);
    expect(h.journalMode).toBe("delete"); // 🔴 现状；切 WAL 是总指挥层面的事
    expect(h.chain?.ok).toBe(true);
  });
});

describe("② withCoreWrite 异常路（回滚得干净）", () => {
  it("回调抛错：业务没写、审计没长、闸=0、错原样上抛", async () => {
    const rosterBefore = await 计数(主副本, "roster");
    const auditBefore = await 计数(主副本, "audit_log");

    await expect(
      withCoreWrite(
        { actor: "agent", tool: "test_boom" },
        async (tx) => {
          await tx
            .insert(roster)
            .values({ code: "stu_boom", alias: "不该存在", status: "active" });
          throw new Error("业务写到一半炸了");
        },
        主副本,
      ),
    ).rejects.toThrow("业务写到一半炸了");

    expect(await 计数(主副本, "roster")).toBe(rosterBefore);
    expect(await 计数(主副本, "audit_log")).toBe(auditBefore);
    // 🔴 关键：闸随事务一起回滚，不存在「崩在开闸态」
    expect(await readWriteGate(主副本)).toBe(0);

    const gone = await 主副本.client.execute(
      "SELECT COUNT(*) AS c FROM roster WHERE code='stu_boom'",
    );
    expect(Number((gone.rows[0] as unknown as { c: number }).c)).toBe(0);
  });

  it("炸完之后写路还能用（写队列没被毒死）", async () => {
    const receipt = await withCoreWrite(
      { actor: "system", tool: "test_after_boom" },
      async (tx) => {
        await tx
          .insert(roster)
          .values({ code: "stu_b", alias: "乙同学", status: "active" });
        return [{ table: "roster", id: "stu_b", op: "insert" as const }];
      },
      主副本,
    );
    expect(receipt.seq).toBeGreaterThan(0);
    expect((await verifyAuditChain(主副本)).ok).toBe(true);
  });
});

describe("③ 审计链口径与防篡改", () => {
  it("🔴 规范化串口径字面量钉死（改了这条断言 = 换库）", () => {
    expect(AUDIT_CHAIN_VERSION).toBe("kb-audit/v1");
    expect(AUDIT_GENESIS_SEED).toBe("kb-audit/v1:genesis:资料库.db");
    expect(AUDIT_GENESIS_HASH).toBe(sha256Hex("kb-audit/v1:genesis:资料库.db"));

    expect(
      canonicalAuditString({
        seq: 7,
        ts: "2026-08-12T15:04:05+08:00",
        actor: "agent",
        tool: "ingest_items",
        argsDigest: "abc",
        gateResultsJson: null,
        rowRefsJson: '[{"table":"question","id":"q_1","op":"insert"}]',
        prevHash: "deadbeef",
      }),
    ).toBe(
      '["kb-audit/v1",7,"2026-08-12T15:04:05+08:00","agent","ingest_items","abc",null,"[{\\"table\\":\\"question\\",\\"id\\":\\"q_1\\",\\"op\\":\\"insert\\"}]","deadbeef"]',
    );
  });

  it("🔴 audit_log 开着闸也改不动、删不掉（无条件触发器）", async () => {
    await 裸连接.execute("UPDATE _write_gate SET allowed=1 WHERE id=1");
    await expect(
      裸连接.execute("UPDATE audit_log SET tool='篡改' WHERE seq=1"),
    ).rejects.toThrow(/append-only/);
    await expect(
      裸连接.execute("DELETE FROM audit_log WHERE seq=1"),
    ).rejects.toThrow(/append-only/);
    await 裸连接.execute("UPDATE _write_gate SET allowed=0 WHERE id=1");
    expect(await readWriteGate(主副本)).toBe(0);
  });

  it("🔴 改不动就只能伪造：直接 INSERT 一行假审计 → verifyAuditChain 必红", async () => {
    // 触发器只拦 UPDATE/DELETE，INSERT 是放行的（append-only 的代价）。
    // 所以「插一行接不上的」是唯一可行的攻击面 —— 而它正是哈希链要抓的东西。
    const forge = await 造副本("forge");
    try {
      const 基线 = await 计数(forge, "audit_log");
      const 种子 = await withCoreWrite(
        { actor: "agent", tool: "test_seed" },
        async (tx) => {
          await tx
            .insert(roster)
            .values({ code: "stu_x", alias: "x", status: "active" });
          return [{ table: "roster", id: "stu_x", op: "insert" as const }];
        },
        forge,
      );
      expect((await verifyAuditChain(forge)).ok).toBe(true);

      await forge.client.execute(
        `INSERT INTO audit_log(ts, actor, tool, args_digest, prev_hash)
         VALUES ('2026-08-12T00:00:00+08:00','agent','偷偷加的一行','x','伪造的prev_hash')`,
      );

      const chain = await verifyAuditChain(forge);
      expect(chain.ok).toBe(false);
      // 伪造的那行紧跟在种子行后面
      expect(chain.brokenAtSeq).toBe(种子.seq + 1);
      expect(chain.reason).toContain("prev_hash");
      // 断链之前的行仍然是校验过的（基线那些 + 种子这一条）
      expect(chain.checkedRows).toBe(基线 + 1);
    } finally {
      forge.close();
    }
  });
});

describe("④ 裸写被拦（不经 core 就改不动）", () => {
  it("裸连接 UPDATE / DELETE roster 一律 RAISE", async () => {
    await expect(
      裸连接.execute("UPDATE roster SET alias='裸改' WHERE code='stu_a'"),
    ).rejects.toThrow(/裸/);
    await expect(
      裸连接.execute("DELETE FROM roster WHERE code='stu_a'"),
    ).rejects.toThrow(/roster/);

    const r = await 裸连接.execute(
      "SELECT alias FROM roster WHERE code='stu_a'",
    );
    expect((r.rows[0] as unknown as { alias: string }).alias).toBe("甲改名");
  });
});

describe("⑤ ids / time / gates 骨架", () => {
  it("newId：前缀 + 26 位 Crockford ULID", () => {
    for (const p of ID_PREFIXES) {
      const id = newId(p);
      expect(id.startsWith(`${p}_`)).toBe(true);
      expect(id.slice(p.length + 1)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(isId(id, p)).toBe(true);
      expect(parseIdPrefix(id)).toBe(p);
    }
    expect(isId("kp_不是ULID")).toBe(false);
    expect(isId("nope_01J000000000000000000000")).toBe(false);
    // 前缀对不上也算不合规（防止把 q_ 当 kp_ 用）
    expect(isId(newId("q"), "kp")).toBe(false);
  });

  it("nowLocalISO：本地时区偏移形式，不是 UTC 的 Z", () => {
    const ts = nowLocalISO();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(ts.endsWith("Z")).toBe(false);
    expect(isLocalISO(ts)).toBe(true);
    expect(isLocalISO("2026-08-12T15:04:05Z")).toBe(false);
    // 解析回去要是同一时刻
    expect(new Date(ts).getFullYear()).toBe(new Date().getFullYear());
  });

  it("runGates：逐项有账，失败带错误契约 shape", async () => {
    const 过: Gate<number> = { name: "总是过", run: () => ({ ok: true }) };
    const 红: Gate<number> = {
      name: "考点必须存在",
      run: (n) =>
        n > 0
          ? { ok: true }
          : {
              ok: false,
              code: "KP_NOT_FOUND",
              message: "kp_id 不存在，先用 resolve_kp 查真叶子",
              recoverable: true,
              nextTool: "resolve_kp",
              candidates: [{ id: "kp_1", label: "绝对值", score: 0.82 }],
            },
    };

    const 绿 = await runGates([过, 红], 1);
    expect(绿.ok).toBe(true);
    expect(绿.items.map((i) => i.name)).toEqual(["总是过", "考点必须存在"]);

    const 报告 = await runGates([过, 红, 过], 0);
    expect(报告.ok).toBe(false);
    expect(报告.total).toBe(3);
    expect(报告.passed).toBe(2);
    expect(报告.failed).toBe(1);
    expect(报告.items).toHaveLength(3); // 🔴 默认跑完全部：页页有账
    expect(报告.firstFailure?.code).toBe("KP_NOT_FOUND");
    expect(报告.firstFailure?.recoverable).toBe(true);
    expect(报告.firstFailure?.candidates?.[0]?.id).toBe("kp_1");

    const 急停 = await runGates([红, 过, 过], 0, { stopOnFail: true });
    expect(急停.items).toHaveLength(1);
    expect(急停.skipped).toBe(2);
  });
});
