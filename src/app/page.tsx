/**
 * 首页 · 工作台（AI:PRD-008 · 地基；原件 = AI:PRD-001 WP6 的「系统底座」页）
 *
 * 设计稿 §二·1：开台第一眼——库有多大、有没有红灯、今天该去哪。
 *   统计卡一排（点卡跳对应列表）+ 红旗条（在 layout 里，全站通栏）+ 待办卡。
 * **不管**任何明细：本页所有内容都是"跳过去"的入口。
 *
 * 🔴 全 server component + 现算：本地 SQLite 毫秒级，不上 client 状态、不做缓存
 *    （缓存过的「健康」是最没用的健康）。force-dynamic 的理由见 layout.tsx 文件头。
 * 🔴 本页没有任何按钮能改库：写操作一律走 core（MCP / 脚本）。
 * 🔴 目标页还没建的卡**不给链接**（StatCard 的 todo）：点进去 404 比不能点更糟。
 */
import { Alert, Card, Col, Row, Tag } from "antd";
import Link from "next/link";

import { DataSourceNote, StatCard, TimeText } from "~/components/console/ui";
import {
  QUESTION_STATUSES,
  SOLUTION_GRADES,
  countOpenQueueByKind,
  getLatestIntegritySummary,
  health,
  kgOverview,
  listBackups,
  listIngestBatches,
  listModels,
  listQuarantine,
  listRoster,
  listSkus,
  searchQuestions,
} from "~/core";

export const dynamic = "force-dynamic";

/** 读不动就把错误如实端出来（本地工具页，藏错误没有任何好处） */
async function safe<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    return String(e);
  }
}

function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TH: React.CSSProperties = {
  background: "#f5f7fa",
  color: "#606266",
  fontWeight: 500,
  fontSize: 12.5,
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid #ebeef5",
};
const TD: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #ebeef5",
  fontSize: 13,
  verticalAlign: "top",
};

