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
import { closeCoreDb, createKp } from "~/core";
import {
  classifyToolError,
  payloadToText,
  runBackupNow,
  runGetQuestion,
  runHealth,
  runIntegrityCheck,
  runKpContext,
  runResolveKp,
  runSearchQuestions,
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
  inputSchema?: {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
}

describe("MCP 壳 · 注册表", () => {
  it("route 导出 GET/POST（同一个 handler），tools/list 回十个工具", async () => {
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

    // 🔴 基线随卡增长：001 三个系统工具 + 002-C 两个考点工具 + 003-D 三个录题工具
    //    + 004-B 两个检索工具 = 10
    expect(tools.map((t) => t.name)).toEqual([
      "health",
      "integrity_check",
      "backup_now",
      "resolve_kp",
      "kp_context",
      "kb_ingest",
      "propose_question",
      "get_ingest_batch",
      "search_questions",
      "get_question",
    ]);
    // 描述是给 agent 看的，不许空
    for (const t of tools) expect(t.description ?? "").not.toBe("");

    // 🔴 pre-restore 是恢复演练内部专用，绝不能出现在对外 schema 里
    const reasons =
      tools.find((t) => t.name === "backup_now")?.inputSchema?.properties
        ?.reason?.enum ?? [];
    expect(reasons).toEqual(["daily", "batch", "manual"]);
    expect(reasons).not.toContain("pre-restore");

    // 🔴 kb_ingest 的入参 schema 是 core 契约正本（ingest-schema.ts）长出来的，
    //    不是这儿抄的第二份 —— 抄一份迟早跟契约漂，这条断言就是漂移闸。
    const ingest = tools.find((t) => t.name === "kb_ingest");
    expect(Object.keys(ingest?.inputSchema?.properties ?? {})).toEqual([
      "contract",
      "source",
      "sourceDoc",
      "items",
      "dry_run",
    ]);
    expect(ingest?.inputSchema?.required).toEqual([
      "contract",
      "source",
      "items",
    ]);

    // 🔴 同一条漂移闸盯着检索：search_questions 的入参 schema 是 core 的
    //    searchParamsSchema 长出来的，不是这儿抄的第二份。
    //    字段少一个 = 有人在 core 加了参数却没让工具吃到（agent 传了会被静默忽略）。
    const search = tools.find((t) => t.name === "search_questions");
    expect(Object.keys(search?.inputSchema?.properties ?? {})).toEqual([
      "kpIds",
      "primaryOnly",
      "difficulty",
      "qtype",
      "solutionGrade",
      "editionScope",
      "keywords",
      // 004-C 追加：考点用词落靶（本工具默认开，见 route.ts 的工具描述）
      "kpAutoResolve",
      "semanticQuery",
      "excludeQuestionIds",
      "statuses",
      "limit",
    ]);
    // 🔴 全可选：一个参数都不给 = 「把库里能出题的题按稳定序列给我」，是合法查询
    expect(search?.inputSchema?.required ?? []).toEqual([]);
    expect(
      Object.keys(
        tools.find((t) => t.name === "get_question")?.inputSchema?.properties ??
          {},
      ),
    ).toEqual(["question_id"]);
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

describe("MCP 壳 · 考点两工具（AI:PRD-002 · 002-C）", () => {
  it("resolve_kp：精确命中 1.0，外壳裹着 core 的原始结果", async () => {
    await createKp({ name: "绝对值" });
    const r = await runResolveKp({ query: "绝对值" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tool).toBe("resolve_kp");
    expect(r.data.candidates[0]?.confidence).toBe(1);
    expect(r.data.candidates[0]?.matchedVia).toBe("exact-name");
    expect(r.data.lowConfidence).toBe(false);
  });

  it("🔴 REG-B4：编造 kp_id → ok:false / KP_NOT_FOUND / recoverable / 错误体带 candidates", async () => {
    const r = await runKpContext({ kp_id: "kp_绝对值" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("KP_NOT_FOUND");
    expect(r.recoverable).toBe(true);
    expect(r.candidates?.length).toBeGreaterThan(0);
    // 🔴 候选要能原样穿过 JSON 序列化到 agent 手里（BigInt/循环引用之类别在这翻车）
    const parsed = JSON.parse(payloadToText(r)) as {
      candidates: { kpId: string }[];
    };
    expect(parsed.candidates[0]!.kpId).toBe(r.candidates![0]!.kpId);
  });

  it("resolve_kp 空查询串 → INVALID_INPUT（KgError 翻得成工具码）", async () => {
    const r = await runResolveKp({ query: "   " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });
});

describe("MCP 壳 · 检索两工具（AI:PRD-004 · 004-B）", () => {
  it("search_questions：命中带**来源标注**，wire 上是瘦身版 + 指路全文", async () => {
    const r = await runSearchQuestions({ keywords: "最小值", limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tool).toBe("search_questions");
    expect(r.data.hits.length).toBeGreaterThan(0);
    expect(r.data.axes.fts.active).toBe(true);
    expect(r.data.axes.fts.op).toBe("and");

    const hit = r.data.hits[0]!;
    // 🔴 来源标注是这个工具的主要价值之一：agent 挑题时看得见"为什么它在这儿"
    expect(hit.sources.fts?.rank).toBe(1);
    // 主考点带 ★
    expect(hit.kps.some((k) => k.startsWith("★"))).toBe(true);
    // 🔴 瘦身：wire 上不驮全文（stemBrief 有、answer/analysis 一个字都没有）
    expect(hit.stemBrief.length).toBeGreaterThan(0);
    expect(hit).not.toHaveProperty("stem");
    expect(hit).not.toHaveProperty("answer");
    expect(hit).not.toHaveProperty("analysis");
    // 明确告诉 agent 全文去哪儿取
    expect(r.data.fullText).toContain("get_question");
    expect(r.data.fullText).toContain(hit.questionId);
  });

  it("零命中不是失败：ok:true + 一句怎么放宽的人话", async () => {
    const r = await runSearchQuestions({ keywords: "洛必达法则" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits).toEqual([]);
    expect(r.data.total).toBe(0);
    expect(r.data.fullText).toContain("零命中");
  });

  it("get_question：全文卡片，答案解析都在", async () => {
    const s = await runSearchQuestions({ keywords: "最小值", limit: 1 });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const id = s.data.hits[0]!.questionId;

    const r = await runGetQuestion({ question_id: id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.id).toBe(id);
    expect(r.data.stem.length).toBeGreaterThan(0);
    expect(r.data.kps.filter((k) => k.isPrimary).length).toBe(1);
    expect(r.data.provenance.type).toBeTruthy();
  });

  it("🔴 编造的 question_id → QUESTION_NOT_FOUND / recoverable / candidates **空**", async () => {
    const r = await runGetQuestion({ question_id: "q_我编的" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("QUESTION_NOT_FOUND");
    expect(r.recoverable).toBe(true);
    // 🔴 与 KP_NOT_FOUND 的关键差别：题 id 是纯 ULID，猜不出近似的，
    //    所以如实给空数组 + 在 message 里指路，而不是硬凑几个"最像的题"
    expect(r.candidates).toEqual([]);
    expect(r.message).toContain("search_questions");
    // 空 candidates 也要能原样穿过 JSON 序列化
    const parsed = JSON.parse(payloadToText(r)) as { candidates: unknown[] };
    expect(parsed.candidates).toEqual([]);
  });

  it("入参不合法 → INVALID_INPUT（RetrievalError 翻得成工具码）", async () => {
    const r = await runSearchQuestions({ difficulty: { min: 5, max: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.recoverable).toBe(true);
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
