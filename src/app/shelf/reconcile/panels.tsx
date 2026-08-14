"use client";

/**
 * 两库对账的三块面板（AI:PRD-009 · D-B `/shelf/reconcile`）
 *
 * 🔴🔴 同名异库：左边永远是**货架 punch 库**（`举一反三产物/资料库.db`），
 *      右边永远是**本库**（`data/资料库.db`）。列头一律写清是哪一边。
 * 🔴🔴 **只报不改**：本页没有一个能改库的控件；「重新跑一次」也只是重算一遍。
 *
 * 三条轴的强弱在页面上必须看得见（把弱键当结论是对账最容易犯的错）：
 *   轴 A 成品文件 = **强键**（绝对路径，两边都存了「这份文件在盘上的哪儿」）
 *   轴 B 册子配对 = 先用轴 A 的强键推，名字只作补充线索（标「待人工确认」）
 *   轴 C 网盘指针 = 挂在轴 B 的配对上，配对存疑的行结论也带问号
 */
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useState, useTransition } from "react";

import { EmptyHint, TimeText } from "~/components/console/ui";
import {
  NETDISK_COLOR,
  shelfFileUrl,
  type BookMatchView,
  type FileMatchView,
  type NetdiskRowView,
  type ReconcileReportView,
  type ReconcileResponse,
} from "../shared";

/** 路径列：只显示文件名，全路径在悬停里（绝对路径太长，摆出来就没法看表了） */
function PathCell({ p, onDisk }: { p: string; onDisk: boolean }) {
  const name = p.split(/[\\/]/).pop() ?? p;
  return (
    <Tooltip title={p} styles={{ root: { maxWidth: 640 } }}>
      <span
        style={{
          fontFamily: "Consolas, Menlo, monospace",
          fontSize: 11.5,
          color: onDisk ? undefined : "#c45656",
        }}
      >
        {onDisk ? "" : "⚠ "}
        {name}
      </span>
    </Tooltip>
  );
}

function fileColumns(
  kind: "matched" | "punch" | "kf",
): ColumnsType<FileMatchView> {
  const 文件: ColumnsType<FileMatchView>[number] = {
    title: "文件",
    dataIndex: "path",
    ellipsis: true,
    render: (_, r) => <PathCell p={r.path} onDisk={r.onDisk} />,
  };
  const 货架: ColumnsType<FileMatchView>[number] = {
    title: "货架侧（punch）",
    dataIndex: "punchDocName",
    width: 280,
    ellipsis: true,
    render: (_, r) =>
      r.punchDocId === null ? (
        <span style={{ color: "#909399" }}>—</span>
      ) : (
        <span style={{ fontSize: 12.5 }}>
          <Link href={`/shelf/doc/${r.punchDocId}`}>{r.punchDocName}</Link>
          {r.punchAssetType ? (
            <Tag style={{ marginLeft: 6 }}>{r.punchAssetType}</Tag>
          ) : null}
        </span>
      ),
  };
  const 工厂: ColumnsType<FileMatchView>[number] = {
    title: "本库侧（SKU）",
    dataIndex: "kfSkuName",
    width: 300,
    ellipsis: true,
    render: (_, r) =>
      r.kfSkuId === null ? (
        <span style={{ color: "#909399" }}>—</span>
      ) : (
        <span style={{ fontSize: 12.5 }}>
          <Link href={`/sku/${r.kfSkuId}`}>{r.kfSkuName}</Link>
          {r.kfOutputKind ? (
            <Tag style={{ marginLeft: 6 }}>{r.kfOutputKind}</Tag>
          ) : null}
        </span>
      ),
  };
  const 打开: ColumnsType<FileMatchView>[number] = {
    title: "打开",
    key: "op",
    width: 120,
    render: (_, r) => (
      <span style={{ fontSize: 12.5 }}>
        {/* 货架侧文件走绝对路径通路；本库侧文件是内容寻址，走 hash 通路 */}
        {r.punchDocId !== null ? (
          <a href={shelfFileUrl(r.path)} target="_blank" rel="noreferrer">
            货架件
          </a>
        ) : null}
        {r.punchDocId !== null && r.kfHash ? (
          <span style={{ color: "#dcdfe6" }}> · </span>
        ) : null}
        {r.kfHash ? (
          <a href={`/api/asset/${r.kfHash}`} target="_blank" rel="noreferrer">
            仓内件
          </a>
        ) : null}
        {r.punchDocId === null && !r.kfHash ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : null}
      </span>
    ),
  };
  if (kind === "matched") return [文件, 货架, 工厂, 打开];
  if (kind === "punch") return [文件, 货架, 打开];
  return [文件, 工厂, 打开];
}

