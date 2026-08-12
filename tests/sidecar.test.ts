/**
 * Python 侧车闸（AI:PRD-003 · 003-B / 003-E）
 *
 * 测试在精不在多，只钉六件必须永远成立的事：
 *   ① segment：LaTeX 符号一个都不许进词串，中文真的被切开（不然 unicode61 白搭）；
 *   ② calc_verify 三态各一例 —— 尤其 **cannot_verify 是如实报**，
 *      应用题绝不许被"看着像对的"判成 verified；
 *   ③ mismatch 要给得出实算值（人拿着它就能直接判是答案错还是题面录错）；
 *   ④ 环境没装 = CONFIG_MISSING + 一句能照着修的人话，不是一坨 ENOENT；
 *   ⑤ line_verify 一红一绿：中间行断了必须报出**是哪一行、算成了多少**；
 *   ⑥ line_verify 判不了的**如实说判不了**（含未知量的变形链）——
 *      这道闸是红灯闸，宁可漏判也不能假红把真题拦下。
 *
 * 🔴 侧车是真起 python 子进程（jieba 载词典 ~0.4s），单例耗时秒级属正常。
 */
import { describe, expect, it } from "vitest";

import {
  SidecarError,
  calcVerify,
  lineVerify,
  pingSidecar,
  segmentTexts,
  sidecarStatus,
} from "~/core";

describe("① segment（去 LaTeX + jieba）", () => {
  it("LaTeX 不进词串，中文被切开，数字留得住", async () => {
    const [r] = await segmentTexts([
      { id: "q1", text: "已知方程 $x^2-5x+6=0$，求它的两个根" },
    ]);
    const toks = (r?.segmented ?? "").split(" ");

    // LaTeX / 数学符号一个都不许留：留了就是拿符号当词去索引
    for (const bad of ["$", "\\", "^", "=", "frac", "times"]) {
      expect(r?.segmented ?? "", `词串里混进了 ${bad}`).not.toContain(bad);
    }
    // 中文真的切开了——这正是 unicode61 自己做不到、非要 jieba 不可的那一步
    expect(toks).toContain("方程");
    expect(toks).toContain("已知");
    // 数学环境里的字母数字留下来（别把题面掏成空壳）
    expect(toks).toContain("x");
    expect(toks).toContain("5x");
  });

  it("🔴 精确模式切不开长词（一元一次方程 里查不到 方程）；search 模式能", async () => {
    // 这不是 bug，是 jieba 精确模式的口径。写在测试里免得日后当故障查：
    // 写侧要不要换 search 模式（长词再切、召回更高）是 003-C 的决定，
    // 查侧固定 exact ⇒ 写 search 只会多命中不会漏。
    const 词 = [{ id: "k", text: "一元一次方程的解法" }];
    const [精确] = await segmentTexts(词);
    const [搜索] = await segmentTexts(词, { mode: "search" });
    expect(精确?.segmented.split(" ")).not.toContain("方程");
    expect(搜索?.segmented.split(" ")).toContain("方程");
  });
});

describe("② calc_verify 三态", () => {
  it("verified / mismatch / cannot_verify 各归各位", async () => {
    const rs = await calcVerify([
      { id: "对", stem: "计算：3+5×2", answer: "13" },
      { id: "错", stem: "计算：3+5×2", answer: "14" },
      {
        id: "应用题",
        stem: "小明有 12 个苹果，平均分给 3 个同学，每人分得几个？",
        answer: "4",
      },
    ]);
    const by = new Map(rs.map((r) => [r.id, r]));

    expect(by.get("对")?.verdict).toBe("verified");

    // mismatch 必须带实算值：只说"不对"等于把活又推回给人
    expect(by.get("错")?.verdict).toBe("mismatch");
    expect(by.get("错")?.detail.computed).toBe("13");
    expect(by.get("错")?.detail.expected).toBe("14");

    // 🔴 应用题算不了就报算不了。它的答案 4 其实是对的——
    //    但侧车没有"建模"能力，猜对了也是猜，一律 cannot_verify。
    expect(by.get("应用题")?.verdict).toBe("cannot_verify");
    expect(by.get("应用题")?.detail.reason).toContain("中文");
  });
});

