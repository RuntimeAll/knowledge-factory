"use client";

/**
 * SKU 详情页的三块表/抽屉（AI:PRD-008 · P2 · 设计稿 §二·8「详情」）
 *
 * 题单（ord 对位）｜产物清单（可下载）｜recipe 展开抽屉。
 *
 * 🔴 这里是 client 组件的理由只有一个：表格的列要写 render 函数、抽屉要开合状态，
 *    而 server component 不能把函数传下来。**数据全是 server 现算好传进来的**，
 *    本文件一行库都不读。
 * 🔴 `ord` 就是卷面题号（学情回流按它对位）—— **题单表永远按 ord 排，列头不给排序**：
 *    换个序看题单，第 7 题就不是第 7 题了。产物表没有这个理由，列头可排（见下半截）。
 */
import { Button, Drawer, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useState } from "react";

import { EmptyHint, StatusTag, TimeText } from "~/components/console/ui";
import { humanBytes } from "../shared";

export interface SkuItemLite {
  ord: number;
  questionId: string | null;
  stemBrief: string | null;
  status: string | null;
}

export interface SkuOutputLite {
  id: string;
  kind: string | null;
  hash: string | null;
  path: string | null;
  bytes: number | null;
  note: string | null;
  createdAt: string | null;
}

/**
 * 内容 hash 的短串 + 复制。
 * 🔴 与 ULID 的规矩（尾 6 位）不同：hash 认的是**前缀**（`a3f1c9…`），
 *    ~/components/console/ui 的 IdTail 是给 ULID 的，这里不套它。
 */
