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
 *
 * ── 批量勾选 / 批量处置（2026-08-14 补 · 设计稿 §二·14 明写，之前整块没做）──
 *   · 只有 state='open' 的行勾得动（终态不重裁，勾了也没意义）；
 *   · 批量只做**通过**一个方向 —— 驳回要理由，二十条同一句理由不叫理由，
 *     那条路仍然走确认页；
 *   · 隔离区 tab 不给勾选：那不是「裁一下」，是「改 payload 重投 / 废弃」，
 *     每一条都得看着办（core 的 resolveQuarantine 也要逐条的 payload）。
 * 🔴 列头排序：本表数据是**一次取回全量**（/api/queue 一把取 200 条），
 *    所以 sorter 用比较函数在前端排就是对的 —— 与 /sku 那类服务端切片的表不同。
 *
 * ── AI:PRD-009 打磨（只动版面与交互，处置链一条没改）──────────────────────
 *   ① 二次确认（检查单 7）：逐行的「通过 / 图对得上 / 转正入库」原来是**裸 submit**
 *      —— 手滑一下就落库。现在与批量通过同一形态：弹层 + 影响面。
 *      action 一个字没换（还是 verdictQueueAction / passFigureAction /
 *      promoteDraftAction），确认后走的是同一条 form 提交路径；
 *   ② 列规范（检查单 3）：进队原因 / why / 题面三列长文三行截断 + 悬停全文，
 *      不再让一条工单顶掉半屏；
 *   ③ 跳转贯通（检查单 4）：隔离区的批次 id 点得进 `/ingest?batch=<id>` 看闸报告；
 *   ④ 错误态（检查单 2）：列表 fetch 本身炸了不再被吞成「队列是空的」。
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
  Popconfirm,
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
// 🔴 统一确认件（集成收口②已收编进 components/console/confirm）：
//    检查单第 7 条要求全站写操作统一 Modal 形态，逐行处置按钮以前是裸 submit。
import { ConfirmSubmit } from "~/components/console/confirm";
import {
  batchPassAction,
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

/**
 * 长文列的两件样式（AI:PRD-009 · 检查单 3「长文截断 + 悬停全文」）。
 * 🔴 三行封顶不是"嫌它长"：进队原因/why 里常常整段闸报告，一条能顶掉半屏 ——
 *    截断之后一屏能看见十条工单，全文在悬停里一个字不少。
 */
const 多行截断: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: 12.5,
  lineHeight: 1.7,
};

