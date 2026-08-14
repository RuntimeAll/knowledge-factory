"use client";

/**
 * 学员名册 · 三段式列表（AI:PRD-008 · P2 · 设计稿 §二·11）
 *
 * 职责：代号名册 + 每人一行的概览。**不管**学情明细（那是 /student/[code]）、
 * 也不管建名册（upsertRoster 是 agent/MCP 的活，页面白名单五类里没有它）。
 *
 * 🔴 全代号，无真名：表里一列真名字段都没有，工具栏那句提示常驻提醒。
 * 🔴 挂桥覆盖 2/4 是**带色**的：全挂上=绿，一个都没挂=红，挂一半=橙。
 *    覆盖不全 ≠ 没数据：那几卷的分数照给（圣域里有），只是算不到考点上。
 * 🔴 本组件零业务逻辑：条件丢给 `/api/student`，那头调 core 的
 *    listRoster / bridgeBatches / getStudentView（与 MCP student_view 同一个入口）。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmptyHint, TimeText } from "~/components/console/ui";
import type { StudentListResponse, StudentRosterRow } from "./shared";

interface QueryForm {
  status?: string;
}

/** 数字列一律等宽数字（🔴 检查单 §三·3：竖着比大小的数，字宽不一样就比不了） */
const 数字: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** 覆盖 2/4：全挂=绿 / 全没挂=红 / 一半=橙（0 个批次是灰，那是「还没交过卷」） */
function 覆盖色(matched: number, total: number): string {
  if (total === 0) return "default";
  if (matched === total) return "green";
  if (matched === 0) return "red";
  return "orange";
}

function 得分文本(r: StudentRosterRow): string {
  const s = r.lastScore;
  if (!s) return "—";
  const pct = s.total === 0 ? null : Math.round((s.ok / s.total) * 100);
  return `${s.ok}/${s.total}${pct === null ? "" : ` · ${pct}%`}`;
}

