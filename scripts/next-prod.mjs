#!/usr/bin/env node
/**
 * 生产侧 next 的统一入口（AI:PRD-009 验收修复 ·「pnpm start / pnpm preview 是死路」）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 它修的到底是什么
 *
 *   `next dev --turbo` 与 `next build` **共用 `.next/`**。dev 在跑（或跑过）之后
 *   做一次生产构建，turbopack dev 会把 `.next/routes-manifest.json` 覆盖成它自己
 *   那份精简版（只剩 version/basePath/caseSensitive/headers/redirects/rewrites
 *   六个键）。`next start` 侧对 `routesManifest.dataRoutes` 做 for-of，键不存在，
 *   于是启动当场抛
 *       [TypeError: routesManifest.dataRoutes is not iterable]
 *   端口不开、探活 curl 返 000。
 *
 *   🔴 而 `next build` 自己**退出码 0** —— 「build 绿」这道闸证明不了「产物起得来」。
 *      验收里正是这么判红的：闸绿、`pnpm start` 死。
 *
 *   两条修法一起上：
 *     ① **分家**：生产侧一律 `KF_DIST_DIR=.next-prod`（next.config.js 读它），
 *        dev 继续独占 `.next`，两个进程再也不抢同一个目录；
 *     ② **起前先验产物**（start 那一路）：manifest 里 dataRoutes/staticRoutes/
 *        dynamicRoutes 缺任何一个，就用**人话**拦在启动之前，不让人再去猜那句
 *        看不懂的 TypeError。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 用法（都由 package.json 的 scripts 调，不必手敲）：
 *   node scripts/next-prod.mjs build          # 生产构建 → .next-prod
 *   node scripts/next-prod.mjs start [-p 端口]
 *   node scripts/next-prod.mjs preview        # build + start
 *   node scripts/next-prod.mjs verify         # 🔴 build 之后**真起一次**并探活 200
 *
 * 🔴 `verify` 是本文件的重点：它把「产物可服务」变成一条**机器判据**（起服务 →
 *    探活 → 杀掉 → 报退出码），这正是原来缺的那道闸。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const 仓根 = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 🔴 生产产物目录：与 dev 的 `.next` 分家，名字同时写在 next.config.js 与 .gitignore 里 */
const DIST = ".next-prod";

/** 探活端口（verify 用；避开 dev 的 3210 与 punch-console 的 3000/8787） */
const VERIFY_PORT = Number(process.env.KF_VERIFY_PORT ?? 3399);

function nextBin() {
  // 🔴 走 require.resolve 而不是拼 node_modules 路径：pnpm 的 .pnpm 硬链接布局下，
  //    手拼路径在换机/换装法时会指空。
  return require.resolve("next/dist/bin/next");
}

/** 起一个 next 子进程（生产 distDir 已注入） */
function 起next(args, opts = {}) {
  return spawn(process.execPath, [nextBin(), ...args], {
    cwd: 仓根,
    env: { ...process.env, KF_DIST_DIR: DIST, ...(opts.env ?? {}) },
    stdio: opts.stdio ?? "inherit",
    windowsHide: true,
  });
}

function 跑完(child) {
  return new Promise((res) => {
    child.on("close", (code) => res(code ?? 1));
    child.on("error", (e) => {
      console.error(`起不来 next：${e.message}`);
      res(1);
    });
  });
}

/**
 * 🔴 起服务前的产物体检。返回 null = 过；返回字符串 = 拦下的原因（人话）。
 *
 * 判据取 `next start` 真正会 for-of 的那三个键 —— 不是随手挑的字段：
 * 它们缺失就是本文件开头那条 TypeError 的直接成因。
 */
