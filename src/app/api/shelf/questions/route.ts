/**
 * GET /api/shelf/questions —— 货架题目浏览（/shelf/questions）的取数口
 * （AI:PRD-009 验收修复 · 2026-08-15）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本路由读的是 **punch 库 `举一反三产物/资料库.db`** 的 `question`
 *      （3230 题 / 15 本册子），**不是**本库 `data/资料库.db` 的题库。
 *      两边**零交集**（同一口径 hash 实测交集为 0），所以这一页的题
 *      **绝不跳本库 /question/[id]** —— 那会指到另一本账上去。
 * 🔴🔴 **全程 mode=ro，零写**（core/punch.ts 三道锁），两库绝不互写。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 app 层不许碰 db：本文件只 import `~/core`（eslint 红线）。
 */
import { NextResponse } from "next/server";

import { listPunchQuestions } from "~/core";
import type { PunchQuestionsResponse } from "~/app/shelf/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function str(sp: URLSearchParams, key: string): string {
  return (sp.get(key) ?? "").trim();
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const keyword = str(sp, "kw");
  const qtype = str(sp, "qtype");
  const kp = str(sp, "kp");
  const docRaw = str(sp, "doc");
  const docId = docRaw === "" ? undefined : Number(docRaw);
  const limitRaw = Number(str(sp, "limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 60;

  if (docRaw !== "" && !Number.isInteger(docId)) {
    // 🔴 册 id 是 punch 的自增整数（不是本库那种 ULID）：给了个不是整数的就明确拒，
    //    别当成"没筛"静默返回全部 —— 那会让人以为自己筛过了。
    const body: PunchQuestionsResponse = {
      ok: false,
      error: `doc=${JSON.stringify(docRaw)} 不是整数（punch 的 doc.id 是自增整数，不是本库那种 ULID）。`,
      data: [],
      total: 0,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }

  try {
    const r = await listPunchQuestions({
      ...(keyword ? { keyword } : {}),
      ...(qtype ? { qtype } : {}),
      ...(kp ? { kp } : {}),
      ...(docId !== undefined ? { docId } : {}),
      limit,
    });
    const body: PunchQuestionsResponse = {
      ok: true,
      data: r.rows,
      total: r.hitCount,
      meta: {
        filteredTotal: r.filteredTotal,
        qtypes: r.qtypes,
        docs: r.docs,
        coverage: r.coverage,
        dbPath: r.dbPath,
        ms: r.ms,
        warnings: r.warnings,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    // 🔴 报错原文照登：最常见的一条是 PUNCH_DB_URL 没配 / 没带 mode=ro，core 会把话说全。
    const body: PunchQuestionsResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
