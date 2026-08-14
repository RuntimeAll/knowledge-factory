/**
 * GET /api/shelf/reconcile —— 两库对账（/shelf/reconcile）的机读出口（AI:PRD-009 · D-B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：**货架 punch 库 `举一反三产物/资料库.db`** ↔ **本库 `data/资料库.db`**，
 *      两个文件同名、schema 完全不同。本路由同时读两边，所以格外要写清谁是谁。
 * 🔴🔴 **差异只报不改**，且**两边都零写**：
 *      - punch 侧 mode=ro（物理只读）；
 *      - 本库侧只 SELECT，**不 logMetric、不留审计行** —— 打开/刷新一个页面
 *        不该改库（与 /api/health/integrity 的 metric:false 同一条理由）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 页面首屏是 server component 直接调 core 现算的；本路由是给「重新跑一次」按钮
 * 和外部机读用的，两条路走同一个 `reconcileShelf`，口径不可能漂。
 */
import { NextResponse } from "next/server";

import { reconcileShelf } from "~/core";
import type { ReconcileResponse } from "~/app/shelf/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const report = await reconcileShelf();
    // 🔴 这行赋值就是那道机器闸：core 的 ShelfReconcileReport 一改形状，
    //    与 shared.ts 的 ReconcileReportView 对不上就当场编译不过。
    const body: ReconcileResponse = { ok: true, report };
    return NextResponse.json(body);
  } catch (e) {
    const body: ReconcileResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      report: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