function RootTable({ rows }: { rows: { root: string; n: number }[] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ fontSize: 12, color: "#606266", marginBottom: 8 }}>
      分布：
      {rows.map((r) => (
        <Tag key={r.root} style={{ marginInlineEnd: 6 }}>
          {r.root} {r.n}
        </Tag>
      ))}
    </div>
  );
}

export function ReconcilePanels({ initial }: { initial: ReconcileReportView }) {
  const [report, setReport] = useState<ReconcileReportView>(initial);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [pending, start] = useTransition();

  const rerun = () => {
    start(async () => {
      try {
        const res = await fetch("/api/shelf/reconcile");
        const j = (await res.json()) as ReconcileResponse;
        if (j.ok && j.report) {
          setReport(j.report);
          setErr(undefined);
        } else {
          setErr(j.error ?? "对账返回了 ok=false 但没给原因");
        }
      } catch (e) {
        setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    });
  };

  const f = report.fileAxis;
  const b = report.bookAxis;
  const n = report.netdiskAxis;
  const 强配对 = b.matched.filter((x) => x.how === "路径").length;

  const bookColumns: ColumnsType<BookMatchView> = [
    {
      title: "凭什么配上的",
      dataIndex: "how",
      width: 150,
      render: (_, r) =>
        r.how === "路径" ? (
          <Tooltip title={`两边共用 ${r.sharedFiles} 份成品文件 —— 机器可证`}>
            <Tag color="green">路径 · 共用 {r.sharedFiles} 件</Tag>
          </Tooltip>
        ) : r.how === "名称" ? (
          <Tooltip title="归一化册名相等（弱键，基本可信）">
            <Tag color="blue">名称相等</Tag>
          </Tooltip>
        ) : (
          <Tooltip title="🔴 一方的名字包含另一方 —— 只是线索，是不是同一本要人拍板">
            <Tag color="orange">名称疑似</Tag>
          </Tooltip>
        ),
    },
    {
      title: "货架侧册子（punch doc）",
      dataIndex: "punchDocName",
      ellipsis: true,
      render: (_, r) => (
        <span style={{ fontSize: 12.5 }}>
          <Link href={`/shelf/doc/${r.punchDocId}`}>{r.punchDocName}</Link>
          <Tag style={{ marginLeft: 6 }}>{r.punchType}</Tag>
          {r.punchVersion ? (
            <span style={{ color: "#909399" }}> {r.punchVersion}</span>
          ) : null}
        </span>
      ),
    },
    {
      title: "本库侧 SKU",
      dataIndex: "kfSkuName",
      ellipsis: true,
      render: (_, r) => (
        <span style={{ fontSize: 12.5 }}>
          <Link href={`/sku/${r.kfSkuId}`}>{r.kfSkuName}</Link>
          {r.kfType ? <Tag style={{ marginLeft: 6 }}>{r.kfType}</Tag> : null}
          {r.kfStatus ? (
            <span style={{ color: "#909399" }}> {r.kfStatus}</span>
          ) : null}
        </span>
      ),
    },
  ];

  const netdiskColumns: ColumnsType<NetdiskRowView> = [
    {
      title: "判词",
      dataIndex: "verdict",
      width: 132,
      filters: [...new Set(n.rows.map((r) => r.verdict))].map((v) => ({
        text: v,
        value: v,
      })),
      onFilter: (v, r) => r.verdict === v,
      render: (_, r) => (
        <Tooltip title={r.note}>
          <Tag color={NETDISK_COLOR[r.verdict]}>{r.verdict}</Tag>
        </Tooltip>
      ),
    },
    {
      title: "货架侧册子",
      dataIndex: "punchDocName",
      ellipsis: true,
      render: (_, r) => (
        <Link href={`/shelf/doc/${r.punchDocId}`}>{r.punchDocName}</Link>
      ),
    },
    {
      title: "货架链接",
      dataIndex: "punchLink",
      width: 160,
      render: (_, r) =>
        r.punchLink ? (
          <Tooltip title={r.punchLink}>
            <span>
              <Tag color="green">{r.punchCode ?? "有链接"}</Tag>
              <a href={r.punchLink} target="_blank" rel="noreferrer">
                打开
              </a>
            </span>
          </Tooltip>
        ) : (
          <span style={{ color: "#909399" }}>没记</span>
        ),
    },
    {
      title: "本库侧 SKU",
      dataIndex: "kfSkuName",
      ellipsis: true,
      render: (_, r) =>
        r.kfSkuId ? (
          <span style={{ fontSize: 12.5 }}>
            <Link href={`/sku/${r.kfSkuId}`}>{r.kfSkuName}</Link>
            {r.pairedBy === "名称疑似" ? (
              <Tag color="orange" style={{ marginLeft: 6 }}>
                配对存疑
              </Tag>
            ) : null}
          </span>
        ) : (
          <Tooltip title="本库里按册名与共用文件都找不到对应 SKU —— 这本册子本库根本没登记过（不是数据丢了，是两边各记各的账）">
            <span style={{ color: "#909399" }}>没有</span>
          </Tooltip>
        ),
    },
    {
      title: "本库配方链接",
      dataIndex: "kfLink",
      width: 150,
      render: (_, r) =>
        r.kfLink ? (
          <Tooltip title={r.kfLink}>
            <span>
              <Tag color="green">{r.kfCode ?? "有链接"}</Tag>
              <a href={r.kfLink} target="_blank" rel="noreferrer">
                打开
              </a>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title="recipe_json 里没有 netdisk 段 —— 它的意思是「配方里没记网盘」，不是「没传过网盘」（真凭据在 网盘分发记录/分享链接总表.md）">
            <span style={{ color: "#909399" }}>配方没记</span>
          </Tooltip>
        ),
    },
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            这一页<b>只报差异、不改任何一边</b>：货架 punch
            库物理只读（mode=ro）， 本库这一页也零写（不
            logMetric、不留审计行）。对不上要怎么办 ——
            改哪边、认成同一本、还是各归各 —— 是人的判断。
          </span>
        }
        description={
          <span style={{ fontSize: 12, color: "#606266" }}>
            跑于 <TimeText iso={report.takenAt} /> · {report.ms}ms · 货架库{" "}
            {report.punchDbPath} · 本库 {report.kfDbPath}
          </span>
        }
        action={
          <Button size="small" onClick={rerun} loading={pending}>
            重新跑一次
          </Button>
        }
      />

      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="重跑失败（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{err}</span>}
        />
      ) : null}

      {report.warnings.map((w, i) => (
        <Alert
          key={i}
          type="warning"
          style={{ marginBottom: 8 }}
          message={<span style={{ fontSize: 12.5 }}>{w}</span>}
        />
      ))}

      {/* ══ 轴 A ══════════════════════════════════════════════════════════ */}
      <Card
        size="small"
        title="轴 A · 成品文件（强键 = 绝对路径）"
        style={{ marginTop: 12, marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            punch `asset.路径` ↔ 本库 `sku_output.gate_results_json.src`
          </span>
        }
      >
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>货架登记的产物</span>}
              value={f.punchAssets}
              valueStyle={{ fontSize: 20 }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>本库登记的产出</span>}
              value={f.kfOutputs}
              valueStyle={{ fontSize: 20 }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>两边对上</span>}
              value={f.matched.length}
              valueStyle={{ fontSize: 20, color: "#67c23a" }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>只货架有</span>}
              value={f.punchOnly.length}
              valueStyle={{ fontSize: 20 }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>只本库有</span>}
              value={f.kfOnly.length}
              valueStyle={{ fontSize: 20 }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>账上有·盘上没有</span>}
              value={f.missingOnDisk.length}
              valueStyle={{
                fontSize: 20,
                color: f.missingOnDisk.length > 0 ? "#c45656" : undefined,
              }}
            />
          </Col>
        </Row>

        <Alert
          type="info"
          style={{ marginBottom: 10 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              「只货架有 / 只本库有」<b>不是坏事</b>：两条产线本来就各产各的 ——
              货架管六类资料成品（举一反三产物/），本库管群卷与题库产出（订阅特训/）。
              这一栏回答的是「同一份文件两边都记了吗」，不是「谁少了东西」。
              {f.kfOutputsWithoutSrc > 0
                ? ` 另有 ${f.kfOutputsWithoutSrc} 件本库产出没记 src，没有可比的键，不计入任何一栏。`
                : ""}
            </span>
          }
        />

        <Tabs
          size="small"
          items={[
            {
              key: "m",
              label: `两边对上（${f.matched.length}）`,
              children: (
                <Table<FileMatchView>
                  rowKey="key"
                  size="small"
                  columns={fileColumns("matched")}
                  dataSource={f.matched}
                  scroll={{ x: 900 }}
                  pagination={{ defaultPageSize: 10, showSizeChanger: true }}
                  locale={{
                    emptyText: (
                      <EmptyHint>
                        两边<b>一份文件都没对上</b>
                        ：说明两条产线的成品目前完全不重叠 （不是数据丢了）。
                      </EmptyHint>
                    ),
                  }}
                />
              ),
            },
            {
              key: "p",
              label: `只货架有（${f.punchOnly.length}）`,
              children: (
                <>
                  <RootTable rows={f.punchOnlyByRoot} />
                  <Table<FileMatchView>
                    rowKey="key"
                    size="small"
                    columns={fileColumns("punch")}
                    dataSource={f.punchOnly}
                    scroll={{ x: 800 }}
                    pagination={{ defaultPageSize: 10, showSizeChanger: true }}
                  />
                </>
              ),
            },
            {
              key: "k",
              label: `只本库有（${f.kfOnly.length}）`,
              children: (
                <>
                  <RootTable rows={f.kfOnlyByRoot} />
                  <Table<FileMatchView>
                    rowKey="key"
                    size="small"
                    columns={fileColumns("kf")}
                    dataSource={f.kfOnly}
                    scroll={{ x: 800 }}
                    pagination={{ defaultPageSize: 10, showSizeChanger: true }}
                  />
                </>
              ),
            },
            {
              key: "x",
              label: `账上有·盘上没有（${f.missingOnDisk.length}）`,
              children: (
                <Table<FileMatchView>
                  rowKey="key"
                  size="small"
                  columns={fileColumns("matched")}
                  dataSource={f.missingOnDisk}
                  scroll={{ x: 900 }}
                  pagination={{ defaultPageSize: 10, showSizeChanger: true }}
                  locale={{
                    emptyText: (
                      <EmptyHint>
                        没有「登记行在、文件不在盘上」的行 ——
                        两边账上指的文件此刻都还在。
                      </EmptyHint>
                    ),
                  }}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* ══ 轴 B ══════════════════════════════════════════════════════════ */}
      <Card
        size="small"
        title="轴 B · 册子配对（先用强键推，名字只作线索）"
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            货架 {b.punchDocs} 份资料 · 本库 {b.kfSkus} 本 SKU · 配上{" "}
            {b.matched.length} 对 （其中强配对 {强配对} 对）
          </span>
        }
      >
        <Table<BookMatchView>
          rowKey="key"
          size="small"
          columns={bookColumns}
          dataSource={b.matched}
          pagination={false}
          scroll={{ x: 780 }}
          locale={{
            emptyText: (
              <EmptyHint>
                两库在册子层<b>一对都没配上</b>
                ：既没有共用成品文件，名字也对不上 ——
                这说明两边现在是各记各的账。
              </EmptyHint>
            ),
          }}
        />
        <Row gutter={12} style={{ marginTop: 12 }}>
          <Col xs={24} md={12}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
              只在货架有的资料（{b.punchOnly.length}）
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 2,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {b.punchOnly.length === 0 ? (
                <span style={{ color: "#909399" }}>没有</span>
              ) : (
                b.punchOnly.map((d) => (
                  <span key={d.id} style={{ marginRight: 10 }}>
                    <Link href={`/shelf/doc/${d.id}`}>{d.name}</Link>
                    <span style={{ color: "#909399" }}>（{d.type}）</span>
                  </span>
                ))
              )}
            </div>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
              只在本库有的 SKU（{b.kfOnly.length}）
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 2,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {b.kfOnly.length === 0 ? (
                <span style={{ color: "#909399" }}>没有</span>
              ) : (
                b.kfOnly.map((s) => (
                  <span key={s.id} style={{ marginRight: 10 }}>
                    <Link href={`/sku/${s.id}`}>{s.name}</Link>
                    <span style={{ color: "#909399" }}>
                      （{s.type ?? "未填类型"}）
                    </span>
                  </span>
                ))
              )}
            </div>
          </Col>
        </Row>
      </Card>

      {/* ══ 轴 C ══════════════════════════════════════════════════════════ */}
      <Card
        size="small"
        title="轴 C · 网盘指针"
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            货架 `doc.网盘链接/提取码` ↔ 本库 `sku.recipe_json.netdisk`
          </span>
        }
      >
        <div style={{ marginBottom: 10 }}>
          {(Object.keys(n.counts) as (keyof typeof n.counts)[])
            .filter((k) => n.counts[k] > 0)
            .map((k) => (
              <Tag
                key={k}
                color={NETDISK_COLOR[k]}
                style={{ marginInlineEnd: 6 }}
              >
                {k} {n.counts[k]}
              </Tag>
            ))}
        </div>
        <Table<NetdiskRowView>
          rowKey={(r) => `${r.punchDocId}::${r.kfSkuId ?? "none"}`}
          size="small"
          columns={netdiskColumns}
          dataSource={n.rows}
          scroll={{ x: 900 }}
          pagination={{ defaultPageSize: 10, showSizeChanger: true }}
          locale={{
            emptyText: (
              <EmptyHint>
                没有可比的网盘指针：货架侧没有一本册子挂了链接（doc.网盘链接
                全空）。
              </EmptyHint>
            ),
          }}
        />
        <div style={{ marginTop: 8, fontSize: 11.5, color: "#909399" }}>
          🔴 「配方没记」≠「没传过网盘」：本库 recipe_json 里没有 netdisk
          段只说明出册时没往配方里写；网盘的<b>唯一指引</b>是{" "}
          <code>网盘分发记录/分享链接总表.md</code>。
        </div>
      </Card>

      {/* ══ punch 侧空表 ═════════════════════════════════════════════════ */}
      <Card size="small" title="货架侧「声明了却没用」的表">
        <div style={{ fontSize: 12.5, lineHeight: 2 }}>
          {report.punchEmptyTables.map((t) => (
            <div key={t.table}>
              <Typography.Text code>{t.table}</Typography.Text>{" "}
              <Tag color={t.rows === 0 ? "default" : "green"}>{t.rows} 行</Tag>
              <span style={{ color: "#606266" }}>{t.说明}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 11.5, color: "#909399" }}>
          清点它们是为了<b>别把空壳当成有数据</b>
          ：收编时这几张要么接管、要么明确宣告作废，
          这是要人拍板的事，本页只如实数一遍。
        </div>
      </Card>
    </>
  );
}

export default ReconcilePanels;
