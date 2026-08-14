/**
 * 批改流水线四页的线上契约（AI:PRD-008 · PRD-027 交互面）
 *
 * 🔴 与 question/shared.ts、queue/rows.ts 同一个理由：`/api/grading/*`（server）
 *    与四张页面的 client 组件要说同一种话，类型放这儿两边 import。
 * 🔴 本文件**不 import ~/core**：client 顺着它 import 会把 libsql / node:sqlite
 *    打进浏览器包。枚举与常量由 server 页面读出来当 props 传下去。
 *
 * ── 这四页的边界（PRD-008 设计稿 §二·收卷录入/看板/判据/报告架） ──────────────
 *   写：**只有收卷录入**（白名单五类之一）——写 `收件箱/<代号>/<时间戳>/` 的新照片
 *       + 向 `收件箱/_队列.jsonl` 追加一行。跨线契约 §一：管理台上传 API 是
 *       收件箱的**唯一写入方**（只写新增，不改不删）。
 *   读：审核.db 一律 mode=ro（G-1 红线）；订阅特训/学员/ 是产线运行态，只读。
 *   本组页面**一行都不写审核.db、不写圣域文件**。
 */

// ---------------------------------------------------------------------------
// 收卷录入
// ---------------------------------------------------------------------------

/**
 * 卷型。
 * 🔴 判型只切**锚定闸**（手抄必开 stem_seen），不改判定口径
 *    （PRD-027 设计稿 §二 认卷模块）。默认 auto = 交给认卷模块自己认，
 *    认不出才问人 —— 页面不替它猜。
 */
export const PAPER_KINDS = ["auto", "手抄", "打印"] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];

export const PAPER_KIND_LABEL: Record<PaperKind, string> = {
  auto: "自动识别（默认）",
  手抄: "手抄版",
  打印: "打印版",
};

/** 允许上传的照片扩展名（小写，带点） */
export const PHOTO_EXTS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
] as const;

/** 一次提交最多几张（拍一份卷子不该超过这个数；超了多半是选错了目录） */
export const MAX_PHOTOS = 30;
/** 单张上限（手机原图 ~5MB，留三倍余量） */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/**
 * 收件事件流的一行（跨线契约 §二·6 的形状）。
 *
 * 🔴 契约规定四键：`{ts, code, files, status:"收件中"}`，**append-only 永不改旧行**。
 * 🔴 `卷型` 是四键之外的**可选第五键**，只在用户手选（非 auto）时才写：
 *    JSON 对象加键对读方是向后兼容的（watcher 忽略未知键即可），
 *    但它仍算契约超集 —— 已列进本卡 TODO，等 027 通报确认后定稿。
 */
export interface IntakeQueueLine {
  ts: string;
  code: string;
  files: string[];
  status: string;
  卷型?: PaperKind;
}

/** 最近录入表的一行（坏行也占一行：原文照登，不静默跳过） */
export interface IntakeRecentRow {
  /** 文件里的第几行（1 起）—— 同一秒两次提交也分得开 */
  lineNo: number;
  ts: string | null;
  code: string | null;
  files: string[];
  status: string | null;
  paperKind: string | null;
  /** 解析不了的坏行：原样贴出来 */
  badLine?: string;
  parseError?: string;
}

export interface IntakeRecentResponse {
  ok: boolean;
  /** ok=false 时的原文报错 */
  error?: string;
  data: IntakeRecentRow[];
  total: number;
  /** 队列文件绝对路径（页面要说清楚写到哪儿去了） */
  queuePath: string;
  /** 文件还不存在 = 还没提交过第一批，**不是故障** */
  exists: boolean;
  /** 文件总行数（data 只取尾 20 行） */
  lines: number;
}

