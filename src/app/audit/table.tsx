"use client";

/**
 * 系统监控 · 审计日志 · 列表（AI:PRD-008 · P3 · 设计稿 §二·15）
 *
 * 三段式：搜索区（actor / 工具 / 时间）→ 工具栏 → 表格 + 真分页（core 有 offset）。
 *
 * 🔴 **纯只读**：这一页没有任何写按钮，也不该有 —— audit_log 是 append-only，
 *    库里另有两只无条件 RAISE 的触发器，页面就算想改也改不动。
 * 🔴 筛选下拉的候选（actor / tool）由服务端从全表 distinct 出来，
 *    不在前端写死一份：写死的那份会在新加一个工具时悄悄漏掉它。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import Link from "next/link";
import { useRef, useState } from "react";

import {
  CopyCmd,
  EmptyHint,
  LongText,
  TimeText,
} from "~/components/console/ui";
import type { AuditListResponse, AuditRefView, AuditRow } from "./shared";

/**
 * 影响行 → 它自己的页（AI:PRD-009 · 检查单 ④「看到即可达」）。
 *
 * 🔴 只登记**确实存在的详情页**：question_kp / sku_item / kp_alias 这类关联表
 *    没有自己的页，review_queue 也只有处置动作页（/queue/[id]/reject）没有详情页 ——
 *    一律不给链接。不可点是遗憾，点过去 404 是欺骗。
 * 🔴 id 一律 encodeURIComponent：审计行里的 id 是从库里原样取的，
 *    将来出现带 `/` 或空格的键时不会把路由劈开。
 */
const REF_ROUTE: Record<string, (id: string) => string> = {
  question: (id) => `/question/${encodeURIComponent(id)}`,
  kp: (id) => `/kg/kp/${encodeURIComponent(id)}`,
  edition_tree: (id) => `/kg/tree/${encodeURIComponent(id)}`,
  sku: (id) => `/sku/${encodeURIComponent(id)}`,
  exam_model: (id) => `/model/${encodeURIComponent(id)}`,
  ingest_batch: (id) => `/ingest?batch=${encodeURIComponent(id)}`,
  quarantine: (id) => `/queue/quarantine/${encodeURIComponent(id)}`,
  roster: (id) => `/student/${encodeURIComponent(id)}`,
};

interface QueryForm {
  actor?: string;
  tool?: string;
  ts?: string[];
  from?: string;
  to?: string;
}

/** actor 四态各给一个色（不是状态 tag，别混用 STATUS_COLOR 那张表） */
const ACTOR_COLOR: Record<string, string> = {
  agent: "blue",
  human: "green",
  proxy: "purple",
  system: "default",
};

function toEnum(list: string[]): Record<string, { text: string }> {
  return Object.fromEntries(list.map((v) => [v, { text: v }]));
}

