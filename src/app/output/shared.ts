/**
 * 产物仓页的线上契约（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 不 import ~/core（client 会顺着它把 libsql 打进浏览器包）。
 *    `humanBytes` 复用 SKU 台账那份纯函数（同一个仓、同一组页，别抄第二份）。
 */
export { humanBytes } from "~/app/sku/shared";

export interface OutputRow {
  /** sku_output.id */
  id: string;
  skuId: string;
  skuName: string;
  skuType: string | null;
  skuStatus: string | null;
  kind: string | null;
  /** 内容 hash（asset.hash）；null = 这件产出没有 asset 登记行 ⇒ 下载不了 */
  hash: string | null;
  /** 仓内文件名 `<hash><ext>`（下载时拿它取扩展名） */
  path: string | null;
  bytes: number | null;
  /** 登记附注（寄存在 gate_results_json 的 note） */
  note: string | null;
  createdAt: string | null;
}

export interface OutputListMeta {
  /** 扫了几本册子（= listSkus 的窗口） */
  skus: number;
  cap: number;
  capped: boolean;
  /** 展平出来一共几件（过滤前） */
  total: number;
  filtered: number;
  windowFilters: string[];
  /** 当前按哪一列排（null = 没排，用默认的稳定序）。🔴 排序是**窗口内**排的 */
  sort: { field: string; desc: boolean } | null;
  ms: number;
  warnings: string[];
}

export interface OutputListResponse {
  ok: boolean;
  error?: string;
  data: OutputRow[];
  total: number;
  page: number;
  pageSize: number;
  meta: OutputListMeta | null;
}

/** SKU 下拉的一条候选 */
export interface SkuOption {
  value: string;
  label: string;
}
