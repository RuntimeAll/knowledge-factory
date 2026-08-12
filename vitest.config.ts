import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/**/*.{test,spec}.{ts,tsx}"],
  },
});
