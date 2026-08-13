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

    /**
     * 🔴 vitest 默认 5s 是给**纯单测**定的，本仓早就不是那种测试了：
     *   - 对账六项（integrityCheck）要在一个真库副本上扫全表 + 重算审计链，单条 ~4s；
     *   - 每个 describe 起手一次 `VACUUM INTO` 造副本（1.5MB 库，~0.3s）；
     *   - 004-A 起还要真载一个 95MB 的 ONNX 句向量模型（每个 worker 进程一次，~0.5s）。
     * 多个测试文件并行跑时这些开销互相叠加，于是「本来 4.6s 的那条」偶发 5s 超时 ——
     * 而它是**被别的文件挤慢的**，不是自己变慢了（单跑必过，实测过）。
     *
     * 靠调小并发或者把慢用例改瘦都是在治症状：这些用例慢是因为它们干的是真活
     * （真库、真模型、真对账）。把闸放到 30s，让「超时」重新变成一个**真信号**
     * ——超了就是真卡住了，而不是"今天机器忙"。
     */
    testTimeout: 30_000,
    /** beforeAll 里造副本 + 预热模型，同理 */
    hookTimeout: 30_000,
  },
});
