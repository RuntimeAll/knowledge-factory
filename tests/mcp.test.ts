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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  runCheckDuplicate,
  runFindSimilar,
  runGetQuestion,
  runGroupKpStats,
  runHealth,
  runIntegrityCheck,
  runKpContext,
  runMapGradingTask,
  runProposeModel,
  runRegisterSku,
  runResolveKp,
  runSearchQuestions,
  runStudentView,
  type ToolPayload,
} from "~/app/api/mcp/tools";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
let 沙盒: string;
/** 产线用例之间传递的两个 id（register_sku 那条用例先建出来） */
let 实测册 = "";
let 实测题 = "";

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
  it("route 导出 GET/POST（同一个 handler），tools/list 回十七个工具", async () => {
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
    //    + 004-B 两个检索工具 + 005-B 五个产线工具 + 006-B 两个学情工具 = 17
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
      "register_sku",
      "map_grading_task",
      "propose_model",
      "check_duplicate",
      "find_similar",
      "student_view",
      "group_kp_stats",
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
      // 🆕 AI:PRD-008（2026-08-14）：录入批次硬过滤 —— 设计稿 §二·2 的搜索区
      //    逐项列了它，core 侧补进 searchParamsSchema，工具面自动跟着长出来。
      "ingestBatchIds",
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

    // 🔴 产线工具的必填面也是一条漂移闸：map_grading_task 的 task_id **必须必填** ——
    //    它一旦变成可选，rowid 自增出来的幽灵映射就又有路可走了（005-B 文件头那条纪律）。
    const mapTool = tools.find((t) => t.name === "map_grading_task");
    expect(mapTool?.inputSchema?.required).toEqual(["task_id", "sku_id"]);
    expect(
      tools.find((t) => t.name === "propose_model")?.inputSchema?.required,
    ).toEqual(["kp", "name", "dsl_ref"]);

    // 🔴 学情两工具（006-B）的入参面也当漂移闸：
    //    student_view 的 code **必填**（学员代号；少了它就成了「随便给我看点学情」），
    //    group_kp_stats **全可选**（不给参数 = 全库群错误率，是合法查询）。
    const sv = tools.find((t) => t.name === "student_view");
    expect(Object.keys(sv?.inputSchema?.properties ?? {})).toEqual([
      "code",
      "line",
      // 🔴 006-C 加：学情报告一天一份，不按批次筛就把好几天并成一行 perKp
      "batch_id",
    ]);
    expect(sv?.inputSchema?.required).toEqual(["code"]);
    const gk = tools.find((t) => t.name === "group_kp_stats");
    expect(Object.keys(gk?.inputSchema?.properties ?? {})).toEqual([
      "kp_ids",
      "line",
    ]);
    expect(gk?.inputSchema?.required ?? []).toEqual([]);
    // 🔴 描述里必须写着「代号不是真名」——这条纪律靠工具描述传给 agent
    expect(sv?.description ?? "").toMatch(/代号/);
    expect(sv?.description ?? "").toMatch(/不是真名/);
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

describe("MCP 壳 · 产线五工具（AI:PRD-005 · 005-B）", () => {
  it("register_sku：一次编排（建册 + 装题 + 登记产出），steps 说得出每一步", async () => {
    const s = await runSearchQuestions({ keywords: "最小值", limit: 2 });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const ids = s.data.hits.map((x) => x.questionId);
    expect(ids.length).toBeGreaterThanOrEqual(1);

    const 件 = join(沙盒, "mcp-单测题目卷.pdf");
    writeFileSync(件, "%PDF-1.4 MCP 单测的假 PDF\n");

    const r = await runRegisterSku({
      type: "专项",
      name: "MCP 单测·绝对值最值专项",
      recipe: { 来源: "mcp.test", 题量: ids.length },
      edition_ctx: "人教七上",
      items: ids.map((id, i) => ({ question_id: id, ord: i + 1 })),
      outputs: [{ kind: "pdf_q", file_path: 件, note: "单测件" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.steps.length).toBe(3); // 建册 / 装题 / 登记产出
    expect(r.data.sku.status).toBe("draft"); // 🔴 登记≠上架
    expect(r.data.sku.counts.items).toBe(ids.length);
    expect(r.data.sku.outputs[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    实测册 = r.data.skuId;
    实测题 = ids[0]!;

    // 编造的题 id → QUESTION_NOT_FOUND（candidates 恒空，和检索侧一条路）
    const bad = await runRegisterSku({
      sku_id: r.data.skuId,
      items: [{ question_id: "q_我编的", ord: 99 }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("QUESTION_NOT_FOUND");
  });

  it("🔴 map_grading_task：圣域没有那条 task ⇒ 拒（幽灵映射防线的工具面）", async () => {
    const r = await runMapGradingTask({ task_id: 999999, sku_id: 实测册 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
    expect(r.recoverable).toBe(true);
    expect(r.message).toContain("tasks");
  });

  it("propose_model：考点不精确 → KP_NOT_FOUND，错误体里带候选（能自愈）", async () => {
    // 「绝对值的化简」不是任何考点的全名（真名是「绝对值的化简与去号」，0.917）——
    // 🔴 登记模型只认 1.0：像不算数，但要把最像的那几个交回去让 agent 改对
    const r = await runProposeModel({
      kp: "绝对值的化简",
      name: "MCP 单测·差一点的说法",
      dsl_ref: "单测/_源/qbank.py#T_x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("KP_NOT_FOUND");
    expect(r.recoverable).toBe(true);
    // 🔴 「不存在」三个字对 agent 没用，最近似的真考点才有用
    expect(r.candidates?.length).toBeGreaterThan(0);
    expect(r.candidates![0]!.name).toContain("绝对值");

    // 纯编的说法：候选如实为空 + message 说清楚「词表里没有这个说法」
    const 编 = await runProposeModel({
      kp: "绝对值宇宙无敌考点",
      name: "MCP 单测·瞎挂考点",
      dsl_ref: "单测/_源/qbank.py#T_y",
    });
    expect(编.ok).toBe(false);
    if (编.ok) return;
    expect(编.code).toBe("KP_NOT_FOUND");
    expect(编.message).toContain("词表里没有这个说法");
  });

  it("check_duplicate：撞了要说得出撞的是哪本册子（不是只报一个 id）", async () => {
    const q = await runGetQuestion({ question_id: 实测题 });
    expect(q.ok).toBe(true);
    if (!q.ok) return;

    const r = await runCheckDuplicate({ stem: q.data.stem, similar_limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.collision).toBe(true);
    expect(r.data.matchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(r.data.hits[0]?.questionId).toBe(实测题);
    expect(r.data.hits[0]?.skus.map((x) => x.name)).toContain(
      "MCP 单测·绝对值最值专项",
    );

    // 库里绝对没有的题面 ⇒ collision=false（"查过了、没撞"是有用的结论）
    const 干净 = await runCheckDuplicate({
      stem: "MCP 单测·库里绝没有的题：把 2026 拆成三个连续偶数之和。",
    });
    expect(干净.ok).toBe(true);
    if (!干净.ok) return;
    expect(干净.data.collision).toBe(false);
    expect(干净.data.hits).toEqual([]);
  });

  it("find_similar：拿一道题找最像的（004 遗留 C16 的工具面）", async () => {
    const r = await runFindSimilar({ question_id: 实测题, limit: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.questionId).toBe(实测题);
    // 🔴 语意轴降级时 hits 恒空且 degraded=true —— 那是「这次没查」，不是「没有相似题」
    if (!r.data.degraded) {
      expect(r.data.hits.length).toBeGreaterThan(0);
      expect(r.data.hits.every((x) => x.questionId !== 实测题)).toBe(true); // 排除自身
      expect(r.data.hits[0]!.score).toBeLessThanOrEqual(1);
    }

    const bad = await runFindSimilar({ question_id: "q_我编的" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("QUESTION_NOT_FOUND");
  });
});

describe("MCP 壳 · 学情两工具（AI:PRD-006 · 006-B）", () => {
  it("student_view：数据包带覆盖口径，未挂桥批次如实列出", async () => {
    const r = await runStudentView({ code: "小崽子" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.code).toBe("小崽子");
    expect(r.data.batches.length).toBeGreaterThan(0);
    // 🔴 覆盖口径必带（少了它，perKp 会被当成全量）
    expect(r.data.coverage.total).toBeGreaterThan(0);
    expect(r.data.coverage.unmatched.length).toBe(
      r.data.coverage.total - r.data.coverage.matched,
    );
    // 🔴 未挂桥的批次分数照给、说得出为什么、但没有 taskId
    for (const b of r.data.batches.filter((x) => !x.matched)) {
      expect(b.why ?? "").not.toBe("");
      expect(b.taskId).toBeNull();
      expect(b.score).toBeTruthy();
    }
    // 口径注释跟着数走
    expect(r.data.rubric.join("\n")).toMatch(/空题算失分/);
  });

  it("🔴 student_view：batch_id 筛出「那一天」（不筛就把好几天并成一行 perKp）", async () => {
    const 全 = await runStudentView({ code: "小崽子" });
    expect(全.ok).toBe(true);
    if (!全.ok) return;
    const 挂上的 = 全.data.batches.filter((b) => b.matched);
    expect(挂上的.length, "小崽子该有不止一天挂上桥").toBeGreaterThan(1);

    const 一天 = await runStudentView({ code: "小崽子", batch_id: 10 });
    expect(一天.ok).toBe(true);
    if (!一天.ok) return;
    expect(一天.data.batches.map((b) => b.batchId)).toEqual([10]);
    // 🔴 汇总口径的 total 一定 ≥ 单天口径（并起来只会更大）
    const 单天分母 = 一天.data.perKp.reduce((s, k) => s + k.total, 0);
    const 汇总分母 = 全.data.perKp.reduce((s, k) => s + k.total, 0);
    expect(单天分母).toBe(19); // batch10 = 20 题 − 1 漏抄
    expect(汇总分母).toBeGreaterThan(单天分母);
    // 单批口径要说出来，别被当成覆盖率
    expect(一天.data.coverage.total).toBe(1);
    expect(一天.data.warnings.join("\n")).toMatch(/单批口径/);
  });

  it("student_view：查无此代号 ⇒ 回空数据包而不是报错（如实说「没有」）", async () => {
    const r = await runStudentView({ code: "查无此人代号" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.batches).toEqual([]);
    expect(r.data.roster).toBeNull();
    expect(r.data.done.count).toBe(0);
    expect(r.data.warnings.join("\n")).toMatch(/roster 里没有代号/);
  });

  it("group_kp_stats：错误率 + 错因分布合并回执，unmapped 红旗不静默丢", async () => {
    const r = await runGroupKpStats({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.coverage).toEqual(r.data.errorRate.coverage);
    expect(r.data.errorRate.rows.length).toBeGreaterThan(0);
    for (const row of r.data.errorRate.rows) {
      expect(row.wrong).toBeLessThanOrEqual(row.total);
    }
    // 🔴 三形态分列 + unmapped 的恒等式：**不管种子灌没灌**，展开的码次一个都不许丢。
    //    006-C 灌完种子后 unmapped 应为空、rows 非空；灌之前正相反。这条对两种状态都成立。
    expect(
      r.data.causes.rows.length + r.data.causes.unmapped.length,
    ).toBeGreaterThan(0);
    for (const u of r.data.causes.unmapped) {
      // 万一还有没铺的，它必须指得回去（红旗不许是个光秃秃的数）
      expect(u.sample.length).toBeGreaterThan(0);
      expect(u.kpName).not.toBe("");
    }
    expect(r.data.causes.sampleCodes).toBe(
      r.data.causes.rows.reduce((s, x) => s + x.count, 0) +
        r.data.causes.unmapped.reduce((s, x) => s + x.count, 0),
    );

    // 只看一个考点：kp_ids 过滤真的生效
    const one = r.data.errorRate.rows[0]!.kpId;
    const f = await runGroupKpStats({ kp_ids: [one] });
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.data.errorRate.rows.map((x) => x.kpId)).toEqual([one]);
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
