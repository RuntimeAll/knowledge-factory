/**
 * core/segment.ts —— 🔴 分词统一层（AI:PRD-004 · 004-A）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 一句话：**全产品只有这一处分词**。写侧（question.stem_plain + question_fts 三段）
 * 与查侧（ftsQuery 的 MATCH 串）从此走同一份代码、同一份词典、同一套归一。
 *
 * 为什么把它从 Python 侧车搬回 node（总指挥拍板 2026-08-13）：
 *   侧车分词是「一次调用起一个 python 进程」，jieba 载词典 ~0.4s ——
 *   **查询路径上不能有这个**（004 的三路检索每次查询都要分词一次）。
 *   `@node-rs/jieba` 是 jieba-rs 的 napi 绑定，同一套算法、进程内、零启动开销。
 *   侧车不退休，只是**退守 sympy 实算专职**（calc_verify / line_verify）；
 *   它的 `segment` op 保留着，作为「新旧分词口径对照」的参照物（重派生脚本要用）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 三条纪律
 *
 * ① **写侧 search / 查侧 exact，方向不许反**（口径承自 003-C）。
 *    search 模式长词再切、索引更胖；exact 切出来的 token 必是 search 的子集，
 *    所以「查得到的一定在索引里」。反过来（写 exact / 查 search）就是静默漏召回。
 *
 * ② **喂料归一在本文件内做，外面别先剥一遍**。`segSearch` / `segExact` 进门
 *    第一件事就是 {@link stripHtmlForSeg} + {@link deLatex}。
 *    🔴 剥 HTML **不幂等**（`&amp;lt;` 剥两次会变成 `<`，凭空多解一层），
 *    所以调用方一律传**原文**，不许自己先剥。
 *
 * ③ **词典变了就得重派生存量**。自定义词典只在「分词那一刻」生效，
 *    库里躺着的 stem_plain / question_fts 是旧切法。加词后不跑重派生 =
 *    新词只对新题有效，老题查不到 —— 又一次静默半失效。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * §双词典并集（🔴 本文件唯一"聪明"的地方，值得多读两行）
 *
 * 自定义词典是把双刃剑：把「一元一次方程」加成一个整词，jieba 就**不再**在
 * 搜索模式里吐出四字子词「一次方程」了（cut_for_search 只补 2-gram 与 3-gram）。
 * 于是「加个词典」这个纯增量的动作，会**悄悄让某些老查询查不到东西**。
 * 这类倒退没有任何报错，只有"怎么少了几条"。
 *
 * 解法不是"小心选词"（选词是人的判断，判断会错），是把它变成结构上不可能：
 *
 *   segSearch(text) = 搜索模式(text | 基础词典 + 自定义词典)
 *                   ∪ 搜索模式(text | 基础词典)
 *
 * 并集 ⇒ 索引 token 只增不减 ⇒ **加词典永远不会让召回变低**，最多让索引胖一点
 * （实测每题多几个 token，60~万级题量都无所谓）。
 * 于是词典维护者只需回答「它是不是数学专名」，不必权衡"会不会切丢子词"。
 *
 * 查侧不并集：`segExact` 只用自定义词典切一次。因为 exact ⊆ search 恒成立
 * （cut_for_search 的输出必含 cut 的全部词），纪律①的保证依旧在。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Jieba } from "@node-rs/jieba";
import { dict as 基础词典 } from "@node-rs/jieba/dict.js";

// ---------------------------------------------------------------------------
// 喂料归一 ①：剥 HTML（🔴 严格形状，口径正本原在 003-E4 · core/fts.ts）
// ---------------------------------------------------------------------------

/**
 * 🔴 **只认「标签形状」的 `<…>`，不认数学不等号**。
 *
 * 群卷题面里混着三种格式（备料 R2 实测）：填空线是
 * `<span style="display:inline-block;border-bottom:1px solid #000;min-width:3.4em"></span>`，
 * 选项栅格是 `<div style="display:grid;…">`。这些样式串一路喂进 jieba，
 * 检索词里就躺着 `span` / `style` / `display` / `border` / `bottom` / `1px` / `solid`
 * —— 搜「border」能搜出一堆填空题，而这些 token 不是题目的任何一部分。
 *
 * 但**不能**用 `<[^>]*>` 通杀（G-3 核查员方法论坑①）：库里真有裸不等号的题面 ——
 *
 *   `有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|。`
 *   `（用 < 或 > 或 = 号填空）`
 *   `1 000 < 50 653 < 1 000 000`
 *
 * `<[^>]*>` 会把 `< 0，b < 0，c >` 整段当成一个标签吃掉，题面直接丢字。
 *
 * 所以形状收得很紧：`<` 或 `</` 之后**紧跟**一个 ASCII 字母，且属性区间里
 * **不许再出现 `<`**（合法 HTML 属性里的 `<` 一律写成 `&lt;`）。
 */
const RE_HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;

