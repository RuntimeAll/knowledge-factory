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
 * ⚠️ 强度边界（诚实标注，别当成它没做到）：侧车验的是**最终答案**，
 *   验不出「答案对、过程错」（备料 §1 的 2026-07-30 事故：LLM 去括号漏变号，
 *   最后一行又锚回正确答案）。逐行恒等校验是另一类闸
 *   （`举一反三产物/解题模型库/_验算/逐行恒等校验.py`），本卡不做，
 *   接进来是后续卡的事 —— 现在写在这儿，免得有人把 calc_verified 当"过程也对"。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";
import { type KbIngestItem } from "../ingest-schema";

export const CALC_CODES = {
  mismatch: "CALC_MISMATCH",
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

export const ingestCalcGate: Gate<IngestItemCtx> = {
  name: "⑧可实算即实算",
  run(ctx: IngestItemCtx): GateResult {
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
  },
};

export default ingestCalcGate;
