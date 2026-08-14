/**
 * KG 治理 · 总览（AI:PRD-002 · 002-D；AI:PRD-009 打磨批换壳）
 *
 * 一屏回答三件事：概念层有多厚（考点/卡片/别名/挂位）、有哪几棵版本树、队列里积了多少活。
 * 版本树管理（active ↔ readonly）也在这页 —— 树就这么七棵，为它单开一页是浪费。
 *
 * 🔴 页面只读 core 的读侧函数，一个 SQL 都不自己写（app 层 import 不到 db）。
 *
 * ── AI:PRD-009 打磨（只动版面与交互，业务语义一个字没改）────────────────────
 *   ① 一致性（检查单 10）：从 D1 作废的「学术纸感」kit 换成 antd + console/ui，
 *      与 /question、/sku、/queue 同一套 tag 色 / 间距 / 标题层级；
 *   ② 二次确认（检查单 7）：切版本树状态原来是**裸 submit** —— 点一下直接改库。
 *      现在统一走 ConfirmSubmit 弹层，把影响面（唯一索引、谁会被顶掉）写在弹层里。
 *      🔴 动作本身没变：仍是同一个 setTreeStatusAction；
 *   ③ 跳转贯通（检查单 4）：每张统计卡都能点进对应页（点不进的如实不给链接）；
 *   ④ 空态（检查单 6）：一棵树都没有时给口径原句，不留白。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import {
  EmptyHint,
  IdTail,
  StatCard,
  StatusTag,
} from "~/components/console/ui";
import { countOpenQueueByKind, kgOverview, listEditionTrees } from "~/core";
import { setTreeStatusAction } from "./actions";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { Num } from "~/components/console/table";
import { param, treeLabel } from "./shared";

export const dynamic = "force-dynamic";

export default async function KgHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  const [overview, trees, queue] = await Promise.all([
    kgOverview(),
    listEditionTrees(),
    countOpenQueueByKind(),
  ]);
  const openTotal = queue.reduce((a, b) => a + b.count, 0);

  return (
    <>
      <PageHead
        title="知识图谱"
        sub="概念层（考点）版本无关，教材版本只活在树上 —— 换教材换树，考点不动"
        source={
          <>
            core.kgOverview / core.listEditionTrees / core.countOpenQueueByKind
            · 表 kp / kp_alias / node_kp_map / edition_tree / review_queue
          </>
        }
      />

      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{err}</span>}
        />
      ) : null}
      {ok ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{ok}</span>}
        />
      ) : null}

      {/* ── 概念层一屏数字 ─────────────────────────────────────────────────
          🔴 能点的才给链接（StatCard 的规矩）：
             「考点」「写了卡」「别名」「挂位」没有对应的列表页 —— 概念层的入口
             是下面的版本树与考点详情，硬给一个链接只会点进一个筛不出这个数的页。 */}
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          marginBottom: 14,
        }}
      >
        <StatCard
          label="考点（kp）"
          value={overview.kpTotal}
          sub="概念层总量 · 版本无关"
        />
        <StatCard
          label="写了考点卡"
          value={overview.kpWithCard}
          sub={`占 ${overview.kpTotal > 0 ? Math.round((overview.kpWithCard / overview.kpTotal) * 100) : 0}%`}
        />
        <StatCard
          label="别名"
          value={overview.aliasTotal}
          sub={`${overview.kpWithAlias} 个考点有别名`}
        />
        <StatCard
          label="教材挂位"
          value={overview.mapTotal}
          sub="node_kp_map"
        />
        <StatCard
          label="一棵树都没挂"
          value={overview.kpUnplaced}
          sub="按章节召回不到它"
        />
        <StatCard
          label="待裁工单"
          value={openTotal}
          sub={openTotal > 0 ? "去处置台裁一裁" : "队列是空的"}
          href="/queue"
        />
      </div>

      <div
        style={{
          fontSize: 12,
          color: "#606266",
          marginBottom: 18,
          lineHeight: 2,
        }}
      >
        考点状态：
        {Object.entries(overview.kpByStatus).map(([s, c]) => (
          <span key={s} style={{ marginInlineEnd: 8 }}>
            <StatusTag value={s} />
            <Num n={c} />
          </span>
        ))}
        {queue.length > 0 ? (
          <>
            <span style={{ color: "#dcdfe6", marginInline: 6 }}>｜</span>
            待裁工单按类：
            {queue.map((q) => (
              <Link key={q.kind} href="/queue" style={{ marginInlineEnd: 8 }}>
                {q.kind} <Num n={q.count} tone="warn" />
              </Link>
            ))}
          </>
        ) : null}
      </div>

      {/* ── 版本树 ──────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 2px" }}>
        版本树（{trees.length} 棵 · 现役 {overview.treeActive}）
      </h2>
      <div style={{ fontSize: 12, color: "#909399", marginBottom: 12 }}>
        🔴 同一 学科×教材版本×册 至多一棵 active（库里是部分唯一索引）。
        新版教材上架 = 老树先转 readonly，再把新树转 active。
      </div>

      {trees.length === 0 ? (
        <Card size="small">
          <EmptyHint>
            一棵版本树都没有。🔴 这不是「教材没铺完」，是**连树都还没建** ——
            没有树，考点就挂不上章节，出题时按章节召回永远是空的。 建树走 core
            的 upsertEditionTree（脚本口）。
          </EmptyHint>
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {trees.map((t) => {
            const active = t.status === "active";
            const 目标 = active ? "readonly" : "active";
            return (
              <Card
                key={t.id}
                size="small"
                title={<span style={{ fontSize: 13 }}>{treeLabel(t)}</span>}
                extra={
                  active ? (
                    <StatusTag value="active" title="现役：本册的当前教材树" />
                  ) : (
                    <Tag color="orange">{t.status ?? "状态为 NULL"}</Tag>
                  )
                }
              >
                <div style={{ fontSize: 12, color: "#909399" }}>
                  {t.subject} · v{t.version}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    display: "flex",
                    gap: 16,
                    fontSize: 12.5,
                  }}
                >
                  <span>
                    <Num n={t.nodeCount} big /> 节点
                  </span>
                  <span>
                    <Num n={t.mapCount} big /> 挂位
                  </span>
                  <span>
                    <Num n={t.kpCount} big /> 考点
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <Link href={`/kg/tree/${t.id}`}>浏览章节 →</Link>
                  <form
                    action={setTreeStatusAction}
                    style={{ marginLeft: "auto" }}
                  >
                    <input type="hidden" name="treeId" value={t.id} />
                    <input type="hidden" name="status" value={目标} />
                    <input type="hidden" name="label" value={treeLabel(t)} />
                    <ConfirmSubmit
                      label={active ? "转归档 readonly" : "转现役 active"}
                      title={
                        active
                          ? `把「${treeLabel(t)}」转成归档？`
                          : `把「${treeLabel(t)}」转成现役？`
                      }
                      description={
                        active ? (
                          <>
                            只改 <b>edition_tree.status</b> 这一格（
                            {t.nodeCount} 个节点、{t.mapCount} 处挂位
                            <b>一行都不动</b>）。
                            <br />
                            归档后这册就<b>没有现役树</b>了 ——
                            按章节召回会落空，直到你把新树转 active。可逆。
                          </>
                        ) : (
                          <>
                            只改 <b>edition_tree.status</b> 这一格。
                            <br />
                            🔴 同一 学科×教材版本×册 至多一棵
                            active（库里是部分唯一
                            索引）：这一册若已有现役树，core 会<b>直接拒</b>
                            并把人话报错端到页顶 —— 先把老树转 readonly。可逆。
                          </>
                        )
                      }
                      okText={active ? "确认归档" : "确认转现役"}
                    />
                  </form>
                </div>
                <div style={{ marginTop: 8 }}>
                  <IdTail id={t.id} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div
        style={{
          marginTop: 18,
          fontSize: 12,
          color: "#909399",
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <Link href="/kg/merge">合并向导 →</Link>
        <Link href="/queue">
          审查队列{openTotal > 0 ? `（${openTotal}）` : ""} →
        </Link>
      </div>
    </>
  );
}