describe("③ line_verify 逐行恒等", () => {
  it("🔴 一红：中间行断了 —— 报得出是哪一行、算成了多少（答案对也照拦）", async () => {
    // 2026-07-30 有理数打卡第二天第 9 题事故复刻：去括号漏变号（-8+3-54=-59），
    // 最后一行又锚回正确答案 49 —— calc_verify 对这种错完全免疫。
    const [r] = await lineVerify([
      {
        id: "事故",
        analysis: "原式 = -8-(-3+9÷(-1/6))\n= -8-(-3-54)\n= -8+3-54\n= 49",
      },
    ]);
    expect(r?.verdict).toBe("line_mismatch");
    expect(r?.badLines).toHaveLength(1);
    expect(r?.badLines[0]!.line).toBe(3);
    expect(r?.badLines[0]!.right).toBe("-8+3-54");
    expect(r?.badLines[0]!.computed).toBe("-59");
    expect(r?.badLines[0]!.expected).toBe("49");
  });

  it("一绿：正确的链全等；多小问各算各的链，不互相比", async () => {
    const rs = await lineVerify([
      { id: "对", analysis: "原式 = -13-16+7+18\n= -29+25\n= -4" },
      // 🔴 两条链值不同（5 与 12），但它们是两个小问 —— 不该被判成断裂。
      //    「不以等号开头的行另起一条链」就是为这个存在的。
      { id: "多小问", analysis: "（1）原式 = 2+3\n= 5\n（2）原式 = 4×3\n= 12" },
      { id: "链形态", lines: ["3+5*2", "6+7", "13"] },
    ]);
    const by = new Map(rs.map((r) => [r.id, r]));
    expect(by.get("对")?.verdict).toBe("all_identical");
    expect(by.get("多小问")?.verdict).toBe("all_identical");
    expect(by.get("多小问")?.chains).toBe(2); // 两个小问 = 两条链
    expect(by.get("链形态")?.verdict).toBe("all_identical");
    expect(by.get("链形态")?.checked).toBe(2);
  });

  it("🔴 判不了就说判不了：含未知量的变形链、判断句，一律 no_checkable_lines", async () => {
    const rs = await lineVerify([
      // 解方程的变形链：判它要比**解集**，拿恒等去判 x=1 会当场假红
      { id: "解方程", analysis: "4-3x=6-5x\n2x=2\nx=1" },
      // 字母化简
      { id: "化简", analysis: "原式 = (a+c)-(-b-c)+(a-b) = 2a+2c" },
      // 判断句不是恒等链
      {
        id: "判断句",
        analysis: "3^3 = 27，4^3 = 64，27 < 50 < 64\n所以十位是 3",
      },
      { id: "纯文字", analysis: "先定号，再逐项去壳。" },
    ]);
    for (const r of rs) {
      expect(r.verdict, `${r.id} 不该给出结论`).toBe("no_checkable_lines");
      expect(r.checked).toBe(0);
    }
  });
});

describe("④ 环境", () => {
  it("装好了：ping 报得出 jieba / sympy 版本", async () => {
    const p = await pingSidecar();
    expect(p.versions.jieba).toMatch(/^\d+\./);
    expect(p.versions.sympy).toMatch(/^\d+\./);
    expect(sidecarStatus().ok).toBe(true);
  });

  it("🔴 没装：CONFIG_MISSING + 照着能修的人话（不是一坨 ENOENT）", async () => {
    const 假路径 = "D:/根本不存在的目录/python.exe";
    await expect(
      segmentTexts([{ id: "x", text: "试试" }], { python: 假路径 }),
    ).rejects.toThrow(SidecarError);

    const 抓到: unknown = await segmentTexts([{ id: "x", text: "试试" }], {
      python: 假路径,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(抓到).toBeInstanceOf(SidecarError);
    const e = 抓到 as SidecarError;
    expect(e.code).toBe("CONFIG_MISSING");
    expect(e.message).toContain("sidecar/README.md"); // 修法指到文档
    expect(e.message).toContain("pip install -r requirements.txt"); // 和具体命令

    const st = sidecarStatus({ python: 假路径 });
    expect(st.ok).toBe(false);
    expect(st.reason).toContain("没装");
  });
});
