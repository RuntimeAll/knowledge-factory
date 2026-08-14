/**
 * 错因管理 / 补映射的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * `/cause` 一次要算三块（listCauses → 逐个 getCause 拼 err_code_map 全量 +
 * causeDistribution 现算挂桥），错因多起来就不是瞬间的事；`/cause/map` 第二步
 * 还要再查一遍「这一组是不是已经映射过」。没有骨架时这两页都是「点了没反应」。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function CauseLoading() {
  return (
    <PageSkeleton
      titleWidth={220}
      note="正在读错因台账（core.listCauses → 逐个 getCause 拼 err_code_map 全量 + causeDistribution 现算挂桥）…"
      cards={[{ rows: 6 }]}
    />
  );
}
