/**
 * 闸⑤ 前缀清洗（AI:PRD-003 · 003-C）
 *
 * 纪律出处：记忆 [[prefix-cleaning-mandatory]]（「已忘 ≥3 次被批」）+
 * `录题管线/SKILL.md` 原子入库六闸④。以前它是**灌完库再补跑的脚本**，
 * 于是「忘了跑」就成了常态；本卡把它做进管道 —— 灌库这一步本身包含清洗，
 * 忘不了（🔴 punch-console 的教训原话：靠 SOP 记的闸迟早漏，做进管道的闸漏不了）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 正则全部照抄现行实现，出处逐条标注（备料 `闸物料-指令词与前缀.md`）：
 *
 *   §1  `.claude/skills/必刷题整书录入/scripts/clean_stems.py` L18-30 + L44
 *       七条：BRACKET / COLUMN / SHUA / PTYPE / MOTHER / PITFALL / THOUGHT + 情境标签
 *   §2  同目录 `clean_stems_v2.py` L10-20
 *       三条：LABEL / STAR / RESID（口径更宽，且 RESID 是**复核**用的残留判据）
 *   §3  `录书工作区/小学数学管线/preflight_lint.py` L33
 *       一条：RE_STEM_PREFIX（题号前缀）
 *
 *   移植时只做了一处**有意的偏离**，理由写在 RE_STEM_PREFIX 上（1.5 米那个坑）。
 *   除此之外一个字符都没改 —— 改口径要先去改那三份正本，不在这儿分叉。
 *
 * 🔴 收尾必须有**机器复核**（原文那句 `REGEXP = 0`）：剥完再拿 RESID/BRACKET/
 *    题号三条打一遍，还命中就红灯。备料 §5④ 提醒 SQLite 没有内建 REGEXP ——
 *    所以这条复核在**入库前**用 JS 正则做，不指望 SQL 侧事后查。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const PREFIX_CODES = {
  residue: "STEM_PREFIX_RESIDUE",
  emptyAfterClean: "STEM_EMPTY_AFTER_CLEAN",
} as const;

// ── §1 clean_stems.py 七条 ────────────────────────────────────────────────────

/** `[2025浙江杭州期末，较难]` → 来源/年份/难度（原剥完分流到 exam_year/region/…） */
const BRACKET = /^\s*[[［【]\s*(20\d\d)([^\]］】]*?)\s*[\]］】]\s*/;
/** `新考向·传统文化` 栏目 */
const COLUMN =
  /^\s*(新考向|新考法|新素材)((?:传统文化|开放性试题|跨学科综合|项目化学习|代数推理|真实情境类问题|项目学习))?\s*[·:：]?\s*/;
/** `刷易错` 栏目 */
const SHUA = /^\s*(刷易错|刷素养|刷基础|刷提升)\s*[·:：]?\s*/;
/** `类型3 数轴上的动点·` 题型前缀 */
const PTYPE =
  /^\s*(类型|考点|微专题|题型)\s*\d+\s*[·:：]?\s*([^[\]［］【】。．:：\n]{0,25}?)\s*(?:[·:：．。]\s*|(?=[[［【]))/;
/** `母题学大招5（数形结合）` */
const MOTHER =
  /^\s*母题学大招\s*\d+\s*[（(]?\s*([^[\]［］【】。．\n)]{0,20})\s*[）)]?\s*[:：]?\s*/;
/** `易错点：忽略绝对值的非负性致错` */
const PITFALL =
  /^\s*易错点\s*[:：]?\s*([^。．\n]{4,40}致错|[^。．\n]{4,30})\s*[。．]?\s*/;
const THOUGHT_KW =
  "推理能力|运算能力|几何直观|抽象能力|数感|符号意识|空间观念|数据观念|模型观念|应用意识|创新意识|" +
  "数形结合|分类讨论|方程思想|函数思想|整体思想|转化化归|对应思想|归纳猜想|类比|特殊与一般|消元|配方";
/** `核心素养·运算能力` */
const THOUGHT = new RegExp(
  `^\\s*(核心素养|思想方法|数学思想)\\s*[·]?\\s*(${THOUGHT_KW})\\s*[·:：]?\\s*`,
);
/** `【素材】` 情境标签（clean_stems.py L44，原本不是模块级常量） */
const SCENE =
  /^[\s　]*【\s*(概念学习|素材|阅读理解|新定义|图文题|材料阅读|项目学习|跨学科综合|情境)\s*】\s*/;

// ── §2 clean_stems_v2.py 三条 ────────────────────────────────────────────────

const LABEL = new RegExp(
  "^\\s*(?:" +
    "【[^】]{0,40}?(?:专题|易错|考向|考法|素材|思想|素养|类型|题型|难关|拓展|模型|大招|走向重高)[^】]{0,40}?】" +
    "|[（(]\\s*20\\d\\d[^）)]{0,30}[）)]" +
    "|(?:新考法|新考向|新素材|思想方法|数形结合|分类讨论|整体思想|方程思想|核心素养|几何直观|运算能力|推理能力" +
    "|微专题\\d*|题型\\d*|类型\\d*|易错点?|走向重高|项目化学习|跨学科(?:综合)?|传统文化|开放性试题|真实情境(?:类问题)?|代数推理|新定义|规律探究)" +
    "(?:[·•・:：、，\\s　]+(?:开放性试题|传统文化|跨学科综合|项目化学习|代数推理|真实情境类问题))?" +
    ")[·•・:：、，.\\s　]*",
);
const STAR = /^\s*(?:难度?\s*)?[★⭐☆]{1,5}[·•・:：、\s　]*/;
/** 🔴 RESID 是**复核**判据：剥完还命中它 = 清洗没干净 */
const RESID =
  /^\s*(?:【[^】]{0,40}?(?:专题|易错|考向|考法|思想|素养|类型|题型)[^】]{0,40}?】|新考法|新考向|思想方法|微专题|易错点|[★⭐])/;

