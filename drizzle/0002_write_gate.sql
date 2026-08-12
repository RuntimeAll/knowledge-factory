-- ===========================================================================
-- 0002 · 写令牌 _write_gate + 64 只防裸写触发器
--
-- 目的：库文件本身就长着「不许绕过 core 直接改数据」这条纪律。
-- agent / sqlite3 CLI / DB 客户端拿裸连接连上来，SELECT 随便、INSERT 放行，
-- 但 UPDATE / DELETE 一律被 RAISE(ABORT) 打回——只有走 core 业务层（开闸 →
-- 业务写 → 关闸，同一事务内）才改得动。
--
-- 🔴 为什么令牌是【主库普通表】而不是 temp 表 / PRAGMA 变量：
--    SQLite 触发器体内不能引用 temp 库对象（trigger 与其表必须同库），
--    也没有「会话变量」这种东西。所以令牌只能落主库一张 1 行表。
--    代价 = 令牌本身也在库里、谁都能 UPDATE 它；这不是密码而是安全带：
--    它拦的是「顺手改一行」的误操作与 agent 的自作主张，不是恶意攻击。
--
-- core 的用法（下一个 WP 实现）：
--    BEGIN;
--      UPDATE _write_gate SET allowed=1 WHERE id=1;
--      ...业务写 + 审计链写入...
--      UPDATE _write_gate SET allowed=0 WHERE id=1;
--    COMMIT;
--    裸连接默认读到 allowed=0 —— 闸是常闭的。
--
-- 🔴 _write_gate 自身不设触发器（core 靠它开闸，给它上闸=自锁死）。
-- 🔴 audit_log 例外：BEFORE UPDATE / BEFORE DELETE 【无条件】RAISE，
--    不看令牌——审计链绝对 append-only，core 也不许改。
-- 🔴 命名规范：trg_<表名>_no_bare_update / trg_<表名>_no_bare_delete。
--    本文件的触发器由 scripts/gen-write-gate-sql.ts 生成（64 只手抄必错）；
--    将来加表要补闸 ⇒ 新开一支 custom migration，绝不回头改本文件。
-- ===========================================================================

