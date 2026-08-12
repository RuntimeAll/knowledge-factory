import { FlatCompat } from "@eslint/eslintrc";
import tseslint from 'typescript-eslint';
// @ts-ignore -- no types for this plugin
import drizzle from "eslint-plugin-drizzle";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

export default tseslint.config(
  {
    // next-env.d.ts 是 Next 生成的，里面的 triple-slash 引用改不得；
    // data/ 是本地 SQLite 库，drizzle/ 是生成的迁移 SQL。
    ignores: [".next", "next-env.d.ts", "data", "drizzle"],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      drizzle,
    },
		extends: [
			...tseslint.configs.recommended,
			...tseslint.configs.recommendedTypeChecked,
			...tseslint.configs.stylisticTypeChecked
		],
      rules: {
    "@typescript-eslint/array-type": "off",
    "@typescript-eslint/consistent-type-definitions": "off",
    "@typescript-eslint/consistent-type-imports": [
      "warn",
      { prefer: "type-imports", fixStyle: "inline-type-imports" },
    ],
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/require-await": "off",
    "@typescript-eslint/no-misused-promises": [
      "error",
      { checksVoidReturn: { attributes: false } },
    ],
    "drizzle/enforce-delete-with-where": [
      "error",
      { drizzleObjectName: ["db", "ctx.db"] },
    ],
    "drizzle/enforce-update-with-where": [
      "error",
      { drizzleObjectName: ["db", "ctx.db"] },
    ],
  },
  },
  {
    // =========================================================================
    // 🔴 依赖红线（AI:PRD-001 §core 唯一业务层 / 验收 1-4 的机器闸）
    //
    // app 层（含 app/api/mcp 路由）与将来的 src/mcp/ 工具注册表，一律不许自己碰 DB：
    // 页面和工具是「壳」，逻辑全在 core。一旦谁能绕过 core 写一行，
    // 审计链就有洞，「可对账」整套说法作废。
    //
    // 用 @typescript-eslint 版而不是 ESLint 内置版：本仓开了 verbatimModuleSyntax +
    // inline type imports，内置规则管不到 `import type`，会被 `import type { db }` 绕过去。
    // core/ 与 server/db/ 不受限（它们就是实现层）；tests/ 与 scripts/ 不受限（要造场景）。
    // =========================================================================
    files: ["src/app/**/*.{ts,tsx}", "src/mcp/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "drizzle-orm",
                "drizzle-orm/*",
                "@libsql/client",
                "@libsql/client/*",
                "~/server/db",
                "~/server/db/*",
                "**/server/db",
                "**/server/db/*",
              ],
              message:
                "app/mcp 层禁直连 db——一切经 ~/core（AI:PRD-001 §core 唯一业务层）",
            },
            {
              group: ["~/core/*", "**/core/*"],
              message:
                "~/core 是唯一公共出口，别深挖子模块——要用什么就在 core/index.ts re-export（AI:PRD-001 §core 唯一业务层）",
            },
          ],
        },
      ],
    },
  },
  {
		linterOptions: {
			reportUnusedDisableDirectives: true
		},
		languageOptions: {
			parserOptions: {
				projectService: true
			}
		}
	}
)
