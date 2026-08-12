import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    // 本地 SQLite：形如 file:./data/资料库.db
    // 🔴 不用 z.url()：libsql 的 file: 相对路径经 WHATWG URL 归一化会丢掉 "./"，
    //    语义和 libsql 自己的 parseUri 不一致，校验通过反而误导。这里只保证非空。
    DATABASE_URL: z.string().min(1),
    // 🔴 圣域 审核.db 只读挂载（G-1）：这里只保证「设了就得带 mode=ro」，
    //    真正的强制校验在 core/grading.ts（core 不 import 本文件，得自己把关）。
    //    留 optional：没配只影响对账 C4/C5，不该把整个 Next 构建卡死。
    GRADING_DB_URL: z
      .string()
      .min(1)
      .refine((v) => v.includes("mode=ro"), {
        message: "圣域只读挂载必须显式 mode=ro（审核.db 只准 SELECT）",
      })
      .optional(),
    // 备份异地副本目录；不设=跳过异地
    BACKUP_REMOTE_DIR: z.string().min(1).optional(),
    // 当前向量模型版本（对账 C3 的比对基准）
    EMBED_MODEL_VER: z.string().min(1).optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    GRADING_DB_URL: process.env.GRADING_DB_URL,
    BACKUP_REMOTE_DIR: process.env.BACKUP_REMOTE_DIR,
    EMBED_MODEL_VER: process.env.EMBED_MODEL_VER,
    NODE_ENV: process.env.NODE_ENV,
    // NEXT_PUBLIC_CLIENTVAR: process.env.NEXT_PUBLIC_CLIENTVAR,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
