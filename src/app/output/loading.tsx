/**
 * 产物仓的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 这一页的 server 段要先取 SKU 下拉候选（core.listSkus，一次 500 本），
 *    表格的行数据才由 client 走 /api/outputs 取（那一段有 ProTable 自己的 loading）。
 *    没有本文件时，从 SKU 详情点「本册产物」会**停在旧页面上等** ——
 *    看上去像链接没反应。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={160}
      note="正在取册子候选（core.listSkus）—— 取回来才画得出「所属 SKU」那个下拉…"
      cards={[{ rows: 6 }]}
    />
  );
}
