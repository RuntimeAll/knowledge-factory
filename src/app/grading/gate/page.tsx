/**
 * 批改流水线 · 升档判据（AI:PRD-008 · 设计稿 §二 批改流水线组第 3 页）
 *
 * 职责：把「**L1 两周零翻案 ∧ 风险台账清零**」变成一眼可见的数字与清单。
 * **不管**：改档位（旋钮在 `订阅特训/_产线/产线配置.json`，产线的地盘，本页只读它）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 三个率**全部现算**（审核.db mode=ro 逐行读、JS 里算），一个都不许硬编码：
 *      翻案率   = 用户终审 ≠ agent 预判 的题次 / **人工**终审且非存疑 的题次
 *                🔴 分母摘掉 L1静默批次（batches.auto 非空）：那些的终审值是机器
 *                   自己抄的预判，final ≡ pre 是结构决定的（2026-08-14 验收判红修）
 *      存疑率   = agent 标存疑（?/doubt/missing）的题次 / 全部判定行
 *      静默放行 = batches.auto 非空 的批次 / 已 confirmed 的批次
 *   分母为 0 一律显示「数据不足」，绝不显示 0% 或 100%（1 例算成 100% 是最常见的骗术）。
 * 🔴 风险台账 8 条是**静态表**，逐字照抄正本：
 *      `订阅特训/_产线/需求沉淀-2026-08-13-无人值守流水线.md` §五（L2 风险台账）。
 *      ⚠️ 本卡任务书写的是「PRD-027 设计稿 §五」，但那一节是「实施顺序」——
 *      8 条台账的正本在需求沉淀 §五（PRD-027 设计稿 §六 与交付记录 L4 都指向它）。
 *      状态列一律「开放」：正本没有任何一条标关闭，交付记录 L4 也写着「台账 8 条未清零」。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";

import { Alert, Card, Col, Row, Tag, Tooltip } from "antd";

import { DataSourceNote, StatCard, TimeText } from "~/components/console/ui";
import { getGradingDb, nowLocalISO } from "~/core";
import { pipelineConfigFile } from "../paths";
import { RISK_LEDGER } from "./ledger";

export const dynamic = "force-dynamic";

/** 存疑判定值面（与 产线配置.json「零存疑（?/doubt/missing 皆无）」同口径） */
const DOUBT_PRE = ["?", "doubt", "missing"];
/** 「两周零翻案」的两周 */
const L1_WINDOW_DAYS = 14;
/** 周窗口 */
const WEEK_DAYS = 7;

interface Rates {
  /** 翻案：非存疑且已终审的题次里，终审与预判不一致的（含静默批次，见下） */
  flips: number;
  judged: number;
  /**
   * 🔴🔴 **人工终审**口径（2026-08-14 修 · 验收判红）：把 `batches.auto` 非空的批次
   *    （L1静默放行）从分母里摘出去 —— 那些批次的 verdict_final 是产线**照抄机器预判**
   *    写进去的（直批.py:363 `DB.confirm(..., {qno: verdict}, auto='L1静默')`），
   *    final ≡ pre 是结构决定的，人从来没看过。把它们算进「零翻案」等于拿机器
   *    自己给自己打的分去支撑升 L2。判据①只认这一对数。
   */
  flipsHuman: number;
  judgedHuman: number;
  /** 被摘出去的那部分（静默批次里已终审的非存疑题次）——如实摆出来，不闷声扣掉 */
  judgedAuto: number;
  doubt: number;
  items: number;
  autoBatches: number;
  confirmedBatches: number;
  batches: number;
  /** 最早一次静默放行（L1 连续天数的起点） */
  firstAutoAt: string | null;
  lastFlipAt: string | null;
}

const 空率: Rates = {
  flips: 0,
  judged: 0,
  flipsHuman: 0,
  judgedHuman: 0,
  judgedAuto: 0,
  doubt: 0,
  items: 0,
  autoBatches: 0,
  confirmedBatches: 0,
  batches: 0,
  firstAutoAt: null,
  lastFlipAt: null,
};

