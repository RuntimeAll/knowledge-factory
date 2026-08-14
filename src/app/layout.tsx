/**
 * 全站壳（AI:PRD-008 · 地基改版；原件 AI:PRD-001 · WP6）
 *
 * 版式正本换人了：prd/PRD-008/设计稿-管理台改版.md ——
 * 「结构全面若依化 + 视觉弃学术纸感、改朴素后台」（D1 拍板，antd 默认主题即基调）。
 * 侧栏菜单树 / 面包屑 / 顶栏都在 `~/components/console/shell`，菜单正本在 `console/menu.ts`。
 *
 * 🔴 本文件只做三件事：挂 antd 的 SSR 样式注册器、把红旗条（server component）
 *    交给壳、把 children 塞进内容区。**导航一条都不在这儿写**。
 *
 * 🔴 AntdRegistry 不可省：不挂它，antd 的 css-in-js 样式只在浏览器里生成，
 *    首屏会闪一下无样式的裸 HTML（App Router 下这是 antd 的官方接法）。
 *
 * 🔴 force-dynamic：本壳每次渲染都读真库（红旗条）。不标的话 Next 会在 build 期
 *    预渲染 / 与 /_not-found，那时库未必在位，构建会因为「读不到库」失败 ——
 *    而这页面的数据本来就该是**现算**的（本地库毫秒级，没有缓存的必要）。
 */
import "~/styles/globals.css";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { type Metadata } from "next";

import { ConsoleShell } from "~/components/console/shell";
import { RedFlagBar } from "~/components/red-flag-bar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知识工厂 · 管理台",
  description: "个人知识库 · agent 外挂（本地库监督面）",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ConsoleShell flags={<RedFlagBar />}>{children}</ConsoleShell>
        </AntdRegistry>
      </body>
    </html>
  );
}
