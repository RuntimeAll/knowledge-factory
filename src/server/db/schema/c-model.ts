/**
 * C 域 · 考察模型域（AIG 三件套 + 血缘 + 生命周期）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.C。
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { kp } from "./a-kg";

/** 生成题只认 active 模型（question.model_id 闸在 core 校验 status） */
export const examModel = sqliteTable(
  "exam_model",
  {
    id: text("id").primaryKey(),
    /** 归位考点下（不再散在各册 qbank.py） */
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
    name: text("name").notNull(),
    /** 题干模板 */
    stemTemplate: text("stem_template"),
    /** 变量约束（域/步长/互斥） */
    varSpecJson: text("var_spec_json"),
    /** 错误模型（预置错因→err 关联） */
    errorModelJson: text("error_model_json"),
    /** 现役 DSL 模块指针（册子_源/qbank.py#类名）；收编前的桥 */
    dslRef: text("dsl_ref"),
    difficulty: integer("difficulty"),
    status: text("status").notNull(),
    /** 从哪些真题归纳出来（血缘上游） */
    originQidsJson: text("origin_qids_json"),
    createdAt: text("created_at"),
    activatedAt: text("activated_at"),
  },
  () => [
    check(
      "exam_model_status_ck",
      sql`status IN ('proposed','active','deprecated')`,
    ),
  ],
);