export function StudentTable() {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<StudentListResponse | null>(null);

  const columns: ProColumns<StudentRosterRow, "text">[] = [
    {
      title: "名册状态",
      dataIndex: "status",
      hideInTable: true,
      valueType: "select",
      valueEnum: {
        active: { text: "active（在读）" },
        paused: { text: "paused（暂停）" },
        closed: { text: "closed（结课）" },
      },
      fieldProps: { placeholder: "不选=名册 ∪ 圣域全部代号" },
      tooltip:
        "状态只有名册里才有。一旦筛状态，圣域里没登记名册的代号会落选（表格上方会说一声）",
    },
    {
      title: "代号",
      dataIndex: "code",
      search: false,
      width: 170,
      render: (_, r) => (
        <Space size={4}>
          <Link href={`/student/${encodeURIComponent(r.code)}`}>
            <b>{r.code}</b>
          </Link>
          {r.inRoster ? null : (
            <Tooltip title="圣域里有他的批次，roster 里却没有这个代号 —— 学情照常算（事实全在圣域），但选题台/交付指向拿不到年级与版本上下文。补登记走 upsertRoster（agent/MCP），页面上不做。">
              <Tag color="orange">未登记名册</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "年级 / 版本语境",
      dataIndex: "grade",
      search: false,
      width: 150,
      render: (_, r) =>
        r.inRoster ? (
          <span style={{ fontSize: 12.5 }}>
            {r.grade ?? "—"} · {r.editionCtx ?? "版本未声明"}
          </span>
        ) : (
          <span style={{ color: "#909399", fontSize: 12.5 }}>名册没这一行</span>
        ),
    },
    {
      title: "批次数",
      dataIndex: "batches",
      search: false,
      width: 78,
      render: (_, r) => <span style={数字}>{r.batches}</span>,
    },
    {
      title: "挂桥覆盖",
      dataIndex: "matched",
      search: false,
      width: 100,
      tooltip:
        "挂上桥的批次 / 全部批次。挂不上桥 ≠ 没数据：分数照给，只是算不到考点上（perKp 不含它们）",
      render: (_, r) => (
        <Tag color={覆盖色(r.matched, r.batches)} style={数字}>
          {r.matched}/{r.batches}
        </Tag>
      ),
    },
    {
      title: "最近打卡",
      dataIndex: "lastAt",
      search: false,
      width: 210,
      // 🔴 「最近」= 批次号最大的那一批（圣域自增，序等价），与详情页那张批次表同一把尺子。
      //    不按 exported_at 挑：批完还没出件的批次 exported_at 是空的，
      //    按时间挑会把它当成最早、悄悄显示上一次的旧卷（见 /api/student 的 取最近）。
      tooltip:
        "最近 = 批次号最大的那一批（与详情页批次表同序）。出件时间只是展示：为空就是「批完还没出件」，不拿旧批次顶上",
      // 🔴 检查单 §三·4 看到即可达：批次号 b<id> 原来是死字 ——
      //    名册上看见「最近这一批」，却要自己去看板里翻它。有 day 就直接点进终审页。
      render: (_, r) =>
        r.lastBatchId === null ? (
          <span style={{ color: "#909399" }}>还没交过卷</span>
        ) : (
          <span style={{ fontSize: 12.5 }}>
            {r.lastAt === null ? (
              <Tooltip title="这一批的 exported_at 是空的 = 批完了还没出件。它仍是最新的一批，所以这里不显示上一批的时间">
                <span style={{ color: "#e6a23c" }}>还没出件</span>
              </Tooltip>
            ) : (
              <TimeText iso={r.lastAt} />
            )}
            {r.lastDay === null ? (
              <span style={{ color: "#909399", ...数字 }}>
                {" "}
                · b{r.lastBatchId}
              </span>
            ) : (
              <Link
                href={`/grading/review/${encodeURIComponent(r.code)}/${r.lastDay}`}
                title="进终审台看这一批的逐题判定"
                style={数字}
              >
                {" "}
                · b{r.lastBatchId} · 第 {r.lastDay} 次
              </Link>
            )}
            <div style={{ color: "#909399" }}>
              {r.lastLine ?? "线名未知（这批没挂上桥）"}
            </div>
          </span>
        ),
    },
    {
      title: "最近得分",
      dataIndex: "lastScore",
      search: false,
      width: 150,
      tooltip:
        "🔴 题数口径：分母 = 判定行数 − skip（漏抄整条摘掉），所以是 16/19 而不是 16/20",
      render: (_, r) =>
        r.lastScore === null ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : r.lastMatched ? (
          <Tag color="green" style={数字}>
            {得分文本(r)}
          </Tag>
        ) : (
          <Tooltip title="这一批没挂上桥：分数是从圣域直接数出来的，算不到考点上（详情页「未挂原因」列有原文）">
            <Tag style={数字}>{得分文本(r)}（无桥）</Tag>
          </Tooltip>
        ),
    },
    {
      title: "读数",
      dataIndex: "loadError",
      search: false,
      width: 120,
      render: (_, r) =>
        r.loadError ? (
          <Tooltip title={r.loadError}>
            <Tag color="red">这行算不出来</Tag>
          </Tooltip>
        ) : (
          <span style={{ color: "#909399", fontSize: 12 }}>现算</span>
        ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 150,
      fixed: "right",
      // 🔴 看到即可达：名册是「人」的入口，他的批次流水与已出件报告都该一步可达
      render: (_, r) => [
        <Link key="view" href={`/student/${encodeURIComponent(r.code)}`}>
          学情详情
        </Link>,
        <Link
          key="board"
          href={`/grading/board?code=${encodeURIComponent(r.code)}`}
          title="看这个学员的全部批次流水（收件 → 出件）"
        >
          批次
        </Link>,
        <Link
          key="reports"
          href={`/grading/reports?code=${encodeURIComponent(r.code)}`}
          title="看这个学员已出件的报告 PNG"
        >
          报告
        </Link>,
      ],
    },
  ];

  return (
    <>
      {meta && !meta.ok ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="名册读不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{meta.error}</span>}
        />
      ) : null}
      {meta?.ok ? (
        <Alert
          type={
            meta.strayCount > 0 || meta.warnings.length > 0 ? "warning" : "info"
          }
          showIcon={meta.strayCount > 0}
          style={{ marginBottom: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              名册登记 {meta.rosterCount} 人 · 表里 {meta.total} 行（其中{" "}
              {meta.strayCount} 个代号只在圣域出现过）· 全库挂桥覆盖{" "}
              {meta.coverage.matched}/{meta.coverage.total}（
              {meta.coverage.rate}
              ）· {meta.ms}ms
            </span>
          }
          description={
            meta.warnings.length > 0 ? (
              <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                {meta.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            ) : null
          }
        />
      ) : null}

      <ProTable<StudentRosterRow, QueryForm>
        actionRef={actionRef}
        rowKey="code"
        size="small"
        cardBordered
        columns={columns}
        scroll={{ x: 1140 }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="学员名册"
        locale={{
          // 🔴 取数失败时不许再说「名册与圣域都没有代号」（检查单 §三·2/§三·6）
          emptyText:
            meta && !meta.ok ? (
              <EmptyHint>
                这张表是<b>空的，因为没读出来</b>，不是「没有学员」——
                上面那条红色错误里是原文。
              </EmptyHint>
            ) : (
              <EmptyHint>
                名册与圣域都没有代号 ——
                这不是「没有学员」，是「还没有人交过卷、也没人登记过名册」。
                登记走 upsertRoster（🔴 只落代号，不落真名），收卷走批改线。
              </EmptyHint>
            ),
        }}
        toolBarRender={() => [
          <span key="anon" style={{ fontSize: 12, color: "#909399" }}>
            🔴 全代号：本页与 roster 表都没有真名字段
          </span>,
        ]}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          if (params.status) q.set("status", params.status);
          // 🔴 三种失败都要上墙（检查单 §三·2）：① ok:false；② HTTP 非 2xx
          //    （body 常是 HTML，json() 抛看不懂的 SyntaxError）；③ fetch 自己抛。
          //    **②③ 不 catch 的话 ProTable 吞成一张「名册与圣域都没有代号」的空表**
          //    —— 这一页原来连 setErr 都没有，读失败在屏幕上完全没有痕迹。
          //    这里合成一份 ok:false 的 meta，顶上那条红条与空态文案一起改口。
          try {
            const res = await fetch(`/api/student?${q.toString()}`);
            if (!res.ok) {
              throw new Error(
                `GET /api/student 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            const j = (await res.json()) as StudentListResponse;
            setMeta(j);
            return { data: j.data, total: j.total, success: true };
          } catch (e) {
            setMeta({
              ok: false,
              error: `名册没取回来（不是「没有学员」）：${
                e instanceof Error ? `${e.name}: ${e.message}` : String(e)
              }`,
              data: [],
              total: 0,
              rosterCount: 0,
              strayCount: 0,
              coverage: { matched: 0, total: 0, rate: "—" },
              ms: 0,
              warnings: [],
            });
            return { data: [], total: 0, success: true };
          }
        }}
      />
    </>
  );
}

export default StudentTable;
