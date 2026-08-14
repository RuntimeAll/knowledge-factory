/**
 * 资料货架 · 两库对账（AI:PRD-009 · D-B 第三页 `/shelf/reconcile`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本页**同时读两个都叫「资料库.db」的文件**，所以每一栏都写清是谁：
 *      · 货架 punch 库 = `举一反三产物/资料库.db`（doc/asset/material 六类资料总账）
 *      · 本库          = `codeplace-AI/knowledge-factory/data/资料库.db`（sku/sku_output）
 * 🔴🔴 **差异只报不改**，两边都零写：punch 侧物理只读；本库侧只 SELECT，
 *      不 logMetric、不留审计行 —— 打开/刷新一个页面不该改库。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 首屏由 server 直接调 core 的 reconcileShelf 现算（本地 ~40ms），
 * 「重新跑一次」走 `/api/shelf/reconcile`，两条路同一个函数，口径不会漂。
 */
import { Alert } from "antd";
import Link from "next/link";

import { DataSourceNote } from "~/components/console/ui";
import { reconcileShelf } from "~/core";
import type { ReconcileReportView } from "../shared";
import { ReconcilePanels } from "./panels";

export const dynamic = "force-dynamic";

export default async function ShelfReconcilePage() {
  let report: ReconcileReportView | null = null;
  let loadError = "";
  try {
    report = await reconcileShelf();
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          资料对账
        </h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          货架成品 ↔ 本库 SKU / 网盘指针 —— 差异只报，不动任何一边
        </span>
        <span style={{ marginLeft: "auto", textAlign: "right" }}>
          <DataSourceNote>
            core.reconcileShelf · <b>punch 库</b>（
            {report?.punchDbPath ?? "举一反三产物/资料库.db"}
            ，mode=ro）asset / doc + <b>本库</b> sku / sku_output / asset —— 🔴
            两个库同名不同物
          </DataSourceNote>
        </span>
      </div>

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="对账跑不起来（原文照登）"
          description={
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {loadError}
              {"\n\n"}
              两库任意一边读不动都会到这儿：货架侧看 .env 的 <b>PUNCH_DB_URL</b>
              （必须带 ?mode=ro），本库侧看 DATABASE_URL。 货架浏览面在{" "}
              <Link href="/shelf">资料货架</Link>，它只用货架库、不受本库影响。
            </div>
          }
        />
      ) : report ? (
        <ReconcilePanels initial={report} />
      ) : null}
    </>
  );
}
