/**
 * 批改流水线 · 批改看板（AI:PRD-008 · 设计稿 §二 批改流水线组第 2 页）
 *
 * 职责：今日流水一行一批——从收件到出件的状态一眼看完。
 * **不管**：终审（那在审核台 :7801，页面只给直链）、判定口径（产线正本的事）。
 *
 * 🔴 全只读：审核.db 走 core 的 mode=ro 句柄（G-1 红线），收件段读 `_队列.jsonl`。
 * 🔴 两段不合并：收件段（事件流）与批改段（审核.db）各是各的行 ——
 *    编排台账没建之前，谁也没资格把它们 join 成一条（唯一事实源纪律）。
 */
import { DataSourceNote } from "~/components/console/ui";
import { listRoster } from "~/core";
import { BoardTable } from "./table";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function GradingBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const code = one(sp, "code");

  let codes: string[] = [];
  try {
    codes = (await listRoster()).map((r) => r.code);
  } catch {
    // 名册读不出来只影响下拉候选（可以直接敲代号），不该拦住整页
  }

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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>批改看板</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          一行一批：收件中 → 待认卷 → 批改中 → 待审核 / 已放行 / 已出件
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            审核.db（mode=ro：batches / items / feedback）+ core bridgeBatches
            挂桥 + 收件箱/_队列.jsonl 收件段 —— 本页零写
          </DataSourceNote>
        </span>
      </div>

      <BoardTable codes={codes} defaultCode={code || undefined} />
    </>
  );
}
