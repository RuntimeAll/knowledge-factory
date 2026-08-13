/**
 * 分词统一层闸（AI:PRD-004 · 004-A · core/segment.ts）
 *
 * 只钉五件必须永远成立的事 —— 每一件对应一类**只会静默发生**的故障：
 *   ① 自定义词典真的生效（不生效 = 查「三角形」查不到等腰三角形的题，没人会发现）；
 *   ② 🔴 双词典并集：`segSearch ⊇ segSearchBaseOnly`
 *      —— 这条是"加词典永远不会让召回变低"的**全部**保障，塌了整个设计就塌了；
 *   ③ 写查方向：`segExact ⊆ segSearch`（反了就是查询 token 不在索引里，静默漏召回）；
 *   ④ 剥 HTML 的严格形状（承 003-E4）：吃标签、不吃数学不等号、先剥后解实体；
 *   ⑤ 去 LaTeX 与 Python 侧车 `de_latex` 同口径（两边漂了，"新旧对照"就成了比两件事）。
 */
import { describe, expect, it } from "vitest";

import {
  deLatex,
  dictInfo,
  segExact,
  segSearch,
  segSearchBaseOnly,
  stripHtmlForSeg,
} from "~/core";

/** 真语料形态：HTML 填空线 + 裸不等号 + LaTeX + 数学专名，一段吃三种坑 */
const 真语料 = [
  "已知一元一次方程 $2x+1=7$，求 x 的值。",
  '在等腰三角形中，底角为 <span style="display:inline-block;border-bottom:1px solid #000"></span> 度。',
  "有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|，用科学记数法表示。",
  "合并同类项后去括号，再用加减消元法解二元一次方程组。",
  "把 $\\frac{1}{2}$ 化简求值，注意算术平方根与立方根的区别。",
] as const;

describe("① 自定义词典生效", () => {
  it("词典载得到，且每个词条在精确模式下都是一个整词", () => {
    const info = dictInfo();
    expect(info.words).toBeGreaterThanOrEqual(80);
    expect(info.path).toMatch(/math-terms\.dict\.txt$/);

    // 抽几个「通用词典会切碎、加了词典才整」的代表
    expect(segExact("等腰三角形的性质")).toEqual(["等腰三角形", "的", "性质"]);
    expect(segExact("用科学记数法表示")).toContain("科学记数法");
    expect(segExact("有序数对")).toEqual(["有序数对"]);
    expect(segExact("加减消元法")).toEqual(["加减消元法"]);
  });

  it("🔴 词典的真实收益：查「三角形」查得到等腰三角形的题", () => {
    // 基础词典把「等腰三角形」切成 等腰三角/形 —— 索引里压根没有「三角形」
    expect(segSearchBaseOnly("等腰三角形的性质")).not.toContain("三角形");
    // 加了词典（并集）之后，「三角形」作为 3-gram 子词进了索引
    expect(segSearch("等腰三角形的性质")).toContain("三角形");
  });
});

describe("② 🔴 双词典并集：加词典只增不减（本设计的命根子）", () => {
  it.each(真语料)("segSearch ⊇ segSearchBaseOnly：%s", (text) => {
    const 新 = new Set(segSearch(text));
    const 旧 = segSearchBaseOnly(text);
    const 丢 = 旧.filter((t) => !新.has(t));
    // 🔴 判据是"一个都不许丢"。丢了就意味着：某个原本查得到的词，加完词典查不到了。
    expect(丢).toEqual([]);
  });
});

describe("③ 写查方向：exact ⊆ search（反了就是静默漏召回）", () => {
  it.each(真语料)("segExact ⊆ segSearch：%s", (text) => {
    const 索引 = new Set(segSearch(text));
    for (const t of segExact(text)) expect(索引.has(t)).toBe(true);
  });
});

describe("④ 剥 HTML：吃标签，但一个数学不等号都不许吃（承 003-E4）", () => {
  it("样式串整段剥掉，正文一个字不少", () => {
    const 剥 = stripHtmlForSeg(
      '底角为 <span style="display:inline-block;border-bottom:1px solid #000"></span> 度',
    );
    expect(剥).toBe("底角为 度");
    for (const 脏 of ["span", "style", "border", "solid", "1px"]) {
      expect(剥).not.toContain(脏);
    }
  });

  it("🔴 裸不等号原样保留（`<[^>]*>` 通杀会把整段吃掉）", () => {
    for (const 题面 of [
      "有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|。",
      "（用 < 或 > 或 = 号填空）",
      "1 000 < 50 653 < 1 000 000",
    ]) {
      expect(stripHtmlForSeg(题面)).toBe(题面);
    }
  });

  it("先剥标签、后解实体：被转义的 <span> 是正文，不许当标签剥掉", () => {
    expect(stripHtmlForSeg("a &lt; 0 且 b &gt; 0")).toBe("a < 0 且 b > 0");
    expect(stripHtmlForSeg("正文里写着 &lt;span&gt; 这个词")).toBe(
      "正文里写着 <span> 这个词",
    );
    // &amp; 最后解：`&amp;lt;` 只该解一层，变成 `&lt;` 而不是 `<`
    expect(stripHtmlForSeg("甲 &amp;lt; 乙")).toBe("甲 &lt; 乙");
  });
});

describe("⑤ 去 LaTeX：与 sidecar/main.py 的 de_latex 同口径", () => {
  it("数学环境 → 语义近似串；裸命令清掉", () => {
    expect(deLatex("$3+5\\times 2$")).toBe("3 5 2");
    expect(deLatex("$\\frac{1}{2}$")).toBe("1 2");
    expect(deLatex("$x^2$")).toBe("x 2");
    // $$..$$ 必须先于 $..$ 匹配，否则会被从中间切开
    expect(deLatex("前 $$a+b$$ 后")).toBe("前 a b 后");
    expect(deLatex("裸命令 \\alpha 清掉")).toBe("裸命令 清掉");
  });

  it("空串 / 纯标点切不出 token（调用方据此判断「别去 MATCH」）", () => {
    expect(segExact("")).toEqual([]);
    expect(segExact("，。！")).toEqual([]);
    expect(segSearch("   ")).toEqual([]);
  });
});
