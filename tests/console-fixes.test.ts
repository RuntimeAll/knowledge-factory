/**
 * AI:PRD-008 验收缺陷修复的三个纯函数（2026-08-14）
 *
 * 🔴 只测**说错了会静默出错**的那几件 —— 这三个当初错了没人发现，都因为没测到：
 *   ① pickLatestBatch：「最近一次」按批次号，不按可空的 exported_at
 *      （旧实现让「批完还没出件」的那一批悄悄显示成上一次的旧卷与旧分数）；
 *   ② sortWindow / parseSort：null 恒排最后 + 字段白名单
 *      （地址栏是人能手改的地方，`?sort=drop table` 要当没给而不是报错）；
 *   ③ parseRegressionSummary：自相矛盾的战报往「更吵」的方向倒
 *      （`ok:true` 但有一关红 ⇒ 判红。/health 上一个假绿比没有更坏）。
 */
import { describe, expect, it } from "vitest";

import { pickLatestBatch } from "~/app/student/shared";
import { parseSort, sortWindow } from "~/lib/sort-window";
import { parseRegressionSummary } from "~/core";

describe("① pickLatestBatch：最近一次 = 批次号最大的那条", () => {
  it("🔴 没出件（exportedAt=null）的新批次照样是最近的 —— 旧实现在这儿取到了上一批", () => {
    const rows = [
      { batchId: 27, exportedAt: "2026-08-13T09:00:00+08:00" },
      { batchId: 28, exportedAt: null }, // 批完了还没出件
    ];
    expect(pickLatestBatch(rows)?.batchId).toBe(28);
  });

  it("与 /student/[code] 批次表同一把尺子：批次号倒序，与出件时间的先后无关", () => {
    const rows = [
      { batchId: 21, exportedAt: "2026-08-14T23:00:00+08:00" }, // 时间最晚、批次最早
      { batchId: 24, exportedAt: "2026-08-10T01:00:00+08:00" },
    ];
    expect(pickLatestBatch(rows)?.batchId).toBe(24);
  });

  it("空名册返回 null（不是抛，也不是造一条空行）", () => {
    expect(pickLatestBatch([])).toBeNull();
  });

  it("不改调用方的数组（route 里那份 v.batches 还要按原序用）", () => {
    const rows = [{ batchId: 1 }, { batchId: 9 }, { batchId: 5 }];
    pickLatestBatch(rows);
    expect(rows.map((r) => r.batchId)).toEqual([1, 9, 5]);
  });
});

describe("② sortWindow / parseSort：窗口内排序的两条纪律", () => {
  it("🔴 null 恒排最后 —— 升序降序都是（`—` 挤在最前会让人以为这列坏了）", () => {
    const asc = [{ v: 3 }, { v: null }, { v: 1 }];
    sortWindow(asc, (r) => r.v, false);
    expect(asc.map((r) => r.v)).toEqual([1, 3, null]);

    const desc = [{ v: 3 }, { v: null }, { v: 1 }];
    sortWindow(desc, (r) => r.v, true);
    expect(desc.map((r) => r.v)).toEqual([3, 1, null]);
  });

  it("🔴 数字按数值排，不按字符串排（否则 10 会跑到 2 前面）", () => {
    const rows = [{ n: 2 }, { n: 10 }, { n: 1 }];
    sortWindow(rows, (r) => r.n, false);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 10]);
  });

  it("parseSort：字段走白名单，地址栏手改的怪值当没给（不报错）", () => {
    const allow = ["name", "bytes"] as const;
    expect(parseSort(new URLSearchParams("sort=bytes"), allow)).toEqual({
      field: "bytes",
      desc: true, // 默认降序：点一下多半想看最大的/最新的那一头
    });
    expect(
      parseSort(new URLSearchParams("sort=bytes&order=asc"), allow),
    ).toEqual({ field: "bytes", desc: false });
    expect(
      parseSort(new URLSearchParams("sort=drop%20table"), allow),
    ).toBeNull();
    expect(parseSort(new URLSearchParams(""), allow)).toBeNull();
  });
});

describe("③ parseRegressionSummary：/health 上一个假绿比没有更坏", () => {
  const 一关 = (id: string, ok: boolean) => ({
    id,
    name: `${id} 关`,
    ok,
    secs: 1,
    reason: ok ? null : "红了",
  });

  it("正常战报照实解析", () => {
    const s = parseRegressionSummary(
      7,
      "2026-08-14T20:00:00+08:00",
      JSON.stringify({
        ok: true,
        total: 2,
        passed: 2,
        failed: 0,
        secs: 12.5,
        gates: [一关("REG-A1", true), 一关("REG-A2", true)],
      }),
    );
    expect(s).toMatchObject({ metricId: 7, ok: true, passed: 2, failed: 0 });
    expect(s?.gates.map((g) => g.id)).toEqual(["REG-A1", "REG-A2"]);
  });

  it("🔴 自相矛盾（写着 ok=true 却有一关红）⇒ 判红，不认那个 ok", () => {
    const s = parseRegressionSummary(
      8,
      null,
      JSON.stringify({
        ok: true,
        failed: 0,
        gates: [一关("REG-A1", true), 一关("REG-B", false)],
      }),
    );
    expect(s?.ok).toBe(false);
    expect(s?.failed).toBe(1);
    expect(s?.passed).toBe(1);
  });

  it("🔴 -Only 单关跑标出来 —— 「1/1 关绿」不是「11 关全绿」", () => {
    const s = parseRegressionSummary(
      9,
      null,
      JSON.stringify({ ok: true, only: "A3b", gates: [一关("REG-A3b", true)] }),
    );
    expect(s?.only).toBe("A3b");
    expect(s?.total).toBe(1);
  });

  it("脏行/空行当作「这条没有」（与对账摘要同口径，不抛）", () => {
    expect(parseRegressionSummary(1, null, null)).toBeNull();
    expect(parseRegressionSummary(1, null, "{ 不是 JSON")).toBeNull();
    expect(parseRegressionSummary(1, null, "[]")).toBeNull();
  });
});
