"use client";

/**
 * 审查队列 · 处置台（AI:PRD-008 · 地基 · 设计稿 §二·14）
 *
 * 四类 tab（KP 低置信 / 图片必审 / 新题草稿 / 隔离区）+ 兜底一类「其他工单」，
 * 每类一张 ProTable、tab 上挂未处置角标。
 *
 * 🔴 **处置动作一个都没重写**：按钮直接调 003-D 就在用的 server action
 *    （passFigureAction / promoteDraftAction / verdictQueueAction），
 *    破坏性/要理由的（驳回、别名收编、隔离改判）仍然跳原来的确认子页 ——
 *    改版换的是版式，不是那条「破坏性动作走确认页」的规矩。
 * 🔴 第五个 tab「其他工单」是本卡加的（设计稿只写了四类）：模型转正 / KG 提议
 *    这些 kind 否则在页面上**无处可见**，而它们同样等着人拍板。
 * 🔴 空态一律用口径原句（队列空是好事，不是"暂无数据"）。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import {
  Alert,
  Badge,
  Button,
  Segmented,
  Space,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import {
  passFigureAction,
  promoteDraftAction,
  verdictQueueAction,
} from "./actions";
import {
  QUEUE_TABS,
  type QueueCounts,
  type QueueListResponse,
  type QueueTab,
  type QueueViewRow,
} from "./rows";

const TAB_LABEL: Record<QueueTab, string> = {
  kp: "KP 低置信",
  figure: "图片必审",
  draft: "新题草稿",
  quarantine: "隔离区",
  other: "其他工单",
};

const TAB_HINT: Record<QueueTab, string> = {
  kp: "agent 问了一句词表里认不出来的说法 —— 处置 = 通过 / 补别名收编 / 驳回",
  figure: "带题干图的题必须人眼对一遍图文 —— 通过则摘掉该题的必审位",
  draft: "agent 提议入库的题（提议 ≠ 入库）—— 转正会真跑一遍十道闸",
  quarantine: "管道拒了的题，原样 payload 留着 —— 改判重投 / 废弃",
  other: "模型转正 / KG 提议 / 抽查 / 其他：设计稿的四类之外，同样等人拍板",
};

/** 工单三态 / 隔离两态（隔离区没有裁决，只有「结没结」） */
const STATES: Record<string, { label: string; value: string }[]> = {
  queue: [
    { label: "未处置", value: "open" },
    { label: "已通过", value: "passed" },
    { label: "已驳回", value: "rejected" },
  ],
  quarantine: [
    { label: "未结", value: "open" },
    { label: "已结", value: "resolved" },
    { label: "全部", value: "all" },
  ],
};

/** 回位隐藏字段：处置完还回原 tab/state（不然处理一列工单要点二十次） */
function Back({ tab, state }: { tab: QueueTab; state: string }) {
  return (
    <>
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="state" value={state} />
    </>
  );
}

export interface QueueBoardProps {
  tab: QueueTab;
  state: string;
  counts: QueueCounts;
  ok?: string;
  err?: string;
}

