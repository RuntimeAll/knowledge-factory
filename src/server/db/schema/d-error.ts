/**
 * D 域 · 错因域（实体化 + 读侧映射，批改线写侧一行不动）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.D。
 * 🔴 err_code_map 是复合键 (kp_id, err_code)：同一七码在不同考点下=不同错因（D-12）。
 */
import { sql } from "drizzle-orm";
import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { kp } from "./a-kg";
import { question } from "./b-question";

export const errorCause = sqliteTable(
  "error_cause",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    desc: text("desc"),
    /** MaE55 种子编码，人工整理来源 */
    seedCode: text("seed_code"),
    status: text("status"),
  },
  () => [check("error_cause_status_ck", sql`status IN ('active','retired')`)],
);

/** 判错因候选集 = 主考点挂载集（53%→84% 那条实验结论） */
export const kpError = sqliteTable(
  "kp_error",
  {
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
    causeId: text("cause_id")
      .notNull()
      .references(() => errorCause.id),
  },
  (t) => [primaryKey({ columns: [t.kpId, t.causeId] })],
);

/** 每错因≥2 诊断例题（软闸提示，不硬拦） */
export const causeExample = sqliteTable(
  "cause_example",
  {
    causeId: text("cause_id")
      .notNull()
      .references(() => errorCause.id),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
  },
  (t) => [primaryKey({ columns: [t.causeId, t.questionId] })],
);

/** 🔴 R-GR-R2 读侧映射：items.error_kp 是 JSON 数组字符串，读侧一律 json_each() 展开后再 join */
export const errCodeMap = sqliteTable(
  "err_code_map",
  {
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
    errCode: text("err_code").notNull(),
    causeId: text("cause_id")
      .notNull()
      .references(() => errorCause.id),
    mappedBy: text("mapped_by"),
    mappedAt: text("mapped_at"),
  },
  (t) => [primaryKey({ columns: [t.kpId, t.errCode] })],
);
