/**
 * 资料货架 · 六类资料总览（AI:PRD-009 · D-B 第一页 `/shelf`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本页读 **punch 库 `举一反三产物/资料库.db`**（六类资料总账：
 *      doc / question / asset / material / doc_member），**不是**本库的
 *      `data/资料库.db`。两个文件同名、schema 完全不同、数据零交集。
 * 🔴🔴 全程 mode=ro、**零写**；两库绝不互写。
 *      货架收编 = **只读挂载先行**：v1(:8787)/v2(:3000) 退役与数据正式迁移
 *      要用户最后点头，本卡一行都不动。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 职责：六类资料按类目浏览 —— 哪些在售、哪些还差东西、哪本能点进去看物料和配图。
 * **不管**：改任何一个字（人工态只有人能在 punch-console 上点）、发布动作（用户手机人工发）。
 *
 * 🔴 首屏的分类 tab 与筛选候选由 server 先算好传下去（`listShelfDocs` 本地 ~20ms）：
 *    tab 是这一页的主导航，让它等一次 fetch 才出现 = 打开就是一片空白。
 *    行数据仍由 client 走 `/api/shelf/docs` 取（筛选/换 tab 都只重取行）。
 */
import { Alert, Card } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import { EmptyHint } from "~/components/console/ui";
import { listShelfDocs } from "~/core";
import { ShelfTable } from "./table";
import { SHELF_TYPE_ORDER, type ShelfFacetsView } from "./shared";

export const dynamic = "force-dynamic";

/** 地址栏取一个值（数组/缺失都当没给） */
function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function ShelfPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const keyword = one(sp, "keyword");
  const type = one(sp, "type");

  let facets: ShelfFacetsView | null = null;
  let totalDocs = 0;
  let dbPath = "";
  let warnings: string[] = [];
  let loadError = "";
  try {
    const r = await listShelfDocs();
    facets = r.facets;
    totalDocs = r.totalDocs;
    dbPath = r.dbPath;
    warnings = r.warnings;
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <>
      <PageHead
        title={<>资料货架</>}
        sub={<>六类资料的总账（{SHELF_TYPE_ORDER.join(" / ")}）—— 只看不改</>}
        source={
          <>
            core.listShelfDocs · <b>punch 库</b>（
            {dbPath || "举一反三产物/资料库.db"}
            ，mode=ro）表 doc / question / asset / material / doc_member —— 🔴
            同名异库，不是本库的 data/资料库.db
          </>
        }
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="货架库读不出来（原文照登）"
          description={
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {loadError}
              {"\n\n"}
              最常见的一条：`.env` 里没配 <b>PUNCH_DB_URL</b>（或没带{" "}
              <b>?mode=ro</b>）。它是<b>只读挂载</b>
              声明，core 不会替你补上——写不出这个意图就不许连。
            </div>
          }
        />
      ) : null}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            本页对货架库<b>只读</b>（mode=ro，物理零写路径），两库绝不互写。
            「在售 / 待整理 / 停售」是 <b>doc.人工态</b>，<b>只有人能点</b>（在
            punch-console 上）；其余泳道与体检灯全是
            <b>现算</b>的，提醒不拦路。
          </span>
        }
        description={
          <span style={{ fontSize: 12.5, color: "#606266" }}>
            对账（货架成品 ↔ 本库 SKU / 网盘指针）在{" "}
            <Link href="/shelf/reconcile">资料对账</Link>
            ，那一页也只报差异、不改任何一边。
          </span>
        }
      />

      {warnings.map((w, i) => (
        <Alert
          key={i}
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={<span style={{ fontSize: 12.5 }}>{w}</span>}
        />
      ))}

      {facets ? (
        <ShelfTable
          facets={facets}
          totalDocs={totalDocs}
          {...(keyword ? { defaultKeyword: keyword } : {})}
          {...(type ? { defaultType: type } : {})}
        />
      ) : loadError ? null : (
        // 🔴 空态照口径原句写 + 给下一步（设计稿 §三·6）：
        //    「货架上没有」不等于「没做过册子」—— 差的是产线那一步 import。
        <Card size="small">
          <EmptyHint>
            货架库连上了，但 <b>doc 表一行都没有</b>。🔴
            它的意思是「这个库里还没登记过任何一份资料」，
            <b>不是</b>「本机没做过册子」—— 册子做完要跑一次产线的 import
            才会登记进货架库。
            <br />
            先确认 <b>PUNCH_DB_URL</b> 指的是{" "}
            <code>举一反三产物/资料库.db</code>（🔴 同名异库，别指到本库的
            data/资料库.db 上，那边没有 doc 表）， 再去产线跑
            import。两库对不对得上可以看{" "}
            <Link href="/shelf/reconcile">资料对账</Link>。
          </EmptyHint>
        </Card>
      )}
    </>
  );
}
