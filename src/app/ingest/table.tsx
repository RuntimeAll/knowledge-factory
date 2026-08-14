"use client";

/**
 * 题库管理 · 录入批次（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 职责：每一次投料的台账——什么时候、谁投的、进了多少拒了多少、闸报告。
 * **不管**重投（命令行的事，工具栏只给一句可复制的命令）。
 *
 * 结构 = 若依/ProTable 三段式：搜索区（来源/状态/时间）→ 工具栏 → 表格 + 真分页。
 *
 * 🔴 本组件零业务逻辑：条件拼成 query 丢给 `/api/ingest`，那头调 core 的
 *    listIngestBatches；闸报告点开才去 `/api/ingest/<id>` 取全账（单批 gate_report
 *    能到 76KB，列表页不驮它）。
 * 🔴 「看本批题目」不是跳 `/question` 带筛选 —— core 的检索层**没有 ingest_batch
 *    这一维**（硬过滤只有考点/题型/难度/判档/版本/状态）。与其造一个筛不出东西的
 *    链接，不如直接把本批落库的题 id 列出来，每个都点得进详情。这条口径写在抽屉里。
 * 🔴 全页只读：录题是数据生产类写操作，页面一个字都不改库（设计稿 §〇·3）。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useRef, useState } from "react";

import {
  CopyCmd,
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import {
  INGEST_STATUSES,
  type GateItemView,
  type IngestBatchDetail,
  type IngestBatchRow,
  type IngestDetailResponse,
  type IngestItemView,
  type IngestListResponse,
} from "./shared";

/** 搜索区表单形状（时间列 transform 成 from/to 两个键） */
interface QueryForm {
  source?: string;
  status?: string;
  createdAt?: string[];
  from?: string;
  to?: string;
}

/** 抽屉三页：闸报告 / 本批题目 / 隔离行 */
type DrawerTab = "gate" | "questions" | "quarantine";

/** 数字列：0 显灰（「0 道被拒」和「没这一栏」不是一回事，但灰掉能让红的跳出来） */
function Num({ n, tone }: { n: number; tone?: "ok" | "warn" | "bad" }) {
  if (n === 0) return <span style={{ color: "#c0c4cc" }}>0</span>;
  const color =
    tone === "bad" ? "#f56c6c" : tone === "warn" ? "#e6a23c" : "#67c23a";
  return <b style={{ color }}>{n}</b>;
}

/** 一道闸的红绿（红灯连 code + 人话一起摆出来，那是 agent 自愈用的错误契约） */
function gateColumns(): ColumnsType<GateItemView> {
  return [
    {
      title: "闸",
      dataIndex: "name",
      width: 190,
      render: (_, g) => (
        <span style={{ fontSize: 12.5 }}>
          {g.ok ? "🟢" : "🔴"} {g.name}
        </span>
      ),
    },
    {
      title: "结论",
      dataIndex: "code",
      render: (_, g) =>
        g.ok ? (
          <span style={{ color: "#909399", fontSize: 12.5 }}>过</span>
        ) : (
          <span style={{ fontSize: 12.5 }}>
            <Tag color="red">{g.code}</Tag>
            {g.message}
            {g.nextTool ? (
              <span style={{ color: "#909399" }}> · 下一步 {g.nextTool}</span>
            ) : null}
            {g.recoverable === false ? (
              <Tag color="red" style={{ marginInlineStart: 6 }}>
                改参数也过不了 · 停下来问人
              </Tag>
            ) : null}
          </span>
        ),
    },
    {
      title: "耗时",
      dataIndex: "ms",
      width: 70,
      render: (_, g) => `${g.ms}ms`,
    },
  ];
}

