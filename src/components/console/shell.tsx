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

import { ProLayout, type ProLayoutProps } from "@ant-design/pro-components";
import { Breadcrumb, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { CONSOLE_MENU, crumbsFor, selectedPathFor } from "./menu";

/** ProLayout 没导出 Route 类型，从 props 上取（照抄一份迟早跟库漂） */
type RouteNode = NonNullable<ProLayoutProps["route"]>;

/** 菜单正本 → ProLayout 的 route 树（组用伪路径当键，只作分组标题） */
const ROUTES: NonNullable<RouteNode["children"]> = CONSOLE_MENU.map((g) => ({
  path: g.key,
  name: g.name,
  children: g.children.map((it) => ({
    path: it.path,
    name: it.name,
    disabled: it.todo === true,
    hint: it.hint,
  })),
}));

/** 若依/element 系侧栏配色（过稿模版 console-mockup.html 的 --side 那组） */
const SIDER_TOKEN = {
  colorMenuBackground: "#304156",
  colorBgMenuItemSelected: "#263445",
  colorBgMenuItemHover: "#263445",
  colorTextMenu: "#bfcbd9",
  colorTextMenuSecondary: "#8a97a8",
  colorTextMenuSelected: "#409eff",
  colorTextMenuActive: "#ffffff",
  colorTextMenuItemHover: "#ffffff",
  colorTextMenuTitle: "#ffffff",
  colorTextSubMenuSelected: "#409eff",
  colorTextCollapsedButton: "#8a97a8",
  colorTextCollapsedButtonHover: "#ffffff",
  menuSubArtBoard: "#304156",
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
      }}
    >
      <ProLayout
        title="知识工厂"
        // 🔴 logo 必须显式关掉：ProLayout 的默认 logo 是一条外网 CDN 图片地址，
        //    本地库断网也要能用，不该为一个图标去连外网。
        logo={false}
        layout="side"
        siderWidth={216}
        fixSiderbar
        fixedHeader
        route={{ path: "/", children: ROUTES }}
        location={{ pathname: selected }}
        // type=group：一级组显示成分组标题（过稿模版就是这个样子——所有二级页一屏看完）
        menu={{ type: "group" }}
        // 面包屑自己画在顶栏（ProLayout 自带的那份要配 PageContainer 才出现）
        breadcrumbRender={false}
        pageTitleRender={false}
        token={{ sider: SIDER_TOKEN }}
        menuItemRender={(item, dom) => {
          const todo = item.disabled === true;
          if (todo) {
            return (
              // 🔴 这里**不复用 dom**：dom 自带一层行高，套进来两行会被 40px 的
              //    菜单条从中间切开（实测：字被腰斩、「待开发」压在下一行）。
              //    置灰项自己画一行 flex，名字省略号、标签不换行。
              <span
                aria-disabled="true"
                title={`${typeof item.hint === "string" ? item.hint + " · " : ""}页还没建（AI:PRD-008 分期建设）`}
                style={{
                  cursor: "not-allowed",
                  // 只调色不调透明度：叠上侧栏本来就低的对比度，opacity 会让这几项
                  // **几乎看不见** —— 灰是「点不了」，不是「不给你看」。
                  color: "#93a2b5",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.name}
                </span>
                <span style={{ fontSize: 10, color: "#7d8ea3" }}>待开发</span>
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
        menuFooterRender={(props) =>
          props?.collapsed ? null : (
            <div
              style={{
                padding: "12px 16px",
                fontSize: 11.5,
                lineHeight: 1.8,
                color: "#8a97a8",
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
        {/* ── 顶栏：面包屑 + 那句权限说明（过稿模版的 .topbar）───────────────── */}
        <div
          style={{
            height: 48,
            background: "#fff",
            borderBottom: "1px solid #e4e7ed",
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 20px",
          }}
        >
          <Breadcrumb
            style={{ fontSize: 13 }}
            items={[
              { title: <Link href="/">知识工厂</Link> },
              ...(crumbs
                ? [{ title: crumbs.group }, { title: <b>{crumbs.name}</b> }]
                : []),
            ]}
          />
          <span
            style={{ marginLeft: "auto", fontSize: 12.5, color: "#606266" }}
          >
            无登录无权限（内部单人）· 写操作走 core / MCP
          </span>
        </div>

        {/* 🔴 红旗条留在内容区顶部、通栏（它回答「这库现在可不可信」，比任何一页都靠前） */}
        {flags}
        <div style={{ padding: "16px 20px 64px", maxWidth: 1280 }}>
          {children}
        </div>
      </ProLayout>
    </ConfigProvider>
  );
}

export default ConsoleShell;
