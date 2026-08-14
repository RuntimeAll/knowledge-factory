"use client";

/**
 * 管理台通用小件（AI:PRD-008 · 地基）—— 设计稿 §三「通用规范」的代码化
 *
 * 🔴 全站一致靠这几件，别在页面里现搓 Tag 颜色/时间格式/ULID 截断：
 *      状态 tag 色：active=绿 / draft=蓝 / pending=橙 / rejected·red=红 / retired·merged=灰
 *      时间：`MM-DD HH:mm`（悬停全量）
 *      ULID：显示尾 6 位 + 复制按钮
 *      空态：口径文案原句（「没有数据」≠「没有错误」这类），不留白页
 *      每页右上角「本页数据源」小字（表名 / core 函数），方便对库排查
 *
 * 🔴 本文件是 client 组件，但**不取数**：所有数字都由 server component 现算后传进来。
 * 🔴 时间只做字符串切片（`2026-08-13T18:12:33+08:00` → `08-13 18:12`），
 *    不 new Date()：服务端与浏览器时区/本地化不同会造成 hydration 不一致，
 *    而库里存的本来就是**本地** ISO（core/time.ts 口径），切出来就是对的。
 */
import { Card, Empty, Statistic, Tag, Tooltip, Typography } from "antd";
import Link from "next/link";

// ---------------------------------------------------------------------------
// 状态 tag
// ---------------------------------------------------------------------------

/** 状态 → antd tag 色（设计稿 §三 那五档；认不出来的一律灰，不猜） */
export const STATUS_COLOR: Record<string, string> = {
  // 绿：现役 / 好
  active: "green",
  passed: "green",
  committed: "green",
  resolved: "green",
  ok: "green",
  calc_verified: "green",
  // 蓝：草稿 / 在途
  draft: "blue",
  proposed: "blue",
  analysis_only: "blue",
  // 橙：等人处置
  pending: "orange",
  open: "orange",
  warn: "orange",
  no_solution: "orange",
  // 红：坏 / 被拒
  rejected: "red",
  red: "red",
  quarantine: "red",
  failed: "red",
  // 灰：退役 / 已并
  retired: "default",
  merged: "default",
  deprecated: "default",
  // 🔴 批改线三态（集成收口②收编：原来 `app/grading/shared.ts` 里另有一份
  //    REVIEW_STATUS_TONE 自成色表 —— 同一个壳里两张色表，`pending` 在两处
  //    还刚好同色，于是没人发现它是两份。并进来后那份只留 label/hint 文案）：
  //      pending 已在上面（橙）· rework=红（要返工）· confirmed=绿（已终审）
  confirmed: "green",
  rework: "red",
};

export function StatusTag({
  value,
  title,
}: {
  value: string | null | undefined;
  title?: string;
}) {
  if (!value) return <Tag color="default">—</Tag>;
  const tag = <Tag color={STATUS_COLOR[value] ?? "default"}>{value}</Tag>;
  return title ? <Tooltip title={title}>{tag}</Tooltip> : tag;
}

// ---------------------------------------------------------------------------
// 时间 / ID
// ---------------------------------------------------------------------------

/** 本地 ISO → `MM-DD HH:mm`（拿不到就返回空串，绝不编一个"现在"） */
export function shortTime(iso: string | null | undefined): string {
  if (!iso || iso.length < 16) return "";
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

export function TimeText({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span style={{ color: "#909399" }}>时间未记</span>;
  return (
    <Tooltip title={iso}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {shortTime(iso)}
      </span>
    </Tooltip>
  );
}

/**
 * 内容 hash：显示**前 8 位** + 复制（集成收口②收编，原来 `output/table.tsx` 与
 * `sku/[id]/panels.tsx` 各内联一份）。
 *
 * 🔴 与 {@link IdTail} 分成两件而不是加个 flag：hash 认**前缀**（`a3f1c9…`，
 *    内容寻址仓的目录就是按前缀分的），ULID 认**尾 6 位**（前缀是时间，
 *    同一批入库的题前缀全一样，截前面等于没截）。两种截法混用会让人
 *    照着屏幕上的短串去仓里找不到文件。
 */
export function HashTail({ hash }: { hash: string }) {
  return (
    <Tooltip title={hash}>
      <Typography.Text
        copyable={{ text: hash, tooltips: ["复制全 hash", "已复制"] }}
        style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12 }}
      >
        {hash.slice(0, 8)}…
      </Typography.Text>
    </Tooltip>
  );
}

