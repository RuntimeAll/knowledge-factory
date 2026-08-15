"use client";

/**
 * 管理台外壳（AI:PRD-008 · 地基）—— 侧栏菜单树 + 面包屑 + 顶栏
 *
 * 🔴 用现成件，不自研（设计稿 §五·2 拍板原话「不然全自研代价无法承受」）：
 *    ProLayout = 侧栏 + 菜单树 + 顶栏一个组件；antd v5 默认主题即基调（D1 彻底朴素后台）。
 * 🔴 React 19 必须打补丁：antd v5 的静态方法（message/notification/Modal.confirm）
 *    在 React 19 下走的是老 ReactDOM.render 通路，不打补丁会静默失效。
 *    补丁**全站只 import 这一次**（这里是唯一的全站 client 入口）。
 * 🔴 菜单正本在 ./menu.ts —— 本文件只负责画，不藏任何一条路由。
 * 🔴 无登录无鉴权（设计稿 §五·1 拍板）：顶栏右侧那句小字就是全部的"权限说明"，
 *    永不长出用户体系。
 *
 * ── 为什么壳是 client、数据还是 server ─────────────────────────────────────
 *   ProLayout 要 pathname（选中态/面包屑）才画得对，而 RSC 里没有"当前 URL"。
 *   所以壳是 client，但**它不取数**：红旗条是 server component，从 layout.tsx
 *   当 `flags` 传进来（RSC 里渲染好再序列化）。壳里一行库都不读。
 */
import "@ant-design/v5-patch-for-react-19";

