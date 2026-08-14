"use client";

/**
 * 产物仓 · 三段式列表（AI:PRD-008 · P2 · 设计稿 §二·10）
 *
 * 职责：内容寻址仓里的**实物件**（题目卷/答案卷 PDF、题单 JSON、物料）。
 * 字节按 sha256 存进 assets/，路径只是指针 —— 所以这一页认的是 hash，不是路径。
 *
 * 🔴 下载走已有的 `/api/asset/<hash>`（core 的 getAssetByHash 查登记行再直返字节）。
 *    没有 asset 登记行的产出**不给下载入口**：库里查不到登记行的文件视同不存在，
 *    那是对账 C1 要抓的红旗，不是一个「点了应该能下」的按钮。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Tag, Tooltip, Typography } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmptyHint, StatusTag, TimeText } from "~/components/console/ui";
import {
  humanBytes,
  type OutputListMeta,
  type OutputListResponse,
  type OutputRow,
  type SkuOption,
} from "./shared";

interface QueryForm {
  sku?: string;
  kind?: string;
  note?: string;
}

export interface OutputTableProps {
  /** SKU 下拉候选（server 页面读 core.listSkus 传进来） */
  skuOptions: SkuOption[];
  /** 产出类型枚举正本 = core 的 SKU_OUTPUT_KINDS */
  kinds: readonly string[];
  /** 从 /sku 详情点「本册产物」过来时带的册子 id */
  initialSku?: string;
}

/**
 * 内容 hash 的短串 + 复制。
 * 🔴 hash 认前缀（`a3f1c9…`），ULID 认尾 6 位 ——
 *    ~/components/console/ui 的 IdTail 是给 ULID 的，这里不套它。
 *    （同一段也在 `app/sku/[id]/panels.tsx` 里有一份：那是详情页的产物表，
 *      两处都只有八行，比为它去动地基的公共件划算。）
 */
function HashTail({ hash }: { hash: string }) {
  return (
    <Tooltip title={hash}>
      <Typography.Text
        copyable={{ text: hash, tooltips: ["复制全 hash", "已复制"] }}
        style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12 }}
      >
        {hash.slice(0, 8)}…
      </Typography.Text>
    </Tooltip>
  );
}

function extOf(path: string | null): string {
  if (!path) return "";
  const i = path.lastIndexOf(".");
  return i > 0 ? path.slice(i) : "";
}

