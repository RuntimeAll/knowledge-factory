/**
 * 题库检索页的纯函数（AI:PRD-004 · 004-C · src/app/search/shared.ts）
 *
 * 🔴 只测**说错了会静默出错**的那几件，不测渲染：
 *   ① `f=1` 那条约定：首屏与「提交了但没勾」必须区分得开（勾错了 = 悄悄只查主考点）；
 *   ② URL ↔ 表单往返一致（chip 的 × 、候选的「选它」全靠它拼 URL，拼错就丢条件）；
 *   ③ hasCondition 决定要不要落 metric_event（判宽了 = 给 004-D 的评测集掺水）；
 *   ④ 来源徽章：三条召回轴各自的标法 + 双轴两枚不合并。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_LIMIT,
  hasCondition,
  parseForm,
  searchUrl,
  showRrf,
  sourceBadges,
  toParams,
} from "~/app/search/shared";

/** 一条 /search?… 的 query string → Next 给页面的那种 searchParams 形状 */
function sp(qs: string): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

describe("① 首屏 vs 提交过：checkbox 没勾就不提交，靠 f=1 区分", () => {
  it("首屏（一个参数都没有）⇒ 含次考点默认勾上（primaryOnly=false）", () => {
    const f = parseForm(sp(""));
    expect(f.submitted).toBe(false);
    expect(f.includeSub).toBe(true);
    expect(f.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(f.kpIds).toEqual([]);
  });

  it("🔴 提交过但没勾 ⇒ includeSub=false（只认主考点）—— 没有 f 就分不出这两种", () => {
    expect(parseForm(sp("f=1&kw=最小值")).includeSub).toBe(false);
    expect(parseForm(sp("f=1&kw=最小值&sub=1")).includeSub).toBe(true);
  });

  it("认不出来的值一律回默认，不抛（地址栏是人能手改的地方）", () => {
    const f = parseForm(sp("f=1&limit=999&sg=乱写的"));
    expect(f.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(f.grade).toBe("");
  });
});

describe("② URL ↔ 表单往返：拼错一次就丢条件", () => {
  it("多选用重复键，往返后一字不差（顺序也不变）", () => {
    const qs =
      "f=1&kp=kp_A&kp=kp_B&kpq=绝对值&kw=化简&sem=分类讨论&qt=填空&qt=选择&sg=calc&sub=1&limit=50";
    const f = parseForm(sp(qs));
    expect(f.kpIds).toEqual(["kp_A", "kp_B"]);
    expect(f.qtypes).toEqual(["填空", "选择"]);
    expect(f.grade).toBe("calc");
    expect(f.limit).toBe(50);

    // 再编回去 → 再解一次，两次得到同一个状态
    expect(parseForm(sp(toParams(f).toString()))).toEqual(f);
  });

  it("空值不写进 URL（地址栏别被一串 &kw=&sem= 塞满）", () => {
    const s = toParams(parseForm(sp("f=1&kp=kp_A")));
    expect(s.toString()).toBe("f=1&kp=kp_A");
    expect(s.has("kw")).toBe(false);
    expect(s.has("limit")).toBe(false); // 默认值不写
  });

  it("searchUrl 打补丁：去掉一个 chip / 选中一个候选", () => {
    const f = parseForm(sp("f=1&kp=kp_A&kp=kp_B&kpq=绝对值"));
    // chip 的 ×
    expect(searchUrl(f, { kpIds: ["kp_A"] })).toBe(
      "/search?f=1&kp=kp_A&kpq=%E7%BB%9D%E5%AF%B9%E5%80%BC",
    );
    // 候选的「选它」：加进来，同时清掉搜索框
    expect(searchUrl(f, { kpIds: [...f.kpIds, "kp_C"], kpq: "" })).toBe(
      "/search?f=1&kp=kp_A&kp=kp_B&kp=kp_C",
    );
  });
});

describe("③ hasCondition：决定这次要不要落 metric_event", () => {
  it("🔴 首屏空表单不算「查了点什么」—— 落进去就是给 004-D 的评测集掺水", () => {
    expect(hasCondition(parseForm(sp("")))).toBe(false);
    expect(hasCondition(parseForm(sp("f=1")))).toBe(false);
    // 只调「怎么看」不算条件
    expect(hasCondition(parseForm(sp("f=1&sub=1&limit=50")))).toBe(false);
  });

  it("任一条件在就算，包括 similar 模式", () => {
    for (const qs of [
      "f=1&kw=化简",
      "f=1&sem=分类讨论",
      "f=1&kp=kp_A",
      "f=1&qt=填空",
      "f=1&sg=calc",
      "similar=q_01KZV",
    ]) {
      expect(hasCondition(parseForm(sp(qs))), qs).toBe(true);
    }
  });
});

describe("④ 来源徽章：人一眼看出「为什么它在这儿」", () => {
  it("三条召回轴各自的标法", () => {
    expect(sourceBadges({ fts: { rank: 1, score: -2.4 } })[0]!.label).toBe(
      "FTS #1",
    );
    expect(sourceBadges({ vector: { rank: 3, score: 0.94 } })[0]!.label).toBe(
      "语意 0.94",
    );
    expect(sourceBadges({ kp: { rank: 2, kpIds: ["kp_A"] } })[0]!.label).toBe(
      "考点 #2",
    );
    expect(sourceBadges({ sqlOnly: true })[0]).toMatchObject({
      label: "仅条件",
      tone: "n", // 🔴 中性灰：它没有相关性可言，跟"排第 1"用同一种绿会误导
    });
  });

  it("🔴 双轴命中就是两枚徽章，不合成一枚（RRF 分说不出是字面中的还是语意中的）", () => {
    const badges = sourceBadges({
      fts: { rank: 2, score: -1.1 },
      vector: { rank: 1, score: 0.88 },
    });
    expect(badges.map((b) => b.label)).toEqual(["FTS #2", "语意 0.88"]);
  });

  it("RRF 分只在多于一条轴时才值得摆出来（单轴时它与名次一一对应）", () => {
    expect(showRrf({ fts: { rank: 1, score: -1 } })).toBe(false);
    expect(showRrf({ sqlOnly: true })).toBe(false);
    expect(
      showRrf({ fts: { rank: 1, score: -1 }, kp: { rank: 1, kpIds: ["k"] } }),
    ).toBe(true);
  });
});
