/**
 * 建库证据：把 data/资料库.db 的 sqlite_master 全量导出成 markdown。
 *
 * 用法：  pnpm exec tsx scripts/dump-sqlite-master.ts <输出md绝对路径>
 * 不传路径就打到 stdout。
 *
 * 🔴 只读脚本：只跑 SELECT，不动库。
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const DB_URL = process.env.DATABASE_URL ?? "file:./data/资料库.db";

type Row = { name: string; type: string; tbl_name: string; sql: string | null };

async function main(): Promise<void> {
  const outPath = process.argv[2];
  const client = createClient({ url: DB_URL });

  const inventory = await client.execute(
    "SELECT name, type FROM sqlite_master ORDER BY type, name",
  );
  const all = await client.execute(
    "SELECT name, type, tbl_name, sql FROM sqlite_master ORDER BY type, name",
  );
  const rows = all.rows as unknown as Row[];

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);

  const stamp = new Date().toISOString();
  const L: string[] = [];
  L.push("# AI:PRD-001 建库证据 · sqlite_master 全量快照");
  L.push("");
  L.push(`> 库：\`knowledge-factory/data/资料库.db\`（DATABASE_URL=\`${DB_URL}\`）`);
  L.push("> 生成命令：`pnpm exec tsx scripts/dump-sqlite-master.ts <本文件路径>`（cwd=knowledge-factory）");
  L.push(`> 生成时间：${stamp}`);
  L.push("> 🔴 本文件是**机器导出**，不要手改；结构变了重跑脚本覆盖。");
  L.push("");
  L.push("## 0. 计数");
  L.push("");
  L.push("| type | 条数 |");
  L.push("|---|---|");
  for (const t of [...counts.keys()].sort()) L.push(`| ${t} | ${counts.get(t)!} |`);
  L.push("");

  L.push("## 1. `SELECT name, type FROM sqlite_master ORDER BY type, name`");
  L.push("");
  L.push("```");
  L.push("name|type");
  for (const r of inventory.rows as unknown as Array<{ name: string; type: string }>) {
    L.push(`${r.name}|${r.type}`);
  }
  L.push("```");
  L.push("");

  const section = (title: string, pred: (r: Row) => boolean) => {
    L.push(`## ${title}`);
    L.push("");
    L.push("```sql");
    for (const r of rows.filter(pred)) {
      L.push(`-- [${r.type}] ${r.name}${r.tbl_name !== r.name ? ` (on ${r.tbl_name})` : ""}`);
      L.push(r.sql === null ? "-- (sql = NULL：SQLite 自建对象，如 UNIQUE/PK 的隐式索引、FTS5 影子表)" : `${r.sql};`);
      L.push("");
    }
    L.push("```");
    L.push("");
  };

  section("2. 表 DDL（`SELECT sql FROM sqlite_master WHERE type='table'`）", (r) => r.type === "table");
  section("3. 索引 DDL", (r) => r.type === "index");
  section("4. 触发器 DDL", (r) => r.type === "trigger");

  const md = L.join("\n") + "\n";
  if (outPath) {
    writeFileSync(outPath, md, "utf8");
    process.stdout.write(`written: ${outPath} (${md.length} chars)\n`);
  } else {
    process.stdout.write(md);
  }
  client.close();
}

void main();
