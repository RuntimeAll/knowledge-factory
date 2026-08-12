/**
 * B 域 · 题目域（原子 + provenance 硬闸 + 三路检索的物理基础）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.B。
 * 🔴 question_fts（FTS5 虚拟表）与其同步触发器**永不进本文件**，只走 raw SQL migration。
 */
import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { kp } from "./a-kg";
import { examModel } from "./c-model";
import { ingestBatch } from "./e-production";

export const question = sqliteTable(
  "question",
  {
    /** 'q_'+ULID（🔴 全链路字符串传，杜绝雪花截尾坑） */
    id: text("id").primaryKey(),
    /** 正本（LaTeX 混排） */
    stem: text("stem").notNull(),
    /** 检索纯文本（去 LaTeX；jieba 喂料；入库时生成） */
    stemPlain: text("stem_plain"),
    answer: text("answer"),
    analysis: text("analysis"),
    /** 计算/填空/选择/解答…（字典值） */
    qtype: text("qtype"),
    /** 1-5 档（与产线档位表对齐，表驱动不 LLM 自评） */
    difficulty: integer("difficulty"),
    status: text("status").notNull(),
    /** Q11：no_solution 排除出出题检索 */
    solutionGrade: text("solution_grade").notNull(),
    reviewRequired: integer("review_required").default(0),
    /** 查重键=规范化题面 hash；部分唯一索引见 §5 */
    matchKey: text("match_key"),
    provType: text("prov_type").notNull(),
    /** scan 必填 */
    sourceDocId: text("source_doc_id").references(() => sourceDoc.id),
    sourcePageNo: integer("source_page_no"),
    /** model 必填且须 active */
    modelId: text("model_id").references(() => examModel.id),
    /** pipeline 必填：产线标识（脚本名@版本 + 参数摘要） */
    pipelineRef: text("pipeline_ref"),
    /** 管道来料必填 */
    ingestBatchId: text("ingest_batch_id").references(() => ingestBatch.id),
    /** Q12 显式版本适用（如'浙教'），NULL=版本通用 */
    editionScope: text("edition_scope"),
    createdBy: text("created_by"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  },
  (t) => [
    check(
      "question_status_ck",
      sql`status IN ('pending','active','quarantine','rejected','retired')`,
    ),
    check(
      "question_solution_grade_ck",
      sql`solution_grade IN ('calc_verified','analysis_only','no_solution')`,
    ),
    check(
      "question_prov_type_ck",
      sql`prov_type IN ('scan','model','pipeline','manual')`,
    ),
    check(
      "question_prov_scan_ck",
      sql`prov_type != 'scan'     OR (source_doc_id IS NOT NULL AND source_page_no IS NOT NULL)`,
    ),
    check(
      "question_prov_model_ck",
      sql`prov_type != 'model'    OR model_id IS NOT NULL`,
    ),
    check(
      "question_prov_pipeline_ck",
      sql`prov_type != 'pipeline' OR pipeline_ref IS NOT NULL`,
    ),
    // manual 不当无条件逃逸阀
    check(
      "question_prov_manual_ck",
      sql`prov_type != 'manual'   OR created_by IS NOT NULL`,
    ),
    // §5 检索主力（SQL 硬过滤轴）
    index("idx_q_status_diff").on(t.status, t.difficulty),
    uniqueIndex("idx_q_matchkey")
      .on(t.matchKey)
      .where(sql`status IN ('pending','active')`),
  ],
);

/** 主考点唯一由部分唯一索引保证（§5）；判错因候选集从主考点走 */
export const questionKp = sqliteTable(
  "question_kp",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    kpId: text("kp_id")
      .notNull()
      .references(() => kp.id),
    isPrimary: integer("is_primary").default(0),
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.kpId] }),
    index("idx_qkp_kp").on(t.kpId, t.questionId),
    // 主考点至多一个
    uniqueIndex("idx_qkp_primary")
      .on(t.questionId)
      .where(sql`is_primary=1`),
  ],
);

/** free_tags 三件套铁律延续（方法标签/题型标签/来源标签） */
export const questionTag = sqliteTable(
  "question_tag",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    tag: text("tag").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.tag] }),
    index("idx_tag").on(t.tag, t.questionId),
  ],
);

/** 分级审核：role='stem' 入库即进 review_queue（必人审）；'analysis' 抽检 */
export const questionFigure = sqliteTable(
  "question_figure",
  {
    id: text("id").primaryKey(),
    questionId: text("question_id").references(() => question.id),
    assetId: text("asset_id").references(() => asset.id),
    role: text("role"),
    reviewState: text("review_state"),
  },
  () => [
    check("question_figure_role_ck", sql`role IN ('stem','analysis')`),
    check(
      "question_figure_review_state_ck",
      sql`review_state IN ('pending','passed','rejected')`,
    ),
  ],
);

/** 向量正本列；索引可重建；换 embedding 模型=全量重算（版本列就是闸） */
export const questionVec = sqliteTable("question_vec", {
  questionId: text("question_id")
    .primaryKey()
    .references(() => question.id),
  embedding: blob("embedding").notNull(),
  embedModelVer: text("embed_model_ver").notNull(),
  updatedAt: text("updated_at"),
});

export const asset = sqliteTable(
  "asset",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    kind: text("kind"),
    bytes: integer("bytes"),
    createdAt: text("created_at"),
  },
  (t) => [unique("asset_hash_unique").on(t.hash)],
);

/** 录入台冻结 ⇒ 无页级审核状态机；本表只当 provenance 锚 */
export const sourceDoc = sqliteTable(
  "source_doc",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind"),
    path: text("path"),
    hash: text("hash"),
    pages: integer("pages"),
    note: text("note"),
    createdAt: text("created_at"),
  },
  () => [
    check(
      "source_doc_kind_ck",
      sql`kind IN ('册子','群卷','试卷','讲义','其他')`,
    ),
  ],
);

/** 薄化保留（D-9） */
export const sourcePage = sqliteTable(
  "source_page",
  {
    id: text("id").primaryKey(),
    docId: text("doc_id").references(() => sourceDoc.id),
    pageNo: integer("page_no"),
    imageAssetId: text("image_asset_id").references(() => asset.id),
  },
  (t) => [unique("source_page_doc_id_page_no_unique").on(t.docId, t.pageNo)],
);
