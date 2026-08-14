/**
 * SKU 排重报告（AI:PRD-008 · P2 · 设计稿 §二·8「排重报告」）
 *
 * 对这本册子的题单跑一次 core 的 {@link assertNoSoldDuplicates}，**只读展示**。
 * 出册前置闸与录题闸⑦的差别在**归因**：闸⑦说「撞了 q_01KZ…」，
 * 这里说「撞了《绝对值突破》第 37 题，在售」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 两个必须写在页面上、不能只写在注释里的口径
 *
 *   ① **自撞是必然的**：这本册子的题本来就在库里，match_key 一算当然撞到自己。
 *      所以报告把「撞到的是自己」和「撞到别的题」分开数 —— 只有后者是事故。
 *   ② **题面必须取正本**：core 的 getSku 只给 stemBrief（截断 140 字 + 去 HTML），
 *      拿它算 match_key 会算出**另一个键**，报告就会假绿。
 *      所以本页逐题 getQuestion 取 `stem` 正本再送检 —— 慢一点，但结果是真的。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 语义轴默认**关**：开一次要跑整册的句向量（本地 ONNX），一本 120 题的册子
 *    要等好几秒。想看「同模板换数」那类近似，点页面上那个开关（?similar=1）。
 */
import { Alert, Card, Descriptions, Tag, Tooltip } from "antd";
import Link from "next/link";