/** 分数串：分母 0 就说「数据不足」，不给百分数 */
function pct(num: number, den: number): string {
  if (den <= 0) return "数据不足";
  return `${((num / den) * 100).toFixed(1)}%`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
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
  fontSize: 12.5,
  verticalAlign: "top",
};

export default async function GradingGatePage() {
  const now = nowLocalISO();
  // 审核.db 的 created_at 没有时区后缀（'2026-08-11T00:49:48'）——
  // 比较时把本地 ISO 砍掉偏移量，两边都是「本地墙上时间」字符串，可直接比大小。
  const 周界 = new Date(Date.now() - WEEK_DAYS * 86_400_000);
  const 周界串 = nowLocalISO(周界).slice(0, 19);

  let 全量 = 空率;
  let 近周 = 空率;
  let dbPath: string | null = null;
  let dbError: string | undefined;

  try {
    const g = await getGradingDb();
    dbPath = g.path;

    const batches = g.query<{
      id: number;
      status: string | null;
      auto: string | null;
      created_at: string | null;
      confirmed_at: string | null;
    }>(
      "SELECT id, status, auto, created_at, confirmed_at FROM batches ORDER BY id",
    );
    const items = g.query<{
      batch_id: number;
      verdict_pre: string | null;
      verdict_final: string | null;
      needs_human: number | null;
    }>("SELECT batch_id, verdict_pre, verdict_final, needs_human FROM items");

    const 建于 = new Map(
      batches.map((b) => [Number(b.id), b.created_at ?? null] as const),
    );
    // 🔴 静默放行的批次（batches.auto 非空）：它们的终审值没有人看过
    const 静默批次 = new Set(
      batches.filter((b) => !!b.auto).map((b) => Number(b.id)),
    );

    function 算(窗: (createdAt: string | null) => boolean): Rates {
      const r: Rates = { ...空率 };
      for (const b of batches) {
        if (!窗(b.created_at ?? null)) continue;
        r.batches += 1;
        if (b.status === "confirmed") r.confirmedBatches += 1;
        if (b.auto) {
          r.autoBatches += 1;
          const at = b.confirmed_at ?? b.created_at ?? null;
          if (at && (r.firstAutoAt === null || at < r.firstAutoAt)) {
            r.firstAutoAt = at;
          }
        }
      }
      for (const it of items) {
        if (!窗(建于.get(Number(it.batch_id)) ?? null)) continue;
        r.items += 1;
        const 存疑 =
          (it.verdict_pre !== null && DOUBT_PRE.includes(it.verdict_pre)) ||
          Number(it.needs_human ?? 0) === 1;
        if (存疑) {
          r.doubt += 1;
          continue; // 存疑题本来就是交人工的，不进翻案率的分母
        }
        if (it.verdict_pre === null || it.verdict_final === null) continue;
        r.judged += 1;
        const 静默 = 静默批次.has(Number(it.batch_id));
        if (静默) {
          // 🔴 机器自己写的终审值：结构上不可能翻案，不进判据①的分母
          r.judgedAuto += 1;
        } else {
          r.judgedHuman += 1;
        }
        if (it.verdict_final !== it.verdict_pre) {
          r.flips += 1;
          if (!静默) r.flipsHuman += 1;
          const at = 建于.get(Number(it.batch_id)) ?? null;
          if (at && (r.lastFlipAt === null || at > r.lastFlipAt)) {
            r.lastFlipAt = at;
          }
        }
      }
      return r;
    }

    全量 = 算(() => true);
    近周 = 算((at) => at !== null && at >= 周界串);
  } catch (e) {
    dbError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  // ── 档位旋钮（只读 产线配置.json；读不到就说读不到，不假设 L0/L1） ──────
  const cfgPath = pipelineConfigFile();
  let 档位: string | null = null;
  let cfgError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const v = (parsed as Record<string, unknown>).档位;
      档位 = typeof v === "string" ? v : null;
      if (档位 === null) cfgError = "配置里没有「档位」字段（或它不是字符串）";
    } else {
      cfgError = "产线配置.json 不是 JSON 对象";
    }
  } catch (e) {
    cfgError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  const L1天数 =
    全量.firstAutoAt === null ? null : daysBetween(全量.firstAutoAt, now);
  // 🔴 判据①只认**人工终审**那一半（静默批次的 final ≡ pre，见 Rates.judgedHuman）
  const 零翻案 = 全量.judgedHuman > 0 && 全量.flipsHuman === 0;

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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>升档判据</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          升 L2 靠数字不靠感觉：L1 跑两周零翻案 ∧ 风险台账 8 条全关
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            审核.db（mode=ro：batches / items）现算 · 档位读 {cfgPath} ·
            台账正本 = 需求沉淀-2026-08-13-无人值守流水线.md §五
          </DataSourceNote>
        </span>
      </div>

      {dbError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="审核.db 读不出来（原文照登）——下面的率一个都没算"
          description={<span style={{ fontSize: 12.5 }}>{dbError}</span>}
        />
      ) : null}

      {/* ── 三个率 + 当前档位 ─────────────────────────────────────────── */}
      <Row gutter={[12, 12]}>
        <Col xs={12} lg={6}>
          <StatCard
            label="翻案率（人工终审）"
            value={pct(全量.flipsHuman, 全量.judgedHuman)}
            sub={
              `${全量.flipsHuman}/${全量.judgedHuman} 人工终审的非存疑判定 · ` +
              `近 ${WEEK_DAYS} 天 ${pct(近周.flipsHuman, 近周.judgedHuman)}（${近周.flipsHuman}/${近周.judgedHuman}）· ` +
              `🔴 另有 ${全量.judgedAuto} 题次来自静默批次（机器自判，不入分母）`
            }
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="存疑率（全量）"
            value={pct(全量.doubt, 全量.items)}
            sub={`${全量.doubt}/${全量.items} 题次 · 近 ${WEEK_DAYS} 天 ${pct(近周.doubt, 近周.items)}（${近周.doubt}/${近周.items}）`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="静默放行率（全量）"
            value={pct(全量.autoBatches, 全量.confirmedBatches)}
            sub={`${全量.autoBatches}/${全量.confirmedBatches} 已确认批次带 auto 留痕 · 近 ${WEEK_DAYS} 天 ${pct(近周.autoBatches, 近周.confirmedBatches)}`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            label="当前档位"
            value={档位 ?? "读不到"}
            sub={
              档位
                ? "产线配置.json 的旋钮（本页只读）"
                : "🔴 读不到 ≠ L0：代码侧 fail-safe 才退 L0，本页不替它断言"
            }
          />
        </Col>
      </Row>

      {cfgError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={`档位旋钮没读出来：${cfgError}`}
          description={
            <span style={{ fontSize: 12.5 }}>
              文件 = {cfgPath}。产线代码遇到这种情况会 fail-safe 退
              L0（朝人工方向）， 但那是产线的行为 —— 本页只如实说「读不到」。
            </span>
          }
        />
      ) : null}

      {/* ── 两周零翻案 ────────────────────────────────────────────────── */}
      <Card
        size="small"
        title="升 L2 判据①：L1 跑两周零翻案"
        style={{ marginTop: 14 }}
      >
        <div style={{ fontSize: 12.5, lineHeight: 2 }}>
          <div>
            <b>零翻案</b>：
            {全量.judgedHuman === 0 ? (
              <Tag>
                数据不足（还没有<b>人工终审</b>过的非存疑题次
                {全量.judgedAuto > 0
                  ? ` —— 库里那 ${全量.judgedAuto} 题次全在静默批次里，人从没看过`
                  : ""}
                ）
              </Tag>
            ) : 零翻案 ? (
              <Tag color="green">是 · {全量.judgedHuman} 题次 0 翻案</Tag>
            ) : (
              <Tag color="red">
                否 · {全量.flipsHuman}/{全量.judgedHuman} 被翻
                {全量.lastFlipAt
                  ? `（最近一次在 ${全量.lastFlipAt} 建的批次）`
                  : ""}
              </Tag>
            )}
            {全量.judgedAuto > 0 ? (
              <Tooltip title="静默批次的 verdict_final 是产线照抄机器预判写进去的（直批.py 的 DB.confirm(..., auto='L1静默')），final ≡ pre 是结构决定的 —— 拿它们凑「零翻案」等于自证">
                <span style={{ color: "#e6a23c", marginInlineStart: 8 }}>
                  （另有 {全量.judgedAuto} 题次来自 L1静默批次，未计入 —— 人从未终审）
                </span>
              </Tooltip>
            ) : null}
          </div>
          <div>
            <b>L1 已跑</b>：
            {全量.firstAutoAt === null ? (
              <Tag>数据不足（库里还没有 auto 非空的批次）</Tag>
            ) : (
              <>
                <Tag
                  color={(L1天数 ?? 0) >= L1_WINDOW_DAYS ? "green" : "orange"}
                >
                  {L1天数} 天 / 需 {L1_WINDOW_DAYS} 天
                </Tag>
                起点 = 最早一次静默放行 <TimeText iso={全量.firstAutoAt} />
              </>
            )}
          </div>
          <div style={{ color: "#909399" }}>
            🔴 口径：翻案 = 用户终审值与 agent 预判值不一致。两类题次
            <b>不进分母</b>：① agent 自标存疑（?/doubt/missing）—— 那些本来就是交给人的，
            人改了不算翻案；② <b>L1静默批次</b>（batches.auto 非空）—— 那些批次的终审值
            是产线照抄机器预判写的，人从未看过，结构上不可能出现翻案，
            算进来就是拿自证的数字支撑升档。
            <br />
            这与正本 §四 的回放口径一致（08-13：122 题<b>人工</b>非存疑判定，用户翻案 0）。
          </div>
        </div>
      </Card>

      {/* ── 风险台账 8 条 ─────────────────────────────────────────────── */}
      <Card
        size="small"
        title="升 L2 判据②：风险台账 8 条全关"
        style={{ marginTop: 14 }}
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            正本 = 需求沉淀-2026-08-13-无人值守流水线.md
            §五（逐字照抄，本页不加判断）
          </span>
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message={`8 条全部「开放」——台账未清零，L2 不开（PRD-027 包① 交付记录 L4 原话：「L2 档不开（风险台账 8 条未清零）」）。`}
        />
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 34 }}>#</th>
                <th style={TH}>风险</th>
                <th style={TH}>现防线</th>
                <th style={TH}>关闭条件</th>
                <th style={{ ...TH, width: 130 }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {RISK_LEDGER.map((r) => (
                <tr key={r.no}>
                  <td style={TD}>{r.no}</td>
                  <td style={TD}>{r.risk}</td>
                  <td style={TD}>{r.guard}</td>
                  <td style={TD}>{r.close}</td>
                  <td style={TD}>
                    <Tooltip title={r.note ?? "正本没有标关闭"}>
                      <Tag color="orange">开放</Tag>
                    </Tooltip>
                    {r.note ? (
                      <div style={{ color: "#909399", marginTop: 2 }}>
                        {r.note}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ marginTop: 14, fontSize: 12, color: "#909399" }}>
        圣域（只读）：{dbPath ?? "路径未知（审核.db 没连上）"}
        <br />
        本页只读、现算，没有缓存。档位要改去动 {cfgPath}{" "}
        的「档位」字段（产线的地盘）； 台账要销账去改正本 §五 ——
        页面上没有任何一个按钮能改这两样。
      </div>
    </>
  );
}
