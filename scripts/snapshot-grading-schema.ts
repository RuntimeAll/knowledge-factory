/**
 * 圣域（批改线 审核.db）schema 快照 —— 契约附件生成器（AI:PRD-001 · WP4）
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/snapshot-grading-schema.ts [输出json路径]
 * 默认输出：contracts/审核db-schema.snapshot.json（🔴 入 git，它是契约附件）
 *
 * 🔴 M1 §3.F 的教训收编：**快照禁手抄**（首版手抄漏了 4 列，其中 slots.day 恰是唯一
 *    可用桥键，差点让整条学情回流建在空气上）。这里直接 SELECT sqlite_master 生成。
 * 🔴 只读：连接串必须带 mode=ro，且用 node:sqlite 的 SQLITE_OPEN_READONLY 打开
 *    （见 src/core/grading.ts 三道锁）。本脚本对审核.db 一个字节都不写。
 *
 * 快照变了怎么办 = **人工重新评估**：对账 C4a 会把 hash 变化报红，那是提醒你
 * 「批改线动了表，我们的读侧口径可能已经不成立」，不是让你无脑重跑本脚本盖掉红旗。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { closeGradingDb, gradingSchemaSnapshot } from "../src/core/index";

const DEFAULT_OUT = "contracts/审核db-schema.snapshot.json";

async function main(): Promise<void> {
  const out = resolve(process.cwd(), process.argv[2] ?? DEFAULT_OUT);
  const snap = await gradingSchemaSnapshot();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snap, null, 2) + "\n", "utf8");

  const L = [
    "圣域 schema 快照已生成",
    `  源库（只读）：${snap.dbPath}`,
    `  快照时间  ：${snap.takenAt}`,
    `  schemaHash：${snap.schemaHash}`,
    `  表（${snap.tables.length}）：${snap.tables.map((t) => t.name).join("、")}`,
    `  写入      ：${out}`,
    "",
    "🔴 本文件入 git；下次对账 C4a 会拿现场 hash 与它比对，不一致=红旗（人工评估，不自动跟进）。",
  ];
  process.stdout.write(L.join("\n") + "\n");
  closeGradingDb();
}

void main();
