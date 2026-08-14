/**
 * 管理台「手搓表」的共享件（AI:PRD-009 · 打磨检查单 ③⑤⑩）
 *
 * 为什么还有手搓表：/（工作台）、/health 这几页的表是**固定几行的摘要**，
 * 不需要筛选/排序/分页，上 ProTable 反而重。但它们各自 copy 一份 TH/TD 常量
 * 就是设计稿 §三·10「一致性」的反面 —— 工作台 padding 8px、/health padding 7px，
 * 字号一个 13 一个 12.5，两页并排看得出错位。这里收一份，谁都别再抄。
 *
 * 🔴 本文件**没有 "use client"**：三处调用方都是 server component，
 *    而 `TH`/`TD` 是普通对象 —— 从 "use client" 模块导出的普通对象在 RSC 里
 *    拿到的是 client reference 代理，`{...TH}` 展开当场就炸。样式常量必须住在
 *    这种两边都能 import 的普通模块里（client 侧 import 它也照样能用）。
 * 🔴 组件里不放任何 hook / 事件 —— 一旦放了，本文件就必须变成 client 模块，
 *    上面那条约束立刻失效。
 */
import type { CSSProperties, ReactNode } from "react";

/** 表头单元格（全站同一套：底色 #f5f7fa、12.5px、左对齐） */
export const TH: CSSProperties = {
  background: "#f5f7fa",
  color: "#606266",
  fontWeight: 500,
  fontSize: 12.5,
  textAlign: "left",
  padding: "7px 10px",
  borderBottom: "1px solid #ebeef5",
  whiteSpace: "nowrap",
};

/** 表体单元格 */
export const TD: CSSProperties = {
  padding: "7px 10px",
  borderBottom: "1px solid #ebeef5",
  fontSize: 12.5,
  verticalAlign: "top",
};

/** 数字列：等宽数字，位数对齐（检查单 ③「数字 tabular」） */
export const NUM: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/** id / hash / 命令这类要逐字符看的东西 */
export const MONO: CSSProperties = {
  fontFamily: "Consolas, Menlo, monospace",
  fontSize: 11.5,
};

/**
 * 横向滚动壳（检查单 ⑤「移动端」）。
 *
 * 🔴 手机上宽表的正解是**表自己横滚**，不是让整页横滚：
 *    页面 body 一旦能左右拖，读一行字都得来回划。所以每张宽表都套一层这个，
 *    里面钉一个 `min` 保证列不被挤成竖着的一个字。
 */
export function ScrollX({
  min = 640,
  children,
}: {
  /** 表的最小宽度（窄于它就出横向滚动条） */
  min?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <div style={{ minWidth: min }}>{children}</div>
    </div>
  );
}

/** `<table>` 的统一底样式（配合 TH/TD 用） */
export const TABLE: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

// ---------------------------------------------------------------------------
// 组件形态（= b 组 `app/kg/pieces.tsx` 的收编靶子）
//
// 🔴 收编说明（AI:PRD-009 · d 组）：b 组在 kg/** 与 queue/** 就地内联了一份同款
//    版面原语并标了「待 d 组收编」。两边的数值本来就一模一样（padding 7px 10px /
//    12.5px / #f5f7fa / th nowrap），所以这里按**它的签名**补齐组件形态，
//    收编时是一次纯 import 替换，不用改任何调用点的写法：
//        `~/app/kg/pieces` 的 Th/Td/TableBox/Num/KV → `~/components/console/table`
//        `~/app/kg/pieces` 的 PageTitle            → `~/components/console/page-head` 的 PageHead
//    （PageHead 已补 `tags` / `right` 两个 prop，与 PageTitle 逐个对得上）
//    换完把 kg/pieces.tsx 删掉 —— 🔴 别在两处各留一份，那正是这一轮要治的病。
// 🔴 组件形态与上面的常量形态**共用同一份数值**（Th/Td 直接展开 TH/TD）：
//    两种写法可以并存，但"尺子"只能有一把。
// ---------------------------------------------------------------------------

/** 表头单元格（组件形态） */
export function Th({
  children,
  width,
}: {
  children: ReactNode;
  width?: number;
}) {
  return <th style={{ ...TH, ...(width ? { width } : {}) }}>{children}</th>;
}

/** 表体单元格（组件形态） */
export function Td({
  children,
  num,
  nowrap,
}: {
  children: ReactNode;
  /** 数字列：tabular-nums 对齐 */
  num?: boolean;
  nowrap?: boolean;
}) {
  return (
    <td
      style={{
        ...TD,
        ...(num ? NUM : {}),
        ...(nowrap ? { whiteSpace: "nowrap" as const } : {}),
      }}
    >
      {children}
    </td>
  );
}

/** 表格外壳 + `<table>` 一体件（横滚同 {@link ScrollX}） */
export function TableBox({
  min = 420,
  children,
}: {
  min?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ overflowX: "auto", width: "100%" }}>
      <table style={{ ...TABLE, minWidth: min }}>{children}</table>
    </div>
  );
}

/** 数字：tabular-nums（检查单 ③）；0 灰掉，让非零跳出来 */
export function Num({
  n,
  tone,
  big,
}: {
  n: number;
  tone?: "ok" | "warn" | "bad";
  big?: boolean;
}) {
  const color =
    n === 0
      ? "#c0c4cc"
      : tone === "bad"
        ? "#f56c6c"
        : tone === "warn"
          ? "#e6a23c"
          : tone === "ok"
            ? "#67c23a"
            : undefined;
  return (
    <span
      style={{
        ...NUM,
        fontSize: big ? 15 : undefined,
        fontWeight: n === 0 ? undefined : 600,
        color,
      }}
    >
      {n}
    </span>
  );
}

/** 一行「标签 : 值」（antd Descriptions 撑不开的地方用） */
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        padding: "5px 0",
        borderBottom: "1px solid #f0f2f5",
        fontSize: 12.5,
      }}
    >
      <span
        style={{ width: 92, flexShrink: 0, color: "#909399", fontSize: 11.5 }}
      >
        {k}
      </span>
      <span style={{ minWidth: 0, flex: 1, wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}
