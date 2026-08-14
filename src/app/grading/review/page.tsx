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
import { PageHead } from "~/components/console/page-head";
import { ReviewQueueTable } from "./table";

export const dynamic = "force-dynamic";

export default function GradingReviewPage() {
  return (
    <>
      <PageHead
        title={<>终审台</>}
        sub={
          <>
            agent 预批只是草稿：每题给出终审 √ / × / 去掉，全部定完才谈得上出件
          </>
        }
        source={
          <>
            审核.db（mode=ro：batches / items / feedback）—— 队列口径照抄
            审核库.py 的 pending()：status ∈ (pending, rework)
          </>
        }
      />

      <ReviewQueueTable />
    </>
  );
}
