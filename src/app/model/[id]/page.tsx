/**
 * 生产管理 · 模型族谱（AI:PRD-008 · P2 · 设计稿 §二·9「操作列 → 族谱」）
 *
 * 一个考察模型的全貌 + 它的族谱（母题 → 本模型 → 派生变式）。
 * **不管**建模（MCP 的 propose_model）与转正（人在处置台点通过 → core.activateModel；
 * 🔴 MCP 表面没有 activate_model 这个工具，别在页面上写它）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 族谱是**从母题那一侧进去的**（core 的 getLineage 吃的是 questionId）：
 *    对每一道 origin 母题调一次 getLineage，在它的 `originOf` 里找出「本模型」
 *    那一支，那一支的 `derived` 就是本模型的派生题。
 *
 *    ⚠️ 所以：**模型没记母题（origin_qids_json 空）时，这条路进不去** ——
 *    core 没有「按 model_id 列题」的只读函数（getModel 只给一个 questionCount
 *    这个数）。这时页面照实说「出题数 N 是真的，但列不出是哪 N 道」，
 *    绝不拿别的东西冒充族谱。补母题：建模时 propose_model 带 origin_qids，
 *    已建好的走 scripts/model-origins-*.ts（core.setModelOrigins）——
 *    🔴 没有 set_model_origins 这个 MCP 工具。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync } from "node:fs";

import { Alert, Card, Descriptions, Tag, Tooltip } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import {
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import { getLineage, getModel, getQuestion, stemBrief } from "~/core";
import { splitDslRef } from "../shared";
import {
  DerivedTable,
  JsonBlocks,
  OriginTable,
  type LineageQuestionView,
} from "./lineage";

export const dynamic = "force-dynamic";

/** 派生题一次最多列多少（core 的 getLineage limit 上限 200） */
const DERIVED_LIMIT = 200;

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let card: Awaited<ReturnType<typeof getModel>> = null;
  let loadError = "";
  try {
    card = await getModel(id);
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="这个模型读不出来（原文照登）"
        description={
          <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {loadError}
            {"\n"}
            id = {id}
          </div>
        }
      />
    );
  }

  if (!card) {
    return (
      <Card size="small">
        <EmptyHint>
          exam_model 表里没有 id = {id} 这一行 —— 回{" "}
          <Link href="/model">考察模型</Link> 从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  const { file, fragment } = splitDslRef(card.dslRef);
  let onDisk: boolean | null = null;
  if (file) {
    try {
      onDisk = existsSync(file);
    } catch {
      onDisk = false;
    }
  }

  // ── 族谱：逐道母题进去，捞本模型那一支 ──────────────────────────────────
  //   🔴 先把 id 取成 const：`card` 是 let（try/catch 要求），
  //      TS 对 let 的窄化**进不了回调**，在 find 里写 card.id 会报可能为 null。
  const 本模型id = card.id;
  const 母题: LineageQuestionView[] = [];
  const 派生Map = new Map<string, LineageQuestionView>();
  let 派生总数: number | null = null;
  const 族谱警告: string[] = [];

  for (const qid of card.originQids) {
    try {
      const q = await getQuestion(qid);
      母题.push({
        questionId: qid,
        stemBrief: stemBrief(q.stem),
        status: q.status,
        qtype: q.qtype,
      });
    } catch {
      // 🔴 母题查无此行是**血缘断链**，如实摆出来（不静默丢）
      母题.push({
        questionId: qid,
        stemBrief:
          "🔴 这道母题不在库里（origin_qids_json 指了个查无此行的 id）",
        status: "missing",
        qtype: null,
      });
    }

    try {
      const lin = await getLineage(qid, { limit: DERIVED_LIMIT });
      const 本支 = lin.originOf.find((m) => m.modelId === 本模型id);
      if (本支) {
        派生总数 = Math.max(派生总数 ?? 0, 本支.derivedTotal);
        for (const d of 本支.derived) {
          if (!派生Map.has(d.questionId)) {
            派生Map.set(d.questionId, {
              questionId: d.questionId,
              stemBrief: d.stemBrief,
              status: d.status,
              qtype: d.qtype,
              via: qid,
            });
          }
        }
      }
    } catch (e) {
      族谱警告.push(
        `从母题 ${qid} 进族谱失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const 派生 = [...派生Map.values()];
  const 进不去 = card.originQids.length === 0;

  return (
    <>
      {/* 🔴 flexWrap：模型名本来就长，窄屏上不换行会把标题挤成竖排（全站页头一律 wrap） */}
      <PageHead
        title={<>{card.name}</>}
        tags={
          <>
            <StatusTag value={card.status} />
            <span style={{ fontSize: 12.5, color: "#909399" }}>
              考察模型 · 族谱
            </span>
          </>
        }
        source={
          <>
            core.getModel + core.getLineage · 表 exam_model / question（model_id
            / origin_qids_json）
          </>
        }
      />

      {/* 🔴 flexWrap + rowGap：手机上这一排链接必须能折行 */}
      <div
        style={{
          display: "flex",
          gap: 14,
          rowGap: 8,
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <Link href="/model">← 回模型台账</Link>
        {/* 🔴 看到即可达：归位考点在上面的卡里出现过，这里给它一条直达链 */}
        <Link href={`/kg/kp/${card.kpId}`}>
          归位考点详情{card.kpName ? `（${card.kpName}）` : ""}
        </Link>
        <Link href={`/question?kp=${card.kpId}`}>
          看这个考点下的题（不等于本模型出的题）
        </Link>
        {card.openQueueId ? (
          <Tooltip title="处置台点「通过」= core 的 activateModel：模型 proposed→active + 工单同一事务关掉（不是只关工单）">
            <Link href="/queue?tab=other">去处置台裁这张转正工单 →</Link>
          </Tooltip>
        ) : null}
      </div>

      <Card size="small" title="基本信息" style={{ marginBottom: 12 }}>
        <Descriptions
          size="small"
          // 🔴 响应式：写死 column={3} 时「生成器 dsl_ref」那格在手机上会被压成
          //    一列一个字（它装的是一条 Windows 全路径）
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            {
              key: "kp",
              label: "归位考点",
              children: card.kpName ? (
                <Link href={`/kg/kp/${card.kpId}`}>
                  <Tag color="blue">{card.kpName}</Tag>
                </Link>
              ) : (
                <Tooltip title={`kp_id = ${card.kpId}（考点名没读出来）`}>
                  <Tag>考点名未取到</Tag>
                </Tooltip>
              ),
            },
            {
              key: "status",
              label: "状态",
              children: (
                <span>
                  <StatusTag value={card.status} />
                  {card.openQueueId ? (
                    <Tooltip title={`转正工单：${card.openQueueId}`}>
                      <Tag color="orange">还开着转正工单</Tag>
                    </Tooltip>
                  ) : null}
                </span>
              ),
            },
            {
              key: "difficulty",
              label: "难度",
              children: card.difficulty ?? "（未打档）",
            },
            {
              key: "nq",
              label: "出题数",
              children: (
                <Tooltip title="question.model_id 指向它的题有多少道（这个数是 SQL 现算的，准）">
                  <b>{card.questionCount}</b>
                </Tooltip>
              ),
            },
            {
              key: "origins",
              label: "母题数",
              children: card.originQids.length,
            },
            {
              key: "id",
              label: "id",
              children: <IdTail id={card.id} />,
            },
            {
              key: "created",
              label: "建档",
              children: <TimeText iso={card.createdAt} />,
            },
            {
              key: "activated",
              label: "转正",
              children:
                card.activatedAt === null ? (
                  <span style={{ color: "#909399" }}>还没转正</span>
                ) : (
                  <TimeText iso={card.activatedAt} />
                ),
            },
            {
              key: "dsl",
              label: "生成器 dsl_ref",
              children:
                onDisk === null ? (
                  <Tooltip title="exam_model.dsl_ref 是空的 —— 这个模型指不回任何生成器">
                    <span style={{ color: "#e6a23c" }}>没记</span>
                  </Tooltip>
                ) : (
                  <Tooltip
                    title={card.dslRef ?? ""}
                    styles={{ root: { maxWidth: 560 } }}
                  >
                    <span style={{ fontSize: 12 }}>
                      <Tag color={onDisk ? "green" : "red"}>
                        {onDisk ? "✓ 在盘" : "✗ 不在盘"}
                      </Tag>
                      <span
                        style={{ fontFamily: "Consolas, Menlo, monospace" }}
                      >
                        {file}
                        {fragment ? `#${fragment}` : ""}
                      </span>
                    </span>
                  </Tooltip>
                ),
            },
          ]}
        />
      </Card>

      {进不去 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这个模型没记母题，族谱从母题侧进不去"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              <div>
                · core 的 getLineage 吃的是 questionId：没有一道 origin
                母题，就没有入口。
              </div>
              <div>
                · 而 core <b>没有</b>「按 model_id 列题」的只读函数 ——「出题数{" "}
                {card.questionCount}」这个数是真的（SQL 现算），
                但列不出是哪几道。页面不拿别的东西冒充族谱。
              </div>
              <div>
                · 补母题<b>没有 MCP 工具</b>（set_model_origins 是 core
                的函数名，不是工具名）：建模时 <code>propose_model</code> 带{" "}
                <code>origin_qids</code>，已建好的走{" "}
                <code>scripts/model-origins-*.ts</code>。补完这一页自然长出来。
              </div>
            </div>
          }
        />
      ) : null}

      {族谱警告.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="族谱有一部分没读出来（原文照登）"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {族谱警告.map((w, i) => (
                <div key={`w${i}`}>· {w}</div>
              ))}
            </div>
          }
        />
      ) : null}

      <Card
        size="small"
        title={`母题（这个模型是从哪几道真题归纳出来的 · ${card.originQids.length} 道）`}
        style={{ marginBottom: 12 }}
      >
        <OriginTable rows={母题} />
      </Card>

      <Card
        size="small"
        title={`派生题（本模型名下 · 列出 ${派生.length} 道）`}
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            经母题的族谱查出来；与上面「出题数 {card.questionCount}」对不上时，
            差的是没回填 model_id 或超出 {DERIVED_LIMIT} 条上限的那部分
          </span>
        }
      >
        <DerivedTable rows={派生} total={派生总数} />
      </Card>

      <Card size="small" title="模板 / 变量规格 / 错误模型（原文）">
        <JsonBlocks
          blocks={[
            {
              key: "stem",
              label: "题干模板 stem_template",
              text: card.stemTemplate,
            },
            {
              key: "var",
              label: "变量规格 var_spec_json",
              text: card.varSpecJson,
            },
            {
              key: "err",
              label: "错误模型 error_model_json",
              text: card.errorModelJson,
            },
          ]}
        />
      </Card>
    </>
  );
}
