"use client";

/**
 * 逐题终审 · 交互层（AI:PRD-009 · 设计稿 §一 D-A）
 *
 * ── 从审核台 :7801 逐条搬过来、一条都不许丢的交互 ─────────────────────────────
 *  ① **一页照片一页题**：左边该页原图常驻（点开可放大），右边只列该页的题。
 *     页码集合来自 `SELECT DISTINCT items.page`，不是扫目录扫出来的。
 *  ② 行黄底 = `needs_human`；批次头「存疑 N 题：第 x、y 题」摘要。
 *  ③ 终审三按钮 √ / × / 去掉；**预判非 `?` 时自动预置**为预判值
 *     —— 人只需要动存疑题和要翻案的题。
 *  ④ **双层进度**：本页 done/total + 🔴「本页完但全卷没完」时给橙色警告并列出
 *     还差哪几题在第几页（2026-08-11 事故修的：19 题的第 1 页滚到底看见绿 ✅，
 *     第 2 页那 1 题在屏幕外，读起来就是「审完了」）。
 *  ⑤ 提交前先查缺题；打回前查理由非空；打回成功后刷新。
 *
 * ── 本产品加的三件（都是补它的缺，不改判定口径） ────────────────────────────
 *  ⓐ **二次确认 Modal**：点下去到底会发生什么、影响面多大，先摆出来
 *     （设计稿 §三·7 全站统一形态）；
 *  ⓑ **撤回打回**按钮：原语 `unrework` 一直有，审核台没接 —— 打回后改主意
 *     只能去敲命令行。内化要「不再需要打开 :7801」，就不能把人赶去开终端。
 *  ⓒ **CLI 原文上墙**：argv / exit code / stdout / stderr 一字不改地摊开，
 *     再加一份事后 mode=ro 复核（CLI 的成功输出是 emoji 人话，机读不了）。
 *
 * 🔴 本组件**不 import ~/core**（会把 node:sqlite 打进浏览器包）：全部走 API。
 * 🔴 错因码 → 中文只认正本 `_产线/err_kp.json`（随取数一起下发），前端不许硬写一份。
 */
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Image,
  Input,
  Modal,
  Row,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { EmptyHint, STATUS_COLOR, TimeText } from "~/components/console/ui";
import {
  REVIEW_STATUS_LABEL,
  REVIEW_STATUSES,
  VERDICTS,
  VERDICT_LABEL,
  reviewStatusUnknownHint,
  type ReviewBatchDetail,
  type ReviewBatchResponse,
  type ReviewItem,
  type ReviewKpDict,
  type ReviewStatus,
  type ReviewWriteResponse,
  type Verdict,
} from "../../../shared";

/** 数字列一律等宽数字（🔴 检查单 §三·3） */
const 数字: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

/**
 * 弹窗在手机上不许比屏幕宽（🔴 检查单 §三·5）：antd 的 `width` 是死值，
 * 640 的弹窗在 390px 的手机上会横向溢出，按钮被挤出屏幕外点不到。
 */
const 弹窗宽 = { maxWidth: "calc(100vw - 24px)" } as const;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function photoUrl(code: string, day: number, page: number): string {
  const q = new URLSearchParams({
    code,
    day: String(day),
    page: String(page),
  });
  return `/api/grading/review/photo?${q.toString()}`;
}

/**
 * 初始判定。
 * 🔴 优先取 `verdict_final`（库里已经有的终审值 —— 复审/已确认批次要显示真相），
 *    否则照审核台的规矩：预判不是 `?` 就预置成预判值。
 *    `?` 是「交人工」，它**不是**合法终审值，永远不预置。
 */
function 初值(it: ReviewItem): Verdict | undefined {
  const f = it.verdictFinal;
  if (f !== null && (VERDICTS as readonly string[]).includes(f)) {
    return f as Verdict;
  }
  const p = it.verdictPre;
  if (p !== null && (VERDICTS as readonly string[]).includes(p)) {
    return p as Verdict;
  }
  return undefined;
}

function 错因中文(codes: string[], kp: ReviewKpDict): string {
  if (codes.length === 0) return "不归因(非技能失分)";
  return codes.map((c) => kp.cn[c] ?? c).join("、");
}

// ---------------------------------------------------------------------------
// 终审三按钮
// ---------------------------------------------------------------------------

const 判定色: Record<Verdict, { bg: string; border: string }> = {
  "√": { bg: "#16a34a", border: "#16a34a" },
  "×": { bg: "#dc2626", border: "#dc2626" },
  skip: { bg: "#64748b", border: "#64748b" },
};

