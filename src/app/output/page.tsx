/**
 * 生产管理 · 产物仓（AI:PRD-008 · P2 · 设计稿 §二·10）
 *
 * 🔴 页面只做两件事：把 SKU 下拉候选（core.listSkus）和产出类型枚举
 *    （core.SKU_OUTPUT_KINDS）取出来传给表格；`?sku=` 带进来就预置成筛选值
 *    （从 SKU 台账点「本册产物」过来时用）。
 */
import { Alert } from "antd";

import { PageHead } from "~/components/console/page-head";
import { SKU_OUTPUT_KINDS, listSkus } from "~/core";
import type { SkuOption } from "./shared";
import { OutputTable } from "./table";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function OutputPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const initialSku = one(sp, "sku");

  let options: SkuOption[] = [];
  let listErr = "";
  try {
    const skus = await listSkus({ limit: 500 });
    options = skus.map((s) => ({
      value: s.id,
      label: `${s.name}（${s.type ?? "未填类型"} · ${s.outputs} 件）`,
    }));
  } catch (e) {
    // 🔴 下拉取不到不该拦住整页：表格自己还会取一次数，那次的错会摆在页面上
    listErr = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      {/* 🔴 flexWrap：窄屏上不换行，右边的数据源小字会把标题挤成竖排（全站页头一律 wrap） */}
      <PageHead
        title={<>产物仓</>}
        sub={
          <>
            内容寻址仓里的实物件（PDF / 题单 JSON / 物料）—— 字节按 sha256
            存，路径只是指针
          </>
        }
        source={
          <>
            core.listSkus + core.getSku（展平 outputs）· 表 sku_output / asset ·
            下载走 /api/asset/&lt;hash&gt;
          </>
        }
      />

      {/* 🔴 报错一律走 Alert（全站同一形态），不再用一行红字：
          红字在密集的页头里几乎看不见，而这条恰恰是「筛选框为什么空着」的唯一解释。 */}
      {listErr ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="SKU 下拉候选取不到 —— 筛选区的「所属 SKU」会是空的（表格照常出数）"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {listErr}
            </span>
          }
        />
      ) : null}

      <OutputTable
        skuOptions={options}
        kinds={SKU_OUTPUT_KINDS}
        {...(initialSku ? { initialSku } : {})}
      />
    </>
  );
}
