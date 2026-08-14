/**
 * 全站兜底加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 骨架是**中性**的：不画成某一页的样子。这一份要盖住所有还没自带
 *    loading.tsx 的路由，画得越像某页，进别的页时越像"闪了个错的东西"。
 * 🔴 壳（侧栏 / 面包屑 / 红旗条）留在原位不闪 —— 换的只是内容区。
 * 骨架形态收编自 `~/components/console/skeleton`（集成收口②）。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={140}
      note="正在读本地库…（现算不走缓存，慢一下是真的在算）"
      cards={[{ rows: 3 }, { rows: 5 }]}
    />
  );
}
