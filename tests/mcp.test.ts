/**
 * MCP 壳（AI:PRD-001 · WP5）
 *
 * 沿用既有范式：**真库只读、行为测试全在 VACUUM INTO 出来的副本上跑** ——
 * backup_now 会真写文件，跑在真库上会往 data/backup/ 里堆测试垃圾，
 * 所以本文件在 beforeAll 里把 DATABASE_URL 指到临时副本（core 惰性读 env，
 * 只要在第一次 getCoreDb 之前改掉就生效）。圣域 GRADING_DB_URL 不动，
 * C4/C5 照旧对真 审核.db 只读。
 *
 * 测试在精不在多，只钉住「壳该负责的那几件事」：
 *   ① 注册表：route 导出 GET/POST，tools/list 真回三个工具（名字一字不差），
 *      且 backup_now 的 enum 里没有 pre-restore
 *   ② 只读两工具的成功外壳：ok:true + data 是 core 的原始报告
 *   ③ backup_now 默认 manual，且真落下一个快照文件
 *   ④ 🔴 异常不裸穿：库连不上时回错误契约而不是 throw
 *   ⑤ 序列化：BigInt 不炸 stringify（这坑会在 catch 之外炸成 transport 500）
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as route from "~/app/api/mcp/route";
import { closeCoreDb } from "~/core";
import {
  classifyToolError,
  payloadToText,
  runBackupNow,
  runHealth,
  runIntegrityCheck,
  type ToolPayload,
} from "~/app/api/mcp/tools";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
let 沙盒: string;

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

beforeAll(async () => {
  沙盒 = mkdtempSync(join(tmpdir(), "kf-wp5-"));
  const 副本 = join(沙盒, "资料库.db");
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${副本.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  process.env.DATABASE_URL = fileUrl(副本);
});

afterAll(async () => {
  await closeCoreDb();
  // Windows 句柄释放晚于 close()，删不掉不算失败（只是 %TEMP% 里的一次性沙盒），
  // 与 tests/backup-integrity.test.ts 同一处置
  try {
    if (沙盒) rmSync(沙盒, { recursive: true, force: true });
  } catch {
    /* 随它去 */
  }
});

/** 打一发 JSON-RPC 到真 handler（2025-era 无状态路径），把 SSE 里的那条 data 抠出来 */
async function rpc(body: unknown): Promise<Record<string, unknown>> {
  const res = await route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(line ?? text) as Record<string, unknown>;
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { enum?: string[] }> };
}

describe("MCP 壳 · 注册表", () => {
  it("route 导出 GET/POST（同一个 handler），tools/list 回五个工具", async () => {
    expect(typeof route.GET).toBe("function");
    expect(typeof route.POST).toBe("function");
    expect(route.GET).toBe(route.POST); // 2.x 一个 handler 通吃，不再分 SSE/message 两条路

    const r = (await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })) as { result?: { tools?: ListedTool[] } };
    const tools = r.result?.tools ?? [];

    // 🔴 基线随卡增长：001 三个系统工具 + 002-C 两个考点工具
    expect(tools.map((t) => t.name)).toEqual([
      "health",
      "integrity_check",
      "backup_now",
      "resolve_kp",
      "kp_context",
    ]);
    // 描述是给 agent 看的，不许空
    for (const t of tools) expect(t.description ?? "").not.toBe("");

    // 🔴 pre-restore 是恢复演练内部专用，绝不能出现在对外 schema 里
    const reasons =
      tools.find((t) => t.name === "backup_now")?.inputSchema?.properties
        ?.reason?.enum ?? [];
    expect(reasons).toEqual(["daily", "batch", "manual"]);
    expect(reasons).not.toContain("pre-restore");
  });
});

describe("MCP 壳 · 三工具", () => {
  it("health / integrity_check：ok:true 外壳里裹着 core 的原始报告", async () => {
    const h = await runHealth();
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.tool).toBe("health");
    expect(h.data.tableCount).toBeGreaterThan(0);
    expect(h.data.gateResting).toBe(true);
    expect(h.data.chain).toBeUndefined(); // deep 默认 false
    expect((await runHealth({ deep: true })).ok && true).toBe(true);

    const i = await runIntegrityCheck();
    expect(i.ok).toBe(true);
    if (!i.ok) return;
    // 🔴 外壳 ok=true 只说「调用跑通了」；六项齐全才算报告完整，
    //    data.ok 是不是 true 取决于真数据，这里不断言它
    expect(i.data.checks.map((c) => c.id)).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6",
    ]);
  });

  it("backup_now：不传 reason 默认 manual，且真落下一个快照文件", async () => {
    const r = await runBackupNow();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.reason).toBe("manual");
    expect(existsSync(r.data.path)).toBe(true);
    expect(r.data.bytes).toBeGreaterThan(0);
    expect(r.data.tables).toBeGreaterThan(0);
    expect(readdirSync(join(沙盒, "backup"))).toContain(
      r.data.path.split(/[\\/]/).pop(),
    );
    // 没配 BACKUP_REMOTE_DIR 时必须如实说跳过，不许静默
    expect(r.data.remote).toMatch(/^skipped\(/);
  });
});

describe("MCP 壳 · 错误契约（REG-G2）", () => {
  it("🔴 异常不裸穿：库连不上时回 {ok:false,code,message,recoverable} 而不是 throw", async () => {
    vi.resetModules(); // 换一套全新模块图，绕开已建好的 core 单例
    const 存 = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const fresh = await import("~/app/api/mcp/tools");
      const r = await fresh.runHealth();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe("CONFIG_MISSING");
      expect(r.recoverable).toBe(false);
      expect(r.message).toContain("DATABASE_URL");
      expect(r.message).toContain(".env"); // 「怎么改」必须写在 message 里
    } finally {
      process.env.DATABASE_URL = 存;
      vi.resetModules();
    }
  });

  it("分类表：锁库可重试、路径不对不可重试、认不出的落 INTERNAL 但不吞原文", () => {
    const busy = classifyToolError(
      "backup_now",
      new Error("SQLITE_BUSY: database is locked"),
    );
    expect([busy.code, busy.recoverable]).toEqual(["DB_BUSY", true]);

    const gone = classifyToolError(
      "health",
      new Error("failed to connect", {
        cause: new Error("SQLITE_CANTOPEN: unable to open database file"),
      }),
    );
    expect([gone.code, gone.recoverable]).toEqual(["DB_UNREACHABLE", false]);
    expect(gone.message).toContain("SQLITE_CANTOPEN"); // cause 里的真凶不许丢

    const 意外 = classifyToolError("integrity_check", "喵");
    expect(意外.code).toBe("INTERNAL");
    expect(意外.message).toContain("喵");
  });

  it("payloadToText：BigInt 不炸 stringify（这坑炸在 catch 之外 = 真 500）", () => {
    const payload = {
      ok: true,
      tool: "health",
      data: { 小: 7n, 大: 12345678901234567890n },
    } as unknown as ToolPayload<unknown>;
    const parsed = JSON.parse(payloadToText(payload)) as {
      data: { 小: number; 大: string };
    };
    expect(parsed.data.小).toBe(7);
    expect(parsed.data.大).toBe("12345678901234567890"); // 超安全整数转字符串保精度
  });
});
