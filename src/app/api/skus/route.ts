/**
 * GET /api/skus —— SKU 台账页（/sku）的取数口（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 **零写**：列册子而已，一行都不改库。上架/下架是 `app/sku/actions.ts` 里的
 *    server action（调 core 的 setSkuStatus，走审计链），与本路由无关。
 * 🔴 app 层不许碰 db：本文件只 import `~/core`（eslint 红线，见 eslint.config.js）。
 *
 * ── 🔴 为什么要逐本再读一次卡（N+1，如实写在这儿）────────────────────────────
 *   core 的 `listSkus` 摘要面只有 8 列（id/type/name/status/createdAt/items/outputs/taskId），
 *   **没有 layout / edition_ctx / recipe_json** —— 而设计稿 §二·8 的搜索区要「版式 /
 *   版本语境」，列里要「网盘指针有无」（那个指针寄存在 recipe_json 的 netdisk 段）。
 *   所以本路由在 listSkus 之后逐本调一次 `getSku` 把这三样取回来。
 *   本地库 34 本册子，逐本一张卡是几十毫秒的事；真要治本，是给 core 的摘要面补
 *   这三列（或加一个 listSkuBriefs），那是一次显式的契约变更，不在本卡范围内
 *   —— 见交接说明的 TODO。
 *
 * ── 🔴 哪些筛选是「窗口内过滤」────────────────────────────────────────────────
 *   core 的 listSkus 只吃 `type` / `status` 两维（SQL 硬过滤，总数是库口径）。
 *   名称 / 版式 / 版本语境三维是本路由在取回的窗口里过滤的，`meta.windowFilters`
 *   会如实列出来，页面照它上墙。窗口 = listSkus 的上限 500 本；撞到上限
 *   （`meta.capped`）时连总数都只是窗口口径，也一并说明。
 */
import { NextResponse } from "next/server";

import {
  SKU_STATUSES,
  SKU_TYPES,
  getSku,
  listSkus,
  type SkuStatus,
  type SkuType,
} from "~/core";
import {
  parseNetdisk,
  type NetdiskPointer,
  type SkuListResponse,
  type SkuRow,
} from "~/app/sku/shared";

export const dynamic = "force-dynamic";

/** listSkus 的上限（core zod: max(500)）——本地库 34 本，够用很久 */
const CAP = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** 单值白名单（地址栏是人能手改的地方，不在表里的一律当没给） */
function one(
  sp: URLSearchParams,
  key: string,
  allow: readonly string[],
): string | null {
  const v = (sp.get(key) ?? "").trim();
  return v && allow.includes(v) ? v : null;
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;

  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const type = one(sp, "type", SKU_TYPES);
  const status = one(sp, "status", SKU_STATUSES);
  const name = (sp.get("name") ?? "").trim();
  const layout = (sp.get("layout") ?? "").trim();
  const edition = (sp.get("edition") ?? "").trim();

  const t0 = Date.now();
  try {
    const briefs = await listSkus({
      ...(type ? { type: type as SkuType } : {}),
      ...(status ? { status: status as SkuStatus } : {}),
      limit: CAP,
    });

    // 逐本读卡（见文件头 §N+1）：要的就是 layout / editionCtx / recipeJson 三样
    const rows: SkuRow[] = [];
    const warnings: string[] = [];
    for (const b of briefs) {
      let layoutV: string | null = null;
      let editionV: string | null = null;
      let netdisk: NetdiskPointer | null = null;
      let recipeBroken = false;
      try {
        const card = await getSku(b.id);
        if (card) {
          layoutV = card.layout;
          editionV = card.editionCtx;
          const n = parseNetdisk(card.recipeJson);
          netdisk = n.netdisk;
          recipeBroken = n.broken;
        }
      } catch (e) {
        // 🔴 一本读不出来不该让整页白屏：那一行照出，把原文挂在 warnings 上
        warnings.push(
          `${b.name}（${b.id}）的卡读不出来：${
            e instanceof Error ? e.message : String(e)
          } —— 这一行的版式/版本语境/网盘三栏是空的，不代表库里没有。`,
        );
      }
      rows.push({
        id: b.id,
        name: b.name,
        type: b.type,
        status: b.status,
        items: b.items,
        outputs: b.outputs,
        layout: layoutV,
        editionCtx: editionV,
        netdisk,
        recipeBroken,
        taskId: b.taskId,
        createdAt: b.createdAt,
      });
    }

    // ── 窗口内过滤（core 的 listSkus 没有这三维）────────────────────────────
    const windowFilters: string[] = [];
    let filtered = rows;
    if (name) {
      windowFilters.push(`名称包含「${name}」`);
      const kw = name.toLowerCase();
      filtered = filtered.filter((r) => r.name.toLowerCase().includes(kw));
    }
    if (layout) {
      windowFilters.push(`版式包含「${layout}」`);
      const kw = layout.toLowerCase();
      filtered = filtered.filter((r) =>
        (r.layout ?? "").toLowerCase().includes(kw),
      );
    }
    if (edition) {
      windowFilters.push(`版本语境包含「${edition}」`);
      const kw = edition.toLowerCase();
      filtered = filtered.filter((r) =>
        (r.editionCtx ?? "").toLowerCase().includes(kw),
      );
    }

    const start = (page - 1) * pageSize;
    const body: SkuListResponse = {
      ok: true,
      data: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
      meta: {
        listed: briefs.length,
        cap: CAP,
        capped: briefs.length >= CAP,
        filtered: filtered.length,
        windowFilters,
        enriched: rows.length,
        ms: Date.now() - t0,
        warnings,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    // 🔴 报错原文照登（本地工具页，藏错误没有任何好处）
    const body: SkuListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      page,
      pageSize,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