import {
  ApartmentOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BookOutlined,
  BugOutlined,
  CheckSquareOutlined,
  CloudUploadOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileDoneOutlined,
  FileSearchOutlined,
  FormOutlined,
  HistoryOutlined,
  HomeOutlined,
  IdcardOutlined,
  ImportOutlined,
  InboxOutlined,
  MenuOutlined,
  MergeCellsOutlined,
  MonitorOutlined,
  PartitionOutlined,
  ProfileOutlined,
  ProjectOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  SolutionOutlined,
  SwapOutlined,
  TagsOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { ProLayout, type ProLayoutProps } from "@ant-design/pro-components";
import { Breadcrumb, Button, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  CONSOLE_MENU,
  crumbsFor,
  selectedPathFor,
  type ConsoleIconName,
} from "./menu";

/** ProLayout 没导出 Route 类型，从 props 上取（照抄一份迟早跟库漂） */
type RouteNode = NonNullable<ProLayoutProps["route"]>;

/**
 * 图标名 → 组件（菜单正本 menu.ts 是纯数据，只存名字；组件在这儿装配）。
 *
 * 🔴 收起态侧栏只剩这一列图标，它就是全部的导航信息 ——
 *    所以选图标的标准是「一眼认出是哪一页」，不是好看。
 */
const MENU_ICONS: Record<ConsoleIconName, React.ReactNode> = {
  home: <HomeOutlined />,
  dashboard: <DashboardOutlined />,
  database: <DatabaseOutlined />,
  "file-search": <FileSearchOutlined />,
  import: <ImportOutlined />,
  apartment: <ApartmentOutlined />,
  partition: <PartitionOutlined />,
  "merge-cells": <MergeCellsOutlined />,
  appstore: <AppstoreOutlined />,
  tags: <TagsOutlined />,
  experiment: <ExperimentOutlined />,
  inbox: <InboxOutlined />,
  shop: <ShopOutlined />,
  book: <BookOutlined />,
  profile: <ProfileOutlined />,
  swap: <SwapOutlined />,
  team: <TeamOutlined />,
  idcard: <IdcardOutlined />,
  bug: <BugOutlined />,
  audit: <AuditOutlined />,
  "check-square": <CheckSquareOutlined />,
  form: <FormOutlined />,
  "cloud-upload": <CloudUploadOutlined />,
  project: <ProjectOutlined />,
  solution: <SolutionOutlined />,
  control: <ControlOutlined />,
  "file-done": <FileDoneOutlined />,
  monitor: <MonitorOutlined />,
  history: <HistoryOutlined />,
  "safety-certificate": <SafetyCertificateOutlined />,
};

/** 菜单正本 → ProLayout 的 route 树（组用伪路径当键，只作分组标题） */
const ROUTES: NonNullable<RouteNode["children"]> = CONSOLE_MENU.map((g) => ({
  path: g.key,
  name: g.name,
  icon: g.icon ? MENU_ICONS[g.icon] : undefined,
  children: g.children.map((it) => ({
    path: it.path,
    name: it.name,
    // 🔴 二级项的图标 ProLayout 只在 `menu.type==='group'` 下画（它把组的下一级
    //    当作第一级看）—— 本壳正是 group 模式，所以这里给的图标会真出现在行首，
    //    收起态更是**只剩它**（组标题整条不渲染，二级项被拍平成一列图标）。
    icon: it.icon ? MENU_ICONS[it.icon] : undefined,
    disabled: it.todo === true,
    hint: it.hint,
  })),
}));

/** 收放状态记在浏览器（换页/刷新都记得住，key 与本壳同名以免撞别的项目） */
const COLLAPSE_KEY = "kf.sider.collapsed";
/** 手机断点：窄于此宽度不吃收放记忆（那边侧栏是抽屉，收放不是偏好） */
const DESKTOP_MIN_WIDTH = 768;
/** ProLayout 默认断点 lg = 992：窄过它侧栏会**自动**收起，那一次不是人点的 */
const SIDER_BREAKPOINT_WIDTH = 992;

/**
 * 壳的响应式（AI:PRD-009 · 检查单 ⑤「移动端」）。
 *
 * 🔴 用 `<style>` + media query，不用 `Grid.useBreakpoint()` 条件渲染：
 *    断点 hook 首帧在服务端拿不到窗口宽度，SSR 出来的 DOM 与水合后的第一帧
 *    会不一致（顶栏那句字先出现再消失，肉眼可见地闪一下）。CSS 没有这个问题。
 * 🔴 内边距只写在 class 里、不写 inline：inline style 覆盖 class，
 *    写了 inline 手机上的 12px 就永远不生效。
 */
const RESPONSIVE_CSS = `
.kf-topbar { height: 48px; background: #fff; border-bottom: 1px solid #e4e7ed;
  display: flex; align-items: center; gap: 14px; padding: 0 20px; }
.kf-topbar-note { margin-left: auto; font-size: 12.5px; color: #606266; white-space: nowrap; }
.kf-content { padding: 16px 20px 64px; max-width: 1280px; }
/* 🔴 侧栏组间距收紧（验收：「太稀疏，一屏放不下还出内滚动条」）
   ProLayout 每个一级组后面塞一条 divider —— borderBlockEnd:0 所以**看不见**，
   却白吃 6+8=14px，九个组就是 126px，正好是溢出的那一截。
   它的 margin 是**行内样式**（BaseMenu 写死），只能用 !important 压过去。
   🔴 选择器认 antd 的 ant-menu-item-divider，不认 ProLayout 那半截：
   它的类名带渲染模式（ant-pro-base-menu-inline-divider），写死必漏。
   🔴 这段是**模板字符串**，注释里一个反引号都不能有（会当场截断整段 CSS，
      表现是后面的规则全不生效而页面照常渲染 —— 排查过一轮，别再踩）。 */
.ant-pro-sider .ant-menu-item-divider { margin: 2px 12px !important; margin-block-start: 3px !important; }
.ant-pro-sider .ant-menu-item-group-title { padding-bottom: 2px !important; }
/* 🔴 汉堡键只在手机上出现：桌面有侧栏，多一个按钮是噪音 */
.kf-menu-toggle { display: none; }
/* 窄屏：顶栏那句权限说明让位给面包屑（它是一句常识性说明，不是当前页的信息） */
@media (max-width: 900px) { .kf-topbar-note { display: none; } }
@media (max-width: 767px) {
  .kf-topbar { padding: 0 12px; gap: 8px; }
  .kf-content { padding: 12px 12px 56px; }
  .kf-menu-toggle { display: inline-flex; }
}
`;

/**
 * 侧栏配色 —— 🔴 浅色高对比（2026-08-15 验收拍板，原话「颜色配比太丑、看不清内容」）
 *
 * 换掉的是原来那套若依深色 `#304156`：白字压深蓝底，组标题 `#8a97a8` 与背景
 * 对比不足 3:1，菜单项 `#bfcbd9` 也只是勉强及格 —— 结果是「一眼扫不出自己在哪一组」。
 * 现在回 antd 默认基调（`navTheme="light"`，白底 + 近黑正文 + 蓝底选中），
 * 与顶栏、内容区同为白底，整屏只剩一条 1px 分隔线。
 *
 * 🔴 颜色只往「更深」调，绝不再自调暗色系：这一栏的活是被读，不是被欣赏。
 * 🔴 `colorBgCollapsedButton` 必须给值 —— 这就是「不能收起来」的真凶：
 *    ProLayout 自带的收放按钮是浮在侧栏右边缘的 24px 圆钮，背景色取的正是这个 token，
 *    从前没给 ⇒ 透明圆 + 一个 `#8a97a8` 的箭头贴在深色边上，肉眼基本看不见，
 *    于是「有按钮」和「没按钮」在体验上是一回事。
 */
const SIDER_TOKEN = {
  colorMenuBackground: "#ffffff",
  // 选中 = 浅蓝底 + 主色字（antd 默认 controlItemBgActive 的同一族，不自创色）
  colorBgMenuItemSelected: "#e6f4ff",
  colorBgMenuItemHover: "#f2f5f9",
  colorTextMenu: "#303133",
  // 侧栏底注/次要文字：比正文淡一档但仍在 4.5:1 以上
  // （组标题的色 ProLayout 写死取全局 colorTextLabel，白底下本就够黑，不必动）
  colorTextMenuSecondary: "#5b6675",
  colorTextMenuTitle: "#1f2329",
  colorTextMenuSelected: "#1677ff",
  colorTextMenuActive: "#1677ff",
  colorTextMenuItemHover: "#1677ff",
  colorTextSubMenuSelected: "#1677ff",
  colorMenuItemDivider: "#eef0f3",
  // 收放按钮：白底圆钮 + 深灰箭头，压在 1px 边线上一眼可见
  colorBgCollapsedButton: "#ffffff",
  colorTextCollapsedButton: "#5b6675",
  colorTextCollapsedButtonHover: "#1677ff",
  menuSubArtBoard: "#ffffff",
};

/**
 * 侧栏密度（验收原话「太稀疏，一屏放不下还出内滚动条」）。
 *
 * 量出来的账（21 项 + 9 组标题 + 9 条组分隔，浏览器实测）：
 *   改前 40+4×2 的行 ⇒ 项 1008 + 组标题 270 + 分隔 135 = **1413px**
 *   改后 30+1×2 的行 ⇒ 项 672 + 组标题 252 + 分隔 54  = **978px**（省 435px / 31%）
 * 组分隔那 135px 尤其冤：ProLayout 给每个一级组尾部塞一条 `borderBlockEnd:0` 的
 * 分隔线 —— **看不见**却白吃 14px，压到 5px（见 RESPONSIVE_CSS 那两条 !important）。
 * 🔴 只压侧栏那一层：正文表格/表单的密度沿用全局 token，别顺手改小。
 */
const MENU_DENSITY = {
  itemHeight: 30,
  itemMarginBlock: 1,
  itemMarginInline: 8,
  itemPaddingInline: 8,
  itemBorderRadius: 4,
  groupTitleFontSize: 12,
  groupTitleLineHeight: "22px",
  iconMarginInlineEnd: 8,
  iconSize: 14,
  collapsedIconSize: 16,
};

export function ConsoleShell({
  flags,
  children,
}: {
  /** 全局红旗条（server component 渲染好传进来） */
  flags: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);
  const selected = selectedPathFor(pathname);

  /**
   * 🔴🔴 手机上打不开菜单的坑（AI:PRD-009 · 检查单 ⑤）：
   *   ProLayout 在窄屏会把侧栏变成 Drawer 并默认收起，而**开这个抽屉的那个汉堡键
   *   长在它自带的 header 上** —— 本壳 `headerRender={false}`（顶栏我们自己画），
   *   于是手机上整站只剩当前这一页，换页只能手改地址栏。
   *   解法：受控 `collapsed` + 顶栏自画一枚汉堡（桌面用 CSS 藏掉）。
   * 🔴 初值 `undefined` 是刻意的：交给 ProLayout 自己按断点决定初始收放，
   *    我们只在人点了之后接管（写死 false 会让手机首屏糊一层抽屉遮罩）。
   */
  const [collapsed, setCollapsed] = useState<boolean | undefined>(undefined);

  /**
   * 收放记忆（验收原话「不能收起来，非常碍事」的后半段：收起来还得记得住）。
   *
   * 🔴 只能在 effect 里读 localStorage，**不能塞进 useState 初值**：
   *    这个壳在服务端也要渲染一遍，服务端没有 localStorage ⇒ 首帧必然按「展开」出，
   *    初值里读到 true 就是一次 hydration 不一致（整棵侧栏重渲、宽度闪一下）。
   *    放在 effect 里：首帧永远与服务端一致，挂载后再收 —— 只有一次干净的动画。
   * 🔴 窄屏（<768）不吃这份记忆：那边的收放是抽屉的开关、不是人的偏好，
   *    照搬会让手机一进来就糊一层遮罩。
   */
  useEffect(() => {
    if (window.innerWidth < DESKTOP_MIN_WIDTH) return;
    if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
  }, []);

  /**
   * 收放 + 记一笔。
   * 🔴 宽屏（≥ lg 992）才记：`onCollapse` 不只有人点会触发 ——
   *    ProLayout 的断点逻辑在窗口窄过 lg 时也会调它自动收起。不设这道闸，
   *    「把窗口拖窄一次」就等于「我选择了收起」，回到大屏侧栏还自己收着，
   *    人一次也没点过。窄屏那次是布局行为，不是偏好。
   */
  const handleCollapse = (next: boolean) => {
    setCollapsed(next);
    if (typeof window === "undefined") return;
    if (window.innerWidth < SIDER_BREAKPOINT_WIDTH) return;
    window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 朴素后台：小圆角 + 13px 正文（与若依/element 的密度对齐）
          borderRadius: 3,
          fontSize: 13,
          colorPrimary: "#409eff",
        },
        // 🔴 只收侧栏菜单这一处的行距（见 MENU_DENSITY 注释）
        components: { Menu: MENU_DENSITY },
      }}
    >
      <ProLayout
        title="知识工厂"
        // 🔴 logo 必须显式关掉：ProLayout 的默认 logo 是一条外网 CDN 图片地址，
        //    本地库断网也要能用，不该为一个图标去连外网。
        logo={false}
        layout="side"
        // 🔴 浅色侧栏（2026-08-15 验收拍板）：antd 默认浅色 = 朴素后台的基调，
        //    白底 + 深字 + 蓝底选中，对比度不用自己算。
        navTheme="light"
        siderWidth={216}
        fixSiderbar
        fixedHeader
        route={{ path: "/", children: ROUTES }}
        location={{ pathname: selected }}
        collapsed={collapsed}
        onCollapse={handleCollapse}
        // 收起态宽度走 ProLayout 默认（实测 64px 的图标条，够放 16px 图标）：
        // 它没把 collapsedWidth 透出到 ProLayoutProps 上，显式写会过不了 tsc。
        // 🔴 收放按钮用它自带的那枚（浮在侧栏右边缘的圆钮），只包一层 title：
        //    自画一枚要么和汉堡键重复、要么位置对不上侧栏动画。
        //    它之所以从前「不能收起来」不是没按钮，是圆钮背景色 token 没给（见 SIDER_TOKEN）。
        //    外面这层只补一句说明文字（它自己那枚圆钮没有可读标签）。
        collapsedButtonRender={(isCollapsed, dom) => (
          <span
            title={isCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-label={isCollapsed ? "展开侧栏" : "收起侧栏"}
          >
            {dom}
          </span>
        )}
        // type=group：一级组显示成分组标题（过稿模版就是这个样子——所有二级页一屏看完）
        // 🔴 收起时组标题整条不渲染、二级项被拍平成一列图标（ProLayout 的既定行为），
        //    所以 menu.ts 里每一项都必须有 icon，否则那一格退化成首字母方块。
        menu={{ type: "group" }}
        // 面包屑自己画在顶栏（ProLayout 自带的那份要配 PageContainer 才出现）
        breadcrumbRender={false}
        pageTitleRender={false}
        token={{ sider: SIDER_TOKEN }}
        menuItemRender={(item, dom, menuProps) => {
          const todo = item.disabled === true;
          // 🔴 收起态一律交还 dom：那一格只剩 16px 图标，自画的行会把图标挤没
          //    （置灰项本来就没画图标 ⇒ 收起后是一块白板）。
          if (menuProps?.collapsed === true) {
            return todo ? (
              dom
            ) : (
              <Link href={item.path ?? "/"} title={item.name}>
                {dom}
              </Link>
            );
          }
          if (todo) {
            return (
              // 🔴 展开态这里**不复用 dom**：dom 自带一层行高，套进来两行会被
              //    菜单条从中间切开（实测：字被腰斩、「待开发」压在下一行）。
              //    置灰项自己画一行 flex：图标 + 名字省略号 + 标签不换行。
              <span
                aria-disabled="true"
                title={`${typeof item.hint === "string" ? item.hint + " · " : ""}页还没建（AI:PRD-008 分期建设）`}
                style={{
                  cursor: "not-allowed",
                  // 只调色不调透明度：opacity 会让这几项**几乎看不见** ——
                  // 灰是「点不了」，不是「不给你看」。浅底下取 #7c8797（约 4.5:1）。
                  color: "#7c8797",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                {/* 图标跟着一起画：不然置灰项与可点项左边缘对不齐，看着像错位 */}
                <span style={{ fontSize: 14, lineHeight: 1 }}>{item.icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.name}
                </span>
                <span style={{ fontSize: 10, color: "#98a2af" }}>待开发</span>
              </span>
            );
          }
          return (
            <Link
              href={item.path ?? "/"}
              title={typeof item.hint === "string" ? item.hint : undefined}
            >
              {dom}
            </Link>
          );
        }}
        // 🔴 header 自己画（见下面的顶栏）：layout="side" 时 ProLayout 不出顶栏，
        //    rightContentRender 会被塞进侧栏底部 —— 面包屑和那句权限小字就都跑偏了。
        headerRender={false}
        /**
         * 侧栏底注（这库是谁在用的一句话）。
         * 🔴 收起态直接不渲染：48px 宽塞两行小字只会挤成一团墨点。
         * 🔴 必须有一条分隔线 + 上留白：它和菜单项从前是贴着的，
         *    验收时被读成「最后一个菜单项」（原话「和菜单项挤在一起」）。
         * 🔴 字色调淡但不摸黑：#8892a0 在白底上约 4.1:1 —— 是"次要"，不是"看不清"。
         */
        menuFooterRender={(props) =>
          props?.collapsed ? null : (
            <div
              style={{
                margin: "8px 8px 0",
                padding: "10px 8px 2px",
                borderTop: "1px solid #eef0f3",
                fontSize: 11,
                lineHeight: 1.7,
                color: "#8892a0",
              }}
            >
              agent 不看这些页面——它走 MCP，与页面共用同一 core。
              <br />
              页面 = 你的监督面。
            </div>
          )
        }
        contentStyle={{ padding: 0, margin: 0 }}
      >
        <style dangerouslySetInnerHTML={{ __html: RESPONSIVE_CSS }} />

        {/* ── 顶栏：面包屑 + 那句权限说明（过稿模版的 .topbar）───────────────── */}
        <div className="kf-topbar">
          {/* 手机上唯一的「回菜单」入口。40×40 触控目标：贴着 44px 指南的下限，
              再大就把 48px 高的顶栏顶破了（检查单 ⑤ 的触控目标那条） */}
          <Button
            className="kf-menu-toggle"
            type="text"
            size="small"
            aria-label="打开导航菜单"
            icon={<MenuOutlined />}
            onClick={() => setCollapsed(collapsed === false)}
            style={{ minWidth: 40, height: 40 }}
          />
          <Breadcrumb
            style={{ fontSize: 13 }}
            items={[
              { title: <Link href="/">知识工厂</Link> },
              ...(crumbs
                ? [
                    { title: crumbs.group },
                    // 🔴 详情页补一层**可点的**列表页（检查单 ④⑧）：
                    //    「知识工厂 / 题库管理 / 题目详情」里中间那层是组名、点不动，
                    //    从详情页回列表页原先只能靠浏览器后退。父页正本在 menu.ts。
                    ...(crumbs.parent
                      ? [
                          {
                            title: (
                              <Link href={crumbs.parent.path}>
                                {crumbs.parent.name}
                              </Link>
                            ),
                          },
                        ]
                      : []),
                    { title: <b>{crumbs.name}</b> },
                  ]
                : []),
            ]}
          />
          <span className="kf-topbar-note">
            无登录无权限（内部单人）· 写操作走 core / MCP
          </span>
        </div>

        {/* 🔴 红旗条留在内容区顶部、通栏（它回答「这库现在可不可信」，比任何一页都靠前） */}
        {flags}
        <div className="kf-content">{children}</div>
      </ProLayout>
    </ConfigProvider>
  );
}

export default ConsoleShell;
