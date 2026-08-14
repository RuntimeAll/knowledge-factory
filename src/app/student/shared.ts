/**
 * 学员名册的线上契约（AI:PRD-008 · P2 学情中心）
 *
 * 🔴 与 question/shared.ts、queue/rows.ts 同一个理由：`/api/student`（server）与
 *    `table.tsx`（client）要说同一种话，类型放这儿两边 import。
 * 🔴 本文件**不 import ~/core**（client 顺着它 import 会把 libsql 打进浏览器包）。
 * 🔴 全代号：这套类型里**没有真名字段**，将来也不许加 —— roster 是纯维度表，
 *    挂桥靠代号字符串对上（core/cause.ts upsertRoster 的口径），写成真名桥当场断。
 */

/** 一次打卡的判定计数（🔴 题数口径：total = 判定行数 − skip，16/19 而不是 16/20） */
export interface StudentScore {
  ok: number;
  wrong: number;
  skip: number;
  total: number;
}

export interface StudentRosterRow {
  /** 🔴 学员代号（圣域 batches.student 同一个串） */
  code: string;
  /** 线内叫法（同样不是真名）；roster 里没登记就是 null */
  alias: string | null;
  grade: string | null;
  editionCtx: string | null;
  /** roster.status；🔴 圣域有卷但名册没登记时为 null（见 inRoster） */
  status: string | null;
  joinedAt: string | null;
  note: string | null;
  /** 🔴 false = 圣域里有他的批次、roster 里却没有这个代号（不静默隐藏） */
  inRoster: boolean;

  /** 批次数（圣域口径，含没挂上桥的） */
  batches: number;
  /** 其中挂上桥的（挂不上 = 分数照给，但算不到考点） */
  matched: number;

  /** 最近一次打卡：他自己的第几次（≠ 线的第几天） */
  lastDay: number | null;
  /** 最近一次的出件时间（batches.exported_at） */
  lastAt: string | null;
  /** 最近一次是哪条线（没挂桥就没有线名 —— 如实 null） */
  lastLine: string | null;
  lastScore: StudentScore | null;
  lastBatchId: number | null;
  /** 最近这次挂没挂上桥（决定这个分数能不能算到考点上） */
  lastMatched: boolean;

  /** 🔴 这一行算不出来时的原文报错（一个学员坏了不该让整页白屏） */
  loadError?: string;
}

export interface StudentListResponse {
  ok: boolean;
  /** ok=false 时的原文报错 */
  error?: string;
  data: StudentRosterRow[];
  total: number;
  /** 名册登记的人数（roster 表行数，受 status 筛选影响） */
  rosterCount: number;
  /** 🔴 圣域里有批次、名册里没有的代号数（= data 里 inRoster=false 的行数） */
  strayCount: number;
  /** 全库挂桥覆盖（matched/total，与逐行的那份是同一把尺子） */
  coverage: { matched: number; total: number; rate: string };
  ms: number;
  warnings: string[];
}
