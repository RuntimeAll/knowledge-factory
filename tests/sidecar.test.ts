/**
 * Python 侧车闸（AI:PRD-003 · 003-B）
 *
 * 测试在精不在多，只钉四件必须永远成立的事：
 *   ① segment：LaTeX 符号一个都不许进词串，中文真的被切开（不然 unicode61 白搭）；
 *   ② calc_verify 三态各一例 —— 尤其 **cannot_verify 是如实报**，
 *      应用题绝不许被"看着像对的"判成 verified；
 *   ③ mismatch 要给得出实算值（人拿着它就能直接判是答案错还是题面录错）；
 *   ④ 环境没装 = CONFIG_MISSING + 一句能照着修的人话，不是一坨 ENOENT。
 *
 * 🔴 侧车是真起 python 子进程（jieba 载词典 ~0.4s），单例耗时秒级属正常。
 */
import { describe, expect, it } from "vitest";

import {
  SidecarError,
  calcVerify,
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

describe("③ 环境", () => {
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
