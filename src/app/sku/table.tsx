"use client";

/**
 * SKU 台账 · 三段式列表（AI:PRD-008 · P2 · 设计稿 §二·8）
 *
 * 职责：卖的/备着卖的册子总账。**不管**建 SKU（走产线脚本/MCP）。
 * 结构 = 若依/ProTable 标准三段式：搜索区 → 工具栏 → 表格 + 真分页（默认 20）。
 *
 * 🔴 本组件**零业务逻辑**：条件拼成 query 丢给 `/api/skus`，那头调 core 的
 *    listSkus + getSku。页面不自己算哪本册子该出现。
 * 🔴 写操作只有一条：上架/下架 —— 而且**不在这张表上直接改**，点进确认页
 *    （`/sku/<id>/status?to=…`）看清楚「从什么改成什么、影响谁」再按。
 *    二次确认是设计稿 §二·8 明写的要求，不是我加戏。
 * 🔴 窗口内过滤/上限一律上墙（表格上方那条 Alert），一个字不吞。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import {
  CopyCmd,
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import type { SkuListMeta, SkuListResponse, SkuRow } from "./shared";

interface QueryForm {
  name?: string;
  type?: string;
  status?: string;
  layout?: string;
  edition?: string;
}

export interface SkuTableProps {
  /** 枚举正本全在 core，由 server 页面读出来传进来（client 不 import core） */
  types: readonly string[];
  statuses: readonly string[];
}

function toEnum(list: readonly string[]): Record<string, { text: string }> {
  return Object.fromEntries(list.map((v) => [v, { text: v }]));
}

