/**
 * 闸⑧ 可实算即实算（AI:PRD-003 · 003-C）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 **自家实算，不继承产线自报**（备料 R6）
 *
 *   punch-ingest/v1 的题级字段里有个 `实算: "绿"`，消费端原样落库、不复算
 *   （原文注释：「产线说绿才是绿（它逐题实算过）」）。kb-ingest/v1 **不认这个绿**：
 *   契约里压根没有「实算」字段可填 —— 想让一道题拿到 `calc_verified`，
 *   只有一条路，就是本闸把它送进 sympy 侧车真算一遍。
 *
 *   理由不是不信任产线，是**信任不可迁移**：产线的绿是「那一版脚本、那一天、
 *   那个人」的结论，进了库以后没人知道它当时验的是什么口径。库里的绿必须是
 *   库自己算的，才谈得上「可对账」。
 *
 * 🔴 mismatch 是**红灯**，不是警告。
 *   缺答案只是「这题还不能用来出卷」（判档降级即可），
 *   答案错是「这题会把学生教错」——严重程度差一个量级。
 *   记忆 [[self-authored-problems-must-be-solved]] 的原话：方法写错比答案写错更坑；
 *   而答案错，是连方法都懒得看就能发现的那一类。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 **两个判据，不是一个**（003-E 补口）
 *
 *   ① calc_verify   最终答案对不对        → `CALC_MISMATCH`
 *   ② line_verify   过程每一行对不对      → `CALC_LINE_MISMATCH`
 *
 *   ② 补的正是 ① 结构性验不出的那一类：**答案对、过程错**。
 *   备料 §1 那次事故（2026-07-30 有理数打卡第二天第 9 题）就是这个形态 ——
 *   LLM 写解析时去括号漏变号，最后一行又锚定回已验算的正确答案，
 *   于是「只重算最终答案」的闸对它完全免疫。记忆 [[line-identity-check-gate]]
 *   的原话：**LLM 解析头号错误 = 中间行错、答案对**。
 *
 *   所以这道闸判两次：先判答案（错得更严重：题目本身就是错的），
 *   再判过程（题对、讲错 —— 学生照着那一行学，学到的是错方法）。
 *   两者都是**红灯**：记忆 [[self-authored-problems-must-be-solved]] 原话
 *   「方法写错比答案写错更坑」。
 *
 * ⚠️ 强度边界（诚实标注）：line_verify **只判数值链**。含未知量的变形链
 *   （解方程、字母化简）一律 no_checkable_lines 记账放行 —— 判它们要比解集
 *   （逐行恒等校验.py 的 eq 模式），拿恒等去判 `x=1` 这种行会当场判出假红。
 *   本闸是红灯闸：假红拦下真题的代价，比漏判一条大。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";
import { type KbIngestItem } from "../ingest-schema";

export const CALC_CODES = {
  mismatch: "CALC_MISMATCH",
  lineMismatch: "CALC_LINE_MISMATCH",
} as const;

/**
 * 「看起来就是一条纯算式」的判据（纯函数，可单测）。
 * 🔴 只用来**扩大**送算范围（qtype 没标 `计算` 但题面是裸算式的，照样送去算），
 *    判不准也不会误伤：送进去算不动，侧车如实回 cannot_verify。
 */
export function looksLikePureExpression(stem: string): boolean {
  const t = (stem ?? "").trim();
  if (t.length === 0) return false;
  if (/[一-鿿]/.test(t)) return false; // 有中文 = 是一句话，不是裸算式
  if (!/\d/.test(t)) return false;
  return /[+\-−×÷*/^]|\\times|\\div|\\frac|\\sqrt|\\cdot/.test(t);
}

/** 这题要不要送去实算 */
export function isCalcCandidate(
  item: KbIngestItem,
  stemStripped: string,
): boolean {
  return item.qtype === "计算" || looksLikePureExpression(stemStripped);
}

/**
 * 这题要不要送去**逐行**校（总指挥 2026-08-13 定的口径）。
 * 🔴 收得比 isCalcCandidate 窄：必须是 `qtype='计算'` **且有解析** ——
 *    没解析就没有"过程"可校，题面本身不是链。
 */
