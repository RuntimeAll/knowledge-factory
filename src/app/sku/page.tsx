/**
 * 生产管理 · SKU 台账（AI:PRD-008 · P2 · 设计稿 §二·8）
 *
 * 🔴 这一页点亮的是首页那张「生产登记」占位卡。
 * 🔴 页面本身只做一件事：把 core 的两张枚举表（类型/状态）取出来传给表格组件。
 *    枚举**不许在前端抄第二份**：抄出来的那份迟早跟建表的 CHECK 漂。
 */
import { DataSourceNote } from "~/components/console/ui";
import { SKU_STATUSES, SKU_TYPES } from "~/core";
import { SkuTable } from "./table";

export const dynamic = "force-dynamic";

export default function SkuPage() {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>SKU 台账</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          卖的 / 备着卖的册子总账 —— 不管建 SKU（那是产线脚本和 MCP 的事）
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.listSkus + core.getSku · 表 sku / sku_item / sku_output /
            grading_task_map
          </DataSourceNote>
        </span>
      </div>

      <SkuTable types={SKU_TYPES} statuses={SKU_STATUSES} />
    </>
  );
}
