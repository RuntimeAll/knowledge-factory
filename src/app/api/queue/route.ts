/**
 * GET /api/queue?tab=kp|figure|draft|quarantine|other&state=open —— 处置台取数（AI:PRD-008 · 地基）
 *
 * 🔴 **只读**：列工单、列隔离行、点各 tab 的角标数。处置动作一律走
 *    `app/queue/actions.ts` 里那几个 server action（core 原语 + 审计行），
 *    本路由一行都不改库（列表页刷十次也不会动一行）。
 * 🔴 图片/草稿两类要额外的卡片包（题面、图 hash、预检）：逐条取够快（本地库），
 *    但**一条坏工单不该让整页白屏** —— 读不出来的那行把报错挂在 `loadError` 上，
 *    其余行照常处置。
 */
import { NextResponse } from "next/server";

import {
  countOpenQueueByKind,
  getDraftCard,
  getFigureReviewCard,
  listQuarantine,
  listQueueItems,
  type QueueItem,
} from "~/core";
import {
  QUEUE_TABS,
  type QueueCounts,
  type QueueListResponse,
  type QueueTab,
  type QueueViewRow,
} from "~/app/queue/rows";

export const dynamic = "force-dynamic";

/** tab ↔ review_queue.kind（quarantine 读的是另一张表，other 是"其余全部"） */
const KIND_OF: Record<QueueTab, string | null> = {
  kp: "kp低置信",
  figure: "图片",
  draft: "新题草稿",
  quarantine: null,
  other: null,
};
const 三类 = ["kp低置信", "图片", "新题草稿"];

const LIMIT = 200;

function pretty(json: string | null): string {
  if (!json) return "（空）";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** 低置信工单 payload 里那句 query（取不到就 null，绝不猜） */
function queryOf(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const p: unknown = JSON.parse(payloadJson);
    if (p && typeof p === "object" && "query" in p) {
      const v = p.query;
      return typeof v === "string" ? v : null;
    }
  } catch {
    /* 不是 JSON 也不是灾难：原样 payload 那一栏照样看得见 */
  }
  return null;
}

function baseRow(it: QueueItem): QueueViewRow {
  return {
    id: it.id,
    kind: it.kind,
    state: it.state,
    reason: it.reason,
    createdAt: it.createdAt,
    refType: it.refType,
    refId: it.refId,
    verdictBy: it.verdictBy,
    verdictAt: it.verdictAt,
    verdictNote: it.verdictNote,
    payloadPretty:
      pretty(it.payloadJson) +
      (it.signalsJson ? `\n--- signals ---\n${pretty(it.signalsJson)}` : ""),
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const tabRaw = sp.get("tab") ?? "kp";
  const tab: QueueTab = (QUEUE_TABS as readonly string[]).includes(tabRaw)
    ? (tabRaw as QueueTab)
    : "kp";
  const stateRaw = sp.get("state") ?? "open";

  try {
    // 角标（未处置数）：工单按 kind 分 + 隔离区未结
    const [byKind, qrOpen] = await Promise.all([
      countOpenQueueByKind(),
      listQuarantine({ state: "open", limit: 500 }),
    ]);
    const n = (kind: string) => byKind.find((k) => k.kind === kind)?.count ?? 0;
    const counts: QueueCounts = {
      kp: n("kp低置信"),
      figure: n("图片"),
      draft: n("新题草稿"),
      other: byKind
        .filter((k) => !三类.includes(k.kind))
        .reduce((a, b) => a + b.count, 0),
      quarantine: qrOpen.length,
    };

    let data: QueueViewRow[] = [];

    if (tab === "quarantine") {
      const state = ["open", "resolved", "all"].includes(stateRaw)
        ? (stateRaw as "open" | "resolved" | "all")
        : "open";
      const rows = await listQuarantine({ state, limit: LIMIT });
      data = rows.map((q) => ({
        id: q.id,
        kind: "隔离",
        state: q.resolvedAt ? "resolved" : "open",
        reason: q.why,
        createdAt: q.createdAt,
        refType: null,
        refId: null,
        verdictBy: null,
        verdictAt: q.resolvedAt,
        verdictNote: null,
        payloadPretty: pretty(q.payloadJson),
        why: q.why,
        batchId: q.batchId,
        resolvedAt: q.resolvedAt,
      }));
    } else {
      const state = ["open", "passed", "rejected"].includes(stateRaw)
        ? (stateRaw as "open" | "passed" | "rejected")
        : "open";
      const kind = KIND_OF[tab];
      const items = await listQueueItems({
        ...(kind ? { kind } : {}),
        state,
        limit: LIMIT,
      });
      const list =
        tab === "other"
          ? items.filter((it) => !三类.includes(it.kind ?? ""))
          : items;

      data = [];
      for (const it of list) {
        const row = baseRow(it);
        try {
          if (tab === "kp") {
            row.query = queryOf(it.payloadJson);
          } else if (tab === "figure") {
            const card = await getFigureReviewCard(it.id);
            row.stem = card.question?.stem ?? null;
            row.questionId = card.question?.id ?? null;
            row.reviewRequired = card.question?.reviewRequired ?? null;
            row.figures = card.figures.map((f) => ({
              id: f.id,
              role: f.role,
              reviewState: f.reviewState,
              hash: f.hash,
            }));
          } else if (tab === "draft") {
            const card = await getDraftCard(it.id);
            row.stem =
              typeof card.draft.item.stem === "string"
                ? card.draft.item.stem
                : null;
            row.answer =
              typeof card.draft.item.answer === "string"
                ? card.draft.item.answer
                : null;
            row.source = card.draft.source;
            row.precheckOk = card.draft.precheck?.ok ?? null;
            row.reds = (card.draft.precheck?.reds ?? []).map(
              (r) => `${r.gate}[${r.code}] ${r.message}`,
            );
          }
        } catch (e) {
          row.loadError = e instanceof Error ? e.message : String(e);
        }
        data.push(row);
      }
    }

    const body: QueueListResponse = {
      ok: true,
      tab,
      state: stateRaw,
      data,
      total: data.length,
      counts,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: QueueListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      tab,
      state: stateRaw,
      data: [],
      total: 0,
      counts: { kp: 0, figure: 0, draft: 0, other: 0, quarantine: 0 },
    };
    return NextResponse.json(body, { status: 200 });
  }
}
