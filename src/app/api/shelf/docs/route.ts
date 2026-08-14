/**
 * GET /api/shelf/docs —— 资料货架列表页（/shelf）的取数口（AI:PRD-009 · D-B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本路由读的是 **punch 库 `举一反三产物/资料库.db`**（六类资料总账），
 *      **不是**本库的 `data/资料库.db`。两个文件同名、schema 完全不同、数据零交集。
 * 🔴🔴 **全程 mode=ro，零写**：punch 库物理只读（core/punch.ts 三道锁），
 *      两库绝不互写。货架是「挂载来看」，不是「搬过来」。
 *      punch 的 `doc.人工态` 只有人能点（在 punch-console 上），本产品连写的路都没有。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 app 层不许碰 db：本文件只 import `~/core`（eslint 红线）。
 * 🔴 不分页：doc 一共几十行，一次取尽反而简单；泳道/关键词是**窗口内过滤**
 *    （泳道是现算的，库里没有那一列），`meta.windowFilters` 如实上墙。
 */
import { NextResponse } from "next/server";

import { listShelfDocs } from "~/core";
import type { ShelfListResponse } from "~/app/shelf/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function str(sp: URLSearchParams, key: string): string {
  return (sp.get(key) ?? "").trim();
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const type = str(sp, "type");
  const subject = str(sp, "subject");
  const grade = str(sp, "grade");
  const lane = str(sp, "lane");
  const keyword = str(sp, "keyword");

  try {
    const r = await listShelfDocs({
      ...(type ? { type } : {}),
      ...(subject ? { subject } : {}),
      ...(grade ? { grade } : {}),
      ...(lane ? { lane } : {}),
      ...(keyword ? { keyword } : {}),
    });
    const body: ShelfListResponse = {
      ok: true,
      data: r.rows,
      total: r.rows.length,
      facets: r.facets,
      meta: {
        totalDocs: r.totalDocs,
        windowFilters: r.windowFilters,
        dbPath: r.dbPath,
        ms: r.ms,
        warnings: r.warnings,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    // 🔴 报错原文照登（本地工具页，藏错误没有任何好处）——
    //    最常见的一条就是 PUNCH_DB_URL 没配 / 没带 mode=ro，core 会把话说全。
    const body: ShelfListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      facets: null,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
