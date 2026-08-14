/**
 * 审查队列 · 处置台（AI:PRD-008 · 地基改版；原件 AI:PRD-003 · 003-D）
 *
 * 设计稿 §二·14：所有等人拍板的东西一个入口，**每 tab = 标准表格 + 批量勾选**，
 * 操作列 = 通过 / 别名收编 / 打回 / 隔离处置。**不管**「为什么进队列」的规则 —— 那是闸的事。
 * 🔴 别把「批量处置」写成「批量视图」：那是把需求悄悄降一级（本页 2026-08-14 补上了
 *    勾选与批量通过，见 board.tsx 文件头）。
 *
 * 🔴 这一页只搭壳：tab / 角标 / 表格全在 `board.tsx`（client），
 *    处置动作仍是 003-D 那几个 server action（`actions.ts`）+ 三个确认子页
 *    （`/queue/[id]/alias`、`/queue/[id]/reject`、`/queue/quarantine/[id]`），
 *    一个都没重写。
 * 🔴 `?ok=` / `?err=` 是 server action 回执带回来的原话，原文照登。
 */
import { DataSourceNote } from "~/components/console/ui";
import { countOpenQueueByKind, listQuarantine } from "~/core";
import { QueueBoard } from "./board";
import { QUEUE_TABS, type QueueCounts, type QueueTab } from "./rows";

export const dynamic = "force-dynamic";

const 三类 = ["kp低置信", "图片", "新题草稿"];

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tabRaw = one(sp, "tab");
  const tab: QueueTab = (QUEUE_TABS as readonly string[]).includes(tabRaw)
    ? (tabRaw as QueueTab)
    : "kp";
  const stateRaw = one(sp, "state");
  const 可选态 =
    tab === "quarantine"
      ? ["open", "resolved", "all"]
      : ["open", "passed", "rejected"];
  const state = 可选态.includes(stateRaw) ? stateRaw : "open";

  // 首屏角标（之后每次表格取数会带回最新的一份）
  let counts: QueueCounts = {
    kp: 0,
    figure: 0,
    draft: 0,
    other: 0,
    quarantine: 0,
  };
  try {
    const [byKind, qr] = await Promise.all([
      countOpenQueueByKind(),
      listQuarantine({ state: "open", limit: 500 }),
    ]);
    const n = (kind: string) => byKind.find((k) => k.kind === kind)?.count ?? 0;
    counts = {
      kp: n("kp低置信"),
      figure: n("图片"),
      draft: n("新题草稿"),
      other: byKind
        .filter((k) => !三类.includes(k.kind))
        .reduce((a, b) => a + b.count, 0),
      quarantine: qr.length,
    };
  } catch {
    // 🔴 角标读不出来不该拦住整页：表格自己还会再取一次，那次的错会摆在页面上
  }

  const ok = one(sp, "ok");
  const err = one(sp, "err");

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>处置台</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          agent 拿不准的、管道拦下的、必须人看一眼的，都在这儿排队 ——
          处置一条，链条就往前走一格
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            表 review_queue / quarantine（处置动作走 core 原语，全上审计链）
          </DataSourceNote>
        </span>
      </div>

      <QueueBoard
        tab={tab}
        state={state}
        counts={counts}
        ok={ok || undefined}
        err={err || undefined}
      />
    </>
  );
}
