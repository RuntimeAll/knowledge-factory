"use client";

/**
 * 错因管理 · 三块面板（AI:PRD-008 · P2 · 设计稿 §二·13）
 *
 * 上 = error_cause 实体表 ｜ 中 = err_code_map 复合键映射表 ｜ 下 = unmapped 红旗队列。
 *
 * 🔴 写操作只有一类（白名单五类之一「补错因映射」），而且**全部走确认页**：
 *    列表上的按钮只是链接，真正的写在 `/cause/map`（补映射）与 `/cause/remap`
 *    （改指 / 摘除）上按第二次才发生。错因实体的建/退役页面不做（agent/MCP 的活）。
 * 🔴 unmapped = 0 时给绿横幅，但**必须同时印覆盖口径**：0 条红旗只覆盖挂上桥的
 *    批次，不等于「所有错都有归因」。「没有数据」不是「没有错误」。
 * 🔴 err_code_map 表里没有「据」这一列 —— 本页那一栏摆的是能指得回去的东西：
 *    谁在什么时候定的（mapped_by / mapped_at）+ 错因实体的来源正本（seed_code）。
 */
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Alert, Button, Card, Tag, Tooltip } from "antd";
import Link from "next/link";

import { EmptyHint, StatusTag, TimeText } from "~/components/console/ui";
import type {
  CauseEntityRow,
  CausePanelsProps,
  ErrCodeMapRow,
  UnmappedRow,
} from "./shared";

const MONO: React.CSSProperties = {
  fontFamily: "Consolas, Menlo, monospace",
  fontSize: 12.5,
};
const 灰: React.CSSProperties = { color: "#909399" };

/** 从数据里现推的列筛选项（不写死字典：码/错因都会长） */
function 选项(values: string[]): { text: string; value: string }[] {
  return [...new Set(values)].sort().map((v) => ({ text: v, value: v }));
}

