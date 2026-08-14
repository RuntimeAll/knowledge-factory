/**
 * `GET /api/grading/board` —— 批改看板取数（AI:PRD-008 · PRD-027 交互面）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **零写**。两个数据源都只读：
 *      ① 圣域 审核.db —— 走 core 的 `getGradingDb()`（mode=ro 三道锁，非 SELECT 直接抛）；
 *      ② `收件箱/_队列.jsonl` —— 只读文件（写它的是收卷录入那条 POST）。
 *
 * 🔴 唯一事实源纪律（PRD-027 设计稿 §一）：**照片一进 收卷.py，状态一律以 审核.db 为准**。
 *    所以本路由**不合并**两边：收件段一行是一行（`seg:"收件"`），批改段一行是一行
 *    （`seg:"批改"`）。两边对不上是**现在的真相**——编排台账（grading-pipeline）
 *    是 PRD-027 包② 的东西，还没建；在它出现之前，谁也没资格把两段 join 起来。
 *
 * 🔴 「卷是哪张」不自己拼：走 core 的 `bridgeBatches()`（桥键=slots(student,day)，
 *    绝不是 batches.task_id 那条死列）。挂不上桥的批次照常列，并把 why 原文带上。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from "node:fs";

import { NextResponse } from "next/server";

import {
  VERDICT_OK,
  VERDICT_SKIP,
  VERDICT_WRONG,
  bridgeBatches,
  getGradingDb,
} from "~/core";
import {
  type BoardMeta,
  type BoardResponse,
  type BoardRow,
  type BoardState,
} from "~/app/grading/shared";
import { inboxQueueFile } from "~/app/grading/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 存疑的判定值面（与 产线配置.json「零存疑（?/doubt/missing 皆无）」同口径） */
const DOUBT_PRE = ["?", "doubt", "missing"];

