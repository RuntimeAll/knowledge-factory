/**
 * 题库管理 · 题目详情 `/question/[id]`（AI:PRD-008 · 设计稿 §二·3）
 *
 * 一道题的正本 + 它的一生，四个 tab：
 *   **基本信息**（题面/答案/解析/考点/标签/配图）｜**血缘**（母题 → 模型 → 变式，双向可点）｜
 *   **归属**（进过哪些 SKU、第几题位）｜**出处**（provenance 四型 + 录题批次 + 查重键）。
 * **不管**编辑（页面无改题）。
 *
 * 🔴 它取代 004-C 的 `/q/[id]`（2026-08-14）：那页是一长条，而且用的是 D1 已作废的
 *    「学术纸感」kit —— 新壳里点进旧版式页是本次改版最刺眼的一处不一致。
 *    内容一条没少：三段原文、考点、标签、配图、族谱、出处全在，只是分了 tab、换成 antd。
 *
 * 🔴 三段原文一律**等宽原样、不渲染公式**：这页的读者是要核对的人，他要看的是
 *    「库里到底存了什么字」。渲染一层公式反而会把 `\frac` 写错、少个 `$` 这类真问题藏起来。
 * 🔴 编造的 id 走真 404（notFound()）：题 id 是纯 ULID，core 给不出「最近似候选」，
 *    与其拿一张 200 的空页装作页面存在，不如老实回 404 + 一句指路。
 * 🔴 配图走 /api/asset/<hash>：页面不碰文件系统，路径一律由库里的登记行说了算。
 */
