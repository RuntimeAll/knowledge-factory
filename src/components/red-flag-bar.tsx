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

/**
 * 三态配色（集成收口②改：原来这条是全站最后一处「学术纸感」旧配色 ——
 * Tailwind 的 `bg-code / text-mut / --acc 学术绿 #0e6b4f`，而管理台其余
 * 25 页早已整体换成 antd 那套。它由壳**每页通栏**渲染，所以是检查单 ⑩
 * 现存最刺眼的一处：同一屏上半截学术绿、下半截 antd 蓝。
 *
 * 🔴 只换颜色，不碰判定：`data-red-flag-state` / `role="alert"` / 灯的字形 /
 *    三态文案 / redFlagView() 一个字没动 —— 这是条安全件，改的只有皮。
 * 🔴 红仍然是红（#f56c6c 系）、绿仍然是绿、读不出仍然是灰：
 *    三态在屏幕上必须一眼分得开，"统一配色"绝不能把红态调淡。
 * 🔴 改成内联样式而不是换几个 Tailwind 类：那几个 token（--acc / --code /
 *    --mut）现在只剩本文件在用，留着类名等于把一整套退役设计吊在这儿。
 */
const TONE = {
  // 灰：不知道 ≠ 没事（读不到库、还没跑过对账）
  none: { border: "#c0c4cc", bg: "#f4f4f5", fg: "#909399", weight: 400 },
  // 红：库不可信
  red: { border: "#f56c6c", bg: "#fef0f0", fg: "#f56c6c", weight: 600 },
  // 绿：最近一次对账全过
  green: { border: "#67c23a", bg: "#f0f9eb", fg: "#529b2e", weight: 400 },
} as const;

/** 状态灯：红态用旗，其余用圆点（文案已在 headline 里，别在灯旁边重复一遍） */
const LAMP = { none: "○", red: "⚑", green: "●" } as const;

export async function RedFlagBar() {
  const [{ view, error }, 工单] = await Promise.all([load(), 未处置()]);
  const { state } = view;

  const tone = TONE[state];
  const num: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

  return (
    <div
      data-red-flag-state={state}
      role={state === "red" ? "alert" : undefined}
      style={{
        // 🔴 内边距跟着壳走：窄屏 12px（壳的正文也是 12），桌面 30px。
        //    用 clamp 不用媒体查询 —— 这是 server 组件，少一段 <style> 少一处漂。
        padding: "7px clamp(12px, 4vw, 30px)",
        fontSize: 12.5,
        borderBottom: "1px solid #ebeef5",
        borderLeft: `3px solid ${tone.border}`,
        background: tone.bg,
        color: tone.fg,
        fontWeight: tone.weight,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          columnGap: 8,
          rowGap: 4,
        }}
      >
        <span style={{ fontSize: 10 }}>{LAMP[state]}</span>
        <span style={{ ...num, wordBreak: "break-word" }}>{view.headline}</span>
        {/* red 态的 headline 只讲红旗，warn 数在这儿补一句（绿态 headline 已经带了） */}
        {state === "red" && view.warnCount > 0 ? (
          <span style={{ color: "#e6a23c", fontWeight: 400 }}>
            另有 warn {view.warnCount} 项
          </span>
        ) : null}

        {/* 🔴 工单是流程不是事故：橙一枚徽章，点得进去，零 open 时整枚不出现 */}
        {工单.total > 0 ? (
          <Link
            href="/queue"
            style={{
              marginLeft: "auto",
              border: "1px solid #f3d19e",
              background: "#fdf6ec",
              color: "#e6a23c",
              borderRadius: 2,
              padding: "1px 8px",
              fontWeight: 400,
              textDecoration: "none",
            }}
          >
            工单 open <span style={num}>{工单.total}</span>
            {工单.label ? `：${工单.label}` : ""}
          </Link>
        ) : null}
      </div>

      {/* red：逐项列出来——「红旗 3 项」不说是哪三项等于没说 */}
      {state === "red" ? (
        <ul style={{ marginTop: 4, paddingLeft: 0, fontWeight: 400 }}>
          {view.items.map((it) => (
            <li
              key={it.id}
              style={{ listStyle: "none", wordBreak: "break-word" }}
            >
              <span style={{ ...num, marginRight: 8 }}>{it.id}</span>
              {it.name}
            </li>
          ))}
        </ul>
      ) : null}

      {/* green 且有 warn：原生折叠，不为这点事拉 JS */}
      {state === "green" && view.items.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "#909399" }}>
            warn 明细（{view.items.length} 项 · 不拦路）
          </summary>
          <ul style={{ marginTop: 4, paddingLeft: 0, color: "#909399" }}>
            {view.items.map((it) => (
              <li
                key={it.id}
                style={{ listStyle: "none", wordBreak: "break-word" }}
              >
                <span style={{ ...num, marginRight: 8 }}>{it.id}</span>
                {it.name}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {error ? (
        <div style={{ marginTop: 4, color: "#909399", fontWeight: 400 }}>
          读库失败：{error}
        </div>
      ) : null}
    </div>
  );
}

export default RedFlagBar;