export function CausePanels(props: CausePanelsProps) {
  const 实体列: ProColumns<CauseEntityRow>[] = [
    {
      title: "错因实体",
      dataIndex: "name",
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          <b>{r.name}</b>
          {r.desc ? <div style={灰}>{r.desc}</div> : null}
        </div>
      ),
    },
    {
      title: "来源正本（seed_code）",
      dataIndex: "seedCode",
      width: 240,
      render: (_, r) =>
        r.seedCode ? (
          <span style={MONO}>{r.seedCode}</span>
        ) : (
          <span style={灰}>没写来源 —— 这条错因指不回任何正本</span>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 84,
      render: (_, r) => <StatusTag value={r.status} />,
    },
    {
      title: "挂载考点",
      dataIndex: "kps",
      width: 90,
      sorter: (a, b) => a.kps - b.kps,
      render: (_, r) => <span>{r.kps}</span>,
    },
    {
      title: "诊断例题",
      dataIndex: "examples",
      width: 118,
      sorter: (a, b) => a.examples - b.examples,
      render: (_, r) =>
        r.examples >= 2 ? (
          <span>{r.examples}</span>
        ) : (
          <Tooltip title="M1 口径 ≥2 道。🔴 软闸：不拦，但少于两道就讲不清「这类错长什么样」。补例题走 addCauseExample（agent/MCP）">
            <Tag color="orange">{r.examples} · 不足 2</Tag>
          </Tooltip>
        ),
    },
    {
      title: "码映射",
      dataIndex: "errCodes",
      width: 90,
      sorter: (a, b) => a.errCodes - b.errCodes,
      render: (_, r) => <span>{r.errCodes}</span>,
    },
  ];

  const 映射列: ProColumns<ErrCodeMapRow>[] = [
    {
      title: "考点",
      dataIndex: "kpName",
      filters: 选项(props.maps.map((m) => m.kpName)),
      onFilter: (v, r) => r.kpName === v,
      render: (_, r) => <Link href={`/kg/kp/${r.kpId}`}>{r.kpName}</Link>,
    },
    {
      title: "码",
      dataIndex: "errCode",
      width: 110,
      filters: 选项(props.maps.map((m) => m.errCode)),
      onFilter: (v, r) => r.errCode === v,
      render: (_, r) => <span style={MONO}>{r.errCode}</span>,
    },
    {
      title: "错因实体",
      dataIndex: "causeName",
      width: 300,
      filters: 选项(props.maps.map((m) => m.causeName)),
      onFilter: (v, r) => r.causeName === v,
      render: (_, r) => (
        <span style={{ fontSize: 12.5 }}>
          {r.causeName}
          {r.causeStatus === "active" ? null : (
            <StatusTag value={r.causeStatus} />
          )}
        </span>
      ),
    },
    {
      title: "据（谁定的 · 来源正本）",
      dataIndex: "mappedBy",
      width: 250,
      render: (_, r) => (
        <div style={{ fontSize: 12 }}>
          <span>{r.mappedBy ?? "没记谁定的"}</span> ·{" "}
          <TimeText iso={r.mappedAt} />
          <div style={{ ...灰, ...MONO, fontSize: 11.5 }}>
            {r.causeSeedCode ?? "错因没写 seed_code"}
          </div>
        </div>
      ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 120,
      fixed: "right",
      render: (_, r) => [
        <Link
          key="remap"
          href={`/cause/remap?kp=${encodeURIComponent(r.kpId)}&code=${encodeURIComponent(r.errCode)}`}
        >
          改指 / 摘除…
        </Link>,
      ],
    },
  ];

  const 红旗列: ProColumns<UnmappedRow>[] = [
    {
      title: "考点",
      dataIndex: "kpName",
      render: (_, r) => <Link href={`/kg/kp/${r.kpId}`}>{r.kpName}</Link>,
    },
    {
      title: "码",
      dataIndex: "errCode",
      width: 110,
      render: (_, r) => <span style={MONO}>{r.errCode}</span>,
    },
    {
      title: "码次",
      dataIndex: "count",
      width: 80,
      sorter: (a, b) => a.count - b.count,
    },
    {
      title: "样本（指得回去）",
      dataIndex: "samples",
      render: (_, r) => (
        <span style={{ ...MONO, fontSize: 12 }}>{r.samples.join("、")}</span>
      ),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 110,
      fixed: "right",
      render: (_, r) => [
        <Link
          key="map"
          href={`/cause/map?kp=${encodeURIComponent(r.kpId)}&code=${encodeURIComponent(r.errCode)}`}
        >
          去补映射
        </Link>,
      ],
    },
  ];

  return (
    <>
      {props.err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{props.err}</span>}
        />
      ) : null}
      {props.ok ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{props.ok}</span>}
        />
      ) : null}

      {/* ── ③ 红旗先摆（它是工作队列，不是附录）───────────────────────── */}
      {props.unmapped.length === 0 ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              unmapped = 0 —— 展开的每一组 (考点, 码) 都查得到映射（本次样本{" "}
              {props.sampleCodes} 个码次）
            </span>
          }
          description={
            <span style={{ fontSize: 12.5 }}>
              🔴 但这只覆盖<b>挂上桥的批次</b>（{props.coverage.matched}/
              {props.coverage.total}，{props.coverage.rate}）：没挂上桥的卷子
              一个码都算不进来。「没有数据」不是「没有错误」。
            </span>
          }
        />
      ) : (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              🔴 {props.unmapped.length} 组 (考点, 码) 查不到 err_code_map
              映射，共 {props.unmapped.reduce((s, x) => s + x.count, 0)} 个码次
              —— 它们没有被静默丢掉，全在下面第三张表里（带 batch/qno 样本）
            </span>
          }
          description={
            <span style={{ fontSize: 12.5 }}>
              处置：给这些 (考点, 码) 铺映射（下表「去补映射」），
              或确认这个码在这个考点下确实没有语义 —— 那就让它继续红着，
              红旗本身就是「这里还没想清楚」的记账。
            </span>
          }
        />
      )}

      {props.warnings.length > 0 ? (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={<span style={{ fontSize: 12.5 }}>取数时的如实提示</span>}
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {props.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          }
        />
      ) : null}

      {/* ── ① error_cause ─────────────────────────────────────────────── */}
      <ProTable<CauseEntityRow>
        rowKey="causeId"
        size="small"
        cardBordered
        search={false}
        options={{ reload: false, density: true, setting: true }}
        columns={实体列}
        dataSource={props.causes}
        scroll={{ x: 900 }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            ① 错因实体 error_cause
            <span style={{ ...灰, marginInlineStart: 8, fontSize: 12 }}>
              一句话能说清「错在哪」的那个东西；建/退役走 agent/MCP，页面只读
            </span>
          </span>
        }
        locale={{
          emptyText: (
            <EmptyHint>
              错因域一个实体都没有 —— 于是所有码都会进 unmapped
              红旗。这是「种子还没灌」的诚实形态，不是故障。
            </EmptyHint>
          ),
        }}
        pagination={{ defaultPageSize: 20, pageSizeOptions: [10, 20, 50, 100] }}
        style={{ marginBottom: 12 }}
      />

      {/* ── ② err_code_map ────────────────────────────────────────────── */}
      <ProTable<ErrCodeMapRow>
        rowKey={(r) => `${r.kpId}|${r.errCode}`}
        size="small"
        cardBordered
        search={false}
        options={{ reload: false, density: true, setting: true }}
        columns={映射列}
        dataSource={props.maps}
        scroll={{ x: 1100 }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            ② 码映射 err_code_map（🔴 复合键 = 考点 + 码）
            <span style={{ ...灰, marginInlineStart: 8, fontSize: 12 }}>
              同一个
              dist：挂「简便技巧」下是运算律简算，挂「去括号法则」下是漏变号 ——
              单键表会把两种能力并成一个数
            </span>
          </span>
        }
        toolBarRender={() => [
          <Link key="new" href="/cause/map">
            <Button size="small" type="primary" ghost>
              + 补映射
            </Button>
          </Link>,
        ]}
        locale={{
          emptyText: (
            <EmptyHint>
              一条映射都没有 —— 错因分布必然全空、所有码都进 unmapped。
              这是「种子还没灌」的诚实形态，不是故障。
            </EmptyHint>
          ),
        }}
        pagination={{ defaultPageSize: 20, pageSizeOptions: [10, 20, 50, 100] }}
        style={{ marginBottom: 12 }}
      />

      {/* ── ③ unmapped 队列 ───────────────────────────────────────────── */}
      <ProTable<UnmappedRow>
        rowKey={(r) => `${r.kpId}|${r.errCode}`}
        size="small"
        cardBordered
        search={false}
        options={{ reload: false, density: false, setting: false }}
        columns={红旗列}
        dataSource={props.unmapped}
        scroll={{ x: 900 }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            ③ unmapped 红旗队列
            <span style={{ ...灰, marginInlineStart: 8, fontSize: 12 }}>
              展开后 (考点, 码) 在 err_code_map 里查不到的 ——
              这里空着才是好事，但空着不代表没有错
            </span>
          </span>
        }
        locale={{
          emptyText: (
            <EmptyHint>
              队列空 —— 挂上桥的这些批次里，每一个码都翻译得出错因。 🔴
              覆盖口径见页顶那条绿横幅：没挂上桥的卷子不在这个样本面里。
            </EmptyHint>
          ),
        }}
        pagination={false}
        style={{ marginBottom: 12 }}
      />

      <Card size="small" title="判定口径（core 的原句，一个字不改）">
        <div style={{ fontSize: 12, ...灰, lineHeight: 1.9 }}>
          {props.rubric.map((s, i) => (
            <div key={i}>· {s}</div>
          ))}
        </div>
      </Card>
    </>
  );
}

export default CausePanels;