function VerdictPicker({
  value,
  disabled,
  onPick,
}: {
  value: Verdict | undefined;
  disabled: boolean;
  onPick: (v: Verdict) => void;
}) {
  return (
    <Space size={6}>
      {VERDICTS.map((v) => {
        const on = value === v;
        return (
          <Tooltip key={v} title={VERDICT_LABEL[v]}>
            <Button
              // 🔴 AI:PRD-009 打磨（检查单 §三·5 触控目标）：这三个按钮是全站**手指点得最多**
              //    的地方（一批 19 题就是 19 次），原来的 size="small"（高 24px）在手机上
              //    低于可点阈值，挨着点常点错行。中号 = 32px 高 + 最小 44px 宽。
              size="middle"
              disabled={disabled}
              onClick={() => onPick(v)}
              style={
                on
                  ? {
                      background: 判定色[v].bg,
                      borderColor: 判定色[v].border,
                      color: "#fff",
                      fontWeight: 700,
                      minWidth: v === "skip" ? 58 : 44,
                    }
                  : { minWidth: v === "skip" ? 58 : 44 }
              }
            >
              {v === "skip" ? "去掉" : v}
            </Button>
          </Tooltip>
        );
      })}
    </Space>
  );
}

// ---------------------------------------------------------------------------
// 主体
// ---------------------------------------------------------------------------

type 弹窗 = "confirm" | "rework" | "unrework" | null;

