/**
 * 两库对账的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴🔴 同名异库：这一页**同时读两个都叫「资料库.db」的文件** ——
 *      货架 punch 库（`举一反三产物/资料库.db`，mode=ro）+ 本库
 *      （`data/资料库.db`，只 SELECT）。骨架里就把这句摆出来：
 *      对账跑不起来时（多半是 PUNCH_DB_URL 没配），人第一眼就知道卡在哪一边。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={180}
      note={
        <>
          正在对账（core.reconcileShelf）：扫货架 punch 库的 asset / doc +
          本库的 sku / sku_output，再按三条轴两两配对
          <br />
          （轴 A 成品文件=强键 · 轴 B 册子配对 · 轴 C 网盘指针）—— 🔴
          两库同名不同物，两边都只读。
        </>
      }
      cards={[
        { title: "轴 A · 成品文件", rows: 4 },
        { title: "轴 B · 册子配对", rows: 3 },
        { title: "轴 C · 网盘指针", rows: 3 },
      ]}
    />
  );
}
