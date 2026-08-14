"use client";

/**
 * 批改看板 · 三段式列表（AI:PRD-008 · 设计稿 §二 批改流水线组第 2 页）
 *
 * 搜索区（学员 / 状态 / 日期）→ 工具栏 → 表格 + 分页，与 /question 同一套骨架。
 *
 * 🔴 本页**没有一个写按钮**：终审要点的地方是审核台（:7801，PRD-027 自己的进程），
 *    这里只给直链。看板改不了任何判定，这是产线执行权的边界。
 * 🔴 状态色不新调：一律映射到 console/ui 的 STATUS_COLOR 那张表（设计稿 §三 五档）。
 * 🔴 「放大预算」列现在**算不出**：审核.db items 没有 zooms 列（PRD-027 包① 遗留 L2），
 *    页面照实说「算不出」，绝不拿别的数凑一个看起来像的。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmptyHint, STATUS_COLOR, TimeText } from "~/components/console/ui";
import {
  BOARD_STATES,
  REVIEW_CONSOLE_URL,
  type BoardMeta,
  type BoardResponse,
  type BoardRow,
  type BoardState,
} from "../shared";

/** 状态 → 设计稿 §三 的五档色（认不出的一律灰，不猜） */
const STATE_TONE: Record<BoardState, string> = {
  收件中: STATUS_COLOR.draft!,
  待认卷: STATUS_COLOR.pending!,
  批改中: STATUS_COLOR.draft!,
  待审核: STATUS_COLOR.pending!,
  已放行: STATUS_COLOR.active!,
  已出件: STATUS_COLOR.active!,
  状态未知: STATUS_COLOR.retired!,
};

interface QueryForm {
  code?: string;
  state?: BoardState;
  day?: string[];
}

export interface BoardTableProps {
  codes: string[];
  defaultCode?: string;
}

function MetaBar({ meta, error }: { meta: BoardMeta | null; error?: string }) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="看板取数没跑成（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;
  const notes: string[] = [
    `挂桥覆盖 ${meta.bridgeMatched}/${meta.bridgeTotal}（${meta.bridgeCoverage}）——挂不上桥的批次分数照给，但算不到考点上，原因在「卷」那一列如实写着`,
    meta.queueExists
      ? `收件段读自 ${meta.queuePath}`
      : `收件事件流还没有：${meta.queuePath} 不存在（还没从本台提交过收卷，不是故障）`,
    "「待认卷」这一态属编排台账（grading-pipeline，PRD-027 包② 未建）——现在推不出来，宁可缺一态也不拿别处的数冒充",
  ];
  if (!meta.zoomColumn) {
    notes.push(
      "审核.db items 没有 zooms 列 ⇒「放大预算」整列算不出（PRD-027 包① 遗留 L2：L1 的 zooms 靠 agent 自报 + 事后核数，没落库）",
    );
  }
  return (
    <Alert
      type={meta.bridgeMatched < meta.bridgeTotal ? "warning" : "info"}
      showIcon={meta.bridgeMatched < meta.bridgeTotal}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          圣域（只读）：{meta.gradingDbPath ?? "路径未知"}
        </span>
      }
      description={
        <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          {notes.map((n, i) => (
            <div key={`n${i}`}>· {n}</div>
          ))}
          {meta.warnings.map((w, i) => (
            <div key={`w${i}`}>⚠ {w}</div>
          ))}
        </div>
      }
    />
  );
}

