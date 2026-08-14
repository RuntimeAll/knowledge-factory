/**
 * 模型族谱的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 这一页慢在**族谱是逐道母题进去查的**：对每一道 origin 母题各调一次
 *    `getQuestion` + `getLineage`（母题多的模型就是十几次往返）。
 *    没有骨架时点「族谱」像没反应 —— 旧页面会一直停在那儿等。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={240}
      note="正在拼族谱：逐道母题调 core.getLineage，再从每条血缘里捞出本模型那一支…"
      cards={[
        { title: "基本信息", rows: 3 },
        { title: "母题", rows: 2 },
        { title: "派生题", rows: 4 },
      ]}
    />
  );
}
