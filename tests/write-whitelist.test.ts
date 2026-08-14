/**
 * 🔴🔴 写操作白名单的**反证闸**（AI:PRD-009 验收修复 · 2026-08-15）
 *
 * ── 它拦的是什么 ────────────────────────────────────────────────────────────
 *   验收判红：白名单说「就六类，其余全只读」，代码里却挂着 4 个白名单外的写端点
 *   （KG 版本树状态切换 / 别名增删 / 考点退役）—— 而且**没有任何东西会发现这件事**：
 *   白名单只是设计稿里的一句话，谁再加一个 `"use server"` 的 action 都不会有人知道。
 *
 *   本闸把「白名单」变成一份**对得上代码**的台账（`src/app/write-ops.ts`）：
 *     ① 源码里扫得到的写入口，台账里必须有 → 新加写口子必须先登记；
 *     ② 台账里有的，源码里必须还在      → 下线了必须销账；
 *     ③ 每条都得声明二次确认形态          → 「全部写操作都要二次确认」有了机器判据。
 *
 * 🔴 扫源码而不是 import：`"use server"` 文件在 vitest 里 import 会被 Next 的
 *    server-action 转换卡住（那是构建期的事），而且这里要验的本来就是**文本事实**
 *    ——「仓里到底有几个写入口」，读文件是最直接、最不会被绕过的做法。
 * 🔴 本测试**零写、零库**：只读 src 下的文件。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIRM_FORMS,
  SETTLED_WRITE_OP_CLASSES,
  WRITE_OPS,
  WRITE_OP_CLASSES,
} from "~/app/write-ops";

const 仓根 = process.cwd();
const APP = join(仓根, "src", "app");

/** 递归列 src/app 下所有 .ts/.tsx */
function 全部文件(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...全部文件(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 仓相对路径，一律用 `/` 分隔（台账里就是这么写的，Windows 上别漏这一步） */
function 相对(p: string): string {
  return relative(仓根, p).split(sep).join("/");
}

const 文件 = 全部文件(APP);

/** 源码里真实存在的写入口：server action 导出名 + 写路由的 `METHOD 路径` */
function 扫写入口(): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = [];
  for (const p of 文件) {
    const src = readFileSync(p, "utf8");
    const rel = 相对(p);

    // ① server action：文件头有 "use server"，导出的每个 async 函数都是一个写入口
    //    （Next 的硬约束：这种文件只能导出 async 函数）
    if (/^\s*["']use server["'];/m.test(src)) {
      for (const m of src.matchAll(/^export async function (\w+)\s*\(/gm)) {
        out.push({ id: m[1]!, file: rel });
      }
    }

    // ② 写路由：route.ts 里导出的 POST/PUT/PATCH/DELETE
    if (rel.endsWith("/route.ts")) {
      const 路径 = `/${rel.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "")}`;
      for (const m of src.matchAll(
        /^export async function (POST|PUT|PATCH|DELETE)\s*\(/gm,
      )) {
        out.push({ id: `${m[1]!} ${路径}`, file: rel });
      }
    }
  }
  return out;
}

const 实际 = 扫写入口();

describe("🔴 写操作白名单 · 台账与代码逐条对得上", () => {
  it("① 源码里的每一个写入口，台账里都登记过（新加写口子必须先登记）", () => {
    const 记着 = new Set(WRITE_OPS.map((o) => o.id));
    const 漏登记 = 实际.filter((e) => !记着.has(e.id));
    expect(
      漏登记.map((e) => `${e.id}（${e.file}）`),
      "🔴🔴 有写入口没进 src/app/write-ops.ts 的台账。\n" +
        "   这正是本闸存在的理由：白名单只写在设计稿里的话，多一个写端点没人会发现。\n" +
        "   处置：确认它该不该存在 —— 该存在就补进 WRITE_OPS（写清属于哪一类、\n" +
        "   在哪一页、二次确认是什么形态、最终写到哪儿）；不该存在就连页面挂载点一起下线。",
    ).toEqual([]);
  });

  it("② 台账里的每一条，源码里都还在（下线了必须销账）", () => {
    const 有的 = new Set(实际.map((e) => e.id));
    const 已消失 = WRITE_OPS.filter((o) => !有的.has(o.id));
    expect(
      已消失.map((o) => `${o.id}（台账说在 ${o.file}）`),
      "🔴 台账里记着、源码里已经没有了 —— 要么改名了没同步，要么下线了没销账。\n" +
        "   一份对不上代码的白名单比没有白名单更坏：它会让人以为查过了。",
    ).toEqual([]);
  });

  it("③ 台账不重条，且每条的类/形态都在枚举里", () => {
    const ids = WRITE_OPS.map((o) => o.id);
    expect(new Set(ids).size, `台账里有重复 id：${ids.join(", ")}`).toBe(
      ids.length,
    );
    for (const o of WRITE_OPS) {
      expect(
        (WRITE_OP_CLASSES as readonly string[]).includes(o.cls),
        `${o.id} 的类「${o.cls}」不在 WRITE_OP_CLASSES 里`,
      ).toBe(true);
      expect(
        (CONFIRM_FORMS as readonly string[]).includes(o.confirm),
        `${o.id} 的确认形态「${o.confirm}」不在 CONFIRM_FORMS 里`,
      ).toBe(true);
      // 🔴「全部写操作二次确认」：形态字段不许空着糊过去
      expect(o.page.trim(), `${o.id} 没写它长在哪一页`).not.toBe("");
      expect(o.writes.trim(), `${o.id} 没写它最终写到哪儿`).not.toBe("");
    }
  });

  it("④ 六类已拍板的白名单一个都没丢（PRD-008 D2 五类 + PRD-009 D-C 终审）", () => {
    for (const c of SETTLED_WRITE_OP_CLASSES) {
      expect(
        WRITE_OPS.some((o) => o.cls === c),
        `白名单第「${c}」类在台账里一条实现都没有 —— 是被下线了还是改名了？`,
      ).toBe(true);
    }
  });

  it("🔴 ⑤ 圣域红线：终审那一类只准 spawn 审核库.py，不许出现写库句柄", () => {
    // 「终审确认打回」三条的实现文件里，不许出现任何非 ro 的库连接。
    // 这条与 REG-F4 的物理验证是两个层次：那边验「连上去也写不动」，
    // 这边验「代码里压根没有那种连接」。
    const 终审 = WRITE_OPS.filter((o) => o.cls === "终审确认打回");
    expect(终审.length, "终审白名单三条原语少了").toBe(3);
    for (const o of 终审) {
      const src = readFileSync(join(仓根, o.file), "utf8");
      expect(o.writes, `${o.id} 的写口不是 spawn 审核库.py`).toContain(
        "审核库.py",
      );
      // 圣域只准经 CLI 写：路由里不许自己开库
      expect(
        /createClient|DatabaseSync|new\s+Database\b/.test(src),
        `🔴🔴 ${o.file} 里出现了数据库连接构造 —— 终审写只准 spawn 审核库.py CLI`,
      ).toBe(false);
    }
  });
});

describe("🔴 反证：扫描器本身是活的（常绿的闸等于没有闸）", () => {
  it("扫得到的写入口数量与台账一致，且确实扫出了两种形态各若干条", () => {
    // 扫描器要是写坏了（正则不匹配 / 目录走错），①② 会双双变成「空集对空集」的假绿。
    // 所以这里钉住「它到底扫到了东西」，并且两种入口形态都扫到了。
    expect(实际.length, "一个写入口都没扫到 —— 扫描器坏了").toBeGreaterThan(0);
    expect(
      实际.filter((e) => !e.id.includes(" ")).length,
      "一个 server action 都没扫到",
    ).toBeGreaterThan(0);
    expect(
      实际.filter((e) => e.id.startsWith("POST ")).length,
      "一个写路由都没扫到",
    ).toBeGreaterThan(0);
    expect(实际.length).toBe(WRITE_OPS.length);
  });
});
