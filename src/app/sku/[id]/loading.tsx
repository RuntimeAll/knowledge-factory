/**
 * 册子详情 / 上下架确认页的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 这两页是 **server component + force-dynamic**，没有 loading.tsx 时
 *    Next 的路由会**停在旧页面上等**（点了「详情」像没反应）。
 * 🔴 本文件同时罩住 `[id]/status`（确认页）：App Router 里最近的 loading 边界
 *    覆盖本段与所有未自建边界的子段。`dedup` 自己有一份（那页慢得多，话也不一样）。
 * 🔴 骨架的形状照着真页面摆（标题 → 信息卡 → 题单 → 产物），别用一坨通用灰条：
 *    形状对得上，切换时不会「跳一下」。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={260}
      note="正在读这本册子（core.getSku：sku / sku_item / sku_output / grading_task_map 一次读齐）…"
      cards={[
        { title: "基本信息", rows: 3 },
        { title: "题单", rows: 4 },
        { title: "产物", rows: 2 },
      ]}
    />
  );
}
