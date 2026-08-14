"use client";

/**
 * 模型族谱页的两张表 + JSON 折叠块（AI:PRD-008 · P2 · 设计稿 §二·9「族谱」）
 *
 * 🔴 只画，不算：母题、派生题全是 server 侧 core 的 getLineage 给的，
 *    本文件一行血缘判断都没有。
 */
import { Collapse, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";

import { EmptyHint, StatusTag } from "~/components/console/ui";

export interface LineageQuestionView {
  questionId: string;
  stemBrief: string;
  status: string;
  qtype: string | null;
  /** 这道题是从哪个母题的族谱里查出来的（多母题时看得出来源） */
  via?: string;
}

const 题列: ColumnsType<LineageQuestionView> = [
  {
    title: "题面",
    dataIndex: "stemBrief",
    render: (_, r) => (
      <Link href={`/q/${r.questionId}`} style={{ color: "inherit" }}>
        <span
          style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12.5 }}
        >
          {r.stemBrief}
        </span>
      </Link>
    ),
  },
  {
    title: "题型",
    dataIndex: "qtype",
    width: 84,
    render: (_, r) => (r.qtype ? <Tag>{r.qtype}</Tag> : <Tag>题型未填</Tag>),
  },
  {
    title: "状态",
    dataIndex: "status",
    width: 96,
    render: (_, r) =>
      r.status === "missing" ? (
        <Tooltip title="origin_qids_json 指了个查无此行的 id —— 血缘断在这儿">
          <Tag color="red">查无此题</Tag>
        </Tooltip>
      ) : (
        <StatusTag value={r.status} />
      ),
  },
  {
    title: "操作",
    key: "op",
    width: 110,
    render: (_, r) =>
      r.status === "missing" ? (
        <span style={{ color: "#909399" }}>—</span>
      ) : (
        <>
          <Link href={`/q/${r.questionId}`}>查看</Link>
          <span style={{ color: "#dcdfe6" }}> · </span>
          <Link href={`/search?similar=${r.questionId}`}>相似题</Link>
        </>
      ),
  },
];

export function OriginTable({ rows }: { rows: LineageQuestionView[] }) {
  return (
    <Table<LineageQuestionView>
      rowKey="questionId"
      size="small"
      columns={题列}
      dataSource={rows}
      locale={{
        emptyText: (
          <EmptyHint>
            这个模型没记母题（origin_qids_json 空）—— 🔴
            族谱从母题侧就断了：谁也说不出它是从哪几道真题归纳来的。 补血缘走
            MCP 的 set_model_origins。
          </EmptyHint>
        ),
      }}
      pagination={false}
    />
  );
}

export function DerivedTable({
  rows,
  total,
}: {
  rows: LineageQuestionView[];
  total: number | null;
}) {
  return (
    <Table<LineageQuestionView>
      rowKey="questionId"
      size="small"
      columns={题列}
      dataSource={rows}
      locale={{
        emptyText: (
          <EmptyHint>
            这个模型名下没有派生题。🔴
            「没有派生题」有两种可能：真没生成过，或者生成的题没回填 model_id ——
            页面分不出来，别当成前者。
          </EmptyHint>
        ),
      }}
      pagination={{ defaultPageSize: 20, showSizeChanger: true }}
      footer={
        total === null
          ? undefined
          : () => (
              <span style={{ fontSize: 12, color: "#909399" }}>
                族谱里这个模型的派生题共 {total} 道（本表最多列 200 道）
              </span>
            )
      }
    />
  );
}

/** 模板 / 变量规格 / 错误模型：原文照登，折叠起来不占版面 */
export function JsonBlocks({
  blocks,
}: {
  blocks: { key: string; label: string; text: string | null }[];
}) {
  const 有货 = blocks.filter((b) => b.text !== null && b.text.trim() !== "");
  if (有货.length === 0) {
    return (
      <EmptyHint>
        这个模型没有模板/变量规格/错误模型三段 —— 它现在只是一条「名字 + 考点 +
        生成器指针」的登记行。
      </EmptyHint>
    );
  }
  return (
    <Collapse
      size="small"
      items={有货.map((b) => ({
        key: b.key,
        label: <span style={{ fontSize: 12.5 }}>{b.label}</span>,
        children: (
          <pre
            style={{
              fontSize: 11.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              background: "#f4f4f5",
              padding: 10,
              margin: 0,
              maxHeight: 420,
              overflow: "auto",
            }}
          >
            {pretty(b.text ?? "")}
          </pre>
        ),
      }))}
    />
  );
}

/** JSON 就格式化，不是 JSON 就原样（坏 JSON 是要修的东西，不是要藏的） */
function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s) as unknown, null, 2);
  } catch {
    return s;
  }
}
