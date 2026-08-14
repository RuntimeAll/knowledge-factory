/**
 * 回归战报落库（AI:PRD-008 验收缺陷 · /health「回归最近一跑」的写侧）
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/regression-report.ts <战报.json>
 * 退出码：0=写进去了；1=写不进去（原因打在 stderr）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 为什么要有这个脚本：`regression.ps1` 只往控制台打 [PASS]/[FAIL] + 退出码，
 *    战报既不落库也不落文件 —— 于是 /health 的「回归最近一跑」那块**永远没有数据**
 *    （设计稿 §二·16 明写要它）。本脚本把那张汇总表写成 metric_event 一行，
 *    页面就能如实显示「什么时候跑的、哪一关红了」。
 *
 * 🔴 它是**一次库写**（logMetric → 连带一条审计行），所以：
 *      · 由 regression.ps1 在**所有关卡跑完之后**调用 —— 写在中途会让
 *        REG-A2（审计链校验）校验到一条自己造出来的行；
 *      · 谁都可以拿一份 JSON 手动补写（战报格式见下），但那也会留痕。
 *
 * 战报 JSON（regression.ps1 生成，字段与 core/status.ts 的 RegressionSummary 对齐）：
 *   { ok, total, passed, failed, secs, only, startedAt, finishedAt,
 *     gates: [{ id, name, ok, secs, reason }] }
 * 🔴 本脚本**不判断也不美化**：JSON 里写什么就落什么（只做形状校验）。
 *    战报是"那一跑到底怎么样"的记录，不是这里现算的结论。
 */
import { readFileSync } from "node:fs";

import {
  REGRESSION_METRIC_KIND,
  closeCoreDb,
  logMetric,
} from "../src/core/index";

interface GateLine {
  id: string;
  name: string;
  ok: boolean;
  secs: number;
  reason: string | null;
}

function 形状错(msg: string): never {
  throw new Error(`战报 JSON 不合格：${msg}`);
}

function 读战报(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `战报文件读不出来：${path}\n${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    // 🔴 PowerShell 的 Out-File 默认会写 BOM，JSON.parse 撞上它直接抛
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(
      `战报不是合法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    形状错("顶层不是对象");
  }
  return parsed as Record<string, unknown>;
}

function 归一关(v: unknown, i: number): GateLine {
  if (typeof v !== "object" || v === null) 形状错(`gates[${i}] 不是对象`);
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") {
    形状错(`gates[${i}].id 缺失`);
  }
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  return {
    id: o.id,
    name: typeof o.name === "string" ? o.name : o.id,
    ok: o.ok === true,
    secs: typeof o.secs === "number" ? o.secs : 0,
    reason: reason === "" ? null : reason,
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    throw new Error(
      "用法：pnpm exec tsx --env-file=.env scripts/regression-report.ts <战报.json>",
    );
  }

  const o = 读战报(file);
  if (!Array.isArray(o.gates)) 形状错("gates 不是数组");
  const gates = o.gates.map(归一关);
  const failed = gates.filter((g) => !g.ok).length;

  const value = {
    ok: failed === 0,
    total: gates.length,
    passed: gates.length - failed,
    failed,
    secs: typeof o.secs === "number" ? o.secs : 0,
    // 🔴 -Only 单关跑照样落账，但标出来 —— 「1/1 关绿」不是「全量全绿」
    only: typeof o.only === "string" && o.only.trim() !== "" ? o.only : null,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : null,
    finishedAt: typeof o.finishedAt === "string" ? o.finishedAt : null,
    gates,
  };

  const r = await logMetric(REGRESSION_METRIC_KIND, null, value);
  process.stdout.write(
    `回归战报已落库：metric_event #${r.id}（审计行 seq ${r.seq}）—— ` +
      `${value.passed}/${value.total} 关绿${value.only ? `（-Only ${value.only}）` : ""}\n`,
  );
  await closeCoreDb();
}

main().catch((e: unknown) => {
  process.stderr.write(
    `🔴 回归战报没写进去：${e instanceof Error ? e.message : String(e)}\n` +
      "（这不影响本轮回归的结论 —— 关卡的红绿以上面的汇总表为准）\n",
  );
  process.exitCode = 1;
});