export function isLineVerifyCandidate(item: KbIngestItem): boolean {
  return item.qtype === "计算" && item.analysis !== null;
}

/** 判据①：最终答案（calc_verify） */
function 判答案(ctx: IngestItemCtx): GateResult {
  const 位置 = `seq=${ctx.seq}`;
  const calc = ctx.derived.calc;

  // 非计算题：压根没送去算（不是"算过了没结论"，账上要分得清）
  if (calc === null) return { ok: true };

  switch (calc.verdict) {
    case "verified":
      ctx.derived.notes.push(
        `实算通过：${calc.detail.expr} = ${calc.detail.computed}（判档候选 calc_verified）`,
      );
      return { ok: true };

    case "mismatch":
      return fail({
        code: CALC_CODES.mismatch,
        message:
          `${位置} 实算与答案对不上：${calc.detail.expr} 算出 ${calc.detail.computed}，` +
          `而答案写的是 ${calc.detail.expected} —— 🔴 答案错的题比没答案的题严重得多（它会把人教错），` +
          "所以这里是红灯不是降级。回去核这道题：要么答案抄错了，要么题面数字抄错了。",
        recoverable: true,
        example: `computed=${calc.detail.computed} / expected=${calc.detail.expected}`,
      });

    case "cannot_verify":
      // 🔴 如实降级，不美化：应用题、含未知量的化简、单位换算…本来就算不了
      ctx.derived.notes.push(
        `实算算不动（如实报，不猜）：${calc.detail.reason} —— 判档退到 analysis_only`,
      );
      return { ok: true };
  }
}

/** 判据②：过程逐行恒等（line_verify） */
function 判过程(ctx: IngestItemCtx): GateResult {
  const 位置 = `seq=${ctx.seq}`;
  const lv = ctx.derived.lineVerify;
  if (lv === null) return { ok: true };

  switch (lv.verdict) {
    case "all_identical":
      ctx.derived.notes.push(
        `逐行恒等通过：${lv.chains} 条链共 ${lv.checked} 处比对全等`,
      );
      return { ok: true };

    case "no_checkable_lines":
      // 🔴 如实记账：这道题的解析本闸判不了（含未知量/纯文字），不是"判过了"
      ctx.derived.notes.push(
        `逐行恒等无从判（如实报，不猜）：${lv.reason} —— 这道题的过程仍需人核`,
      );
      return { ok: true };

    case "line_mismatch": {
      const 明细 = lv.badLines
        .slice(0, 3)
        .map(
          (b) =>
            `第 ${b.line} 行「${b.text}」：${b.right} = ${b.computed}，` +
            `而原式 ${b.left} = ${b.expected}`,
        )
        .join("；");
      return fail({
        code: CALC_CODES.lineMismatch,
        message:
          `${位置} 解析的过程有 ${lv.badLines.length} 处与原式不恒等 —— ${明细}` +
          (lv.badLines.length > 3 ? "（只列前 3 处）" : "") +
          "。🔴 这正是「答案对、过程错」：最终答案那一行可能是对的（实算闸放行了），" +
          "但中间某一行已经断了，学生照着那一行学，学到的是错方法。" +
          "回去核这道题的解析——去括号变号、约分、移项，多半错在这几处。",
        recoverable: true,
        example: lv.badLines[0]
          ? `第 ${lv.badLines[0].line} 行：${lv.badLines[0].right} 算出 ${lv.badLines[0].computed}，应为 ${lv.badLines[0].expected}`
          : undefined,
      });
    }
  }
}

export const ingestCalcGate: Gate<IngestItemCtx> = {
  name: "⑧可实算即实算",
  run(ctx: IngestItemCtx): GateResult {
    // 🔴 先判答案再判过程：答案错 = 题目本身错，比过程错更根子上。
    //    两者都红时先报答案那一处（一次修一个根子，别让人同时改两件事）。
    const 答案 = 判答案(ctx);
    if (!答案.ok) return 答案;
    return 判过程(ctx);
  },
};

export default ingestCalcGate;
