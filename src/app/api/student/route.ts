/**
 * GET /api/student?status=active|paused|closed —— 学员名册取数（AI:PRD-008 · P2）
 *
 * 🔴 **零写**：只调 listRoster / bridgeBatches / getStudentView，三个都是只读
 *    （圣域走 mode=ro 物理只读句柄，本库只有 SELECT）。列表页刷十次也不会动一行。
 * 🔴 名册 ∪ 圣域：roster 是**纯维度表**，学情事实全在圣域。有人交了卷却没登记名册
 *    （现库的「困呆眠」「小宇川奈子」就是），照样列出来并标 inRoster=false ——
 *    静默隐藏等于「这个人没交过卷」，那是最难发现的一类漏。
 * 🔴 一个学员算不出来不该让整页白屏：逐个 try/catch，坏行把原文挂在 loadError 上。
 *
 * ⚠️ 已知代价（TODO，留给后续卡）：每个代号一次 getStudentView，而它内部会重跑
 *    bridgeBatches（自己一次 + causeDistribution 一次）。现库 6 个代号 / 12 个批次，
 *    本地 SQLite 毫秒级，够用；学员上百时该在 core 侧补一个「名册概览」汇总函数
 *    （一次桥算完所有人），而不是在页面这层堆 N 次调用。
 */
import { NextResponse } from "next/server";

import { bridgeBatches, getStudentView, listRoster } from "~/core";
import type {
  StudentListResponse,
  StudentRosterRow,
} from "~/app/student/shared";

export const dynamic = "force-dynamic";

const ROSTER_STATUS = ["active", "paused", "closed"];

/** 最近一次 = 出件时间最大的那条；时间缺失就退到批次号（圣域自增，序等价） */
function 取最近<T extends { exportedAt: string | null; batchId: number }>(
  rows: T[],
): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) =>
      (a.exportedAt ?? "").localeCompare(b.exportedAt ?? "") ||
      a.batchId - b.batchId,
  )[rows.length - 1]!;
}

export async function GET(req: Request): Promise<NextResponse> {
  const t0 = Date.now();
  const sp = new URL(req.url).searchParams;
  const statusRaw = (sp.get("status") ?? "").trim();
  const status = ROSTER_STATUS.includes(statusRaw)
    ? (statusRaw as "active" | "paused" | "closed")
    : undefined;

  try {
    const [rosterRows, bridge] = await Promise.all([
      listRoster(status ? { status } : {}),
      bridgeBatches(),
    ]);

    const 名册 = new Map(rosterRows.map((r) => [r.code, r]));
    // 圣域里出现过的代号（含没登记名册的）
    const 圣域代号 = [
      ...new Set(
        bridge.batches
          .map((b) => b.student)
          .filter((s): s is string => !!s && s.trim() !== ""),
      ),
    ];
    const warnings: string[] = [];

    // 🔴 按 status 筛的时候只认名册（圣域侧根本没有「状态」这一维）——
    //    否则一筛 active 就会把没登记的人也拉进来，那不是任何一种口径。
    const codes = status
      ? rosterRows.map((r) => r.code)
      : [...new Set([...rosterRows.map((r) => r.code), ...圣域代号])].sort();
    if (status) {
      const 落选 = 圣域代号.filter((c) => !名册.has(c));
      if (落选.length > 0) {
        warnings.push(
          `按名册状态「${status}」筛选中：圣域里另有 ${落选.length} 个代号没登记名册` +
            `（${落选.join("、")}），它们没有状态这一维，本次不在表里。清空筛选即可看到。`,
        );
      }
    }

    const data: StudentRosterRow[] = [];
    for (const code of codes) {
      const r = 名册.get(code);
      const base: StudentRosterRow = {
        code,
        alias: r?.alias ?? null,
        grade: r?.grade ?? null,
        editionCtx: r?.editionCtx ?? null,
        status: r?.status ?? null,
        joinedAt: r?.joinedAt ?? null,
        note: r?.note ?? null,
        inRoster: !!r,
        batches: 0,
        matched: 0,
        lastDay: null,
        lastAt: null,
        lastLine: null,
        lastScore: null,
        lastBatchId: null,
        lastMatched: false,
      };
      try {
        const v = await getStudentView(code);
        const last = 取最近(v.batches);
        data.push({
          ...base,
          batches: v.coverage.total,
          matched: v.coverage.matched,
          lastDay: last?.day ?? null,
          lastAt: last?.exportedAt ?? null,
          lastLine: last?.line ?? null,
          lastScore: last?.score ?? null,
          lastBatchId: last?.batchId ?? null,
          lastMatched: last?.matched ?? false,
        });
      } catch (e) {
        data.push({
          ...base,
          loadError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
      }
    }

    const body: StudentListResponse = {
      ok: true,
      data,
      total: data.length,
      rosterCount: rosterRows.length,
      strayCount: data.filter((d) => !d.inRoster).length,
      coverage: {
        matched: bridge.matched,
        total: bridge.total,
        rate: bridge.coverage,
      },
      ms: Date.now() - t0,
      warnings: [...warnings, ...bridge.warnings],
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: StudentListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      rosterCount: 0,
      strayCount: 0,
      coverage: { matched: 0, total: 0, rate: "n/a" },
      ms: Date.now() - t0,
      warnings: [],
    };
    // 🔴 HTTP 仍 200：错误摆在页面上（原文照登）比一个红色 500 有用
    return NextResponse.json(body, { status: 200 });
  }
}