export function HashTail({ hash }: { hash: string }) {
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

// ---------------------------------------------------------------------------
// ① 题单（ord 对位）
// ---------------------------------------------------------------------------

export function SkuItemsTable({ items }: { items: SkuItemLite[] }) {
  const columns: ColumnsType<SkuItemLite> = [
    {
      title: "ord",
      dataIndex: "ord",
      width: 60,
      render: (_, r) => (
        <Tooltip title="sku_item.ord = 卷面题号，学情回流按它对位">
          <b style={{ fontVariantNumeric: "tabular-nums" }}>{r.ord}</b>
        </Tooltip>
      ),
    },
    {
      title: "题面",
      dataIndex: "stemBrief",
      render: (_, r) =>
        r.questionId === null ? (
          <span style={{ color: "#c45656" }}>
            这个题位没有题（sku_item.question_id 是空的）——
            出卷/对账/学情三处都会变成查不出原因的窟窿
          </span>
        ) : r.stemBrief === null ? (
          <span style={{ color: "#c45656" }}>
            题 {r.questionId} 不在 question 表里（挂了个查无此行的 id）
          </span>
        ) : (
          <Link href={`/question/${r.questionId}`} style={{ color: "inherit" }}>
            <span
              style={{
                fontFamily: "Consolas, Menlo, monospace",
                fontSize: 12.5,
              }}
            >
              {r.stemBrief}
            </span>
          </Link>
        ),
    },
    {
      title: "题的状态",
      dataIndex: "status",
      width: 96,
      render: (_, r) => <StatusTag value={r.status} />,
    },
    {
      title: "操作",
      key: "op",
      width: 110,
      render: (_, r) =>
        r.questionId ? (
          <>
            <Link href={`/question/${r.questionId}`}>查看</Link>
            <span style={{ color: "#dcdfe6" }}> · </span>
            <Link href={`/question?similar=${r.questionId}`}>相似题</Link>
          </>
        ) : (
          <span style={{ color: "#909399" }}>—</span>
        ),
    },
  ];

  return (
    <Table<SkuItemLite>
      rowKey="ord"
      size="small"
      columns={columns}
      dataSource={items}
      locale={{
        emptyText: (
          <EmptyHint>
            这本册子还没装题（sku_item 一行都没有）—— 🔴 登记 ≠ 装题。装题走 MCP
            的 <b>register_sku</b>（传 sku_id + items 往这本册子里补， ord
            就是卷面题号），页面不做。
          </EmptyHint>
        ),
      }}
      pagination={{
        defaultPageSize: 20,
        pageSizeOptions: [10, 20, 50, 100],
        showSizeChanger: true,
        showTotal: (t) => `共 ${t} 题`,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// ② 产物清单
// ---------------------------------------------------------------------------

export function SkuOutputsTable({
  outputs,
  skuName,
}: {
  outputs: SkuOutputLite[];
  skuName: string;
}) {
  const columns: ColumnsType<SkuOutputLite> = [
    {
      title: "类型",
      dataIndex: "kind",
      width: 84,
      sorter: (a, b) => (a.kind ?? "").localeCompare(b.kind ?? ""),
      render: (_, r) => (r.kind ? <Tag>{r.kind}</Tag> : <Tag>未标类型</Tag>),
    },
    {
      title: "字节",
      dataIndex: "bytes",
      width: 92,
      sorter: (a, b) => (a.bytes ?? -1) - (b.bytes ?? -1),
      render: (_, r) => (
        <Tooltip title={r.bytes ?? "asset 登记行里没有字节数"}>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {humanBytes(r.bytes)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "hash",
      dataIndex: "hash",
      width: 120,
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
      width: 106,
      sorter: (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      render: (_, r) => <TimeText iso={r.createdAt} />,
    },
    {
      title: "附注",
      dataIndex: "note",
      sorter: (a, b) => (a.note ?? "").localeCompare(b.note ?? ""),
      render: (_, r) =>
        r.note ? (
          <span style={{ fontSize: 12.5 }}>{r.note}</span>
        ) : (
          <span style={{ color: "#909399" }}>—</span>
        ),
    },
    {
      title: "操作",
      key: "op",
      width: 78,
      render: (_, r) =>
        r.hash ? (
          <a
            href={`/api/asset/${r.hash}`}
            download={`${skuName}-${r.kind ?? "产物"}${extOf(r.path)}`}
          >
            下载
          </a>
        ) : (
          <span style={{ color: "#909399" }}>—</span>
        ),
    },
  ];

  return (
    <Table<SkuOutputLite>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={outputs}
      locale={{
        emptyText: (
          <EmptyHint>
            还没登记过产出（sku_output 一行都没有）—— 🔴 出了 PDF
            不等于登记了：登记走 MCP 的 <b>register_sku</b>（传 sku_id +
            outputs），字节按 sha256 进内容仓。
          </EmptyHint>
        ),
      }}
      pagination={false}
    />
  );
}

/** 仓内文件名（`<hash>.pdf`）→ 扩展名；取不到就不加（宁可没后缀，不编一个） */
function extOf(path: string | null): string {
  if (!path) return "";
  const i = path.lastIndexOf(".");
  return i > 0 ? path.slice(i) : "";
}

// ---------------------------------------------------------------------------
// ③ recipe 抽屉
// ---------------------------------------------------------------------------

/**
 * 出这本册的配方（`sku.recipe_json`）。
 * 🔴 原文照登：解析得动就格式化，解析不动就把原串摆出来 ——
 *    坏 JSON 是要修的东西，不是要藏的东西。
 */
export function RecipeDrawer({
  name,
  json,
}: {
  name: string;
  json: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (!json) {
    return (
      <Tooltip title="sku.recipe_json 是空的 —— 这本册子没记配方（产线出料时没写）">
        <span style={{ fontSize: 12.5, color: "#909399" }}>配方：未记</span>
      </Tooltip>
    );
  }

  let pretty = json;
  let broken = false;
  try {
    pretty = JSON.stringify(JSON.parse(json) as unknown, null, 2);
  } catch {
    broken = true;
  }

  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        展开配方 recipe_json{broken ? "（坏 JSON）" : ""}
      </Button>
      <Drawer
        title={`配方 · ${name}`}
        width={720}
        open={open}
        onClose={() => setOpen(false)}
      >
        {broken ? (
          <div style={{ color: "#c45656", marginBottom: 8, fontSize: 12.5 }}>
            🔴 这段 recipe_json 解析不了，下面是<b>原串</b>（没有美化过）。
          </div>
        ) : null}
        <pre
          style={{
            fontSize: 11.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            background: "#f4f4f5",
            padding: 10,
            margin: 0,
          }}
        >
          {pretty}
        </pre>
      </Drawer>
    </>
  );
}
