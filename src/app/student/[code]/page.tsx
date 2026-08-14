/**
 * 学情中心 · 学员学情（AI:PRD-008 · P2 · 设计稿 §二·12）
 *
 * 职责：`student_view` 数据包的页面化 = **报告的取数预览**。
 * **不管**出报告 —— 报告是批改线的出件（学情报告 skill 写英雄卡与措辞），
 * 本页只把数摆出来，末尾给一条能直接粘的取数命令。
 *
 * 四块（设计稿逐条）：
 *   ① 批次表：day / 线 / 得分 / 档位 / 挂桥 via / **未挂原因如实列**
 *   ② 考点掌握：perKp 进度条（🔴 题数口径，分母 = 题单挂载的考点）
 *   ③ 诊断三态**分列**：归因 / `'[]'` 拒绝归因 / `NULL` 未记录
 *   ④ 取数命令复制条（🔴 带 batch_id：报告是一天一份）
 *
 * 🔴 全程只读现算：圣域（审核.db）走 mode=ro 物理只读句柄，本库只有 SELECT，
 *    页面不落一行缓存 —— 缓存过的学情与真相漂开，是最难查的一类错。
 * 🔴 本页不写「掌握 / 薄弱」这类判词：那是报告的活。页面只给数与口径。
 */
import { Alert, Card, Col, Progress, Row, Tag } from "antd";
import Link from "next/link";

