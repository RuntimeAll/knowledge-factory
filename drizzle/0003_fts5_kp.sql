-- ===========================================================================
-- 0003 · kp_fts（考点词表检索）+ 6 只同步触发器 + 现有行回填
--
-- 🔴 虚拟表与触发器永不进 drizzle schema（M1 §3 约定），只在 raw SQL migration 里长。
--
-- ── 为什么是 trigram，而不是 question_fts 那边的 unicode61 ──────────────────
--   两张 FTS 表吃的是**完全不同形状的文本**，口径各自独立，别互相看齐：
--     question_fts：题干/答案/解析，几十到几百字的**长文**。长文要的是「分词后
--       按词命中」，所以走 unicode61 + 写侧预分词串（001 疑问一方案甲，003 落地）。
--     kp_fts（本表）：考点名与别名，「绝对值」「一元一次方程的解法」这种
--       **短语级中文短串**（多为 3~12 字）。对短串做分词毫无收益，反倒引入
--       「分词器怎么切」这个新的错误来源；而 agent 的问法天然是子串
--       （查「绝对值」要命中「绝对值的化简」、查「一元一次方程」要命中
--       「一元一次方程的解法」）。trigram 把每 3 个字符切成一个 token，
--       **子串模糊匹配是它的原生能力，且完全不需要分词**——正好是词表要的。
--
--   trigram 的两条代价，写在这里免得日后当 bug 查：
--     ① **查询串 < 3 字符 MATCH 一定空**（切不出一个完整 trigram）。
--        「减」「加减」这类短查询由 core/resolve.ts 退到 LIKE 前缀/包含路，
--        不是 FTS 坏了。
--     ② 索引体积比分词大（每字符一个 token 位）。词表量级（考点数千条）无害。
--
-- ── 词条口径 ───────────────────────────────────────────────────────────────
--   一行一词条，kind='name'（kp 的活跃名）| 'alias'（kp_alias 的每条别名）。
--   🔴 **只收 status ∈ (draft, active) 的考点**。merged 壳与 retired 一律不进词表：
--      合并后旧壳还留在库里供旧 id 反查（kg.ts §⑤），但它不该再作为**检索候选**
--      被命中——那等于把已经合掉的重复考点又端回给出题的人。
--      旧 id 反查走的是 kp.merged_into 链（core/kg.ts resolveMergedKp），不是词表。
--
-- ── 触发器 6 只（正表是唯一事实源，kp_fts 只是它的投影）────────────────────
--   kp:       AFTER INSERT / AFTER UPDATE OF name,status / AFTER DELETE
--   kp_alias: AFTER INSERT / AFTER UPDATE / AFTER DELETE
--   🔴 kp_alias 的 AFTER UPDATE 不是可省的礼节：mergeKp 重挂别名走的是
--      `UPDATE kp_alias SET kp_id=to WHERE kp_id=from`（不是删+插），
--      少这只触发器，合并后 to 的别名就永远进不了词表、from 的死词条还赖着不走。
--   🔴 kp 的 AFTER UPDATE 采用「整只 kp 的词条推倒重建」（name + 它当下的全部
--      alias），而不是只改 name 那一行：status 一旦离开 draft/active，
--      它名下的 alias 词条也必须跟着消失，一条 DELETE 全带走最省心也最难写错。
--
-- 🔴 MATCH 语法永不接受 agent 拼串（core/resolve.ts 侧把 query 整体转义成
--    FTS5 字符串字面量再传参，本层拦不住，但纪律记在这儿）。
-- ===========================================================================

CREATE VIRTUAL TABLE kp_fts USING fts5(
  kp_id UNINDEXED,
  kind UNINDEXED,
  term,
  tokenize='trigram'
);
--> statement-breakpoint

-- --- kp 侧三只 -------------------------------------------------------------

CREATE TRIGGER trg_kp_fts_ai AFTER INSERT ON kp
WHEN new.status IN ('draft','active') BEGIN
  INSERT INTO kp_fts(kp_id, kind, term) VALUES (new.id, 'name', new.name);
END;
--> statement-breakpoint

-- 改名或改状态 → 该考点的全部词条推倒重建（不在 draft/active 就只剩推倒）
CREATE TRIGGER trg_kp_fts_au AFTER UPDATE OF name, status ON kp BEGIN
  DELETE FROM kp_fts WHERE kp_id = old.id;
  INSERT INTO kp_fts(kp_id, kind, term)
    SELECT new.id, 'name', new.name WHERE new.status IN ('draft','active');
  INSERT INTO kp_fts(kp_id, kind, term)
    SELECT new.id, 'alias', a.alias FROM kp_alias a
     WHERE a.kp_id = new.id AND new.status IN ('draft','active');
END;
--> statement-breakpoint

CREATE TRIGGER trg_kp_fts_ad AFTER DELETE ON kp BEGIN
  DELETE FROM kp_fts WHERE kp_id = old.id;
END;
--> statement-breakpoint

-- --- kp_alias 侧三只 -------------------------------------------------------

CREATE TRIGGER trg_kp_alias_fts_ai AFTER INSERT ON kp_alias BEGIN
  INSERT INTO kp_fts(kp_id, kind, term)
    SELECT new.kp_id, 'alias', new.alias
     WHERE (SELECT status FROM kp WHERE id = new.kp_id) IN ('draft','active');
END;
--> statement-breakpoint

-- 🔴 mergeKp 的别名重挂就是走 UPDATE（见文件头）
CREATE TRIGGER trg_kp_alias_fts_au AFTER UPDATE ON kp_alias BEGIN
  DELETE FROM kp_fts
   WHERE kp_id = old.kp_id AND kind = 'alias' AND term = old.alias;
  INSERT INTO kp_fts(kp_id, kind, term)
    SELECT new.kp_id, 'alias', new.alias
     WHERE (SELECT status FROM kp WHERE id = new.kp_id) IN ('draft','active');
END;
--> statement-breakpoint

CREATE TRIGGER trg_kp_alias_fts_ad AFTER DELETE ON kp_alias BEGIN
  DELETE FROM kp_fts
   WHERE kp_id = old.kp_id AND kind = 'alias' AND term = old.alias;
END;
--> statement-breakpoint

-- --- 回填现有行 ------------------------------------------------------------
-- 🔴 顺序不能假设：导底（importKgBatch）可能先于本迁移落库，那批 kp/kp_alias
--    没经过上面的触发器。空库跑这两句是 0 行，无副作用；有存量则一次补齐。
INSERT INTO kp_fts(kp_id, kind, term)
  SELECT id, 'name', name FROM kp WHERE status IN ('draft','active');
--> statement-breakpoint

INSERT INTO kp_fts(kp_id, kind, term)
  SELECT a.kp_id, 'alias', a.alias
    FROM kp_alias a JOIN kp k ON k.id = a.kp_id
   WHERE k.status IN ('draft','active');
