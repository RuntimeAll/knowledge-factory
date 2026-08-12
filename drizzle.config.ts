import { type Config } from "drizzle-kit";

import { env } from "~/env";

export default {
  schema: "./src/server/db/schema.ts",
  // 迁移 SQL 落这里（本 WP 不生成，WP2 建表时才跑 db:generate/db:migrate）
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    // 来自 .env 的 DATABASE_URL = file:./data/资料库.db
    url: env.DATABASE_URL,
  },
  tablesFilter: ["knowledge-factory_*"],
} satisfies Config;
