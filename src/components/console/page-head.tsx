/**
 * 页头（AI:PRD-009 · 打磨检查单 ⑨⑩）—— 标题 + 一句话职责 + 右上角数据源
 *
 * 收编的是全站 25 页各抄一遍的那段 flex：
 *   `<div flex baseline gap12><h1 18px 600>标题</h1><span 12.5 灰>副题</span>
 *    <span marginLeft:auto><DataSourceNote>…</DataSourceNote></span></div>`
 * 抄得久了就漂：marginBottom 有 12 有 14、标题有的 nowrap 有的不 nowrap，
 * 换页时标题基线会跳一下。这里定死一份。
 *
 * 🔴 `flexWrap: wrap` + 副题/数据源可换行 = 手机上不再把标题挤成两个字一行
 *    （检查单 ⑤）。桌面宽度下换不换行看不出差别，窄屏才见效。
 * 🔴 没有 "use client"：调用方全是 server component。里面渲染的
 *    {@link DataSourceNote} 是 client 组件 —— server 渲 client 是合法组合，
 *    反过来（client 里 import server 组件）才不行。
 */
import type { ReactNode } from "react";

import { DataSourceNote } from "./ui";

export function PageHead({
  title,
  sub,
  source,
  right,
  tags,
  extra,
}: {
  title: ReactNode;
  /** 一句话说清这页管什么（检查单 ⑨：不写黑话，写点进来能得到什么） */
  sub?: ReactNode;
  /** 本页的数被谁算出来的：表名 / core 函数（自动套 DataSourceNote 壳） */
  source?: ReactNode;
  /**
   * 右上角**原样**塞一个节点（自己带壳时用它，如已经写好的 `<DataSourceNote>`）。
   * 🔴 存在的唯一理由 = 收编 b 组 `app/kg/pieces.tsx` 的 `PageTitle({right})`：
   *    签名对得上，收编时调用点一个字都不用改。新页请用 `source`。
   */
  right?: ReactNode;
  /** 标题右边紧跟的徽章（状态 tag 之类） */
  tags?: ReactNode;
  /** 右上角额外挂件（按钮/开关）；有它时数据源退到它左边 */
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 14,
      }}
    >
      <h1
        style={{
          fontSize: 18,
          fontWeight: 600,
          margin: 0,
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </h1>
      {tags}
      {sub ? (
        <span style={{ fontSize: 12.5, color: "#909399" }}>{sub}</span>
      ) : null}
      {source ? (
        <span
          style={{
            marginLeft: "auto",
            textAlign: "right",
            maxWidth: "100%",
          }}
        >
          <DataSourceNote>{source}</DataSourceNote>
        </span>
      ) : null}
      {right ? (
        <span
          style={{
            marginLeft: source ? 12 : "auto",
            textAlign: "right",
            maxWidth: "100%",
          }}
        >
          {right}
        </span>
      ) : null}
      {extra ? (
        <span style={{ marginLeft: (source ?? right) ? 12 : "auto" }}>
          {extra}
        </span>
      ) : null}
    </div>
  );
}

export default PageHead;
