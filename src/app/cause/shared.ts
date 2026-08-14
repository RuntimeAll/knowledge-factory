/**
 * 错因管理页的线上契约（AI:PRD-008 · P2 学情中心）
 *
 * 🔴 与 question/shared.ts 同一个理由：server 页面取数、client 面板画表，
 *    类型放这儿两边 import。本文件**不 import ~/core**
 *    （client 顺着它 import 会把 libsql 打进浏览器包）。
 * 🔴 err_code_map 是**复合键 (kp_id, err_code)**：同一个产线码在不同考点下是
 *    不同的错因实体（dist 在混合运算线=运算律简算，在整式线=去括号/合并同类项）。
 *    所以本文件里凡是「一条映射」，键一律是 kpId + errCode 两个字段，不许只写码。
 */

/** ① error_cause 一行（错因实体） */
export interface CauseEntityRow {
  causeId: string;
  name: string;
  desc: string | null;
  /** 种子来源编码（指得回去的来源串，如 err_kp:v1.0.0/sign） */
  seedCode: string | null;
  status: string | null;
  /** 挂了几个考点 / 几道诊断例题 / 几条码映射 */
  kps: number;
  examples: number;
  errCodes: number;
}

/** ② err_code_map 一行（🔴 复合键 (考点, 码) → 错因实体） */
export interface ErrCodeMapRow {
  kpId: string;
  kpName: string;
  errCode: string;
  causeId: string;
  causeName: string;
  causeStatus: string | null;
  /** 「据」的一半：这个错因实体的来源正本 */
  causeSeedCode: string | null;
  /** 「据」的另一半：错因实体的展开说明（什么样的题会踩） */
  causeDesc: string | null;
  /** 谁定的这条映射 / 什么时候定的 */
  mappedBy: string | null;
  mappedAt: string | null;
}

/** ③ unmapped 红旗一行（展开后查不到映射的 (考点, 码)） */
export interface UnmappedRow {
  kpId: string;
  kpName: string;
  errCode: string;
  /** 命中次数（码次） */
  count: number;
  /** 最多 6 条样本，指得回去：`b10·q7` */
  samples: string[];
}

/** 覆盖口径（红旗为空时必须一起看：0 条 unmapped 只覆盖挂上桥的批次） */
export interface CauseCoverage {
  matched: number;
  total: number;
  rate: string;
}

export interface CausePanelsProps {
  causes: CauseEntityRow[];
  maps: ErrCodeMapRow[];
  unmapped: UnmappedRow[];
  coverage: CauseCoverage;
  /** 参与统计的码次总数（样本量，别把 1 例当成 100%） */
  sampleCodes: number;
  /** core 的判定口径原句（原文照登） */
  rubric: string[];
  /** core 的如实提示（原文照登） */
  warnings: string[];
  /** server action 的回执 */
  ok?: string;
  err?: string;
}
