/**
 * 处置台的线上契约（AI:PRD-008 · 地基）
 *
 * 🔴 与 question/shared.ts 同一个理由：`/api/queue`（server）与 `board.tsx`（client）
 *    要说同一种话，类型放这儿两边 import。本文件**不 import ~/core**
 *    （client 顺着它 import 会把 libsql 打进浏览器包）。
 */

/** 四类 + 兜底一类（tab 的 key，也是 actions.ts 回跳时带的 tab 值） */
export const QUEUE_TABS = [
  "kp",
  "figure",
  "draft",
  "quarantine",
  "other",
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export interface QueueFigureView {
  id: string;
  role: string | null;
  reviewState: string | null;
  hash: string | null;
}

/**
 * 一行工单（四类共用一个形状，各类各填自己那几格）。
 * 🔴 合成一个形状而不是五个：表格列是按 tab 挑的，多几个 undefined 字段
 *    比五套类型 + 五个类型守卫便宜得多。
 */
export interface QueueViewRow {
  id: string;
  kind: string | null;
  state: string;
  reason: string | null;
  createdAt: string | null;
  refType: string | null;
  refId: string | null;
  verdictBy: string | null;
  verdictAt: string | null;
  verdictNote: string | null;
  /** 原样 payload（缩进过；处置不了的时候人总得看得见原始那一坨） */
  payloadPretty: string;

  /** kp低置信：工单里那句「问不出来的说法」 */
  query?: string | null;

  /** 图片 / 新题草稿：题面 */
  stem?: string | null;
  /** 图片：题 id 与必审位 */
  questionId?: string | null;
  reviewRequired?: number | null;
  figures?: QueueFigureView[];

  /** 新题草稿：答案 / 来源 / 预检 */
  answer?: string | null;
  source?: string | null;
  precheckOk?: boolean | null;
  reds?: string[];

  /** 隔离区：为什么被拒 / 属于哪一批 / 结案时间 */
  why?: string | null;
  batchId?: string | null;
  resolvedAt?: string | null;

  /** 这一行的详情读不出来时的原文报错（一条坏工单不该让整页白屏） */
  loadError?: string;
}

export interface QueueCounts {
  kp: number;
  figure: number;
  draft: number;
  other: number;
  quarantine: number;
}

export interface QueueListResponse {
  ok: boolean;
  error?: string;
  tab: QueueTab;
  state: string;
  data: QueueViewRow[];
  total: number;
  /** 各 tab 的未处置数（角标）——处置完一条要能立刻看见数字掉下去 */
  counts: QueueCounts;
}
