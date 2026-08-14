/**
 * GET /api/outputs —— 产物仓页（/output）的取数口（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 **零写**：列产出而已。出件/登记（register_sku_output）是产线与 MCP 的活。
 * 🔴 app 层不许碰 db：只 import `~/core`（eslint 红线）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 这一路是**绕出来的**，如实写在这儿（地基交接说明的遗留 5）
 *
 *   core 目前**没有** `listSkuOutputs`（跨册列产出）这个只读函数 —— 只有
 *   `getSku(skuId)` 顺带给一本册子的 outputs。所以本路由的做法是：
 *     listSkus（≤500 本）→ 逐本 getSku → 把各本的 outputs 展平成一张表。
 *   本地库 34 本册子 / 66 件产出，代价可以忽略；册子上了几百本之后这条路会变慢，
 *   那时候的正解是给 core 加一个 15 行的 `listSkuOutputs`（带 skuId/kind 过滤 +
 *   asset 联表），再把本文件切过去。**不在 app 层自己写 SQL** —— 那条红线不能破。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { SKU_OUTPUT_KINDS, getSku, listSkus } from "~/core";
import type { OutputListResponse, OutputRow } from "~/app/output/shared";

export const dynamic = "force-dynamic";

/** listSkus 的上限（core zod: max(500)） */
const CAP = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;

  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const skuId = (sp.get("sku") ?? "").trim();
  const kindRaw = (sp.get("kind") ?? "").trim();
  const kind = (SKU_OUTPUT_KINDS as readonly string[]).includes(kindRaw)
    ? kindRaw
    : "";
  const note = (sp.get("note") ?? "").trim();

  const t0 = Date.now();
  try {
    const briefs = await listSkus({ limit: CAP });
    // 指定了册子就只读那一本（省掉 33 次读卡）
    const 目标 = skuId ? briefs.filter((b) => b.id === skuId) : briefs;

    const rows: OutputRow[] = [];
    const warnings: string[] = [];
    if (skuId && 目标.length === 0) {
      warnings.push(
        `窗口里没有 id = ${skuId} 这本册子（可能已被 listSkus 的 ${CAP} 条上限截掉，或者这个 id 不对）。`,
      );
    }
    for (const b of 目标) {
      try {
        const card = await getSku(b.id);
        if (!card) continue;
        for (const o of card.outputs) {
          rows.push({
            id: o.id,
            skuId: card.id,
            skuName: card.name,
            skuType: card.type,
            skuStatus: card.status,
            kind: o.kind,
            hash: o.hash,
            path: o.path,
            bytes: o.bytes,
            note: o.note,
            createdAt: o.createdAt,
          });
        }
      } catch (e) {
        // 🔴 一本读不出来不该让整页白屏：其余册子的产出照列，原文挂 warnings
        warnings.push(
          `${b.name}（${b.id}）的产出读不出来：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    // 新的在前（登记时间同秒的按 id 兜底，顺序才稳定）
    rows.sort((a, z) => {
      const t = (z.createdAt ?? "").localeCompare(a.createdAt ?? "");
      return t !== 0 ? t : z.id.localeCompare(a.id);
    });

    const windowFilters: string[] = [];
    let filtered = rows;
    if (kind) {
      windowFilters.push(`类型 = ${kind}`);
      filtered = filtered.filter((r) => r.kind === kind);
    }
    if (note) {
      windowFilters.push(`附注包含「${note}」`);
      const kw = note.toLowerCase();
      filtered = filtered.filter((r) =>
        (r.note ?? "").toLowerCase().includes(kw),
      );
    }

    const start = (page - 1) * pageSize;
    const body: OutputListResponse = {
      ok: true,
      data: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
      meta: {
        skus: 目标.length,
        cap: CAP,
        capped: briefs.length >= CAP,
        total: rows.length,
        filtered: filtered.length,
        windowFilters,
        ms: Date.now() - t0,
        warnings,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: OutputListResponse = {
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
