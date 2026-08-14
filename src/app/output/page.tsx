/**
 * 生产管理 · 产物仓（AI:PRD-008 · P2 · 设计稿 §二·10）
 *
 * 🔴 页面只做两件事：把 SKU 下拉候选（core.listSkus）和产出类型枚举
 *    （core.SKU_OUTPUT_KINDS）取出来传给表格；`?sku=` 带进来就预置成筛选值
 *    （从 SKU 台账点「本册产物」过来时用）。
 */
import { DataSourceNote } from "~/components/console/ui";
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
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>产物仓</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          内容寻址仓里的实物件（PDF / 题单 JSON / 物料）—— 字节按 sha256
          存，路径只是指针
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.listSkus + core.getSku（展平 outputs）· 表 sku_output / asset ·
            下载走 /api/asset/&lt;hash&gt;
          </DataSourceNote>
        </span>
      </div>

      {listErr ? (
        <div style={{ fontSize: 12.5, color: "#c45656", marginBottom: 10 }}>
          SKU 下拉取不到（筛选框里会是空的，表格照常）：{listErr}
        </div>
      ) : null}

      <OutputTable
        skuOptions={options}
        kinds={SKU_OUTPUT_KINDS}
        {...(initialSku ? { initialSku } : {})}
      />
    </>
  );
}
