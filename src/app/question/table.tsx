"use client";

/**
 * 题目管理 · 三段式列表（AI:PRD-008 · 地基）
 *
 * 设计稿 §二·2：找题、盘题——按条件把题捞出来看。**不管**改题（录入线的事）、组卷（生产域）。
 * 结构 = 若依/ProTable 的标准三段式：搜索区 → 工具栏（列显隐 + 入库命令提示）→ 表格 + 真分页。
 *
 * 🔴 本组件**零业务逻辑**：条件拼成 query 丢给 `/api/questions`，那头调 core 的
 *    searchQuestions（与 MCP 同一个入口）。页面不自己算什么题该出现。
 * 🔴 入库是**数据生产类写操作**，页面不做（设计稿 §〇·3）：工具栏只给一句能直接粘的命令。
 * 🔴 界面如实：难度筛选置灰（全库 difficulty 未打档，摆一个永远零命中的筛选比没有更坏）；
 *    降级/落靶/窗口封顶一律上墙（表格上方那条 Alert），一个字不吞。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Select, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { CopyCmd, IdTail, StatusTag, TimeText } from "~/components/console/ui";
import type {
  KpOption,
  KpOptionsResponse,
  QuestionListMeta,
  QuestionListResponse,
  QuestionRow,
} from "./shared";

/** 搜索区的表单形状（= ProTable 各列 dataIndex） */
interface QueryForm {
  kw?: string;
  sem?: string;
  kp?: string[];
  qtype?: string[];
  solutionGrade?: string[];
  provType?: string[];
  status?: string[];
}

export interface QuestionTableProps {
  /** 枚举正本全在 core，由 server 页面读出来传进来（client 不 import core） */
  qtypes: readonly string[];
  statuses: readonly string[];
  grades: readonly string[];
  provTypes: readonly string[];
  /** 默认看哪些状态（= core 的 DEFAULT_STATUSES） */
  defaultStatuses: readonly string[];
}

function toEnum(list: readonly string[]): Record<string, { text: string }> {
  return Object.fromEntries(list.map((v) => [v, { text: v }]));
}

/** 各轴干了什么 + 有没有降级/封顶：检索结果的可信度取决于看的人知不知道少跑了哪条轴 */
function MetaBar({
  meta,
  error,
}: {
  meta: QuestionListMeta | null;
  error?: string;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="检索没跑成（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;

  const notes: string[] = [];
  if (meta.axes.fts.active) {
    notes.push(
      `关键词轴 ${meta.axes.fts.count} 中（${meta.axes.fts.op === "or" ? "OR·已降级" : "AND"}${
        meta.axes.fts.tokens.length > 0
          ? ` · 分词 ${meta.axes.fts.tokens.join(" / ")}`
          : ""
      }）`,
    );
  }
  if (meta.axes.vector.active) {
    notes.push(
      `语意轴 ${meta.axes.vector.count} 中（${meta.axes.vector.modelVer ?? "模型不可用"}）`,
    );
  }
  if (meta.axes.kpAuto.active) {
    notes.push(
      `关键词落靶成考点「${meta.axes.kpAuto.names.join("、")}」，额外开了一条考点召回轴（${meta.axes.kpAuto.count} 中）`,
    );
  }
  if (meta.capped) {
    notes.push(
      `命中 ${meta.coreTotal} 条，本页只翻得到前 ${meta.fetched} 条 —— 关键词/语意是相关性序，` +
        `core 的 searchQuestions 单次上限 ${meta.cap} 且没有 offset，跨窗拼接会把顺序拼错。收窄条件即可看到后面的题。`,
    );
  }
  if (meta.provWindow) {
    notes.push(
      `来源筛选是在已取回的 ${meta.fetched} 条里过滤的（core 硬过滤没有 prov_type 这一维），总数按这个窗口算`,
    );
  }

  const tone = meta.degraded || meta.capped ? "warning" : "info";
  return (
    <Alert
      type={tone}
      showIcon={meta.degraded || meta.capped}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          候选 {meta.candidateCount} · 命中 {meta.coreTotal} · 取回{" "}
          {meta.fetched}（{meta.rounds} 次检索）· {meta.ms}ms
          {meta.degraded ? " · degraded" : ""}
        </span>
      }
      description={
        notes.length + meta.warnings.length > 0 ? (
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            {notes.map((n, i) => (
              <div key={`n${i}`}>· {n}</div>
            ))}
            {meta.warnings.map((w, i) => (
              <div key={`w${i}`}>⚠ {w}</div>
            ))}
          </div>
        ) : null
      }
    />
  );
}