import {
  CopyCmd,
  DataSourceNote,
  EmptyHint,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import { getStudentView, type StudentViewResult } from "~/core";

export const dynamic = "force-dynamic";

const TH: React.CSSProperties = {
  background: "#f5f7fa",
  color: "#606266",
  fontWeight: 500,
  fontSize: 12.5,
  textAlign: "left",
  padding: "7px 9px",
  borderBottom: "1px solid #ebeef5",
  whiteSpace: "nowrap",
};
const TD: React.CSSProperties = {
  padding: "7px 9px",
  borderBottom: "1px solid #ebeef5",
  fontSize: 12.5,
  verticalAlign: "top",
};
const 表: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const 灰: React.CSSProperties = { color: "#909399" };

function 百分(ok: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((ok / total) * 100);
}

/** 覆盖 2/4：全挂=绿 / 全没挂=红 / 挂一半=橙 */
function 覆盖色(matched: number, total: number): string {
  if (total === 0) return "default";
  if (matched === total) return "green";
  if (matched === 0) return "red";
  return "orange";
}

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

// ---------------------------------------------------------------------------
// ① 批次表
// ---------------------------------------------------------------------------

function BatchTable({
  code,
  view,
  active,
}: {
  code: string;
  view: StudentViewResult;
  active: number | null;
}) {
  if (view.batches.length === 0) {
    return (
      <EmptyHint>
        圣域里没有这个代号的批次 ——
        这不是「他全对」，是「他还没交过卷，或者交的卷子还没进批改线」。
        代号必须与圣域 batches.student 一字不差（🔴 真名对不上桥）。
      </EmptyHint>
    );
  }
  const 排序 = [...view.batches].sort((a, b) => b.batchId - a.batchId);
  return (
    <table style={表}>
      <thead>
        <tr>
          <th style={{ ...TH, width: 76 }}>批次</th>
          <th style={{ ...TH, width: 56 }}>第几次</th>
          <th style={{ ...TH, width: 150 }}>线</th>
          <th style={{ ...TH, width: 130 }}>得分</th>
          <th style={{ ...TH, width: 110 }}>档位</th>
          <th style={{ ...TH, width: 120 }}>挂桥</th>
          <th style={TH}>说明（未挂原因 / 题单正本）</th>
          <th style={{ ...TH, width: 92 }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {排序.map((b) => (
          <tr
            key={b.batchId}
            style={active === b.batchId ? { background: "#f0f7ff" } : undefined}
          >
            <td style={{ ...TD, fontFamily: "Consolas, Menlo, monospace" }}>
              b{b.batchId}
            </td>
            <td style={TD}>{b.day ?? "—"}</td>
            <td style={TD}>
              {b.line ?? <span style={灰}>没挂上桥，拿不到线名</span>}
            </td>
            <td style={TD}>
              {b.score === null ? (
                <span style={灰}>—</span>
              ) : (
                <span
                  title="🔴 题数口径：分母 = 判定行数 − skip（漏抄整条摘掉），所以是 16/19 而不是 16/20"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {b.score.ok}/{b.score.total}
                  {b.score.total > 0
                    ? ` · ${百分(b.score.ok, b.score.total)}%`
                    : ""}
                  {b.score.skip > 0 ? (
                    <span style={灰}> （skip {b.score.skip} 已摘）</span>
                  ) : null}
                </span>
              )}
            </td>
            <td style={TD}>
              {b.auto ? (
                <Tag color="blue" title="无人值守放行（batches.auto）">
                  {b.auto}
                </Tag>
              ) : (
                <Tag title="batches.auto 是 NULL = 人工点的">人工</Tag>
              )}
              <div style={{ ...灰, marginTop: 2 }}>
                {b.status ?? "状态未记"}
                {b.round === null ? "" : ` · 第 ${b.round} 轮`}
              </div>
            </td>
            <td style={TD}>
              {b.matched ? (
                <Tag color="green">
                  {b.via === "slots" ? "slots 主路" : "补录桥"}
                  {b.taskId === null ? "" : ` → task${b.taskId}`}
                </Tag>
              ) : (
                <Tag color="red">无桥</Tag>
              )}
            </td>
            <td style={{ ...TD, whiteSpace: "pre-wrap" }}>
              {b.matched ? (
                <span style={灰}>
                  {b.sheet ?? "题单路径未记（tasks.sheet 为空）"}
                </span>
              ) : (
                <span style={{ color: "#c45656" }}>{b.why}</span>
              )}
            </td>
            <td style={TD}>
              {active === b.batchId ? (
                <Link href={`/student/${encodeURIComponent(code)}`}>
                  看全部批次
                </Link>
              ) : (
                <Link
                  href={`/student/${encodeURIComponent(code)}?batch=${b.batchId}`}
                >
                  只看这一批
                </Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// ② 考点掌握（perKp）
// ---------------------------------------------------------------------------

function KpMastery({ view }: { view: StudentViewResult }) {
  if (view.perKp.length === 0) {
    return (
      <EmptyHint>
        算不出考点掌握 —— 挂上桥的批次里没有对位到考点的题（挂桥{" "}
        {view.coverage.matched}/{view.coverage.total}）。🔴
        这不是「考点都掌握了」，是「这些卷子的题单还没登记到 SKU
        上，题次落不到考点」。
      </EmptyHint>
    );
  }
  return (
    <>
      <table style={表}>
        <thead>
          <tr>
            <th style={TH}>考点</th>
            <th style={{ ...TH, width: 260 }}>掌握（题数口径）</th>
            <th style={{ ...TH, width: 90 }}>对/总</th>
            <th style={{ ...TH, width: 190 }}>兜底档扣了几题次</th>
          </tr>
        </thead>
        <tbody>
          {view.perKp.map((k) => {
            const p = 百分(k.ok, k.total);
            return (
              <tr key={k.kpId}>
                <td style={TD}>
                  <Link href={`/kg/kp/${k.kpId}`}>{k.kpName}</Link>
                </td>
                <td style={TD}>
                  <Progress
                    percent={p}
                    size="small"
                    status={p === 100 ? "success" : "normal"}
                    strokeColor={
                      p === 100 ? "#67c23a" : p >= 60 ? "#409eff" : "#e6a23c"
                    }
                  />
                </td>
                <td style={{ ...TD, fontVariantNumeric: "tabular-nums" }}>
                  {k.ok}/{k.total}
                </td>
                <td style={TD}>
                  {k.fallbackAll === 0 ? (
                    <span style={灰}>0</span>
                  ) : (
                    <span
                      title="这些题的 error_kp 是 NULL（没给归因）→ 兜底档：该题所挂考点全扣。数摆在这儿，别当成「这个考点真的错了这么多」"
                      style={{ color: "#e6a23c" }}
                    >
                      {k.fallbackAll} 题次（error_kp IS NULL）
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 12, ...灰, lineHeight: 1.9 }}>
        · 分母 = <b>题单挂载的考点</b>（sku_item → question → question_kp），
        不是 error_kp：光有错因码算不出掌握度。
        <br />· 错因归位<b>不连坐</b>：一题挂 3 个考点只错 1 个，另外 2
        个这题算对。
        <br />· 本页不写「掌握 / 薄弱」这类判词 —— 那是报告的活（学情报告 skill
        出件），页面只给数与口径。
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ③ 诊断三态（分列，绝不并成一个「没归因」）
// ---------------------------------------------------------------------------

function CauseTriState({ view }: { view: StudentViewResult }) {
  const c = view.causes;
  return (
    <>
      <Alert
        type="info"
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            error_kp 三形态 —— 🔴 <b>NULL 未记录 ≠ &apos;[]&apos; 拒绝归因</b>
          </span>
        }
        description={
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            · 带码 <code>&apos;[&quot;pow&quot;,&quot;sign&quot;]&apos;</code> →{" "}
            <b>展开归因</b>（下表）；
            <br />· <code>&apos;[]&apos;</code> → <b>判×拒绝归因</b>
            ：明确说了「错的不属于本题所挂考点」，per_kp
            里该题所挂的码一个都不扣；
            <br />· <code>NULL</code> → <b>未给归因</b>
            （老批次 / 未走归因链）：兜底档，per_kp 里该题所挂的码全扣。
            <br />
            🔴 把 NULL 当 <code>&apos;[]&apos;</code>
            会让错题的考点凭空「算对」—— 两者必须分列，不许合并。
          </div>
        }
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={8}>
          <Card size="small" title="① 展开归因（带码）">
            {c.rows.length === 0 ? (
              <EmptyHint>
                没有一条码翻译成了错因实体。🔴
                「没有数据」不是「没有错误」：要么这些批次没挂上桥（覆盖{" "}
                {c.coverage.matched}/{c.coverage.total}
                ），要么码还没铺映射（见下方红旗）。
              </EmptyHint>
            ) : (
              <table style={表}>
                <thead>
                  <tr>
                    <th style={TH}>错因</th>
                    <th style={{ ...TH, width: 70 }}>码</th>
                    <th style={{ ...TH, width: 56 }}>码次</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r) => (
                    <tr key={`${r.causeId}|${r.kpId}|${r.errCode}`}>
                      <td style={TD}>
                        {r.causeName}
                        <div style={灰}>
                          <Link href={`/kg/kp/${r.kpId}`}>{r.kpName}</Link>
                        </div>
                      </td>
                      <td
                        style={{
                          ...TD,
                          fontFamily: "Consolas, Menlo, monospace",
                        }}
                      >
                        {r.errCode}
                      </td>
                      <td style={TD}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            size="small"
            title={`② '[]' 拒绝归因 · ${c.unattributed.count} 题`}
            extra={
              <span style={{ ...灰, fontSize: 11.5 }}>判× 且明确不归因</span>
            }
          >
            {c.unattributed.count === 0 ? (
              <div style={{ fontSize: 12.5, ...灰 }}>
                没有这一形态的题。（不是「没有错」——错法在①③两列里）
              </div>
            ) : (
              <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                错的不属于本题所挂考点（抄错答案 / 没写完这类），
                <b>per_kp 一个码都不扣</b>：与得分同时成立是口径，不是 bug。
                <div style={{ marginTop: 6, ...灰 }}>
                  样本：
                  {c.unattributed.sample
                    .map((s) => `b${s.batchId}·q${s.qno}`)
                    .join("、")}
                  {c.unattributed.count > c.unattributed.sample.length
                    ? " …"
                    : ""}
                </div>
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            size="small"
            title={`③ NULL 未记录 · ${c.unrecorded.count} 题`}
            extra={
              <span style={{ ...灰, fontSize: 11.5 }}>判× 但没给归因</span>
            }
          >
            {c.unrecorded.count === 0 ? (
              <div style={{ fontSize: 12.5, ...灰 }}>
                没有这一形态的题（该批次都走过归因链）。
              </div>
            ) : (
              <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                老批次 / 没走归因链：<b>兜底档，该题所挂考点全扣</b>
                （②的进度条里那一列 fallbackAll 就是它）。
                <div style={{ marginTop: 6, ...灰 }}>
                  样本：
                  {c.unrecorded.sample
                    .map((s) => `b${s.batchId}·q${s.qno}`)
                    .join("、")}
                  {c.unrecorded.count > c.unrecorded.sample.length ? " …" : ""}
                </div>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {c.copyReminder.count > 0 ? (
        <Alert
          type="warning"
          style={{ marginTop: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              口径③ 抄错题面按所抄算：{c.copyReminder.count} 个码次是
              <b>抄写提醒</b>，已从错因分布里剔除、单列（
              {c.copyReminder.codes
                .map((x) => `${x.errCode}×${x.count}`)
                .join("、")}
              ）。
            </span>
          }
        />
      ) : null}

      {c.unmapped.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              🔴 {c.unmapped.length} 组 (考点, 码) 查不到 err_code_map 映射 ——
              这些错没有被静默丢掉，都摆在这儿（带样本 batch/qno）
            </span>
          }
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {c.unmapped.map((u) => (
                <div key={`${u.kpId}|${u.errCode}`}>
                  · <b>{u.kpName}</b> × <code>{u.errCode}</code> —— {u.count}{" "}
                  码次（样本{" "}
                  {u.sample.map((s) => `b${s.batchId}·q${s.qno}`).join("、")}）{" "}
                  <Link
                    href={`/cause/map?kp=${encodeURIComponent(u.kpId)}&code=${encodeURIComponent(u.errCode)}`}
                  >
                    去补映射 →
                  </Link>
                </div>
              ))}
            </div>
          }
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default async function StudentViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code: rawCode } = await params;
  const code = decodeURIComponent(rawCode);
  const sp = await searchParams;
  const batchRaw = one(sp, "batch");
  const batchId =
    batchRaw !== "" && /^\d+$/.test(batchRaw) ? Number(batchRaw) : null;

  // 🔴 两次取数，各有各的口径：
  //    全量 = 批次表（要看得见没挂上桥的那几卷）；
  //    单批 = ②③④（报告是一天一份，混着两天出的 perKp 不是任何一天的报告）。
  let all: StudentViewResult;
  try {
    all = await getStudentView(code);
  } catch (e) {
    return (
      <>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 12px" }}>
          学员学情 · {code}
        </h1>
        <Alert
          type="error"
          showIcon
          message="学情读不出来（原文照登）"
          description={
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, margin: 0 }}>
              {e instanceof Error ? `${e.name}: ${e.message}` : String(e)}
            </pre>
          }
        />
      </>
    );
  }

  const 有这一批 =
    batchId !== null && all.batches.some((b) => b.batchId === batchId);
  const scoped =
    有这一批 && batchId !== null
      ? await getStudentView(code, { batchId })
      : null;
  const 视图 = scoped ?? all;
  const 选中 = scoped ? batchId : null;

  // 取数命令里的 batch_id：优先选中的那一批，否则最近一个挂上桥的批次
  const 挂上的 = all.batches.filter((b) => b.matched);
  const 推荐批次 =
    选中 ??
    (挂上的.length > 0
      ? 挂上的.reduce((a, b) => (b.batchId > a.batchId ? b : a)).batchId
      : null);
  const 取数命令 =
    推荐批次 === null
      ? `student_view {"code":"${code}"}`
      : `student_view {"code":"${code}","batch_id":${推荐批次}}`;

  const r = all.roster;

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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
          学员学情 · {code}
        </h1>
        <span style={{ fontSize: 12.5, ...灰 }}>
          student_view 数据包的页面化 = 报告的取数预览（不出报告）
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.getStudentView / causeDistribution（与 MCP student_view
            同一入口）· 圣域 审核.db(mode=ro) batches/slots/items + 本库
            sku_item / question_kp / err_code_map
          </DataSourceNote>
        </span>
      </div>

      {/* ── 名册维度 + 覆盖口径 ─────────────────────────────────────────── */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[12, 8]}>
          <Col xs={24} lg={10}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>名册（roster，纯维度表）</b>
              <br />
              {r ? (
                <>
                  <StatusTag value={r.status} /> {r.grade ?? "年级未记"} ·{" "}
                  {r.editionCtx ?? "版本语境未声明"} · 入册{" "}
                  <TimeText iso={r.joinedAt} />
                  {r.alias ? <div style={灰}>线内叫法：{r.alias}</div> : null}
                  {r.note ? (
                    <div style={{ ...灰, whiteSpace: "pre-wrap" }}>
                      {r.note}
                    </div>
                  ) : null}
                </>
              ) : (
                <span style={{ color: "#e6a23c" }}>
                  roster 里没有这个代号 —— 数据照常算（学情事实全在圣域，roster
                  只是维度表），但选题台/交付指向拿不到年级与版本上下文。
                </span>
              )}
            </div>
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>挂桥覆盖（本页所有考点口径的分母面）</b>
              <br />
              <Tag color={覆盖色(视图.coverage.matched, 视图.coverage.total)}>
                {视图.coverage.matched}/{视图.coverage.total}（
                {视图.coverage.rate}）
              </Tag>
              <br />
              <span style={灰}>
                挂不上桥 ≠ 没数据：分数照给，只是算不到考点上。
              </span>
            </div>
          </Col>
          <Col xs={24} lg={7}>
            <div style={{ fontSize: 12.5, lineHeight: 2 }}>
              <b>已做题集</b>
              <br />
              {all.done.count} 道（选题时排除已做的那一份）
              <br />
              <span style={灰}>
                🔴 未挂桥批次上做过的题算不进来，这个集合是偏小的。
              </span>
            </div>
          </Col>
        </Row>
      </Card>

      {视图.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={<span style={{ fontSize: 12.5 }}>取数时的如实提示</span>}
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {视图.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          }
        />
      ) : null}

      {/* ── ① 批次表 ───────────────────────────────────────────────────── */}
      <Card
        size="small"
        title="① 批次（全部，含没挂上桥的）"
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 11.5, ...灰 }}>
            {选中 === null
              ? "下面两块 = 全部挂桥批次汇总；点「只看这一批」切到单批口径（报告是一天一份）"
              : `下面两块已切到单批口径：b${选中}`}
          </span>
        }
      >
        <BatchTable code={code} view={all} active={选中} />
      </Card>

      {/* ── ② 考点掌握 ─────────────────────────────────────────────────── */}
      <Card
        size="small"
        title={`② 考点掌握${选中 === null ? "（全部挂桥批次汇总）" : `（b${选中} 单批）`}`}
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 11.5, ...灰 }}>
            🔴 题数口径：一题挂 N 个考点就算 N 题次
          </span>
        }
      >
        <KpMastery view={视图} />
      </Card>

      {/* ── ③ 诊断三态 ─────────────────────────────────────────────────── */}
      <Card
        size="small"
        title={`③ 诊断三态${选中 === null ? "" : `（b${选中} 单批）`}`}
        style={{ marginBottom: 12 }}
      >
        <CauseTriState view={视图} />
      </Card>

      {/* ── ④ 取数命令 ─────────────────────────────────────────────────── */}
      <Card size="small" title="④ 出报告的取数命令">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <CopyCmd label="MCP 取数" cmd={取数命令} />
        </div>
        <div style={{ marginTop: 8, fontSize: 12, ...灰, lineHeight: 1.9 }}>
          🔴 <b>必须带 batch_id</b>：报告是一天一份（「第 02
          天学情分析」），不筛批次就会把两天并成一行 perKp ——
          那不是任何一天的报告。
          {推荐批次 === null
            ? "（这个学员一个批次都没挂上桥，命令里就没有 batch_id：拿到的 perKp 会是空的，先把桥挂上。）"
            : ""}
          <br />
          报告的措辞与英雄卡结论仍由「学情报告分析」skill
          写，本页只交数（每条结论都能回指到 batch_id / qno / kp_id）。
        </div>
        <div style={{ marginTop: 8, fontSize: 12, ...灰, lineHeight: 1.9 }}>
          <b>判定口径（core 的原句，一个字不改）</b>
          <br />
          {视图.rubric.map((s, i) => (
            <div key={i}>· {s}</div>
          ))}
        </div>
      </Card>
    </>
  );
}
