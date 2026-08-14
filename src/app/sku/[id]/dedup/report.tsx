"use client";

/**
 * 排重报告的两张表（AI:PRD-008 · P2 · 设计稿 §二·8「排重报告」）
 *
 * 🔴 只画，不算：撞没撞车全是 server 侧 core 的 assertNoSoldDuplicates 算的，
 *    本文件一行判断逻辑都没有（连「算不算重复」都不在这儿定）。
 * 🔴 归属册子里，**本册**标灰（自己装的题当然在自己册里），**别的册子**标红 ——
 *    这份报告真正要看的就是后者。
 */
import { Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";

import { EmptyHint, StatusTag } from "~/components/console/ui";

export interface OwnerView {
  skuId: string;
  name: string;
  type: string | null;
  status: string | null;
  ord: number | null;
  /** 就是当前这本册子 */
  isThis: boolean;
}

export interface HitView {
  questionId: string;
  status: string;
  stemBrief: string;
  /** 撞到的就是送检的这道题本身（题本来就在库里，必然撞） */
  self: boolean;
  skus: OwnerView[];
}

export interface DupViewRow {
  /** 送检题在本册的位次（sku_item.ord） */
  ord: number;
  questionId: string | null;
  stemBrief: string;
  matchKey: string;
  hits: HitView[];
}

export interface SimilarViewRow {
  key: string;
  ord: number;
  questionId: string;
  score: number;
  stemBrief: string;
  self: boolean;
  skus: OwnerView[];
}

function Owners({ skus }: { skus: OwnerView[] }) {
  if (skus.length === 0) {
    return (
      <Tooltip title="这道题没进过任何册子（库存题）——照样是重复，只是还没被卖出去">
        <span style={{ color: "#909399" }}>库存题（没进过册子）</span>
      </Tooltip>
    );
  }
  return (
    <span>
      {skus.map((s) => (
        <Tooltip
          key={s.skuId}
          title={`${s.name}（${s.type ?? "未填类型"} · ${s.status ?? "未填状态"}）${
            s.ord === null ? "" : ` 第 ${s.ord} 题`
          }`}
        >
          <span>
            <Link href={`/sku/${s.skuId}`}>
              <Tag color={s.isThis ? "default" : "red"}>
                {s.isThis ? "本册" : s.name}
                {s.ord === null ? "" : ` #${s.ord}`}
              </Tag>
            </Link>
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

export function CollisionTable({ rows }: { rows: DupViewRow[] }) {
  const columns: ColumnsType<DupViewRow> = [
    {
      title: "本册位次",
      dataIndex: "ord",
      width: 78,
      render: (_, r) => (
        <b style={{ fontVariantNumeric: "tabular-nums" }}>#{r.ord}</b>
      ),
    },
    {
      title: "送检的题",
      dataIndex: "stemBrief",
      width: 320,
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          {r.questionId ? (
            <Link href={`/q/${r.questionId}`} style={{ color: "inherit" }}>
              {r.stemBrief}
            </Link>
          ) : (
            r.stemBrief
          )}
          <div style={{ color: "#909399", fontSize: 11.5, marginTop: 2 }}>
            match_key {r.matchKey.slice(0, 12)}…
          </div>
        </div>
      ),
    },
    {
      title: "撞到了谁",
      dataIndex: "hits",
      render: (_, r) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          {r.hits.map((h) => (
            <div key={h.questionId}>
              {h.self ? (
                <Tag color="default">送检题自己</Tag>
              ) : (
                <Tag color="red">重复</Tag>
              )}
              <Link href={`/q/${h.questionId}`}>{h.stemBrief}</Link>
              <span style={{ marginInlineStart: 6 }}>
                <StatusTag value={h.status} />
              </span>
              <span style={{ marginInlineStart: 6 }}>
                <Owners skus={h.skus} />
              </span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <Table<DupViewRow>
      rowKey="ord"
      size="small"
      columns={columns}
      dataSource={rows}
      locale={{
        emptyText: (
          <EmptyHint>
            这本册子的题，除了它们自己之外没有撞到库里别的题。🔴
            「没有撞车」说的是 match_key
            这一层（同一道题的两次入库）——同模板换数那种「像但不是同一道」，
            要开语义轴才看得见，见上面那条开关。
          </EmptyHint>
        ),
      }}
      pagination={{ defaultPageSize: 20, showSizeChanger: true }}
    />
  );
}

export function SimilarTable({ rows }: { rows: SimilarViewRow[] }) {
  const columns: ColumnsType<SimilarViewRow> = [
    {
      title: "本册位次",
      dataIndex: "ord",
      width: 78,
      render: (_, r) => (
        <b style={{ fontVariantNumeric: "tabular-nums" }}>#{r.ord}</b>
      ),
    },
    {
      title: "余弦",
      dataIndex: "score",
      width: 72,
      render: (_, r) => (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.score}</span>
      ),
    },
    {
      title: "像谁",
      dataIndex: "stemBrief",
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          {r.self ? <Tag color="default">送检题自己</Tag> : null}
          <Link href={`/q/${r.questionId}`}>{r.stemBrief}</Link>
        </div>
      ),
    },
    {
      title: "归属册子",
      dataIndex: "skus",
      width: 300,
      render: (_, r) => <Owners skus={r.skus} />,
    },
  ];

  return (
    <Table<SimilarViewRow>
      rowKey="key"
      size="small"
      columns={columns}
      dataSource={rows}
      locale={{
        emptyText: (
          <EmptyHint>
            语义轴没报出 ≥ 报告线的近似题。🔴
            只报不拦：同模板换数本来就该长得像， 是不是重复得人来判。
          </EmptyHint>
        ),
      }}
      pagination={{ defaultPageSize: 20, showSizeChanger: true }}
    />
  );
}
