/**
 * 处置台线的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 处置台首屏要现算五个 tab 的角标（含隔离区一次 500 行的扫描），
 *    三个确认子页（别名 / 驳回 / 隔离改判）还要读工单卡片包 ——
 *    全是 server 端现算，没有骨架的话点下去就是"死一下"。
 * 🔴 挂在 /queue 段根上，三个子页继承。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function QueueLoading() {
  return (
    <PageSkeleton
      titleWidth={160}
      note="正在现算各 tab 的角标（core.countOpenQueueByKind + listQuarantine 一次扫 500 行）…"
      cards={[{ rows: 8 }]}
    />
  );
}
