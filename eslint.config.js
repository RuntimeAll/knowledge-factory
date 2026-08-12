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
