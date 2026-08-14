"use client";

/**
 * 终审台 · 待审队列表 + 页尾「近期已确认」（AI:PRD-009 · 设计稿 §二）
 *
 * 对照审核台 :7801 的首屏，这一层要复刻的四件事（一件都不许丢）：
 *   ① 「存疑 N 题：第 x、y 题」批次头摘要 —— 这批到底要你看哪几道，一眼就知道；
 *   ② 打回轮次 / 「已打回 · 待重批」状态；
 *   ③ 反馈历史有没有被 agent 处理（resolved_at）；
 *   ④ 页尾「近期已确认」只读小节 + **放行来源**（人工 / L1静默 / L2静默 / L2代审）。
 *
 * 🔴 本组件**不 import ~/core**（client 顺着它 import 会把 node:sqlite 打进浏览器包），
 *    数据全部走 `/api/grading/review`。
 * 🔴 本页零写。写在逐题终审页，且全部 spawn 圣域的 审核库.py。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Progress, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmptyHint, STATUS_COLOR, TimeText } from "~/components/console/ui";
import {
  REVIEW_CONFIRMED_LIMIT,
  REVIEW_CONSOLE_URL,
  REVIEW_STATUS_LABEL,
  REVIEW_STATUSES,
  reviewStatusUnknownHint,
  type ReviewBatchBrief,
  type ReviewConfirmedRow,
  type ReviewListResponse,
  type ReviewStatus,
} from "../shared";

/** 数字列一律等宽数字（🔴 检查单 §三·3：竖着比大小的数，字宽不一样就比不了） */
const 数字: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** 终审页地址（代号可能是中文，必须 encode） */
export function reviewHref(student: string, day: number): string {
  return `/grading/review/${encodeURIComponent(student)}/${day}`;
}

/** 学情页地址（🔴 检查单 §三·4 看到即可达：表上出现的代号必须点得进去） */
export function studentHref(student: string): string {
  return `/student/${encodeURIComponent(student)}`;
}

function StatusTagOf({ status }: { status: string }) {
  if ((REVIEW_STATUSES as readonly string[]).includes(status)) {
    const s = status as ReviewStatus;
    return <Tag color={STATUS_COLOR[s]}>{REVIEW_STATUS_LABEL[s]}</Tag>;
  }
  return (
    <Tooltip title={reviewStatusUnknownHint(status)}>
      <Tag>状态未知</Tag>
    </Tooltip>
  );
}

export function ReviewQueueTable() {
  const actionRef = useRef<ActionType>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ReviewConfirmedRow[]>([]);

  const columns: ProColumns<ReviewBatchBrief>[] = [
    {
      title: "学员 · 打卡次",
      dataIndex: "student",
      width: 190,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link href={reviewHref(r.student, r.day)}>
            <b>{r.student}</b>
          </Link>
          <Tooltip title="该学员自己的第几次打卡（batches.day）—— 🔴 与「线的第几天」不是一回事">
            <span style={{ color: "#606266", ...数字 }}>第 {r.day} 次</span>
          </Tooltip>
          {/* 🔴 看到即可达：代号在这儿出现了，就得点得进他的学情页 */}
          <Tooltip
            title={`看 ${r.student} 的学情（批次 / 考点掌握 / 诊断三态）`}
          >
            <Link
              href={studentHref(r.student)}
              style={{ fontSize: 11.5, color: "#909399" }}
            >
              学情
            </Link>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 132,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <StatusTagOf status={r.status} />
          <span style={{ fontSize: 11.5, color: "#909399", ...数字 }}>
            第 {r.round} 轮
          </span>
        </Space>
      ),
    },
    {
      title: "存疑",
      dataIndex: "doubtCount",
      width: 190,
      tooltip:
        "verdict_pre ∈ {?, doubt, missing} 或 needs_human=1 —— 这批到底要你看哪几道",
      render: (_, r) =>
        r.doubtCount === 0 ? (
          <Tag color="green">0（程序全判得下来）</Tag>
        ) : (
          <Tooltip title={`第 ${r.doubtQnos.join("、")} 题`}>
            <Tag color="orange">
              存疑 {r.doubtCount} 题：第 {r.doubtQnos.slice(0, 6).join("、")}
              {r.doubtQnos.length > 6 ? "…" : ""} 题
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: "终审进度",
      dataIndex: "judgedCount",
      width: 150,
      tooltip:
        "已落 verdict_final 的题数 / 本批题数。🔴 未终审 ≠ 未看：全题闸要求每道题都有终审值，缺一道整批拒绝",
      render: (_, r) =>
        r.itemCount === 0 ? (
          <Tooltip title="批次建了、items 一行都没落 —— 判定还没回来，终审无从审起">
            <Tag color="red">一道题都没有</Tag>
          </Tooltip>
        ) : (
          <Space direction="vertical" size={0} style={{ width: 118 }}>
            <Progress
              percent={Math.round((r.judgedCount / r.itemCount) * 100)}
              size="small"
              status={r.judgedCount === r.itemCount ? "success" : "active"}
            />
            <span style={{ fontSize: 11.5, color: "#909399", ...数字 }}>
              {r.judgedCount} / {r.itemCount} 题 · {r.pages.length} 页
            </span>
          </Space>
        ),
    },
    {
      title: "反馈",
      dataIndex: "feedbackCount",
      width: 132,
      tooltip:
        "打回时写的「哪里不对」；未处理 = agent 还没重批（resolved_at 为空）",
      render: (_, r) =>
        r.feedbackCount === 0 ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : (
          <Space size={4} wrap>
            <Tag>{r.feedbackCount} 条</Tag>
            {r.openFeedbackCount > 0 ? (
              <Tag color="orange">{r.openFeedbackCount} 条待重批</Tag>
            ) : (
              <Tag color="green">已重批</Tag>
            )}
          </Space>
        ),
    },
    {
      title: "入库时间",
      dataIndex: "createdAt",
      width: 108,
      tooltip: "batches.created_at —— 这一轮预批落库的时刻（重批会改写它）",
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "批次",
      dataIndex: "batchId",
      width: 78,
      render: (_, r) => (
        <Tooltip title={`审核.db batches.id=${r.batchId}`}>
          <span style={{ fontFamily: "Consolas, Menlo, monospace" }}>
            b{r.batchId}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 96,
      fixed: "right",
      render: (_, r) => [
        <Link key="go" href={reviewHref(r.student, r.day)}>
          去终审
        </Link>,
      ],
    },
  ];

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="待审队列取数没跑成（原文照登）"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {err}
            </span>
          }
        />
      ) : null}
      {warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="读队列时遇到的事（一条不吞）"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {warnings.map((w, i) => (
                <div key={i}>· {w}</div>
              ))}
            </div>
          }
        />
      ) : null}

      <ProTable<ReviewBatchBrief>
        actionRef={actionRef}
        rowKey="key"
        size="small"
        cardBordered
        columns={columns}
        scroll={{ x: 1140 }}
        search={false}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            等你终审的批次
            <span
              style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
            >
              圣域（只读）：{dbPath ?? "（还没取数）"}
            </span>
          </span>
        }
        pagination={false}
        locale={{
          emptyText: (
            <EmptyHint>
              没有待审核的批次 ✅ —— 「没有待审」不是「没有批改」：L1/L2
              静默放行的批次直接落 confirmed，
              从来不在这张表出现（谁放的看页尾「近期已确认」的放行来源）。
              下一步：要看全部批次（含已确认/已出件）去
              <Link href="/grading/board"> 批改看板 </Link>； 要收新卷去{" "}
              <Link href="/grading/intake">收卷录入</Link>。
            </EmptyHint>
          ),
        }}
        request={async () => {
          const res = await fetch("/api/grading/review");
          const j = (await res.json()) as ReviewListResponse;
          setErr(j.ok ? undefined : j.error);
          setWarnings(j.warnings);
          setDbPath(j.gradingDbPath);
          setConfirmed(j.confirmed);
          return { data: j.data, total: j.total, success: true };
        }}
      />

      <RecentConfirmed rows={confirmed} />

      <div style={{ marginTop: 12, fontSize: 11.5, color: "#909399" }}>
        {/* 🔴 AI:PRD-009 打磨（检查单 §三·9 文案）：这里原来写的是 Markdown 的
            `**可退役的旧 UI**` —— JSX 不认 Markdown，星号是原样印在页面上的。 */}
        旧审核台（{REVIEW_CONSOLE_URL}，PRD-027 自己的进程）从本卡起是
        <b>可退役的旧 UI</b> —— 终审全流程已在本页闭环，写仍由圣域的 审核库.py
        落库，它开不开都不影响。
      </div>
    </>
  );
}

