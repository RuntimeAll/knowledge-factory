/**
 * 闸④ 题面禁指令词（AI:PRD-003 · 003-C）
 *
 * 纪律出处：记忆 [[stem-no-instruction-words]]（2026-07-27 用户点破）——
 * 「计算：」「变式」「例题」这些是**题目自带的属性**（题型/角色），由 qtype、
 * 册子 item 的 kind 承载，不是题面内容。备料 §3 查证：这条纪律**至今零代码**
 * （`INSTR_IN_STEM` 在 skills/ 与录书工作区全仓零命中），本闸是它的第一块砖。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 反例意识：**不能一刀切**（备料 §5②，种子集 seq 58-61 是天然回归样本）
 *
 *   `有理数 a<0，b<0，c>0，且 |a|<|c|<|b|。化简：|a+c|−|b+c|+|a−b|。`
 *   这里的「化简：」在**句中**，是真题面的一部分，剥了这道题就没有题目了。
 *
 *   所以本闸的剥离口径收得很窄，两个条件同时成立才动手：
 *     ① 指令词在**句首**（`^`，允许它前面有个题号如 `1．`）；
 *     ② 剥完之后剩下的内容**以数学表达式开头**（数字/字母/括号/正负号/竖线/
 *        LaTeX 反斜杠/美元符）。
 *   于是 `计算：3+5×2` 会被剥，而 `计算下面各题，能简算的要简算` 一个字不动
 *   （剩余以中文开头 —— 那是多小问的真题面，剥了就废，记忆里原话）。
 *
 * 🔴 元词（变式/原题/例题…）是另一回事：它们出现在题面**任何位置**都是红灯，
 *    不是「剥掉就好」。因为「变式」标的是这道题**在一组题里的角色**，
 *    题面里带着它，说明喂料方把版面结构当成了题目内容 —— 该回去改产线，
 *    不该由入库这一侧替它猜哪几个字是版面。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const INSTRUCTION_CODES = {
  metaWord: "STEM_HAS_META_WORD",
  emptyAfterStrip: "STEM_EMPTY_AFTER_STRIP",
} as const;

/** 允许剥的句首裸指令词（词表起点见备料 §5①；只收「剥完还剩算式」的那几个） */
export const BARE_INSTRUCTIONS = [
  "计算",
  "解方程",
  "解不等式",
  "化简",
  "求值",
] as const;

/**
 * 句首裸指令词。
 * 🔴 前面那个可选的 `\d{1,3}[．.、]` 不是多余：真实形态是 `1．计算：3+5×2`，
 *    题号在指令词**外面**。题号闸（闸⑤）在本闸之后跑，这里不顺手把题号一起
 *    看穿，指令词就永远躲在题号后面剥不掉。
 */
const RE_LEAD_INSTRUCTION = new RegExp(
  `^[\\s　]*(?:(\\d{1,3}[．.、])[\\s　]*)?(${BARE_INSTRUCTIONS.join("|")})[：:][\\s　]*`,
);

/**
 * 「剩余以数学表达式开头」的判据。
 * 收录：数字、拉丁字母、各种左括号、正负号（含全角与 U+2212）、绝对值竖线、
 *       LaTeX 反斜杠与美元定界、根号/分数等常见符号。
 * 🔴 刻意**不收中文**：中文开头 = 还是一句话，不是算式（那就是真题面）。
 */
const RE_MATH_HEAD = /^[0-9A-Za-z(（[［{｛|｜$\\\-−+．.√±]/;

/** 元词：出现在题面任何位置都红（属性/版面角色，不是题面） */
export const META_WORDS = [
  "变式训练",
  "变式",
  "原题",
  "典型例题",
  "例题",
  "对应练习",
  "方法点拨",
  "跟踪训练",
] as const;

export interface StripResult {
  text: string;
  /** 剥掉的片段（原样，含冒号），页页有账 */
  stripped: string[];
}

/**
 * 剥句首裸指令词（纯函数，可单测）。
 * 迭代最多 3 轮：`1．计算：化简：…` 这种叠加形态见过，但也就到此为止。
 */
export function stripLeadInstruction(stem: string): StripResult {
  let s = stem ?? "";
  const stripped: string[] = [];
  for (let round = 0; round < 3; round++) {
    const m = RE_LEAD_INSTRUCTION.exec(s);
    if (!m) break;
    const rest = s.slice(m[0].length);
    // 🔴 条件②：剩下的必须以算式开头，否则这个「计算：」是真题面的一部分
    if (!RE_MATH_HEAD.test(rest.trimStart())) break;
    stripped.push(m[0].trim());
    s = rest.trimStart();
  }
  return { text: s, stripped };
}

/** 题面里出现的元词（返回全部命中，一次说完） */
export function findMetaWords(stem: string): string[] {
  const hit: string[] = [];
  for (const w of META_WORDS) {
    if (!stem.includes(w)) continue;
    // 「变式训练」命中后不再报「变式」（同一处别报两遍）
    if (hit.some((h) => h.includes(w))) continue;
    hit.push(w);
  }
  return hit;
}

export const ingestInstructionGate: Gate<IngestItemCtx> = {
  name: "④题面禁指令词",
  run(ctx: IngestItemCtx): GateResult {
    const 位置 = `seq=${ctx.seq}`;
    const s = ctx.derived.stemStripped;

    if (s.trim().length === 0) {
      return fail({
        code: INSTRUCTION_CODES.emptyAfterStrip,
        message: `${位置} 题面剥掉句首指令词之后什么都不剩了（原文：「${ctx.item.stem.slice(0, 40)}」）—— 说明这条根本不是题，是个标题/栏目名。`,
        recoverable: false,
      });
    }

    const 元词 = findMetaWords(s);
    if (元词.length > 0) {
      return fail({
        code: INSTRUCTION_CODES.metaWord,
        message:
          `${位置} 题面里带着元词：${元词.map((w) => `「${w}」`).join("、")} —— ` +
          "这些是题目**在一组题里的角色**（属性），不是题面内容；带进库以后卷面会把它印给学生看。" +
          "回产线把版面标记从题面里摘掉（角色请走 tags / qtype），不要在这儿手工删几个字了事。",
        recoverable: true,
        example: `stem: "$3+5\\times 2$"，tags: ["变式"]`,
      });
    }

    if (ctx.derived.stripped.length === 0 && s !== ctx.item.stem) {
      // 只可能是 trim 造成的差异，记一笔免得账对不上
      ctx.derived.notes.push("题面首尾空白已归一");
    }
    return { ok: true };
  },
};

export default ingestInstructionGate;
