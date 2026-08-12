/**
 * KG 治理 · 树浏览（AI:PRD-002 · 002-D）
 *
 * 一棵册子的章节层级 + 每一节挂着哪些考点。考点名可点进详情页。
 * 🔴 这页是「教材视角」：同一个考点会在人教树和浙教树上各出现一次，那是对的
 *    （概念层一个，挂位两处）—— 想看一个考点的全部挂位，去它的详情页。
 */
import Link from "next/link";

import { Chip, PageHead } from "~/components/kit";
import { treeOutline, type TreeNodeView } from "~/core";
import { treeLabel } from "../../shared";

export const dynamic = "force-dynamic";

/** 一层节点（章 → 节 → …）。层级由 parentId 还原，不假定只有两层。 */
function NodeList({
  nodes,
  byParent,
  depth,
}: {
  nodes: TreeNodeView[];
  byParent: Map<string | null, TreeNodeView[]>;
  depth: number;
}) {
  return (
    <ul className={depth === 0 ? "space-y-3" : "mt-1.5 space-y-2"}>
      {nodes.map((n) => {
        const kids = byParent.get(n.id) ?? [];
        return (
          <li
            key={n.id}
            className={
              depth === 0
                ? "border-hair bg-sheet rounded-[3px] border px-[15px] py-3"
                : "border-hair border-l pl-3"
            }
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                className={
                  depth === 0
                    ? "font-serif text-[15px] font-bold"
                    : "text-[13px] font-semibold"
                }
              >
                {n.name}
              </span>
              <span className="text-mut text-[11px]">
                L{n.level ?? "?"} · sort {n.sort ?? "—"}
              </span>
              {n.kps.length > 0 ? (
                <span className="text-mut text-[11px]">
                  挂 <span className="num">{n.kps.length}</span> 个考点
                </span>
              ) : kids.length === 0 ? (
                // 叶子却一个考点都没挂 = 这一节还没铺，说出来比留白强
                <span className="text-amber text-[11px]">这一节还没挂考点</span>
              ) : null}
            </div>

            {n.kps.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                {n.kps.map((k) => (
                  <Link
                    key={k.kpId}
                    href={`/kg/kp/${k.kpId}`}
                    className="hover:text-acc-deep underline decoration-dotted"
                  >
                    {k.name}
                    {k.status === "active" ? null : (
                      <span className="text-mut">（{k.status}）</span>
                    )}
                  </Link>
                ))}
              </div>
            ) : null}

            {kids.length > 0 ? (
              <NodeList nodes={kids} byParent={byParent} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export default async function TreePage({
  params,
}: {
  params: Promise<{ treeId: string }>;
}) {
  const { treeId } = await params;
  const outline = await treeOutline(decodeURIComponent(treeId));

  if (!outline) {
    return (
      <>
        <PageHead title="版本树" sub="这棵树不在库里" />
        <div className="text-pen text-[12.5px]">
          树 {treeId} 查不到。回 <Link href="/kg">知识图谱总览</Link>{" "}
          看现有的几棵。
        </div>
      </>
    );
  }

  const { tree, nodes } = outline;
  const byParent = new Map<string | null, TreeNodeView[]>();
  for (const n of nodes) {
    const key = n.parentId;
    byParent.set(key, [...(byParent.get(key) ?? []), n]);
  }
  // 🔴 父不在本树（脏数据）时它的孩子会挂在一个查不到的 key 上 —— 那样整枝会看不见，
  //    所以「根」= parentId 为空，或 parentId 指向的节点不在本树里。
  const 本树 = new Set(nodes.map((n) => n.id));
  const roots = nodes.filter((n) => !n.parentId || !本树.has(n.parentId));

  return (
    <>
      <PageHead
        title={treeLabel(tree)}
        sub={
          <>
            {tree.subject} · v{tree.version} ·{" "}
            <span className="num">{tree.nodeCount}</span> 节点 ·{" "}
            <span className="num">{tree.mapCount}</span> 挂位 ·{" "}
            <span className="num">{tree.kpCount}</span> 个考点
          </>
        }
        right={
          <div className="flex items-baseline gap-2">
            {tree.status === "active" ? (
              <Chip tone="g">现役 active</Chip>
            ) : (
              <Chip tone="a">{tree.status ?? "状态为 NULL"}</Chip>
            )}
            <Link className="text-acc-deep text-[12.5px] underline" href="/kg">
              ← 总览
            </Link>
          </div>
        }
      />

      {roots.length === 0 ? (
        <div className="text-mut text-[12.5px]">这棵树还一个节点都没有。</div>
      ) : (
        <NodeList nodes={roots} byParent={byParent} depth={0} />
      )}

      <hr className="rule-double my-5 border-0" />
      <div className="text-mut text-[12px]">
        考点旁的（draft/merged/retired）是概念层状态；
        <span className="text-pen">
          merged / retired 还挂在树上 = 对账 C2 的红旗
        </span>
        ，看到了就去详情页处理。
      </div>
    </>
  );
}
