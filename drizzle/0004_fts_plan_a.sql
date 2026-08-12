-- ===========================================================================
-- 0004 · question_fts 方案甲落地：INSERT/UPDATE 触发器撤除，只留 DELETE 兜底
--
-- 🔴 裁决出处：AI:PRD-001 `疑问.md` 疑问一（主件）—— 2026-08-12 执行裁决**方案甲**。
--
-- ── 为什么非改不可（0001 的三只触发器错在哪）──────────────────────────────
--   question_fts 用 tokenize='unicode61'，而 unicode61 **把连续中文当一个 token**：
--   索引里躺着「一元一次方程的解法」整块，`MATCH '方程'` 一条也命中不了。
--   不报错、有结果、就是查不全 —— 静默失效，最坏的一类故障。
--   要让它工作，喂进去的必须是**已经分好词的空格串**（jieba 预分词）。
--   而 SQLite 触发器体内跑不了 jieba，它只能原样拷贝列值。
--   ⇒ 「同步触发器」这条路在物理上就到头了，预分词只能由写侧（core）做。
--
-- ── 改成什么 ───────────────────────────────────────────────────────────────
--   INSERT / UPDATE 的 FTS 写：交给 **core 写题事务**（`core/fts.ts` 的
--     writeQuestionFts，DELETE+INSERT 幂等），值 = jieba 预分词串：
--       stem_plain  已是「去 LaTeX + jieba 分词后的空格串」（001 勘误后的输出语义）
--       answer / analysis  的分词串由 core 现生成后直写 FTS，**不回写正本列**
--       （正本列是人写的原文，污染不得 —— 这也是方案乙被否掉的理由）。
--   DELETE 兜底触发器：**保留**。它是唯一不需要分词的一步，而且是防孤儿的最后一道
--     （题删了 FTS 行还赖着 = 检索能查出已经不存在的题）。留着它，
--     "正表删了 FTS 一定跟着删" 就不依赖任何调用方的自觉。
--
-- ── 代价与可回退性 ─────────────────────────────────────────────────────────
--   表结构一行不动（虚拟表与列全不变），只动触发器层；要回退就把 0001 那两只
--   原样建回来。库里 question 表当前为空 ⇒ **无回填负担**，也就没有"新旧口径
--   混在一个索引里"的中间态。
--
-- 🔴 由此产生的新纪律（核到写侧去了，别指望库层再兜）：
--    写 question 的**每一条路径**都必须在同一事务里调 writeQuestionFts，
--    漏一次 = 那道题此后 FTS 查不到（SQL/向量轴仍在，所以照样是静默半失效）。
--    机器闸在 tests/fts.test.ts 与 003-C 的入库管道里。
-- ===========================================================================

DROP TRIGGER IF EXISTS trg_question_fts_ai;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_question_fts_au;
--> statement-breakpoint

-- 兜底触发器原样重建（幂等：这份迁移在任何顺序下跑完，库里都恰好只剩这一只）
DROP TRIGGER IF EXISTS trg_question_fts_ad;
--> statement-breakpoint

CREATE TRIGGER trg_question_fts_ad AFTER DELETE ON question BEGIN
  DELETE FROM question_fts WHERE question_id = old.id;
END;
