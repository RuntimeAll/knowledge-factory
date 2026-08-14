"use client";

/**
 * 考察模型 · 三段式列表（AI:PRD-008 · P2 · 设计稿 §二·9）
 *
 * 职责：exam_model 的台账 —— 每个模型出过多少题、指回哪个生成器文件。
 * **不管**建模（propose_model 走 MCP，工具栏给命令提示）。
 * 🔴 转正**不是 MCP 工具**（MCP 表面没有 activate_model 这个名字）：它是
 *    「处置台点通过」这个人的动作 —— 那条链走 core 的 activateModel（模型 active +
 *    工单 passed，单事务）。本页只把人指过去，不编一个不存在的工具名。
 *
 * 🔴 「生成器文件」那一列是**真去盘上查过**的（existsSync，见 /api/models）：
 *    ✓ 在盘 / ✗ 不在盘 / 没记 dsl_ref 三态分明 —— 模型指不回生成器，
 *    「照这个模型再出一批题」就无从谈起，这是本页存在的头号理由。
 * 🔴 「看题」跳题目管理并按**该模型的归位考点**筛：
 *    core 的检索硬过滤**没有 model_id 这一维**，所以它不等于「本模型出的题」——
 *    列头与悬停都写明了，不含糊过去。（要看真·本模型出的题，走「族谱」。）
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
import {
  dslShortName,
  type ModelListMeta,
  type ModelListResponse,
  type ModelRow,
} from "./shared";

interface QueryForm {
  name?: string;
  status?: string;
  onDisk?: string;
}

export interface ModelTableProps {
  /** 枚举正本在 core（MODEL_STATUSES），server 页面读出来传进来 */
  statuses: readonly string[];
}

function toEnum(list: readonly string[]): Record<string, { text: string }> {
  return Object.fromEntries(list.map((v) => [v, { text: v }]));
}

