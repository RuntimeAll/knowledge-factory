/**
 * 录入批次页的线上契约（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 🔴 与 question/shared.ts、queue/rows.ts 同一个理由：`/api/ingest`（server）
 *    与 `table.tsx`（client）要说同一种话，类型放这儿两边 import。
 *    本文件**不 import ~/core** —— client 顺着它 import 会把 libsql 打进浏览器包。
 * 🔴 这里的形状是 core 契约的**投影**（IngestBatchBrief / IngestBatchRecord 的可显示子集），
 *    不是第二套口径：字段名一律照抄 core，别在前端改名字。
 */

/** ingest_batch.status 的三态（库里 CHECK 约束就这三个） */
export const INGEST_STATUSES = ["open", "committed", "failed"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** 列表一行（= core.IngestBatchBrief 拍平） */
export interface IngestBatchRow {
  id: string;
  contractVer: string;
  source: string;
  status: string | null;
  total: number;
  accepted: number;
  queued: number;
  rejected: number;
  createdAt: string | null;
  committedAt: string | null;
  hasGateReport: boolean;
  quarantineOpen: number;
  quarantineTotal: number;
}

export interface IngestListResponse {
  ok: boolean;
  /** 读不出来时的报错原文（HTTP 仍 200，页面把它摆在表格上方） */
  error?: string;
  data: IngestBatchRow[];
  total: number;
  page: number;
  pageSize: number;
  /** 命中条件的总批数（= total，冗余一份是为了让「窗口」口径将来能分开说） */
  matched: number;
  /** 本次列了多少行（core 单次上限 500；超了如实说） */
  capped: boolean;
}

// ---------------------------------------------------------------------------
// 详情（闸报告 / 本批题目 / 隔离行）
// ---------------------------------------------------------------------------

/** 一道闸的结论（= core GateItem 的可显示投影） */
export interface GateItemView {
  name: string;
  ok: boolean;
  ms: number;
  /** 红灯才有：稳定错误码 + 人话 + 能不能改参数重试 */
  code?: string;
  message?: string;
  recoverable?: boolean;
  nextTool?: string;
}

/** 一道题在这一批里的账 */
export interface IngestItemView {
  seq: number;
  verdict: string;
  /** 落库题 id（rejected = null） */
  questionId: string | null;
  gates: GateItemView[];
  gatesOk: boolean;
  /** 第一处红灯（rejected 时必有） */
  failCode: string | null;
  failMessage: string | null;
  /** 被剥掉的片段（指令词闸 + 前缀闸） */
  stripped: string[];
  /** 不拦路但要人看见的事 */
  notes: string[];
  solutionGrade: string | null;
  /** 实算 / 逐行恒等三态（没送去算 = null，不是「没问题」） */
  calcVerdict: string | null;
  lineVerdict: string | null;
  kpCount: number;
  reviewRequired: boolean;
}

export interface IngestBatchDetail {
  id: string;
  contractVer: string;
  source: string;
  payloadHash: string | null;
  status: string | null;
  createdAt: string | null;
  committedAt: string | null;
  total: number;
  accepted: number;
  queued: number;
  rejected: number;
  /** 批级闸（闸①契约检查）过没过 */
  contractOk: boolean | null;
  /** 逐题账；gate_report_json 解析不动 = 空数组 + gateParseError */
  items: IngestItemView[];
  /** gate_report_json 解析失败的原因（老批/脏行照实说，不装作没有闸账） */
  gateParseError: string | null;
  /** 本批落库题 id（按 id 序） */
  questionIds: string[];
  quarantine: {
    total: number;
    open: number;
    resolved: number;
    openIds: string[];
  };
}

export interface IngestDetailResponse {
  ok: boolean;
  error?: string;
  data: IngestBatchDetail | null;
}
