/**
 * GET /api/ingest/[id] —— 一次录题批的全账（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 🔴 **零写**：调的是 core 的 `getIngestBatch` —— 与 MCP 的 `get_ingest_batch`
 *    同一个函数。「网站看到什么，agent 就看到什么」在这一页是字面意思。
 * 🔴 gate_report_json 单批能到 76KB，所以列表页不驮它，**只有点开闸报告才取**。
 * 🔴 解析不动的老批/脏行：不假装没有闸账 —— items 给空、gateParseError 写清楚
 *    「批行里有 gate_report_json，但解析不出来」，让人知道该去看原文。
 */
import { NextResponse } from "next/server";

import { getIngestBatch } from "~/core";
import type {
  GateItemView,
  IngestBatchDetail,
  IngestDetailResponse,
  IngestItemView,
} from "~/app/ingest/shared";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: raw } = await ctx.params;
  const id = decodeURIComponent(raw ?? "").trim();

  try {
    const rec = await getIngestBatch(id);
    if (!rec) {
      const miss: IngestDetailResponse = {
        ok: false,
        error: `ingest_batch 里没有 id=${id} 这一批。`,
        data: null,
      };
      return NextResponse.json(miss, { status: 200 });
    }

    const gr = rec.gateReport;
    const items: IngestItemView[] = (gr?.items ?? []).map((it) => {
      const gates: GateItemView[] = it.gates.items.map((g) => ({
        name: g.name,
        ok: g.result.ok,
        ms: g.ms,
        ...(g.result.ok
          ? {}
          : {
              code: g.result.code,
              message: g.result.message,
              recoverable: g.result.recoverable,
              ...(g.result.nextTool ? { nextTool: g.result.nextTool } : {}),
            }),
      }));
      return {
        seq: it.seq,
        verdict: it.verdict,
        questionId: it.questionId,
        gates,
        gatesOk: it.gates.ok,
        failCode: it.failure?.code ?? null,
        failMessage: it.failure?.message ?? null,
        stripped: it.stripped,
        notes: it.notes,
        solutionGrade: it.solutionGrade,
        calcVerdict: it.calcVerdict,
        lineVerdict: it.lineVerdict,
        kpCount: it.kpIds.length,
        reviewRequired: it.reviewRequired,
      };
    });

    const data: IngestBatchDetail = {
      id: rec.id,
      contractVer: rec.contractVer,
      source: rec.source,
      payloadHash: rec.payloadHash,
      status: rec.status,
      createdAt: rec.createdAt,
      committedAt: rec.committedAt,
      total: rec.counts.total,
      accepted: rec.counts.accepted,
      queued: rec.counts.queued,
      rejected: rec.counts.rejected,
      contractOk: gr ? gr.contract.ok : null,
      items,
      gateParseError:
        gr === null
          ? rec.gateReportRaw
            ? "批行里有 gate_report_json，但解析不出来（老批 / 脏行）——原文仍在库里，去查 ingest_batch.gate_report_json"
            : "这一批没有留 gate_report_json（批行里就是空的）"
          : null,
      questionIds: rec.questionIds,
      quarantine: rec.quarantine,
    };

    const body: IngestDetailResponse = { ok: true, data };
    return NextResponse.json(body);
  } catch (e) {
    const body: IngestDetailResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