export function QuestionTable(props: QuestionTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<QuestionListMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [kpOptions, setKpOptions] = useState<KpOption[]>([]);
  const [kpLow, setKpLow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 考点框：敲字 → 远程出候选（debounce 250ms，enqueue:false 见 api/kp-options） */
  function searchKp(q: string): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/kp-options?q=${encodeURIComponent(q)}`);
          const j = (await res.json()) as KpOptionsResponse;
          setKpOptions(j.options);
          setKpLow(j.lowConfidence);
        } catch {
          setKpOptions([]);
        }
      })();
    }, 250);
  }

  const columns: ProColumns<QuestionRow, "text">[] = [
    {
      title: "关键词",
      dataIndex: "kw",
      hideInTable: true,
      tooltip:
        "题面里真出现过这些字才算命中（jieba 分词逐词 AND，全中不了自动退 OR）；若它本身是考点的说法，另开一条考点召回轴",
      fieldProps: { placeholder: "最小值 / 去绝对值 / 立方根" },
    },
    {
      title: "语意描述",
      dataIndex: "sem",
      hideInTable: true,
      tooltip: "说不出关键词时用：描述你要找什么样的题（句向量近邻）",
      fieldProps: { placeholder: "含字母的绝对值怎么分类讨论正负" },
    },
    {
      title: "考点",
      dataIndex: "kp",
      hideInTable: true,
      renderFormItem: () => (
        <Select
          mode="multiple"
          allowClear
          showSearch
          filterOption={false}
          onSearch={searchKp}
          placeholder="搜考点名 / 别名，选中才生效"
          options={kpOptions}
          notFoundContent={
            kpLow
              ? "词表四路都没把握——候选只作参考，别硬挑一个"
              : "敲两个字试试"
          }
        />
      ),
    },
    {
      title: "难度",
      dataIndex: "difficultyDisabled",
      hideInTable: true,
      tooltip:
        "全库 difficulty 仍是 NULL（未打档）——能点的难度筛选只会永远零命中，所以置灰",
      renderFormItem: () => (
        <Select disabled placeholder="未打档 · 打完档再启用" options={[]} />
      ),
      search: { transform: () => ({}) },
    },
    {
      title: "题面",
      dataIndex: "stemBrief",
      search: false,
      width: 360,
      render: (_, r) => (
        <Tooltip title={r.stemBrief} styles={{ root: { maxWidth: 560 } }}>
          <Link href={`/q/${r.id}`} style={{ color: "inherit" }}>
            <div
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                fontFamily: "Consolas, Menlo, monospace",
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {r.stemBrief}
            </div>
          </Link>
        </Tooltip>
      ),
    },
    {
      title: "题型",
      dataIndex: "qtype",
      width: 84,
      valueType: "select",
      valueEnum: toEnum(props.qtypes),
      fieldProps: { mode: "multiple", placeholder: "不选=全部" },
      render: (_, r) => (r.qtype ? <Tag>{r.qtype}</Tag> : <Tag>题型未填</Tag>),
    },
    {
      title: "考点",
      dataIndex: "kps",
      search: false,
      width: 240,
      render: (_, r) =>
        r.kps.length === 0 ? (
          <span style={{ color: "#909399" }}>没挂考点</span>
        ) : (
          <span>
            {r.kps.map((k) => (
              <Link key={k.kpId} href={`/kg/kp/${k.kpId}`}>
                <Tag color={k.isPrimary ? "blue" : "default"}>
                  {k.isPrimary ? "★" : ""}
                  {k.name}
                </Tag>
              </Link>
            ))}
          </span>
        ),
    },
    {
      title: "难度",
      dataIndex: "difficulty",
      search: false,
      width: 64,
      render: (_, r) =>
        r.difficulty === null ? (
          <Tooltip title="未打档（question.difficulty IS NULL）">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ) : (
          <span>{r.difficulty}</span>
        ),
    },
    {
      title: "判档",
      dataIndex: "solutionGrade",
      width: 116,
      valueType: "select",
      valueEnum: toEnum(props.grades),
      fieldProps: { mode: "multiple", placeholder: "默认=实算过+仅解析" },
      render: (_, r) => <StatusTag value={r.solutionGrade} />,
    },
    {
      title: "来源",
      dataIndex: "provType",
      width: 96,
      valueType: "select",
      valueEnum: toEnum(props.provTypes),
      tooltip:
        "prov_type。🔴 core 的硬过滤没有这一维：本筛选是在取回的结果里过滤的，总数口径见表格上方",
      fieldProps: { mode: "multiple", placeholder: "不选=全部" },
      render: (_, r) => <Tag>{r.provType}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      valueType: "select",
      valueEnum: toEnum(props.statuses),
      fieldProps: { mode: "multiple" },
      render: (_, r) => (
        <Space size={2}>
          <StatusTag value={r.status} />
          {r.reviewRequired ? (
            <Tooltip title="review_required=1：这题带没过审的题干图">
              <Tag color="orange">必审</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "入库时间",
      dataIndex: "ingestedAt",
      search: false,
      width: 110,
      tooltip:
        "由题 id 里的 ULID 解出（发号即入库那一刻）——检索契约里没有 created_at 这一列",
      render: (_, r) => <TimeText iso={r.ingestedAt} />,
    },
    {
      title: "id",
      dataIndex: "id",
      search: false,
      width: 110,
      render: (_, r) => <IdTail id={r.id} />,
    },
    {
      title: "命中",
      dataIndex: "badges",
      search: false,
      width: 130,
      render: (_, r) =>
        r.badges.map((b) => (
          <Tag key={b} color={b === "仅条件" ? "default" : "green"}>
            {b}
          </Tag>
        )),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 120,
      fixed: "right",
      render: (_, r) => [
        <Link key="view" href={`/q/${r.id}`}>
          查看
        </Link>,
        <Link key="similar" href={`/search?similar=${r.id}`}>
          相似题
        </Link>,
      ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<QuestionRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1400 }}
        columnsState={{
          persistenceKey: "kf-question-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{ initialValues: { status: [...props.defaultStatuses] } }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="题目列表"
        toolBarRender={() => [
          <CopyCmd
            key="submit"
            label="入库请用"
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
          if (params.kw) q.set("kw", params.kw);
          if (params.sem) q.set("sem", params.sem);
          for (const id of params.kp ?? []) q.append("kp", id);
          for (const t of params.qtype ?? []) q.append("qt", t);
          for (const s of params.status ?? []) q.append("st", s);
          for (const g of params.solutionGrade ?? []) q.append("sg", g);
          for (const p of params.provType ?? []) q.append("pv", p);

          const res = await fetch(`/api/questions?${q.toString()}`);
          const j = (await res.json()) as QuestionListResponse;
          setMeta(j.meta);
          setErr(j.ok ? undefined : j.error);
          return { data: j.data, total: j.total, success: true };
        }}
      />
    </>
  );
}

export default QuestionTable;