/** 逐题的账（设计稿：「闸报告（弹层展开逐题红绿）」） */
function itemColumns(): ColumnsType<IngestItemView> {
  return [
    { title: "#", dataIndex: "seq", width: 48 },
    {
      title: "判定",
      dataIndex: "verdict",
      width: 92,
      render: (_, it) => (
        <StatusTag
          value={it.verdict === "accepted" ? "passed" : "rejected"}
          title={it.verdict}
        />
      ),
    },
    {
      title: "落库题",
      dataIndex: "questionId",
      width: 130,
      render: (_, it) =>
        it.questionId ? (
          <Link href={`/q/${it.questionId}`}>
            <IdTail id={it.questionId} />
          </Link>
        ) : (
          <Tooltip title="被拒的题不落 question，原样 payload 在隔离区">
            <span style={{ color: "#909399" }}>未落库</span>
          </Tooltip>
        ),
    },
    {
      title: "闸",
      dataIndex: "gatesOk",
      width: 96,
      render: (_, it) => {
        const bad = it.gates.filter((g) => !g.ok).length;
        return bad === 0 ? (
          <span style={{ color: "#67c23a" }}>🟢 {it.gates.length} 道全过</span>
        ) : (
          <span style={{ color: "#f56c6c" }}>🔴 红 {bad} 道</span>
        );
      },
    },
    {
      title: "红灯",
      dataIndex: "failCode",
      render: (_, it) =>
        it.failCode ? (
          <span style={{ fontSize: 12.5 }}>
            <Tag color="red">{it.failCode}</Tag>
            {it.failMessage}
          </span>
        ) : (
          <span style={{ color: "#c0c4cc" }}>—</span>
        ),
    },
    {
      title: "判档 / 实算 / 逐行",
      dataIndex: "solutionGrade",
      width: 210,
      render: (_, it) => (
        <Space size={2} wrap>
          <StatusTag value={it.solutionGrade} />
          <Tooltip title="calc_verdict：没送去实算 = 未算，不是「算过没问题」">
            <Tag color={it.calcVerdict ? "blue" : "default"}>
              实算 {it.calcVerdict ?? "未算"}
            </Tag>
          </Tooltip>
          <Tooltip title="line_verdict：逐行恒等校验三态">
            <Tag color={it.lineVerdict ? "blue" : "default"}>
              逐行 {it.lineVerdict ?? "未校"}
            </Tag>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: "其他",
      dataIndex: "notes",
      width: 200,
      render: (_, it) => (
        <span style={{ fontSize: 12, color: "#606266" }}>
          {it.reviewRequired ? <Tag color="orange">必审</Tag> : null}
          {it.kpCount > 0 ? `挂 ${it.kpCount} 考点` : "没挂考点"}
          {it.stripped.length > 0
            ? ` · 剥掉「${it.stripped.join("」「")}」`
            : ""}
          {it.notes.length > 0 ? ` · ${it.notes.join(" / ")}` : ""}
        </span>
      ),
    },
  ];
}

export function IngestTable() {
  const actionRef = useRef<ActionType>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [capped, setCapped] = useState(false);

  /** 抽屉：一次只看一批（open=批 id） */
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<DrawerTab>("gate");
  const [detail, setDetail] = useState<IngestBatchDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  function 打开(id: string, which: DrawerTab): void {
    setOpen(id);
    setTab(which);
    setDetail(null);
    setDetailErr(undefined);
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/ingest/${encodeURIComponent(id)}`);
        const j = (await res.json()) as IngestDetailResponse;
        setDetail(j.data);
        setDetailErr(j.ok ? undefined : j.error);
      } catch (e) {
        setDetailErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }

  const columns: ProColumns<IngestBatchRow, "text">[] = [
    {
      title: "批次号",
      dataIndex: "id",
      search: false,
      width: 110,
      render: (_, r) => <IdTail id={r.id} />,
    },
    {
      title: "来源",
      dataIndex: "source",
      tooltip:
        "ingest_batch.source = 喂料方标识（skill/脚本名@版本）。搜的是子串。",
      fieldProps: { placeholder: "kb-submit / 群卷接入 / 绝对值压轴册" },
      render: (_, r) => (
        <Tooltip title={`${r.source}（契约 ${r.contractVer}）`}>
          <span style={{ fontSize: 12.5 }}>{r.source}</span>
        </Tooltip>
      ),
    },
    {
      title: "总数",
      dataIndex: "total",
      search: false,
      width: 56,
      render: (_, r) => r.total,
    },
    {
      title: "通过",
      dataIndex: "accepted",
      search: false,
      width: 56,
      tooltip: "accepted = 落库题数（含需人审的）",
      render: (_, r) => <Num n={r.accepted} tone="ok" />,
    },
    {
      title: "待审",
      dataIndex: "queued",
      search: false,
      width: 56,
      tooltip: "queued = 落了库但带没过审的题干图，开了人审工单",
      render: (_, r) => <Num n={r.queued} tone="warn" />,
    },
    {
      title: "拒收",
      dataIndex: "rejected",
      search: false,
      width: 56,
      tooltip: "rejected = 红灯题，不落 question，原样 payload 进隔离区",
      render: (_, r) => <Num n={r.rejected} tone="bad" />,
    },
    {
      title: "隔离未结",
      dataIndex: "quarantineOpen",
      search: false,
      width: 78,
      tooltip: "本批留在隔离区还没人处置的行（改判重投 / 废弃都算处置）",
      render: (_, r) =>
        r.quarantineTotal === 0 ? (
          <span style={{ color: "#c0c4cc" }}>—</span>
        ) : (
          <span>
            <Num n={r.quarantineOpen} tone="bad" />
            <span style={{ color: "#909399" }}> / {r.quarantineTotal}</span>
          </span>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      valueType: "select",
      valueEnum: Object.fromEntries(
        INGEST_STATUSES.map((s) => [s, { text: s }]),
      ),
      fieldProps: { placeholder: "不选=全部" },
      render: (_, r) => <StatusTag value={r.status} />,
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      valueType: "dateRange",
      width: 104,
      tooltip: "批次开出来的时间（created_at）；committed_at 在抽屉里",
      search: {
        transform: (v: string[]) => ({ from: v?.[0], to: v?.[1] }),
      },
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 130,
      render: (_, r) => [
        r.hasGateReport ? (
          <a key="gate" onClick={() => 打开(r.id, "gate")}>
            闸报告
          </a>
        ) : (
          <Tooltip key="gate" title="这一批没留 gate_report_json，展不出东西">
            <span style={{ color: "#c0c4cc" }}>闸报告</span>
          </Tooltip>
        ),
        <a key="q" onClick={() => 打开(r.id, "questions")}>
          本批题目
        </a>,
      ],
    },
  ];

  const d = detail;

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="批次台账读不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{err}</span>}
        />
      ) : null}
      {capped ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="批次数已到单次上限 500 —— 收窄时间范围再看，否则更早的批看不到"
        />
      ) : null}

      <ProTable<IngestBatchRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        // 🔴 列宽之和刚好塞进容器（约 1130）：十列全在一屏，不出横向滚动条。
        //    操作列**不设 fixed:"right"** —— 目检实测：一固定，它的实际宽度会顶掉
        //    左边的「时间」列，把 `08-14 10:45` 压成 `08-14 1`。不滚就不需要钉住。
        scroll={{ x: 1120 }}
        columnsState={{
          persistenceKey: "kf-ingest-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="录入批次"
        locale={{
          emptyText: (
            <EmptyHint>
              没有符合条件的批次。
              <br />
              「一次也没投过料」和「这段时间没投过」不是一回事 ——
              先把时间范围清空再看一眼。
            </EmptyHint>
          ),
        }}
        toolBarRender={() => [
          <CopyCmd
            key="submit"
            label="投料 / 重投请用"
            cmd="pnpm kb:submit <题单.json>"
          />,
        ]}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          q.set("page", String(params.current ?? 1));
          q.set("pageSize", String(params.pageSize ?? 20));
          if (params.source) q.set("source", params.source);
          if (params.status) q.set("status", params.status);
          if (params.from) q.set("from", params.from);
          if (params.to) q.set("to", params.to);

          const res = await fetch(`/api/ingest?${q.toString()}`);
          const j = (await res.json()) as IngestListResponse;
          setErr(j.ok ? undefined : j.error);
          setCapped(j.capped);
          return { data: j.data, total: j.total, success: true };
        }}
      />

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        width={980}
        title={
          <span style={{ fontSize: 14 }}>
            录入批次全账
            {open ? (
              <Typography.Text
                code
                copyable={{ text: open }}
                style={{ fontSize: 12, marginInlineStart: 8 }}
              >
                {open}
              </Typography.Text>
            ) : null}
          </span>
        }
      >
        {detailErr ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 10 }}
            message={detailErr}
          />
        ) : null}

        {d ? (
          <>
            <Descriptions
              size="small"
              bordered
              column={2}
              style={{ marginBottom: 12 }}
              items={[
                { key: "src", label: "来源", children: d.source },
                { key: "ver", label: "契约", children: d.contractVer },
                {
                  key: "st",
                  label: "状态",
                  children: <StatusTag value={d.status} />,
                },
                {
                  key: "cnt",
                  label: "计数",
                  children: `总 ${d.total} · 通过 ${d.accepted} · 待审 ${d.queued} · 拒收 ${d.rejected}`,
                },
                {
                  key: "ct",
                  label: "开批",
                  children: <TimeText iso={d.createdAt} />,
                },
                {
                  key: "cm",
                  label: "提交",
                  children: <TimeText iso={d.committedAt} />,
                },
                {
                  key: "ph",
                  label: "payload hash",
                  span: 2,
                  children: (
                    <span style={{ fontSize: 11.5, wordBreak: "break-all" }}>
                      {d.payloadHash ?? "（没留）"}
                    </span>
                  ),
                },
              ]}
            />

            <Tabs
              activeKey={tab}
              onChange={(k) => setTab(k as DrawerTab)}
              items={[
                {
                  key: "gate",
                  label: `闸报告（${d.items.length} 题）`,
                  children: d.gateParseError ? (
                    <EmptyHint>{d.gateParseError}</EmptyHint>
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#606266",
                          marginBottom: 8,
                        }}
                      >
                        批级闸（契约检查）
                        {d.contractOk === null ? (
                          <Tag>未记</Tag>
                        ) : d.contractOk ? (
                          <Tag color="green">过</Tag>
                        ) : (
                          <Tag color="red">红（整批拒，一道题都不入库）</Tag>
                        )}
                        · 展开一行看它那十道闸逐道的结论
                      </div>
                      <Table<IngestItemView>
                        rowKey="seq"
                        size="small"
                        columns={itemColumns()}
                        dataSource={d.items}
                        pagination={{ defaultPageSize: 20, size: "small" }}
                        expandable={{
                          expandedRowRender: (it) => (
                            <Table<GateItemView>
                              rowKey="name"
                              size="small"
                              columns={gateColumns()}
                              dataSource={it.gates}
                              pagination={false}
                            />
                          ),
                        }}
                      />
                    </>
                  ),
                },
                {
                  key: "questions",
                  label: `本批题目（${d.questionIds.length}）`,
                  children:
                    d.questionIds.length === 0 ? (
                      <EmptyHint>
                        这一批没有题落库（整批被拒，或者是一次 dryRun）。
                      </EmptyHint>
                    ) : (
                      <>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#606266",
                            marginBottom: 8,
                          }}
                        >
                          🔴 这里直接列 id 而不是跳「题目管理」带筛选：core
                          的检索层没有 ingest_batch
                          这一维（硬过滤只有考点/题型/难度/判档/版本/状态），
                          造一个筛不出东西的链接不如把题摆出来。
                        </div>
                        <Space size={[6, 6]} wrap>
                          {d.questionIds.map((qid) => (
                            <Link key={qid} href={`/q/${qid}`}>
                              <Tag color="blue">…{qid.slice(-6)}</Tag>
                            </Link>
                          ))}
                        </Space>
                      </>
                    ),
                },
                {
                  key: "quarantine",
                  label: `隔离行（${d.quarantine.open}/${d.quarantine.total}）`,
                  children:
                    d.quarantine.total === 0 ? (
                      <EmptyHint>
                        这一批没有隔离行 —— 没有题被管道拒掉。
                      </EmptyHint>
                    ) : (
                      <div style={{ fontSize: 12.5, lineHeight: 2 }}>
                        未结 <b>{d.quarantine.open}</b> · 已结{" "}
                        {d.quarantine.resolved} · 共 {d.quarantine.total}
                        <br />
                        <Link href="/queue?tab=quarantine">
                          去处置台 · 隔离区 →
                        </Link>
                        <br />
                        {d.quarantine.openIds.length > 0 ? (
                          <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
                            {d.quarantine.openIds.map((qid) => (
                              <Link key={qid} href={`/queue/quarantine/${qid}`}>
                                <Tag color="red">…{qid.slice(-6)}</Tag>
                              </Link>
                            ))}
                          </Space>
                        ) : null}
                      </div>
                    ),
                },
              ]}
            />
          </>
        ) : (
          <div style={{ padding: 24, textAlign: "center", color: "#909399" }}>
            {loading ? "读取中…" : detailErr ? "" : "—"}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Button size="small" onClick={() => setOpen(null)}>
            关闭
          </Button>
        </div>
      </Drawer>
    </>
  );
}

export default IngestTable;
