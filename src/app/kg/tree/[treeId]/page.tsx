/**
 * KG 治理 · 树浏览（AI:PRD-002 · 002-D；AI:PRD-009 打磨批换壳）
 *
 * 一棵册子的章节层级 + 每一节挂着哪些考点。考点名可点进详情页。
 * 🔴 这页是「教材视角」：同一个考点会在人教树和浙教树上各出现一次，那是对的
 *    （概念层一个，挂位两处）—— 想看一个考点的全部挂位，去它的详情页。
 *
 * ── AI:PRD-009 打磨（只动版面）──────────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；空态给口径原句（检查单 6）；
 *   页头补数据源小字；章节卡改自适应宽度，手机上不横向溢出（检查单 5）。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import { EmptyHint, IdTail, StatusTag } from "~/components/console/ui";
import { treeOutline, type TreeNodeView } from "~/core";
import { PageHead } from "~/components/console/page-head";
import { Num } from "~/components/console/table";
import { treeLabel } from "../../shared";

export const dynamic = "force-dynamic";

const 灰: React.CSSProperties = { color: "#909399" };

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
    <ul
      style={{
        listStyle: "none",
        margin: depth === 0 ? 0 : "6px 0 0",
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: depth === 0 ? 10 : 8,
      }}
    >
      {nodes.map((n) => {
        const kids = byParent.get(n.id) ?? [];
        const 内容 = (
          <>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: depth === 0 ? 14 : 13,
                  fontWeight: 600,
                }}
              >
                {n.name}
              </span>
              <span style={{ ...灰, fontSize: 11 }}>
                L{n.level ?? "?"} · sort {n.sort ?? "—"}
              </span>
              {n.kps.length > 0 ? (
                <span style={{ ...灰, fontSize: 11 }}>
                  挂 <Num n={n.kps.length} /> 个考点
                </span>
              ) : kids.length === 0 ? (
                // 叶子却一个考点都没挂 = 这一节还没铺，说出来比留白强
                <Tag color="orange">这一节还没挂考点</Tag>
              ) : null}
            </div>

            {n.kps.length > 0 ? (
              <div
                style={{
                  marginTop: 6,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "4px 12px",
                  fontSize: 12.5,
                }}
              >
                {n.kps.map((k) => (
                  <Link key={k.kpId} href={`/kg/kp/${k.kpId}`}>
                    {k.name}
                    {k.status === "active" ? null : (
                      <span style={灰}>（{k.status}）</span>
                    )}
                  </Link>
                ))}
              </div>
            ) : null}

            {kids.length > 0 ? (
              <NodeList nodes={kids} byParent={byParent} depth={depth + 1} />
            ) : null}
          </>
        );

        return depth === 0 ? (
          <li key={n.id}>
            <Card size="small" styles={{ body: { padding: "12px 14px" } }}>
              {内容}
            </Card>
          </li>
        ) : (
          <li
            key={n.id}
            style={{
              borderInlineStart: "1px solid #ebeef5",
              paddingInlineStart: 12,
            }}
          >
            {内容}
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
        <Alert
          type="error"
          showIcon
          message={`树 ${treeId} 查不到`}
          description={
            <span style={{ fontSize: 12.5 }}>
              🔴 树 id 是建树时发的号，编不出来也猜不出来 —— 回{" "}
              <Link href="/kg">知识图谱总览</Link> 看现有的几棵，从那儿点进来。
            </span>
          }
        />
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
        tags={
          tree.status === "active" ? (
            <StatusTag value="active" title="现役：本册的当前教材树" />
          ) : (
            <Tag color="orange">{tree.status ?? "状态为 NULL"}</Tag>
          )
        }
        sub={
          <>
            {tree.subject} · v{tree.version} · <Num n={tree.nodeCount} /> 节点 ·{" "}
            <Num n={tree.mapCount} /> 挂位 · <Num n={tree.kpCount} /> 个考点
          </>
        }
        source={
          <>core.treeOutline · 表 edition_tree / tree_node / node_kp_map</>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          fontSize: 12.5,
        }}
      >
        <Link href="/kg">← 回总览</Link>
        <IdTail id={tree.id} />
      </div>

      {roots.length === 0 ? (
        <Card size="small">
          <EmptyHint>
            这棵树还一个节点都没有。🔴
            「没有节点」不是「这册没内容」——是章节骨架还没录：
            骨架没铺，考点就没地方挂，按章节召回永远是空的。
          </EmptyHint>
        </Card>
      ) : (
        <NodeList nodes={roots} byParent={byParent} depth={0} />
      )}

      <div
        style={{
          marginTop: 18,
          paddingTop: 12,
          borderTop: "1px solid #ebeef5",
          ...灰,
          fontSize: 12,
          lineHeight: 1.9,
        }}
      >
        考点旁的（draft/merged/retired）是概念层状态；
        <span style={{ color: "#c45656" }}>
          merged / retired 还挂在树上 = 对账 C2 的红旗
        </span>
        ，看到了就去详情页处理。
      </div>
    </>
  );
}
