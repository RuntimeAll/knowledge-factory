/**
 * core/status.ts —— 页面读侧（AI:PRD-001 · WP6）
 *
 * 页面壳要的三样东西里，health() 已经有了，这里补两个**只读**帮手：
 *   - getLatestIntegritySummary()  最近一次对账的摘要（读 metric_event，不重跑对账）
 *   - redFlagView()                摘要 → 全局红旗条的显示态（纯函数，可单测）
 *
 * 🔴 为什么红旗条读摘要而不是现跑 integrityCheck()：
 *    对账要连圣域、逐表扫审计覆盖、遍历 assets 目录 —— 那是「跑一次」的成本，
 *    不是「每次打开页面」的成本。而且 integrityCheck 收尾会 logMetric（一次库写 +
 *    一条审计行）：页面每刷一次就往审计链里塞一行，链会被浏览器刷成噪音。
 *    所以读侧只认摘要，「对账」这个动作永远由人/agent 显式发起。
 *
 * 🔴 摘要是**外部数据**（value_json 是历史行里的自由 JSON，字段可能缺、可能是老口径）。
 *    这里一律容错解析：读不动就当没有，绝不让首页因为一条脏摘要白屏。
 */
import { desc, eq } from "drizzle-orm";

import { metricEvent } from "~/server/db/schema";
import { getCoreDb, type CoreDbHandle } from "./db";
import type { CheckLevel } from "./integrity";

/** integrityCheck 收尾打点用的 kind（写侧在 integrity.ts，两处必须一致） */
export const INTEGRITY_METRIC_KIND = "integrity_check";

export interface IntegrityCheckItem {
  /** C1~C6 */
  id: string;
  name: string;
  ok: boolean;
  level: CheckLevel;
}

/** 最近一次对账的摘要（metric_event 里的一行，解析后） */
export interface IntegritySummary {
  /** metric_event.id */
  metricId: number;
  /** metric_event.ts（本地 ISO） */
  ts: string | null;
  ok: boolean;
  /** 见红的项 id */
  red: string[];
  /** 只是 warn 的项 id */
  warn: string[];
  /** 六项明细（WP6 之前落的老行没有这个字段 → 空数组，读侧回落到 id） */
  items: IntegrityCheckItem[];
}

type Json = Record<string, unknown>;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function asItems(v: unknown): IntegrityCheckItem[] {
  if (!Array.isArray(v)) return [];
  const out: IntegrityCheckItem[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Json;
    if (typeof o.id !== "string") continue;
    out.push({
      id: o.id,
      name: typeof o.name === "string" ? o.name : o.id,
      ok: o.ok === true,
      level: o.level === "warn" ? "warn" : "red",
    });
  }
  return out;
}

/** value_json → 摘要；解析不动返回 null（脏行当作「这条没有」） */
export function parseIntegritySummary(
  metricId: number,
  ts: string | null,
  valueJson: string | null,
): IntegritySummary | null {
  if (!valueJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Json;
  return {
    metricId,
    ts,
    ok: o.ok === true,
    red: asStringArray(o.red),
    warn: asStringArray(o.warn),
    items: asItems(o.items),
  };
}

/**
 * 最近一次对账摘要；一次也没跑过 = null。
 *
 * 🔴 按 id（自增）倒序而不是 ts：ts 是秒精度字符串，同一秒跑两次对账排序不稳定，
 *    而 id 单调。「最近一次」这种事不能有二义。
 */
export async function getLatestIntegritySummary(
  handle?: CoreDbHandle,
): Promise<IntegritySummary | null> {
  const h = handle ?? (await getCoreDb());
  const rows = await h.db
    .select({
      id: metricEvent.id,
      ts: metricEvent.ts,
      valueJson: metricEvent.valueJson,
    })
    .from(metricEvent)
    .where(eq(metricEvent.kind, INTEGRITY_METRIC_KIND))
    .orderBy(desc(metricEvent.id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return parseIntegritySummary(row.id, row.ts, row.valueJson);
}

// ---------------------------------------------------------------------------
// 红旗条显示态（纯函数）
// ---------------------------------------------------------------------------

/**
 * - `none`  从没对过账（灰条，告诉你怎么跑）
 * - `red`   有红旗（朱批红，逐项列出来）
 * - `green` 全绿，可能带 warn（细绿条）
 */
export type RedFlagState = "none" | "red" | "green";

export interface RedFlagView {
  state: RedFlagState;
  /** 条上那句话 */
  headline: string;
  /** red 态=红旗逐项；green 态=warn 逐项（可折叠）；none 态=空 */
  items: IntegrityCheckItem[];
  redCount: number;
  warnCount: number;
  /** 对账时刻（none 态为 null） */
  checkedAt: string | null;
}

const NO_CHECK_HEADLINE =
  "尚未对账 —— 跑 scripts/integrity-check 或 MCP integrity_check";

/** id 列表 → 明细：有 items 用 items 的名字，没有就拿 id 当名字（老行兼容） */
function pick(
  ids: string[],
  items: IntegrityCheckItem[],
  level: CheckLevel,
): IntegrityCheckItem[] {
  return ids.map(
    (id) =>
      items.find((i) => i.id === id) ?? { id, name: id, ok: false, level },
  );
}

/**
 * 摘要 → 显示态。**纯函数**：不碰库、不看时钟，所以三态能被单测钉死。
 *
 * 🔴 `ok === false` 但一条红旗都没列出来时，仍然按 red 报（并说明摘要不完整）：
 *    读侧遇到自相矛盾的摘要必须往「更吵」的方向倒 —— 把红旗静默成绿条，
 *    正是这条红旗条存在的意义所反对的事。
 */
export function redFlagView(summary: IntegritySummary | null): RedFlagView {
  if (!summary) {
    return {
      state: "none",
      headline: NO_CHECK_HEADLINE,
      items: [],
      redCount: 0,
      warnCount: 0,
      checkedAt: null,
    };
  }

  const reds = pick(summary.red, summary.items, "red");
  const warns = pick(summary.warn, summary.items, "warn");
  const checkedAt = summary.ts;

  if (!summary.ok || reds.length > 0) {
    const items =
      reds.length > 0
        ? reds
        : [
            {
              id: "?",
              name: "摘要说 ok=false，却没列出是哪几项（摘要不完整，请重跑对账）",
              ok: false,
              level: "red" as const,
            },
          ];
    return {
      state: "red",
      headline: `红旗 ${items.length} 项 · ${checkedAt ?? "时间未知"}`,
      items,
      redCount: items.length,
      warnCount: warns.length,
      checkedAt,
    };
  }

  return {
    state: "green",
    headline: `对账绿 · ${warns.length} warn · ${checkedAt ?? "时间未知"}`,
    items: warns,
    redCount: 0,
    warnCount: warns.length,
    checkedAt,
  };
}
