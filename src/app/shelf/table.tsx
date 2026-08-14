"use client";

/**
 * 资料货架 · 列表（AI:PRD-009 · D-B 第一页 `/shelf`）
 *
 * 🔴🔴 同名异库：这张表列的是 **punch 库（`举一反三产物/资料库.db`）** 的 doc 行，
 *      不是本库的 SKU 台账（那在 /sku）。两库绝不互写；本页零写。
 *
 * 结构 = 分类 tab（六类）+ 三段式（搜索区 → 工具栏 → 表格）。
 * 🔴 本组件**零业务逻辑**：条件拼成 query 丢给 `/api/shelf/docs`，那头调 core。
 *    页面不自己算哪本册子该出现、也不自己判泳道（泳道是 core 现算的）。
 * 🔴 「按归属组折叠」是本地视图开关（punch 的 `组名` 是**归属**不是属性）：
 *    组内按名称里的**数值序**排 —— 字典序会把 `2.10` 排到 `2.2` 前面，
 *    那样「顺序名称」这个需求等于没做。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Segmented, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { EmptyHint } from "~/components/console/ui";
import {
  CHECK_COLOR,
  LANE_COLOR,
  LANE_HINT,
  SHELF_TYPE_ORDER,
  seqOfName,
  type ShelfDocView,
  type ShelfFacetsView,
  type ShelfLaneView,
  type ShelfListResponse,
} from "./shared";

/** 表格里的一行：册行（带 doc）或组行（带 children） */
interface Row {
  key: string;
  isGroup: boolean;
  /** 组行才有 */
  groupName?: string;
  members?: number;
  /** 册行才有 */
  doc?: ShelfDocView;
  children?: Row[];
}

interface QueryForm {
  keyword?: string;
  subject?: string;
  grade?: string;
  lane?: string;
  /**
   * 🔴 下面两个不是搜索框里的字段，是塞给 ProTable `params` 的**重取触发器**：
   *    换 tab / 换折叠方式时 params 一变，ProTable 自己重跑 request
   *    （比在 onChange 里手动 reload 少一次时序问题）。request 里读的仍是 state。
   */
  tab?: string;
  grouped?: boolean;
}

function toEnum(list: { value: string; count: number }[]) {
  return Object.fromEntries(
    list.map((f) => [f.value, { text: `${f.value}（${f.count}）` }]),
  );
}

/** 一串体检灯（绿/缺/免三态，提醒不拦路） */
function Checks({ doc }: { doc: ShelfDocView }) {
  if (doc.checks.length === 0) {
    return <span style={{ color: "#909399" }}>—</span>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {doc.checks.map((c) => (
        <Tooltip key={c.name} title={`${c.name}：${c.note}`}>
          <Tag
            color={CHECK_COLOR[c.state]}
            style={{ marginInlineEnd: 0, fontSize: 11.5 }}
          >
            {c.name}
            {c.state === "绿" ? "" : c.state === "免" ? "·免" : "·缺"}
          </Tag>
        </Tooltip>
      ))}
    </span>
  );
}

