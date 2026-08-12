/**
 * KG 治理 · 总览（AI:PRD-002 · 002-D）
 *
 * 一屏回答三件事：概念层有多厚（考点/卡片/别名/挂位）、有哪几棵版本树、队列里积了多少活。
 * 版本树管理（active ↔ readonly）也在这页 —— 树就这么七棵，为它单开一页是浪费。
 *
 * 🔴 页面只读 core 的读侧函数，一个 SQL 都不自己写（app 层 import 不到 db）。
 */
import Link from "next/link";

import { Chip, Kpi, Notice, PageHead, Panel } from "~/components/kit";
import { countOpenQueueByKind, kgOverview, listEditionTrees } from "~/core";
import { setTreeStatusAction } from "./actions";
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
        sub={
          <>
            概念层（考点）版本无关，教材版本只活在树上 —— 换教材换树，考点不动。
          </>
        }
        right={
          <div className="flex gap-2 text-[12.5px]">
            <Link className="text-acc-deep underline" href="/kg/merge">
              合并向导
            </Link>
            <Link className="text-acc-deep underline" href="/kg/queue">
              提议审批{openTotal > 0 ? `（${openTotal}）` : ""}
            </Link>
          </div>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      {/* ── 概念层一屏数字 ─────────────────────────────────────────────── */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi n={overview.kpTotal} label="考点（kp）" tone="acc" />
        <Kpi n={overview.kpWithCard} label="写了考点卡" />
        <Kpi
          n={overview.aliasTotal}
          label={`别名（${overview.kpWithAlias} 个考点有）`}
        />
        <Kpi n={overview.mapTotal} label="教材挂位" />
        <Kpi
          n={overview.kpUnplaced}
          label="一棵树都没挂"
          tone={overview.kpUnplaced > 0 ? "pen" : undefined}
        />
        <Kpi
          n={openTotal}
          label="待裁工单"
          tone={openTotal > 0 ? "pen" : undefined}
        />
      </div>

      <div className="text-mut mb-5 text-[12px]">
        考点状态：
        {Object.entries(overview.kpByStatus).map(([s, c]) => (
          <span key={s} className="mr-2">
            <span className="num">{c}</span> {s}
          </span>
        ))}
        {queue.length > 0 ? (
          <>
            ｜待裁工单按类：
            {queue.map((q) => (
              <span key={q.kind} className="mr-2">
                <span className="num">{q.count}</span> {q.kind}
              </span>
            ))}
          </>
        ) : null}
      </div>

      {/* ── 版本树 ──────────────────────────────────────────────────────── */}
      <h2 className="font-serif text-[17px] font-bold tracking-[1px]">
        版本树（{trees.length} 棵 · 现役 {overview.treeActive}）
      </h2>
      <div className="text-mut mt-[3px] mb-3 text-[12px]">
        🔴 同一 学科×教材版本×册 至多一棵
        active（库里是部分唯一索引）。新版教材上架 = 老树先转
        readonly，再把新树转 active。
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {trees.map((t) => {
          const active = t.status === "active";
          return (
            <Panel
              key={t.id}
              title={treeLabel(t)}
              right={
                active ? (
                  <Chip tone="g">现役 active</Chip>
                ) : (
                  <Chip tone="a">{t.status ?? "状态为 NULL"}</Chip>
                )
              }
            >
              <div className="text-mut text-[12px]">
                {t.subject} · v{t.version}
              </div>
              <div className="mt-1.5 flex gap-4 text-[12.5px]">
                <span>
                  <span className="num text-[15px]">{t.nodeCount}</span> 节点
                </span>
                <span>
                  <span className="num text-[15px]">{t.mapCount}</span> 挂位
                </span>
                <span>
                  <span className="num text-[15px]">{t.kpCount}</span> 考点
                </span>
              </div>
              <div className="mt-2.5 flex items-center gap-3">
                <Link
                  href={`/kg/tree/${t.id}`}
                  className="text-acc-deep text-[12.5px] underline"
                >
                  浏览章节 →
                </Link>
                {/* 状态切换是可逆动作，不设确认页；撞唯一约束时 core 的人话会显示在页顶 */}
                <form action={setTreeStatusAction} className="ml-auto">
                  <input type="hidden" name="treeId" value={t.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={active ? "readonly" : "active"}
                  />
                  <input type="hidden" name="label" value={treeLabel(t)} />
                  <button
                    type="submit"
                    className="border-hair2 hover:bg-sel rounded-[2px] border px-2 py-[3px] text-[11.5px]"
                  >
                    {active ? "转归档 readonly" : "转现役 active"}
                  </button>
                </form>
              </div>
              <div className="text-mut mt-1.5 font-mono text-[10.5px] break-all">
                {t.id}
              </div>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