export function QueueBoard(props: QueueBoardProps) {
  const router = useRouter();
  const actionRef = useRef<ActionType>(null);
  const [counts, setCounts] = useState<QueueCounts>(props.counts);
  const [listErr, setListErr] = useState<string | undefined>(undefined);

  const tab = props.tab;
  const state = props.state;
  const 隔离 = tab === "quarantine";

  function go(nextTab: QueueTab, nextState: string): void {
    router.push(`/queue?tab=${nextTab}&state=${nextState}`);
  }

  const 时间列: ProColumns<QueueViewRow>[] = [
    {
      title: "进队时间",
      dataIndex: "createdAt",
      width: 106,
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 88,
      render: (_, r) => (
        <Tooltip
          title={
            r.verdictAt
              ? `${r.verdictBy ?? "未记名"} 于 ${r.verdictAt} 裁：${r.state}${
                  r.verdictNote ? `\n理由：${r.verdictNote}` : ""
                }`
              : undefined
          }
        >
          <span>
            <StatusTag value={r.state} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: "id",
      dataIndex: "id",
      width: 108,
      render: (_, r) => <IdTail id={r.id} />,
    },
  ];

  function columnsFor(t: QueueTab): ProColumns<QueueViewRow>[] {
    const 已裁 = (r: QueueViewRow) => r.state !== "open";

    if (t === "quarantine") {
      return [
        {
          title: "为什么被拒（why）",
          dataIndex: "why",
          render: (_, r) => (
            <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>
              {r.why}
            </div>
          ),
        },
        {
          title: "批次",
          dataIndex: "batchId",
          width: 120,
          render: (_, r) =>
            r.batchId ? <IdTail id={r.batchId} /> : <span>—</span>,
        },
        ...时间列,
        {
          title: "操作",
          valueType: "option",
          width: 150,
          fixed: "right",
          render: (_, r) =>
            r.resolvedAt
              ? [
                  <span key="done" style={{ color: "#909399" }}>
                    已结（痕迹在 why 的【处置】行）
                  </span>,
                ]
              : [
                  <Link key="fix" href={`/queue/quarantine/${r.id}`}>
                    改判重投 / 废弃…
                  </Link>,
                ],
        },
      ];
    }

    const 原因列: ProColumns<QueueViewRow> = {
      title: "进队原因",
      dataIndex: "reason",
      render: (_, r) => (
        <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>
          {r.reason ?? "（没写理由）"}
          {r.loadError ? (
            <div style={{ color: "#c45656" }}>
              这条工单的详情读不出来：{r.loadError}
            </div>
          ) : null}
        </div>
      ),
    };

    if (t === "kp") {
      return [
        {
          title: "问不出来的说法",
          dataIndex: "query",
          width: 160,
          render: (_, r) =>
            r.query ? (
              <b>「{r.query}」</b>
            ) : (
              <span style={{ color: "#909399" }}>—</span>
            ),
        },
        原因列,
        ...时间列,
        {
          title: "操作",
          valueType: "option",
          width: 210,
          fixed: "right",
          render: (_, r) =>
            已裁(r)
              ? [
                  <span key="done" style={{ color: "#909399" }}>
                    已裁
                  </span>,
                ]
              : [
                  <form
                    key="pass"
                    action={verdictQueueAction}
                    style={{ display: "inline" }}
                  >
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="verdict" value="passed" />
                    <Back tab={tab} state={state} />
                    <Button size="small" htmlType="submit">
                      通过
                    </Button>
                  </form>,
                  r.query ? (
                    <Link key="alias" href={`/queue/${r.id}/alias`}>
                      别名收编
                    </Link>
                  ) : null,
                  <Link key="reject" href={`/queue/${r.id}/reject`}>
                    驳回…
                  </Link>,
                ],
        },
      ];
    }

    if (t === "figure") {
      return [
        {
          title: "题面",
          dataIndex: "stem",
          width: 300,
          render: (_, r) => (
            <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>
              {r.stem ?? "（题不在库里了）"}
              {r.questionId ? (
                <div style={{ color: "#909399", marginTop: 2 }}>
                  <Link href={`/q/${r.questionId}`}>看这道题 →</Link>
                  {r.reviewRequired ? " · review_required=1" : ""}
                </div>
              ) : null}
            </div>
          ),
        },
        {
          title: "配图（对着题面看）",
          dataIndex: "figures",
          width: 260,
          render: (_, r) => (
            <Space wrap size={6}>
              {(r.figures ?? []).map((f) =>
                f.hash ? (
                  <span key={f.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节，不进 next/image 优化管线 */}
                    <img
                      src={`/api/asset/${f.hash}`}
                      alt={`配图 ${f.role ?? ""}`}
                      style={{
                        maxHeight: 96,
                        maxWidth: 160,
                        border: "1px solid #ebeef5",
                        background: "#fff",
                      }}
                    />
                    <div style={{ fontSize: 11 }}>
                      <Tag>{f.role ?? "?"}</Tag>
                      <StatusTag value={f.reviewState} />
                    </div>
                  </span>
                ) : (
                  <span key={f.id} style={{ color: "#c45656", fontSize: 12 }}>
                    这张图没有 asset 登记行（对账 C1c 会红）
                  </span>
                ),
              )}
            </Space>
          ),
        },
        原因列,
        ...时间列,
        {
          title: "操作",
          valueType: "option",
          width: 190,
          fixed: "right",
          render: (_, r) =>
            已裁(r)
              ? [
                  <span key="done" style={{ color: "#909399" }}>
                    已裁
                  </span>,
                ]
              : [
                  <form
                    key="pass"
                    action={passFigureAction}
                    style={{ display: "inline" }}
                  >
                    <input type="hidden" name="id" value={r.id} />
                    <Back tab={tab} state={state} />
                    <Button size="small" type="primary" ghost htmlType="submit">
                      图对得上，通过
                    </Button>
                  </form>,
                  <Link key="reject" href={`/queue/${r.id}/reject`}>
                    驳回…
                  </Link>,
                ],
        },
      ];
    }

    if (t === "draft") {
      return [
        {
          title: "题面 / 答案",
          dataIndex: "stem",
          width: 320,
          render: (_, r) => (
            <div style={{ fontSize: 12.5 }}>
              <div style={{ whiteSpace: "pre-wrap" }}>
                {r.stem ?? "（payload 里没有 stem）"}
              </div>
              <div style={{ color: "#909399", marginTop: 2 }}>
                答案：{r.answer ?? "（无）"} · 来源 {r.source ?? "—"}
              </div>
            </div>
          ),
        },
        {
          title: "预检",
          dataIndex: "precheckOk",
          width: 150,
          render: (_, r) =>
            r.precheckOk === null || r.precheckOk === undefined ? (
              <span style={{ color: "#909399" }}>没有预检记录</span>
            ) : r.precheckOk ? (
              <Tag color="green">全绿 · 点转正即入库</Tag>
            ) : (
              <Tooltip title={(r.reds ?? []).join("\n")}>
                <Tag color="red">有 {(r.reds ?? []).length} 处红灯</Tag>
              </Tooltip>
            ),
        },
        原因列,
        ...时间列,
        {
          title: "操作",
          valueType: "option",
          width: 180,
          fixed: "right",
          render: (_, r) =>
            已裁(r)
              ? [
                  <span key="done" style={{ color: "#909399" }}>
                    已裁
                  </span>,
                ]
              : [
                  <form
                    key="promote"
                    action={promoteDraftAction}
                    style={{ display: "inline" }}
                  >
                    <input type="hidden" name="id" value={r.id} />
                    <Back tab={tab} state={state} />
                    <Button size="small" type="primary" ghost htmlType="submit">
                      转正入库
                    </Button>
                  </form>,
                  <Link key="reject" href={`/queue/${r.id}/reject`}>
                    驳回…
                  </Link>,
                ],
        },
      ];
    }

    // other
    return [
      { title: "类别", dataIndex: "kind", width: 110 },
      原因列,
      ...时间列,
      {
        title: "操作",
        valueType: "option",
        width: 150,
        fixed: "right",
        render: (_, r) =>
          已裁(r)
            ? [
                <span key="done" style={{ color: "#909399" }}>
                  已裁
                </span>,
              ]
            : [
                <form
                  key="pass"
                  action={verdictQueueAction}
                  style={{ display: "inline" }}
                >
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="verdict" value="passed" />
                  <Back tab={tab} state={state} />
                  <Button size="small" htmlType="submit">
                    通过
                  </Button>
                </form>,
                <Link key="reject" href={`/queue/${r.id}/reject`}>
                  驳回…
                </Link>,
              ],
      },
    ];
  }

  const 空态 =
    state === "open" ? (
      <EmptyHint>
        这一类没有待处置的东西 —— 队列空是好事：它说明管道拦下的、agent
        问不出来的，都已经有人看过了。
      </EmptyHint>
    ) : (
      <EmptyHint>没有符合条件的记录。</EmptyHint>
    );

  return (
    <>
      {props.err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{props.err}</span>}
        />
      ) : null}
      {props.ok ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{props.ok}</span>}
        />
      ) : null}
      {listErr ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={`队列读不出来：${listErr}`}
        />
      ) : null}

      <Tabs
        activeKey={tab}
        onChange={(k) => go(k as QueueTab, "open")}
        items={QUEUE_TABS.map((t) => ({
          key: t,
          label: (
            <Tooltip title={TAB_HINT[t]}>
              <span>
                {TAB_LABEL[t]}
                <Badge
                  count={counts[t]}
                  size="small"
                  style={{ marginInlineStart: 6 }}
                />
              </span>
            </Tooltip>
          ),
        }))}
      />

      <ProTable<QueueViewRow>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        cardBordered
        search={false}
        options={{
          reload: true,
          density: false,
          setting: true,
          fullScreen: false,
        }}
        columns={columnsFor(tab)}
        params={{ tab, state }}
        scroll={{ x: 1100 }}
        locale={{ emptyText: 空态 }}
        expandable={{
          expandedRowRender: (r) => (
            <pre
              style={{
                maxHeight: 300,
                overflow: "auto",
                fontSize: 11.5,
                whiteSpace: "pre-wrap",
                background: "#f4f4f5",
                padding: 8,
                margin: 0,
              }}
            >
              {r.payloadPretty}
            </pre>
          ),
          rowExpandable: (r) => r.payloadPretty !== "（空）",
        }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            {TAB_LABEL[tab]}
            <span
              style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
            >
              {TAB_HINT[tab]}
            </span>
          </span>
        }
        toolBarRender={() => [
          <Segmented
            key="state"
            size="small"
            value={state}
            options={STATES[隔离 ? "quarantine" : "queue"]!}
            onChange={(v) => go(tab, String(v))}
          />,
        ]}
        pagination={{ defaultPageSize: 20, pageSizeOptions: [10, 20, 50, 100] }}
        request={async (params) => {
          const q = new URLSearchParams();
          q.set("tab", String((params as { tab?: string }).tab ?? tab));
          q.set("state", String((params as { state?: string }).state ?? state));
          const res = await fetch(`/api/queue?${q.toString()}`);
          const j = (await res.json()) as QueueListResponse;
          setCounts(j.counts);
          setListErr(j.ok ? undefined : j.error);
          return { data: j.data, total: j.total, success: true };
        }}
      />
    </>
  );
}

export default QueueBoard;
