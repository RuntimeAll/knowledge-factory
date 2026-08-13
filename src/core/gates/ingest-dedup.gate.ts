/**
 * 闸⑦ 查重 match_key（AI:PRD-003 · 003-C）
 *
 * 数据模型侧已经有 `idx_q_matchkey`（部分唯一索引，WHERE status IN ('pending','active')）。
 * 本闸不是它的重复，是它的**前置**：索引撞了只会在 INSERT 那一刻抛
 * `UNIQUE constraint failed`，而那时整批已经在事务里 —— 一道重复题回滚 60 道好题。
 * 闸把撞车提前到入库前，并且告诉你**撞的是库里哪一道题**。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 归一口径（改它 = 全库 match_key 作废重算，别顺手动）
 *
 *   ① 剥 HTML 标签      群卷题面夹着 `<div style="display:grid…">` 选项栅格、
 *                      `<span style="border-bottom…">` 填空线（备料 R2 实测三种格式混存），
 *                      样式串留在键里 = 同一道题换个行内样式就成了"新题"。
 *   ② LaTeX 归一        去 `\left`/`\right`、去 `$`/`\(`/`\[` 定界符 ——
 *                      `$x^2$` 与 `\(x^2\)` 是同一道题的两种写法。
 *   ③ NFKC             全角→半角、`ｘ`→`x`、`²`→`2`（顺带把全角标点折成半角，④ 才好统一处理）。
 *   ④ 去空白 + 去**句读**标点
 *      🔴 注意这里**不是**「去所有标点」：ASCII `-` 在 Unicode 里是 Pd（破折号类标点），
 *         `(` `)` 是 Ps/Pe —— 用 `\p{P}` 一刀切会把 `3-5` 削成 `35`，
 *         于是 `3-5` 和 `35` 撞成同一道题。这里只去**语气与句读**（，。、；：！？引号…），
 *         运算符与括号一律保留。
 *
 *   对照 punch-ingest/v1 的 `hash_L1 = sha1(NFKC(stem) 去所有空白)`：本口径是它的超集
 *   （多了剥 HTML 与 LaTeX 归一），而且**真的拦**（那边只算不拦，见备料 §9 第 6 条）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { sha256Hex } from "../audit";
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const DEDUP_CODES = {
  inBatch: "DUPLICATE_IN_BATCH",
  inDb: "DUPLICATE",
} as const;

/**
 * ① HTML 标签与常见实体
 *
 * ⚠️⚠️ **已知缺陷，2026-08-13（003-E4）查实，按「match_key 不动」的口径挂账未修**：
 *
 *   `<[^>]*>` 是**宽松**剥法，会把「一个数学 `<` 到下一个 `>` 之间的整段」当成标签吃掉
 *   —— 正是 G-3 核查员点名的方法论坑①。真库实测 60 行里有 **2 行**中招：
 *     · `q_01KZVF46KBKBTWEAYK207HGTZA`：`有理数 a < 0，b < 0，c > 0，且…`
 *        归一后变成 `有理数a0且…`（`0，b < 0，c` 被吃）；
 *     · `q_01KZVFBGNZZCZY86M9YXFRHHYS`：`（用 < 或 > 或 = 号填空）` → `(用或=号填空)`。
 *
 *   后果是**查重键失真**：两道只在被吃掉那一段上有区别的题会撞成同一道
 *   （假 `DUPLICATE` 红灯）。不是数据损坏 —— `question.stem` 正本一个字没少，
 *   只有这个 hash 算错了。
 *
 *   🔴 修法现成：换成 `fts.ts` 的 {@link stripHtmlForSeg} 同款严格形状
 *   `</?[a-zA-Z][^<>]*>`（标签名必须紧跟 ASCII 字母、属性区不许再有 `<`）。
 *   **但换它 = 全库 match_key 作废重算**（本条注释顶上那句「别顺手动」说的就是这个），
 *   还要连带做一次撞键预检 —— 属于要拍板的动作，不在 003-E4 的授权范围内，
 *   故此处只挂账、留证据、给修法，等总指挥裁。
 */
const RE_TAG = /<[^>]*>/g;
const 实体表: ReadonlyArray<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&amp;/gi, "&"],
  [/&quot;/gi, '"'],
  [/&#39;/g, "'"],
];

/** ② LaTeX 定界与不影响语义的排版命令 */
const RE_LATEX_NOISE =
  /\\left|\\right|\\,|\\;|\\!|\\quad|\\qquad|\\displaystyle/g;
const RE_LATEX_DELIM = /\$\$|\$|\\\(|\\\)|\\\[|\\\]/g;

/** ④ 只去这些：语气与句读（运算符、括号、小数点一律保留） */
const RE_PUNCT_NOISE = /[\s　，。、；：！？,;:!?"'`“”‘’《》〈〉«»…—～~·・､｡]/g;

/** 规范化题面（纯函数，可单测） */
export function normalizeStem(stem: string): string {
  let s = stem ?? "";
  for (const [re, to] of 实体表) s = s.replace(re, to);
  s = s.replace(RE_TAG, " ");
  s = s.replace(RE_LATEX_NOISE, " ").replace(RE_LATEX_DELIM, " ");
  s = s.normalize("NFKC");
  s = s.replace(RE_PUNCT_NOISE, "");
  return s;
}

/** 查重键 = 规范化题面的 sha256 */
export function matchKeyOf(stem: string): string {
  return sha256Hex(normalizeStem(stem));
}

export const ingestDedupGate: Gate<IngestItemCtx> = {
  name: "⑦查重 match_key",
  async run(ctx: IngestItemCtx): Promise<GateResult> {
    const 位置 = `seq=${ctx.seq}`;
    const key = ctx.derived.matchKey;

    // ── 同批互撞 ─────────────────────────────────────────────────────────────
    const 首 = ctx.batch.keyOwner.get(key);
    if (首 !== undefined && 首 !== ctx.seq) {
      return fail({
        code: DEDUP_CODES.inBatch,
        message: `${位置} 与本批 seq=${首} 是同一道题（归一后题面一致）—— 同批两道一样的题落库时会撞 idx_q_matchkey，整批回滚。去掉一条。`,
        recoverable: true,
      });
    }

    // ── 撞库里的老题 ─────────────────────────────────────────────────────────
    const r = await ctx.batch.handle.client.execute({
      sql: "SELECT id, stem, status FROM question WHERE match_key = ? AND status IN ('pending','active') LIMIT 3",
      args: [key],
    });
    const 撞 = r.rows as unknown as {
      id: string;
      stem: string;
      status: string;
    }[];
    if (撞.length > 0) {
      return fail({
        code: DEDUP_CODES.inDb,
        message:
          `${位置} 库里已经有同一道题（match_key 一致）：${撞
            .map((x) => `${x.id}(${x.status})`)
            .join("、")} —— ` +
          "要么这批本来就该跳过它，要么你想改的是那道老题（改题走更新路径，不是再录一遍）。",
        recoverable: true,
        candidates: 撞.map((x) => ({
          id: x.id,
          label: x.stem.slice(0, 40),
          note: `status=${x.status}`,
        })),
      });
    }

    return { ok: true };
  },
};

export default ingestDedupGate;
