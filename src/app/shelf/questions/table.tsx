"use client";

/**
 * 货架题目 · 列表（AI:PRD-009 验收修复 · `/shelf/questions`）
 *
 * 🔴🔴 同名异库：这张表列的是 **punch 库（`举一反三产物/资料库.db`）** 的 question 行
 *      （3230 题 / 15 本册子），**不是**本库题库（那在 /question）。
 *      两边**零交集**（同一口径 hash 实测交集为 0）——
 *      所以这一页**一个跳本库题详情的链接都没有**：指过去就是指到另一本账上。
 * 🔴 本页零写：punch 库物理只读。
 *
 * 🔴 本组件**不 import ~/core**（client 顺着它 import 会把 node:sqlite 打进浏览器包），
 *    数据全部走 `/api/shelf/questions`。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Progress, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmphasisText, EmptyHint } from "~/components/console/ui";
import {
  CALC_COLOR,
  type PunchQuestionView,
  type PunchQuestionsResponse,
} from "../shared";

const 数字: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

interface QueryForm {
  kw?: string;
  qtype?: string;
  kp?: string;
  doc?: string;
}

type Meta = NonNullable<PunchQuestionsResponse["meta"]>;

/** 考点覆盖条：标签轴铺到哪了，一眼看完（对照 punch-console v2 的 CoverageBar） */
function CoverageBar({ meta }: { meta: Meta }) {
  const { tagged, untagged, items } = meta.coverage;
  const total = tagged + untagged;
  const pct = total === 0 ? 0 : Math.round((tagged / total) * 100);
  return (
    <Alert
      type={untagged > 0 ? "warning" : "info"}
      showIcon={false}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          考点覆盖：已标 <span style={数字}>{tagged}</span> /{" "}
          <span style={数字}>{total}</span> 题 · {items.length} 个考点
          <Progress
            percent={pct}
            size="small"
            showInfo={false}
            style={{ maxWidth: 260, marginInlineStart: 10 }}
          />
        </span>
      }
      description={
        <div style={{ fontSize: 12, color: "#606266", lineHeight: 1.9 }}>
          {untagged > 0 ? (
            <div>
              🔴 还有 <span style={数字}>{untagged}</span> 题<b>没打考点</b>{" "}
              ——「没打标」不是「没有考点」：打标是深度处理， 要改得动 punch
              库，本产品对它<b>只读</b>。
            </div>
          ) : null}
          {items.length > 0 ? (
            <div style={{ marginTop: 2 }}>
              {items.slice(0, 30).map((k) => (
                <Tag key={k.value} style={{ marginBottom: 4 }}>
                  {k.value} <span style={数字}>{k.count}</span>
                </Tag>
              ))}
              {items.length > 30 ? (
                <span style={{ color: "#909399" }}>
                  …另有 {items.length - 30} 个考点（用上面的「考点」栏筛）
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

export function ShelfQuestionTable({
  defaultDoc,
  defaultKp,
}: {
  defaultDoc?: string;
  defaultKp?: string;
}) {
  const actionRef = useRef<ActionType>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [meta, setMeta] = useState<Meta | null>(null);

  const columns: ProColumns<PunchQuestionView, "text">[] = [
    {
      title: "关键词",
      dataIndex: "kw",
      hideInTable: true,
      fieldProps: {
        placeholder: "题面里真出现过的字（走 punch 自己的 FTS 索引）",
      },
      tooltip:
        "🔴 走的是 punch 侧那套 bigram 分词的 FTS5（与产线同一把切法）。索引是产线手工同步的，落后于题表时会自动退成 LIKE 逐字包含，并在上方如实说一声",
    },
    {
      title: "题面",
      dataIndex: "stem",
      search: false,
      render: (_, r) => (
        <div style={{ fontSize: 12.5, lineHeight: 1.8, maxWidth: 620 }}>
          <div style={{ wordBreak: "break-word" }}>{r.stem}</div>
          <Space size={[6, 2]} wrap style={{ marginTop: 3 }}>
            {r.qtype ? <Tag>{r.qtype}</Tag> : null}
            {r.kps.map((k) => (
              <Tag key={k} color="blue">
                {k}
              </Tag>
            ))}
            {r.answer ? (
              <Tooltip title={r.answer}>
                <span style={{ fontSize: 11.5, color: "#909399" }}>
                  答案：
                  {r.answer.length > 24
                    ? `${r.answer.slice(0, 24)}…`
                    : r.answer}
                </span>
              </Tooltip>
            ) : (
              <span style={{ fontSize: 11.5, color: "#909399" }}>没记答案</span>
            )}
          </Space>
        </div>
      ),
    },
    {
      title: "出处",
      dataIndex: "docId",
      search: false,
      width: 210,
      render: (_, r) => (
        <div style={{ fontSize: 12 }}>
          {r.docId === null ? (
            <Tooltip title="question.doc_id 是空的 —— 这道题没挂在任何册子上">
              <span style={{ color: "#909399" }}>没挂册</span>
            </Tooltip>
          ) : (
            // 🔴 看到即可达：册子点得进货架详情（这是**货架内**的跳转，不跨账）
            <Link href={`/shelf/doc/${r.docId}`}>
              {r.docName ?? `doc ${r.docId}`}
            </Link>
          )}
          {r.docVersion && r.docVersion !== "正册" ? (
            <span style={{ color: "#909399" }}> · {r.docVersion}</span>
          ) : null}
          <div style={{ color: "#909399", ...数字 }}>
            {r.day === null ? "" : `第 ${r.day} 天 · `}
            {r.section ?? "（无 section）"}
            {r.seq === null ? "" : ` · #${r.seq}`}
          </div>
        </div>
      ),
    },
    {
      title: "实算",
      dataIndex: "calc",
      search: false,
      width: 76,
      render: (_, r) => (
        <Tooltip title="punch 侧的机器实算态：绿 = 程序验算过；红 = 算出来对不上；未算 = 没跑过（不是坏）">
          <Tag color={CALC_COLOR[r.calc ?? "未算"] ?? "default"}>
            {r.calc ?? "未算"}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: "题号",
      dataIndex: "id",
      search: false,
      width: 82,
      render: (_, r) => (
        <Tooltip
          title={`punch 库 question.id=${r.id}（🔴 与本库题的 ULID 不是一个体系）`}
        >
          <span style={{ fontFamily: "Consolas, Menlo, monospace", ...数字 }}>
            q{r.id}
          </span>
        </Tooltip>
      ),
    },
    // ── 只用于搜索区的三个筛选维（列本身不显示）
    {
      title: "题型",
      dataIndex: "qtype",
      hideInTable: true,
      valueType: "select",
      fieldProps: { placeholder: "不选=全部题型", showSearch: true },
      valueEnum: Object.fromEntries(
        (meta?.qtypes ?? []).map((f) => [
          f.value,
          { text: `${f.value}（${f.count}）` },
        ]),
      ),
      tooltip:
        "🔴 punch 侧 题型/section 两栏口径混乱（英文 oral/vert/step/app 与中文小节名并存）—— 如实照列，归一化要改它的库",
    },
    {
      title: "考点",
      dataIndex: "kp",
      hideInTable: true,
      valueType: "select",
      fieldProps: { placeholder: "不选=全部（含没打标的）", showSearch: true },
      valueEnum: Object.fromEntries(
        (meta?.coverage.items ?? []).map((f) => [
          f.value,
          { text: `${f.value}（${f.count}）` },
        ]),
      ),
    },
    {
      title: "册",
      dataIndex: "doc",
      hideInTable: true,
      valueType: "select",
      fieldProps: { placeholder: "不选=全部册", showSearch: true },
      valueEnum: Object.fromEntries(
        (meta?.docs ?? []).map((d) => [
          d.value,
          {
            text: `${d.name}${d.version && d.version !== "正册" ? `·${d.version}` : ""}（${d.count}）`,
          },
        ]),
      ),
    },
  ];

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="货架题目取不出来（原文照登）"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {err}
            </span>
          }
        />
      ) : null}
      {meta && meta.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="这次检索里发生的事（一条不吞）"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {meta.warnings.map((w, i) => (
                <div key={i}>
                  · <EmphasisText text={w} />
                </div>
              ))}
            </div>
          }
        />
      ) : null}
      {meta ? <CoverageBar meta={meta} /> : null}

      <ProTable<PunchQuestionView, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        cardBordered
        columns={columns}
        scroll={{ x: 900 }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{
          initialValues: {
            ...(defaultDoc ? { doc: defaultDoc } : {}),
            ...(defaultKp ? { kp: defaultKp } : {}),
          },
        }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            货架题目
            <span
              style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
            >
              punch 库（{meta?.dbPath ?? "还没取数"}，mode=ro）· 共{" "}
              {meta?.filteredTotal ?? "—"} 题在当前条件下 ·{" "}
              {meta ? `${meta.ms}ms` : ""}
            </span>
          </span>
        }
        pagination={false}
        locale={{
          emptyText: err ? (
            <EmptyHint>
              这张表是<b>空的，因为没读出来</b>，不是「没有题」——
              上面那条红色错误里是原文。
            </EmptyHint>
          ) : (
            <EmptyHint>
              这组条件下零命中。🔴 「没搜到」不等于「货架上没有这种题」：
              关键词走的是<b>字面</b>（题面里真出现过那几个字才算），
              考点栏筛的是<b>打过标的</b>
              那部分（还有一批题没打标，见上面的覆盖条）。
              <br />
              先放宽：去掉题型/册，或把关键词换成题面里真会出现的字。
            </EmptyHint>
          ),
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          if (params.kw) q.set("kw", params.kw.trim());
          if (params.qtype) q.set("qtype", params.qtype);
          if (params.kp) q.set("kp", params.kp);
          if (params.doc) q.set("doc", params.doc);
          q.set("limit", "200");
          // 🔴 三种失败都要上墙（检查单 §三·2）：① ok:false；② HTTP 非 2xx
          //    （body 常是 HTML，json() 抛看不懂的 SyntaxError）；③ fetch 自己抛。
          //    ②③ 不 catch 会被 ProTable 吞成一张空表 —— 在这一页，空表长得
          //    就像「货架上没有这种题」，而真相可能只是 PUNCH_DB_URL 没配。
          try {
            const res = await fetch(`/api/shelf/questions?${q.toString()}`);
            if (!res.ok) {
              throw new Error(
                `GET /api/shelf/questions 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            const j = (await res.json()) as PunchQuestionsResponse;
            setMeta(j.meta);
            setErr(
              j.ok ? undefined : (j.error ?? "接口返回 ok=false，但没给原因"),
            );
            return { data: j.data, total: j.total, success: true };
          } catch (e) {
            setMeta(null);
            setErr(
              `货架题目没取回来（不是「没有题」）：${
                e instanceof Error ? `${e.name}: ${e.message}` : String(e)
              }`,
            );
            return { data: [], total: 0, success: true };
          }
        }}
      />
    </>
  );
}

export default ShelfQuestionTable;
