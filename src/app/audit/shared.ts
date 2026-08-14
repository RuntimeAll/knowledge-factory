/**
 * 审计日志页的线上契约（AI:PRD-008 · P3 · 设计稿 §二·15）
 *
 * 🔴 本文件**不 import ~/core**（client 顺着它 import 会把 libsql 打进浏览器包）。
 * 🔴 形状照抄 core.AuditRowView，不改名字：审计链的字段名是**口径的一部分**
 *    （规范化串固定键序，见 core/audit.ts 文件头），前端另起一套名字迟早对不上。
 */

/** audit_log.actor 的四态（库里 CHECK 约束就这四个） */
export const AUDIT_ACTORS = ["agent", "human", "proxy", "system"] as const;

export interface AuditRefView {
  table: string;
  id: string;
  op: string;
}

export interface AuditRow {
  seq: number;
  ts: string | null;
  actor: string | null;
  tool: string | null;
  argsDigest: string | null;
  /** 影响行摘要：`question +20 · question_kp +34`（按 表+op 归并） */
  impact: string;
  /** 明细（展开行里逐条列） */
  refs: AuditRefView[];
  /** row_refs_json 原文（解析不动时唯一能看的东西） */
  refsRaw: string | null;
  /** 这次写有没有带闸账 */
  hasGateResults: boolean;
  prevHash: string | null;
}

export interface AuditListResponse {
  ok: boolean;
  error?: string;
  data: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  /** 筛选下拉的候选（全表出现过的值，不受当前条件影响） */
  actors: string[];
  tools: string[];
}