export default async function WorkbenchPage() {
  const [q, kg, skus, models, roster, h, byKind, qr, integ, backups, batches] =
    await Promise.all([
      // 🔴 题目总数走检索层的候选计数（core 没有单独的 count 口子，而检索是唯一入口）：
      //    状态/判档都放全，拿到的就是全库题数；metric:false = 这一下不落打点。
      safe(() =>
        searchQuestions(
          {
            statuses: [...QUESTION_STATUSES],
            solutionGrade: [...SOLUTION_GRADES],
            limit: 1,
          },
          { metric: false },
        ),
      ),
      safe(() => kgOverview()),
      safe(() => listSkus({ limit: 500 })),
      safe(() => listModels({ limit: 500 })),
      safe(() => listRoster()),
      safe(() => health()),
      safe(() => countOpenQueueByKind()),
      safe(() => listQuarantine({ state: "open", limit: 500 })),
      safe(() => getLatestIntegritySummary()),
      safe(() => listBackups({ limit: 3 })),
      // 设计稿 §二·1 的快捷入口第三件：最近 5 个录入批次（core 早就有这个只读函数）
      safe(() => listIngestBatches({ limit: 5 })),
    ]);

  const 题数 = typeof q === "string" ? "读不出" : q.candidateCount;
  const 考点数 = typeof kg === "string" ? "读不出" : kg.kpTotal;
  const 别名数 = typeof kg === "string" ? null : kg.aliasTotal;
  const skuList = typeof skus === "string" ? [] : skus;
  const draftSku = skuList.filter((s) => s.status === "draft");
  const 队列 = typeof byKind === "string" ? [] : byKind;
  const 队列未处置 = 队列.reduce((a, b) => a + b.count, 0);
  const 隔离未结 = typeof qr === "string" ? 0 : qr.length;
  const 体检 = typeof h === "string" ? null : h;
  const 对账 = typeof integ === "string" ? null : integ;
  const 快照 = typeof backups === "string" ? [] : backups;
  const 最近批次 = typeof batches === "string" ? [] : batches;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>工作台</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          库有多大 · 有没有红灯 · 今天该去哪
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            searchQuestions / kgOverview / listSkus / listModels / listRoster /
            health（全部现算）
          </DataSourceNote>
        </span>
      </div>

      {/* ── 统计卡一排 ─────────────────────────────────────────────────── */}
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="题目"
            value={题数}
            sub="全状态全判档"
            href="/question"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="考点"
            value={考点数}
            sub={别名数 === null ? "" : `+${别名数} 别名`}
            href="/kg"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="SKU 册/卷"
            value={typeof skus === "string" ? "读不出" : skuList.length}
            sub={`draft ${draftSku.length}`}
            href="/sku"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="考察模型"
            value={typeof models === "string" ? "读不出" : models.length}
            href="/model"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="学员"
            value={typeof roster === "string" ? "读不出" : roster.length}
            sub="全代号"
            href="/student"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="审计链 seq"
            value={体检?.auditHeadSeq ?? "空链"}
            href="/audit"
          />
        </Col>
      </Row>

      {/* ── 待办 ───────────────────────────────────────────────────────── */}
      <Card
        size="small"
        title="待办"
        style={{ marginTop: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            这三行是「今天该去哪」的全部——它们清零 = 没有人等你拍板
          </span>
        }
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={TH}>类型</th>
              <th style={TH}>内容</th>
              <th style={{ ...TH, width: 90 }}>数量</th>
              <th style={{ ...TH, width: 140 }}>入口</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={TD}>审查队列</td>
              <td style={TD}>
                未处置工单
                {队列.length > 0
                  ? `（${队列
                      .filter((k) => k.count > 0)
                      .map((k) => `${k.kind}${k.count}`)
                      .join(" · ")}）`
                  : "（各类均为 0）"}
              </td>
              <td style={TD}>
                <Tag color={队列未处置 > 0 ? "orange" : "green"}>
                  {队列未处置}
                </Tag>
              </td>
              <td style={TD}>
                <Link href="/queue">去处置台 →</Link>
              </td>
            </tr>
            <tr>
              <td style={TD}>审查队列</td>
              <td style={TD}>隔离区未清（管道拒了的题，原样 payload 留着）</td>
              <td style={TD}>
                <Tag color={隔离未结 > 0 ? "red" : "green"}>{隔离未结}</Tag>
              </td>
              <td style={TD}>
                <Link href="/queue?tab=quarantine">去隔离区 →</Link>
              </td>
            </tr>
            <tr>
              <td style={TD}>生产</td>
              <td style={TD}>
                draft 状态 SKU
                {draftSku.length > 0
                  ? `（${draftSku
                      .slice(0, 3)
                      .map((s) => s.name)
                      .join("、")}${draftSku.length > 3 ? " …" : ""}）`
                  : ""}
              </td>
              <td style={TD}>
                <Tag color={draftSku.length > 0 ? "blue" : "green"}>
                  {draftSku.length}
                </Tag>
              </td>
              <td style={TD}>
                {/* 🔴 不带 ?status=draft：/sku 的筛选在 ProTable 里、不读 URL 参数，
                    给一个不生效的参数等于骗人。到了那页手选一下状态即可。 */}
                <Link href="/sku">去 SKU 台账 →</Link>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* ── 最近 5 个录入批次（设计稿 §二·1 快捷入口第三件）──────────────── */}
      <Card
        size="small"
        title="最近 5 个录入批次"
        style={{ marginTop: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            投料的台账 —— 明细/闸报告在 <Link href="/ingest">录入批次 →</Link>
          </span>
        }
      >
        {typeof batches === "string" ? (
          <Alert
            type="error"
            showIcon
            message={`录入批次读不出来：${batches}`}
          />
        ) : 最近批次.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "#606266" }}>
            一次投料都没有（ingest_batch 空表）。🔴
            「没有批次」不等于「库里没题」—— 手工/脚本直写进来的题不留批次账；
            走 <code>pnpm kb:submit</code> 的每一次投料才在这张表上。
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>批次 / 来源</th>
                <th style={{ ...TH, width: 210 }}>进多少 / 拒多少</th>
                <th style={{ ...TH, width: 96 }}>状态</th>
                <th style={{ ...TH, width: 120 }}>时间</th>
                <th style={{ ...TH, width: 110 }}>入口</th>
              </tr>
            </thead>
            <tbody>
              {最近批次.map((b) => (
                <tr key={b.id}>
                  <td style={TD}>
                    <span style={{ fontSize: 12.5 }}>{b.source}</span>
                    <div
                      style={{
                        color: "#909399",
                        fontFamily: "Consolas, Menlo, monospace",
                        fontSize: 11.5,
                      }}
                    >
                      {b.id}
                    </div>
                  </td>
                  <td style={{ ...TD, fontSize: 12.5 }}>
                    <Tag color="green">进 {b.counts.accepted}</Tag>
                    {b.counts.queued > 0 ? (
                      <Tag color="orange">待审 {b.counts.queued}</Tag>
                    ) : null}
                    {b.counts.rejected > 0 ? (
                      <Tag color="red">拒 {b.counts.rejected}</Tag>
                    ) : null}
                    <span style={{ color: "#909399" }}>
                      / 共 {b.counts.total}
                    </span>
                    {b.quarantineOpen > 0 ? (
                      <div style={{ color: "#c45656" }}>
                        隔离区还有 {b.quarantineOpen} 条没结
                      </div>
                    ) : null}
                  </td>
                  <td style={TD}>
                    <Tag
                      color={
                        b.status === "committed"
                          ? "green"
                          : b.status === "failed"
                            ? "red"
                            : "orange"
                      }
                    >
                      {b.status ?? "状态未记"}
                    </Tag>
                  </td>
                  <td style={{ ...TD, fontSize: 12.5 }}>
                    <TimeText iso={b.committedAt ?? b.createdAt} />
                  </td>
                  <td style={TD}>
                    <Link href={`/ingest?batch=${encodeURIComponent(b.id)}`}>
                      看这一批 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── 系统底座（一眼摘要；明细全在 /health）───────────────────────── */}
      <Card
        size="small"
        title="系统底座"
        style={{ marginTop: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            这里只是摘要 · 快照列表 / 对账六项明细 / 现跑一次对账都在{" "}
            <Link href="/health">备份与对账 →</Link>
          </span>
        }
      >
        {typeof h === "string" ? (
          <Alert type="error" showIcon message={`库体检读不出来：${h}`} />
        ) : null}
        <Row gutter={[12, 12]}>
          <Col xs={24} lg={8}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>库体检</b>
              <br />
              {体检 ? (
                <>
                  <Tag color={体检.ok ? "green" : "red"}>
                    {体检.ok ? "库活着 · 闸静息" : "不健康"}
                  </Tag>
                  <br />
                  表数 {体检.tableCount} 张 · 审计链尾 seq{" "}
                  {体检.auditHeadSeq ?? "—（空链）"}
                  <br />
                  写闸 allowed={体检.writeGate}（正常恒为 0）·{" "}
                  {体检.journalMode} · 外键 {体检.foreignKeys ? "ON" : "OFF"}
                </>
              ) : (
                "—"
              )}
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>对账（最近一次的摘要，不是现跑）</b>
              <br />
              {对账 ? (
                <>
                  <Tag color={对账.ok ? "green" : "red"}>
                    {对账.ok ? "全绿 · 无红旗" : `红旗 ${对账.red.length} 项`}
                  </Tag>
                  {对账.warn.length > 0 ? (
                    <Tag color="orange">warn {对账.warn.length}</Tag>
                  ) : null}
                  <br />
                  <TimeText iso={对账.ts} />
                </>
              ) : (
                <>
                  还没跑过对账（或读不出摘要）。跑一次：
                  <br />
                  <code style={{ fontSize: 11.5 }}>
                    pnpm exec tsx --env-file=.env scripts/integrity-check.ts
                  </code>
                </>
              )}
            </div>
          </Col>
          <Col xs={24} lg={8}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>备份</b>
              <br />
              {快照.length === 0 ? (
                <>
                  <Tag color="red">一份快照都没有</Tag>
                  <br />
                  <code style={{ fontSize: 11.5 }}>
                    pnpm exec tsx --env-file=.env scripts/backup.ts
                  </code>
                </>
              ) : (
                <>
                  <Tag color="green">最近快照</Tag>
                  <TimeText iso={快照[0]!.mtime} />
                  <br />
                  {bytesText(快照[0]!.bytes)} · reason={快照[0]!.reason}
                  <br />
                  <span style={{ color: "#909399" }}>
                    另有 {Math.max(0, 快照.length - 1)} 份更早的
                  </span>
                </>
              )}
            </div>
          </Col>
        </Row>
      </Card>

      <div style={{ marginTop: 14, fontSize: 12, color: "#909399" }}>
        本页只读、现算，没有缓存。要动库请走 MCP 工具或 scripts/ —— 页面壳与
        agent 共用同一个 core，绕过去就没有审计行。
      </div>
    </>
  );
}
