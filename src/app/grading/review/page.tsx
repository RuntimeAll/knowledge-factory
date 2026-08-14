/**
 * 终审台 · 待审队列（AI:PRD-009 · 设计稿 §二「/grading/review」）
 *
 * 职责：替代审核台 :7801 的首屏 —— 哪几批等你审、哪几批被你打回还没回来。
 * **不管**：判定口径（`批改标准.md` 是产线正本）、出件（确认 ≠ 出件，见详情页）。
 *
 * 🔴 读：审核.db 走 core 的 mode=ro 句柄（G-1 红线）。
 * 🔴 写：一个都不在本页 —— 确认/打回/撤回全在逐题终审页，且全部 spawn 审核库.py。
 * 🔴 学员只代号（本产品从不落真名）。
 */
import { DataSourceNote } from "~/components/console/ui";
import { ReviewQueueTable } from "./table";

export const dynamic = "force-dynamic";

export default function GradingReviewPage() {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>终审台</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          agent 预批只是草稿：每题给出终审 √ / × / 去掉，全部定完才谈得上出件
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            审核.db（mode=ro：batches / items / feedback）—— 队列口径照抄
            审核库.py 的 pending()：status ∈ (pending, rework)
          </DataSourceNote>
        </span>
      </div>

      <ReviewQueueTable />
    </>
  );
}
