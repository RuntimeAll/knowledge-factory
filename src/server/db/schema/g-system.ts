/**
 * G 域 · 系统域（审查队列 / 台账 / 审计链 / 指标）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.G。
 * 🔴 audit_log 是 append-only 审计链：库里另有无条件 RAISE 的 UPDATE/DELETE 触发器，
 *    core 也不许改（见 raw migration 0002_write_gate）。
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const reviewQueue = sqliteTable(
  "review_queue",
  {
    id: text("id").primaryKey(),
    kind: text("kind"),
    /** 多态弱引用（孤儿对账兜底，见 §5） */
    refType: text("ref_type"),
    refId: text("ref_id"),
    /** 🔴 D-2：提议变更集正文直接放队列行（不另设 proposal 表） */
    payloadJson: text("payload_json"),
    reason: text("reason"),
    signalsJson: text("signals_json"),
    state: text("state").notNull(),
    verdictBy: text("verdict_by"),
    verdictNote: text("verdict_note"),
    createdAt: text("created_at"),
    verdictAt: text("verdict_at"),
  },
  (t) => [
    check(
      "review_queue_kind_ck",
      sql`kind IN ('kp低置信','图片','KG提议','模型转正','新题草稿','隔离','抽查','其他')`,
    ),
    check("review_queue_state_ck", sql`state IN ('open','passed','rejected')`),
    index("idx_queue_open")
      .on(t.state, t.kind)
      .where(sql`state='open'`),
  ],
);

/** session 台账（Q14 三类封顶） */
export const ledger = sqliteTable(
  "ledger",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    ts: text("ts").notNull(),
    actor: text("actor"),
    title: text("title").notNull(),
    bodyMd: text("body_md"),
    /** tool / page / pipeline */
    source: text("source"),
    /** 正本文本路径（认知/…）——不吞 memory/认知，只存指针 */
    pointer: text("pointer"),
  },
  () => [
    check("ledger_kind_ck", sql`kind IN ('decision','delivery','change')`),
    check("ledger_actor_ck", sql`actor IN ('agent','human','system')`),
  ],
);

/** 「这个考点/这个学生相关的历史拍板」一键可查=按 (ref_type, ref_id) 反查 */
export const ledgerRef = sqliteTable(
  "ledger_ref",
  {
    ledgerId: text("ledger_id")
      .notNull()
      .references(() => ledger.id),
    refType: text("ref_type").notNull(),
    refId: text("ref_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ledgerId, t.refType, t.refId] }),
    check(
      "ledger_ref_ref_type_ck",
      sql`ref_type IN ('kp','question','sku','student','batch','model','cause')`,
    ),
    index("idx_ledger_ref").on(t.refType, t.refId),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    ts: text("ts"),
    actor: text("actor"),
    tool: text("tool"),
    argsDigest: text("args_digest"),
    gateResultsJson: text("gate_results_json"),
    rowRefsJson: text("row_refs_json"),
    /** sha256(上一行规范化串)；写入走 core 单点 */
    prevHash: text("prev_hash").notNull(),
    /** 可选加固；默认纯链（防误改可检测，诚实标注） */
    hmac: text("hmac"),
  },
  () => [
    check(
      "audit_log_actor_ck",
      sql`actor IN ('agent','human','proxy','system')`,
    ),
  ],
);

/** 检索调用也落这（kind='search'，params+命中来源）→ 评测集从真实查询抽（Q9 定案） */
export const metricEvent = sqliteTable("metric_event", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: text("ts"),
  kind: text("kind"),
  ref: text("ref"),
  valueJson: text("value_json"),
});
