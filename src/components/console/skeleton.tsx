"use client";

/**
 * 页面加载骨架（AI:PRD-009 · 打磨检查单 §三·1「绝无白屏闪现」）—— 全站唯一一份
 *
 * ── 收编来历（集成收口②，2026-08-14）─────────────────────────────────────────
 *   打磨批四组共建了 13 份 `loading.tsx`，形状一致但各抄一遍
 *   （标题条 + 一句"为什么慢" + 若干张卡的灰条），三组都在文件头标了
 *   「**待 d 组收编**成统一 `<PageSkeleton>`」。本文件即收编结果：
 *   13 份 loading.tsx 现在都只剩「说清这页在读什么」那几行文案。
 *
 * ── 为什么这些页非要有 loading 边界 ────────────────────────────────────────
 *   全站页面是 `force-dynamic` 的 server component。**没有 loading.tsx 时
 *   Next 会停在上一页不动**，等服务端渲完再整屏换掉 —— 点一下菜单，屏幕
 *   几百毫秒没有任何反应，人分不清"在读"还是"点了没反应"，于是再点一次。
 *   有了它，导航瞬间换骨架，壳（侧栏 / 面包屑 / 红旗条）留在原位不闪。
 *
 * 🔴 骨架里**绝不出现任何结论**：这时候一个数都还没读到，
 *    印一句「暂无数据」就是编的（检查单 §三·6 同一条纪律：
 *    空态 ≠ 读不出 ≠ 还没读完，三件事三种画法）。
 * 🔴 `note` 请写**这页在读什么、为什么慢**（读哪个库 / 调哪个 core 函数），
 *    不写进度百分比 —— 这里没有真实进度可报，编一个假的比不报更坏。
 * 🔴🔴 **必须是 "use client"** —— 这不是风格问题，是**不加就 500** ：
 *    本件用到 `Skeleton.Input`（复合组件的**子属性**）。antd v5 的模块自带
 *    "use client"，所以在 server component 里 `import { Skeleton }` 拿到的是
 *    **client reference 代理**，代理上没有 `.Input` 这个属性 —— 取出来是
 *    `undefined`，渲染时报 "Element type is invalid … but got: undefined"，
 *    而且**整棵树都挂**（root loading.tsx 一挂 = 全站每一页 500）。
 *    与 `console/table.tsx` 文件头那条约束是同一枚硬币的两面：
 *    那边是「常量必须住在 server 也能 import 的普通模块」，
 *    这边是「碰复合组件子属性的必须住在 client 模块」。
 *    🔴 集成收口②实测：四组各自写的 7 份 loading.tsx 正是漏了这一条
 *      （`Skeleton.Input` + 无 "use client"），dev 一起就是满屏 500；
 *      四组都只跑了 build/tsc —— **build 不渲染 dynamic 路由，抓不到它**。
 * 🔴 client 组件不等于要取数：本件不取数、无 hook、无事件，
 *    所有文案由调用方（server 的 loading.tsx）当 props 传进来。
 */
import { Card, Skeleton } from "antd";
import type { ReactNode } from "react";

export interface SkeletonCard {
  /** 卡片标题（照真页面摆，形状对得上切换时才不「跳一下」） */
  title?: ReactNode;
  /** 正文灰条几行 */
  rows?: number;
}

export function PageSkeleton({
  titleWidth = 200,
  note,
  cards = [{ rows: 6 }],
}: {
  /** 标题灰条宽度：照真页面标题的长短给，换屏时基线不跳 */
  titleWidth?: number;
  /** 🔴 一句话说清「正在读什么」——加载态里唯一允许出现的文字 */
  note?: ReactNode;
  /** 骨架卡：照真页面的卡片结构摆 */
  cards?: SkeletonCard[];
}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <div style={{ marginBottom: 12 }}>
        <Skeleton.Input
          active
          style={{ width: titleWidth, height: 26, minWidth: titleWidth }}
        />
        {note ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 12.5,
              color: "#909399",
              lineHeight: 1.9,
            }}
          >
            {note}
          </div>
        ) : null}
      </div>

      {cards.map((c, i) => (
        <Card
          key={i}
          size="small"
          title={c.title}
          style={{ marginBottom: i === cards.length - 1 ? 0 : 12 }}
        >
          <Skeleton active paragraph={{ rows: c.rows ?? 4 }} title={false} />
        </Card>
      ))}
    </div>
  );
}

export default PageSkeleton;
