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
 *
 * ── AI:PRD-009 打磨（2026-08-14）────────────────────────────────────────────
 * 🔴🔴 检查单 ②：本页原先有 11 处只读，只有 2 处会报错，其余**读失败就退化成
 *    0 / 空 / 绿**：listQuarantine 抛异常 → 隔离区显示绿色 0；countOpenQueueByKind
 *    抛异常 → 待办显示绿色 0；listBackups 抛异常 → 「一份快照都没有」；
 *    getLatestIntegritySummary 抛异常 → 「还没跑过对账」。
 *    也就是说：**库连不上的那一刻，这一页最像"今天没活儿、一切正常"**。
 *    改法 = 每一处读的失败都记进 `读错`，顶部一条 Alert 原文照登，
 *    受影响的格子一律出「读不出」标（Unreadable），绝不出 0、绝不出绿。
 */
import { Alert, Card, Col, Row, Tag } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import { MONO, NUM, ScrollX, TABLE, TD, TH } from "~/components/console/table";
import {
  EmptyHint,
  LongText,
  StatCard,
  StatusTag,
  TimeText,
  Unreadable,
} from "~/components/console/ui";
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

  // 🔴 一处读失败 = 记一条账 + 这一格出「读不出」。
  //    ok() 的返回值 null **只表示读不出来**，不表示"没有" —— 两者在下面严格分开画。
  const 读错: { 项: string; 原文: string }[] = [];
  function ok<T>(r: T | string, 项: string): T | null {
    if (typeof r === "string") {
      读错.push({ 项, 原文: r });
      return null;
    }
    return r;
  }

  const 题 = ok(q, "searchQuestions（题目总数）");
  const 图谱 = ok(kg, "kgOverview（考点/别名）");
  const skuList = ok(skus, "listSkus（SKU 台账）");
  const 模型 = ok(models, "listModels（考察模型）");
  const 名册 = ok(roster, "listRoster（学员名册）");
  const 体检 = ok(h, "health（库体检）");
  const 队列 = ok(byKind, "countOpenQueueByKind（未处置工单）");
  const 隔离 = ok(qr, "listQuarantine（隔离区未结）");
  // 🔴 对账/快照/批次三处：`null` 与 `[]` 是**结论**（没跑过 / 没有快照），
  //    读失败走的是 读错 那条路，不许混成同一个 null。
  const 对账 = ok(integ, "getLatestIntegritySummary（最近一次对账摘要）");
  const 快照 = ok(backups, "listBackups（data/backup/ 快照）");
  const 最近批次 = ok(batches, "listIngestBatches（最近录入批次）");

  const draftSku = (skuList ?? []).filter((s) => s.status === "draft");
  const 队列未处置 =
    队列 === null ? null : 队列.reduce((a, b) => a + b.count, 0);
  const 隔离未结 = 隔离 === null ? null : 隔离.length;

  return (
    <>
      <PageHead
        title="工作台"
        sub="库有多大 · 有没有红灯 · 今天该去哪"
        source="searchQuestions / kgOverview / listSkus / listModels / listRoster / health（全部现算）"
      />

      {/* 🔴 检查单 ②：读失败上墙，原文一个字不改。
          放在统计卡**之前** —— 卡上的「读不出」要有个地方说明白是为什么。 */}
      {读错.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`这一页有 ${读错.length} 处没读出来（原文照登）`}
          description={
            <div style={{ fontSize: 12.5 }}>
              {读错.map((e) => (
                <div key={e.项} style={{ marginBottom: 2 }}>
                  <b>{e.项}</b>
                  <span
                    style={{
                      ...MONO,
                      color: "#606266",
                      marginLeft: 6,
                      wordBreak: "break-all",
                    }}
                  >
                    {e.原文}
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 6, color: "#606266" }}>
                🔴 下面凡是标「读不出」的格子都受这几条影响：那不是
                0，也不是「没有」。
              </div>
            </div>
          }
        />
      ) : null}

      {/* ── 统计卡一排 ─────────────────────────────────────────────────── */}
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="题目"
            value={题 === null ? "读不出" : 题.candidateCount}
            sub="全状态全判档"
            href="/question"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="考点"
            value={图谱 === null ? "读不出" : 图谱.kpTotal}
            sub={图谱 === null ? "" : `+${图谱.aliasTotal} 别名`}
            href="/kg"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="SKU 册/卷"
            value={skuList === null ? "读不出" : skuList.length}
            sub={skuList === null ? "" : `draft ${draftSku.length}`}
            href="/sku"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="考察模型"
            value={模型 === null ? "读不出" : 模型.length}
            href="/model"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <StatCard
            label="学员"
            value={名册 === null ? "读不出" : 名册.length}
            sub="全代号"
            href="/student"
          />
        </Col>
        <Col xs={12} sm={8} lg={4}>
          {/* 🔴 体检读不出时这里原先显示「空链」—— 那是一个**结论**（链上一行都没有），
              而实际情况是根本没读到。两者差着一次事故。 */}
          <StatCard
            label="审计链 seq"
            value={体检 === null ? "读不出" : (体检.auditHeadSeq ?? "空链")}
            sub={体检 === null ? "" : "现算"}
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
        <ScrollX min={560}>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 88 }}>类型</th>
                <th style={TH}>内容</th>
                <th style={{ ...TH, width: 90 }}>数量</th>
                <th style={{ ...TH, width: 140 }}>入口</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={TD}>审查队列</td>
                <td style={TD}>
                  {队列 === null
                    ? "未处置工单（读不出来 —— 见上面的错误条）"
                    : `未处置工单${
                        队列.length > 0
                          ? `（${队列
                              .filter((k) => k.count > 0)
                              .map((k) => `${k.kind}${k.count}`)
                              .join(" · ")}）`
                          : "（各类均为 0）"
                      }`}
                </td>
                <td style={TD}>
                  {队列未处置 === null ? (
                    <Unreadable why="countOpenQueueByKind 抛了异常" />
                  ) : (
                    <Tag color={队列未处置 > 0 ? "orange" : "green"}>
                      <span style={NUM}>{队列未处置}</span>
                    </Tag>
                  )}
                </td>
                <td style={TD}>
                  <Link href="/queue">去处置台 →</Link>
                </td>
              </tr>
              <tr>
                <td style={TD}>审查队列</td>
                <td style={TD}>
                  隔离区未清（管道拒了的题，原样 payload 留着）
                </td>
                <td style={TD}>
                  {隔离未结 === null ? (
                    <Unreadable why="listQuarantine 抛了异常" />
                  ) : (
                    <Tag color={隔离未结 > 0 ? "red" : "green"}>
                      <span style={NUM}>{隔离未结}</span>
                    </Tag>
                  )}
                </td>
                <td style={TD}>
                  <Link href="/queue?tab=quarantine">去隔离区 →</Link>
                </td>
              </tr>
              <tr>
                <td style={TD}>生产</td>
                <td style={TD}>
                  {skuList === null ? (
                    "draft 状态 SKU（读不出来 —— 见上面的错误条）"
                  ) : (
                    <>
                      draft 状态 SKU
                      {draftSku.length > 0 ? (
                        <>
                          （
                          {/* 🔴 检查单 ④「看到即可达」：名字原先是纯文本，
                              人看见了却点不进去。SKU 详情页在 /sku/[id]。 */}
                          {draftSku.slice(0, 3).map((s, i) => (
                            <span key={s.id}>
                              {i > 0 ? "、" : ""}
                              <Link href={`/sku/${s.id}`}>
                                <LongText text={s.name} maxWidth={160} />
                              </Link>
                            </span>
                          ))}
                          {draftSku.length > 3 ? " …" : ""}）
                        </>
                      ) : null}
                    </>
                  )}
                </td>
                <td style={TD}>
                  {skuList === null ? (
                    <Unreadable why="listSkus 抛了异常" />
                  ) : (
                    <Tag color={draftSku.length > 0 ? "blue" : "green"}>
                      <span style={NUM}>{draftSku.length}</span>
                    </Tag>
                  )}
                </td>
                <td style={TD}>
                  {/* 🔴 不带 ?status=draft：/sku 的筛选在 ProTable 里、不读 URL 参数，
                    给一个不生效的参数等于骗人。到了那页手选一下状态即可。 */}
                  <Link href="/sku">去 SKU 台账 →</Link>
                </td>
              </tr>
            </tbody>
          </table>
        </ScrollX>
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
        {最近批次 === null ? (
          <Alert
            type="error"
            showIcon
            message="录入批次读不出来（原文见页面顶部的错误条）"
          />
        ) : 最近批次.length === 0 ? (
          <EmptyHint>
            一次投料都没有（ingest_batch 空表）。
            <br />
            🔴 「没有批次」不等于「库里没题」——
            手工/脚本直写进来的题不留批次账； 走 <code>
              pnpm kb:submit
            </code>{" "}
            的每一次投料才在这张表上。
          </EmptyHint>
        ) : (
          <ScrollX min={760}>
            <table style={TABLE}>
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
                      {/* 检查单 ③：来源可能很长（群卷路径），一行截断 + 悬停全文 */}
                      <LongText text={b.source} maxWidth={260} />
                      <div>
                        <Link
                          href={`/ingest?batch=${encodeURIComponent(b.id)}`}
                        >
                          <span style={{ ...MONO, color: "#909399" }}>
                            {b.id}
                          </span>
                        </Link>
                      </div>
                    </td>
                    <td style={TD}>
                      <Tag color="green">
                        进 <span style={NUM}>{b.counts.accepted}</span>
                      </Tag>
                      {b.counts.queued > 0 ? (
                        <Tag color="orange">
                          待审 <span style={NUM}>{b.counts.queued}</span>
                        </Tag>
                      ) : null}
                      {b.counts.rejected > 0 ? (
                        <Tag color="red">
                          拒 <span style={NUM}>{b.counts.rejected}</span>
                        </Tag>
                      ) : null}
                      <span style={{ color: "#909399", ...NUM }}>
                        / 共 {b.counts.total}
                      </span>
                      {b.quarantineOpen > 0 ? (
                        <div style={{ color: "#c45656" }}>
                          <Link href="/queue?tab=quarantine">
                            隔离区还有 {b.quarantineOpen} 条没结 →
                          </Link>
                        </div>
                      ) : null}
                    </td>
                    <td style={TD}>
                      {/* 🔴 检查单 ⑩：状态色不在页面里现调 —— 走 console/ui 的
                          STATUS_COLOR 那张表（committed=绿 / failed=红 / open=橙）。
                          原先这里手写了一串三元，等于给全站色表开了个后门。 */}
                      {b.status ? (
                        <StatusTag value={b.status} />
                      ) : (
                        <Tag>状态未记</Tag>
                      )}
                    </td>
                    <td style={TD}>
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
          </ScrollX>
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
                <>
                  <Unreadable why="health() 抛了异常" />
                  <br />
                  <span style={{ color: "#606266" }}>
                    连库体检都读不出来时，本页其它数字一并存疑。
                  </span>
                </>
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
              ) : typeof integ === "string" ? (
                // 🔴 读失败：绝不写成「还没跑过对账」——「没跑过」是结论，「读不出」不是
                <>
                  <Unreadable why="getLatestIntegritySummary 抛了异常" />
                </>
              ) : (
                <>
                  还没跑过对账（metric_event 里没有 integrity_check 的行）。
                  <br />
                  🔴 「没有对账记录」不等于「库没问题」。跑一次：
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
              {快照 === null ? (
                // 🔴 同上：读不出 ≠「一份快照都没有」。后者会让人以为"该跑备份了"，
                //    前者的正解是"先去看库/磁盘出了什么事"。
                <Unreadable why="listBackups 抛了异常" />
              ) : 快照.length === 0 ? (
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
                    另有 {Math.max(0, 快照.length - 1)} 份更早的 ——{" "}
                    <Link href="/health">全列表 →</Link>
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
