"use client";

/**
 * 题目详情的 tab 壳（AI:PRD-008 · 设计稿 §二·3「tab 化」）
 *
 * 🔴 只有这一层是 client：antd 的 Tabs 要切换态。四块内容全是 server component
 *    现算好、当 children 传进来的 —— 本文件一行库都不读、一条判断都不做。
 * 🔴 tab 记在地址栏（`?tab=blood` 这种）：详情页要能被链接到某一块
 *    （比如「族谱断了」的告警想直接指向血缘 tab），也让刷新之后还停在原处。
 */
import { Tabs } from "antd";
import { useRouter, useSearchParams } from "next/navigation";

export interface QuestionTabItem {
  key: string;
  label: string;
  children: React.ReactNode;
}

export function QuestionTabs({
  items,
  defaultKey,
}: {
  items: QuestionTabItem[];
  defaultKey: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const 现在 = sp.get("tab");
  const active = items.some((i) => i.key === 现在) ? 现在! : defaultKey;

  return (
    <Tabs
      activeKey={active}
      items={items}
      onChange={(k) => {
        const next = new URLSearchParams(sp.toString());
        next.set("tab", k);
        // scroll:false —— 换 tab 不该把页面弹回顶部
        router.replace(`?${next.toString()}`, { scroll: false });
      }}
    />
  );
}

export default QuestionTabs;
