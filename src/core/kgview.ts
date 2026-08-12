/**
 * core/kgview.ts —— KG 治理页读侧（AI:PRD-002 · 002-D）
 *
 * 治理页要看的三样东西：**这库有多少 KG**（总览统计）、**一棵树长什么样**（章节层级 +
 * 每个节点挂了哪些考点）、**一个考点身上还挂着多少引用**（退役前的判据）。
 * 页面自己不许碰 db（ESLint 红线），所以读也得从 core 出去 —— 就是本文件。
 *
 * 🔴 全文件只 SELECT，一个字都不写库。写在 kg.ts / queue.ts。
 * 🔴 与 resolve.ts 分家的理由：那边是**给 agent 用的检索口径**（打分、入队列、
 *    错误里带候选），一个字都不该为页面版式改动；本文件是**给人看的取数**，
 *    随页面演化。两者混在一起，早晚有人为了页面好看去动 agent 的判断依据。
 */
import { getCoreDb, type CoreDbHandle } from "./db";
import { type KpRefCounts } from "./kg";

// ---------------------------------------------------------------------------
// 小工具（照 resolve.ts 的口径：裸客户端 + 参数化）
// ---------------------------------------------------------------------------

type Args = Array<string | number | null>;

async function q<T>(
  h: CoreDbHandle,
  sql: string,
  args: Args = [],
): Promise<T[]> {
  const r = await h.client.execute({ sql, args });
  return r.rows as unknown as T[];
}

/** libsql 的 COUNT(*) 可能回 bigint，统一 Number() */
async function one(h: CoreDbHandle, sql: string, args: Args = []) {
  const rows = await q<{ c: number | bigint }>(h, sql, args);
  return Number(rows[0]?.c ?? 0);
}

export interface KgViewOptions {
  handle?: CoreDbHandle;
}

// ---------------------------------------------------------------------------
// 版本树
// ---------------------------------------------------------------------------

export interface TreeSummary {
  id: string;
  subject: string;
  edition: string;
  gradeSem: string;
  version: number;
  /** 'active' = 现役；'readonly' = 归档；NULL = 建表时绕过了状态（见 kg.ts 的吐槽） */
  status: string | null;
  /** 树上有多少章节节点 */
  nodeCount: number;
  /** 树上挂了多少条 node↔kp 映射 */
  mapCount: number;
  /** 去重后覆盖多少个考点（映射数 ≥ 考点数：同一考点可挂多节） */
  kpCount: number;
}

/** 全部版本树（学科 → 版本 → 册 排序），带节点数/映射数/覆盖考点数 */
export async function listEditionTrees(
  opts: KgViewOptions = {},
): Promise<TreeSummary[]> {
  const h = opts.handle ?? (await getCoreDb());
  const rows = await q<{
    id: string;
    subject: string;
    edition: string;
    grade_sem: string;
    version: number;
    status: string | null;
    node_count: number | bigint;
    map_count: number | bigint;
    kp_count: number | bigint;
  }>(
    h,
    `SELECT t.id, t.subject, t.edition, t.grade_sem, t.version, t.status,
            (SELECT COUNT(*) FROM edition_node n WHERE n.tree_id = t.id) AS node_count,
            (SELECT COUNT(*) FROM node_kp_map m
               JOIN edition_node n ON n.id = m.node_id
              WHERE n.tree_id = t.id) AS map_count,
            (SELECT COUNT(DISTINCT m.kp_id) FROM node_kp_map m
               JOIN edition_node n ON n.id = m.node_id
              WHERE n.tree_id = t.id) AS kp_count
       FROM edition_tree t
      ORDER BY t.subject, t.edition, t.grade_sem, t.version`,
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    edition: r.edition,
    gradeSem: r.grade_sem,
    version: Number(r.version),
    status: r.status,
    nodeCount: Number(r.node_count),
    mapCount: Number(r.map_count),
    kpCount: Number(r.kp_count),
  }));
}

export interface TreeNodeView {
  id: string;
  parentId: string | null;
  level: number | null;
  name: string;
  sort: number | null;
  /** 这一节挂着的考点（按名字排） */
  kps: { kpId: string; name: string; status: string }[];
}

export interface TreeOutline {
  tree: TreeSummary;
  /** 扁平节点表（父在子前，按 sort 排）；层级由 parentId 自行还原 */
  nodes: TreeNodeView[];
}

/**
 * 一棵树的全貌：章节节点 + 每节挂的考点。
 * 树不存在返回 null（页面自己决定怎么说「没这棵树」）。
 *
 * 一棵册子的量级是几十个节点、上百条映射 —— 两条查询全量捞回来在内存里拼，
 * 比按层递归查省事得多，也不会随层数抖动。
 */
