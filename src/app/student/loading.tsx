/**
 * 学情中心（名册 / 学员学情）的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * `/student/[code]` 是最重的一页：`getStudentView` 要读圣域 审核.db（mode=ro）
 * 再逐题对位到本库的 sku_item / question_kp / err_code_map，一次几百毫秒起。
 * 没有骨架时点进去像卡住了。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function StudentLoading() {
  return (
    <PageSkeleton
      titleWidth={220}
      note="正在读学情（core.getStudentView：圣域 审核.db mode=ro，再逐题对位本库 sku_item / question_kp / err_code_map）…"
      cards={[{ rows: 2 }, { rows: 6 }]}
    />
  );
}
