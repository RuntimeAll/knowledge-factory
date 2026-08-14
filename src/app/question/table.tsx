"use client";

/**
 * 题目管理 · 三段式列表（AI:PRD-008 · 地基）
 *
 * 设计稿 §二·2：找题、盘题——按条件把题捞出来看。**不管**改题（录入线的事）、组卷（生产域）。
 * 结构 = 若依/ProTable 的标准三段式：搜索区 → 工具栏（列显隐 + 入库命令提示）→ 表格 + 真分页。
 *
 * 🔴 本组件**零业务逻辑**：条件拼成 query 丢给 `/api/questions`，那头调 core 的
 *    searchQuestions（与 MCP 同一个入口）。页面不自己算什么题该出现。
 * 🔴 入库是**数据生产类写操作**，页面不做（设计稿 §〇·3）：工具栏只给一句能直接粘的命令。
 * 🔴 界面如实：难度筛选置灰（全库 difficulty 未打档，摆一个永远零命中的筛选比没有更坏）；
 *    降级/落靶/窗口封顶一律上墙（表格上方那条 Alert），一个字不吞。
 *
 * ── 2026-08-14 三处补（验收判红）────────────────────────────────────────────
 *   ① **列头可排序**（改版四原则第 1 条）：排序是 `sorter:true` + 服务端排 ——
 *      本表是服务端切片的，前端排只会把"当前这一页"排一遍，那是假排序。
 *   ② **空态给口径文案**（设计稿 §三：「没有数据」≠「没有错误」），不许落 antd 默认。
 *   ③ **录入批次**这一维补上（设计稿 §二·2 逐项列了它）：core 的 searchParamsSchema
 *      现在有 ingestBatchIds，是**真硬过滤**，不是窗口内筛。
 *   ④ 「相似题」改成本页弹层（原来跳 004-C 的 /search，那页已随本次改版下线）。
 *
 * ── 2026-08-14 夜 · AI:PRD-009 打磨（只动版面与交互）────────────────────────
 *   ⑤ 错误态（检查单 2）：`request` 里的 fetch **本身**炸了（服务没起/网断/坏 JSON）
 *      以前会被 ProTable 吞掉 —— 页面显示成"零命中"，而那是故障不是事实。
 *      现在 try/catch 兜住、原文上墙、`success:false`；
 *   ⑥ 加载态（检查单 1）：相似题弹层给骨架屏，不再是一行"读取中…"；
 *   ⑦ 移动端（检查单 5）：弹层宽度改 `min(720px,100vw)`；
 *   ⑧ 列规范（检查单 3）：难度列补 tabular-nums。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Drawer, Select, Skeleton, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  CopyCmd,
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import type {
  KpOption,
  KpOptionsResponse,
  QuestionListMeta,
  QuestionListResponse,
  QuestionRow,
  SimilarResponse,
} from "./shared";

/** 搜索区的表单形状（= ProTable 各列 dataIndex） */
interface QueryForm {
  kw?: string;
  sem?: string;
  kp?: string[];
  qtype?: string[];
  solutionGrade?: string[];
  provType?: string[];
  status?: string[];
  batch?: string;
}

export interface QuestionTableProps {
  /** 枚举正本全在 core，由 server 页面读出来传进来（client 不 import core） */
  qtypes: readonly string[];
  statuses: readonly string[];
  grades: readonly string[];
  provTypes: readonly string[];
  /** 默认看哪些状态（= core 的 DEFAULT_STATUSES） */
  defaultStatuses: readonly string[];
  /** 从地址栏带进来的初值（/ingest、/model 那些页跳过来时用） */
  initialBatch?: string;
  initialKp?: KpOption;
  /** ?similar=q_… 直接开弹层（旧 /search?similar= 的落点） */
  initialSimilar?: string;
}

function toEnum(list: readonly string[]): Record<string, { text: string }> {
  return Object.fromEntries(list.map((v) => [v, { text: v }]));
}

