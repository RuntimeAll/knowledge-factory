/**
 * 资料货架列表的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴🔴 同名异库：这一页首屏读的是 **punch 库 `举一反三产物/资料库.db`**（mode=ro），
 *      不是本库的 `data/资料库.db`。骨架里也把这句写出来 ——
 *      货架第一次打开时最常见的失败就是 PUNCH_DB_URL 没配，
 *      看得见「正在读哪个库」，那条报错才接得上。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={180}
      note={
        <>
          正在读货架库（core.listShelfDocs · punch 库 举一反三产物/资料库.db，
          mode=ro）—— 🔴 同名异库，不是本库的 data/资料库.db
        </>
      }
      cards={[{ rows: 6 }]}
    />
  );
}