export function BoardTable(props: BoardTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<BoardMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const columns: ProColumns<BoardRow, "text">[] = [
    {
      title: "学员",
      dataIndex: "code",
      width: 130,
      valueType: "select",
      fieldProps: {
        placeholder: "不选=全部",
        allowClear: true,
        showSearch: true,
        options: props.codes.map((c) => ({ value: c, label: c })),
      },
      render: (_, r) => (
        <Space size={4}>
          <b>{r.student ?? "—"}</b>
          <Tag color={r.seg === "收件" ? "default" : "blue"}>{r.seg}</Tag>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 108,
      valueType: "select",
      fieldProps: {
        placeholder: "不选=全部",
        allowClear: true,
        options: BOARD_STATES.map((s) => ({ value: s, label: s })),
      },
      render: (_, r) => (
        <Tooltip title={r.stateNote ?? undefined}>
          <Tag color={STATE_TONE[r.state]}>{r.state}</Tag>
        </Tooltip>
      ),
    },
    {
      title: "日期",
      dataIndex: "dateRange",
      key: "dateRange",
      valueType: "dateRange",
      hideInTable: true,
      fieldProps: { placeholder: ["起", "止"] },
      search: {
        transform: (v) => {
          const arr = Array.isArray(v) ? (v as string[]) : [];
          return { from: arr[0] ?? "", to: arr[1] ?? "" };
        },
      },
    },
    {
      title: "时间",
      dataIndex: "ts",
      search: false,
      width: 106,
      tooltip: "收件段=提交时刻；批改段=审核.db batches.created_at",
      render: (_, r) => <TimeText iso={r.ts} />,
    },
    {
      title: "打卡次",
      dataIndex: "day",
      key: "punchDay",
      search: false,
      width: 76,
      tooltip:
        "该学员自己的第几次打卡（审核.db batches.day）—— 🔴 与「线的第几天」不是一回事",
      render: (_, r) =>
        r.day === null ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : (
          <span>第 {r.day} 次</span>
        ),
    },
    {
      title: "卷",
      dataIndex: "paper",
      search: false,
      width: 230,
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          {r.paper ?? <span style={{ color: "#909399" }}>没挂上桥</span>}
          {r.paperNote ? (
            <div
              style={{ color: "#909399", marginTop: 2, whiteSpace: "pre-wrap" }}
            >
              {r.paperNote}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "档位",
      dataIndex: "auto",
      search: false,
      width: 96,
      tooltip:
        "放行来源留痕（batches.auto）：'L1静默'=判据全绿自动放的 / 'L2代审'=复核 subagent / 空=人工点的",
      render: (_, r) =>
        r.seg === "收件" ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : r.auto ? (
          <Tag color="blue">{r.auto}</Tag>
        ) : (
          <Tag>人工</Tag>
        ),
    },
    {
      title: "存疑数",
      dataIndex: "doubt",
      search: false,
      width: 92,
      tooltip:
        "verdict_pre ∈ {?, doubt, missing} 或 needs_human=1 的题次 —— 零存疑是静默放行判据的第一条",
      render: (_, r) =>
        r.doubt === null ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : r.doubt > 0 ? (
          <Tag color="orange">{r.doubt} 题</Tag>
        ) : (
          <Tag color="green">0</Tag>
        ),
    },
    {
      title: "得分 / 题数",
      dataIndex: "score",
      search: false,
      width: 124,
      tooltip:
        "题数口径：分母已摘掉 skip（漏抄整条不进分子也不进分母，如 16/19 而不是 16/20）",
      render: (_, r) => r.score ?? <span style={{ color: "#909399" }}>—</span>,
    },
    {
      title: "放大预算",
      dataIndex: "zoom",
      search: false,
      width: 110,
      render: () => (
        <Tooltip title="审核.db items 没有 zooms 列（PRD-027 包① 遗留 L2）：L1 的放大次数靠 agent 自报 + 直批时事后核数，没有落库 ⇒ 这一列现在算不出，不编。">
          <span style={{ color: "#909399" }}>算不出</span>
        </Tooltip>
      ),
    },
    {
      title: "批次",
      dataIndex: "batchId",
      search: false,
      width: 96,
      render: (_, r) =>
        r.batchId === null ? (
          <span style={{ color: "#909399" }}>未建</span>
        ) : (
          <Tooltip
            title={`审核.db batches.id=${r.batchId}${r.round === null ? "" : ` · 第 ${r.round} 轮`}${
              r.reworks > 0 ? ` · 被打回 ${r.reworks} 次（feedback）` : ""
            }`}
          >
            <span style={{ fontFamily: "Consolas, Menlo, monospace" }}>
              b{r.batchId}
              {r.reworks > 0 ? <Tag color="orange">打回{r.reworks}</Tag> : null}
            </span>
          </Tooltip>
        ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 150,
      fixed: "right",
      render: (_, r) => [
        <a
          key="review"
          href={REVIEW_CONSOLE_URL}
          target="_blank"
          rel="noreferrer"
          title="审核台是 PRD-027 自己的进程（:7801）——没起就打不开，那不是本页的故障"
        >
          去审核台
        </a>,
        r.exportedAt && r.student ? (
          <Link
            key="report"
            href={`/grading/reports?code=${encodeURIComponent(r.student)}`}
          >
            看报告
          </Link>
        ) : null,
      ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<BoardRow, QueryForm>
        actionRef={actionRef}
        rowKey="key"
        size="small"
        cardBordered
        columns={columns}
        scroll={{ x: 1360 }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{
          initialValues: props.defaultCode ? { code: props.defaultCode } : {},
        }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            批次流水
            <span
              style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
            >
              收件段来自事件流，批改段以 审核.db 为准 —— 两段各是各的行
            </span>
          </span>
        }
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
        }}
        locale={{
          emptyText: (
            <EmptyHint>
              没有符合条件的批次 ——
              「没有数据」不是「没有批改」：收件段要有人从本台提交过才有行，
              批改段只认 审核.db 里真实存在的批次。
            </EmptyHint>
          ),
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          const p = params as QueryForm & { from?: string; to?: string };
          if (p.code) q.set("code", p.code);
          if (p.state) q.set("state", p.state);
          if (p.from) q.set("from", p.from);
          if (p.to) q.set("to", p.to);
          const res = await fetch(`/api/grading/board?${q.toString()}`);
          const j = (await res.json()) as BoardResponse;
          setMeta(j.meta);
          setErr(j.ok ? undefined : j.error);
          return { data: j.data, total: j.total, success: true };
        }}
      />
    </>
  );
}

export default BoardTable;
