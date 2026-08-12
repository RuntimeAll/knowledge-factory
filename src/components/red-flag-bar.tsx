/**
 * 全局红旗条（AI:PRD-001 · WP6）
 *
 * 挂在 layout 里，**每一页顶部常驻**。它回答一个问题：这库现在可信吗。
 *
 * 🔴 只读最近一次对账的摘要（metric_event），不现跑六项对账：
 *    对账要连圣域、扫全表、遍历 assets，还会写一条 metric + 审计行 ——
 *    那是「跑一次」的成本，不能挂在「每次页面加载」上（理由详见 core/status.ts 文件头）。
 *    代价是：条上的时间就是你上次跑对账的时间，陈旧与否一眼可见（所以时间必须显示）。
 *
 * 🔴 读不到库时**退成灰条**而不是绿条：不知道 ≠ 没事。
 *    （build 期预渲染、库文件不在位，都会走到这条路。）
 *
 * 三态与文案的映射是纯函数 redFlagView()，在 core 里，可单测；本文件只管画。
 *
 * ── 003-D 扩面：开放工单徽章 ────────────────────────────────────────────────
 * 🔴 工单是**流程**不是**事故**：所以徽章一律 amber，绝不进红旗那三态。
 *    「队列里积着 3 张图审」不该让红旗条变红 —— 红是「库不可信」，
 *    把流程性待办也染红，红旗就会被当成噪音，那才是真正的损失。
 * 🔴 零 open 不显示：没活儿的时候，条上就不该有这一行。
 */
import Link from "next/link";

import {
  countOpenQueueByKind,
  getLatestIntegritySummary,
  listQuarantine,
  redFlagView,
  type IntegritySummary,
  type RedFlagView,
} from "~/core";

async function load(): Promise<{
  view: RedFlagView;
  /** 读库异常的人话（正常为 null） */
  error: string | null;
}> {
  let summary: IntegritySummary | null = null;
  try {
    summary = await getLatestIntegritySummary();
  } catch (e) {
    return { view: redFlagView(null), error: String(e) };
  }
  return { view: redFlagView(summary), error: null };
}

/** 开放工单摘要（🔴 读不动就当没有：队列徽章绝不能把红旗条本身搞崩） */
async function 未处置(): Promise<{ label: string; total: number }> {
  try {
    const [byKind, qr] = await Promise.all([
      countOpenQueueByKind(),
      listQuarantine({ state: "open", limit: 500 }),
    ]);
    const 项 = [
      ...byKind.filter((k) => k.count > 0).map((k) => `${k.kind}${k.count}`),
      ...(qr.length > 0 ? [`隔离${qr.length}`] : []),
    ];
    const total = byKind.reduce((a, b) => a + b.count, 0) + qr.length;
    return { label: 项.join(" · "), total };
  } catch {
    return { label: "", total: 0 };
  }
}

const TONE = {
  none: "border-l-hair2 bg-code text-mut",
  red: "border-l-pen bg-pen-soft text-pen font-semibold",
  green: "border-l-acc bg-acc-soft text-acc-deep",
} as const;

/** 状态灯：红态用旗，其余用圆点（文案已在 headline 里，别在灯旁边重复一遍） */
const LAMP = { none: "○", red: "⚑", green: "●" } as const;

export async function RedFlagBar() {
  const [{ view, error }, 工单] = await Promise.all([load(), 未处置()]);
  const { state } = view;

  return (
    <div
      data-red-flag-state={state}
      role={state === "red" ? "alert" : undefined}
      className={`border-b-hair border-b border-l-[3px] px-[30px] py-[7px] text-[12.5px] ${TONE[state]}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[10px]">{LAMP[state]}</span>
        <span className="num break-words">{view.headline}</span>
        {/* red 态的 headline 只讲红旗，warn 数在这儿补一句（绿态 headline 已经带了） */}
        {state === "red" && view.warnCount > 0 ? (
          <span className="text-amber font-normal">
            另有 warn {view.warnCount} 项
          </span>
        ) : null}

        {/* 🔴 工单是流程不是事故：amber 一枚徽章，点得进去，零 open 时整枚不出现 */}
        {工单.total > 0 ? (
          <Link
            href="/queue"
            className="border-amber/30 bg-amber-soft text-amber ml-auto rounded-[2px] border px-2 py-[1px] font-normal no-underline"
          >
            工单 open <span className="num">{工单.total}</span>
            {工单.label ? `：${工单.label}` : ""}
          </Link>
        ) : null}
      </div>

      {/* red：逐项列出来——「红旗 3 项」不说是哪三项等于没说 */}
      {state === "red" ? (
        <ul className="mt-1 space-y-0.5 font-normal">
          {view.items.map((it) => (
            <li key={it.id} className="break-words">
              <span className="num mr-2">{it.id}</span>
              {it.name}
            </li>
          ))}
        </ul>
      ) : null}

      {/* green 且有 warn：原生折叠，不为这点事拉 JS */}
      {state === "green" && view.items.length > 0 ? (
        <details className="mt-1">
          <summary className="text-mut cursor-pointer">
            warn 明细（{view.items.length} 项 · 不拦路）
          </summary>
          <ul className="text-mut mt-1 space-y-0.5">
            {view.items.map((it) => (
              <li key={it.id} className="break-words">
                <span className="num mr-2">{it.id}</span>
                {it.name}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? (
        <div className="text-mut mt-1 font-normal">读库失败：{error}</div>
      ) : null}
    </div>
  );
}

export default RedFlagBar;