function 原文(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

interface ItemAgg {
  n: number;
  doubt: number;
  ok: number;
  wrong: number;
  skip: number;
  unjudged: number;
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const 学员 = sp.get("code")?.trim() ?? "";
  const 状态 = sp.get("state")?.trim() ?? "";
  const 起 = sp.get("from")?.trim() ?? ""; // YYYY-MM-DD
  const 止 = sp.get("to")?.trim() ?? "";

  const queuePath = inboxQueueFile();
  const warnings: string[] = [];
  let rows: BoardRow[] = [];
  let meta: BoardMeta | null = null;

  try {
    const g = await getGradingDb();

    // ── 批改段：桥 + 批次原始列 + 逐题聚合 + 打回次数 ────────────────────
    const bridge = await bridgeBatches();
    warnings.push(...bridge.warnings);

    const 批次列 = g.query<{
      id: number;
      created_at: string | null;
      confirmed_at: string | null;
      round: number | null;
    }>("SELECT id, created_at, confirmed_at, round FROM batches");
    const 原始 = new Map(批次列.map((b) => [Number(b.id), b]));

    const 逐题 = g.query<{
      batch_id: number;
      verdict_pre: string | null;
      verdict_final: string | null;
      needs_human: number | null;
    }>("SELECT batch_id, verdict_pre, verdict_final, needs_human FROM items");
    const agg = new Map<number, ItemAgg>();
    for (const r of 逐题) {
      const id = Number(r.batch_id);
      const e = agg.get(id) ?? {
        n: 0,
        doubt: 0,
        ok: 0,
        wrong: 0,
        skip: 0,
        unjudged: 0,
      };
      e.n += 1;
      if (
        (r.verdict_pre !== null && DOUBT_PRE.includes(r.verdict_pre)) ||
        Number(r.needs_human ?? 0) === 1
      ) {
        e.doubt += 1;
      }
      if (r.verdict_final === VERDICT_OK) e.ok += 1;
      else if (r.verdict_final === VERDICT_WRONG) e.wrong += 1;
      else if (r.verdict_final === VERDICT_SKIP) e.skip += 1;
      else e.unjudged += 1;
      agg.set(id, e);
    }

    const 打回 = new Map<number, number>();
    for (const f of g.query<{ batch_id: number; n: number }>(
      "SELECT batch_id, COUNT(*) AS n FROM feedback GROUP BY batch_id",
    )) {
      打回.set(Number(f.batch_id), Number(f.n));
    }

    for (const b of bridge.batches) {
      const raw = 原始.get(b.batchId);
      const a = agg.get(b.batchId);
      const rework = 打回.get(b.batchId) ?? 0;

      // 状态：以 审核.db 为准逐条推（推不出来就说"状态未知"，不硬套一个）
      let state: BoardState;
      let note: string;
      if (b.status === "confirmed" && b.exportedAt) {
        state = "已出件";
        note = `confirmed 且 exported_at=${b.exportedAt}`;
      } else if (b.status === "confirmed") {
        state = "已放行";
        note =
          "confirmed 但还没 export —— 静默放行只到 confirmed 为止，出件还要 agent 写完总结再 export（产线配置.json「边界不动」）";
      } else if (b.status === "pending" && (a?.n ?? 0) === 0) {
        state = "批改中";
        note = "批次建了、items 还一行都没落 —— 判定还没回来";
      } else if (b.status === "pending") {
        state = "待审核";
        note =
          (a?.doubt ?? 0) > 0
            ? `${a?.doubt ?? 0} 题存疑，等你上审核台终审`
            : "零存疑却仍是 pending —— 多半是打回重批轮（round>1，任何档位都不静默）或档位在 L0";
      } else {
        state = "状态未知";
        note = `审核.db batches.status=${JSON.stringify(b.status)} —— 不是 pending/confirmed，本页不猜它是什么`;
      }

      const 得分 =
        a && a.n - a.skip > 0
          ? `${a.ok}/${a.n - a.skip}${a.skip > 0 ? `（漏抄 ${a.skip} 题已摘）` : ""}`
          : null;

      rows.push({
        key: `b:${b.batchId}`,
        seg: "批改",
        ts: raw?.created_at ?? null,
        student: b.student,
        day: b.day,
        paper: b.task
          ? `${b.task.line ?? "线名未记"}${b.task.day === null ? "" : ` · 第${b.task.day}天`}`
          : null,
        paperNote: b.matched
          ? b.via === "link"
            ? "人工补录桥（grading_batch_link）"
            : null
          : b.why,
        state,
        stateNote: note,
        auto: b.auto,
        doubt: a?.doubt ?? null,
        itemCount: a?.n ?? null,
        score: 得分,
        batchId: b.batchId,
        round: b.round,
        reworks: rework,
        matched: b.matched,
        fileCount: null,
        confirmedAt: raw?.confirmed_at ?? null,
        exportedAt: b.exportedAt,
      });
    }

    // ── 收件段：_队列.jsonl（append-only 事件流） ────────────────────────
    let queueExists = false;
    if (existsSync(queuePath)) {
      queueExists = true;
      const text = readFileSync(queuePath, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        let o: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new Error("不是 JSON 对象");
          }
          o = parsed as Record<string, unknown>;
        } catch (e) {
          warnings.push(
            `收件队列第 ${i + 1} 行解析不了（${原文(e)}）：${line}`,
          );
          continue;
        }
        const files = Array.isArray(o.files)
          ? o.files.filter((x): x is string => typeof x === "string")
          : [];
        rows.push({
          key: `in:${i + 1}`,
          seg: "收件",
          ts: typeof o.ts === "string" ? o.ts : null,
          student: typeof o.code === "string" ? o.code : null,
          day: null,
          paper: typeof o.卷型 === "string" ? `卷型手选：${o.卷型}` : null,
          paperNote:
            "收件段还没认卷 —— 是哪张卷由认卷模块定（PRD-027 包②），本页不猜",
          state: "收件中",
          stateNote:
            "来自 _队列.jsonl（收件事件流）。🔴「待认卷」属编排台账（grading-pipeline 未建），" +
            "这一行会不会已经被 watcher 接手，本页现在看不出来 —— 批改段以 审核.db 为准。",
          auto: null,
          doubt: null,
          itemCount: null,
          score: null,
          batchId: null,
          round: null,
          reworks: 0,
          matched: null,
          fileCount: files.length,
          confirmedAt: null,
          exportedAt: null,
        });
      }
    }

    // ── 筛（学员 / 状态 / 日期） ─────────────────────────────────────────
    if (学员) rows = rows.filter((r) => r.student === 学员);
    if (状态) rows = rows.filter((r) => r.state === 状态);
    if (起) rows = rows.filter((r) => (r.ts ?? "") >= 起);
    if (止) rows = rows.filter((r) => (r.ts ?? "") <= `${止}T23:59:59`);

    // 新的在上；没时间戳的沉底（不编一个时间把它排上去）
    rows.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));

    meta = {
      bridgeMatched: bridge.matched,
      bridgeTotal: bridge.total,
      bridgeCoverage: bridge.coverage,
      queueExists,
      queuePath,
      gradingDbPath: g.path,
      // 🔴 items 有没有 zooms 列 —— 现场问库，不靠记忆
      zoomColumn: g
        .query<{ name: string }>("PRAGMA table_info(items)")
        .some((c) => c.name === "zooms"),
      warnings,
    };

    const body: BoardResponse = {
      ok: true,
      data: rows,
      total: rows.length,
      meta,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: BoardResponse = {
      ok: false,
      error: `看板取数失败（原文照登）：${原文(e)}`,
      data: [],
      total: 0,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
