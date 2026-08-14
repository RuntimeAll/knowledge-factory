/**
 * 批改流水线各页的线上契约（AI:PRD-008 起 · PRD-027 交互面；AI:PRD-009 加终审台）
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

/**
 * 旧审核台（PRD-027 自己的进程 :7801）。
 * 🔴 AI:PRD-009 起终审已内化到 `/grading/review`，这个地址只作**可退役的旧 UI**
 *    在终审台页脚留一句话 —— 看板/终审的按钮一律指内链，不再往外送人。
 */
export const REVIEW_CONSOLE_URL = "http://127.0.0.1:7801";

// ---------------------------------------------------------------------------
// 终审台（AI:PRD-009 · 设计稿 §一 D-A「审核内化 = 换 UI 不碰写逻辑」）
// ---------------------------------------------------------------------------

/**
 * 终审三态 —— 🔴 逐字等于 `审核库.py` 的 `VERDICTS = ('√', '×', SKIP)`。
 * 一个字都不许在这边发明：这三个字符会原样写进 `items.verdict_final`，
 * 下游 `批改.py` / `photo_mark.py` 按它们出卷面与报告。
 *
 *   √     对
 *   ×     错（2026-08-11 起替代老库的 ○，老库已被 PRAGMA user_version=1 迁过）
 *   skip  「去掉」：不算对、不算错、**不进分母**、不进考点统计、不上卷面
 */
