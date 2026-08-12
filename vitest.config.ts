import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 读 .env 灌进测试进程的 process.env。
 *
 * 🔴 为什么要手写这几行而不是 vite 的 loadEnv：`vite` 不是本仓的直接依赖
 *    （pnpm 严格 node_modules，import 'vite' 直接解析失败），`vitest/config`
 *    也没有 re-export loadEnv。这点小事不值得为它加一个顶层依赖。
 * 🔴 为什么非灌不可：core 是**惰性读 process.env** 的（刻意不 import ~/env，
 *    好在纯 node 下也能跑）。GRADING_DB_URL 不喂进来，圣域只读连接就开不了，
 *    对账 C4/C5 在测试里只会报「连不上」，等于这两项没测。
 */
function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue; // 注释行 / 空行
    const key = m[1]!;
    let value = m[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export default defineConfig({
  resolve: {
    alias: {
      // 和 tsconfig.json 的 paths 对齐：~/* → ./src/*
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // node 环境即可：本项目的测试对象是 DB / MCP 工具带这类服务端逻辑，
    // 要测组件时再单独加一份 jsdom 环境的 project。
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "tests/**/*.{test,spec}.{ts,tsx}",
    ],
    env: readDotEnv(fileURLToPath(new URL("./.env", import.meta.url))),
  },
});