/** 取数口径条：窗口有多大、哪几维是窗口内过滤、逐本读卡花了多久 */
function MetaBar({
  meta,
  error,
}: {
  meta: SkuListMeta | null;
  error?: string;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="册子列不出来（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;

  const notes: string[] = [];
  if (meta.windowFilters.length > 0) {
    notes.push(
      `${meta.windowFilters.join("、")} 是在取回的 ${meta.listed} 本里过滤的` +
        "（core 的 listSkus 只吃类型/状态两维），总数按这个窗口算",
    );
  }
  if (meta.capped) {
    notes.push(
      `已经取到 listSkus 的上限 ${meta.cap} 本 —— 更多的册子这一页看不到，` +
        "上面的筛选也只在这 " +
        `${meta.cap} 本里做。收窄类型/状态即可看到别的。`,
    );
  }

  const tone = meta.capped ? "warning" : "info";
  return (
    <Alert
      type={tone}
      showIcon={meta.capped}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          窗口 {meta.listed} 本 · 筛出 {meta.filtered} 本 · 逐本读卡{" "}
          {meta.enriched} 次（版式/版本语境/网盘只在卡里有）· {meta.ms}ms
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

/** 网盘那一栏：有指针给提取码+链接，没有就说清「—」的意思 */
function Netdisk({ row }: { row: SkuRow }) {
  if (!row.netdisk) {
    return (
      <Tooltip
        title={
          row.recipeBroken
            ? "recipe_json 解析不了（坏 JSON）——不是没有配方，是这份配方要修"
            : "recipe_json 里没有 netdisk 段。🔴 它的意思是「这本册子的配方里没记网盘」，不是「没传过网盘」（真凭据在 网盘分发记录/分享链接总表.md）"
        }
      >
        <span style={{ color: row.recipeBroken ? "#c45656" : "#909399" }}>
          {row.recipeBroken ? "配方坏了" : "—"}
        </span>
      </Tooltip>
    );
  }
  const { link, code, raw } = row.netdisk;
  return (
    <Tooltip title={raw} styles={{ root: { maxWidth: 520 } }}>
      <span>
        <Tag color="green">{code ?? "有链接"}</Tag>
        {link ? (
          <a href={link} target="_blank" rel="noreferrer">
            打开
          </a>
        ) : null}
      </span>
    </Tooltip>
  );
}

export function SkuTable(props: SkuTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<SkuListMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const columns: ProColumns<SkuRow, "text">[] = [
    {
      title: "名称",
      dataIndex: "name",
      sorter: true,
      width: 300,
      // 🔴 册名常常长过一列（「七上有理数混合运算每日打卡·教辅版」这种）：
      //    截断 + 悬停全名，别让一行撑成三行把整张表顶散。
      ellipsis: true,
      tooltip:
        "在取回的窗口里按「包含」匹配（core 的 listSkus 没有名称这一维）",
      fieldProps: { placeholder: "群打卡 / 绝对值" },
      render: (_, r) => (
        <Tooltip title={r.name} styles={{ root: { maxWidth: 520 } }}>
          <Link href={`/sku/${r.id}`} style={{ color: "inherit" }}>
            <span style={{ fontSize: 12.5 }}>{r.name}</span>
          </Link>
        </Tooltip>
      ),
    },
    {
      title: "类型",
      dataIndex: "type",
      sorter: true,
      width: 76,
      valueType: "select",
      valueEnum: toEnum(props.types),
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => (r.type ? <Tag>{r.type}</Tag> : <Tag>类型未填</Tag>),
    },
    {
      title: "状态",
      dataIndex: "status",
      sorter: true,
      width: 88,
      valueType: "select",
      valueEnum: toEnum(props.statuses),
      tooltip: "draft=登记了还没开卖 / active=在售 / retired=下架",
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => <StatusTag value={r.status} />,
    },
    {
      title: "题数",
      dataIndex: "items",
      sorter: true,
      search: false,
      width: 64,
      align: "right",
      tooltip: "sku_item 行数 = 题单里有多少题（0 = 登记了还没装题）",
      render: (_, r) =>
        r.items === 0 ? (
          <Tooltip title="登记 ≠ 装题：这本册子还没有一条 sku_item">
            <span
              style={{ color: "#909399", fontVariantNumeric: "tabular-nums" }}
            >
              0
            </span>
          </Tooltip>
        ) : (
          // 🔴 看到即可达：题数点得动 —— 题单在详情页（ord 对位那张表）
          <Tooltip title="点进册子详情看题单（ord = 卷面题号）">
            <Link
              href={`/sku/${r.id}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {r.items}
            </Link>
          </Tooltip>
        ),
    },
    {
      title: "产物",
      dataIndex: "outputs",
      sorter: true,
      search: false,
      width: 64,
      align: "right",
      tooltip: "sku_output 行数（PDF/题单 JSON/物料）",
      render: (_, r) =>
        r.outputs === 0 ? (
          <span
            style={{ color: "#909399", fontVariantNumeric: "tabular-nums" }}
          >
            0
          </span>
        ) : (
          <Tooltip title="点进产物仓，只看这本册子的件">
            <Link
              href={`/output?sku=${r.id}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {r.outputs}
            </Link>
          </Tooltip>
        ),
    },
    {
      title: "网盘",
      dataIndex: "netdisk",
      search: false,
      width: 96,
      tooltip: "取自 recipe_json 的 netdisk 段（页面不去猜别处的链接）",
      render: (_, r) => <Netdisk row={r} />,
    },
    {
      title: "版式",
      dataIndex: "layout",
      sorter: true,
      width: 96,
      ellipsis: true,
      tooltip: "sku.layout（punch 的 layout_key）。窗口内按「包含」匹配",
      fieldProps: { placeholder: "daily_v1" },
      render: (_, r) =>
        r.layout ? (
          <Tooltip title={r.layout}>
            <span style={{ fontSize: 12 }}>{r.layout}</span>
          </Tooltip>
        ) : (
          <Tooltip title="sku.layout 是空的">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ),
    },
    {
      title: "版本语境",
      dataIndex: "edition",
      sorter: true,
      width: 96,
      ellipsis: true,
      tooltip: "sku.edition_ctx（生产动作显式带的版本）。窗口内按「包含」匹配",
      fieldProps: { placeholder: "人教七上 / 七上" },
      render: (_, r) =>
        r.editionCtx ? (
          <Tooltip title={r.editionCtx}>
            <span style={{ fontSize: 12 }}>{r.editionCtx}</span>
          </Tooltip>
        ) : (
          <Tooltip title="sku.edition_ctx 是空的">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ),
    },
    {
      title: "挂桥",
      dataIndex: "taskId",
      search: false,
      width: 76,
      tooltip:
        "grading_task_map：这本天卷对应圣域的哪个打卡任务（null = 没挂桥）",
      render: (_, r) =>
        r.taskId === null ? (
          <Tooltip title="grading_task_map 里没有这本册子 —— 学情回流找不到它的作答（只有打卡天卷才需要挂桥）">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ) : (
          // 🔴 这个 tag 点不动是**故意**的：task 是圣域（审核.db）那边的 id，
          //    本管理台没有一页是按 task 号打开的（批改看板按学员代号进）。
          //    给一个点进去 404 的链接比不能点更糟 —— 与 StatCard 的 todo 一个规矩。
          <Tooltip
            title={`圣域打卡任务 task ${r.taskId}（本台没有按 task 号打开的页，所以这个标签点不动）`}
          >
            <Tag
              color="blue"
              style={{ fontVariantNumeric: "tabular-nums", cursor: "default" }}
            >
              task {r.taskId}
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: "建档",
      dataIndex: "createdAt",
      sorter: true,
      search: false,
      width: 106,
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "id",
      dataIndex: "id",
      search: false,
      width: 108,
      render: (_, r) => <IdTail id={r.id} />,
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 176,
      fixed: "right",
      render: (_, r) => [
        <Link key="detail" href={`/sku/${r.id}`}>
          详情
        </Link>,
        r.status === "active" ? (
          <Link key="off" href={`/sku/${r.id}/status?to=retired`}>
            下架…
          </Link>
        ) : (
          <Link key="on" href={`/sku/${r.id}/status?to=active`}>
            上架…
          </Link>
        ),
        <Link key="dedup" href={`/sku/${r.id}/dedup`}>
          排重报告
        </Link>,
      ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<SkuRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1360 }}
        columnsState={{
          persistenceKey: "kf-sku-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="册子列表"
        locale={{
          emptyText: (
            <EmptyHint>
              没有符合条件的册子。🔴
              「没有册子」不等于「没有产出」——建册走产线脚本/MCP（register_sku），
              页面只读这本账。
            </EmptyHint>
          ),
        }}
        toolBarRender={() => [
          // 🔴 一个工具通吃三件事（2026-08-14 修）：MCP 表面上**没有**
          //    add_sku_items / register_sku_output 这两个工具（它们是 core 函数名，
          //    只有一次性脚本直调）。粘一句查无此工具的命令 = 让人白撞一次。
          <CopyCmd
            key="reg"
            label="建册/装题/登记产出走 MCP 的 register_sku（一次编排到底；分步就传 sku_id 往里补）"
            cmd={
              'register_sku {"type":"打卡","name":"<册名>",' +
              '"items":[{"question_id":"q_…","ord":1}],' +
              '"outputs":[{"kind":"pdf_q","file_path":"…/题目卷.pdf"}]}'
            }
          />,
        ]}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
        }}
        request={async (params, sort) => {
          const q = new URLSearchParams();
          q.set("page", String(params.current ?? 1));
          q.set("pageSize", String(params.pageSize ?? 20));
          if (params.name) q.set("name", params.name);
          if (params.type) q.set("type", params.type);
          if (params.status) q.set("status", params.status);
          if (params.layout) q.set("layout", params.layout);
          if (params.edition) q.set("edition", params.edition);

          // 🔴 排序丢给服务端（本表是服务端切片的，前端排只会排当前这一页）
          const [sf, so] = Object.entries(sort ?? {})[0] ?? [];
          if (sf && so) {
            q.set("sort", sf);
            q.set("order", so === "ascend" ? "asc" : "desc");
          }

          // 🔴 取数的三种失败都要上墙（设计稿 §三·2「API 失败 Alert 上墙带原文，
          //    绝不吞」）：① 路由自己报 ok:false；② HTTP 非 2xx（body 常是 HTML，
          //    直接 json() 会抛一个看不懂的 SyntaxError）；③ fetch 本身抛
          //    （dev server 断了/跨源被拦）。**②③ 不 catch 的话 ProTable 会把它们
          //    吞成一张「暂无数据」的空表** —— 「查过了没有」与「根本没查成」
          //    在这一页必须分得开。
          try {
            const res = await fetch(`/api/skus?${q.toString()}`);
            if (!res.ok) {
              throw new Error(
                `GET /api/skus 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            const j = (await res.json()) as SkuListResponse;
            setMeta(j.meta);
            setErr(
              j.ok ? undefined : (j.error ?? "接口返回 ok=false，但没给原因"),
            );
            return { data: j.data, total: j.total, success: true };
          } catch (e) {
            setMeta(null);
            setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
            return { data: [], total: 0, success: true };
          }
        }}
      />
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: "#909399",
          lineHeight: 1.9,
        }}
      >
        上架/下架是白名单里的轻量写（设计稿 §六
        D2）：点「上架…/下架…」进确认页，确认之后才改 sku.status，
        每一跳留一条审计行。其余一切（建册/装题/登记产出）走 MCP。
      </div>
    </>
  );
}

export default SkuTable;
