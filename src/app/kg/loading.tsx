/**
 * KG 治理线的加载骨架（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 本线的页全是 `force-dynamic` 的 server component —— 数据没读完，
 *    Next 就停在上一页不动（点了没反应）。/kg/kp/[id] 那页还要连圣域算
 *    群错误率，慢起来是秒级：那一段既不是白屏也不是"在转"，就是死住。
 * 🔴 挂在 /kg 段根上，`/kg/kp/**`、`/kg/tree/**`、`/kg/merge/**` 都继承它。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function KgLoading() {
  return (
    <PageSkeleton
      titleWidth={180}
      note="正在读知识图谱（core：版本树 / 考点盘点；考点详情还要连圣域 审核.db 现算群错误率，那一步是秒级）…"
      cards={[{ rows: 4 }, { rows: 4 }]}
    />
  );
}