export interface IntakeSubmitResponse {
  ok: boolean;
  /** ok=false 时的原文报错（写了一半也如实说写进去几张） */
  error?: string;
  /** 照片落到哪个目录（绝对路径原文回显） */
  dir?: string;
  /** 实际写盘的文件名（按提交顺序，序号前缀已加） */
  saved?: string[];
  /** 追加进 _队列.jsonl 的那一行原文（没追加就没有这一项） */
  line?: string;
  queuePath?: string;
  /**
   * 收下了、但有话说（例：这个代号只在圣域出现过，roster 里没登记）。
   * 🔴 与 error 分开：它不是失败，但也不能不说。
   */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// 批改看板
// ---------------------------------------------------------------------------

/**
 * 批次状态（PRD-027 设计稿 §四 状态机）。
 *
 * 🔴 唯一事实源纪律：**照片一进 收卷.py，状态一律以 审核.db 为准**。
 *    所以「收件中」只来自 `_队列.jsonl`，后四态全部由 审核.db 现推；
 *    「待认卷」属编排台账（grading-pipeline，PRD-027 包② 未建）——
 *    本页现在推不出它，宁可缺一态，也不拿别处的数据冒充。
 */
export const BOARD_STATES = [
  "收件中",
  "待认卷",
  "批改中",
  "待审核",
  "已放行",
  "已出件",
  "状态未知",
] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export interface BoardRow {
  key: string;
  /** 收件段（_队列.jsonl）／批改段（审核.db） */
  seg: "收件" | "批改";
  /** 收件段=提交时刻；批改段=批次 created_at */
  ts: string | null;
  student: string | null;
  /** 打卡次 = 该学员自己的第几次（审核.db batches.day，≠ 线的第几天） */
  day: number | null;
  /** 卷（挂上桥才知道是哪张：线 + 该线第几天） */
  paper: string | null;
  /** 挂不上桥时的原因原文（不静默丢） */
  paperNote: string | null;
  state: BoardState;
  stateNote: string | null;
  /** 档位留痕：'L1静默' / 'L2代审' / null=人工点的 */
  auto: string | null;
  /** 存疑题数（verdict_pre ∈ {?,doubt,missing} 或 needs_human=1） */
  doubt: number | null;
  itemCount: number | null;
  /** 得分（题数口径：分母已摘掉 skip 漏抄） */
  score: string | null;
  batchId: number | null;
  round: number | null;
  /** 打回次数（feedback 行数） */
  reworks: number;
  matched: boolean | null;
  fileCount: number | null;
  confirmedAt: string | null;
  exportedAt: string | null;
}

export interface BoardMeta {
  bridgeMatched: number;
  bridgeTotal: number;
  bridgeCoverage: string;
  queueExists: boolean;
  queuePath: string;
  gradingDbPath: string | null;
  /**
   * 审核.db items 有没有 zooms 列。
   * 🔴 现在没有（PRD-027 包① 交付记录 L2）⇒「放大预算」这一列**算不出**，
   *    页面照实说，绝不拿 agent 自报数编一个。
   */
  zoomColumn: boolean;
  warnings: string[];
}

export interface BoardResponse {
  ok: boolean;
  error?: string;
  data: BoardRow[];
  total: number;
  meta: BoardMeta | null;
}

/** 审核台（PRD-027 自己的页，独立进程）—— 看板只给直链，不代管 */
export const REVIEW_CONSOLE_URL = "http://127.0.0.1:7801";

// ---------------------------------------------------------------------------
// 报告架
// ---------------------------------------------------------------------------

export interface ReportRow {
  key: string;
  code: string;
  file: string;
  bytes: number;
  /** 文件名里的天号（`第0N天…`）；没有天号就是 null —— 不猜 */
  day: number | null;
  /** 对上的批次（按 (代号, day) 撞 审核.db batches） */
  batchId: number | null;
  /** 对不上时说清楚为什么 */
  batchNote: string;
  /** 出件时间（对上批次才有：batches.exported_at） */
  exportedAt: string | null;
  /** 文件修改时间（兜底，标注来源） */
  mtime: string;
  timeSource: "批次 exported_at" | "文件修改时间";
}

export interface ReportsResponse {
  ok: boolean;
  error?: string;
  data: ReportRow[];
  total: number;
  /** 扫描根目录（绝对路径，页面上要看得见扫的是哪儿） */
  root: string;
  warnings: string[];
}
