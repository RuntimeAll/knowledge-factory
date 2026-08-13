/**
 * 闸⑥ 占位红旗（AI:PRD-003 · 003-C）
 *
 * 口径出处：`题面速判/SKILL.md` §4.2「题面纯净体检」第 3、4 条 +
 * `preflight_lint.py` 的 PLACEHOLDER（那边在 HARD 集合里，命中即退出码 1）。
 *
 * 拦五种「看起来是题、其实是半成品」：
 *   ① 空题面（前面两道闸剥完可能变空，这里兜底）
 *   ② 纯占位：整条题面就是「略」「待补」「TODO」
 *   ③ 题面/解析里带**内部占位串**『［图…』（无论 figures 给没给）
 *   ④ 声称有图但 figures 是空的
 *   ⑤ 题面里写着「如图/见图/图中…」但一张 role='stem' 的图都没有
 *
 * 🔴 ④⑤ 是同一件事的两个入口，都指向同一个事故形态：**题进了库，图没进**。
 *    这种题在卷面上是一道无法作答的残题，而 SQL/FTS/向量三路检索都照常把它捞出来
 *    —— 又一次「静默半失效」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 ③ 是 003-E4 补的**闸⑥盲点**（G-3 专项路 P1 抓到，实证 q_01KZVFBGNZ…HHYS）
 *
 *   原来的判据是「题面声称有图 **且** figures 为空 ⇒ 红」。于是喂料方把内联 SVG
 *   渲成 PNG、带着 `figures` 重投时，闸就**放行了** —— 而题面里那句
 *   `［图·内联SVG］` 还原样躺着，跟着灌进库、印上卷面。
 *
 *   『［图·内联SVG］』**是备料层的一面红旗，不是题面的一部分**（契约 §2.4）。
 *   图的信息由 `figures` 通道承载，占位串该在**喂料侧**改写/删除掉。
 *   ⇒ 判据改成「出现即红」，与 figures 给没给无关：
 *      给了图 = 图有了，占位串更没有理由留着；没给图 = 本来就该红。
 *
 *   与 ④ 的分工：④ 管「说了有图却没图」，③ 管「内部词进了卷面」。
 *   ③ 排在 ④ 前面 —— 两条同时成立时（没给图且带占位串），报更准的那个码。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 answer/analysis 里的**纯占位**只记 note 不拦：它们不影响这道题**能不能出**
 *    （solution_grade 那一档会如实降级），拦下来反而挡住「先录题面、答案后补」
 *    这种合理节奏。题面不一样 —— 题面是残的，这道题就不成立。
 *    但 ③ 的**内部占位串**两处都拦：解析也是要印给人看的，内部词一样不能进。
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const PLACEHOLDER_CODES = {
  empty: "STEM_EMPTY",
  placeholder: "STEM_PLACEHOLDER",
  internalMarker: "STEM_INTERNAL_MARKER",
  figureMissing: "FIGURE_DECLARED_BUT_MISSING",
} as const;

/**
 * 内部占位串的头部特征（契约 §2.4 的『［图·内联SVG］』及同族写法）。
 *
 * 🔴 只收**方括号开头**的形态：`［图` / `[图`。
 *    刻意**不收** `（图1）`/`(图2)` —— 那是正常中文题面在指某张图的编号，
 *    不是我们的内部记号。收了它等于把一大票正常题打成红灯。
 */
const INTERNAL_MARKERS = ["［图", "[图"] as const;

/** 题面/解析里带内部占位串就返回它（用于报错时把原话摆出来） */
export function internalMarkerIn(text: string | null): string | null {
  const s = text ?? "";
  for (const m of INTERNAL_MARKERS) if (s.includes(m)) return m;
  return null;
}

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

    // ── ③ 内部占位串（🔴 无论 figures 给没给都红；排在 ④ 前面，码更准）──────────
    for (const [列, 文] of [
      ["题面", stem],
      ["解析", ctx.item.analysis],
    ] as const) {
      const 记号 = internalMarkerIn(文);
      if (记号 === null) continue;
      const 有图 = (ctx.item.figures ?? []).length > 0;
      return fail({
        code: PLACEHOLDER_CODES.internalMarker,
        message:
          `${位置} ${列}里带着内部占位串「${记号}…」（如『［图·内联SVG］』）—— ` +
          "这是备料层的一面红旗，不是题面的一部分，它会原样印到卷面上。" +
          `本题${有图 ? "已经给了 figures" : "没给 figures"}，但**给没给都一样红**：` +
          "图的信息由 figures 通道承载，占位串必须在**喂料侧**改写/删除掉（内部词不进卷面）。" +
          "两条路（契约 kb-ingest/v1 §2.4）：把内联 SVG 渲成图片落盘、" +
          "作为 figures:[{role:'stem', path:…}] 给进来**并同时把占位串从题面删掉**；" +
          "或者把对图的引用改写成文字描述。",
        recoverable: true,
        example: `"stem": "如图，数轴上的三点 A、B、C…。\\n(1) 填空：…"，另配 "figures": [{ "role": "stem", "path": "D:/…/fig-01.svg" }]`,
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
