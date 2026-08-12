/**
 * 版式小件（学术风 v2 的 React 版）—— AI:PRD-001 WP6 起在首页用，AI:PRD-002 002-D 提出来共用。
 *
 * 正本 = prd/PRD-026/前端设计稿.html v2：纸感底 + 发丝线 + 学术绿 + 朱批红 + 2~3px 圆角。
 * 🔴 页面一律用这几件 + globals.css 的 token，别在页面里现调颜色 —— 一处改，全站跟。
 */
import { Alert, AlertDescription } from "~/components/ui/alert";

/** 一块纸：小标题（前缀绿书名号）+ 内容 */
export function Panel({
  title,
  right,
  children,
}: {
  title: string;
  /** 标题行右侧的小东西（计数、链接、开关表单…） */
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-hair bg-sheet rounded-[3px] border px-[18px] py-[15px]">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h3 className="panel-title text-mut text-[12px] font-semibold tracking-[1.5px]">
          {title}
        </h3>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

export const CHIP = {
  /** 绿：好 / 现役 */
  g: "text-acc-deep bg-acc-soft border-acc/30",
  /** 黄：留神 / 归档 */
  a: "text-amber bg-amber-soft border-amber/30",
  /** 朱批红：坏 / 已退役 */
  r: "text-pen bg-pen-soft border-pen/30",
  /** 灰：中性标签 */
  n: "text-mut bg-code border-hair",
} as const;

export function Chip({
  tone = "n",
  children,
}: {
  tone?: keyof typeof CHIP;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`mr-1.5 inline-block rounded-[2px] border px-[7px] text-[11px] leading-[1.6] ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

/** 考点状态 → 色调（全站一致：active 绿 / draft 黄 / merged 灰 / retired 红） */
export function statusTone(status: string | null): keyof typeof CHIP {
  switch (status) {
    case "active":
      return "g";
    case "draft":
      return "a";
    case "retired":
      return "r";
    default:
      return "n";
  }
}

/** 定义行：左标签右正文，底一根发丝线 */
export function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="border-hair flex items-baseline gap-3 border-b py-[5px] last:border-b-0">
      <span className="text-mut w-[92px] shrink-0 text-[11.5px] tracking-[0.5px]">
        {k}
      </span>
      <span className="min-w-0 flex-1 break-all">{v}</span>
    </div>
  );
}

/**
 * 操作回执条（server action 之后靠 ?ok= / ?err= 带回来的那句话）。
 * 🔴 错误一律朱批红、原文照登：本地工具页，把报错藏起来没有任何好处。
 */
export function Notice({
  tone,
  children,
}: {
  tone: "ok" | "err";
  children: React.ReactNode;
}) {
  const cls =
    tone === "err"
      ? "border-pen/30 bg-pen-soft text-pen"
      : "border-acc/30 bg-acc-soft text-acc-deep";
  return (
    <Alert className={`mb-3 rounded-[3px] ${cls}`}>
      <AlertDescription className="text-[12.5px] break-words whitespace-pre-wrap text-current">
        {tone === "err" ? "🔴 " : "✓ "}
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** 页头：大标题 + 一句副题 */
export function PageHead({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <div className="min-w-0">
        <h1 className="font-serif text-[23px] font-bold tracking-[1px]">
          {title}
        </h1>
        {sub ? (
          <div className="text-mut mt-[3px] text-[12.5px]">{sub}</div>
        ) : null}
      </div>
      {right ? <div className="ml-auto">{right}</div> : null}
    </div>
  );
}

/** 一屏数字（总览用）：数大、名小 */
export function Kpi({
  n,
  label,
  tone,
}: {
  n: number | string;
  label: string;
  tone?: "acc" | "pen" | "mut";
}) {
  const color =
    tone === "acc" ? "text-acc-deep" : tone === "pen" ? "text-pen" : "";
  return (
    <div className="border-hair bg-sheet rounded-[3px] border px-3 py-2">
      <div className={`num text-[21px] leading-tight ${color}`}>{n}</div>
      <div className="text-mut text-[11.5px]">{label}</div>
    </div>
  );
}