function MetaBar({
  meta,
  error,
}: {
  meta: ModelListMeta | null;
  error?: string;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="模型列不出来（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;

  const notes: string[] = [];
  if (meta.windowFilters.length > 0) {
    notes.push(
      `${meta.windowFilters.join("、")} 是在取回的 ${meta.listed} 条里过滤的` +
        "（core 的 listModels 只吃考点/状态两维），总数按这个窗口算",
    );
  }
  if (meta.capped) {
    notes.push(
      `已经取到 listModels 的上限 ${meta.cap} 条 —— 更多的模型这一页看不到。`,
    );
  }

  return (
    <Alert
      type={meta.capped ? "warning" : "info"}
      showIcon={meta.capped}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          窗口 {meta.listed} 条 · 筛出 {meta.filtered} 条 · 逐条读卡补
          考点名/出题数/母题数 · {meta.ms}ms
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

export function ModelTable(props: ModelTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<ModelListMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const columns: ProColumns<ModelRow, "text">[] = [
    {
      title: "模型名",
      dataIndex: "name",
      sorter: true,
      width: 240,
      // 🔴 模型名会长过一列（「绝对值几何意义·两点距离型」这种）：截断 + 悬停全名
      ellipsis: true,
      tooltip: "窗口内按「包含」匹配模型名或考点名",
      fieldProps: { placeholder: "绝对值 / 合并同类项" },
      render: (_, r) => (
        <Tooltip title={r.name} styles={{ root: { maxWidth: 520 } }}>
          <Link href={`/model/${r.id}`} style={{ color: "inherit" }}>
            <span style={{ fontSize: 12.5 }}>{r.name}</span>
          </Link>
        </Tooltip>
      ),
    },
    {
      title: "归位考点",
      dataIndex: "kpName",
      sorter: true,
      search: false,
      width: 220,
      ellipsis: true,
      render: (_, r) =>
        r.kpName ? (
          <Tooltip title={`${r.kpName}（kp_id = ${r.kpId}）· 点进考点详情`}>
            <Link href={`/kg/kp/${r.kpId}`}>
              <Tag color="blue">{r.kpName}</Tag>
            </Link>
          </Tooltip>
        ) : (
          <Tooltip title={`kp_id = ${r.kpId}（考点名没读出来）`}>
            <Tag>考点名未取到</Tag>
          </Tooltip>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      sorter: true,
      width: 100,
      valueType: "select",
      valueEnum: toEnum(props.statuses),
      tooltip:
        "proposed=提议中（等转正工单） / active=已转正 / deprecated=已弃用",
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => (
        <span>
          <StatusTag value={r.status} />
          {r.openQueueId ? (
            <Tooltip title={`还开着一张转正工单：${r.openQueueId}`}>
              <Link href="/queue?tab=other">
                <Tag color="orange">待审</Tag>
              </Link>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      title: "出题数",
      dataIndex: "questionCount",
      sorter: true,
      search: false,
      width: 76,
      align: "right",
      tooltip: "question.model_id 指向它的题有多少道",
      render: (_, r) =>
        r.questionCount === 0 ? (
          <Tooltip title="这个模型还没生成过题（或者生成的题没回填 model_id）">
            <span
              style={{ color: "#909399", fontVariantNumeric: "tabular-nums" }}
            >
              0
            </span>
          </Tooltip>
        ) : (
          // 🔴 看到即可达：出题数点进族谱（那一页才列得出「是哪几道」）
          <Tooltip title="点进族谱看这些题是哪几道（经母题的血缘查出来）">
            <Link
              href={`/model/${r.id}`}
              style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}
            >
              {r.questionCount}
            </Link>
          </Tooltip>
        ),
    },
    {
      title: "母题",
      dataIndex: "originCount",
      sorter: true,
      search: false,
      width: 64,
      align: "right",
      tooltip:
        "origin_qids_json：这个模型是从哪几道真题归纳出来的。0 = 没记，族谱到此断链",
      render: (_, r) =>
        r.originCount === 0 ? (
          <Tooltip title="没记母题：族谱从母题侧进不去（详见族谱页那条警告）">
            <span
              style={{ color: "#909399", fontVariantNumeric: "tabular-nums" }}
            >
              0
            </span>
          </Tooltip>
        ) : (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {r.originCount}
          </span>
        ),
    },
    {
      title: "难度",
      dataIndex: "difficulty",
      sorter: true,
      search: false,
      width: 60,
      align: "right",
      render: (_, r) =>
        r.difficulty === null ? (
          <Tooltip title="这个模型还没打难度档">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ) : (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {r.difficulty}
          </span>
        ),
    },
    {
      title: "生成器文件",
      dataIndex: "onDisk",
      sorter: true,
      width: 230,
      valueType: "select",
      valueEnum: {
        yes: { text: "✓ 在盘" },
        no: { text: "✗ 不在盘" },
        none: { text: "没记 dsl_ref" },
      },
      tooltip:
        "dsl_ref 指的文件此刻在不在盘上（existsSync，切掉 #函数名 那截再查）",
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) => {
        if (r.dslOnDisk === null) {
          return (
            <Tooltip title="exam_model.dsl_ref 是空的 —— 这个模型指不回任何生成器，「照它再出一批题」无从谈起">
              <span style={{ color: "#e6a23c" }}>没记 dsl_ref</span>
            </Tooltip>
          );
        }
        // 片段里常常是一串函数名（`#T1_absx,T1_absabs,…`），列里只露第一个
        const 首函数 = (r.dslFragment ?? "").split(",")[0] ?? "";
        return (
          <Tooltip
            title={`${r.dslRef ?? ""}\n${
              r.dslOnDisk ? "此刻在盘上" : "🔴 此刻不在盘上（搬走了？删了？）"
            }`}
            styles={{ root: { maxWidth: 560 } }}
          >
            <span style={{ fontSize: 12 }}>
              <Tag color={r.dslOnDisk ? "green" : "red"}>
                {r.dslOnDisk ? "✓ 在盘" : "✗ 不在盘"}
              </Tag>
              <span style={{ fontFamily: "Consolas, Menlo, monospace" }}>
                {dslShortName(r.dslFile)}
                {首函数 ? `#${首函数}…` : ""}
              </span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "转正时间",
      dataIndex: "activatedAt",
      sorter: true,
      search: false,
      width: 106,
      render: (_, r) => <TimeText iso={r.activatedAt} />,
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
      width: 120,
      fixed: "right",
      render: (_, r) => [
        <Link key="lineage" href={`/model/${r.id}`}>
          族谱
        </Link>,
        <Tooltip
          key="q"
          title="跳题目管理，按「该模型的归位考点」筛 —— 🔴 core 的硬过滤没有 model_id 这一维，所以这不等于「本模型出的题」（那个看「族谱」）"
        >
          <Link href={`/question?kp=${r.kpId}`}>看题</Link>
        </Tooltip>,
      ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<ModelRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1340 }}
        columnsState={{
          persistenceKey: "kf-model-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="模型列表"
        locale={{
          emptyText: (
            <EmptyHint>
              没有符合条件的模型。🔴
              模型是「归纳出来的出题法」，不是自动长出来的：建模走 MCP 的
              propose_model，转正要人在
              <Link href="/queue?tab=other">处置台</Link>点通过。
            </EmptyHint>
          ),
        }}
        toolBarRender={() => [
          // 🔴 2026-08-14 修：MCP 表面上**没有** activate_model —— 转正是**人在处置台点**
          //    （处置台的「模型转正」工单走 core 的 activateModel 单事务：模型 active + 工单关）。
          //    页面只给真存在的那一步命令，转正那一步给链接，不给假工具名。
          <CopyCmd
            key="propose"
            label="建模走 MCP 的 propose_model（转正另说，见右）"
            cmd={
              'propose_model {"kp":"<考点名/别名>","name":"<模型名>",' +
              '"dsl_ref":"<册>/_源/qbank.py#类名或函数名"}'
            }
          />,
          <span key="how" style={{ fontSize: 12, color: "#909399" }}>
            转正 = 人在
            <Link href="/queue?tab=other">处置台「其他工单」</Link>
            点通过（提议者不给自己发批准）
          </span>,
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
          if (params.status) q.set("status", params.status);
          if (params.onDisk) q.set("onDisk", params.onDisk);

          // 🔴 路由名是 exam-models 不是 models：仓根 .gitignore 里有一条
          //    **未加锚点**的 `models/`（本意是拦 95MB 的 ONNX 模型目录），
          //    它会把任何一层的 `models/` 一起吞掉 —— `src/app/api/models/`
          //    在 `git status` 里根本不出现，提交时静默丢文件。改名绕开。
          // 🔴 排序丢给服务端（本表是服务端切片的，前端排只会排当前这一页）
          const [sf, so] = Object.entries(sort ?? {})[0] ?? [];
          if (sf && so) {
            q.set("sort", sf);
            q.set("order", so === "ascend" ? "asc" : "desc");
          }

          // 🔴 三种失败都要上墙（与 /sku 同一写法）：ok:false / HTTP 非 2xx /
          //    fetch 抛。后两种不 catch 会被 ProTable 吞成「暂无数据」的空表 ——
          //    「查过了没有」与「根本没查成」必须分得开。
          try {
            const res = await fetch(`/api/exam-models?${q.toString()}`);
            if (!res.ok) {
              throw new Error(
                `GET /api/exam-models 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            const j = (await res.json()) as ModelListResponse;
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
    </>
  );
}

export default ModelTable;
