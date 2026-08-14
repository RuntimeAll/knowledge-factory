/**
 * 系统监控 · 备份与对账（AI:PRD-008 · P3 · 设计稿 §二·16）
 *
 * 职责：库健不健康一页看完 —— 库体检 + 对账六项 C1~C6 最近结果 + 快照列表
 * + 回归最近一跑 + 三条运维命令。**只读**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 本页不触发任何写 —— 三处刻意的选择：
 *   ① 对账默认显示**最近一次的摘要**（core.getLatestIntegritySummary 读 metric_event），
 *      不在打开页面时现跑：现跑要连圣域、扫全表、遍历 assets，且默认会 logMetric
 *      （一次库写 + 一条审计行）。「跑一次」是人显式发起的动作，不是页面加载的副作用。
 *   ② 要现跑，点那个按钮 —— 走 /api/health/integrity，`metric:false`，不进库不留痕、
 *      顶不掉命令行跑出来的正式结论（理由见那个路由的文件头）。
 *   ③ 快照卡只**列目录**（core.listBackups 读文件系统），绝不在页面上出快照：
 *      backupNow 会写 metric_event + 审计行，而且备份该由计划任务/人来发起。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 「快照的验证结果」如实空着：listBackups 只 stat 文件，没打开过它们。
 *    在这一栏编一个「有效」是这页最不该干的事 —— 验证是 backup-verify.ts 的活
 *    （它会出一份新快照再用另一段代码独立打开数一遍），命令就在卡片里。
 * 🔴 「回归 11 关最近一跑」拿不到：regression.ps1 只打控制台 + 退出码，
 *    战报不落库也不落文件。所以这块**只给跑法**，不假装有个最近结果。
 */
import { Alert, Card, Col, Row, Tag } from "antd";

import {
  CopyCmd,
  DataSourceNote,
  EmptyHint,
  TimeText,
} from "~/components/console/ui";
import { getLatestIntegritySummary, health, listBackups } from "~/core";
import { IntegrityRecheck } from "./recheck";
import { CHECK_IDS, CHECK_TITLE } from "./shared";

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
  padding: "7px 10px",
  borderBottom: "1px solid #ebeef5",
};
const TD: React.CSSProperties = {
  padding: "7px 10px",
  borderBottom: "1px solid #ebeef5",
  fontSize: 12.5,
  verticalAlign: "top",
};

