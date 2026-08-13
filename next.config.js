/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  /**
   * 🔴 两个**原生模块**（.node 二进制）必须留在 node_modules 里由 require 直接加载，
   *    不能让 Next 的打包器去"分析并内联"它们（AI:PRD-004 · 004-A）：
   *      @node-rs/jieba   分词（napi 绑定 + 5MB 词典）
   *      onnxruntime-node ONNX 推理（bin/napi-v6/ 下的 .node 与 onnxruntime.dll）
   *    不声明的话，`next build` 会在 core/segment.ts 这条 import 链上撞到
   *    "Module parse failed: Unexpected character" —— 打包器读不懂 .node。
   */
  serverExternalPackages: ["@node-rs/jieba", "onnxruntime-node"],
};

export default config;
