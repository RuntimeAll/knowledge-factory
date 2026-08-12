-- ===========================================================================
-- 0001 · question_fts（FTS5 全文检索）+ 3 只同步触发器
--
-- 🔴 虚拟表与触发器永不进 drizzle schema（M1 §3 约定），只在 raw SQL migration 里长。
--
-- 🔴 拍板：自含式（self-contained）FTS5，**不用 external-content**。理由：
--    ① question 是 TEXT 主键表，rowid 是隐式的、没有稳定语义；
--    ② 备份主路是 VACUUM INTO，VACUUM 可能重排 rowid——external-content 模式
--       用 rowid 对齐正表，重排后索引与正表静默错位（查得出结果，但是错的行），
--       且不报任何错，是最坏的一类故障；
--    ③ 自含式的代价只是文本重复一份，本产品量级（单人产线）无害。
--    换言之：用一点磁盘换「备份后 FTS 一定还是对的」。
--
-- 分词：tokenize='unicode61'。中文 jieba 预分词串由 core 写入侧生成后再喂进来
-- （M1 §3.B 注：content = stem_plain + answer + analysis 的 jieba 分词串），
-- unicode61 负责按空白切开已分好的词——本层不做分词决策。
--
-- 🔴 MATCH 语法永不接受 agent 拼串（core 侧纪律，非本层能拦）。
-- ===========================================================================

CREATE VIRTUAL TABLE question_fts USING fts5(
  question_id UNINDEXED,
  stem_plain,
  answer,
  analysis,
  tokenize='unicode61'
);
--> statement-breakpoint

-- --- 同步触发器三只：正表是唯一事实源，FTS 只是它的投影 -------------------
-- 文本列一律 coalesce(x,'')：FTS5 列存 NULL 会让该列 MATCH 行为退化，
-- 统一成空串，语义单一。

CREATE TRIGGER trg_question_fts_ai AFTER INSERT ON question BEGIN
  INSERT INTO question_fts(question_id, stem_plain, answer, analysis)
  VALUES (new.id, coalesce(new.stem_plain,''), coalesce(new.answer,''), coalesce(new.analysis,''));
END;
--> statement-breakpoint

-- UPDATE OF 三列：只有被索引的文本变了才重建该行，改 status/难度不触发无谓重写。
-- 先 DELETE 再 INSERT（按 question_id 定位，不依赖 fts 的 rowid）。
CREATE TRIGGER trg_question_fts_au AFTER UPDATE OF stem_plain, answer, analysis ON question BEGIN
  DELETE FROM question_fts WHERE question_id = old.id;
  INSERT INTO question_fts(question_id, stem_plain, answer, analysis)
  VALUES (new.id, coalesce(new.stem_plain,''), coalesce(new.answer,''), coalesce(new.analysis,''));
END;
--> statement-breakpoint

CREATE TRIGGER trg_question_fts_ad AFTER DELETE ON question BEGIN
  DELETE FROM question_fts WHERE question_id = old.id;
END;
