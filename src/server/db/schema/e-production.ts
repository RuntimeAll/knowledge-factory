/**
 * E 域 · 生产登记域（工厂只登记不收编；卷=唯一保留的生产动作）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.E。
 * 🔴 grading_task_map / grading_batch_link 是学情回流的独木桥：
 *    task_id / batch_id 是【圣域 审核.db 的只读侧主键】，本库不设物理外键（跨库）。
 */
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import { asset, question } from "./b-question";

export const ingestBatch = sqliteTable(
  "ingest_batch",
  {
    id: text("id").primaryKey(),
    /** 'kb-ingest/v1' */
    contractVer: text("contract_ver").notNull(),
    /** 喂料方标识：skill/脚本名@版本 */
    source: text("source").notNull(),
    payloadHash: text("payload_hash"),
    nTotal: integer("n_total"),
    nAccepted: integer("n_accepted"),
    nQueued: integer("n_queued"),
    nRejected: integer("n_rejected"),
    /** 全套闸的逐项结果（页页有账） */
    gateReportJson: text("gate_report_json"),
    status: text("status"),
    createdAt: text("created_at"),
    committedAt: text("committed_at"),
  },
  () => [
    check(
      "ingest_batch_status_ck",
      sql`status IN ('open','committed','failed')`,
    ),
  ],
);

export const quarantine = sqliteTable("quarantine", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").references(() => ingestBatch.id),
  payloadJson: text("payload_json").notNull(),
  why: text("why").notNull(),
  createdAt: text("created_at"),
  resolvedAt: text("resolved_at"),
});

/** 选题台组的卷也是 sku(type='卷')——组卷/出册共用登记模型（D-4） */
export const sku = sqliteTable(
  "sku",
  {
    id: text("id").primaryKey(),
    type: text("type"),
    name: text("name").notNull(),
    recipeJson: text("recipe_json"),
    layout: text("layout"),
    /** Q12：生产动作显式带版本 */
    editionCtx: text("edition_ctx"),
    status: text("status"),
    createdAt: text("created_at"),
  },
  () => [
    check(
      "sku_type_ck",
      sql`type IN ('打卡','专项','合刊','讲义','练习册','卷')`,
    ),
    check("sku_status_ck", sql`status IN ('draft','active','retired')`),
  ],
);

export const skuItem = sqliteTable(
  "sku_item",
  {
    skuId: text("sku_id")
      .notNull()
      .references(() => sku.id),
    questionId: text("question_id").references(() => question.id),
    ord: integer("ord").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.skuId, t.ord] }),
    unique("sku_item_sku_id_question_id_unique").on(t.skuId, t.questionId),
  ],
);

export const skuOutput = sqliteTable(
  "sku_output",
  {
    id: text("id").primaryKey(),
    skuId: text("sku_id").references(() => sku.id),
    kind: text("kind"),
    assetId: text("asset_id").references(() => asset.id),
    gateResultsJson: text("gate_results_json"),
    createdAt: text("created_at"),
  },
  () => [
    check(
      "sku_output_kind_ck",
      sql`kind IN ('pdf_q','pdf_a','png','物料','其他')`,
    ),
  ],
);

/**
 * 🔴 学情回流的独木桥：打卡任务↔天卷 SKU 一对一登记。
 * 🔴 桥键走 slots，不走 batches.task_id（batches.task_id 是从未被写入的死列）。
 */
export const gradingTaskMap = sqliteTable(
  "grading_task_map",
  {
    /** 审核.db tasks.id（只读侧主键，稳定） */
    taskId: integer("task_id").primaryKey(),
    skuId: text("sku_id")
      .notNull()
      .references(() => sku.id),
    note: text("note"),
    createdAt: text("created_at"),
  },
  (t) => [unique("grading_task_map_sku_id_unique").on(t.skuId)],
);

/**
 * 🔧 人工补录桥：收卷.py 上线前的存量批次无 slots 行。
 * 视图取桥 = COALESCE(slots 通路, 本表补录)；两路都挂不上的批次进覆盖率明细（§5⑤）。
 */
export const gradingBatchLink = sqliteTable("grading_batch_link", {
  batchId: integer("batch_id").primaryKey(),
  taskId: integer("task_id").notNull(),
  note: text("note"),
  createdAt: text("created_at"),
});
