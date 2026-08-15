/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  /**
   * 🔴🔴 生产构建与 dev 各用各的产物目录（AI:PRD-009 验收修复 · 「next start 起不来」）
   *
   * 事故形态：`next dev --turbo` 与 `next build` **共用 `.next/`**。dev 在跑的时候
   * （或跑过之后）做一次生产构建，turbopack dev 会把 `.next/routes-manifest.json`
   * 改写成它自己那份**精简版**（只有 basePath/headers/redirects/rewrites/version/
   * caseSensitive 六个键）。而 `next start` 侧对 `routesManifest.dataRoutes` 做 for-of
   * —— 键压根不存在，当场
   *     `[TypeError: routesManifest.dataRoutes is not iterable]`，
   * 探活 curl 返 000。**症状看着像构建产物坏了，其实是两个进程抢同一个目录。**
   * 🔴 最坑的是 `next build` 自己退出码 0：「build 绿」证明不了「产物起得来」。
   *
   * 解法：生产侧（build / start / preview / verify:serve）由 `scripts/next-prod.mjs`
   * 统一注入 `KF_DIST_DIR=.next-prod`，dev 继续独占 `.next` —— 两边再也不打架，
   * dev 开着也能构建、也能起生产服务。
   * 🔴 不设这个环境变量时行为与从前**完全一致**（`.next`），部署链读的还是老路径。
   */
  distDir: process.env.KF_DIST_DIR?.trim() ?? ".next",

  /**
   * 🔴 两个**原生模块**（.node 二进制）必须留在 node_modules 里由 require 直接加载，
   *    不能让 Next 的打包器去"分析并内联"它们（AI:PRD-004 · 004-A）：
   *      @node-rs/jieba   分词（napi 绑定 + 5MB 词典）
   *      onnxruntime-node ONNX 推理（bin/napi-v6/ 下的 .node 与 onnxruntime.dll）
   *    不声明的话，`next build` 会在 core/segment.ts 这条 import 链上撞到
   *    "Module parse failed: Unexpected character" —— 打包器读不懂 .node。
   */
  serverExternalPackages: ["@node-rs/jieba", "onnxruntime-node"],

  /**
   * 🔴🔴 手机实测的**硬前置**（AI:PRD-009 集成收口②；四组里有两组把它列为阻塞项）
   *
   * 不配这一条，手机用本机网卡 IP 打开 dev server 时：页面 HTML 出得来，但
   * `/_next/*` 的 JS chunk 与字体**全 403** —— 表现是「页面看得见、按钮点不动」，
   * 而且 **curl 和 localhost 都测不出来**（它们不跨源，走的是另一条判断）。
   * 这正是记忆里 `punch-console-serve-traps` 那个坑，同一个 Next 版本、同一种症状。
   *
   * 🔴 必须填**真 WLAN 网卡**的 IP，不是 FlClash 那张虚拟网卡（198.18.x.x）——
   *    Next 启动时打印的 "Network:" 那行经常指的是虚拟网卡，照抄必错。
   *    换网络（换 WiFi / DHCP 续租换了地址）后这里要跟着改，
   *    查法：PowerShell `Get-NetIPAddress -AddressFamily IPv4`，
   *    取 InterfaceAlias 为 WLAN 且 PrefixOrigin 为 Dhcp 的那个。
   * 🔴 只影响 `next dev`：生产构建不读它，所以写死一个内网地址不会带进部署。
   */
  allowedDevOrigins: ["192.168.1.142"],

  /**
   * dev 左下角那枚红色「N Issue」徽标关掉（2026-08-15 验收：验收时碍眼）。
   *
   * 🔴 徽标底下**只有一条已挂账的告警**：ProComponents 响应式断点的 dev-only
   *    hydration 警告（AI:PRD-008 · 遗留#20，见 prd/PRD-008/验收实录-20260814.md，
   *    prod build 不受影响）。
   * 🔴 这一行**只是藏徽标，不是把问题消掉** —— 警告照旧打在浏览器 console 与
   *    dev server 日志里，遗留#20 也还挂在账上。哪天要复现它，把这行注掉即可。
   * 🔴 只作用于 `next dev`：生产构建压根不注入这套 devtools。
   *
   * ⚠️ 实测挂账（2026-08-15，next 15.5.23）：**这个官方开关当前没生效** ——
   *    另起干净 dev（turbopack 与 webpack 各一遍、独立 distDir）徽标照旧出现。
   *    根因：判据在预编译包 dist/compiled/next-devtools 里读
   *    `process.env.__NEXT_DEV_INDICATOR`，而这份包没吃到 define-env 注入的值。
   *    ⇒ 配置按官方写法留着（升级 next 后自然生效），眼下要立刻不碍眼就点徽标上
   *      那个「×」（它写 devIndicator.disabledUntil，是运行期的另一条通路）。
   */
  devIndicators: false,
};

export default config;