export function 体检产物(distDir = join(仓根, DIST)) {
  const manifest = join(distDir, "routes-manifest.json");
  const 建议 =
    `\n修法：① 先停掉正在跑的 \`pnpm dev\`（它会改写产物目录）；` +
    `② \`pnpm build\`（产物落 ${DIST}/，与 dev 的 .next 分开）；③ 再 \`pnpm start\`。`;

  if (!existsSync(distDir)) {
    return `产物目录不在：${distDir} —— 还没构建过。${建议}`;
  }
  if (!existsSync(join(distDir, "BUILD_ID"))) {
    return (
      `${distDir} 里没有 BUILD_ID —— 这不是一份完成的生产构建` +
      `（多半是 dev 的产物，或构建中途断了）。${建议}`
    );
  }
  if (!existsSync(manifest)) {
    return `缺 routes-manifest.json：${manifest}${建议}`;
  }

  let j;
  try {
    j = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (e) {
    return `routes-manifest.json 解析不了：${String(e)}${建议}`;
  }

  const 缺 = ["dataRoutes", "staticRoutes", "dynamicRoutes"].filter(
    (k) => !Array.isArray(j[k]),
  );
  if (缺.length > 0) {
    return (
      `🔴 ${manifest} 缺 ${缺.join(" / ")}（现有键：${Object.keys(j).join(", ")}）——\n` +
      "   这份 manifest 是 `next dev --turbo` 写的精简版，不是生产构建的产物。\n" +
      "   直接 `next start` 会当场抛 `TypeError: routesManifest.dataRoutes is not iterable`，\n" +
      "   端口根本不开（探活返 000）。" +
      建议
    );
  }
  return null;
}

/** verify：build → 真起一次 → 探活 → 杀掉。这是「产物可服务」的机器判据。 */
async function verify() {
  console.log(`[verify:serve] ① 生产构建（产物 → ${DIST}/）`);
  const b = await 跑完(起next(["build"]));
  if (b !== 0) {
    console.error(`[verify:serve] ❌ next build 退出码 ${b}`);
    return b;
  }

  const 体检 = 体检产物();
  if (体检) {
    console.error(`[verify:serve] ❌ 构建退出码 0，但产物体检没过：\n${体检}`);
    return 1;
  }
  console.log("[verify:serve] ② 产物体检过（manifest 三个路由键齐）");

  console.log(`[verify:serve] ③ 真起一次 next start -p ${VERIFY_PORT}`);
  const 日志 = [];
  const child = 起next(["start", "-p", String(VERIFY_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (c) => 日志.push(c));
  child.stderr?.on("data", (c) => 日志.push(c));

  let 退了 = null;
  child.on("close", (code) => (退了 = code ?? 1));

  const 截止 = Date.now() + 90_000;
  let 码 = 0;
  let 通了 = false;
  while (Date.now() < 截止) {
    if (退了 !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${VERIFY_PORT}/`, {
        redirect: "manual",
      });
      码 = res.status;
      // 200/3xx 都算「服务起来了」；本站首页是 200
      if (码 > 0 && 码 < 500) {
        通了 = true;
        break;
      }
    } catch {
      /* 还没起来，接着等 */
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  child.kill();
  const 原文 = Buffer.concat(日志).toString("utf8").trim();

  if (!通了) {
    console.error(
      `[verify:serve] ❌ 起不来或探活没到 2xx/3xx（最后拿到 ${码 || "连接失败"}）。\n` +
        `next start 的输出原文：\n${原文 || "（一个字都没输出）"}`,
    );
    return 1;
  }
  console.log(
    `[verify:serve] ✅ http://127.0.0.1:${VERIFY_PORT}/ 返回 ${码} —— 产物真能服务`,
  );
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "build") {
    process.exit(await 跑完(起next(["build", ...rest])));
  }

  if (cmd === "start") {
    const 体检 = 体检产物();
    if (体检) {
      console.error(`\n🔴 pnpm start 起不来，先看这个：\n${体检}\n`);
      process.exit(1);
    }
    process.exit(await 跑完(起next(["start", ...rest])));
  }

  if (cmd === "preview") {
    const b = await 跑完(起next(["build"]));
    if (b !== 0) process.exit(b);
    const 体检 = 体检产物();
    if (体检) {
      console.error(`\n🔴 构建退出码 0，但产物起不来：\n${体检}\n`);
      process.exit(1);
    }
    process.exit(await 跑完(起next(["start", ...rest])));
  }

  if (cmd === "verify") {
    process.exit(await verify());
  }

  console.error(
    `用法：node scripts/next-prod.mjs <build|start|preview|verify> [next 的参数…]\n收到：${String(cmd)}`,
  );
  process.exit(2);
}

// 被 import 时（单测）不跑 main
if (process.argv[1] && process.argv[1].endsWith("next-prod.mjs")) {
  await main();
}
