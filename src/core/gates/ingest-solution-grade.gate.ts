/**
 * 闸⑨ 解答成色判档 solution_grade（AI:PRD-003 · 003-C）
 *
 * 三档语义（建表 CHECK 就这三个值，M1 §3.B / Q11）：
 *
 *   calc_verified   本管道亲自实算过且与答案等值（闸⑧ verified）——最硬的一档
 *   analysis_only   有解析、或有答案，人能核得动 ——「够用，但机器没验过」
 *   no_solution     两样都没有 ——🔴 Q11：**排除出出题检索**（出了也讲不了）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 一个刻意收窄的口径：`answer-only 且没实算过` 也落 analysis_only。
 *
 *   曾经想过给它单开一档（"只有个答案，连解析都没有"确实比"有完整解析"弱）。
 *   没开，两个理由：
 *     ① 三档是**建表 CHECK 里的封闭集合**，加档就是改 schema —— 本卡红线：不动普通表；
 *     ② 这一档要回答的问题是「这题能不能拿出去用」，answer-only 与 analysis-only
 *        的答案都是「能，人核一眼就行」。真正的分水岭在「机器验过没有」（calc_verified）
 *        和「有没有解答」（no_solution），中间那一档不必再切。
 *   代价是 analysis_only 里混着强弱不等的题 —— 所以 qtype='计算' 却验不动、
 *   又连解析都没有的，本闸会往 gate_report 里记一笔 warn（不拦路，但账上看得见）。
 *
 * 🔴 no_solution 在这儿是**防御性**红灯：契约层（ingest-schema 的 superRefine）
 *    已经拦掉了「answer 与 analysis 都没有」。走到这一步还判出 no_solution，
 *    说明契约层被绕过了（有人直接调 core 而不是走 runIngestBatch），
 *    那是 bug，不该静默落一行进库。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";
import { type SolutionGrade } from "../ingest-schema";
import { type CalcVerifyResult } from "../sidecar";

export const GRADE_CODES = {
  noSolution: "NO_SOLUTION",
} as const;

/** 判档（纯函数，可单测） */
export function decideSolutionGrade(input: {
  answer: string | null;
  analysis: string | null;
  calc: CalcVerifyResult | null;
}): SolutionGrade {
  if (input.calc?.verdict === "verified") return "calc_verified";
  if (input.analysis !== null || input.answer !== null) return "analysis_only";
  return "no_solution";
}

export const ingestSolutionGradeGate: Gate<IngestItemCtx> = {
  name: "⑨判档 solution_grade",
  run(ctx: IngestItemCtx): GateResult {
    const 位置 = `seq=${ctx.seq}`;
    const grade = decideSolutionGrade({
      answer: ctx.item.answer,
      analysis: ctx.item.analysis,
      calc: ctx.derived.calc,
    });

    if (grade === "no_solution") {
      return fail({
        code: GRADE_CODES.noSolution,
        message: `${位置} answer 与 analysis 都没有 —— 这种题按 Q11 会被排除出出题检索（出了也讲不了），不如别录。（🔴 契约层本该已经拦下，走到这一步说明有人绕过了 runIngestBatch。）`,
        recoverable: true,
      });
    }

    if (
      grade === "analysis_only" &&
      ctx.item.qtype === "计算" &&
      ctx.derived.calc?.verdict === "cannot_verify" &&
      ctx.item.analysis === null
    ) {
      ctx.derived.notes.push(
        "【warn】标了 qtype='计算' 却实算不动，而且没有解析 —— 这道题落 analysis_only 是如实降级，" +
          "但它在库里属于最弱的一类：机器没验过、人也没有过程可核。要么补解析，要么把题面写成机器读得懂的算式。",
      );
    }

    ctx.derived.solutionGrade = grade;
    return { ok: true };
  },
};

export default ingestSolutionGradeGate;