import { DataSourceNote, EmptyHint, StatusTag } from "~/components/console/ui";
import {
  assertNoSoldDuplicates,
  getQuestion,
  getSku,
  type SkuOwner,
  type SoldDupItem,
} from "~/core";
import {
  CollisionTable,
  SimilarTable,
  type DupViewRow,
  type OwnerView,
  type SimilarViewRow,
} from "./report";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function SkuDedupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const 开语义 = one(sp, "similar") === "1";

  const card = await getSku(id);
  if (!card) {
    return (
      <Card size="small">
        <EmptyHint>
          sku 表里没有 id = {id} 这一行 —— 回 <Link href="/sku">SKU 台账</Link>{" "}
          从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  // ── 取题面正本（见文件头 §②）────────────────────────────────────────────
  const 送检: SoldDupItem[] = [];
  /** 送检序号 ord → 那道题的 id（报告里要判「撞到的是不是自己」） */
  const 位次题 = new Map<number, string>();
  const 取不到: { ord: number; questionId: string | null; why: string }[] = [];

  for (const it of card.items) {
    if (!it.questionId) {
      取不到.push({
        ord: it.ord,
        questionId: null,
        why: "这个题位没有题（sku_item.question_id 是空的）",
      });
      continue;
    }
    try {
      const q = await getQuestion(it.questionId);
      送检.push({ seq: it.ord, stem: q.stem });
      位次题.set(it.ord, it.questionId);
    } catch (e) {
      取不到.push({
        ord: it.ord,
        questionId: it.questionId,
        why: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const t0 = Date.now();
  let 报告: Awaited<ReturnType<typeof assertNoSoldDuplicates>> | null = null;
  let 报告错 = "";
  try {
    报告 = await assertNoSoldDuplicates(送检, 开语义 ? {} : { similar: false });
  } catch (e) {
    报告错 = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const ms = Date.now() - t0;

  const 归属 = (skus: SkuOwner[]): OwnerView[] =>
    skus.map((s) => ({ ...s, isThis: s.skuId === card.id }));

  const 撞车行: DupViewRow[] = (报告?.collisions ?? []).map((c) => {
    const 自己 = 位次题.get(c.seq) ?? null;
    return {
      ord: c.seq,
      questionId: 自己,
      stemBrief: c.stemBrief,
      matchKey: c.matchKey,
      hits: c.hits.map((h) => ({
        questionId: h.questionId,
        status: h.status,
        stemBrief: h.stemBrief,
        self: h.questionId === 自己,
        skus: 归属(h.skus),
      })),
    };
  });

  /** 真正要看的：除了自己之外还撞到别的题的那些位次 */
  const 真撞 = 撞车行.filter((r) => r.hits.some((h) => !h.self));
  const 只撞自己 = 撞车行.length - 真撞.length;
  /** 撞到的题落在别的册子里（跨册重复 = 最贵的那种） */
  const 跨册 = 真撞.filter((r) =>
    r.hits.some((h) => !h.self && h.skus.some((s) => !s.isThis)),
  ).length;

  const 近似行: SimilarViewRow[] = (报告?.similar ?? []).map((s, i) => ({
    key: `${s.seq}-${s.questionId}-${i}`,
    ord: s.seq,
    questionId: s.questionId,
    score: s.score,
    stemBrief: s.stemBrief,
    self: 位次题.get(s.seq) === s.questionId,
    skus: 归属(s.skus),
  }));

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>排重报告</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>{card.name}</span>
        <StatusTag value={card.status} />
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.assertNoSoldDuplicates（只读）· 题面正本取自 core.getQuestion ·
            归因表 sku_item / sku
          </DataSourceNote>
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <Link href={`/sku/${card.id}`}>← 回册子详情</Link>
        {开语义 ? (
          <Link href={`/sku/${card.id}/dedup`}>关掉语义轴（只看硬撞）</Link>
        ) : (
          <Link href={`/sku/${card.id}/dedup?similar=1`}>
            开语义轴（慢：要跑整册句向量）
          </Link>
        )}
      </div>

      {报告错 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="排重没跑成（原文照登）"
          description={
            <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {报告错}
            </span>
          }
        />
      ) : null}

      <Card size="small" style={{ marginBottom: 12 }}>
        <Descriptions
          size="small"
          column={4}
          items={[
            {
              key: "checked",
              label: "送检",
              children: `${报告?.checked ?? 0} 题（题单 ${card.counts.items} 题）`,
            },
            {
              key: "real",
              label: "真撞车",
              children: (
                <b style={{ color: 真撞.length > 0 ? "#c45656" : "#67c23a" }}>
                  {真撞.length} 题
                </b>
              ),
            },
            {
              key: "cross",
              label: "其中落在别的册子",
              children: (
                <b style={{ color: 跨册 > 0 ? "#c45656" : "#909399" }}>
                  {跨册} 题
                </b>
              ),
            },
            {
              key: "self",
              label: "只撞到自己",
              children: `${只撞自己} 题（正常）`,
            },
            {
              key: "axis",
              label: "语义轴",
              children: 开语义 ? (
                报告?.degraded ? (
                  <Tag color="orange">降级（见下方原文）</Tag>
                ) : (
                  <Tag color="green">开 · 报告线 {报告?.threshold ?? "—"}</Tag>
                )
              ) : (
                <Tag>关（默认）</Tag>
              ),
            },
            {
              key: "ms",
              label: "耗时",
              children: `${ms}ms`,
            },
            {
              key: "unread",
              label: "取不到题面",
              children:
                取不到.length === 0 ? (
                  <span style={{ color: "#909399" }}>0</span>
                ) : (
                  <b style={{ color: "#c45656" }}>{取不到.length} 个题位</b>
                ),
            },
            {
              key: "ok",
              label: "core 的 ok",
              children: 报告 ? (
                <Tooltip
                  title={
                    报告.ok
                      ? "core 的口径：一处 match_key 硬撞都没有"
                      : "🔴 core 的 ok 只要有任何一处 match_key 撞车就是 false —— 而自撞必然发生，所以对「已经入库的册子」这个 ok 恒为 false。真正要看的是左边那个『真撞车』。"
                  }
                >
                  <Tag color={报告.ok ? "green" : "default"}>
                    {报告.ok ? "true" : "false（含自撞）"}
                  </Tag>
                </Tooltip>
              ) : (
                <span style={{ color: "#909399" }}>没跑成</span>
              ),
            },
          ]}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            🔴 自撞是必然的：这本册子的题本来就在库里，match_key
            一算当然撞到自己 ——
            所以「真撞车」只数「除自己之外还撞到别的题」的位次。
          </span>
        }
        description={
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            <div>
              · 题面取的是 core.getQuestion 的 <b>stem 正本</b>，不是列表页那种
              140 字摘要 —— 摘要算出来的 match_key 是另一个键，报告会假绿。
            </div>
            <div>
              · 查重看的是<b>题的状态</b>
              （pending/active），不看册子在不在售；册子的 draft/active/retired
              只影响这里显示成什么颜色。
            </div>
            <div>
              · 「core 的 ok」那一格是 core 自己的口径（有任何 match_key 撞车即
              false）—— 对已经入库的册子它恒为 false，别拿它当结论。
            </div>
            {(报告?.warnings ?? []).map((w, i) => (
              <div key={`w${i}`} style={{ color: "#c45656" }}>
                ⚠ {w}
              </div>
            ))}
          </div>
        }
      />

      {取不到.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`有 ${取不到.length} 个题位的题面取不到 —— 它们没有参与这次排重（不是「查过了没撞」）`}
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {取不到.map((x) => (
                <div key={x.ord}>
                  · 第 {x.ord} 题（{x.questionId ?? "无 question_id"}）：{x.why}
                </div>
              ))}
            </div>
          }
        />
      ) : null}

      <Card
        size="small"
        title={`硬撞（match_key）· 真撞车 ${真撞.length} 题`}
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            只列「除自己之外还撞到别的题」的位次；只撞自己的 {只撞自己}{" "}
            题不占篇幅
          </span>
        }
      >
        <CollisionTable rows={真撞} />
      </Card>

      <Card
        size="small"
        title={`语义近似（只报不拦）· ${近似行.length} 处`}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            {开语义
              ? "报告线以上的近邻；同模板换数本来就该长得像"
              : "语义轴这次没开 —— 上面那个开关点一下才跑"}
          </span>
        }
      >
        {开语义 ? (
          <SimilarTable rows={近似行} />
        ) : (
          <EmptyHint>
            语义轴本次被显式关掉（similar:false），这一段<b>没有查过</b> ——
            不是「查过了没有」。要看「同款不同参」那类近似，点上面的开关。
          </EmptyHint>
        )}
      </Card>
    </>
  );
}