/**
 * 页尾只读小节：近期已确认。
 * 🔴 放行来源必须看得见 —— 分不清哪批是人看过的、哪批是机器放的，就谈不上追责。
 */
function RecentConfirmed({ rows }: { rows: ReviewConfirmedRow[] }) {
  const columns: ProColumns<ReviewConfirmedRow>[] = [
    {
      title: "学员",
      dataIndex: "student",
      width: 170,
      render: (_, r) => (
        <Space size={6} wrap>
          <Link href={reviewHref(r.student, r.day)}>
            <b>{r.student}</b>
          </Link>
          <Link
            href={studentHref(r.student)}
            style={{ fontSize: 11.5, color: "#909399" }}
          >
            学情
          </Link>
        </Space>
      ),
    },
    {
      title: "打卡次",
      dataIndex: "day",
      width: 90,
      render: (_, r) => <span style={数字}>第 {r.day} 次</span>,
    },
    {
      title: "确认时间",
      dataIndex: "confirmedAt",
      width: 120,
      render: (_, r) => <TimeText iso={r.confirmedAt} />,
    },
    {
      title: "轮次",
      dataIndex: "round",
      width: 80,
      render: (_, r) => <span style={数字}>第 {r.round} 轮</span>,
    },
    {
      title: "放行来源",
      dataIndex: "auto",
      render: (_, r) =>
        r.auto ? (
          <Tooltip
            title={
              r.auto === "L2代审"
                ? "复核 subagent 代审（confirm --from --auto L2代审）"
                : "判据全绿，直批.py 机器放行的"
            }
          >
            <Tag color="blue">{r.auto}</Tag>
          </Tooltip>
        ) : (
          <Tooltip title="batches.auto 为空 = 人在终审台（或旧审核台）逐题点的">
            <Tag>人工</Tag>
          </Tooltip>
        ),
    },
  ];

  return (
    <ProTable<ReviewConfirmedRow>
      style={{ marginTop: 14 }}
      rowKey="key"
      size="small"
      cardBordered
      columns={columns}
      dataSource={rows}
      search={false}
      options={false}
      pagination={false}
      scroll={{ x: 700 }}
      headerTitle={
        <span style={{ fontSize: 13 }}>
          近期已确认（只读 · 最近 {REVIEW_CONFIRMED_LIMIT} 批）
          <span
            style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
          >
            人工 = 你逐题点的；L1静默 / L2静默 = 判据全绿机器放的；L2代审 = 复核
            subagent 代审的
          </span>
        </span>
      }
      locale={{
        emptyText: (
          <EmptyHint>
            还没有任何批次被确认过 —— 「没确认过」不是「没批过」：预批入库只落
            pending，要人（或静默档位）放行才算数。
          </EmptyHint>
        ),
      }}
    />
  );
}

export default ReviewQueueTable;
