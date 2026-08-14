"use client";

/**
 * 写操作的**统一二次确认**（AI:PRD-009 · 打磨检查单 §三·7）—— 全站唯一一份
 *
 * ── 收编来历（集成收口②，2026-08-14）─────────────────────────────────────────
 *   打磨批四组各自内联了一份「确认提交按钮」，形态三样：
 *     · b 组 `app/kg/confirm.tsx`  ：Popconfirm 弹层 + 影响面 + useFormStatus 防连点
 *     · c 组 `app/sku/[id]/status/submit.tsx`：只有 useFormStatus 防连点，**没有弹层**
 *     · d 组 未内联（只提了收编建议）
 *   b 组的收编说明写得明白：合并**以 b 组这份为准**，把 c 组的 `cancelHref`
 *   并进来。本文件即合并结果 —— 两份内联件已删，全站 import 指这里。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 *   检查单 §三·7：「全部写操作统一形态（列明影响面）」。原来三种写法并存：
 *   ① 裸 submit 按钮（切版本树状态、加/删别名、处置台逐行通过）——点下去直接改库；
 *   ② 确认页 + 裸 submit（退役 / 合并 / 驳回 / 上下架）；
 *   ③ Popconfirm（少数几处）。现在统一成 ③：**确认页照旧留着**（破坏性动作的
 *   定式不改，PRD-003-D 立的规矩），但最后那一下一律再弹一层，
 *   把「按下去会动哪些行」写进弹层。
 *
 * 🔴 只包按钮，不碰 action：表单的 `action={serverAction}` 一个字没动，
 *    确认后走 `form.requestSubmit()` —— 与人手点 submit 完全同一条路径
 *    （server action 里的校验、审计、回执全部照旧）。
 * 🔴 `useFormStatus` 拿提交中状态 ⇒ 按钮转圈 + 禁用（检查单 §三·1「加载态」，
 *    顺带堵住"连点两下写两次"这种真实事故：server action 那一跳几十~几百 ms，
 *    连点两下 = 两条审计行）。
 * 🔴 本文件是 client 组件但**不取数**：所有影响面文案由调用页（server component）
 *    现算好后当 props 传进来。
 */
import { Button, Popconfirm } from "antd";
import Link from "next/link";
import { useRef } from "react";
import { useFormStatus } from "react-dom";

export interface ConfirmSubmitProps {
  /** 按钮上的字：说清楚点下去发生什么（检查单 §三·9，别写「确定」「提交」） */
  label: string;
  /** 弹层标题：一句问句 */
  title: string;
  /** 🔴 弹层正文 = **影响面**：会动哪些表 / 多少行 / 可不可逆 */
  description: React.ReactNode;
  okText?: string;
  /** 破坏性动作 = 红按钮 + 红确认键 */
  danger?: boolean;
  /** 主行动按钮（primary 实心）；否则线框 */
  primary?: boolean;
  disabled?: boolean;
  /** 禁用时的悬停解释（为什么点不了） */
  disabledReason?: string;
  size?: "small" | "middle";
  /**
   * 确认**页**用：按钮右边摆一条「取消（什么都不改）」回头路（收编自 c 组那份）。
   * 🔴 提交中不显示取消：这时候跳走只会让人以为没改成，实际库已经在改了 ——
   *    换成一句「改完会自动回去，页面上会有一条回执」。
   * 行内按钮（表格里那种）不传它，取消 = 关掉弹层本身。
   */
  cancelHref?: string;
  /** 确认页那档按钮通常更大更显眼（默认 small 是给行内用的） */
  block?: boolean;
}

export function ConfirmSubmit({
  label,
  title,
  description,
  okText,
  danger,
  primary,
  disabled,
  disabledReason,
  size = "small",
  cancelHref,
  block,
}: ConfirmSubmitProps) {
  // 🔴 不用 form id 对表单：确认页里同页可能有两个表单（重投 / 废弃），
  //    靠 DOM 里"自己所在的那个 form"最不容易接错线。
  const anchor = useRef<HTMLSpanElement>(null);
  const { pending } = useFormStatus();

  const btn = (
    <Popconfirm
      title={title}
      description={
        <div style={{ maxWidth: 420, fontSize: 12.5, lineHeight: 1.85 }}>
          {description}
        </div>
      }
      okText={okText ?? "确认"}
      cancelText="再想想"
      okButtonProps={{ danger }}
      disabled={disabled === true || pending}
      onConfirm={() => anchor.current?.closest("form")?.requestSubmit()}
    >
      <Button
        size={block ? "middle" : size}
        danger={danger}
        type={primary && !danger ? "primary" : block ? "primary" : "default"}
        ghost={primary && !danger}
        loading={pending}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
      >
        {pending ? "正在改库…" : label}
      </Button>
    </Popconfirm>
  );

  if (!cancelHref) {
    return (
      <span ref={anchor} style={{ display: "inline-flex" }}>
        {btn}
      </span>
    );
  }

  return (
    <span
      ref={anchor}
      style={{ display: "inline-flex", alignItems: "center", gap: 14 }}
    >
      {btn}
      {pending ? (
        <span style={{ fontSize: 13, color: "#909399" }}>
          改完会自动跳回去，页面上会有一条回执
        </span>
      ) : (
        <Link href={cancelHref} style={{ fontSize: 13 }}>
          取消（什么都不改）
        </Link>
      )}
    </span>
  );
}

/**
 * 不需要确认的提交（搜索这类只读表单）：只要一个「提交中」的态。
 * 🔴 搜索**不是写操作**，不给它套确认弹层 —— 一切写才需要拦一道。
 */
export function PlainSubmit({
  label,
  primary,
}: {
  label: string;
  primary?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      size="small"
      htmlType="submit"
      type={primary ? "primary" : "default"}
      loading={pending}
    >
      {label}
    </Button>
  );
}

export default ConfirmSubmit;