export function ShelfTable({
  facets,
  totalDocs,
  defaultKeyword,
  defaultType,
}: {
  facets: ShelfFacetsView;
  totalDocs: number;
  /** 从地址栏带进来的初值（册详情页的「同组的册子」就是这么跳过来的） */
  defaultKeyword?: string;
  defaultType?: string;
}) {
  const actionRef = useRef<ActionType>(null);
  const [tab, setTab] = useState<string>(
    defaultType && SHELF_TYPE_ORDER.includes(defaultType as never)
      ? defaultType
      : "全部",
  );
  // 🔴 用字符串而不是布尔当 Segmented 的值：rc-segmented 会把值放进 DOM
  //    的 input value 上，布尔在那儿会被 React 抱怨（"true"/"false" 的隐式转换）。
  const [groupMode, setGroupMode] = useState<"组" | "平">("组");
  const grouped = groupMode === "组";
  const [meta, setMeta] = useState<ShelfListResponse["meta"]>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const columns: ProColumns<Row, "text">[] = [
    {
      title: "名称",
      dataIndex: "keyword",
      width: 300,
      ellipsis: true,
      tooltip: "在取回的窗口里按「名称/组名/版本名 包含」匹配",
      fieldProps: { placeholder: "有理数 / 打卡 / 绝对值" },
      render: (_, r) =>
        r.isGroup ? (
          <span style={{ fontWeight: 600 }}>
            {r.groupName}
            <span style={{ marginLeft: 6, fontSize: 11.5, color: "#909399" }}>
              {r.members} 册（归属组）
            </span>
          </span>
        ) : (
          <Link href={`/shelf/doc/${r.doc!.id}`} style={{ color: "inherit" }}>
            <span style={{ fontSize: 12.5 }}>{r.doc!.name}</span>
          </Link>
        ),
    },
    {
      title: "类型",
      dataIndex: "type",
      width: 68,
      search: false,
      render: (_, r) => (r.doc ? <Tag>{r.doc.type}</Tag> : null),
    },
    {
      title: "册型",
      dataIndex: "form",
      width: 64,
      search: false,
      tooltip: "合刊 = 成员册的合订本，它自己不挂题（体检改判「成员齐」）",
      render: (_, r) =>
        r.doc?.form === "合刊" ? (
          <Tag color="purple">合刊</Tag>
        ) : r.doc ? (
          <span style={{ color: "#909399" }}>单册</span>
        ) : null,
    },
    {
      title: "版本",
      dataIndex: "version",
      width: 88,
      search: false,
      ellipsis: true,
      tooltip: "punch 侧 `(名称, 版本名)` 是幂等键：同名不同版是两行",
      render: (_, r) =>
        r.doc?.version ? (
          <span style={{ fontSize: 12 }}>{r.doc.version}</span>
        ) : r.doc ? (
          <span style={{ color: "#909399" }}>—</span>
        ) : null,
    },
    {
      title: "年级",
      dataIndex: "grade",
      width: 108,
      valueType: "select",
      valueEnum: toEnum(facets.grades),
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      tooltip:
        "🔴 库里「七年级上册」与「七上」两种写法并存，按年级筛会分裂成两堆（口径待拍板，货架只如实列不合并）",
      render: (_, r) =>
        r.doc?.grade ? (
          <span style={{ fontSize: 12 }}>{r.doc.grade}</span>
        ) : r.doc ? (
          <Tooltip title="doc.年级 是空的">
            <span style={{ color: "#909399" }}>未填</span>
          </Tooltip>
        ) : null,
    },
    {
      title: "科目",
      dataIndex: "subject",
      width: 72,
      valueType: "select",
      valueEnum: toEnum(facets.subjects),
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      render: (_, r) =>
        r.doc?.subject ? (
          <span style={{ fontSize: 12 }}>{r.doc.subject}</span>
        ) : r.doc ? (
          <span style={{ color: "#909399" }}>未填</span>
        ) : null,
    },
    {
      title: "泳道",
      dataIndex: "lane",
      width: 84,
      valueType: "select",
      valueEnum: toEnum(facets.lanes),
      fieldProps: { placeholder: "不选=全部", allowClear: true },
      tooltip:
        "人工态（在售/待整理/停售）优先，为空才走体检灯现算。🔴 泳道是现算的，库里没有这一列，所以这一维是窗口内过滤",
      render: (_, r) =>
        r.doc ? (
          <Tooltip title={LANE_HINT[r.doc.lane]}>
            <Tag color={LANE_COLOR[r.doc.lane]}>{r.doc.lane}</Tag>
          </Tooltip>
        ) : null,
    },
    {
      title: "体检",
      dataIndex: "checks",
      width: 260,
      search: false,
      tooltip:
        "按类型分档：打卡查 题目齐/实算绿/物料齐/网盘挂；打卡合刊改查成员齐；专项只查 产物在/实算；提醒不拦路",
      render: (_, r) => (r.doc ? <Checks doc={r.doc} /> : null),
    },
    {
      title: "题",
      dataIndex: "questions",
      width: 64,
      search: false,
      align: "right",
      tooltip:
        "🔴 「题在库」与「能卖」是两回事：在售的册子里绝大多数 question=0（题级回收随使用），别拿它当上架判据",
      render: (_, r) =>
        r.doc ? (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {r.doc.counts.questions === 0 ? (
              <Tooltip title="题没拆到题级入库 —— 不代表这本册子没做完">
                <span style={{ color: "#909399" }}>0</span>
              </Tooltip>
            ) : (
              r.doc.counts.questions
            )}
          </span>
        ) : null,
    },
    {
      title: "物料",
      dataIndex: "materials",
      width: 84,
      search: false,
      tooltip: "在用物料覆盖了哪几个号（A/B 双号必须整条线隔离）",
      render: (_, r) => {
        if (!r.doc) return null;
        const a = r.doc.materialAccounts;
        if (a.length === 0) {
          return <span style={{ color: "#909399" }}>—</span>;
        }
        return (
          <span style={{ display: "inline-flex", gap: 3 }}>
            {a.map((x) => (
              <Tag key={x} color="cyan" style={{ marginInlineEnd: 0 }}>
                {x}
              </Tag>
            ))}
          </span>
        );
      },
    },
    {
      title: "产物",
      dataIndex: "assets",
      width: 92,
      search: false,
      tooltip: "asset 行数（题目卷/答案卷/图A/图B/页图/合订卷）",
      render: (_, r) =>
        r.doc ? (
          <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {r.doc.counts.assets === 0 ? (
              <span style={{ color: "#909399" }}>—</span>
            ) : (
              <>
                {r.doc.counts.assets} 件
                {r.doc.counts.images > 0 ? (
                  <span style={{ color: "#909399" }}>
                    {" "}
                    · 图 {r.doc.counts.images}
                  </span>
                ) : null}
              </>
            )}
          </span>
        ) : null,
    },
    {
      title: "网盘",
      dataIndex: "netdisk",
      width: 92,
      search: false,
      tooltip:
        "doc.网盘链接 / 提取码。一册一条链接=一个文件夹分享，双号共用同一条",
      render: (_, r) => {
        if (!r.doc) return null;
        if (!r.doc.netdiskLink) {
          return (
            <Tooltip title="doc.网盘链接 是空的 —— 这本册子的账上没记网盘">
              <span style={{ color: "#909399" }}>—</span>
            </Tooltip>
          );
        }
        return (
          <span>
            <Tag color="green" style={{ marginInlineEnd: 4 }}>
              {r.doc.netdiskCode ?? "有链接"}
            </Tag>
            <a href={r.doc.netdiskLink} target="_blank" rel="noreferrer">
              打开
            </a>
          </span>
        );
      },
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 76,
      fixed: "right",
      render: (_, r) =>
        r.doc
          ? [
              <Link key="d" href={`/shelf/doc/${r.doc.id}`}>
                详情
              </Link>,
            ]
          : [],
    },
  ];

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="货架列不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{err}</span>}
        />
      ) : null}
      {meta && meta.windowFilters.length > 0 ? (
        <Alert
          type="info"
          style={{ marginBottom: 10 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              窗口内过滤：{meta.windowFilters.join("；")} · 库里共{" "}
              {meta.totalDocs} 份资料 · {meta.ms}ms
            </span>
          }
        />
      ) : null}

      <ProTable<Row, QueryForm>
        actionRef={actionRef}
        rowKey="key"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1420 }}
        // 换 tab / 换折叠方式都靠 params 变化触发重取，不用手动 reload
        params={{ tab, grouped }}
        columnsState={{
          persistenceKey: "kf-shelf-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        // 🔴 地址栏带进来的关键词要**落进搜索框**，不能只影响一次取数：
        //    看得见的条件才改得动（框里空着、列表却被筛过 = 最难排查的那种"页面坏了"）
        form={{ initialValues: { keyword: defaultKeyword } }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle={
          <span>
            资料列表
            <span style={{ marginLeft: 8, fontSize: 12, color: "#909399" }}>
              库里共 {totalDocs} 份
            </span>
          </span>
        }
        toolbar={{
          menu: {
            type: "tab",
            activeKey: tab,
            items: [
              { key: "全部", label: `全部（${totalDocs}）` },
              ...SHELF_TYPE_ORDER.map((t) => {
                const n = facets.types.find((f) => f.value === t)?.count ?? 0;
                return { key: t, label: `${t}（${n}）` };
              }),
            ],
            onChange: (key) => setTab(String(key ?? "全部")),
          },
        }}
        toolBarRender={() => [
          <Segmented<"组" | "平">
            key="grp"
            size="small"
            value={groupMode}
            onChange={setGroupMode}
            options={[
              { label: "按归属组折叠", value: "组" },
              { label: "平铺", value: "平" },
            ]}
          />,
        ]}
        locale={{
          emptyText: (
            <EmptyHint>
              {tab !== "全部" &&
              (facets.types.find((f) => f.value === tab)?.count ?? 0) === 0
                ? `「${tab}」这一类现在**一本都没有**（不是筛错了）：punch 侧 doc.类型 声明六类，实际入库的只有 打卡 / 专项 两类。`
                : "没有符合条件的资料。🔴 「货架上没有」不等于「没做过」——货架只列 punch 库 doc 表登记过的册子，新册子要先跑产线的 import 才会出现在这里。"}
            </EmptyHint>
          ),
        }}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) =>
            `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条${grouped ? "（组行按 1 条算）" : ""}`,
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          if (tab !== "全部") q.set("type", tab);
          if (params.keyword) q.set("keyword", params.keyword);
          if (params.subject) q.set("subject", params.subject);
          if (params.grade) q.set("grade", params.grade);
          if (params.lane) q.set("lane", params.lane);

          // 🔴 三种失败都要上墙（与 /sku 同一写法）：ok:false / HTTP 非 2xx /
          //    fetch 抛。后两种不 catch 会被 ProTable 吞成「暂无数据」的空表 ——
          //    货架页这个坑最贵：空表长得就像「货架上没有这本册子」，
          //    而真相可能只是 PUNCH_DB_URL 没配。
          let j: ShelfListResponse;
          try {
            const res = await fetch(`/api/shelf/docs?${q.toString()}`);
            if (!res.ok) {
              throw new Error(
                `GET /api/shelf/docs 返回 HTTP ${res.status} ${res.statusText}`,
              );
            }
            j = (await res.json()) as ShelfListResponse;
          } catch (e) {
            setMeta(null);
            setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
            return { data: [], total: 0, success: true };
          }
          setMeta(j.meta);
          setErr(
            j.ok ? undefined : (j.error ?? "接口返回 ok=false，但没给原因"),
          );

          const flat: Row[] = j.data.map((d) => ({
            key: `d${d.id}`,
            isGroup: false,
            doc: d,
          }));
          if (!grouped) {
            return { data: flat, total: flat.length, success: true };
          }

          // ── 按归属组折叠：≥2 册才立组行，单册照旧平铺（立一个只有一本的组是噪音）
          const byGroup = new Map<string, ShelfDocView[]>();
          for (const d of j.data) {
            const k = d.group ?? `__solo_${d.id}`;
            const list = byGroup.get(k);
            if (list) list.push(d);
            else byGroup.set(k, [d]);
          }
          const tree: Row[] = [];
          for (const [k, docs] of byGroup) {
            if (docs.length === 1) {
              tree.push({
                key: `d${docs[0]!.id}`,
                isGroup: false,
                doc: docs[0],
              });
              continue;
            }
            // 🔴 组内按名称里的**数值序**排（字典序会把 2.10 排到 2.2 前面）
            const sorted = docs.every((d) => seqOfName(d.name) !== null)
              ? [...docs].sort(
                  (a, b) => seqOfName(a.name)! - seqOfName(b.name)!,
                )
              : docs;
            tree.push({
              key: `g${k}`,
              isGroup: true,
              groupName: k,
              members: docs.length,
              children: sorted.map((d) => ({
                key: `d${d.id}`,
                isGroup: false,
                doc: d,
              })),
            });
          }
          return { data: tree, total: tree.length, success: true };
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
        🔴 本页<b>只读</b> punch 库（mode=ro）：这里点不动任何一个字。
        改人工态、重导产物、发布物料都在原产线那边做； 两库对账去{" "}
        <Link href="/shelf/reconcile">资料对账</Link>。
      </div>
    </>
  );
}

export default ShelfTable;

/** 泳道类型在本文件只用于取色，导出一下免得别处再抄一份 */
export type { ShelfLaneView };
