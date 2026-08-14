/**
 * GET /api/ingest —— 录入批次台账的取数口（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 🔴 **零写**：只调 core 的 listIngestBatches（纯 SELECT）。列表页刷一百次，
 *    audit_log 一行都不多 —— 而 audit_log 正是隔壁 /audit 页要看的东西。
 * 🔴 app 层只 import `~/core`（eslint 红线）。
 * 🔴 参数白名单化：地址栏是人能手改的地方，status 不在三态里就当没传，
 *    不把一个乱串直接拼进 WHERE。
 */
import { NextResponse } from "next/server";

import { listIngestBatches } from "~/core";
import {
  INGEST_STATUSES,
  type IngestBatchRow,
  type IngestListResponse,
} from "~/app/ingest/shared";

export const dynamic = "force-dynamic";

/** core 的单次上限（monitor.ts MAX_LIMIT）；本地库当下 44 批，够用很久 */
const CAP = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

/** `YYYY-MM-DD` 才认；别的形状一律当没传（宁可不筛，也不筛出一个假集合） */
function dateParam(sp: URLSearchParams, key: string): string | undefined {
  const v = (sp.get(key) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const source = (sp.get("source") ?? "").trim();
  const statusRaw = (sp.get("status") ?? "").trim();
  const status = (INGEST_STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw
    : undefined;
  const from = dateParam(sp, "from");
  const to = dateParam(sp, "to");

  try {
    const list = await listIngestBatches({
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: CAP,
    });

    const rows: IngestBatchRow[] = list.map((b) => ({
      id: b.id,
      contractVer: b.contractVer,
      source: b.source,
      status: b.status,
      total: b.counts.total,
      accepted: b.counts.accepted,
      queued: b.counts.queued,
      rejected: b.counts.rejected,
      createdAt: b.createdAt,
      committedAt: b.committedAt,
      hasGateReport: b.hasGateReport,
      quarantineOpen: b.quarantineOpen,
      quarantineTotal: b.quarantineTotal,
    }));

    const start = (page - 1) * pageSize;
    const body: IngestListResponse = {
      ok: true,
      data: rows.slice(start, start + pageSize),
      total: rows.length,
      matched: rows.length,
      page,
      pageSize,
      capped: rows.length >= CAP,
    };
    return NextResponse.json(body);
  } catch (e) {
    // 🔴 报错原文照登：本地工具页，藏错误没有任何好处
    const body: IngestListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      matched: 0,
      page,
      pageSize,
      capped: false,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