CREATE TABLE _write_gate(
  id INTEGER PRIMARY KEY CHECK(id=1),
  allowed INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint

INSERT INTO _write_gate(id, allowed) VALUES(1, 0);
--> statement-breakpoint

-- --- A 域 · KG 双层 -------------------------------------------------
CREATE TRIGGER trg_kp_no_bare_update BEFORE UPDATE ON kp
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_no_bare_delete BEFORE DELETE ON kp
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_alias_no_bare_update BEFORE UPDATE ON kp_alias
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_alias: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_alias_no_bare_delete BEFORE DELETE ON kp_alias
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_alias: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_edge_no_bare_update BEFORE UPDATE ON kp_edge
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_edge: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_edge_no_bare_delete BEFORE DELETE ON kp_edge
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_edge: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_edition_tree_no_bare_update BEFORE UPDATE ON edition_tree
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'edition_tree: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_edition_tree_no_bare_delete BEFORE DELETE ON edition_tree
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'edition_tree: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_edition_node_no_bare_update BEFORE UPDATE ON edition_node
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'edition_node: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_edition_node_no_bare_delete BEFORE DELETE ON edition_node
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'edition_node: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_node_kp_map_no_bare_update BEFORE UPDATE ON node_kp_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'node_kp_map: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_node_kp_map_no_bare_delete BEFORE DELETE ON node_kp_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'node_kp_map: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- B 域 · 题目 ----------------------------------------------------
CREATE TRIGGER trg_question_no_bare_update BEFORE UPDATE ON question
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_no_bare_delete BEFORE DELETE ON question
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_kp_no_bare_update BEFORE UPDATE ON question_kp
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_kp: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_kp_no_bare_delete BEFORE DELETE ON question_kp
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_kp: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_tag_no_bare_update BEFORE UPDATE ON question_tag
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_tag: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_tag_no_bare_delete BEFORE DELETE ON question_tag
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_tag: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_figure_no_bare_update BEFORE UPDATE ON question_figure
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_figure: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_figure_no_bare_delete BEFORE DELETE ON question_figure
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_figure: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_vec_no_bare_update BEFORE UPDATE ON question_vec
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_vec: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_question_vec_no_bare_delete BEFORE DELETE ON question_vec
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'question_vec: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_asset_no_bare_update BEFORE UPDATE ON asset
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'asset: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_asset_no_bare_delete BEFORE DELETE ON asset
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'asset: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_source_doc_no_bare_update BEFORE UPDATE ON source_doc
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'source_doc: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_source_doc_no_bare_delete BEFORE DELETE ON source_doc
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'source_doc: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_source_page_no_bare_update BEFORE UPDATE ON source_page
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'source_page: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_source_page_no_bare_delete BEFORE DELETE ON source_page
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'source_page: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- C 域 · 考察模型 --------------------------------------------------
CREATE TRIGGER trg_exam_model_no_bare_update BEFORE UPDATE ON exam_model
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'exam_model: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_exam_model_no_bare_delete BEFORE DELETE ON exam_model
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'exam_model: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- D 域 · 错因 ----------------------------------------------------
CREATE TRIGGER trg_error_cause_no_bare_update BEFORE UPDATE ON error_cause
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'error_cause: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_error_cause_no_bare_delete BEFORE DELETE ON error_cause
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'error_cause: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_error_no_bare_update BEFORE UPDATE ON kp_error
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_error: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_kp_error_no_bare_delete BEFORE DELETE ON kp_error
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'kp_error: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_cause_example_no_bare_update BEFORE UPDATE ON cause_example
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'cause_example: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_cause_example_no_bare_delete BEFORE DELETE ON cause_example
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'cause_example: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_err_code_map_no_bare_update BEFORE UPDATE ON err_code_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'err_code_map: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_err_code_map_no_bare_delete BEFORE DELETE ON err_code_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'err_code_map: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- E 域 · 生产登记 --------------------------------------------------
CREATE TRIGGER trg_ingest_batch_no_bare_update BEFORE UPDATE ON ingest_batch
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ingest_batch: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_ingest_batch_no_bare_delete BEFORE DELETE ON ingest_batch
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ingest_batch: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_quarantine_no_bare_update BEFORE UPDATE ON quarantine
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'quarantine: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_quarantine_no_bare_delete BEFORE DELETE ON quarantine
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'quarantine: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_no_bare_update BEFORE UPDATE ON sku
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_no_bare_delete BEFORE DELETE ON sku
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_item_no_bare_update BEFORE UPDATE ON sku_item
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku_item: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_item_no_bare_delete BEFORE DELETE ON sku_item
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku_item: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_output_no_bare_update BEFORE UPDATE ON sku_output
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku_output: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_sku_output_no_bare_delete BEFORE DELETE ON sku_output
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'sku_output: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_grading_task_map_no_bare_update BEFORE UPDATE ON grading_task_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'grading_task_map: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_grading_task_map_no_bare_delete BEFORE DELETE ON grading_task_map
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'grading_task_map: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_grading_batch_link_no_bare_update BEFORE UPDATE ON grading_batch_link
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'grading_batch_link: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_grading_batch_link_no_bare_delete BEFORE DELETE ON grading_batch_link
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'grading_batch_link: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- F 域 · 学情连接 --------------------------------------------------
CREATE TRIGGER trg_roster_no_bare_update BEFORE UPDATE ON roster
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'roster: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_roster_no_bare_delete BEFORE DELETE ON roster
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'roster: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
-- --- G 域 · 系统 ----------------------------------------------------
CREATE TRIGGER trg_review_queue_no_bare_update BEFORE UPDATE ON review_queue
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'review_queue: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_review_queue_no_bare_delete BEFORE DELETE ON review_queue
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'review_queue: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_no_bare_update BEFORE UPDATE ON ledger
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ledger: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_no_bare_delete BEFORE DELETE ON ledger
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ledger: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_ref_no_bare_update BEFORE UPDATE ON ledger_ref
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ledger_ref: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_ref_no_bare_delete BEFORE DELETE ON ledger_ref
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'ledger_ref: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_no_bare_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log: 审计链 append-only——UPDATE 一律被拒（开闸也不例外）');
END;
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_no_bare_delete BEFORE DELETE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit_log: 审计链 append-only——DELETE 一律被拒（开闸也不例外）');
END;
--> statement-breakpoint
CREATE TRIGGER trg_metric_event_no_bare_update BEFORE UPDATE ON metric_event
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'metric_event: 裸 UPDATE 被拒——写操作必须经 core 业务层');
END;
--> statement-breakpoint
CREATE TRIGGER trg_metric_event_no_bare_delete BEFORE DELETE ON metric_event
WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN
  SELECT RAISE(ABORT, 'metric_event: 裸 DELETE 被拒——写操作必须经 core 业务层');
END;