/**
 * HTML 实体 → 字面字符。
 * 🔴 顺序钉死：**先剥标签、后解实体**。反过来的话 `&lt;span&gt;`（一段被转义、
 *    本该当正文读的文本）会先变成 `<span>`，再被当标签剥掉 —— 凭空吃掉正文。
 */
const 实体表: ReadonlyArray<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;/g, "'"],
  [/&radic;/gi, "√"],
  [/&#183;/g, "·"],
  // 🔴 &amp; 必须最后：先解它的话 `&amp;lt;` 会变成 `&lt;` 再被解成 `<`（二次解码）
  [/&amp;/gi, "&"],
];

/**
 * 分词喂料归一：剥 HTML 标签 + 解实体 + 折叠空白。
 *
 * 🔴 **只作用于喂料，不回写正本**。`question.stem` 存的是原文（版面标记是源的一部分，
 *    渲染要用），派生出去的检索投影才做这层归一。
 * 🔴 **不幂等**（见文件头纪律②）：连剥两次会把 `&amp;lt;` 多解一层。
 *    `segSearch` / `segExact` 已经在内部调它，调用方别在外面再剥一遍。
 */
export function stripHtmlForSeg(text: string | null | undefined): string {
  let s = text ?? "";
  s = s.replace(RE_HTML_TAG, " ");
  for (const [re, to] of 实体表) s = s.replace(re, to);
  // 标签变空格后会留下一串连续空白；jieba 不在意，但对账/单测读起来干净些
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 喂料归一 ②：去 LaTeX（🔴 逐字照搬 sidecar/main.py 的 de_latex，口径不许漂）
// ---------------------------------------------------------------------------

/** `\frac` `\times` `\left` 这类命令名 */
const RE_CMD = /\\[A-Za-z]+\s*/g;
/** 数学环境里"值得留下"的东西：中文 + 字母数字串（纯符号一律丢） */
const RE_WORD = /[0-9A-Za-z]+|[一-鿿]+/g;
/** 一个 token 里只要有这类字符就算有意义（否则是纯标点，分词后丢掉） */
const RE_MEANINGFUL = /[0-9A-Za-z一-鿿]/;

/**
 * 数学环境内容 → 语义近似串：命令名剥掉，只留中文与字母数字，空格分开。
 * `$3+5\times 2$` → `3 5 2`；`$\frac{1}{2}$` → `1 2`；`$x^2$` → `x 2`。
 * 留数字不是为了"检索数字"，是为了别把一道题的题面掏成空壳。
 */
function 数学环境保留(inner: string): string {
  return (inner.replace(RE_CMD, " ").match(RE_WORD) ?? []).join(" ");
}

/**
 * 去 LaTeX：数学环境替成语义近似串，裸命令清掉，空白归一。
 *
 * 🔴 顺序要紧：`$$..$$` 必须先于 `$..$`，否则会被后者从中间切开。
 * 🔴 这是 `sidecar/main.py::de_latex` 的 1:1 移植 —— 两边口径必须一个字都不差，
 *    否则「新旧分词对照」就成了在比两件不同的事。
 */
export function deLatex(text: string | null | undefined): string {
  const rep = (_m: string, inner: string): string =>
    " " + 数学环境保留(inner) + " ";
  let s = text ?? "";
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, rep);
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, rep);
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, rep);
  s = s.replace(/\$([\s\S]+?)\$/g, rep);
  // 没包在数学环境里的裸命令（\alpha 之类）一并清掉
  s = s.replace(RE_CMD, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** 完整喂料归一 = 剥 HTML → 去 LaTeX。分词前唯一的预处理，只在本文件内调用一次。 */
export function segFeed(text: string | null | undefined): string {
  return deLatex(stripHtmlForSeg(text));
}

// ---------------------------------------------------------------------------
// 自定义词典
// ---------------------------------------------------------------------------

/** 词典文件相对仓根的位置（人可读、进 git、带出处注释） */
export const DICT_REL_PATH = "dicts/math-terms.dict.txt";

function 仓根候选(): string[] {
  const out: string[] = [];
  try {
    // <仓根>/src/core/segment.ts → 往上三级
    out.push(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    );
  } catch {
    // bundler 环境下 import.meta.url 可能不是 file: URL —— 不算错，退到 cwd
  }
  out.push(process.cwd());
  return out;
}

/** 词典文件的绝对路径；找不到就抛（🔴 不静默降级成"没词典也能跑"） */
export function dictPath(): string {
  for (const root of 仓根候选()) {
    const p = join(root, DICT_REL_PATH);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `找不到数学专名词典 ${DICT_REL_PATH}（找过：${仓根候选()
      .map((r) => join(r, DICT_REL_PATH))
      .join(" / ")}）。仓库是不是没拉全？\n` +
      "🔴 这里刻意不静默跳过：没词典照跑 = 索引与查询用的是另一套切法，" +
      "而库里存量是带词典切的，两边对不上又不报错。",
  );
}

export interface DictInfo {
  /** 词典文件绝对路径 */
  path: string;
  /** 有效词条数（注释行/空行不算） */
  words: number;
  /** 前几条，给体检页/报告打样用 */
  sample: string[];
}

/**
 * 读词典文件 → 剥注释 → 返回可直接喂 jieba 的纯净文本。
 * 🔴 jieba-rs 的 `load_dict` 逐行 split 空白解析 `词 词频 词性`，
 *    注释行会被当成词条解析（词频那一栏是中文，直接炸），所以必须先剥干净。
 */
function 读词典(): { body: string; words: string[]; path: string } {
  const path = dictPath();
  const words: string[] = [];
  const lines: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    lines.push(line);
    words.push(line.split(/\s+/)[0]!);
  }
  return { body: lines.join("\n") + "\n", words, path };
}