// ── §3 preflight_lint.py 一条（有意偏离，见下）────────────────────────────────

/**
 * 题号前缀。原文是 `^\s*\d{1,3}[．.、]\s*`。
 * 🔴 **有意偏离**：半角句点那一支加了 `(?!\d)` 负向前瞻。
 *    原文里它只是**软告警**（不在 preflight 的 HARD 集合，人看一眼再说），
 *    搬到这儿是要真剥的 —— 而 `1.5 米的绳子…` 会被原正则剥成 `5 米的绳子…`，
 *    题目当场变错。加一个前瞻，代价是 `1.5` 这种真题号（不存在）剥不掉，
 *    换来的是小数题面不会被咬。
 */
const STEM_PREFIX = /^\s*\d{1,3}(?:[．、]|\.(?!\d))\s*/;

/** 剥离用的规则表（顺序 = clean_stems 的迭代顺序：先具体后宽泛） */
const 剥离规则: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "BRACKET", re: BRACKET },
  { name: "SCENE", re: SCENE },
  { name: "COLUMN", re: COLUMN },
  { name: "SHUA", re: SHUA },
  { name: "PTYPE", re: PTYPE },
  { name: "MOTHER", re: MOTHER },
  { name: "PITFALL", re: PITFALL },
  { name: "THOUGHT", re: THOUGHT },
  { name: "LABEL", re: LABEL },
  { name: "STAR", re: STAR },
  { name: "STEM_PREFIX", re: STEM_PREFIX },
];

/** 收尾清孤立标点（clean_stems.py 末尾那句 `re.sub(r"^[\s　．。·]+", "", s)`） */
const 孤立标点 = /^[\s　．。·]+/;

export interface CleanResult {
  text: string;
  /** 剥掉的片段（原样），逐条留痕 */
  stripped: string[];
}

/**
 * 前缀清洗（纯函数，可单测）。
 * 迭代最多 8 轮（clean_stems.py 的 `for _ in range(8)`：防多层叠加，也防死循环）。
 */
export function cleanStemPrefix(stem: string): CleanResult {
  let s = stem ?? "";
  const stripped: string[] = [];
  for (let round = 0; round < 8; round++) {
    let 动过 = false;
    for (const { re } of 剥离规则) {
      const m = re.exec(s);
      if (!m || m[0].length === 0) continue;
      const rest = s.slice(m[0].length);
      // 🔴 剥完不能是空的：整条题面就是一个标签时，宁可留着让占位闸去红，
      //    也不要静默产出一道空题。
      if (rest.trim().length === 0) continue;
      stripped.push(m[0].trim());
      s = rest;
      动过 = true;
      break; // 命中一条就重头再来（对齐 clean_stems 的 continue 语义）
    }
    if (!动过) break;
  }
  const 尾 = s.replace(孤立标点, "");
  if (尾 !== s && 尾.trim().length > 0) s = 尾;
  return { text: s.trim(), stripped };
}

/** 复核：剥完还能命中的残留判据（对应原文那句 `REGEXP = 0`） */
export function prefixResidue(stem: string): string | null {
  for (const [name, re] of [
    ["RESID", RESID],
    ["BRACKET", BRACKET],
    ["STEM_PREFIX", STEM_PREFIX],
  ] as const) {
    const m = re.exec(stem);
    if (m && m[0].trim().length > 0) return `${name}:「${m[0].trim()}」`;
  }
  return null;
}

export const ingestPrefixGate: Gate<IngestItemCtx> = {
  name: "⑤前缀清洗",
  run(ctx: IngestItemCtx): GateResult {
    const 位置 = `seq=${ctx.seq}`;
    const s = ctx.derived.stemClean;

    if (s.trim().length === 0) {
      return fail({
        code: PREFIX_CODES.emptyAfterClean,
        message: `${位置} 题面把前缀剥完就空了（原文：「${ctx.item.stem.slice(0, 40)}」）—— 这条是栏目名/标题，不是题。`,
        recoverable: false,
      });
    }

    const 残 = prefixResidue(s);
    if (残 !== null) {
      return fail({
        code: PREFIX_CODES.residue,
        message:
          `${位置} 前缀清洗后仍有残留（${残}）—— 机器复核这一关等价于老口径里那句 ` +
          "`残留 REGEXP 必须 = 0`。本闸的剥离规则没覆盖到这个形态，" +
          "请在源头把它摘掉（或去 clean_stems 那套正本里补规则，再同步到本闸）。",
        recoverable: true,
      });
    }
    return { ok: true };
  },
};

export default ingestPrefixGate;
