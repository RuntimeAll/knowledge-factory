/**
 * 册子详情的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴🔴 同名异库：本页读 **punch 库 `举一反三产物/资料库.db`**（mode=ro），
 *      不是本库的 `data/资料库.db`。
 * 🔴 一次读六张表（doc / material / asset / doc_member / publish_log / question），
 *    在手机上（跨网卡访问 dev server）这一跳明显能感觉到 —— 骨架不能省。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={280}
      note={
        <>
          正在读这一册（core.getShelfDoc · punch 库 mode=ro：doc / material /
          asset / doc_member / publish_log / question）…
        </>
      }
      cards={[{ title: "基本信息", rows: 4 }, { rows: 5 }]}
    />
  );
}