export async function treeOutline(
  treeId: string,
  opts: KgViewOptions = {},
): Promise<TreeOutline | null> {
  const h = opts.handle ?? (await getCoreDb());
  const tree = (await listEditionTrees({ handle: h })).find(
    (t) => t.id === treeId,
  );
  if (!tree) return null;

  const nodes = await q<{
    id: string;
    parent_id: string | null;
    level: number | null;
    name: string;
    sort: number | null;
  }>(
    h,
    `SELECT id, parent_id, level, name, sort
       FROM edition_node WHERE tree_id = ?
      ORDER BY sort, name, id`,
    [treeId],
  );

  const maps = await q<{
    node_id: string;
    kp_id: string;
    name: string;
    status: string;
  }>(
    h,
    `SELECT m.node_id, m.kp_id, k.name, k.status
       FROM node_kp_map m
       JOIN edition_node n ON n.id = m.node_id
       JOIN kp k ON k.id = m.kp_id
      WHERE n.tree_id = ?
      ORDER BY k.name`,
    [treeId],
  );

  const byNode = new Map<string, TreeNodeView["kps"]>();
  for (const m of maps) {
    const list = byNode.get(m.node_id) ?? [];
    list.push({ kpId: m.kp_id, name: m.name, status: m.status });
    byNode.set(m.node_id, list);
  }

  return {
    tree,
    nodes: nodes.map((n) => ({
      id: n.id,
      parentId: n.parent_id,
      level: n.level === null ? null : Number(n.level),
      name: n.name,
      sort: n.sort === null ? null : Number(n.sort),
      kps: byNode.get(n.id) ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// 概念层总览
// ---------------------------------------------------------------------------

export interface KgOverview {
  /** 考点按状态分（active/draft/merged/retired，没有的键不出现） */
  kpByStatus: Record<string, number>;
  kpTotal: number;
  /** 写了考点卡（card_md 非空）的有几个 —— KG 的「有没有口径」比「有没有名字」重要 */
  kpWithCard: number;
  aliasTotal: number;
  /** 有别名的考点数（别名分布不均，只看总数会高估覆盖面） */
  kpWithAlias: number;
  treeTotal: number;
  treeActive: number;
  nodeTotal: number;
  mapTotal: number;
  /** 一个版本树都没挂上的活跃考点数（概念层与教材的缺口） */
  kpUnplaced: number;
}

/** 总览页那一屏数字（一次读完，页面不再零散查库） */
export async function kgOverview(
  opts: KgViewOptions = {},
): Promise<KgOverview> {
  const h = opts.handle ?? (await getCoreDb());

  const statusRows = await q<{ status: string; c: number | bigint }>(
    h,
    "SELECT status, COUNT(*) AS c FROM kp GROUP BY status",
  );
  const kpByStatus: Record<string, number> = {};
  for (const r of statusRows) kpByStatus[r.status] = Number(r.c);

  return {
    kpByStatus,
    kpTotal: Object.values(kpByStatus).reduce((a, b) => a + b, 0),
    kpWithCard: await one(
      h,
      "SELECT COUNT(*) AS c FROM kp WHERE card_md IS NOT NULL AND TRIM(card_md) <> ''",
    ),
    aliasTotal: await one(h, "SELECT COUNT(*) AS c FROM kp_alias"),
    kpWithAlias: await one(
      h,
      "SELECT COUNT(DISTINCT kp_id) AS c FROM kp_alias",
    ),
    treeTotal: await one(h, "SELECT COUNT(*) AS c FROM edition_tree"),
    treeActive: await one(
      h,
      "SELECT COUNT(*) AS c FROM edition_tree WHERE status = 'active'",
    ),
    nodeTotal: await one(h, "SELECT COUNT(*) AS c FROM edition_node"),
    mapTotal: await one(h, "SELECT COUNT(*) AS c FROM node_kp_map"),
    kpUnplaced: await one(
      h,
      `SELECT COUNT(*) AS c FROM kp
        WHERE status = 'active'
          AND id NOT IN (SELECT kp_id FROM node_kp_map)`,
    ),
  };
}

// ---------------------------------------------------------------------------
// 考点引用面（退役前的判据）
// ---------------------------------------------------------------------------

/**
 * 读侧的引用计数：口径与 kg.ts 里 retireKp 用的那份**逐表对齐**
 * （question_kp / node_kp_map / kp_error / kp_alias / err_code_map / exam_model / kp_edge）。
 *
 * 🔴 这只是**给人看的预判**：真正的判据在 retireKp 的事务里现算。
 *    页面显示 0 而执行时被拒，说明中间有人挂了东西上去 —— 以事务里那次为准。
 */
export async function kpRefCounts(
  kpId: string,
  opts: KgViewOptions = {},
): Promise<KpRefCounts> {
  const h = opts.handle ?? (await getCoreDb());
  const counts = {
    question_kp: await one(
      h,
      "SELECT COUNT(*) AS c FROM question_kp WHERE kp_id = ?",
      [kpId],
    ),
    node_kp_map: await one(
      h,
      "SELECT COUNT(*) AS c FROM node_kp_map WHERE kp_id = ?",
      [kpId],
    ),
    kp_error: await one(
      h,
      "SELECT COUNT(*) AS c FROM kp_error WHERE kp_id = ?",
      [kpId],
    ),
    kp_alias: await one(
      h,
      "SELECT COUNT(*) AS c FROM kp_alias WHERE kp_id = ?",
      [kpId],
    ),
    err_code_map: await one(
      h,
      "SELECT COUNT(*) AS c FROM err_code_map WHERE kp_id = ?",
      [kpId],
    ),
    exam_model: await one(
      h,
      "SELECT COUNT(*) AS c FROM exam_model WHERE kp_id = ?",
      [kpId],
    ),
    kp_edge: await one(
      h,
      "SELECT COUNT(*) AS c FROM kp_edge WHERE from_kp = ? OR to_kp = ?",
      [kpId, kpId],
    ),
  };
  return {
    ...counts,
    合计: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}