// ---------------------------------------------------------------------------
// 分词器单例（进程内常驻；载一次词典管到进程结束）
// ---------------------------------------------------------------------------

interface 分词器组 {
  /** 基础词典 + 自定义词典 */
  custom: Jieba;
  /** 只有基础词典 —— 并集的另一半，也是"新旧口径对照"的参照 */
  base: Jieba;
  info: DictInfo;
}

let 单例: 分词器组 | null = null;

/**
 * 载词典、建分词器（幂等：重复调用直接返回已建好的）。
 *
 * 平时不用手动调 —— `segSearch` / `segExact` 会自己触发。
 * 显式调用的场景：启动预热（把 ~200ms 的载词典挪到第一次查询之前）、
 * 体检页要报「词典载了多少条」、单测要断言词典生效。
 */
export function loadDict(): DictInfo {
  if (单例) return 单例.info;
  const { body, words, path } = 读词典();
  const custom = Jieba.withDict(基础词典);
  custom.loadDict(Buffer.from(body, "utf8"));
  const base = Jieba.withDict(基础词典);
  const info: DictInfo = {
    path,
    words: words.length,
    sample: words.slice(0, 8),
  };
  单例 = { custom, base, info };
  return info;
}

/** 丢掉单例（改了词典文件想在同一进程里重载时用；单测也用它验重载） */
export function resetDict(): void {
  单例 = null;
}

/** 词典现状（会触发加载）；给体检 / 报告 / 单测用 */
export function dictInfo(): DictInfo {
  return loadDict();
}

function 取分词器(): 分词器组 {
  loadDict();
  return 单例!;
}

// ---------------------------------------------------------------------------
// 两个模式
// ---------------------------------------------------------------------------

/** token 清洗：去空白、丢纯标点、按出现顺序去重 */
function 清洗(
  tokens: readonly string[],
  into: string[],
  seen: Set<string>,
): void {
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t || !RE_MEANINGFUL.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    into.push(t);
  }
}

/**
 * 🔴 **写侧**分词（搜索引擎模式 + 双词典并集，见文件头 §双词典并集）。
 *
 * 进门先做完整喂料归一（剥 HTML → 去 LaTeX），调用方传**原文**即可。
 *
 * ```ts
 * segSearch("解一元一次方程 $2x+1=7$")
 * // ['解','一元','一次','次方','方程','一元一次方程','2','x','1','7','一次方程']
 * //                                    ↑自定义词典给的      基础词典那一半补的↑
 * ```
 */
export function segSearch(text: string | null | undefined): string[] {
  const feed = segFeed(text);
  if (!feed) return [];
  const { custom, base } = 取分词器();
  const out: string[] = [];
  const seen = new Set<string>();
  // 自定义那一路在前（读起来更像人话），基础那一路只补差集
  清洗(custom.cutForSearch(feed, true), out, seen);
  清洗(base.cutForSearch(feed, true), out, seen);
  return out;
}

/**
 * 🔴 **查侧**分词（精确模式，只用自定义词典）。
 *
 * 不并集：exact ⊆ search 恒成立（`cut_for_search` 的输出必含 `cut` 的全部词），
 * 而写侧的并集里已经含了自定义词典那一路的 `cut` 结果 ——
 * 所以查侧切出来的每个 token 都保证在索引里。
 */
export function segExact(text: string | null | undefined): string[] {
  const feed = segFeed(text);
  if (!feed) return [];
  const { custom } = 取分词器();
  const out: string[] = [];
  清洗(custom.cut(feed, true), out, new Set<string>());
  return out;
}

/** 写侧要落库的那个「空格串」（= question.stem_plain / question_fts 的列值） */
export function segSearchString(text: string | null | undefined): string {
  return segSearch(text).join(" ");
}

/**
 * 🔴 **只给"新旧口径对照"用**：只走基础词典的搜索模式 = 加自定义词典之前的老口径
 * （也就是 Python 侧车 `mode:'search'` 的等价物）。
 * 业务路径一律别调它 —— 调了就等于绕开词典。
 */
export function segSearchBaseOnly(text: string | null | undefined): string[] {
  const feed = segFeed(text);
  if (!feed) return [];
  const out: string[] = [];
  清洗(取分词器().base.cutForSearch(feed, true), out, new Set<string>());
  return out;
}
