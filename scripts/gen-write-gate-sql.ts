/**
 * 生成「写令牌 + 防裸写触发器」那一坨 SQL（64 只触发器，手抄必错）。
 *
 * 用法：  pnpm exec tsx scripts/gen-write-gate-sql.ts
 * 产出：  SQL 文本打到 stdout，人工贴进【新的】custom migration。
 *
 * 🔴 这不是「跑一下就改库」的工具，也绝不能拿它去覆写已经 apply 过的 migration
 *    （migration 是长期资产，只能追加不能改）。将来加了新表要补闸 ⇒ 新开一支
 *    `drizzle-kit generate --custom`，把本脚本对新表的输出贴进去。
 * 🔴 表清单从 drizzle schema barrel 现读（不手抄），并与下面的域内排序表对账，
 *    对不上直接抛——防止「加了表却漏了闸」。
 */
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";

import * as schema from "../src/server/db/schema/index";

/** 只为可读性存在的域内排序；成员必须与 barrel 完全一致（下面对账） */
const ORDER: Array<[string, string[]]> = [
  ["A 域 · KG 双层", ["kp", "kp_alias", "kp_edge", "edition_tree", "edition_node", "node_kp_map"]],
  [
    "B 域 · 题目",
    [
      "question",
      "question_kp",
      "question_tag",
      "question_figure",
      "question_vec",
      "asset",
      "source_doc",
      "source_page",
    ],
  ],
  ["C 域 · 考察模型", ["exam_model"]],
  ["D 域 · 错因", ["error_cause", "kp_error", "cause_example", "err_code_map"]],
  [
    "E 域 · 生产登记",
    [
      "ingest_batch",
      "quarantine",
      "sku",
      "sku_item",
      "sku_output",
      "grading_task_map",
      "grading_batch_link",
    ],
  ],
  ["F 域 · 学情连接", ["roster"]],
  ["G 域 · 系统", ["review_queue", "ledger", "ledger_ref", "audit_log", "metric_event"]],
];

/** 审计链绝对 append-only：无条件 RAISE，core 也不许改 */
const APPEND_ONLY = new Set(["audit_log"]);

function tablesFromSchema(): string[] {
  return Object.values(schema)
    .filter((v): v is SQLiteTable => is(v, SQLiteTable))
    .map((t) => getTableName(t))
    .sort();
}

function reconcile(): string[][] {
  const fromSchema = tablesFromSchema();
  const ordered = ORDER.flatMap(([, ts]) => ts);
  const a = [...ordered].sort();
  const missing = fromSchema.filter((t) => !ordered.includes(t));
  const extra = ordered.filter((t) => !fromSchema.includes(t));
  if (missing.length || extra.length || a.length !== fromSchema.length) {
    throw new Error(
      `[gen-write-gate] ORDER 与 drizzle schema 对不上：schema 多出 ${JSON.stringify(missing)}，ORDER 多出 ${JSON.stringify(extra)}`,
    );
  }
  return ORDER.map(([, ts]) => ts);
}

function gateTrigger(table: string, op: "UPDATE" | "DELETE"): string {
  const name = `trg_${table}_no_bare_${op.toLowerCase()}`;
  if (APPEND_ONLY.has(table)) {
    return [
      `CREATE TRIGGER ${name} BEFORE ${op} ON ${table} BEGIN`,
      `  SELECT RAISE(ABORT, '${table}: 审计链 append-only——${op} 一律被拒（开闸也不例外）');`,
      `END;`,
    ].join("\n");
  }
  return [
    `CREATE TRIGGER ${name} BEFORE ${op} ON ${table}`,
    `WHEN (SELECT allowed FROM _write_gate WHERE id=1)=0 BEGIN`,
    `  SELECT RAISE(ABORT, '${table}: 裸 ${op} 被拒——写操作必须经 core 业务层');`,
    `END;`,
  ].join("\n");
}

function main(): void {
  reconcile();
  const out: string[] = [];
  for (const [domain, tables] of ORDER) {
    out.push(`-- --- ${domain} ${"-".repeat(Math.max(0, 60 - domain.length))}`);
    for (const t of tables) {
      out.push(gateTrigger(t, "UPDATE"));
      out.push("--> statement-breakpoint");
      out.push(gateTrigger(t, "DELETE"));
      out.push("--> statement-breakpoint");
    }
  }
  // 去掉最后一个 breakpoint 由贴的人决定，这里保留完整块
  process.stdout.write(out.join("\n") + "\n");
}

main();
