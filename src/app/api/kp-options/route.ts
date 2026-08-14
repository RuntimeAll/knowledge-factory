/**
 * GET /api/kp-options?q=绝对值 —— 考点下拉的远程候选（AI:PRD-008 · 地基）
 *
 * 🔴 `enqueue:false`：页面上每敲一次搜索就往人的待办队列塞一张低置信工单，
 *    队列就废了（002-D 定的规矩，/search 页也是这么调的）。⇒ 本路由**零写**。
 * 🔴 只做候选，不做过滤：选中哪个考点是人的决定，路由不替他挑（lowConfidence
 *    如实回传，页面照实提示「四路都没把握」）。
 */
import { NextResponse } from "next/server";

import { resolveKp } from "~/core";
import type { KpOptionsResponse } from "~/app/question/shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) {
    const empty: KpOptionsResponse = {
      ok: true,
      options: [],
      lowConfidence: false,
    };
    return NextResponse.json(empty);
  }

  try {
    const r = await resolveKp(q, { enqueue: false, limit: 10 });
    const body: KpOptionsResponse = {
      ok: true,
      options: r.candidates.map((c) => ({
        value: c.kpId,
        label: c.aliasHit ? `${c.name}（别名「${c.aliasHit}」）` : c.name,
        confidence: c.confidence,
        via: c.matchedVia,
      })),
      lowConfidence: r.lowConfidence,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: KpOptionsResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      options: [],
      lowConfidence: false,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
