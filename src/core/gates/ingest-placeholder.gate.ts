/**
 * 闸⑥ 占位红旗（AI:PRD-003 · 003-C）
 *
 * 口径出处：`题面速判/SKILL.md` §4.2「题面纯净体检」第 3、4 条 +
 * `preflight_lint.py` 的 PLACEHOLDER（那边在 HARD 集合里，命中即退出码 1）。
 *
 * 拦四种「看起来是题、其实是半成品」：
 *   ① 空题面（前面两道闸剥完可能变空，这里兜底）
 *   ② 纯占位：整条题面就是「略」「待补」「TODO」
 *   ③ 声称有图但 figures 是空的
 *   ④ 题面里写着「如图/见图/图中…」但一张 role='stem' 的图都没有
 *
 * 🔴 ③④ 是同一件事的两个入口，都指向同一个事故形态：**题进了库，图没进**。
 *    这种题在卷面上是一道无法作答的残题，而 SQL/FTS/向量三路检索都照常把它捞出来
 *    —— 又一次「静默半失效」。
 *
 * 🔴 answer/analysis 里的占位只记 note 不拦：它们不影响这道题**能不能出**
 *    （solution_grade 那一档会如实降级），拦下来反而挡住「先录题面、答案后补」
 *    这种合理节奏。题面不一样 —— 题面是残的，这道题就不成立。
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const PLACEHOLDER_CODES = {
  empty: "STEM_EMPTY",
  placeholder: "STEM_PLACEHOLDER",
  figureMissing: "FIGURE_DECLARED_BUT_MISSING",
} as const;

/** 整条就是占位（前后允许有标点/空白） */
const RE_PURE_PLACEHOLDER =
  /^[\s　]*(略|待补|待定|暂无|TODO|todo|待补充|见后|同上)[。．.、，,；;：:]*[\s　]*$/;

/**
 * 「题面在说它有一张图」的判据。
 * 🔴 收的是**指着一张已存在的图**的说法；`画图`/`作图`/`图形` 这类刻意不收
 *    （那是让学生画，不是我们缺一张图）。
 */
const FIGURE_WORDS = [
  "如图",
  "见图",
  "下图",
  "上图",
  "右图",
  "左图",
  "图中",
  "图所示",
  "如下图",
  "［图",
  "[图",
  "（图",
  "(图",
] as const;

export function declaresFigure(stem: string): string | null {
  for (const w of FIGURE_WORDS) if (stem.includes(w)) return w;
  return null;
}

export function isPurePlaceholder(text: string): boolean {
  return RE_PURE_PLACEHOLDER.test(text ?? "");
}

export const ingestPlaceholderGate: Gate<IngestItemCtx> = {
  name: "⑥占位红旗",
  run(ctx: IngestItemCtx): GateResult {
    const 位置 = `seq=${ctx.seq}`;
    const stem = ctx.derived.stemClean;

    if (stem.trim().length === 0) {
      return fail({
        code: PLACEHOLDER_CODES.empty,
        message: `${位置} 题面是空的。`,
        recoverable: false,
      });
    }

    if (isPurePlaceholder(stem)) {
      return fail({
        code: PLACEHOLDER_CODES.placeholder,
        message: `${位置} 题面只有一个占位符「${stem.trim()}」—— 半成品别进库：库里躺着的占位题会被检索捞出来，然后印到卷子上。`,
        recoverable: false,
      });
    }

    const 图词 = declaresFigure(stem);
    const 题干图 = (ctx.item.figures ?? []).filter((f) => f.role === "stem");
    if (图词 !== null && 题干图.length === 0) {
      return fail({
        code: PLACEHOLDER_CODES.figureMissing,
        message:
          `${位置} 题面里写着「${图词}」，但没给任何 role='stem' 的配图 —— ` +
          "题进库、图没进，卷面上就是一道做不了的残题（而三路检索照样把它捞出来）。" +
          "把图补上（figures:[{role:'stem', path:'…'}]），或者把题面里对图的引用改写成文字描述。",
        recoverable: true,
        example: `"figures": [{ "role": "stem", "path": "D:/…/fig-01.png" }]`,
      });
    }

    for (const [名, 值] of [
      ["answer", ctx.item.answer],
      ["analysis", ctx.item.analysis],
    ] as const) {
      if (值 !== null && isPurePlaceholder(值)) {
        ctx.derived.notes.push(
          `${名} 是占位符「${值.trim()}」——不拦路，但这题的解答成色实际上等于没有（判档会如实降级）`,
        );
      }
    }

    return { ok: true };
  },
};

export default ingestPlaceholderGate;