export const VERDICTS = ["√", "×", "skip"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABEL: Record<Verdict, string> = {
  "√": "对",
  "×": "错",
  skip: "去掉（不计入这次批改）",
};

/**
 * 批次状态。🔴 schema 注释只写了 pending/confirmed，`rework` 是后加的（实库三值）。
 * 认不出的值一律原样端出来标「状态未知」，不猜。
 */
export const REVIEW_STATUSES = ["pending", "rework", "confirmed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "待审核",
  rework: "已打回 · 待重批",
  confirmed: "已确认",
};

/**
 * 🔴 批次状态的**颜色**不在这儿：集成收口②已把 `confirmed` / `rework` 并进
 *    `~/components/console/ui` 的 `STATUS_COLOR`（`pending` 本来就在那张表里）。
 *    本线两处用色的地方（终审台列表 / 逐题终审页）直接查那张表 ——
 *    同一个壳里两张色表，`pending` 又刚好同色，是最难发现的那类不一致。
 *    这儿只留**文案**（label / 未知话术）：文案是批改线自己的话，不进共享件。
 */

/** 认不出的状态值统一话术（三值之外一律不猜，原样端出来） */
export function reviewStatusUnknownHint(status: string): string {
  return `审核.db batches.status=${JSON.stringify(status)} —— 不是 pending / rework / confirmed，本页不猜它是什么`;
}

/** 「近期已确认」取多少条 —— 审核台 `/api/confirmed` 把 limit 写死 10，这里照抄 */
export const REVIEW_CONFIRMED_LIMIT = 10;

/** 存疑的预判值面（与看板 DOUBT_PRE 同口径；`?` 不是合法终审值） */
export const DOUBT_VERDICT_PRE = ["?", "doubt", "missing"] as const;

/** 一道题（= 审核.db items 一行，列名转驼峰） */
export interface ReviewItem {
  qno: number;
  /** items.page（INTEGER DEFAULT 1）；ingest 缺省回落 `1 if qno<=10 else 2` */
  page: number;
  /** 题面：入库时已 `tex2txt()` 归一化，**前端原样印**，不再渲染 LaTeX */
  qtext: string | null;
  refAns: string | null;
  answerRaw: string | null;
  /** items.lines 存的 JSON 数组（解析不了就空数组 + 把原文挂 linesRaw） */
  lines: string[];
  linesRaw: string | null;
  note: string | null;
  /**
   * 错因考点码。
   * 🔴 三态分明：`null` = 库里就是 NULL（整段不显示）；`[]` = 显示「不归因(非技能失分)」；
   *    有码 = 按 err_kp.json 正本翻中文。
   * 🔴 审核台的 `/api/pending` 这一列给的是**字符串**（只 parse 了 lines），
   *    前端再 `JSON.parse` 一次；本产品在服务端就 parse 好，坏 JSON 走 errorKpError。
   */
  errorKp: string[] | null;
  errorKpRaw: string | null;
  errorKpError?: string;
  /** '√' / '×' / '?'（`?` = 交人工，**不是**合法终审值） */
  verdictPre: string | null;
  /** '√' / '×' / 'skip' / null=未终审 */
  verdictFinal: string | null;
  needsHuman: boolean;
  confidence: number | null;
}

/** 一条打回反馈（feedback 表，新的在前） */
export interface ReviewFeedback {
  round: number | null;
  body: string;
  createdAt: string | null;
  /** 非空 = agent 已重批（ingest/撤回时统一标记） */
  resolvedAt: string | null;
}

/** 列表页一行 = 一个批次（批次 = UNIQUE(student, day)） */
export interface ReviewBatchBrief {
  key: string;
  batchId: number;
  student: string;
  day: number;
  /** 原样端出（三值之外的原样保留，页面标「状态未知」） */
  status: string;
  round: number;
  createdAt: string | null;
  confirmedAt: string | null;
  exportedAt: string | null;
  /** null=人工 / 'L1静默' / 'L2静默' / 'L2代审' */
  auto: string | null;
  itemCount: number;
  /** verdict_pre ∈ {?,doubt,missing} 或 needs_human=1 */
  doubtCount: number;
  doubtQnos: number[];
  /** 已落 verdict_final 的题数（未终审 = itemCount - judgedCount） */
  judgedCount: number;
  pages: number[];
  feedbackCount: number;
  /** 还没被标 resolved_at 的反馈条数（= agent 还没重批） */
  openFeedbackCount: number;
}

/** 一页原图在不在盘上（不在也要列出来，并说清找的是哪条路径） */
export interface ReviewPhoto {
  page: number;
  exists: boolean;
  /** 绝对路径原文（页面上要看得见我们找的是哪儿） */
  path: string;
}

export interface ReviewBatchDetail extends ReviewBatchBrief {
  items: ReviewItem[];
  feedback: ReviewFeedback[];
  photos: ReviewPhoto[];
}

/** 错因码 → 中文（正本 = `_产线/err_kp.json`；读不到就 ok=false，绝不退化成空表） */
export interface ReviewKpDict {
  ok: boolean;
  version: string | null;
  path: string;
  cn: Record<string, string>;
  error?: string;
}

export interface ReviewConfirmedRow {
  key: string;
  student: string;
  day: number;
  confirmedAt: string | null;
  round: number;
  auto: string | null;
}

export interface ReviewListResponse {
  ok: boolean;
  error?: string;
  data: ReviewBatchBrief[];
  total: number;
  /** 页尾只读小节（放行来源看得见才追得回责） */
  confirmed: ReviewConfirmedRow[];
  gradingDbPath: string | null;
  warnings: string[];
}

export interface ReviewBatchResponse {
  ok: boolean;
  error?: string;
  data: ReviewBatchDetail | null;
  kp: ReviewKpDict;
  gradingDbPath: string | null;
  warnings: string[];
}

// ── 三个写动作的入参（🔴 每一个都对应 审核库.py 的一条 CLI 原语） ─────────────

export interface ConfirmRequest {
  student: string;
  day: number;
  /** {题号: '√'|'×'|'skip'}，🔴 必须**全题**都给（缺一道 CLI 就拒） */
  verdicts: Record<string, Verdict>;
  /** 已 confirmed 的批次要再确认一次，必须显式点头（会覆盖 confirmed_at 与放行来源） */
  allowReconfirm?: boolean;
}

export interface ReworkRequest {
  student: string;
  day: number;
  /** 哪里不对（空白 CLI 直接拒：「空反馈等于没说，agent 不知道要改什么」） */
  body: string;
}

export interface UnreworkRequest {
  student: string;
  day: number;
}

/**
 * 写回执。
 *
 * 🔴 两半都要给，缺一不可：
 *   ① **CLI 原文**（argv / exitCode / stdout / stderr）—— 圣域说了什么就上墙什么，
 *      不缩成「成功/失败」。审核库.py 的闸拒绝一律 exit 1 + stderr 人话，那句话
 *      本身就是操作指引（「要直接确认请先撤回打回：python 审核库.py unrework …」）。
 *   ② **事后 ro 复核**（after）—— CLI 的成功输出是给人读的 emoji 文本，机读不了，
 *      所以跑完再用 mode=ro 读一遍库，报**实际**落成什么样。
 *      （这条缺口已记进「给 027 的 CLI 需求清单」，但在 027 认账之前，绕。）
 */
export interface ReviewWriteResponse {
  ok: boolean;
  error?: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  after: ReviewBatchBrief | null;
  /** 收下了、但有话说（例：临时 JSON 删不掉、after 读不出来） */
  notes: string[];
}

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