export function AuditTable() {
  const actionRef = useRef<ActionType>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [actors, setActors] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);

  const columns: ProColumns<AuditRow, "text">[] = [
    {
      title: "seq",
      dataIndex: "seq",
      search: false,
      width: 70,
      tooltip: "自增序号 = 链上的位置。断号就是断链（顶部横幅会红）",
      render: (_, r) => (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.seq}</span>
      ),
    },
    {
      title: "时间",
      dataIndex: "ts",
      valueType: "dateRange",
      width: 104,
      // 🔴 order = 搜索区里的排位（大的靠前）：表格列序按设计稿 seq/时间/actor/工具，
      //    但搜索区按设计稿写的是 actor / 工具 / 时间 —— 两处顺序本来就不一样。
      order: 1,
      search: {
        transform: (v: string[]) => ({ from: v?.[0], to: v?.[1] }),
      },
      render: (_, r) => <TimeText iso={r.ts} />,
    },
    {
      title: "actor",
      dataIndex: "actor",
      width: 92,
      order: 3,
      valueType: "select",
      valueEnum: toEnum(actors),
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => (
        <Tag color={ACTOR_COLOR[r.actor ?? ""] ?? "default"}>
          {r.actor ?? "—"}
        </Tag>
      ),
    },
    {
      title: "工具",
      dataIndex: "tool",
      width: 190,
      order: 2,
      valueType: "select",
      valueEnum: toEnum(tools),
      fieldProps: {
        placeholder: "不选=全部",
        allowClear: true,
        showSearch: true,
      },
      tooltip: "写路径的名字（core 原语 / 脚本名）——候选来自全表 distinct",
      render: (_, r) =>
        r.tool ? (
          <LongText text={r.tool} maxWidth={172} mono />
        ) : (
          <span style={{ color: "#c0c4cc" }}>—</span>
        ),
    },
    {
      title: "影响行摘要",
      dataIndex: "impact",
      search: false,
      tooltip:
        "row_refs_json 按「表+操作」归并：+ 新增 / ~ 更新 / - 删除。展开一行看逐条明细",
      render: (_, r) => (
        <span style={{ fontSize: 12.5 }}>
          {r.impact}
          {r.hasGateResults ? (
            <Tooltip title="这次写带了闸账（gate_results_json）——展开行里有原文">
              <Tag color="blue" style={{ marginInlineStart: 6 }}>
                带闸账
              </Tag>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      title: "args 摘要",
      dataIndex: "argsDigest",
      search: false,
      width: 110,
      tooltip:
        "args_digest = sha256(参数规范化 JSON)。参数正文不入库（可能很大、可能含正文）",
      render: (_, r) =>
        r.argsDigest ? (
          <Typography.Text
            copyable={{ text: r.argsDigest, tooltips: ["复制全串", "已复制"] }}
            style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 11.5 }}
          >
            {`…${r.argsDigest.slice(-8)}`}
          </Typography.Text>
        ) : (
          <span style={{ color: "#c0c4cc" }}>—</span>
        ),
    },
  ];

  const refColumns: ColumnsType<AuditRefView> = [
    { title: "表", dataIndex: "table", width: 180 },
    { title: "操作", dataIndex: "op", width: 80 },
    {
      title: "行 id",
      dataIndex: "id",
      render: (_, r) => {
        const to = REF_ROUTE[r.table]?.(r.id);
        const body = (
          <span
            style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12 }}
          >
            {r.id}
          </span>
        );
        // 🔴 检查单 ④：审计行说「动了 question ULID…」，人当然想点进去看动的是哪道题。
        //    有详情页的就给链接；没有的（关联表）保持纯文本，不假装可点。
        return to ? (
          <Tooltip title={`去 ${to}`}>
            <Link href={to}>{body}</Link>
          </Tooltip>
        ) : (
          <Tooltip title="这张表没有自己的详情页（关联表 / 只在别的页里出现）">
            {body}
          </Tooltip>
        );
      },
    },
  ];

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="审计行读不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{err}</span>}
        />
      ) : null}

      <ProTable<AuditRow, QueryForm>
        actionRef={actionRef}
        rowKey="seq"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1080 }}
        columnsState={{
          persistenceKey: "kf-audit-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="审计行（seq 倒序）"
        locale={{
          // 🔴 检查单 ⑥：空态与「读不出」必须是两句话。读失败时还端出
          //    「这段时间没有写操作留痕」，等于用一句结论把一次事故盖住了。
          emptyText: err ? (
            <EmptyHint>
              这一屏是空的，<b>因为上面那次读失败了</b> —— 不是「没有审计行」。
              <br />
              修好再刷新；在此之前，本页对「谁动过库」不给任何结论。
            </EmptyHint>
          ) : (
            <EmptyHint>
              这段时间没有写操作留痕。
              <br />
              🔴 「审计行为空」= 这段时间没人写库，不等于「没人动过库」—— 绕过
              core 直接改 .db 文件是留不下审计行的，那种事要靠对账 C1(a)
              和备份快照才抓得到。
            </EmptyHint>
          ),
        }}
        toolBarRender={() => [
          <CopyCmd
            key="verify"
            label="整链重算校验"
            cmd="pnpm exec tsx --env-file=.env scripts/audit-verify.ts"
          />,
        ]}
        expandable={{
          expandedRowRender: (r) => (
            <div style={{ fontSize: 12 }}>
              {r.refs.length > 0 ? (
                <Table<AuditRefView>
                  rowKey={(x) => `${x.table}|${x.id}|${x.op}`}
                  size="small"
                  columns={refColumns}
                  dataSource={r.refs}
                  pagination={false}
                  scroll={{ x: 480 }}
                />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    padding: 8,
                    background: "#f4f4f5",
                    whiteSpace: "pre-wrap",
                    fontSize: 11.5,
                  }}
                >
                  {r.refsRaw ?? "（这一行没有 row_refs_json）"}
                </pre>
              )}
              <div style={{ marginTop: 8, color: "#909399" }}>
                prev_hash：
                <span
                  style={{
                    fontFamily: "Consolas, Menlo, monospace",
                    wordBreak: "break-all",
                  }}
                >
                  {r.prevHash ?? "—"}
                </span>
                <br />↑ =
                sha256(上一行的规范化串)。链的完好由顶部横幅整链重算给结论，
                单看一行看不出来。
              </div>
            </div>
          ),
        }}
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
          if (params.actor) q.set("actor", params.actor);
          if (params.tool) q.set("tool", params.tool);
          if (params.from) q.set("from", params.from);
          if (params.to) q.set("to", params.to);

          // 🔴 检查单 ②：取数**整条链**都要接住。原先只认路由返回体里的 error，
          //    可 fetch 本身失败（服务没起 / 500 / 响应不是 JSON）时这里会抛，
          //    ProTable 只把表清空 —— 屏幕上就变成那句「这段时间没有写操作留痕」，
          //    把一次读失败画成了"库里很干净"。这是本页最不能出的错。
          try {
            const res = await fetch(`/api/audit?${q.toString()}`);
            if (!res.ok) {
              setErr(`HTTP ${res.status} ${res.statusText}（GET /api/audit）`);
              return { data: [], total: 0, success: false };
            }
            const j = (await res.json()) as AuditListResponse;
            setErr(j.ok ? undefined : j.error);
            setActors(j.actors);
            setTools(j.tools);
            return { data: j.data, total: j.total, success: j.ok };
          } catch (e) {
            setErr(
              e instanceof Error
                ? `${e.name}: ${e.message}（GET /api/audit）`
                : String(e),
            );
            return { data: [], total: 0, success: false };
          }
        }}
      />
    </>
  );
}

export default AuditTable;
