/**
 * 备份与对账页的线上契约（AI:PRD-008 · P3 · 设计稿 §二·16）
 *
 * 🔴 本文件**不 import ~/core**（client 顺着它 import 会把 libsql 打进浏览器包）。
 * 🔴 形状 = core.CheckResult 的可显示投影，字段名照抄（id/name/ok/level/details/stats）。
 */

/** 对账六项的固定编号与人话（页面在「一次都没跑过」时也要列得出这六行） */
export const CHECK_IDS = ["C1", "C2", "C3", "C4", "C5", "C6"] as const;

export const CHECK_TITLE: Record<string, string> = {
  C1: "审计覆盖与登记对齐（行↔审计 / 题↔向量 / 资产↔文件 / 队列 ref / 静息闸 / FTS 投影）",
  C2: "悬挂引用（引用表不得指向 merged/retired 的考点）",
  C3: "向量版本单一（embed_model_ver 全表 ≤1 种且=当前配置）",
  C4: "圣域契约（schema hash / task_id 存在 / tasks.nq = 题单数）",
  C5: "挂桥覆盖率（挂不上桥的批次列明细 —— warn 不红拦）",
  C6: "活跃树唯一（每 (学科,版本,年级学期) 的 active 树 ≤1）",
};

export interface CheckView {
  id: string;
  name: string;
  ok: boolean;
  /** 'red' | 'warn' */
  level: string;
  details: string[];
  stats: Record<string, string | number>;
}

export interface IntegrityRunResponse {
  ok: boolean;
  error?: string;
  /** 这次对账的结论（没红 = true）；跑失败时为 null */
  report: {
    ok: boolean;
    generatedAt: string;
    checks: CheckView[];
  } | null;
  /** 耗时，让人知道这一下值多少钱 */
  ms: number;
}
