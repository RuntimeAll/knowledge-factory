/**
 * 考察模型页的线上契约（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 本文件**不 import ~/core**（client 组件顺着它 import 会把 libsql 打进浏览器包）；
 *    状态枚举由 server 页面从 core 读出来当 props 传下去。
 */

export interface ModelRow {
  id: string;
  name: string;
  status: string;
  kpId: string;
  /** 归位考点的名字（core 的 listModels 摘要面只有 kp_id，名字是逐条读卡补的） */
  kpName: string | null;
  difficulty: number | null;
  /** 用这个模型生成的题有多少道（question.model_id） */
  questionCount: number;
  /** 记了几道母题（exam_model.origin_qids_json） */
  originCount: number;
  /** 还开着的转正工单 id（null = 没有） */
  openQueueId: string | null;
  /** 生成器指针原文（可能带 `#函数名,函数名` 片段） */
  dslRef: string | null;
  /** `#` 之前那截（真文件路径） */
  dslFile: string | null;
  /** `#` 之后那截（生成器里的函数名，逗号分隔） */
  dslFragment: string | null;
  /** 文件在不在盘上（existsSync）；dsl_ref 为空时是 null = 没得查 */
  dslOnDisk: boolean | null;
  createdAt: string | null;
  activatedAt: string | null;
}

export interface ModelListMeta {
  listed: number;
  cap: number;
  capped: boolean;
  filtered: number;
  /** 窗口内过滤的维度（core 的 listModels 只吃 kpId/status 两维） */
  windowFilters: string[];
  ms: number;
  warnings: string[];
}

export interface ModelListResponse {
  ok: boolean;
  error?: string;
  data: ModelRow[];
  total: number;
  page: number;
  pageSize: number;
  meta: ModelListMeta | null;
}

/**
 * `exam_model.dsl_ref` → 文件 + 片段。
 *
 * 库里的真实长相：`D:\…\_源\qbank.py#T1_absx,T1_absabs,T1_kabs`
 * 🔴 `#` 后面那截是**生成器里的函数名**，不是路径的一部分 ——
 *    连着一起去 existsSync 永远是 false（会把在盘的文件报成不在盘）。
 */
export function splitDslRef(dslRef: string | null): {
  file: string | null;
  fragment: string | null;
} {
  const s = (dslRef ?? "").trim();
  if (!s) return { file: null, fragment: null };
  const i = s.indexOf("#");
  if (i < 0) return { file: s, fragment: null };
  const file = s.slice(0, i).trim();
  const fragment = s.slice(i + 1).trim();
  return { file: file || null, fragment: fragment || null };
}

/** 生成器指针的短名（列表里只显示文件名，全路径进悬停） */
export function dslShortName(file: string | null): string {
  if (!file) return "";
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}
