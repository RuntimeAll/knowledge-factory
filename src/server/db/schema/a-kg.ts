/**
 * A 域 · KG 双层域（版本无关概念层 + 每版本章节树 + 映射）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.A —— 列名 / 类型 / CHECK 一字不改，
 *    本文件只做 SQL→drizzle 的机械转写，不许在这里发明列或改语义。
 * 🔴 CHECK 表达式一律用裸列名（不插值列对象）：SQLite 的 CREATE TABLE CHECK
 *    里不接受 "表名"."列名" 限定写法，插值会生成非法 DDL。
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/** 考点概念层：题只挂这层，绝不 fork 版本树 */
export const kp = sqliteTable(
  "kp",
  {
    /** 'kp_'+ULID */
    id: text("id").primaryKey(),
    /** 活跃名；改名=变更留痕(ledger) */
    name: text("name").notNull(),
    /** 学段带（粗筛）：小低/小高/初中 */
    gradeBand: text("grade_band"),
    /** 两级软分类：数与代数/…（字典值，不建表） */
    domain: text("domain"),
    topic: text("topic"),
    /** 考点卡片正文（口径/易错/教学建议） */
    cardMd: text("card_md"),
    status: text("status").notNull(),
    /** 合并向导落点（自引用） */
    mergedInto: text("merged_into").references((): AnySQLiteColumn => kp.id),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
  () => [
    check("kp_status_ck", sql`status IN ('draft','active','merged','retired')`),
    check(
      "kp_merged_into_ck",
      sql`status <> 'merged' OR merged_into IS NOT NULL`,
    ),
  ],
);

/** resolve_kp 词表；同一 alias 允许指向多考点（resolve 返回候选不武断） */
export const kpAlias = sqliteTable(
  "kp_alias",
  {
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
    alias: text("alias").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kpId, t.alias] }),
    index("idx_alias").on(t.alias),
  ],
);

/** P2 占位，M3 不铺数据 */
export const kpEdge = sqliteTable(
  "kp_edge",
  {
    fromKp: text("from_kp")
      .notNull()
      .references(() => kp.id),
    toKp: text("to_kp")
      .notNull()
      .references(() => kp.id),
    type: text("type").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromKp, t.toKp, t.type] }),
    check("kp_edge_type_ck", sql`type='prereq'`),
  ],
);

/** 学科×教材版本×册×版本号，一棵活跃树 */
export const editionTree = sqliteTable(
  "edition_tree",
  {
    id: text("id").primaryKey(),
    subject: text("subject").notNull(),
    /** 人教/浙教 */
    edition: text("edition").notNull(),
    /** 七上/三下… */
    gradeSem: text("grade_sem").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status"),
    createdAt: text("created_at"),
  },
  (t) => [
    unique("edition_tree_subject_edition_grade_sem_version_unique").on(
      t.subject,
      t.edition,
      t.gradeSem,
      t.version,
    ),
    check("edition_tree_status_ck", sql`status IN ('active','readonly')`),
    // §5：同一学科×版本×册至多一棵活跃树（双 active 树=检索双份考点候选）
    uniqueIndex("idx_edtree_active")
      .on(t.subject, t.edition, t.gradeSem)
      .where(sql`status='active'`),
  ],
);

export const editionNode = sqliteTable("edition_node", {
  id: text("id").primaryKey(),
  treeId: text("tree_id").references(() => editionTree.id),
  parentId: text("parent_id").references((): AnySQLiteColumn => editionNode.id),
  level: integer("level"),
  name: text("name").notNull(),
  sort: integer("sort"),
});

/** 新版本教材 = 新树 + 新映射；概念层不动（IXL/CASE 范式） */
export const nodeKpMap = sqliteTable(
  "node_kp_map",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => editionNode.id),
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.kpId] })],
);