/** 悬停全文：等宽 + 保留换行（闸报告是排过版的，别把它挤成一坨） */
const 前置样式: React.CSSProperties = {
  margin: 0,
  maxHeight: 320,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  fontSize: 11.5,
  lineHeight: 1.7,
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
  const 批量表单 = useRef<HTMLFormElement>(null);
  const [counts, setCounts] = useState<QueueCounts>(props.counts);
  const [listErr, setListErr] = useState<string | undefined>(undefined);
  const [选中, set选中] = useState<string[]>([]);

  const tab = props.tab;
  const state = props.state;
  const 隔离 = tab === "quarantine";
  /** 🔴 隔离区不给批量：那不是「裁一下」，每条都要看着改 payload 或废弃 */
  const 可批量 = !隔离 && state === "open";

  function go(nextTab: QueueTab, nextState: string): void {
    set选中([]);
    router.push(`/queue?tab=${nextTab}&state=${nextState}`);
  }

  const 时间列: ProColumns<QueueViewRow>[] = [
    {
      title: "进队时间",
      dataIndex: "createdAt",
      width: 106,
      // 🔴 时间是本地 ISO 串（core/time.ts 口径），字典序 = 时序，直接比串
      sorter: (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 88,
      sorter: (a, b) => a.state.localeCompare(b.state),
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
          // 🔴 长文截断 + 悬停全文（检查单 3）：why 里常常是一整段闸报告，
          //    不截断的话一行能顶掉半屏，一页只看得见三条隔离料。
          render: (_, r) => (
            <Tooltip
              title={<pre style={前置样式}>{r.why}</pre>}
              styles={{ root: { maxWidth: 560 } }}
            >
              <div style={多行截断}>{r.why}</div>
            </Tooltip>
          ),
        },
        {
          title: "批次",
          dataIndex: "batchId",
          width: 130,
          sorter: (a, b) => (a.batchId ?? "").localeCompare(b.batchId ?? ""),
          // 🔴 检查单 4「看到即可达」：批次 id 点得进那一批的闸报告
          render: (_, r) =>
            r.batchId ? (
              <Link href={`/ingest?batch=${encodeURIComponent(r.batchId)}`}>
                <IdTail id={r.batchId} />
              </Link>
            ) : (
              <Tooltip title="这条隔离料没记来自哪一批（老数据）">
                <span style={{ color: "#909399" }}>—</span>
              </Tooltip>
            ),
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
      // 长文截断 + 悬停全文（检查单 3）；🔴 loadError 不截断——报错要一眼看全
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          <Tooltip
            title={<pre style={前置样式}>{r.reason ?? "（没写理由）"}</pre>}
            styles={{ root: { maxWidth: 560 } }}
          >
            <div style={多行截断}>{r.reason ?? "（没写理由）"}</div>
          </Tooltip>
          {r.loadError ? (
            <div style={{ color: "#c45656", whiteSpace: "pre-wrap" }}>
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
          sorter: (a, b) => (a.query ?? "").localeCompare(b.query ?? ""),
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
                    <ConfirmSubmit
                      label="通过"
                      title="判这条低置信工单「通过」？"
                      okText="通过"
                      description={
                        <>
                          本工单 → <b>passed</b>，另记一条审计行。
                          <br />
                          🔴 <b>只是把工单关掉</b>：词表一个字不加 —— agent
                          下次照原话问，照样问不出来、照样再开一条。
                          <br />
                          真要让它下次问得到，走「别名收编」。
                        </>
                      }
                    />
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
            <div style={{ fontSize: 12.5 }}>
              <Tooltip
                title={
                  <pre style={前置样式}>{r.stem ?? "（题不在库里了）"}</pre>
                }
                styles={{ root: { maxWidth: 560 } }}
              >
                <div style={多行截断}>{r.stem ?? "（题不在库里了）"}</div>
              </Tooltip>
              {r.questionId ? (
                <div style={{ color: "#909399", marginTop: 2 }}>
                  <Link href={`/question/${r.questionId}`}>看这道题 →</Link>
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
                    <ConfirmSubmit
                      label="图对得上，通过"
                      primary
                      okText="通过"
                      title="这张题干图与题面对得上？"
                      description={
                        <>
                          figure.review_state → <b>passed</b>，并
                          <b>摘掉该题的必审位</b>
                          （question.review_required → 0），本工单关掉。
                          <br />
                          🔴 摘掉必审位之后这道题就<b>算数了</b>
                          （会进检索、能被组进册子）——图文对不上就别按。
                        </>
                      }
                    />
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
              <Tooltip
                title={
                  <pre style={前置样式}>
                    {r.stem ?? "（payload 里没有 stem）"}
                  </pre>
                }
                styles={{ root: { maxWidth: 560 } }}
              >
                <div style={多行截断}>
                  {r.stem ?? "（payload 里没有 stem）"}
                </div>
              </Tooltip>
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
          // 全绿的排一头、有红灯的排另一头（null=没有预检记录，落中间）
          sorter: (a, b) =>
            Number(a.precheckOk ?? -1) - Number(b.precheckOk ?? -1),
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
                    <ConfirmSubmit
                      label="转正入库"
                      primary
                      okText="转正"
                      title="把这道草稿真的录进题库？"
                      description={
                        <>
                          走一遍<b>完整的十道闸</b>再落 question ——
                          闸红了就不入库，红灯原文会回到本页顶上。
                          <br />
                          过了则：题进库、本工单关掉；带题干图的还会另开一条图审工单。
                          <br />
                          🔴 这是<b>真入库</b>，不是「标记通过」。
                          {r.precheckOk === false
                            ? "预检已经报了红灯，多半会被拦下。"
                            : ""}
                        </>
                      }
                    />
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
      {
        title: "类别",
        dataIndex: "kind",
        width: 110,
        sorter: (a, b) => (a.kind ?? "").localeCompare(b.kind ?? ""),
        render: (_, r) =>
          r.kind === "模型转正" ? (
            <Tooltip title="点「通过」= core 的 activateModel：模型 proposed→active + 本工单同一事务关掉（不是只关工单）">
              <Tag color="blue">{r.kind}</Tag>
            </Tooltip>
          ) : (
            <span>{r.kind ?? "（未分类）"}</span>
          ),
      },
      原因列,
      ...时间列,
      {
        title: "操作",
        valueType: "option",
        width: 170,
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
                  <ConfirmSubmit
                    label={
                      r.kind === "模型转正" ? "转正（模型→active）" : "通过"
                    }
                    okText={r.kind === "模型转正" ? "转正" : "通过"}
                    title={
                      r.kind === "模型转正"
                        ? "把这个考察模型转成现役？"
                        : "判这条工单「通过」？"
                    }
                    description={
                      r.kind === "模型转正" ? (
                        <>
                          走 core 的 <b>activateModel</b>：模型 proposed →{" "}
                          <b>active</b>，本工单在<b>同一事务</b>里关掉
                          （不是只关工单）。
                          <br />
                          🔴 转正之后它就能被拿去出题了。
                        </>
                      ) : (
                        <>
                          本工单 → <b>passed</b>，另记一条审计行。
                          <br />
                          本类没有额外的连带写 —— 就是「这条我看过了，放行」。
                        </>
                      )
                    }
                  />
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
        rowSelection={
          可批量
            ? {
                selectedRowKeys: 选中,
                onChange: (keys) => set选中(keys.map((k) => String(k))),
                // 🔴 终态不重裁 ⇒ 已裁的行勾不动（勾了也只会撞 ALREADY_DECIDED）
                getCheckboxProps: (r) => ({ disabled: r.state !== "open" }),
              }
            : undefined
        }
        tableAlertRender={
          可批量
            ? ({ selectedRowKeys }) => (
                <span style={{ fontSize: 12.5 }}>
                  已勾 <b>{selectedRowKeys.length}</b> 条 —— 🔴
                  批量只做「通过」这一个方向：驳回要写理由（二十条同一句理由不叫理由），
                  仍然逐条走确认页。
                </span>
              )
            : false
        }
        tableAlertOptionRender={
          可批量
            ? () => (
                <Space size={10}>
                  <form ref={批量表单} action={batchPassAction}>
                    <input type="hidden" name="ids" value={选中.join(",")} />
                    <Back tab={tab} state={state} />
                    <Popconfirm
                      title={`批量通过这 ${选中.length} 条？`}
                      okText="确认通过"
                      cancelText="再想想"
                      description={
                        <div
                          style={{
                            fontSize: 12.5,
                            maxWidth: 420,
                            lineHeight: 1.8,
                          }}
                        >
                          逐条独立事务、逐条留审计行：
                          <b>一条红了不影响其余</b>，回执逐条原文照登。
                          <br />
                          🔴 其中的「模型转正」会真把模型改成 active（core 的
                          activateModel），「图片」会顺手摘掉该题的必审位。
                        </div>
                      }
                      onConfirm={() => 批量表单.current?.requestSubmit()}
                    >
                      <Button size="small" type="primary" ghost>
                        批量通过（{选中.length}）
                      </Button>
                    </Popconfirm>
                  </form>
                  <a onClick={() => set选中([])}>取消勾选</a>
                </Space>
              )
            : false
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
          // 🔴 fetch 本身炸了 ProTable 会吞掉异常，页面显示成"这一类没有待处置的东西"
          //    —— 队列空是好事，把故障说成好事是最坏的一种吞（检查单 2）。
          try {
            const res = await fetch(`/api/queue?${q.toString()}`);
            // 🔴 HTTP 非 2xx 单列一条：body 常是 HTML，直接 json() 抛出来的是
            //    `SyntaxError: Unexpected token '<'`，人看着完全不知道发生了什么。
            if (!res.ok) {
              throw new Error(
                `GET /api/queue 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            const j = (await res.json()) as QueueListResponse;
            setCounts(j.counts);
            setListErr(j.ok ? undefined : j.error);
            return { data: j.data, total: j.total, success: true };
          } catch (e) {
            setListErr(
              `请求没发出去（或没回来）：${
                e instanceof Error ? `${e.name}: ${e.message}` : String(e)
              }`,
            );
            return { data: [], total: 0, success: false };
          }
        }}
      />
    </>
  );
}

export default QueueBoard;
