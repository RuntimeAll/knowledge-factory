"use client";

/**
 * 侧栏导航项（AI:PRD-002 · 002-D）
 *
 * 🔴 全站唯一的 client 组件，而且只为一件事：**知道自己是不是当前页**。
 *    layout 是 server component，Next 不给它 pathname（RSC 里没有「当前 URL」这个概念），
 *    而两个可点导航项都长成选中态，比没有选中态更糟。
 *    它不取数、不持状态 —— 数据一律留在 server component 里。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "text-acc-deep bg-sel border-acc relative flex items-baseline border-l-[3px] px-[19px] py-[7px] font-bold"
          : "text-ink hover:text-acc-deep flex items-baseline px-[22px] py-[7px]"
      }
    >
      {children}
    </Link>
  );
}