export default async function HealthPage() {
  const [h, integ, snaps] = await Promise.all([
    safe(() => health()),
    safe(() => getLatestIntegritySummary()),
    safe(() => listBackups({ limit: 20 })),
  ]);

  const 体检 = typeof h === "string" ? null : h;
  const 对账 = typeof integ === "string" ? null : integ;
  const 快照 = typeof snaps === "string" ? [] : snaps;

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
        {/* 🔴 nowrap：数据源那行字长，不钉住的话标题会被挤成「备份与对 / 账」两行 */}
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            margin: 0,
            whiteSpace: "nowrap",
          }}
        >
          备份与对账
        </h1>
        <span
          style={{ fontSize: 12.5, color: "#909399", whiteSpace: "nowrap" }}
        >
          库健不健康一页看完 —— 只读，页面不触发任何写
        </span>
        <span style={{ marginLeft: "auto", textAlign: "right" }}>
          <DataSourceNote>
            core.health / core.getLatestIntegritySummary（metric_event 的
            integrity_check 最近一行）/ core.listBackups（data/backup/）
          </DataSourceNote>
        </span>
      </div>

      {/* ── 库体检（毫秒级，现算）───────────────────────────────────────── */}
      <Card size="small" title="库体检（现算）" style={{ marginBottom: 14 }}>
        {typeof h === "string" ? (
          <Alert type="error" showIcon message={`库体检读不出来：${h}`} />
        ) : 体检 ? (
          <Row gutter={[12, 8]} style={{ fontSize: 12.5, lineHeight: 2 }}>
            <Col xs={24} lg={8}>
              <Tag color={体检.ok ? "green" : "red"}>
                {体检.ok ? "库活着 · 闸静息 · 链尾正常" : "不健康"}
              </Tag>
              <br />
              表数 {体检.tableCount} 张（含 FTS 影子表与机制表；WP2 立项时 41）
              <br />
              审计链尾 seq {体检.auditHeadSeq ?? "—（空链）"}
            </Col>
            <Col xs={24} lg={8}>
              写闸 allowed=<b>{体检.writeGate}</b>
              （🔴 正常恒为 0；非 0 = 有人把闸拆成独立事务，或开了没关）
              <br />
              journal_mode = {体检.journalMode} · 外键{" "}
              {体检.foreignKeys ? "ON" : "OFF"} · busy_timeout{" "}
              {体检.busyTimeoutMs}ms
            </Col>
            <Col xs={24} lg={8}>
              <span style={{ color: "#909399", wordBreak: "break-all" }}>
                {体检.url}
              </span>
              <br />
              <TimeText iso={体检.checkedAt} />
            </Col>
          </Row>
        ) : null}
      </Card>

      {/* ── 对账六项 C1~C6 ─────────────────────────────────────────────── */}
      <Card
        size="small"
        title="对账六项 C1~C6"
        style={{ marginBottom: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            默认显示「最近一次」的摘要（不是现跑）—— red = 数据已经不自洽；warn
            = 还没补齐但结论不会错，不红拦
          </span>
        }
      >
        {typeof integ === "string" ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 10 }}
            message={`对账摘要读不出来：${integ}`}
          />
        ) : null}

        {对账 ? (
          <>
            <div style={{ marginBottom: 8, fontSize: 12.5 }}>
              <Tag color={对账.ok ? "green" : "red"}>
                {对账.ok ? "全绿 · 无红旗" : `红旗 ${对账.red.length} 项`}
              </Tag>
              {对账.warn.length > 0 ? (
                <Tag color="orange">warn {对账.warn.length}</Tag>
              ) : null}
              <span style={{ color: "#909399" }}>
                最近一次：
                <TimeText iso={对账.ts} />
                （metric_event #{对账.metricId}）
              </span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 56 }}>项</th>
                  <th style={TH}>说明</th>
                  <th style={{ ...TH, width: 96 }}>最近结果</th>
                </tr>
              </thead>
              <tbody>
                {CHECK_IDS.map((id) => {
                  const item = 对账.items.find((i) => i.id === id) ?? null;
                  const red = 对账.red.includes(id);
                  const warn = 对账.warn.includes(id);
                  return (
                    <tr key={id}>
                      <td style={TD}>
                        <b>{id}</b>
                      </td>
                      <td style={TD}>
                        {/* 🔴 名字用摘要里那份 —— 它是**当次对账**的原话。
                            本页的 CHECK_TITLE 只作兜底：WP6 之前落的老摘要行没有
                            items 字段，那时才拿它顶上（两份并排摆等于同一句话说两遍）。 */}
                        {item?.name ?? CHECK_TITLE[id]}
                      </td>
                      <td style={TD}>
                        {red ? (
                          <Tag color="red">RED</Tag>
                        ) : warn ? (
                          <Tag color="orange">WARN</Tag>
                        ) : item ? (
                          <Tag color="green">PASS</Tag>
                        ) : (
                          <Tag>摘要里没这一项</Tag>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: 11.5, color: "#909399" }}>
              🔴 摘要只驮「哪几项红/warn」，不驮明细（C5 挂不上桥的是哪几批、 C1
              少了哪几行，摘要里没有）。要明细就点下面那个按钮现跑一次，
              或跑命令行版留一条正式账。
            </div>
          </>
        ) : typeof integ === "string" ? null : (
          <EmptyHint>
            还没跑过对账（metric_event 里没有 kind=integrity_check 的行）。
            <br />
            🔴 「没有对账记录」不等于「库没问题」—— 它只说明这库还没被检查过。
          </EmptyHint>
        )}

        <div style={{ marginTop: 12 }}>
          <IntegrityRecheck />
        </div>
      </Card>

      {/* ── 快照列表 ───────────────────────────────────────────────────── */}
      <Card
        size="small"
        title={`快照（data/backup/ · 列最近 ${快照.length} 份）`}
        style={{ marginBottom: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            事实源是「文件系统」不是库：备份的意义就在于「库没了它还在」
          </span>
        }
      >
        {typeof snaps === "string" ? (
          <Alert type="error" showIcon message={`快照列不出来：${snaps}`} />
        ) : 快照.length === 0 ? (
          <EmptyHint>
            一份快照都没有 —— 这不是「暂无数据」，这是没有退路。先跑一次备份。
          </EmptyHint>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={TH}>文件</th>
                <th style={{ ...TH, width: 110 }}>时间</th>
                <th style={{ ...TH, width: 90 }}>大小</th>
                <th style={{ ...TH, width: 100 }}>时点</th>
                <th style={{ ...TH, width: 220 }}>验证结果</th>
              </tr>
            </thead>
            <tbody>
              {快照.map((s) => (
                <tr key={s.path}>
                  <td style={TD}>
                    <span
                      style={{
                        fontFamily: "Consolas, Menlo, monospace",
                        fontSize: 11.5,
                      }}
                    >
                      {s.file}
                    </span>
                  </td>
                  <td style={TD}>
                    <TimeText iso={s.mtime} />
                  </td>
                  <td style={TD}>{bytesText(s.bytes)}</td>
                  <td style={TD}>
                    <Tag>{s.reason}</Tag>
                  </td>
                  <td style={{ ...TD, color: "#909399" }}>
                    未验证（本页只 stat 文件，没打开过它）
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 10 }}>
          <CopyCmd
            label="验证快照真能打开（出新快照 + 独立只读复算）"
            cmd="pnpm exec tsx --env-file=.env scripts/backup-verify.ts"
          />
        </div>
      </Card>

      {/* ── 回归 11 关 ─────────────────────────────────────────────────── */}
      <Card
        size="small"
        title="回归 11 关（最近一跑）"
        style={{ marginBottom: 14 }}
      >
        <EmptyHint>
          🔴 拿不到：regression.ps1 只往控制台打逐关 [PASS]/[FAIL]，退出码 =
          失败关数 —— 战报既不落库也不落文件，所以本页没有可显示的「最近一跑」。
          <br />
          与其画一个看起来像真的假结果，不如把跑法摆在这儿。要让这块长出真数据，
          得先让 regression.ps1 把汇总写进 metric_event（那是另一张卡的事）。
        </EmptyHint>
        <div style={{ marginTop: 10, fontSize: 12, color: "#606266" }}>
          十一关 = A3a 静态 · A3b 依赖探针 · A1 对账 · A2 审计链 · TEST 单测全量
          · B KG 金标 · C 录题+产线 · D 检索 · E 产线流程与族谱 · F 学情读侧 ·
          A4 备份快照
        </div>
      </Card>

      {/* ── 三条运维命令 ───────────────────────────────────────────────── */}
      <Card size="small" title="运维命令（复制去终端跑）">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <CopyCmd
            label="① 备份（VACUUM INTO 一致性快照，会留痕）"
            cmd="pnpm exec tsx --env-file=.env scripts/backup.ts --reason manual"
          />
          <CopyCmd
            label="② 对账（退出码 = red 项数；会写一条正式摘要）"
            cmd="pnpm exec tsx --env-file=.env scripts/integrity-check.ts"
          />
          <CopyCmd
            label="③ 回归（十一关全量，任一关红了也跑完）"
            cmd="powershell -File scripts/regression.ps1"
          />
        </div>
        <div style={{ marginTop: 10, fontSize: 11.5, color: "#909399" }}>
          🔴 这三条都是「写」动作（备份/对账都会
          logMetric，连带审计行），所以它们在 命令行、不在页面按钮上 —— 设计稿
          §〇·3：数据生产类的写不上页面， 页面只给一句能直接粘的命令。
        </div>
      </Card>
    </>
  );
}
