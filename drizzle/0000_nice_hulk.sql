CREATE TABLE `edition_node` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text,
	`parent_id` text,
	`level` integer,
	`name` text NOT NULL,
	`sort` integer,
	FOREIGN KEY (`tree_id`) REFERENCES `edition_tree`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `edition_node`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `edition_tree` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`edition` text NOT NULL,
	`grade_sem` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text,
	`created_at` text,
	CONSTRAINT "edition_tree_status_ck" CHECK(status IN ('active','readonly'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_edtree_active` ON `edition_tree` (`subject`,`edition`,`grade_sem`) WHERE status='active';--> statement-breakpoint
CREATE UNIQUE INDEX `edition_tree_subject_edition_grade_sem_version_unique` ON `edition_tree` (`subject`,`edition`,`grade_sem`,`version`);--> statement-breakpoint
CREATE TABLE `kp` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`grade_band` text,
	`domain` text,
	`topic` text,
	`card_md` text,
	`status` text NOT NULL,
	`merged_into` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`merged_into`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kp_status_ck" CHECK(status IN ('draft','active','merged','retired')),
	CONSTRAINT "kp_merged_into_ck" CHECK(status <> 'merged' OR merged_into IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `kp_alias` (
	`kp_id` text NOT NULL,
	`alias` text NOT NULL,
	PRIMARY KEY(`kp_id`, `alias`),
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_alias` ON `kp_alias` (`alias`);--> statement-breakpoint
CREATE TABLE `kp_edge` (
	`from_kp` text NOT NULL,
	`to_kp` text NOT NULL,
	`type` text NOT NULL,
	PRIMARY KEY(`from_kp`, `to_kp`, `type`),
	FOREIGN KEY (`from_kp`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_kp`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kp_edge_type_ck" CHECK(type='prereq')
);
--> statement-breakpoint
CREATE TABLE `node_kp_map` (
	`node_id` text NOT NULL,
	`kp_id` text NOT NULL,
	PRIMARY KEY(`node_id`, `kp_id`),
	FOREIGN KEY (`node_id`) REFERENCES `edition_node`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `asset` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`kind` text,
	`bytes` integer,
	`created_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_hash_unique` ON `asset` (`hash`);--> statement-breakpoint
CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`stem` text NOT NULL,
	`stem_plain` text,
	`answer` text,
	`analysis` text,
	`qtype` text,
	`difficulty` integer,
	`status` text NOT NULL,
	`solution_grade` text NOT NULL,
	`review_required` integer DEFAULT 0,
	`match_key` text,
	`prov_type` text NOT NULL,
	`source_doc_id` text,
	`source_page_no` integer,
	`model_id` text,
	`pipeline_ref` text,
	`ingest_batch_id` text,
	`edition_scope` text,
	`created_by` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`source_doc_id`) REFERENCES `source_doc`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `exam_model`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ingest_batch_id`) REFERENCES `ingest_batch`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_status_ck" CHECK(status IN ('pending','active','quarantine','rejected','retired')),
	CONSTRAINT "question_solution_grade_ck" CHECK(solution_grade IN ('calc_verified','analysis_only','no_solution')),
	CONSTRAINT "question_prov_type_ck" CHECK(prov_type IN ('scan','model','pipeline','manual')),
	CONSTRAINT "question_prov_scan_ck" CHECK(prov_type != 'scan'     OR (source_doc_id IS NOT NULL AND source_page_no IS NOT NULL)),
	CONSTRAINT "question_prov_model_ck" CHECK(prov_type != 'model'    OR model_id IS NOT NULL),
	CONSTRAINT "question_prov_pipeline_ck" CHECK(prov_type != 'pipeline' OR pipeline_ref IS NOT NULL),
	CONSTRAINT "question_prov_manual_ck" CHECK(prov_type != 'manual'   OR created_by IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_q_status_diff` ON `question` (`status`,`difficulty`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_q_matchkey` ON `question` (`match_key`) WHERE status IN ('pending','active');--> statement-breakpoint
CREATE TABLE `question_figure` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text,
	`asset_id` text,
	`role` text,
	`review_state` text,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "question_figure_role_ck" CHECK(role IN ('stem','analysis')),
	CONSTRAINT "question_figure_review_state_ck" CHECK(review_state IN ('pending','passed','rejected'))
);
--> statement-breakpoint
CREATE TABLE `question_kp` (
	`question_id` text NOT NULL,
	`kp_id` text NOT NULL,
	`is_primary` integer DEFAULT 0,
	PRIMARY KEY(`question_id`, `kp_id`),
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_qkp_kp` ON `question_kp` (`kp_id`,`question_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_qkp_primary` ON `question_kp` (`question_id`) WHERE is_primary=1;--> statement-breakpoint
CREATE TABLE `question_tag` (
	`question_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`question_id`, `tag`),
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tag` ON `question_tag` (`tag`,`question_id`);--> statement-breakpoint
CREATE TABLE `question_vec` (
	`question_id` text PRIMARY KEY NOT NULL,
	`embedding` blob NOT NULL,
	`embed_model_ver` text NOT NULL,
	`updated_at` text,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `source_doc` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text,
	`path` text,
	`hash` text,
	`pages` integer,
	`note` text,
	`created_at` text,
	CONSTRAINT "source_doc_kind_ck" CHECK(kind IN ('册子','群卷','试卷','讲义','其他'))
);
--> statement-breakpoint
CREATE TABLE `source_page` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_id` text,
	`page_no` integer,
	`image_asset_id` text,
	FOREIGN KEY (`doc_id`) REFERENCES `source_doc`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_page_doc_id_page_no_unique` ON `source_page` (`doc_id`,`page_no`);--> statement-breakpoint
CREATE TABLE `exam_model` (
	`id` text PRIMARY KEY NOT NULL,
	`kp_id` text NOT NULL,
	`name` text NOT NULL,
	`stem_template` text,
	`var_spec_json` text,
	`error_model_json` text,
	`dsl_ref` text,
	`difficulty` integer,
	`status` text NOT NULL,
	`origin_qids_json` text,
	`created_at` text,
	`activated_at` text,
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exam_model_status_ck" CHECK(status IN ('proposed','active','deprecated'))
);
--> statement-breakpoint
CREATE TABLE `cause_example` (
	`cause_id` text NOT NULL,
	`question_id` text NOT NULL,
	PRIMARY KEY(`cause_id`, `question_id`),
	FOREIGN KEY (`cause_id`) REFERENCES `error_cause`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `err_code_map` (
	`kp_id` text NOT NULL,
	`err_code` text NOT NULL,
	`cause_id` text NOT NULL,
	`mapped_by` text,
	`mapped_at` text,
	PRIMARY KEY(`kp_id`, `err_code`),
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cause_id`) REFERENCES `error_cause`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `error_cause` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`desc` text,
	`seed_code` text,
	`status` text,
	CONSTRAINT "error_cause_status_ck" CHECK(status IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE `kp_error` (
	`kp_id` text NOT NULL,
	`cause_id` text NOT NULL,
	PRIMARY KEY(`kp_id`, `cause_id`),
	FOREIGN KEY (`kp_id`) REFERENCES `kp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cause_id`) REFERENCES `error_cause`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `grading_batch_link` (
	`batch_id` integer PRIMARY KEY NOT NULL,
	`task_id` integer NOT NULL,
	`note` text,
	`created_at` text
);
--> statement-breakpoint
CREATE TABLE `grading_task_map` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`sku_id` text NOT NULL,
	`note` text,
	`created_at` text,
	FOREIGN KEY (`sku_id`) REFERENCES `sku`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grading_task_map_sku_id_unique` ON `grading_task_map` (`sku_id`);--> statement-breakpoint
CREATE TABLE `ingest_batch` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_ver` text NOT NULL,
	`source` text NOT NULL,
	`payload_hash` text,
	`n_total` integer,
	`n_accepted` integer,
	`n_queued` integer,
	`n_rejected` integer,
	`gate_report_json` text,
	`status` text,
	`created_at` text,
	`committed_at` text,
	CONSTRAINT "ingest_batch_status_ck" CHECK(status IN ('open','committed','failed'))
);
--> statement-breakpoint
CREATE TABLE `quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text,
	`payload_json` text NOT NULL,
	`why` text NOT NULL,
	`created_at` text,
	`resolved_at` text,
	FOREIGN KEY (`batch_id`) REFERENCES `ingest_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sku` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text,
	`name` text NOT NULL,
	`recipe_json` text,
	`layout` text,
	`edition_ctx` text,
	`status` text,
	`created_at` text,
	CONSTRAINT "sku_type_ck" CHECK(type IN ('打卡','专项','合刊','讲义','练习册','卷')),
	CONSTRAINT "sku_status_ck" CHECK(status IN ('draft','active','retired'))
);
--> statement-breakpoint
CREATE TABLE `sku_item` (
	`sku_id` text NOT NULL,
	`question_id` text,
	`ord` integer NOT NULL,
	PRIMARY KEY(`sku_id`, `ord`),
	FOREIGN KEY (`sku_id`) REFERENCES `sku`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sku_item_sku_id_question_id_unique` ON `sku_item` (`sku_id`,`question_id`);--> statement-breakpoint
CREATE TABLE `sku_output` (
	`id` text PRIMARY KEY NOT NULL,
	`sku_id` text,
	`kind` text,
	`asset_id` text,
	`gate_results_json` text,
	`created_at` text,
	FOREIGN KEY (`sku_id`) REFERENCES `sku`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sku_output_kind_ck" CHECK(kind IN ('pdf_q','pdf_a','png','物料','其他'))
);
--> statement-breakpoint
CREATE TABLE `roster` (
	`code` text PRIMARY KEY NOT NULL,
	`alias` text,
	`grade` text,
	`edition_ctx` text,
	`status` text,
	`joined_at` text,
	`note` text,
	CONSTRAINT "roster_status_ck" CHECK(status IN ('active','paused','closed'))
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text,
	`actor` text,
	`tool` text,
	`args_digest` text,
	`gate_results_json` text,
	`row_refs_json` text,
	`prev_hash` text NOT NULL,
	`hmac` text,
	CONSTRAINT "audit_log_actor_ck" CHECK(actor IN ('agent','human','proxy','system'))
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ts` text NOT NULL,
	`actor` text,
	`title` text NOT NULL,
	`body_md` text,
	`source` text,
	`pointer` text,
	CONSTRAINT "ledger_kind_ck" CHECK(kind IN ('decision','delivery','change')),
	CONSTRAINT "ledger_actor_ck" CHECK(actor IN ('agent','human','system'))
);
--> statement-breakpoint
CREATE TABLE `ledger_ref` (
	`ledger_id` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	PRIMARY KEY(`ledger_id`, `ref_type`, `ref_id`),
	FOREIGN KEY (`ledger_id`) REFERENCES `ledger`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_ref_ref_type_ck" CHECK(ref_type IN ('kp','question','sku','student','batch','model','cause'))
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_ref` ON `ledger_ref` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `metric_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text,
	`kind` text,
	`ref` text,
	`value_json` text
);
--> statement-breakpoint
CREATE TABLE `review_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text,
	`ref_type` text,
	`ref_id` text,
	`payload_json` text,
	`reason` text,
	`signals_json` text,
	`state` text NOT NULL,
	`verdict_by` text,
	`verdict_note` text,
	`created_at` text,
	`verdict_at` text,
	CONSTRAINT "review_queue_kind_ck" CHECK(kind IN ('kp低置信','图片','KG提议','模型转正','新题草稿','隔离','抽查','其他')),
	CONSTRAINT "review_queue_state_ck" CHECK(state IN ('open','passed','rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_queue_open` ON `review_queue` (`state`,`kind`) WHERE state='open';