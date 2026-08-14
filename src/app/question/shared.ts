/**
 * 题目管理页的线上契约（AI:PRD-008 · 地基）
 *
 * 🔴 单独一个文件的理由：`/api/questions`（server）与 `table.tsx`（client）
 *    要说同一种话。类型放这儿两边都 import，谁改了字段另一边当场编译不过 ——
 *    这比"两边各写一份 any"可靠得多。
 * 🔴 本文件**不 import ~/core**：client 组件顺着它 import 会把 libsql 打进浏览器包。
 *    题型/状态/判档/来源那四张枚举表由 server 页面从 core 读出来当 props 传下去
 *    （唯一正本仍在 core，页面不抄第二份）。
 */

export interface QuestionKp {
  kpId: string;
  name: string;
  isPrimary: boolean;
}

export interface QuestionRow {
  id: string;
  stemBrief: string;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  provType: string;
  editionScope: string | null;
  reviewRequired: boolean;
  kps: QuestionKp[];
  /** 入库时间 = 题 id 里 ULID 的时刻（列头写明；见 route.ts 的 ulidTime） */
  ingestedAt: string | null;
  /** 命中来源徽章（多轴命中就是多枚） */
  badges: string[];
}

export interface QuestionListMeta {
  /** 融合命中总数（截断前，core 的口径） */
  coreTotal: number;
  /** SQL 硬过滤留下的候选数 */
  candidateCount: number;
  /** 本次实际取回多少条（分页窗口） */
  fetched: number;
  /** 调了几次 searchQuestions（链式翻页时 >1） */
  rounds: number;
  /** true = 结果被窗口封顶了（相关性序不跨窗拼接） */
  capped: boolean;
  cap: number;
  /** 来源筛选生效中（core 硬过滤没有 prov_type 这一维） */
  provFilter: boolean;
  /** true = 来源筛选只在窗口内做，总数是窗口口径 */
  provWindow: boolean;
  /** 当前按哪一列排（null = 没排，用 core 给的相关性/稳定序） */
  sort: { field: string; desc: boolean } | null;
  /** 录入批次硬过滤（core 的 ingestBatchIds，真过滤不是窗口内筛） */
  batchIds: string[];
  degraded: boolean;
  warnings: string[];
  ms: number;
  axes: {
    fts: {
      active: boolean;
      count: number;
      degraded: boolean;
      op: "and" | "or" | null;
      tokens: string[];
    };
    vector: { active: boolean; count: number; modelVer: string | null };
    kpAuto: { active: boolean; count: number; names: string[] };
  };
}

export interface QuestionListResponse {
  ok: boolean;
  /** ok=false 时的原文报错 */
  error?: string;
  data: QuestionRow[];
  total: number;
  page: number;
  pageSize: number;
  meta: QuestionListMeta | null;
}

// ---------------------------------------------------------------------------
// 相似题弹层（/api/questions/similar）
// ---------------------------------------------------------------------------

export interface SimilarHitRow {
  questionId: string;
  stemBrief: string;
  /** 余弦相似度（库内向量已归一 ⇒ 就是点积） */
  score: number;
  qtype: string | null;
  status: string;
  solutionGrade: string;
  kps: QuestionKp[];
}

export interface SimilarResponse {
  ok: boolean;
  error?: string;
  questionId: string;
  /** 拿来当查询的那道题（题面摘要） */
  stemBrief: string;
  hits: SimilarHitRow[];
  /** 🔴 true = 语意轴降级（模型没装/向量版本混杂）：hits 恒空，不是「没有相似题」 */
  degraded: boolean;
  modelVer: string | null;
  warnings: string[];
  ms: number;
}

/** 考点下拉的一条候选（/api/kp-options） */
export interface KpOption {
  value: string;
  label: string;
  confidence: number;
  via: string;
}

export interface KpOptionsResponse {
  ok: boolean;
  error?: string;
  options: KpOption[];
  /** 词表四路都没把握（候选只作参考，别硬挑一个） */
  lowConfidence: boolean;
}