/** ULID 主键：显示尾 6 位（含前缀），全量在悬停里，点小图标复制整串 */
export function IdTail({ id }: { id: string }) {
  const tail = id.length > 8 ? `…${id.slice(-6)}` : id;
  return (
    <Tooltip title={id}>
      <Typography.Text
        copyable={{ text: id, tooltips: ["复制全 id", "已复制"] }}
        style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12 }}
      >
        {tail}
      </Typography.Text>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 提示条 / 空态 / 数据源
// ---------------------------------------------------------------------------

/**
 * 写操作提示条：**数据生产类的写一律不在页面上做**（设计稿 §〇·3），
 * 页面只给一句能直接粘的命令。
 */
export function CopyCmd({ label, cmd }: { label: string; cmd: string }) {
  return (
    <span
      style={{
        fontSize: 12,
        color: "#909399",
        background: "#f4f4f5",
        border: "1px dashed #e4e7ed",
        borderRadius: 2,
        padding: "3px 8px",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {label}
      <Typography.Text
        code
        copyable={{ text: cmd, tooltips: ["复制命令", "已复制"] }}
        style={{ fontSize: 12 }}
      >
        {cmd}
      </Typography.Text>
    </span>
  );
}

/** 空态：口径原句照登（「没有数据」不是「没有错误」这类话，一个字不许省） */
export function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <span style={{ fontSize: 12.5, color: "#606266" }}>{children}</span>
      }
    />
  );
}

/** 每页右上角固定：本页的数是从哪儿来的（表名 / core 函数） */
export function DataSourceNote({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11.5, color: "#909399" }}>
      本页数据源：{children}
    </span>
  );
}

/**
 * 长文一行截断 + 悬停看全文（AI:PRD-009 · 检查单 ③）。
 *
 * 🔴 截断必须配 tooltip：只截不给全文 = 把信息删了还不告诉人。
 * 🔴 `maxWidth` 用 px 不用 %：手搓 `<td>` 里百分比宽度算不出稳定值，
 *    列会随内容抖动（同一张表刷新两次列宽不一样）。
 */
export function LongText({
  text,
  maxWidth = 240,
  mono,
}: {
  text: string;
  maxWidth?: number;
  /** id / 路径这类要逐字符看的，用等宽 */
  mono?: boolean;
}) {
  return (
    <Tooltip title={text}>
      <span
        style={{
          display: "inline-block",
          maxWidth,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          verticalAlign: "bottom",
          ...(mono
            ? { fontFamily: "Consolas, Menlo, monospace", fontSize: 11.5 }
            : {}),
        }}
      >
        {text}
      </span>
    </Tooltip>
  );
}

/**
 * 「这一格读不出来」的统一形态（AI:PRD-009 · 检查单 ②）。
 *
 * 🔴🔴 存在的理由：读失败时**绝不能退化成 0 / 空 / 绿**。
 *    「隔离区 0 条」和「隔离区读不出来」在屏幕上长得一样的话，
 *    一次库连不上会被读成「今天没活儿」—— 这是监督面能犯的最坏的错。
 *    所以失败一律出这枚灰红标，原文挂在悬停里。
 */
export function Unreadable({ why }: { why?: string | null }) {
  return (
    <Tooltip title={why ?? "读这一项时抛了异常，原文见页面顶部的错误条"}>
      <Tag color="red" style={{ opacity: 0.85 }}>
        读不出
      </Tag>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 统计卡
// ---------------------------------------------------------------------------

/**
 * 工作台的一张统计卡。
 * 🔴 `todo` = 目标页还没建：卡照显（数是真的），但**不给链接**——
 *    点进去 404 比不能点更糟。
 */
export function StatCard({
  label,
  value,
  sub,
  href,
  todo,
}: {
  label: string;
  value: number | string;
  sub?: string;
  href?: string;
  todo?: boolean;
}) {
  const body = (
    <Card
      size="small"
      hoverable={!todo && !!href}
      styles={{ body: { padding: 14 } }}
    >
      <Statistic
        title={<span style={{ fontSize: 12.5 }}>{label}</span>}
        value={value}
        valueStyle={{ fontSize: 24, color: todo ? "#909399" : "#409eff" }}
      />
      <div style={{ marginTop: 2, fontSize: 11.5, color: "#909399" }}>
        {todo ? `${sub ? sub + " · " : ""}明细页待开发` : (sub ?? "")}
      </div>
    </Card>
  );
  if (todo || !href) return body;
  return (
    <Link href={href} style={{ color: "inherit" }}>
      {body}
    </Link>
  );
}