export function JudgeBoard({ code, day }: { code: string; day: number }) {
  const router = useRouter();
  const [detail, setDetail] = useState<ReviewBatchDetail | null>(null);
  const [kp, setKp] = useState<ReviewKpDict | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const [V, setV] = useState<Record<number, Verdict>>({});
  const [fb, setFb] = useState("");
  const [modal, setModal] = useState<弹窗>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ReviewWriteResponse | null>(null);

  const load = useCallback(
    async (keepVerdicts: boolean) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ code, day: String(day) });
        const res = await fetch(`/api/grading/review/batch?${q.toString()}`);
        const j = (await res.json()) as ReviewBatchResponse;
        setErr(j.ok ? undefined : j.error);
        setWarnings(j.warnings);
        setKp(j.kp);
        setDetail(j.data);
        if (j.data && !keepVerdicts) {
          const init: Record<number, Verdict> = {};
          for (const it of j.data.items) {
            const v = 初值(it);
            if (v) init[it.qno] = v;
          }
          setV(init);
        }
      } catch (e) {
        setErr(
          `请求没发出去（或没回来）：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        );
      } finally {
        setLoading(false);
      }
    },
    [code, day],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const items = useMemo(() => detail?.items ?? [], [detail]);
  const 未审 = useMemo(() => items.filter((it) => !V[it.qno]), [items, V]);
  const 分布 = useMemo(() => {
    const d: Record<Verdict, number> = { "√": 0, "×": 0, skip: 0 };
    for (const it of items) {
      const v = V[it.qno];
      if (v) d[v] += 1;
    }
    return d;
  }, [items, V]);
  /** 与程序预判不同的题（= 你这次翻的案；确认弹窗要把它摆出来） */
  const 翻案 = useMemo(
    () =>
      items
        .map((it) => ({ it, v: V[it.qno] }))
        .filter((x) => x.v !== undefined && x.v !== x.it.verdictPre),
    [items, V],
  );

  const 只读 = detail?.status === "confirmed";
  const 打回中 = detail?.status === "rework";

  async function 跑(
    kind: Exclude<弹窗, null>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    setBusy(true);
    setReceipt(null);
    try {
      const res = await fetch(`/api/grading/review/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ student: code, day, ...payload }),
      });
      const j = (await res.json()) as ReviewWriteResponse;
      setReceipt(j);
      setModal(null);
      setAck(false);
      if (j.ok) {
        if (kind === "rework") setFb("");
        // 🔴 确认后刷新：重新取一遍库，页面显示的就是**库里实际是什么**
        await load(true);
        // 看板/面包屑那些 server 渲染的东西也跟着刷（board 是 force-dynamic）
        router.refresh();
      }
    } catch (e) {
      setReceipt({
        ok: false,
        error: `请求没发出去（或没回来）：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
        argv: [],
        cwd: "",
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        after: null,
        notes: [],
      });
    } finally {
      setBusy(false);
    }
  }

  // ── 取数中 / 取不到 ────────────────────────────────────────────────────
  if (loading && !detail) {
    return (
      <Card size="small">
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    );
  }
  if (err) {
    return (
      <Alert
        type="error"
        showIcon
        message="批次取数没跑成（原文照登）"
        description={
          <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{err}</span>
        }
      />
    );
  }
  if (!detail) {
    return (
      <Card size="small">
        <EmptyHint>
          审核.db 里没有「{code} 第{day}天」这个批次 ——
          「没有批次」不是「没交卷」： 批次由产线的 ingest / 直批 建（batches 按
          UNIQUE(学员, 天) 唯一）。 先去{" "}
          <Link href="/grading/board">批改看板</Link> 看这一天到底走到哪一步了。
        </EmptyHint>
      </Card>
    );
  }

  return (
    <>
      {warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="读这一批时遇到的事（一条不吞）"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {warnings.map((w, i) => (
                <div key={i}>· {w}</div>
              ))}
            </div>
          }
        />
      ) : null}
      {kp && !kp.ok ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="错因考点词表读不出来 —— 下面的「错因考点」只印原始码"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {kp.error}
            </span>
          }
        />
      ) : null}

      <BatchHead detail={detail} refreshing={loading} />

      {打回中 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="这一批已打回 · 等 agent 重批"
          description={
            // 🔴 检查单 §三·9 文案：原来这里写的是 Markdown 的 `**不能直接确认**`，
            //    JSX 不认 Markdown，星号原样印在页面上。
            <span style={{ fontSize: 12.5 }}>
              打回中<b>不能直接确认</b>（审核库.py 的闸：不许绕过重批出件）。 等
              agent 重批完（重批会重新 ingest，轮次 +1），或者你改主意了 →
              点下面的「撤回打回」。
            </span>
          }
        />
      ) : null}
      {只读 ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <span>
              这一批已确认（
              <TimeText iso={detail.confirmedAt} /> · 放行来源：
              {detail.auto ?? "人工"}）
            </span>
          }
          description={
            <span style={{ fontSize: 12.5 }}>
              下面是<b>库里已经落定的终审值</b>，可以看、可以改判后再确认一次；
              再确认会覆盖 confirmed_at 与放行来源，已出件的报告不会跟着重出，
              所以弹窗里要你显式点头。
              {detail.exportedAt ? (
                <>
                  本批已于 <TimeText iso={detail.exportedAt} /> 出件。
                </>
              ) : null}
            </span>
          }
        />
      ) : null}

      <FeedbackHistory detail={detail} />

      {detail.itemCount === 0 ? (
        <Card size="small" style={{ marginTop: 10 }}>
          <EmptyHint>
            这一批一道题都没有（batches 有行、items 没行）——
            「没有题」不是「全对」：多半是批次建了但判定还没回来。
            终审无从审起，先看 <Link href="/grading/board">批改看板</Link>{" "}
            这一批走到哪一步了。
          </EmptyHint>
        </Card>
      ) : (
        detail.pages.map((pg) => (
          <PageBlock
            key={pg}
            code={code}
            day={day}
            page={pg}
            detail={detail}
            kp={kp}
            V={V}
            locked={打回中}
            onPick={(qno, v) => setV((s) => ({ ...s, [qno]: v }))}
          />
        ))
      )}

      {/* ── 打回理由 + 三个动作 ────────────────────────────────────────── */}
      <Card
        size="small"
        style={{ marginTop: 14 }}
        title={
          <span style={{ fontSize: 13 }}>
            改得不对？写清哪里不对，打回让 agent 重批（存进这一轮的记录）
          </span>
        }
      >
        <Input.TextArea
          value={fb}
          onChange={(e) => setFb(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 8 }}
          disabled={只读}
          placeholder="例：第 9 题错因只说「丢负号」太笼统，要写清是取倒数那一步丢的；第 17 题按订正后算"
        />
        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Button
            type="primary"
            disabled={busy || 打回中 || detail.itemCount === 0}
            onClick={() => {
              setAck(false);
              setModal("confirm");
            }}
          >
            {只读 ? "改判后再确认一次…" : "确认这批…"}
          </Button>
          <Button
            danger
            disabled={busy || 只读 || 打回中}
            onClick={() => setModal("rework")}
          >
            打回重批…
          </Button>
          {打回中 ? (
            <Button disabled={busy} onClick={() => setModal("unrework")}>
              撤回打回…
            </Button>
          ) : null}
          <span style={{ fontSize: 12, color: "#909399" }}>
            {未审.length > 0
              ? `🔴 还有 ${未审.length} 题没给终审判定：第 ${未审.map((it) => it.qno).join("、")} 题`
              : "全卷已给判定，可以确认保存"}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#909399" }}>
            🔴 确认 ≠ 出件：确认只把判定存进 审核.db；报告要等 agent
            写完英雄卡总结 + 错题诊断，再跑{" "}
            <code>
              python 审核库.py export {code} {day}
            </code>
          </span>
        </div>
      </Card>

      {receipt ? <Receipt r={receipt} /> : null}

      <ActionModal
        mode={modal}
        detail={detail}
        code={code}
        day={day}
        V={V}
        dist={分布}
        flips={翻案}
        unjudged={未审}
        fb={fb}
        ack={ack}
        setAck={setAck}
        busy={busy}
        onCancel={() => {
          setModal(null);
          setAck(false);
        }}
        onGo={跑}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 批次头
// ---------------------------------------------------------------------------

function BatchHead({
  detail,
  refreshing,
}: {
  detail: ReviewBatchDetail;
  /** 🔴 检查单 §三·1：写完/刷新时页面上要有「正在读库」的动静，不能静静地站着 */
  refreshing: boolean;
}) {
  const known = (REVIEW_STATUSES as readonly string[]).includes(detail.status);
  return (
    <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
      <Space size={10} wrap>
        <b style={{ fontSize: 15 }}>
          {detail.student} · 第 {detail.day} 次打卡
        </b>
        {known ? (
          <Tag color={STATUS_COLOR[detail.status as ReviewStatus]}>
            {REVIEW_STATUS_LABEL[detail.status as ReviewStatus]} ·{" "}
            {detail.itemCount} 题
          </Tag>
        ) : (
          <Tooltip title={reviewStatusUnknownHint(detail.status)}>
            <Tag>
              状态未知（{detail.status || "空"}）· {detail.itemCount} 题
            </Tag>
          </Tooltip>
        )}
        <Tag color="blue">第 {detail.round} 轮</Tag>
        {detail.doubtCount > 0 ? (
          <Tag color="gold">
            存疑 {detail.doubtCount} 题：第 {detail.doubtQnos.join("、")} 题
          </Tag>
        ) : (
          <Tag color="green">零存疑</Tag>
        )}
        <Tooltip title="审核.db batches.id">
          <span
            style={{
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 12,
              color: "#909399",
            }}
          >
            b{detail.batchId}
          </span>
        </Tooltip>
        <span style={{ fontSize: 12, color: "#909399" }}>
          入库 <TimeText iso={detail.createdAt} />
        </span>
        {refreshing ? (
          <Tag color="processing" icon={<LoadingOutlined />}>
            正在重读 审核.db（mode=ro）
          </Tag>
        ) : null}
        <Link href="/grading/review" style={{ fontSize: 12 }}>
          ← 回终审台
        </Link>
        <Link
          href={`/grading/board?code=${encodeURIComponent(detail.student)}`}
          style={{ fontSize: 12 }}
        >
          看这个学员的全部批次
        </Link>
        {/* 🔴 看到即可达：代号在这儿，学情页就得点得到 */}
        <Link
          href={`/student/${encodeURIComponent(detail.student)}`}
          style={{ fontSize: 12 }}
        >
          看这个学员的学情
        </Link>
        {detail.exportedAt ? (
          <Link
            href={`/grading/reports?code=${encodeURIComponent(detail.student)}`}
            style={{ fontSize: 12 }}
          >
            去报告架取件
          </Link>
        ) : null}
      </Space>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 反馈历史
// ---------------------------------------------------------------------------

function FeedbackHistory({ detail }: { detail: ReviewBatchDetail }) {
  if (detail.feedback.length === 0) return null;
  return (
    <Card
      size="small"
      style={{ marginTop: 10 }}
      title={<span style={{ fontSize: 13 }}>打回反馈历史（新的在上）</span>}
      styles={{ body: { padding: "8px 14px" } }}
    >
      {detail.feedback.map((f, i) => (
        <div
          key={i}
          style={{
            borderLeft: "3px solid #e0a45c",
            background: "#fdf6ea",
            padding: "8px 12px",
            margin: "6px 0",
            fontSize: 12.5,
            lineHeight: 1.8,
          }}
        >
          {/* 🔴 检查单 §三·3 时间统一：这三处原来直接印库里的整串 ISO，
              与全站 `MM-DD HH:mm`（悬停看全量）两套写法。一律走 TimeText。 */}
          <Space size={8} wrap>
            <b>第 {f.round ?? "?"} 轮反馈</b>
            <span style={{ color: "#909399" }}>
              <TimeText iso={f.createdAt} />
            </span>
            {f.resolvedAt ? (
              <Tag color="green">
                agent 已重批（
                <TimeText iso={f.resolvedAt} />）
              </Tag>
            ) : (
              <Tag color="orange">待重批</Tag>
            )}
          </Space>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{f.body}</div>
        </div>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 一页照片一页题
// ---------------------------------------------------------------------------

function PageBlock({
  code,
  day,
  page,
  detail,
  kp,
  V,
  locked,
  onPick,
}: {
  code: string;
  day: number;
  page: number;
  detail: ReviewBatchDetail;
  kp: ReviewKpDict | null;
  V: Record<number, Verdict>;
  /** 打回中 = 判定不许再动（审核库.py 的闸：不许绕过重批直接确认） */
  locked: boolean;
  onPick: (qno: number, v: Verdict) => void;
}) {
  const items = detail.items.filter((it) => it.page === page);
  const photo = detail.photos.find((p) => p.page === page);
  const done = items.filter((it) => V[it.qno]).length;
  const 全卷未审 = detail.items.filter((it) => !V[it.qno]);
  const 未审页 = [...new Set(全卷未审.map((it) => it.page))].sort(
    (a, b) => a - b,
  );

  const columns: TableColumnsType<ReviewItem> = [
    {
      title: "题",
      dataIndex: "qno",
      width: 62,
      fixed: "left",
      render: (_, it) => <b style={{ whiteSpace: "nowrap" }}>第{it.qno}题</b>,
    },
    {
      title: "题目（原卷）",
      dataIndex: "qtext",
      width: 210,
      render: (_, it) => (
        <div
          style={{
            fontFamily: "Consolas, Menlo, monospace",
            fontSize: 12.5,
            background: "#f3f8f4",
            borderRadius: 4,
            padding: "4px 6px",
            wordBreak: "break-all",
            lineHeight: 1.5,
          }}
        >
          {it.qtext ?? (
            <span style={{ color: "#909399" }}>题面没落库（题单里就没有）</span>
          )}
        </div>
      ),
    },
    {
      title: "预判",
      dataIndex: "verdictPre",
      width: 62,
      align: "center",
      render: (_, it) => (
        <Tooltip
          title={
            it.verdictPre === "?"
              ? "程序判不了 / 转录标了存疑 → 交人工。🔴 `?` 不是终审值"
              : `agent 预判 ${it.verdictPre ?? "（空）"}${
                  it.confidence === null ? "" : `（置信度 ${it.confidence}）`
                }`
          }
        >
          <span style={{ fontSize: 16 }}>{it.verdictPre ?? "—"}</span>
        </Tooltip>
      ),
    },
    {
      title: "标准答案 / 学生末答",
      dataIndex: "refAns",
      width: 170,
      render: (_, it) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <b
            style={{
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 14,
              color: "#0f766e",
            }}
          >
            {it.refAns ?? "—"}
          </b>
          <div style={{ color: "#606266" }}>
            学生：
            {it.answerRaw ?? <span style={{ color: "#909399" }}>没读出来</span>}
          </div>
          {it.needsHuman ? (
            <Tag color="gold" style={{ marginTop: 2 }}>
              🔶 需人工
            </Tag>
          ) : null}
        </div>
      ),
    },
    {
      title: "诊断",
      dataIndex: "note",
      render: (_, it) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "#b45309" }}>
          <span style={{ whiteSpace: "pre-wrap" }}>{it.note ?? ""}</span>
          {it.lines.length > 0 ? (
            <div
              style={{
                fontFamily: "Consolas, Menlo, monospace",
                color: "#3a4453",
                marginTop: 4,
              }}
            >
              {it.lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          ) : null}
          {it.errorKp === null ? null : (
            <div style={{ color: "#1a2b22", marginTop: 4 }}>
              <b>
                错因考点：
                {错因中文(
                  it.errorKp,
                  kp ?? { ok: false, version: null, path: "", cn: {} },
                )}
              </b>
            </div>
          )}
        </div>
      ),
    },
    {
      title: "终审",
      key: "verdict",
      width: 196,
      fixed: "right",
      render: (_, it) => (
        <VerdictPicker
          value={V[it.qno]}
          disabled={locked}
          onPick={(v) => onPick(it.qno, v)}
        />
      ),
    },
  ];

  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      styles={{ body: { padding: 12 } }}
    >
      <Row gutter={[16, 12]}>
        {/* 🔴 响应式：宽屏左右分栏（照片 sticky 常驻），窄屏（手机）自动上下堆叠 */}
        <Col xs={24} lg={9}>
          <div style={{ position: "sticky", top: 12 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "#409eff",
                marginBottom: 6,
              }}
            >
              第 {page} 页原图（点击放大）
            </div>
            {photo?.exists ? (
              <Image
                src={photoUrl(code, day, page)}
                alt={`${code} 第${day}次打卡 第${page}页原卷`}
                style={{
                  width: "100%",
                  border: "1px solid #dde7df",
                  borderRadius: 6,
                }}
              />
            ) : (
              <Alert
                type="error"
                showIcon
                message={`第 ${page} 页原图不在盘上`}
                description={
                  <span style={{ fontSize: 12, wordBreak: "break-all" }}>
                    找的是 {photo?.path ?? "（路径没算出来）"} ——
                    库里有这一页的题、照片却没有，对着原卷核判定这一步就断了。
                  </span>
                }
              />
            )}
          </div>
        </Col>
        <Col xs={24} lg={15}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#409eff",
              marginBottom: 6,
            }}
          >
            第 {items[0]?.qno ?? "?"}-{items[items.length - 1]?.qno ?? "?"} 题
          </div>
          <Table<ReviewItem>
            rowKey="qno"
            size="small"
            columns={columns}
            dataSource={items}
            pagination={false}
            scroll={{ x: 800 }}
            onRow={(it) => ({
              style: it.needsHuman ? { background: "#fff8ec" } : undefined,
            })}
          />
          {/* ④ 双层进度（2026-08-11 事故修的那条，一个字不许省） */}
          <div
            style={{
              marginTop: 8,
              fontSize: 12.5,
              fontWeight: done === items.length ? 700 : 400,
              color:
                全卷未审.length === 0
                  ? "#16a34a"
                  : done === items.length
                    ? "#d97706"
                    : "#909399",
            }}
          >
            本页终审 {done} / {items.length}
            {done === items.length ? " ✅" : ""}
            {done === items.length && 全卷未审.length > 0
              ? ` · 🔻 全卷还差 ${全卷未审.length} 题未审：第 ${全卷未审
                  .map((it) => it.qno)
                  .join("、")} 题（在第 ${未审页.join("、")} 页，继续往下滚）`
              : null}
            {全卷未审.length === 0 ? " · 全卷已审完，可以确认保存" : null}
          </div>
        </Col>
      </Row>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 二次确认 Modal（全站统一形态：列明影响面）
// ---------------------------------------------------------------------------

function ActionModal(props: {
  mode: 弹窗;
  detail: ReviewBatchDetail;
  code: string;
  day: number;
  V: Record<number, Verdict>;
  /** 三态各多少题 */
  dist: Record<Verdict, number>;
  /** 与 agent 预判不同的题（= 这次翻的案） */
  flips: { it: ReviewItem; v: Verdict | undefined }[];
  /** 还没给终审值的题 */
  unjudged: ReviewItem[];
  fb: string;
  ack: boolean;
  setAck: (v: boolean) => void;
  busy: boolean;
  onCancel: () => void;
  onGo: (
    kind: Exclude<弹窗, null>,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const {
    mode,
    detail,
    code,
    day,
    V,
    dist: 分布,
    flips: 翻案,
    unjudged: 未审,
    fb,
    ack,
    busy,
  } = props;
  if (mode === null) return null;

  const 已确认 = detail.status === "confirmed";
  const 分母 = detail.itemCount - 分布.skip;

  if (mode === "confirm") {
    const 缺题 = 未审.length > 0;
    const 要点头 = 已确认 && !ack;
    return (
      <Modal
        open
        title="确认这批终审判定？"
        okText={已确认 ? "覆盖上一次的确认，落库" : "确认，落库"}
        cancelText="再看看"
        confirmLoading={busy}
        okButtonProps={{ disabled: 缺题 || 要点头 }}
        onCancel={props.onCancel}
        onOk={() =>
          // 🔴 V 的键是题号（数字），JSON.stringify 会照 {"7":"√"} 序列化 ——
          //    正是 审核库.py confirm_from 吃的 `verdicts` 形状。
          void props.onGo("confirm", {
            verdicts: V,
            ...(已确认 ? { allowReconfirm: true } : {}),
          })
        }
        width={640}
        style={弹窗宽}
      >
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <p style={{ marginBottom: 8 }}>
            <b>影响面</b>：{code} 第 {day} 次打卡（批次 b{detail.batchId} · 第{" "}
            {detail.round} 轮）共 {detail.itemCount} 题 —— √ {分布["√"]} 题、×{" "}
            {分布["×"]} 题、去掉 {分布.skip} 题。 得分口径按题数算，
            <b>分母摘掉「去掉」= {分母}</b>。
          </p>
          {缺题 ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 8 }}
              message={`还有 ${未审.length} 题没给判定：第 ${未审.map((it) => it.qno).join("、")} 题`}
              description="审核库.py 的全题闸要求每道题都过一遍人眼，缺一道整批拒绝。"
            />
          ) : null}
          {翻案.length > 0 ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message={`这次翻了 ${翻案.length} 道案（与 agent 预判不同）`}
              description={
                <div style={{ fontSize: 12.5 }}>
                  {翻案.map((x) => (
                    <div key={x.it.qno}>
                      第 {x.it.qno} 题：预判 {x.it.verdictPre ?? "（空）"} →{" "}
                      <b>{x.v}</b>
                      {x.it.needsHuman ? "（本来就标了需人工）" : ""}
                    </div>
                  ))}
                </div>
              }
            />
          ) : null}
          <p style={{ marginBottom: 8 }}>
            <b>会发生什么</b>：<code>batches.status</code> → confirmed、
            <code>confirmed_at</code> 记为现在、
            <code>batches.auto</code> 落 <b>NULL = 人工确认</b>
            （管理台永远不冒充 L1/L2 静默）、逐题写 <code>verdict_final</code>。
          </p>
          <p style={{ marginBottom: 8 }}>
            🔴 <b>确认 ≠ 出件</b>：这一步不产任何对外件。报告要等 agent
            写完英雄卡总结 + 错题诊断，再跑{" "}
            <code>
              python 审核库.py export {code} {day}
            </code>
            。
          </p>
          <p style={{ marginBottom: 8, color: "#606266" }}>
            <b>怎么写进去</b>：把判定写成一份临时 JSON，然后在{" "}
            <code>订阅特训/_产线</code> 里跑
            <br />
            <code>
              python 审核库.py confirm {code} {day} --from &lt;临时JSON&gt;
            </code>
            <br />
            —— 本产品对 审核.db 没有写句柄，落库的每个字节都由圣域自己的
            审核库.py 写。
          </p>
          {已确认 ? (
            <Checkbox
              checked={ack}
              onChange={(e) => props.setAck(e.target.checked)}
            >
              我知道这会<b>覆盖</b>上一次的确认记录（
              <TimeText iso={detail.confirmedAt} /> · 放行来源{" "}
              {detail.auto ?? "人工"}）
              {detail.exportedAt ? "，且已出件的报告不会跟着重出" : ""}
            </Checkbox>
          ) : null}
        </div>
      </Modal>
    );
  }

  if (mode === "rework") {
    const 空 = fb.trim() === "";
    return (
      <Modal
        open
        title="打回这一批，让 agent 重批？"
        okText="打回"
        cancelText="再看看"
        okButtonProps={{ danger: true, disabled: 空 }}
        confirmLoading={busy}
        onCancel={props.onCancel}
        onOk={() => void props.onGo("rework", { body: fb.trim() })}
        width={620}
        style={弹窗宽}
      >
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          {空 ? (
            <Alert
              type="error"
              showIcon
              message="打回必须写清哪里不对"
              description="空反馈等于没说，agent 不知道要改什么（审核库.py 的第一道 assert 就是这条）。"
            />
          ) : (
            <>
              <p style={{ marginBottom: 6 }}>
                <b>要写进 feedback 的原文</b>（记在第 {detail.round} 轮名下）：
              </p>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  background: "#fdf6ea",
                  border: "1px solid #f0c98a",
                  borderRadius: 4,
                  padding: "8px 10px",
                  marginBottom: 10,
                }}
              >
                {fb.trim()}
              </div>
            </>
          )}
          <p style={{ marginBottom: 6 }}>
            <b>会发生什么</b>：<code>feedback</code> 插一行（round=
            {detail.round}）、
            <code>batches.status</code> → rework。
            <br />
            🔴 <b>轮次现在不变</b>：round 要等 agent 重批（ingest / 直批
            看到上一状态是 rework）时才 +1。
            <br />
            🔴 打回期间<b>不能确认</b>；改主意了可以在本页「撤回打回」。
          </p>
          <p style={{ marginBottom: 0, color: "#606266" }}>
            <b>怎么写进去</b>：<code>订阅特训/_产线</code> 里跑
            <br />
            <code>
              python 审核库.py rework {code} {day} &lt;你写的那段话&gt;
            </code>
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title="撤回打回，回到待审？"
      okText="撤回打回"
      cancelText="再看看"
      confirmLoading={busy}
      onCancel={props.onCancel}
      onOk={() => void props.onGo("unrework", {})}
      width={600}
      style={弹窗宽}
    >
      <div style={{ fontSize: 13, lineHeight: 1.9 }}>
        <p style={{ marginBottom: 6 }}>
          <b>会发生什么</b>：<code>batches.status</code> rework → pending； 本批{" "}
          {detail.openFeedbackCount}{" "}
          条未处理反馈被标成已处理（resolved_at=现在）。
          <br />
          反馈正文<b>留档不删</b>，历史仍看得见；轮次不变。
        </p>
        <p style={{ marginBottom: 6 }}>
          用在这种时候：打回之后你自己又想通了，不必让 agent 空跑一轮重批。
        </p>
        <p style={{ marginBottom: 0, color: "#606266" }}>
          <b>怎么写进去</b>：<code>订阅特训/_产线</code> 里跑
          <br />
          <code>
            python 审核库.py unrework {code} {day}
          </code>
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 回执：CLI 原文 + 事后 ro 复核
// ---------------------------------------------------------------------------

function Receipt({ r }: { r: ReviewWriteResponse }) {
  return (
    <Card
      size="small"
      style={{ marginTop: 12 }}
      title={
        <span style={{ fontSize: 13 }}>
          {r.ok ? "🟢 圣域收下了" : "🔴 没跑成"} · 审核库.py 原文回执
        </span>
      }
    >
      {r.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message="失败原因（原文照登）"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {r.error}
            </span>
          }
        />
      ) : null}

      {r.argv.length > 0 ? (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <div style={{ color: "#909399" }}>
            真正跑的命令（cwd={r.cwd}）—— 可以自己复制去命令行重跑：
          </div>
          <Typography.Text
            code
            copyable={{ text: r.argv.join(" "), tooltips: ["复制", "已复制"] }}
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            {r.argv.join(" ")}
          </Typography.Text>
          <div style={{ color: "#909399", marginTop: 2 }}>
            退出码 {String(r.exitCode)}
            {r.timedOut ? "（超时被杀）" : ""}
          </div>
        </div>
      ) : null}

      {r.stdout.trim() ? <pre style={输出样式}>{r.stdout.trim()}</pre> : null}
      {r.stderr.trim() ? (
        <pre style={{ ...输出样式, color: "#dc2626" }}>{r.stderr.trim()}</pre>
      ) : null}

      {r.after ? (
        <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.9 }}>
          <b>事后复核（跑完再用 mode=ro 读一遍库，这才是库里实际的样子）</b>：
          status=<b>{r.after.status}</b> · 第 {r.after.round} 轮 · 放行来源{" "}
          {r.after.auto ?? "人工"} · 确认时间{" "}
          {r.after.confirmedAt ? <TimeText iso={r.after.confirmedAt} /> : "—"} ·
          出件时间{" "}
          {r.after.exportedAt ? <TimeText iso={r.after.exportedAt} /> : "—"} ·
          已终审{" "}
          <span style={数字}>
            {r.after.judgedCount}/{r.after.itemCount}
          </span>{" "}
          题 · 反馈 {r.after.feedbackCount} 条（{r.after.openFeedbackCount}{" "}
          条待重批）
        </div>
      ) : null}

      {r.notes.length > 0 ? (
        <div style={{ fontSize: 12, marginTop: 6, color: "#606266" }}>
          {r.notes.map((n, i) => (
            <div key={i} style={{ wordBreak: "break-all" }}>
              · {n}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

const 输出样式: React.CSSProperties = {
  fontFamily: "Consolas, Menlo, monospace",
  fontSize: 12,
  background: "#f5f7fa",
  border: "1px solid #e4e7ed",
  borderRadius: 4,
  padding: "8px 10px",
  margin: "6px 0 0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 260,
  overflow: "auto",
};

export default JudgeBoard;
