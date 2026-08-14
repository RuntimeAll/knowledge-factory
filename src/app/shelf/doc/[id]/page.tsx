/**
 * 资料货架 · 册子详情（AI:PRD-009 · D-B 第二页 `/shelf/doc/[id]`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本页读 **punch 库 `举一反三产物/资料库.db`**（doc/material/asset/
 *      doc_member/publish_log），**不是**本库的 `data/资料库.db`。两文件同名不同物。
 * 🔴🔴 全程 mode=ro、零写；两库绝不互写。页面上**没有任何一个能改字的控件**——
 *      人工态、物料、产物都在原产线那边改。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 一册的全貌：基本信息 + 体检灯 + 合刊互链 + 四个 tab（物料 / 产物 / 题目 / 发布台账）。
 *
 * 🔴 详情页不进菜单（若依习惯：要 id 才打得开），面包屑走 menu.ts 的 HIDDEN_CRUMBS。
 * 🔴 A/B 号开关同时管**物料与配图**两块（配图必须跟文案同号，是发布纪律），
 *    所以那个开关的状态由 client 的 DocPanels 一处持有，不拆成两块各管各的。
 */
import { Alert, Card, Descriptions, Tag, Tooltip } from "antd";
import Link from "next/link";

import { DataSourceNote, EmptyHint } from "~/components/console/ui";
import { getShelfDoc } from "~/core";
import {
  CHECK_COLOR,
  LANE_COLOR,
  LANE_HINT,
  type ShelfDocDetailView,
} from "../../shared";
import { DocPanels } from "./panels";

export const dynamic = "force-dynamic";

