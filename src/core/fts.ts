/**
 * core/fts.ts —— question_fts 的写侧与查询串构造（AI:PRD-003 · 003-B / 方案甲）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 方案甲是什么（裁决出处：AI:PRD-001 `疑问.md` 疑问一，2026-08-12）
 *
 *   question_fts 的 tokenize='unicode61'，而 unicode61 **把连续中文当一个 token**
 *   —— 索引里躺着「一元一次方程的解法」整块，`MATCH '方程'` 一条也命中不了
 *   （不报错、有结果、就是查不全）。要让它工作，喂进去的必须是**已经分好词的
 *   空格串**；而 SQLite 触发器体内跑不了 jieba，只能原样拷贝列值。
 *
 *   ⇒ 预分词的职责钉死在写侧：
 *       - `question.stem_plain` = 「去 LaTeX + jieba 分词后的空格串」（输出语义，不是喂料）；
 *       - `answer` / `analysis` 的分词串由 core 现生成、**直写 question_fts**，
 *         绝不回写正本列（正本是人写的原文，污染不得）；
 *       - 0004 migration 撤掉 INSERT/UPDATE 两只同步触发器，只留 DELETE 兜底。
 *
 *   ⚠️ 由此产生的纪律：**写 question 的每一条路径都要在同一事务里调
 *      writeQuestionFts**。漏一次 = 那道题此后 FTS 查不到，而 SQL 轴与向量轴照常工作
 *      —— 又是一次静默半失效。管道侧的机器闸在 003-C。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 分词由 Python 侧车干（`core/sidecar.ts` → jieba）。本文件只管：
 *   writeQuestionFts()  写侧幂等投影（DELETE + INSERT）
 *   ftsQuery()          查侧：query → jieba token → 安全的 MATCH 串
 *
 * 🔴 MATCH 永不拼串：每个 token 单独转义成 FTS5 字符串字面量，再用显式 AND 连。
 *    于是 `"`、`*`、`(`、`NEAR`、`OR` 这些 MATCH 语法字符全退化成普通字符
 *    （与 resolve.ts 同一条纪律，那边是 kp_fts，这边是 question_fts）。
 */
import { sql } from "drizzle-orm";

import { type CoreTx } from "./db";
// FTS5 字符串字面量转义：kp_fts 那边先写的，两张 FTS 表同一套语法，不重复造
import { ftsStringLiteral } from "./resolve";
import { segmentTexts, type SegmentOptions } from "./sidecar";

// ---------------------------------------------------------------------------
// 写侧
// ---------------------------------------------------------------------------

export interface QuestionFtsInput {
  questionId: string;
  /** 去 LaTeX + jieba 分词后的空格串（= question.stem_plain 该有的值） */
  stemPlain?: string | null;
  /** answer 的分词串（🔴 不回写正本列，只进 FTS） */
  answerSeg?: string | null;
  /** analysis 的分词串（同上） */
  analysisSeg?: string | null;
}

/**
 * 把一道题的检索投影写进 question_fts。**幂等**：先按 question_id 删干净再插一行，
 * 所以「新题入库」与「改了题面重建索引」是同一个调用，调用方不必分情况。
 *
 * 🔴 只能在 withCoreWrite 的事务回调里调（传回调给的 tx）——
 *    投影必须与正表写在同一个事务里，否则崩在中间就是「题在、索引不在」。
 * 🔴 question_fts 不是审计表（它是派生投影，正本是 question），所以不产 rowRef；
 *    审计覆盖由 question 那一行负责。
 *
 * 空值一律落成空串：FTS5 列存 NULL 会让该列 MATCH 行为退化，语义得单一。
 */
export async function writeQuestionFts(
  tx: CoreTx,
  input: QuestionFtsInput,
): Promise<void> {
  const id = input.questionId;
  if (!id) throw new Error("writeQuestionFts：questionId 不能为空");
  const stem = input.stemPlain ?? "";
  const answer = input.answerSeg ?? "";
  const analysis = input.analysisSeg ?? "";

  await tx.run(sql`DELETE FROM question_fts WHERE question_id = ${id}`);
  await tx.run(
    sql`INSERT INTO question_fts(question_id, stem_plain, answer, analysis)
        VALUES (${id}, ${stem}, ${answer}, ${analysis})`,
  );
}

// ---------------------------------------------------------------------------
// 查侧
// ---------------------------------------------------------------------------

export interface FtsQueryPlan {
  /** 归一后的查询串（去首尾空白） */
  query: string;
  /** jieba 切出来的 token（纯标点已丢） */
  tokens: string[];
  /**
   * 可直接当 MATCH 参数传的串（已转义、已连词）。
   * 🔴 null = 一个 token 都切不出来（空串 / 纯标点）——此时**别去 MATCH**，
   *    空 MATCH 串在 FTS5 里是语法错，不是"查不到"。
   */
  match: string | null;
}

export interface FtsQueryOptions extends SegmentOptions {
  /** token 之间的连接词：and=全都要（默认）；or=命中任一 */
  op?: "and" | "or";
}

/**
 * 查询串 → 安全的 MATCH 参数。
 *
 * ```ts
 * const plan = await ftsQuery("一元一次方程 解法");
 * // plan.match === '"一元" AND "一次方程" AND "解法"'
 * if (plan.match) {
 *   await h.client.execute({
 *     sql: "SELECT question_id FROM question_fts WHERE question_fts MATCH ? LIMIT 20",
 *     args: [plan.match],
 *   });
 * }
 * ```
 *
 * 🔴 为什么显式写 AND 而不是「分词后空格连起来」：FTS5 里裸 token 之间的
 *    空白是**短语连接**（要求相邻）还是隐式 AND，取决于版本与上下文——
 *    这种"看情况"的语义不该出现在检索主路上。逐 token 引号包住 + 显式 AND，
 *    语义只有一种读法，也顺带把语法字符全灭了。
 *
 * 🔴 查侧固定用 exact 模式分词（与 sidecar 默认一致）。写侧若用 search 模式
 *    （长词再切、召回更高），查询 token 仍是索引 token 的子集，**只会多命中不会漏**；
 *    反过来（写 exact / 查 search）才会出问题。两边口径在 003-C 定死。
 *
 * ⚠️ exact 模式的两条固有召回缺口（003-B 实测，写在这儿免得 004 当 bug 查）：
 *    a. **长词内部查不到**：索引里是 `一次方程`，查 `方程` 命中不了；
 *    b. **jieba 切法看上下文**：`因式分解得两个根` 切出 `因式分解`，
 *       而单独查 `因式` 会被切成 `因`/`式`，两边对不上。
 *    两条同根同源，解法也同一个：**写侧改用 search 模式**（长词再切，
 *    `一元一次方程` 会同时留下 `一次`/`方程`/`一次方程`）。索引略胖，召回换回来。
 *    004 定检索策略时一并拍板，本卡只把口径与旋钮都摆在明处。
 */
export async function ftsQuery(
  query: string,
  options: FtsQueryOptions = {},
): Promise<FtsQueryPlan> {
  const q = (query ?? "").trim();
  if (!q) return { query: "", tokens: [], match: null };

  const [seg] = await segmentTexts([{ id: "_q", text: q }], options);
  const tokens = (seg?.segmented ?? "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { query: q, tokens: [], match: null };

  const joiner = options.op === "or" ? " OR " : " AND ";
  return { query: q, tokens, match: tokens.map(ftsStringLiteral).join(joiner) };
}
