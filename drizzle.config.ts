import { type Config } from "drizzle-kit";

import { env } from "~/env";

export default {
  // 六域 schema 按域分文件，barrel 在 index.ts
  schema: "./src/server/db/schema/index.ts",
  // 迁移 SQL 落这里；🔴 一律 generate+migrate，绝不 db:push（migration 是长期资产）
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    // 来自 .env 的 DATABASE_URL = file:./data/资料库.db
    url: env.DATABASE_URL,
  },
  // 🔴 无表名前缀（裸表名，与 M1 SQL 完全一致）；不设 tablesFilter，
  //    否则 raw migration 手建的 question_fts / _write_gate 会被 drizzle 视作「库里多出来的表」。
} satisfies Config;
