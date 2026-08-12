/**
 * 全站壳（AI:PRD-001 · WP6）
 *
 * 版式正本 = prd/PRD-026/前端设计稿.html v2「学术风·精准简约」：
 * 纸感底色 + 浅色侧栏（🔴 禁深色侧栏）+ 宋体系标题 + 学术绿 + 2~3px 圆角 + 发丝线。
 *
 * 🔴 本卡范围只有「壳 + 红旗条 + 首页状态卡」。导航里除首页外全是占位（disabled），
 *    功能页各自属于后面的卡，这里一个都不做 —— 提前搭半成品页比没有页更贵。
 *
 * 🔴 force-dynamic：本壳每次渲染都读真库（红旗条）。不标的话 Next 会在 build 期
 *    预渲染 / 与 /_not-found，那时库未必在位，构建会因为「读不到库」失败 ——
 *    而这页面的数据本来就该是**现算**的（本地库毫秒级，没有缓存的必要）。
 */
import "~/styles/globals.css";

import { type Metadata } from "next";
import Link from "next/link";

import { RedFlagBar } from "~/components/red-flag-bar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "知识工厂 · 资料库",
  description: "个人知识库 · agent 外挂（本地库监督面）",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

/** 🔴 除首页外全是占位：卡没开工，页就别装作有 */
const NAV: ReadonlyArray<{
  label: string;
  href?: string;
  /** 归属卡（占位项显示为「待 AI:PRD-00N」） */
  card: string;
}> = [
  { label: "首页", href: "/", card: "001" },
  { label: "知识图谱", card: "002" },
  { label: "审查队列", card: "003" },
  { label: "题库检索", card: "004" },
  { label: "生产登记", card: "005" },
  { label: "学情", card: "006" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex min-h-screen">
          {/* ── 侧栏：纸上目录（与正文同为纸色，不是深色导航） ── */}
          <aside className="border-hair bg-paper w-[198px] shrink-0 border-r pt-[22px] pb-8">
            <div className="px-[22px]">
              <b className="font-serif text-[19px] tracking-[2px]">知识工厂</b>
              <small className="text-mut mt-0.5 block text-[10.5px] tracking-[1.5px]">
                资料库 · AGENT 外挂
              </small>
              <span className="border-acc mt-2.5 block w-[26px] border-b-2" />
            </div>

            <nav className="mt-4">
              {NAV.map((item) =>
                item.href ? (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="text-acc-deep bg-sel border-acc relative flex items-baseline border-l-[3px] px-[19px] py-[7px] font-bold"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span
                    key={item.label}
                    aria-disabled="true"
                    title={`功能页属 AI:PRD-${item.card}，本卡只搭壳`}
                    className="text-mut/70 flex cursor-not-allowed items-baseline px-[22px] py-[7px]"
                  >
                    {item.label}
                    <span className="text-mut/70 ml-auto text-[10px] tracking-[0.5px]">
                      待 {item.card}
                    </span>
                  </span>
                ),
              )}
            </nav>

            <div className="border-hair text-mut mx-[22px] mt-[22px] border-t pt-3 text-[11px] leading-[1.8]">
              agent 不看这些页面——它走 MCP 工具，与页面共用同一 core。
              <br />
              页面 = 你的监督面。
            </div>
          </aside>

          {/* ── 主区 ── */}
          <main className="min-w-0 flex-1">
            <div className="bg-sheet rule-double sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 px-[30px] py-[13px]">
              <span className="font-serif text-[15px] tracking-[1px]">
                知识工厂 · 资料库
              </span>
              <span className="text-mut text-[11.5px]">本地 SQLite · 现算</span>
              <span className="text-mut ml-auto text-[12px]">
                写操作一律走 core / MCP，页面只读
              </span>
            </div>

            <RedFlagBar />

            <div className="max-w-[1120px] px-[30px] pt-[26px] pb-[80px]">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
