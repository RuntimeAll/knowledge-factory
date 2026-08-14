/**
 * `GET /api/grading/review` —— 待审队列 + 近期已确认（AI:PRD-009 · 设计稿 §一 D-A）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库警示：读的是**圣域** `订阅特训/_产线/审核.db`（批改线正本），
 *      **不是** punch 库 `举一反三产物/资料库.db`，
 *      **不是** 本产品自己的 `data/资料库.db`。
 *
 * 🔴 **零写**：走 core 的 `getGradingDb()`（mode=ro 三道锁）。
 *    这一条替代的是审核台的 `GET /api/pending` + `GET /api/confirmed` 两个口子。
 * 🔴 口径照抄 `审核库.py`：pending 是 `status IN ('pending','rework')`，
 *    confirmed 取最近 10 条（它把 limit 写死 10，这里也写死，见 REVIEW_CONFIRMED_LIMIT）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { reviewQueue, 原文 } from "~/app/grading/review/query";
import { type ReviewListResponse } from "~/app/grading/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const r = await reviewQueue();
    const body: ReviewListResponse = {
      ok: true,
      data: r.batches,
      total: r.batches.length,
      confirmed: r.confirmed,
      gradingDbPath: r.gradingDbPath,
      warnings: r.warnings,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: ReviewListResponse = {
      ok: false,
      error: `待审队列取数失败（原文照登）：${原文(e)}`,
      data: [],
      total: 0,
      confirmed: [],
      gradingDbPath: null,
      warnings: [],
    };
    // 🔴 HTTP 仍 200：错误原文要原样端到页面上（与本仓其它取数路由同一约定），
    //    前端按 ok 判断，不靠状态码猜。
    return NextResponse.json(body, { status: 200 });
  }
}
