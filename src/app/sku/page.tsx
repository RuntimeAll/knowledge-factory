/**
 * 生产管理 · SKU 台账（AI:PRD-008 · P2 · 设计稿 §二·8）
 *
 * 🔴 这一页点亮的是首页那张「生产登记」占位卡。
 * 🔴 页面本身只做一件事：把 core 的两张枚举表（类型/状态）取出来传给表格组件。
 *    枚举**不许在前端抄第二份**：抄出来的那份迟早跟建表的 CHECK 漂。
 */
import { PageHead } from "~/components/console/page-head";
import { SKU_STATUSES, SKU_TYPES } from "~/core";
import { SkuTable } from "./table";

export const dynamic = "force-dynamic";

export default function SkuPage() {
  return (
    <>
      {/* 🔴 flexWrap 是手机上的必需品：不换行时右边那条「本页数据源」会把
          标题挤成竖排一个字一行（窄屏实测）。全站页头一律 wrap。 */}
      <PageHead
        title={<>SKU 台账</>}
        sub={
          <>卖的 / 备着卖的册子总账 —— 不管建 SKU（那是产线脚本和 MCP 的事）</>
        }
        source={
          <>
            core.listSkus + core.getSku · 表 sku / sku_item / sku_output /
            grading_task_map
          </>
        }
      />

      <SkuTable types={SKU_TYPES} statuses={SKU_STATUSES} />
    </>
  );
}
