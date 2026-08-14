/**
 * GET /api/audit —— 审计日志的取数口（AI:PRD-008 · P3 · 设计稿 §二·15）
 *
 * 🔴🔴 **零写，而且必须零写**：这一页看的就是 audit_log。翻页动作若自己也往
 *    audit_log 里追行，翻到第二页时看到的第一行就是「刚才翻第一页」——
 *    观察行为改变被观察对象，这张表当场作废。core 的 listAuditRows 是纯 SELECT。
 * 🔴 链校验（verifyAuditChain）不在这儿跑：那要从创世行整链重算，
 *    是页面顶部横幅（server component）一次的事，不该跟着每次翻页跑。
 * 🔴 app 层只 import `~/core`（eslint 红线）。
 */
import { NextResponse } from "next/server";

import { listAuditRows } from "~/core";
import type {
  AuditListResponse,
  AuditRefView,
  AuditRow,
} from "~/app/audit/shared";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function dateParam(sp: URLSearchParams, key: string): string | undefined {
  const v = (sp.get(key) ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

/**
 * 影响行摘要：按 `表+op` 归并成 `question +20 · question_kp +34`。
 * 🔴 `+` = insert、`~` = update、`-` = delete —— 一次写动了什么，一眼看得出方向。
 * 🔴 解析不动就说「row_refs_json 解析不动」，不写「无影响行」：
 *    「没解析出来」和「什么都没动」是两件事，混起来会把事故读成正常。
 */
function summarize(refs: AuditRefView[] | null, raw: string | null): string {
  if (refs === null) {
    return raw ? "row_refs_json 解析不动（原文见展开行）" : "没记影响行";
  }
  if (refs.length === 0) return "没记影响行";
  const sign: Record<string, string> = {
    insert: "+",
    update: "~",
    delete: "-",
  };
  const bag = new Map<string, number>();
  for (const r of refs) {
    const k = `${r.table}${sign[r.op] ?? "?"}`;
    bag.set(k, (bag.get(k) ?? 0) + 1);
  }
  return [...bag.entries()].map(([k, n]) => `${k}${n}`).join(" · ");
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const actor = (sp.get("actor") ?? "").trim();
  const tool = (sp.get("tool") ?? "").trim();
  const from = dateParam(sp, "from");
  const to = dateParam(sp, "to");

  try {
    const r = await listAuditRows({
      ...(actor ? { actor } : {}),
      ...(tool ? { tool } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const data: AuditRow[] = r.rows.map((row) => ({
      seq: row.seq,
      ts: row.ts,
      actor: row.actor,
      tool: row.tool,
      argsDigest: row.argsDigest,
      impact: summarize(row.rowRefs, row.rowRefsRaw),
      refs: row.rowRefs ?? [],
      refsRaw: row.rowRefsRaw,
      hasGateResults: row.hasGateResults,
      prevHash: row.prevHash,
    }));

    const body: AuditListResponse = {
      ok: true,
      data,
      total: r.total,
      page,
      pageSize,
      actors: r.actors,
      tools: r.tools,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: AuditListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      page,
      pageSize,
      actors: [],
      tools: [],
    };
    return NextResponse.json(body, { status: 200 });
  }
}
