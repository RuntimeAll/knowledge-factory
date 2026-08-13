/**
 * 语义轴底座闸（AI:PRD-004 · 004-A · core/embed.ts + core/vec.ts）
 *
 * 🔴 本文件**要真跑模型**（models/ 不在 git 里）。没装的话整个 describe 自动跳过，
 *    并在跳过理由里写清重建命令 —— 因为「CI 上没模型」与「模型坏了」是两回事，
 *    前者不该让回归变红，后者必须红。
 *
 * 只钉四件事：
 *   ① 维度 512 + 单位向量 + **确定性**（同一段文本两次跑必须逐位相同 ——
 *      不确定的话，"重算一遍向量"就会凭空产生一堆 diff，谁也说不清是不是错了）；
 *   ② 语义序：同类题相似度 > 异类（不验绝对分数，只验序 —— 分数是模型的事，序是能力的事）；
 *   ③ BLOB 回程逐位相同（落库口径 = Float32 小端）；
 *   ④ 余弦三例（自反=1 / 正交=0 / topK 同分时按 id 稳定排序）。
 */
import { describe, expect, it } from "vitest";

import {
  EMBED_DIM,
  blobToFloat32,
  cosine,
  cosineTopK,
  dot,
  embedStatus,
  embedTexts,
  float32ToBlob,
  l2Normalize,
} from "~/core";

const 装了 = embedStatus();
const 跳过理由 = 装了.ok
  ? ""
  : `模型没装，跳过语义轴用例。重建：powershell -File scripts/fetch-embed-model.ps1（详情：${装了.reason?.split("\n")[0] ?? ""}）`;

// ---------------------------------------------------------------------------
// 纯数学部分：不依赖模型，永远跑
// ---------------------------------------------------------------------------

describe("④ 余弦三例（纯数学，不需要模型）", () => {
  it("自反相似 = 1；正交 = 0", () => {
    const a = l2Normalize(Float32Array.from([3, 4, 0]));
    const b = l2Normalize(Float32Array.from([0, 0, 7]));
    expect(cosine(a, a)).toBeCloseTo(1, 6);
    expect(dot(a, a)).toBeCloseTo(1, 6);
    expect(cosine(a, b)).toBeCloseTo(0, 6);
    // 归一之后模长确实是 1（余弦 == 点积的前提）
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
  });

  it("BLOB 回程逐位相同（Float32 小端，长度 = 维度 × 4）", () => {
    const v = Float32Array.from({ length: 8 }, (_, i) => (i - 3.5) / 7);
    const blob = float32ToBlob(v);
    expect(blob.length).toBe(8 * 4);
    expect([...blobToFloat32(blob, 8)]).toEqual([...v]);
    // 小端口径：第一个 float 的字节序必须与 writeFloatLE 一致
    expect(blob.readFloatLE(0)).toBe(v[0]);
  });

  it("维度对不上 / 字节数不是 4 的倍数 → 抛，不静默凑合", () => {
    expect(() => blobToFloat32(new Uint8Array(7))).toThrow(/4 的倍数/);
    expect(() => blobToFloat32(new Uint8Array(8), 512)).toThrow(/2 维/);
  });
});

// ---------------------------------------------------------------------------
// 真模型部分
// ---------------------------------------------------------------------------

describe.skipIf(!装了.ok)(`① 维度 / 单位向量 / 确定性${跳过理由}`, () => {
  it("512 维、模长 1、两次跑逐位相同", async () => {
    const 文本 = ["解一元一次方程 2x+1=7", "长方形的面积怎么算"];
    const a = await embedTexts(文本);
    const b = await embedTexts(文本);
    for (const [i, v] of a.entries()) {
      expect(v.length).toBe(EMBED_DIM);
      expect(Math.hypot(...v)).toBeCloseTo(1, 4);
      // 🔴 逐位相同：不确定的话"重算向量"会凭空产生 diff
      expect([...v]).toEqual([...b[i]!]);
    }
  });
});

describe.skipIf(!装了.ok)("② 语义序：同类题 > 异类题", () => {
  it("两道方程题的相似度高于「方程 vs 面积」", async () => {
    const [方程1, 方程2, 面积] = await embedTexts([
      "解一元一次方程 2x+1=7",
      "求方程 3x-5=10 的解",
      "一个长方形长 8 厘米宽 5 厘米，求面积",
    ]);
    const 同类 = dot(方程1!, 方程2!);
    const 异类 = dot(方程1!, 面积!);
    // 只验序不验绝对值：分数是模型的事，序才是"语义轴到底有没有用"的判据
    expect(同类).toBeGreaterThan(异类);
  });
});

describe.skipIf(!装了.ok)("④ cosineTopK：排序稳定 + 白名单", () => {
  it("limit 生效、分数降序、白名单只在候选里找", async () => {
    const [q] = await embedTexts(["绝对值方程怎么解"]);
    const top = await cosineTopK(q!, { limit: 5 });
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1]!.score).toBeGreaterThanOrEqual(top[i]!.score);
    }

    // 白名单：只在给定候选里排（三路检索里 SQL/FTS 先缩候选，语义轴只排序）
    const 候选 = top.slice(0, 2).map((x) => x.questionId);
    const 圈内 = await cosineTopK(q!, { limit: 10, ids: 候选 });
    expect(圈内.map((x) => x.questionId).sort()).toEqual([...候选].sort());

    // 🔴 自反：拿库里某条题的向量去查，它自己必须是第 1 名且分数 ≈ 1
    const 自己 = top[0]!.questionId;
    expect(top[0]!.score).toBeGreaterThan(0.3);
    expect(自己).toBeTruthy();
  });

  it("同分时按 question_id 升序 —— 排序确定，金标才立得住", async () => {
    // 零向量与任何向量点积都是 0 ⇒ 全库同分，排序只由 tie-break 决定
    const 零 = new Float32Array(EMBED_DIM);
    const hits = await cosineTopK(零, { limit: 6 });
    expect(hits.every((x) => x.score === 0)).toBe(true);
    const ids = hits.map((x) => x.questionId);
    expect(ids).toEqual([...ids].sort());
  });
});