import { Alert, Card, Descriptions, Space, Tag, Tooltip } from "antd";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHead } from "~/components/console/page-head";
import {
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import {
  RetrievalError,
  getLineage,
  getQuestion,
  listSkusOfQuestion,
  type LineageQuestion,
  type LineageView,
  type QuestionCard,
  type QuestionProvenance,
  type QuestionSkuPlacement,
} from "~/core";
import { QuestionTabs } from "./tabs";

export const dynamic = "force-dynamic";

const 灰: React.CSSProperties = { color: "#909399" };
const MONO: React.CSSProperties = {
  fontFamily: "Consolas, Menlo, monospace",
};

const PROV_名: Record<string, string> = {
  scan: "扫描件抽出来的（有源文档与页码）",
  pipeline: "产线脚本生成的（有 pipeline_ref）",
  model: "由考察模型生成的",
  manual: "人手录的",
};

/** 正本一段（原样等宽；空段落如实说「库里就是空的」，别拿空白糊弄） */
function 正本段({
  title,
  text,
  空话,
}: {
  title: string;
  text: string | null;
  空话: string;
}) {
  return (
    <Card size="small" title={title} style={{ marginBottom: 12 }}>
      {text ? (
        <pre
          style={{
            background: "#f4f4f5",
            padding: 10,
            margin: 0,
            maxHeight: 520,
            overflow: "auto",
            fontSize: 12.5,
            lineHeight: 1.9,
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </pre>
      ) : (
        <div style={{ fontSize: 12.5, color: "#e6a23c" }}>{空话}</div>
      )}
    </Card>
  );
}

/** 族谱里的一条题（点进去就是那道题的正本） */
function 族谱题({ q, 我 }: { q: LineageQuestion; 我?: boolean }) {
  if (q.status === "missing") {
    // 🔴 origin 指了个查无此行的 id —— 明说，不静默略过
    return (
      <li style={{ color: "#c45656", fontSize: 12.5, lineHeight: 1.9 }}>
        <span style={{ ...MONO, fontSize: 11.5 }}>{q.questionId}</span>{" "}
        {q.stemBrief}
      </li>
    );
  }
  return (
    <li style={{ fontSize: 12.5, lineHeight: 1.9 }}>
      {我 ? (
        <Tag color="green">本题</Tag>
      ) : (
        <Link href={`/question/${q.questionId}`}>看 → </Link>
      )}
      <span>{q.stemBrief}</span>
      {q.qtype ? (
        <span style={{ ...灰, marginInlineStart: 6 }}>{q.qtype}</span>
      ) : null}
      {q.status === "active" ? null : (
        <span style={{ ...灰, marginInlineStart: 6 }}>[{q.status}]</span>
      )}
    </li>
  );
}

/** 模型抬头：名字 + 态 + 归位考点 + dsl_ref（🔴 一路能指回真生成器文件） */
function 模型抬头({
  m,
}: {
  m: {
    modelId: string;
    name: string;
    status: string;
    dslRef: string | null;
    kpId: string;
    kpName: string | null;
  };
}) {
  return (
    <div style={{ fontSize: 12.5 }}>
      <Link href={`/model/${m.modelId}`}>
        <b>{m.name}</b>
      </Link>
      <StatusTag value={m.status} />
      <Link href={`/kg/kp/${m.kpId}`}>{m.kpName ?? m.kpId} →</Link>
      <div style={{ ...灰, ...MONO, fontSize: 11, wordBreak: "break-all" }}>
        {m.dslRef ?? "🔴 没有 dsl_ref —— 说不出「哪个脚本真会出这类题」"}
      </div>
    </div>
  );
}

/** 血缘 tab：母题 → 模型 → 变式，两个方向都摆出来 */
function 血缘({ lin, meId }: { lin: LineageView; meId: string }) {
  if (!lin.bornOf && lin.originOf.length === 0) {
    return (
      <EmptyHint>
        这道题既不是任何考察模型生成的（没有 model_id），也没有被归纳成模型
        （没人把它写进 origin_qids_json）。🔴
        「没有血缘」不等于「它和别的题无关」—— 只是这条关系从来没有被登记过。
      </EmptyHint>
    );
  }
  return (
    <>
      {lin.bornOf ? (
        <Card
          size="small"
          title="本题是【变式】：由下面这个考察模型生成"
          style={{ marginBottom: 12 }}
        >
          <模型抬头 m={lin.bornOf} />
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <span style={灰}>↑ 该模型的母题（从哪几道真题归纳出来）：</span>
            {lin.bornOf.origins.length === 0 ? (
              <div style={{ color: "#c45656", fontSize: 12.5, marginTop: 2 }}>
                🔴 一道都没记 ——
                族谱在这儿断了：这个模型已经在出题，却说不出自己
                照着什么归纳的。补法：core 的 setModelOrigins(modelId, [母题
                qid]) （脚本口，MCP 没有这个工具）。
              </div>
            ) : (
              <ul style={{ marginTop: 2, marginLeft: 18 }}>
                {lin.bornOf.origins.map((q) => (
                  <族谱题 key={q.questionId} q={q} />
                ))}
              </ul>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <span style={灰}>
              → 同模型的兄弟变式（共 {lin.bornOf.siblingTotal} 道
              {lin.bornOf.siblingTotal > lin.bornOf.siblings.length
                ? `，列前 ${lin.bornOf.siblings.length} 道`
                : ""}
              ）：
            </span>
            {lin.bornOf.siblings.length === 0 ? (
              <span style={{ ...灰, marginInlineStart: 6 }}>
                就它一道（这个模型目前只生成过本题）
              </span>
            ) : (
              <ul style={{ marginTop: 2, marginLeft: 18 }}>
                {lin.bornOf.siblings.map((q) => (
                  <族谱题 key={q.questionId} q={q} />
                ))}
              </ul>
            )}
          </div>
        </Card>
      ) : null}

      {lin.originOf.map((m) => (
        <Card
          key={m.modelId}
          size="small"
          title="本题是【母题】：由它归纳出了下面这个考察模型"
          style={{ marginBottom: 12 }}
        >
          <模型抬头 m={m} />
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <span style={灰}>
              ↓ 该模型派生的变式（共 {m.derivedTotal} 道
              {m.derivedTotal > m.derived.length
                ? `，列前 ${m.derived.length} 道`
                : ""}
              ）：
            </span>
            {m.derived.length === 0 ? (
              <span style={{ ...灰, marginInlineStart: 6 }}>还没生成过题</span>
            ) : (
              <ul style={{ marginTop: 2, marginLeft: 18 }}>
                {m.derived.map((q) => (
                  <族谱题 key={q.questionId} q={q} 我={q.questionId === meId} />
                ))}
              </ul>
            )}
          </div>
        </Card>
      ))}
    </>
  );
}

/** 归属 tab：这道题进过哪些册子、各是第几题（ord = 卷面题号） */
function 归属({ rows }: { rows: QuestionSkuPlacement[] }) {
  if (rows.length === 0) {
    return (
      <EmptyHint>
        这道题还没被任何一本册子用过（sku_item 里没有它）。🔴
        这不是异常：库存题本来就可以一本册子都没进过 ——
        它只是说明「这道题还没卖出去过」，出册排重时它也不会被判成已售题。
      </EmptyHint>
    );
  }
  return (
    <>
      {/* 🔴 手机上让**表格自己**横向滚，别让 body 横滚（AI:PRD-009 检查单 5） */}
      <div style={{ overflowX: "auto", width: "100%" }}>
        <table
          style={{ width: "100%", minWidth: 520, borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th
                style={{
                  background: "#f5f7fa",
                  textAlign: "left",
                  padding: "7px 10px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  borderBottom: "1px solid #ebeef5",
                }}
              >
                册子
              </th>
              <th
                style={{
                  background: "#f5f7fa",
                  textAlign: "left",
                  padding: "7px 10px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  borderBottom: "1px solid #ebeef5",
                  width: 90,
                }}
              >
                第几题
              </th>
              <th
                style={{
                  background: "#f5f7fa",
                  textAlign: "left",
                  padding: "7px 10px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  borderBottom: "1px solid #ebeef5",
                  width: 140,
                }}
              >
                挂桥
              </th>
              <th
                style={{
                  background: "#f5f7fa",
                  textAlign: "left",
                  padding: "7px 10px",
                  fontSize: 12.5,
                  fontWeight: 500,
                  borderBottom: "1px solid #ebeef5",
                  width: 120,
                }}
              >
                建档
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.skuId}|${r.ord}`}>
                <td
                  style={{
                    padding: "7px 10px",
                    borderBottom: "1px solid #ebeef5",
                    fontSize: 12.5,
                  }}
                >
                  <Link href={`/sku/${r.skuId}`}>{r.name}</Link>
                  <Space size={4} style={{ marginInlineStart: 6 }}>
                    {r.type ? <Tag>{r.type}</Tag> : null}
                    <StatusTag value={r.status} />
                  </Space>
                </td>
                <td
                  style={{
                    padding: "7px 10px",
                    borderBottom: "1px solid #ebeef5",
                    fontSize: 12.5,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <Tooltip title="sku_item.ord = 卷面题号，学情回流按它对位（不是排序字段）">
                    <b>第 {r.ord} 题</b>
                  </Tooltip>
                </td>
                <td
                  style={{
                    padding: "7px 10px",
                    borderBottom: "1px solid #ebeef5",
                    fontSize: 12.5,
                  }}
                >
                  {r.taskId === null ? (
                    <span style={灰}>没挂桥</span>
                  ) : (
                    <Tag color="blue">task {r.taskId}</Tag>
                  )}
                </td>
                <td
                  style={{
                    padding: "7px 10px",
                    borderBottom: "1px solid #ebeef5",
                    fontSize: 12.5,
                  }}
                >
                  <TimeText iso={r.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 11.5, ...灰, lineHeight: 1.9 }}>
        🔴 一道题可以进多本册子（合刊/重排都算），每一处的 ord 各自算。
        <br />
        🔴 挂桥 = 这本册子对应圣域的哪个打卡任务；没挂桥的册子，学生的作答落不到
        这道题上（学情算不到考点）。
      </div>
    </>
  );
}

/** 出处 tab：provenance 四型，只摆该型该有的那几格（缺的就是缺，不填占位符） */
function 出处({ card }: { card: QuestionCard }) {
  const p: QuestionProvenance = card.provenance;
  const items: { key: string; label: string; children: React.ReactNode }[] = [
    {
      key: "type",
      label: "类型",
      children: (
        <span style={{ fontSize: 12.5 }}>
          <Tag>{p.type}</Tag>
          <span style={灰}>{PROV_名[p.type] ?? "（未知型）"}</span>
        </span>
      ),
    },
  ];

  if (p.sourceDoc) {
    items.push({
      key: "doc",
      label: "源文档",
      children: (
        <span style={{ fontSize: 12.5 }}>
          {p.sourceDoc.title}
          <span style={{ ...灰, marginInlineStart: 8 }}>
            {p.sourceDoc.kind ?? "类型未填"}
            {p.sourceDoc.pages === null ? "" : ` · 共 ${p.sourceDoc.pages} 页`}
          </span>
        </span>
      ),
    });
    items.push({
      key: "page",
      label: "第几页",
      children:
        p.pageNo === undefined ? (
          <span style={{ color: "#e6a23c", fontSize: 12.5 }}>
            没记页码 —— 回头核对时只能全本翻
          </span>
        ) : (
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{p.pageNo}</span>
        ),
    });
    if (p.sourceDoc.path) {
      items.push({
        key: "path",
        label: "源文件",
        children: (
          <span style={{ ...MONO, fontSize: 11.5 }}>{p.sourceDoc.path}</span>
        ),
      });
    }
  }

  if (p.model) {
    items.push({
      key: "model",
      label: "考察模型",
      children: (
        <span style={{ fontSize: 12.5 }}>
          {p.model.name}
          <Link
            href={`/kg/kp/${p.model.kpId}`}
            style={{ marginInlineStart: 8 }}
          >
            所属考点 →
          </Link>
          <StatusTag value={p.model.status} />
        </span>
      ),
    });
  }

  if (p.pipelineRef) {
    items.push({
      key: "pipe",
      label: "产线标识",
      children: (
        <span style={{ ...MONO, fontSize: 11.5 }}>{p.pipelineRef}</span>
      ),
    });
  }

  if (p.createdBy) {
    items.push({ key: "by", label: "录入人", children: p.createdBy });
  }

  if (p.batch) {
    items.push({
      key: "batch",
      label: "录题批次",
      children: (
        <span style={{ fontSize: 12.5 }}>
          <span style={{ ...MONO, fontSize: 11.5 }}>{p.batch.id}</span>
          <span style={{ ...灰, marginInlineStart: 8 }}>
            {p.batch.source} · {p.batch.contractVer} ·{" "}
            {p.batch.status ?? "状态未填"}
            {/* 🔴 检查单 §三·3 时间统一：原来这里直接把库里那整串 ISO 印出来
                （`2026-08-13T18:12:33+08:00`），全站口径是 `MM-DD HH:mm` +
                悬停看全量 —— 一律走 TimeText。 */}
            {p.batch.committedAt ? (
              <>
                {" · 提交于 "}
                <TimeText iso={p.batch.committedAt} />
              </>
            ) : null}
          </span>
          <div style={{ marginTop: 2 }}>
            <Link href={`/question?batch=${encodeURIComponent(p.batch.id)}`}>
              看这一批的题 →
            </Link>
            {/* 🔴 AI:PRD-009 检查单 4「看到即可达」：批次 id 摆在这儿却点不进闸报告，
                以前只能去 /ingest 里手动翻。现在 ?batch= 直接开那一批的全账抽屉。 */}
            <Link
              href={`/ingest?batch=${encodeURIComponent(p.batch.id)}`}
              style={{ marginInlineStart: 10 }}
            >
              看这一批的闸报告 →
            </Link>
            <span style={{ ...灰, marginInlineStart: 10 }}>
              agent 侧同一份账：<span style={MONO}>get_ingest_batch</span>
            </span>
          </div>
        </span>
      ),
    });
  }

  items.push({
    key: "matchKey",
    label: "查重键",
    children: (
      <span style={{ ...MONO, fontSize: 11, wordBreak: "break-all" }}>
        {card.matchKey ?? "（没算 match_key）"}
      </span>
    ),
  });
  items.push({
    key: "time",
    label: "时间",
    children: (
      // 🔴 检查单 §三·3 时间统一：这两处原来也是整串 ISO 直接印
      <span style={{ ...灰, fontSize: 12 }}>
        建于{" "}
        {card.createdAt ? <TimeText iso={card.createdAt} /> : <span>未知</span>}
        {card.updatedAt ? (
          <>
            {" · 改于 "}
            <TimeText iso={card.updatedAt} />
          </>
        ) : null}
      </span>
    ),
  });

  return <Descriptions size="small" column={1} bordered items={items} />;
}

export default async function QuestionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  await searchParams; // tab 由 client 侧的 QuestionTabs 读，这里只声明本页吃 query

  let card: QuestionCard;
  try {
    card = await getQuestion(id);
  } catch (e) {
    // 🔴 只有「库里没这道题」才是 404；库读不动是环境故障，必须原样炸出来
    if (e instanceof RetrievalError && e.code === "QUESTION_NOT_FOUND") {
      notFound();
    }
    throw e;
  }

  // 🔴 血缘/归属只读、与主查询无关：它们挂了不该把整页拖垮（页面主角是题的正本）
  const lin: LineageView = await getLineage(id).catch(() => ({
    questionId: id,
    bornOf: null,
    originOf: [],
  }));
  let skus: QuestionSkuPlacement[] = [];
  let skuError = "";
  try {
    skus = await listSkusOfQuestion(id);
  } catch (e) {
    skuError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  const 实算过 = card.solutionGrade === "calc_verified";

  const 基本信息 = (
    <>
      <正本段
        title="题面 stem"
        text={card.stem}
        空话="题面是空的 —— 这道题不该进库"
      />
      <正本段
        title="答案 answer"
        text={card.answer}
        空话="没有答案。判档是 analysis_only 时这是正常的（结论在解析里）。"
      />
      <正本段
        title="解析 analysis"
        text={card.analysis}
        空话="没有解析。solution_grade='no_solution' 的题默认不进检索（M1 Q11）。"
      />

      <Card
        size="small"
        title={`考点（${card.kps.length} 个 · ★ = 主考点）`}
        style={{ marginBottom: 12 }}
      >
        {card.kps.length === 0 ? (
          <div style={{ color: "#c45656", fontSize: 12.5 }}>
            一个考点都没挂 —— 按考点检索永远找不到它（录题闸③本该拦下这种题）。
          </div>
        ) : (
          <Space size={4} wrap>
            {card.kps.map((k) => (
              <Link key={k.kpId} href={`/kg/kp/${k.kpId}`}>
                <Tag color={k.isPrimary ? "blue" : "default"}>
                  {k.isPrimary ? "★" : ""}
                  {k.name}
                </Tag>
              </Link>
            ))}
          </Space>
        )}
        <div style={{ marginTop: 8, fontSize: 11.5, ...灰 }}>
          主考点 = 这题<b>到底在考什么</b>；副考点 = 顺带沾了点别的。resolve_kp
          的近邻投票只认主考点。
        </div>
      </Card>

      <Card
        size="small"
        title={`自由标签（${card.tags.length} 条）`}
        style={{ marginBottom: 12 }}
      >
        {card.tags.length > 0 ? (
          <Space size={4} wrap>
            {card.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </Space>
        ) : (
          <span style={{ ...灰, fontSize: 12.5 }}>没打自由标签。</span>
        )}
      </Card>

      <Card size="small" title={`配图（${card.figures.length} 张）`}>
        {card.figures.length === 0 ? (
          <span style={{ ...灰, fontSize: 12.5 }}>
            这道题没有配图（题面里也不该出现「［图」这类占位串，闸⑥盯着）。
          </span>
        ) : (
          <Space size={16} wrap align="start">
            {card.figures.map((fig) => (
              <figure key={fig.id} style={{ margin: 0, maxWidth: 340 }}>
                {fig.hash ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节，不进 next/image 优化管线
                  <img
                    src={`/api/asset/${fig.hash}`}
                    alt={`配图 ${fig.role ?? ""}`}
                    style={{
                      maxHeight: 300,
                      // 手机上不撑破容器（AI:PRD-009 检查单 5）
                      maxWidth: "100%",
                      border: "1px solid #ebeef5",
                      background: "#fff",
                    }}
                  />
                ) : (
                  <div style={{ color: "#c45656", fontSize: 12 }}>
                    这张图没有 asset 登记行（对账 C1c 会红）
                  </div>
                )}
                <figcaption style={{ marginTop: 4, fontSize: 11 }}>
                  <Tag color={fig.role === "stem" ? "orange" : "default"}>
                    {fig.role === "stem"
                      ? "题干图（必审）"
                      : (fig.role ?? "角色未填")}
                  </Tag>
                  <StatusTag value={fig.reviewState} />
                  <span style={MONO}>{fig.hash?.slice(0, 12) ?? ""}</span>
                  {fig.bytes === null ? null : (
                    <span style={{ marginInlineStart: 4 }}>
                      {(fig.bytes / 1024).toFixed(0)} KB
                    </span>
                  )}
                </figcaption>
              </figure>
            ))}
          </Space>
        )}
      </Card>
    </>
  );

  return (
    <>
      <PageHead
        title={<>题目详情</>}
        tags={
          <>
            <IdTail id={card.id} />
          </>
        }
        source={
          <>
            core.getQuestion（= MCP get_question）/ core.getLineage /
            core.listSkusOfQuestion · 表 question / question_kp / figure /
            exam_model / sku_item
          </>
        }
      />

      {/* ── 徽章条：一眼看清这道题「能不能直接拿去用」 ────────────────────── */}
      <Space size={4} wrap style={{ marginBottom: 12 }}>
        <StatusTag value={card.status} />
        <Tooltip
          title={实算过 ? "机器实算过（逐行恒等校验也过了）" : undefined}
        >
          <span>
            <StatusTag value={card.solutionGrade} />
          </span>
        </Tooltip>
        <Tag>{card.qtype ?? "题型未填"}</Tag>
        {card.difficulty === null ? (
          <Tooltip title="全库 difficulty 当下都是 NULL，打档是后续的活">
            <Tag color="orange">难度未打档</Tag>
          </Tooltip>
        ) : (
          <Tag>难度 {card.difficulty}</Tag>
        )}
        {card.reviewRequired ? (
          <Tooltip title="题干图入库即必审：图审通过前它不算数">
            <Tag color="red">必审 review_required</Tag>
          </Tooltip>
        ) : null}
        <Tag color={card.hasVector ? "green" : "orange"}>
          {card.hasVector ? "有句向量" : "没有句向量（语意轴找不到它）"}
        </Tag>
        {card.editionScope ? (
          <Tag>{card.editionScope}</Tag>
        ) : (
          <Tooltip title="edition_scope 为 NULL = 版本通用（M1 Q12）">
            <Tag>教材版本通用</Tag>
          </Tooltip>
        )}
        <Link href="/question">← 回题目管理</Link>
        <Link href={`/question?similar=${encodeURIComponent(card.id)}`}>
          找相似题 →
        </Link>
      </Space>

      {skuError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="「归属」那一块读不出来（原文照登）——不是「它没进过册子」"
          description={<span style={{ fontSize: 12.5 }}>{skuError}</span>}
        />
      ) : null}

      <QuestionTabs
        defaultKey="basic"
        items={[
          { key: "basic", label: "基本信息", children: 基本信息 },
          {
            key: "blood",
            label: `血缘${lin.bornOf || lin.originOf.length > 0 ? "" : "（无）"}`,
            children: <血缘 lin={lin} meId={card.id} />,
          },
          {
            key: "sku",
            label: `归属（${skus.length}）`,
            children: <归属 rows={skus} />,
          },
          { key: "prov", label: "出处", children: <出处 card={card} /> },
        ]}
      />
    </>
  );
}