export default async function ShelfDocPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const id = Number(raw);

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <Card size="small">
        <EmptyHint>
          册子 id 得是个正整数（punch 的 doc.id 是自增整数，不是本库那种
          ULID）—— 收到的是 {JSON.stringify(raw)}。回{" "}
          <Link href="/shelf">资料货架</Link> 从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  let detail: ShelfDocDetailView | null = null;
  let loadError = "";
  try {
    detail = await getShelfDoc(id);
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="这本册子读不出来（原文照登）"
        description={
          <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {loadError}
            {"\n"}doc.id = {id}
            {"\n\n"}
            最常见的一条：`.env` 里没配 PUNCH_DB_URL（或没带 ?mode=ro）。
          </div>
        }
      />
    );
  }
  if (!detail) {
    return (
      <Card size="small">
        <EmptyHint>
          punch 库的 doc 表里没有 id = {id} 这一行。回{" "}
          <Link href="/shelf">资料货架</Link> 从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  const d = detail.doc;
  const 待判 = d.checks.filter((c) => c.state !== "免");
  const 缺 = 待判.filter((c) => c.state === "缺").length;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{d.name}</h1>
        <Tooltip title={LANE_HINT[d.lane]}>
          <Tag color={LANE_COLOR[d.lane]}>{d.lane}</Tag>
        </Tooltip>
        <Tag>{d.type}</Tag>
        {d.form === "合刊" ? <Tag color="purple">合刊</Tag> : null}
        {d.version ? (
          <span style={{ fontSize: 12.5, color: "#909399" }}>{d.version}</span>
        ) : null}
        <span style={{ marginLeft: "auto", textAlign: "right" }}>
          <DataSourceNote>
            core.getShelfDoc · <b>punch 库</b>（{detail.dbPath}，mode=ro）表 doc
            / material / asset / doc_member / publish_log / question —— 🔴
            同名异库，不是本库的 data/资料库.db
          </DataSourceNote>
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <Link href="/shelf">← 回货架</Link>
        {d.group ? (
          <Link href={`/shelf?keyword=${encodeURIComponent(d.group)}`}>
            同组的册子（{d.group}）
          </Link>
        ) : null}
        <Link href="/shelf/reconcile">两库对账</Link>
        {d.netdiskLink ? (
          <a href={d.netdiskLink} target="_blank" rel="noreferrer">
            打开网盘分享
          </a>
        ) : null}
      </div>

      <Alert
        type="info"
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            体检
            {缺 === 0 ? (
              <>
                <b> 全绿</b>（{待判.length} 项待判）
              </>
            ) : (
              <>
                还缺 <b>{缺}</b> 项 / 共 {待判.length} 项待判
              </>
            )}
            ：
            <span
              style={{
                marginLeft: 6,
                display: "inline-flex",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              {d.checks.map((c) => (
                <Tooltip key={c.name} title={c.note}>
                  <Tag
                    color={CHECK_COLOR[c.state]}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {c.name} · {c.note}
                  </Tag>
                </Tooltip>
              ))}
            </span>
          </span>
        }
        description={
          <span style={{ fontSize: 12, color: "#606266" }}>
            🔴 体检<b>提醒不拦路</b>；灯全绿 = <b>能发</b>，不等于<b>已发</b> ——
            中间隔着一次人工动作（人工态只有人能点，本页点不动）。
          </span>
        }
      />

      <Card size="small" title="基本信息" style={{ marginBottom: 12 }}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: "type", label: "类型", children: d.type },
            {
              key: "form",
              label: "册型",
              children:
                d.form === "合刊" ? (
                  <Tooltip title="合刊 = 成员册的合订本，它自己不挂题（题在成员册里，再灌一遍就是同一批题存两份）">
                    <span>合刊</span>
                  </Tooltip>
                ) : (
                  (d.form ?? "（未填）")
                ),
            },
            { key: "ver", label: "版本名", children: d.version ?? "（未填）" },
            {
              key: "group",
              label: "归属组",
              children: d.group ? (
                <Link href={`/shelf?keyword=${encodeURIComponent(d.group)}`}>
                  {d.group}
                </Link>
              ) : (
                <Tooltip title="doc.组名 是空的：这一册自成一组">
                  <span style={{ color: "#909399" }}>自成一组</span>
                </Tooltip>
              ),
            },
            {
              key: "subject",
              label: "科目",
              children: d.subject ?? "（未填）",
            },
            {
              key: "grade",
              label: "年级",
              children: d.grade ? (
                <Tooltip title="🔴 库里「七年级上册」与「七上」两种写法并存，按年级筛会分裂成两堆（口径待拍板）">
                  <span>{d.grade}</span>
                </Tooltip>
              ) : (
                "（未填）"
              ),
            },
            {
              key: "manual",
              label: "人工态",
              children: d.manualState ? (
                <Tooltip title="doc.人工态 = 唯一人工开关，只有人能点（在 punch-console 上），产线代码一行都不许写">
                  <Tag>{d.manualState}</Tag>
                </Tooltip>
              ) : (
                <Tooltip title="人工态为空 = 交回四盏灯现算（泳道那一栏就是算出来的）">
                  <span style={{ color: "#909399" }}>未标（走现算）</span>
                </Tooltip>
              ),
            },
            {
              key: "layout",
              label: "版式 layout_key",
              children: d.layoutKey ?? "（未填）",
            },
            {
              key: "days",
              label: "天数 day_spec",
              children: d.days ? (
                <Tooltip title={d.daySpecRaw ?? ""}>
                  <span>{d.days} 天</span>
                </Tooltip>
              ) : (
                <Tooltip title="没有 day_spec：体检的「题目齐」退化成按题数判">
                  <span style={{ color: "#909399" }}>没记规格</span>
                </Tooltip>
              ),
            },
            {
              key: "counts",
              label: "题 / 产物 / 物料",
              children: `${d.counts.questions} 题 · ${d.counts.assets} 件 · ${d.counts.materials} 份在用`,
            },
            {
              key: "netdisk",
              label: "网盘",
              children: d.netdiskLink ? (
                <span>
                  <Tag color="green">{d.netdiskCode ?? "有链接"}</Tag>
                  <a href={d.netdiskLink} target="_blank" rel="noreferrer">
                    打开
                  </a>
                </span>
              ) : (
                <Tooltip title="doc.网盘链接 是空的 —— 账上没记网盘（不代表一定没传过；唯一指引在 网盘分发记录/分享链接总表.md）">
                  <span style={{ color: "#909399" }}>没记</span>
                </Tooltip>
              ),
            },
            {
              key: "book",
              label: "线上 book_id",
              children: d.onlineBookId ? (
                <Tooltip title="录进线上打卡书的雪花号（punch 侧只有 5 本有）">
                  <span
                    style={{ fontFamily: "Consolas, monospace", fontSize: 12 }}
                  >
                    {d.onlineBookId}
                  </span>
                </Tooltip>
              ) : (
                <span style={{ color: "#909399" }}>没录线上</span>
              ),
            },
            {
              key: "src",
              label: "册目录",
              span: 3,
              children: d.srcDir ? (
                <span
                  style={{
                    fontFamily: "Consolas, Menlo, monospace",
                    fontSize: 11.5,
                    wordBreak: "break-all",
                  }}
                >
                  {d.srcDir}
                </span>
              ) : (
                <span style={{ color: "#909399" }}>没登记源目录</span>
              ),
            },
            {
              key: "kp",
              label: "考点",
              span: 3,
              children: d.kpRaw ? (
                <span style={{ fontSize: 12 }}>{d.kpRaw}</span>
              ) : (
                <span style={{ color: "#909399" }}>
                  没标考点（doc.考点 为空）
                </span>
              ),
            },
          ]}
        />
      </Card>

      {detail.members.length > 0 || detail.includedIn.length > 0 ? (
        <Card
          size="small"
          title="合刊关系（册级 · doc_member）"
          style={{ marginBottom: 12 }}
        >
          {detail.members.length > 0 ? (
            <div style={{ fontSize: 12.5, marginBottom: 6 }}>
              本册由这 {detail.members.length} 册合订：
              {detail.members.map((m) => (
                <Link
                  key={m.id}
                  href={`/shelf/doc/${m.id}`}
                  style={{ marginLeft: 8 }}
                >
                  {m.name}
                  {m.version ? `（${m.version}）` : ""}
                </Link>
              ))}
            </div>
          ) : null}
          {detail.includedIn.length > 0 ? (
            <div style={{ fontSize: 12.5 }}>
              本册被收录在：
              {detail.includedIn.map((m) => (
                <Link
                  key={m.id}
                  href={`/shelf/doc/${m.id}`}
                  style={{ marginLeft: 8 }}
                >
                  {m.name}
                </Link>
              ))}
            </div>
          ) : null}
          <div style={{ marginTop: 6, fontSize: 11.5, color: "#909399" }}>
            🔴 这是<b>册级</b>归属（谁和谁合订成一本，给人读/导航用）；
            <b>题级</b>引用是另一张表 collection_item —— 它建了但一行都没写过，
            所以合刊的排版取题目前不走库。
          </div>
        </Card>
      ) : null}

      <DocPanels detail={detail} />
    </>
  );
}
