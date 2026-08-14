/**
 * 题目详情的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 只挂在 `[id]` 上、不挂在 /question 段根上：列表页的取数在 client
 *    （ProTable 自己有 loading 转圈），给它加骨架反而会在每次翻页时闪一下整页。
 *    详情页则是 server 现算三份数据（题 + 血缘 + 归属），中间那段必须有交代。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function QuestionDetailLoading() {
  return (
    <PageSkeleton
      titleWidth={160}
      note="正在读这道题（core：题正本 + 血缘 getLineage + 考点归属，三份一起取）…"
      cards={[{ rows: 6 }, { rows: 4 }]}
    />
  );
}