function MetaBar({
  meta,
  error,
}: {
  meta: OutputListMeta | null;
  error?: string;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="产物列不出来（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;

  const notes: string[] = [
    `产物是逐本册子读卡展平出来的（core 还没有 listSkuOutputs 这个跨册只读函数）——` +
      `本次扫了 ${meta.skus} 本册子，展平 ${meta.total} 件。`,
  ];
  if (meta.windowFilters.length > 0) {
    notes.push(
      `${meta.windowFilters.join("、")} 是在这 ${meta.total} 件里过滤的`,
    );
  }
  if (meta.capped) {
    notes.push(
      `册子已经取到 listSkus 的上限 ${meta.cap} 本 —— 更靠后的册子的产出这一页看不到。`,
    );
  }

  return (
    <Alert
      type={meta.capped ? "warning" : "info"}
      showIcon={meta.capped}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          展平 {meta.total} 件 · 筛出 {meta.filtered} 件 · {meta.ms}ms
        </span>
      }
      description={
        <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          {notes.map((n, i) => (
            <div key={`n${i}`}>· {n}</div>
          ))}
          {meta.warnings.map((w, i) => (
            <div key={`w${i}`} style={{ color: "#c45656" }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      }
    />
  );
}

export function OutputTable(props: OutputTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<OutputListMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const columns: ProColumns<OutputRow, "text">[] = [
    {
      title: "所属 SKU",
      dataIndex: "sku",
      sorter: true,
      width: 300,
      valueType: "select",
      fieldProps: {
        showSearch: true,
        allowClear: true,
        optionFilterProp: "label",
        placeholder: "不选=全部册子",
        options: props.skuOptions,
      },
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          <Link href={`/sku/${r.skuId}`} style={{ color: "inherit" }}>
            {r.skuName}
          </Link>
          <div style={{ marginTop: 2 }}>
            {r.skuType ? <Tag>{r.skuType}</Tag> : null}
            <StatusTag value={r.skuStatus} />
          </div>
        </div>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      sorter: true,
      width: 88,
      valueType: "select",
      valueEnum: Object.fromEntries(props.kinds.map((k) => [k, { text: k }])),
      tooltip: "pdf_q=题目卷 / pdf_a=答案卷（内部）/ png / 物料 / 其他",
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => (r.kind ? <Tag>{r.kind}</Tag> : <Tag>未标类型</Tag>),
    },
    {
      title: "字节",
      dataIndex: "bytes",
      sorter: true,
      search: false,
      width: 92,
      render: (_, r) => (
        <Tooltip
          title={
            r.bytes === null
              ? "asset 登记行里没有字节数"
              : `${r.bytes} B（登记行里记的数，不是此刻去盘上量的）`
          }
        >
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {humanBytes(r.bytes)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "hash",
      dataIndex: "hash",
      search: false,
      width: 124,
      render: (_, r) =>
        r.hash ? (
          <HashTail hash={r.hash} />
        ) : (
          <Tooltip title="这件产出没有 asset 登记行 —— 对账 C1 要抓的事故，也下载不了">
            <span style={{ color: "#c45656" }}>无登记行</span>
          </Tooltip>
        ),
    },
    {
      title: "登记时间",
      dataIndex: "createdAt",
      sorter: true,
      search: false,
      width: 106,
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "附注",
      dataIndex: "note",
      sorter: true,
      tooltip:
        "登记产出时（MCP 的 register_sku，outputs[].note）写的那句（窗口内按「包含」匹配）",
      fieldProps: { placeholder: "答案卷 / 网盘版" },
      render: (_, r) =>
        r.note ? (
          <Tooltip title={r.note} styles={{ root: { maxWidth: 560 } }}>
            <span
              style={{
                fontSize: 12.5,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {r.note}
            </span>
          </Tooltip>
        ) : (
          <span style={{ color: "#909399" }}>—</span>
        ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 96,
      fixed: "right",
      render: (_, r) =>
        r.hash
          ? [
              <a
                key="dl"
                href={`/api/asset/${r.hash}`}
                download={`${r.skuName}-${r.kind ?? "产物"}${extOf(r.path)}`}
              >
                下载
              </a>,
              <a
                key="open"
                href={`/api/asset/${r.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                打开
              </a>,
            ]
          : [
              <span key="none" style={{ color: "#909399" }}>
                下载不了
              </span>,
            ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<OutputRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1200 }}
        columnsState={{
          persistenceKey: "kf-output-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{
          initialValues: props.initialSku ? { sku: props.initialSku } : {},
        }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="产物列表"
        locale={{
          emptyText: (
            <EmptyHint>
              没有符合条件的产出。🔴 「没有产出」不等于「没出过件」： 出了 PDF
              也要走 MCP 的 <b>register_sku</b>（传 sku_id + outputs）
              登记一次、字节进内容仓，才在这张表上。
            </EmptyHint>
          ),
        }}
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
          if (params.sku) q.set("sku", params.sku);
          if (params.kind) q.set("kind", params.kind);
          if (params.note) q.set("note", params.note);

          // 🔴 排序丢给服务端（本表是服务端切片的，前端排只会排当前这一页）
          const [sf, so] = Object.entries(sort ?? {})[0] ?? [];
          if (sf && so) {
            q.set("sort", sf);
            q.set("order", so === "ascend" ? "asc" : "desc");
          }

          const res = await fetch(`/api/outputs?${q.toString()}`);
          const j = (await res.json()) as OutputListResponse;
          setMeta(j.meta);
          setErr(j.ok ? undefined : j.error);
          return { data: j.data, total: j.total, success: true };
        }}
      />
    </>
  );
}

export default OutputTable;