/** 各轴干了什么 + 有没有降级/封顶：检索结果的可信度取决于看的人知不知道少跑了哪条轴 */
function MetaBar({
  meta,
  error,
}: {
  meta: QuestionListMeta | null;
  error?: string;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 10 }}
        message="检索没跑成（原文照登）"
        description={<span style={{ fontSize: 12.5 }}>{error}</span>}
      />
    );
  }
  if (!meta) return null;

  const notes: string[] = [];
  if (meta.axes.fts.active) {
    notes.push(
      `关键词轴 ${meta.axes.fts.count} 中（${meta.axes.fts.op === "or" ? "OR·已降级" : "AND"}${
        meta.axes.fts.tokens.length > 0
          ? ` · 分词 ${meta.axes.fts.tokens.join(" / ")}`
          : ""
      }）`,
    );
  }
  if (meta.axes.vector.active) {
    notes.push(
      `语意轴 ${meta.axes.vector.count} 中（${meta.axes.vector.modelVer ?? "模型不可用"}）`,
    );
  }
  if (meta.axes.kpAuto.active) {
    notes.push(
      `关键词落靶成考点「${meta.axes.kpAuto.names.join("、")}」，额外开了一条考点召回轴（${meta.axes.kpAuto.count} 中）`,
    );
  }
  if (meta.capped) {
    notes.push(
      `命中 ${meta.coreTotal} 条，本页只翻得到前 ${meta.fetched} 条 —— 关键词/语意是相关性序，` +
        `core 的 searchQuestions 单次上限 ${meta.cap} 且没有 offset，跨窗拼接会把顺序拼错。收窄条件即可看到后面的题。`,
    );
  }
  if (meta.provWindow) {
    notes.push(
      `来源筛选是在已取回的 ${meta.fetched} 条里过滤的（core 硬过滤没有 prov_type 这一维），总数按这个窗口算`,
    );
  }
  if (meta.batchIds.length > 0) {
    notes.push(
      `只看录入批次 ${meta.batchIds.join("、")}（core 的硬过滤，不是窗口内筛 —— 总数是全库口径）`,
    );
  }
  if (meta.sort) {
    notes.push(
      `按「${meta.sort.field}」${meta.sort.desc ? "降序" : "升序"}排 —— ` +
        "🔴 排序是在**取回的窗口内**做的（core 的检索没有 order by 这一维）：" +
        `本次取回 ${meta.fetched} 条${meta.capped ? "，而且撞到了窗口上限，后面的题没参与排序" : "（已取尽，排序覆盖全部命中）"}。`,
    );
  }
  if (meta.axes.vector.active) {
    notes.push(
      `🔴 语意轴在跑：「命中 ${meta.coreTotal}」= 融合名次表的长度（候选里有句向量的题基本都会进榜），` +
        "它是**查询的属性、与页码无关**，但也别把它读成「有这么多题真的相关」——相关性看排序与分数。",
    );
  }

  const tone = meta.degraded || meta.capped ? "warning" : "info";
  return (
    <Alert
      type={tone}
      showIcon={meta.degraded || meta.capped}
      style={{ marginBottom: 10 }}
      message={
        <span style={{ fontSize: 12.5 }}>
          候选 {meta.candidateCount} · 命中 {meta.coreTotal} · 取回{" "}
          {meta.fetched}（{meta.rounds} 次检索）· {meta.ms}ms
          {meta.degraded ? " · degraded" : ""}
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

/** 相似题弹层：拿一道题当查询，找语意近邻（= MCP 的 find_similar 同一个 core 函数） */
function SimilarDrawer({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<SimilarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const 上次 = useRef<string | null>(null);

  /**
   * 🔴 AI:PRD-009 打磨：取数从 render 体里挪进 useEffect。
   *    原来是「render 时发现 id 变了就顺手 fetch」——点开弹层那条路没问题，
   *    但 `?similar=q_…` 直接进页时**服务端也会渲这一遍**，而 SSR 里
   *    `fetch("/api/…")` 的相对地址在 Node 侧解析不了：
   *    服务端先渲出一条"请求没发出去"的红条、客户端再渲出骨架，
   *    两边对不上 = hydration mismatch（整块重渲、弹层闪一下）。
   *    放进 effect 之后只在浏览器跑，行为不变。
   */
  useEffect(() => {
    if (!id || 上次.current === id) return;
    上次.current = id;
    setData(null);
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/questions/similar?id=${encodeURIComponent(id)}`,
        );
        setData((await res.json()) as SimilarResponse);
      } catch (e) {
        setData({
          ok: false,
          error: `请求没发出去（或没回来）：${
            e instanceof Error ? `${e.name}: ${e.message}` : String(e)
          }`,
          questionId: id,
          stemBrief: "",
          hits: [],
          degraded: false,
          modelVer: null,
          warnings: [],
          ms: 0,
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  return (
    <Drawer
      title="相似题（句向量近邻）"
      // 🔴 手机上 720px 会顶出屏幕（检查单 5）：按视口收
      width="min(720px, 100vw)"
      open={id !== null}
      onClose={() => {
        上次.current = null;
        onClose();
      }}
    >
      {id === null ? null : (
        <>
          <div style={{ fontSize: 12.5, marginBottom: 10 }}>
            拿这道题当查询：
            <div
              style={{
                fontFamily: "Consolas, Menlo, monospace",
                background: "#f4f4f5",
                padding: 8,
                marginTop: 4,
              }}
            >
              {data?.stemBrief !== undefined && data.stemBrief !== "" ? (
                data.stemBrief
              ) : loading ? (
                <Skeleton active title={false} paragraph={{ rows: 1 }} />
              ) : (
                "（题面没读出来）"
              )}
            </div>
            <Link href={`/question/${id}`}>看这道题的正本 →</Link>
          </div>

          {/* 加载态：近邻列表也给骨架，别让人对着空白猜"是不是没有相似题"（检查单 1） */}
          {loading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}

          {data && !data.ok ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 10 }}
              message="相似题查不出来（原文照登）"
              description={<span style={{ fontSize: 12.5 }}>{data.error}</span>}
            />
          ) : null}
          {data?.degraded ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 10 }}
              message="语意轴降级了 —— 下面的空列表不是「这题没有相似题」"
              description={
                <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                  {data.warnings.map((w, i) => (
                    <div key={i}>⚠ {w}</div>
                  ))}
                </div>
              }
            />
          ) : null}

          {data?.ok && data.hits.length === 0 && !data.degraded ? (
            <EmptyHint>
              一条近邻都没有 —— 🔴
              这多半是「这道题没有句向量」（语意轴找不到它），不是「库里没有像它的题」。
            </EmptyHint>
          ) : null}

          {(data?.hits ?? []).map((h) => (
            <div
              key={h.questionId}
              style={{
                borderBottom: "1px solid #ebeef5",
                padding: "8px 0",
                fontSize: 12.5,
              }}
            >
              <Space size={6} wrap>
                <Tag color="blue">{h.score.toFixed(4)}</Tag>
                <StatusTag value={h.status} />
                {h.qtype ? <Tag>{h.qtype}</Tag> : null}
                <StatusTag value={h.solutionGrade} />
              </Space>
              <div
                style={{
                  fontFamily: "Consolas, Menlo, monospace",
                  margin: "4px 0",
                }}
              >
                <Link href={`/question/${h.questionId}`}>{h.stemBrief}</Link>
              </div>
              <div>
                {h.kps.map((k) => (
                  <Tag key={k.kpId} color={k.isPrimary ? "blue" : "default"}>
                    {k.isPrimary ? "★" : ""}
                    {k.name}
                  </Tag>
                ))}
              </div>
            </div>
          ))}

          {data?.ok ? (
            <div style={{ marginTop: 10, fontSize: 11.5, color: "#909399" }}>
              模型 {data.modelVer ?? "—"} · {data.ms}ms · 与 MCP 的 find_similar
              同一个 core 函数（页面看得见的近邻 = agent 查到的）
            </div>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

export function QuestionTable(props: QuestionTableProps) {
  const actionRef = useRef<ActionType>(null);
  const [meta, setMeta] = useState<QuestionListMeta | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [kpOptions, setKpOptions] = useState<KpOption[]>(
    props.initialKp ? [props.initialKp] : [],
  );
  const [kpLow, setKpLow] = useState(false);
  const [similarId, setSimilarId] = useState<string | null>(
    props.initialSimilar ?? null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 考点框：敲字 → 远程出候选（debounce 250ms，enqueue:false 见 api/kp-options） */
  function searchKp(q: string): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/kp-options?q=${encodeURIComponent(q)}`);
          const j = (await res.json()) as KpOptionsResponse;
          setKpOptions(j.options);
          setKpLow(j.lowConfidence);
        } catch {
          setKpOptions([]);
        }
      })();
    }, 250);
  }

  const columns: ProColumns<QuestionRow, "text">[] = [
    {
      title: "关键词",
      dataIndex: "kw",
      hideInTable: true,
      tooltip:
        "题面里真出现过这些字才算命中（jieba 分词逐词 AND，全中不了自动退 OR）；若它本身是考点的说法，另开一条考点召回轴",
      fieldProps: { placeholder: "最小值 / 去绝对值 / 立方根" },
    },
    {
      title: "语意描述",
      dataIndex: "sem",
      hideInTable: true,
      tooltip: "说不出关键词时用：描述你要找什么样的题（句向量近邻）",
      fieldProps: { placeholder: "含字母的绝对值怎么分类讨论正负" },
    },
    {
      title: "考点",
      dataIndex: "kp",
      hideInTable: true,
      renderFormItem: () => (
        <Select
          mode="multiple"
          allowClear
          showSearch
          filterOption={false}
          onSearch={searchKp}
          placeholder="搜考点名 / 别名，选中才生效"
          options={kpOptions}
          notFoundContent={
            kpLow
              ? "词表四路都没把握——候选只作参考，别硬挑一个"
              : "敲两个字试试"
          }
        />
      ),
    },
    {
      title: "难度",
      dataIndex: "difficultyDisabled",
      hideInTable: true,
      tooltip:
        "全库 difficulty 仍是 NULL（未打档）——能点的难度筛选只会永远零命中，所以置灰",
      renderFormItem: () => (
        <Select disabled placeholder="未打档 · 打完档再启用" options={[]} />
      ),
      search: { transform: () => ({}) },
    },
    {
      title: "录入批次",
      dataIndex: "batch",
      hideInTable: true,
      tooltip:
        "只看某一次投料进来的题（question.ingest_batch_id 硬过滤）。批次 id 从「录入批次」页复制，形如 batch_01J…",
      fieldProps: { placeholder: "batch_01J…（从录入批次页复制）" },
    },
    {
      title: "题面",
      dataIndex: "stemBrief",
      search: false,
      width: 360,
      sorter: true,
      render: (_, r) => (
        <Tooltip title={r.stemBrief} styles={{ root: { maxWidth: 560 } }}>
          <Link href={`/question/${r.id}`} style={{ color: "inherit" }}>
            <div
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                fontFamily: "Consolas, Menlo, monospace",
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {r.stemBrief}
            </div>
          </Link>
        </Tooltip>
      ),
    },
    {
      title: "题型",
      dataIndex: "qtype",
      width: 84,
      valueType: "select",
      valueEnum: toEnum(props.qtypes),
      sorter: true,
      fieldProps: { mode: "multiple", placeholder: "不选=全部" },
      render: (_, r) => (r.qtype ? <Tag>{r.qtype}</Tag> : <Tag>题型未填</Tag>),
    },
    {
      title: "考点",
      dataIndex: "kps",
      search: false,
      width: 240,
      render: (_, r) =>
        r.kps.length === 0 ? (
          <span style={{ color: "#909399" }}>没挂考点</span>
        ) : (
          <span>
            {r.kps.map((k) => (
              <Link key={k.kpId} href={`/kg/kp/${k.kpId}`}>
                <Tag color={k.isPrimary ? "blue" : "default"}>
                  {k.isPrimary ? "★" : ""}
                  {k.name}
                </Tag>
              </Link>
            ))}
          </span>
        ),
    },
    {
      title: "难度",
      dataIndex: "difficulty",
      search: false,
      width: 64,
      sorter: true,
      render: (_, r) =>
        r.difficulty === null ? (
          <Tooltip title="未打档（question.difficulty IS NULL）">
            <span style={{ color: "#909399" }}>—</span>
          </Tooltip>
        ) : (
          // 数字列一律 tabular-nums（检查单 3）
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {r.difficulty}
          </span>
        ),
    },
    {
      title: "判档",
      dataIndex: "solutionGrade",
      width: 116,
      valueType: "select",
      valueEnum: toEnum(props.grades),
      sorter: true,
      fieldProps: { mode: "multiple", placeholder: "默认=实算过+仅解析" },
      render: (_, r) => <StatusTag value={r.solutionGrade} />,
    },
    {
      title: "来源",
      dataIndex: "provType",
      width: 96,
      valueType: "select",
      valueEnum: toEnum(props.provTypes),
      sorter: true,
      tooltip:
        "prov_type。🔴 core 的硬过滤没有这一维：本筛选是在取回的结果里过滤的，总数口径见表格上方",
      fieldProps: { mode: "multiple", placeholder: "不选=全部" },
      render: (_, r) => <Tag>{r.provType}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      valueType: "select",
      valueEnum: toEnum(props.statuses),
      sorter: true,
      fieldProps: { mode: "multiple" },
      render: (_, r) => (
        <Space size={2}>
          <StatusTag value={r.status} />
          {r.reviewRequired ? (
            <Tooltip title="review_required=1：这题带没过审的题干图">
              <Tag color="orange">必审</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "入库时间",
      dataIndex: "ingestedAt",
      search: false,
      width: 110,
      sorter: true,
      tooltip:
        "由题 id 里的 ULID 解出（发号即入库那一刻）——检索契约里没有 created_at 这一列",
      render: (_, r) => <TimeText iso={r.ingestedAt} />,
    },
    {
      title: "id",
      dataIndex: "id",
      search: false,
      width: 110,
      sorter: true,
      render: (_, r) => <IdTail id={r.id} />,
    },
    {
      title: "命中",
      dataIndex: "badges",
      search: false,
      width: 130,
      render: (_, r) =>
        r.badges.map((b) => (
          <Tag key={b} color={b === "仅条件" ? "default" : "green"}>
            {b}
          </Tag>
        )),
    },
    {
      title: "操作",
      valueType: "option",
      key: "option",
      width: 120,
      fixed: "right",
      render: (_, r) => [
        <Link key="view" href={`/question/${r.id}`}>
          查看
        </Link>,
        // 🔴 设计稿 §二·2 写的就是「相似题（find_similar 弹层）」——
        //    以前这里跳 /search，而那页是本次改版要替换掉的旧版式页。
        <a key="similar" onClick={() => setSimilarId(r.id)}>
          相似题
        </a>,
      ],
    },
  ];

  return (
    <>
      <MetaBar meta={meta} error={err} />
      <ProTable<QuestionRow, QueryForm>
        actionRef={actionRef}
        rowKey="id"
        size="small"
        columns={columns}
        cardBordered
        scroll={{ x: 1400 }}
        columnsState={{
          persistenceKey: "kf-question-columns",
          persistenceType: "localStorage",
        }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{
          initialValues: {
            status: [...props.defaultStatuses],
            ...(props.initialBatch ? { batch: props.initialBatch } : {}),
            ...(props.initialKp ? { kp: [props.initialKp.value] } : {}),
          },
        }}
        options={{
          reload: true,
          density: true,
          setting: true,
          fullScreen: false,
        }}
        headerTitle="题目列表"
        // 🔴 空态给口径原句（设计稿 §三）：零命中最容易被读成「库里没这种题」，
        //    而多数时候是条件太窄或轴没落靶 —— 表格上方那条 Alert 里有逐轴的账。
        locale={{
          emptyText: (
            <EmptyHint>
              这一组条件下零命中。🔴
              「没有命中」不等于「库里没有这种题」：关键词走的是**字面**（题面里真出现过那几个字才算），
              语意描述走的是句向量近邻，两条轴都可能落空。
              <br />
              先放宽：去掉题型/判档/状态，或把关键词换成题面里真会出现的字；
              查考点用「考点」那一栏（考点名在题面里通常一个字都不出现）。
              表格上方那条提示写着每条轴各命中了多少、有没有降级。
            </EmptyHint>
          ),
        }}
        toolBarRender={() => [
          <CopyCmd
            key="submit"
            label="入库请用"
            cmd="pnpm kb:submit <题单.json>"
          />,
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
          if (params.kw) q.set("kw", params.kw);
          if (params.sem) q.set("sem", params.sem);
          if (params.batch) q.set("batch", params.batch.trim());
          for (const id of params.kp ?? []) q.append("kp", id);
          for (const t of params.qtype ?? []) q.append("qt", t);
          for (const s of params.status ?? []) q.append("st", s);
          for (const g of params.solutionGrade ?? []) q.append("sg", g);
          for (const p of params.provType ?? []) q.append("pv", p);
          // 🔴 排序丢给服务端做（本表是服务端切片的，前端排只会排当前这一页）
          const [field, order] = Object.entries(sort ?? {})[0] ?? [];
          if (field && order) {
            q.set("sort", field);
            q.set("order", order === "ascend" ? "asc" : "desc");
          }

          // 🔴 fetch 本身炸了（服务没起 / 网断 / JSON 坏）ProTable 会把异常吞掉，
          //    结果是一张"零命中"的空表 —— 而零命中和"检索没跑成"是两回事（检查单 2）。
          try {
            const res = await fetch(`/api/questions?${q.toString()}`);
            const j = (await res.json()) as QuestionListResponse;
            setMeta(j.meta);
            setErr(j.ok ? undefined : j.error);
            return { data: j.data, total: j.total, success: true };
          } catch (e) {
            setMeta(null);
            setErr(
              `请求没发出去（或没回来）：${
                e instanceof Error ? `${e.name}: ${e.message}` : String(e)
              }`,
            );
            return { data: [], total: 0, success: false };
          }
        }}
      />
      <SimilarDrawer id={similarId} onClose={() => setSimilarId(null)} />
    </>
  );
}

export default QuestionTable;
