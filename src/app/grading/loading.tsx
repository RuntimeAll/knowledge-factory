/**
 * 批改流水线组的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 这一组五个页都是 `force-dynamic` 的 server component，取数在服务端
 * （收卷录入要读 roster ∪ 圣域 batches；升档判据要把 审核.db 的 batches/items
 * 整个扫一遍现算三个率）。没有 loading.tsx 时 App Router **停在上一页不动** ——
 * 点了菜单没反应，人会以为点空了、再点一次。
 *
 * 🔴 只画骨架，不取数、不 import ~/core（app 层规矩照旧）。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function GradingLoading() {
  return (
    <PageSkeleton
      titleWidth={220}
      note="正在读圣域 审核.db（mode=ro）+ 名册 —— 升档判据那页还要扫 batches/items 全表现算三个率…"
      cards={[{ rows: 6 }]}
    />
  );
}
