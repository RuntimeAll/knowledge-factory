/**
 * SKU 台账页的线上契约（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 单独一个文件的理由与 `app/question/shared.ts` 相同：`/api/skus`（server）
 *    与 `table.tsx`（client）要说同一种话，类型放这儿两边都 import。
 * 🔴 本文件**不 import ~/core**：client 组件顺着它 import 会把 libsql 打进浏览器包。
 *    类型/状态两张枚举表由 server 页面从 core 读出来当 props 传下去（正本仍在 core）。
 */

/**
 * 网盘指针 —— 🔴 **只从 `sku.recipe_json` 的 `netdisk` 段读**，一个字不猜：
 * 配方里没记 = 页面显示「—」，它的意思是「这本册子的配方里没记网盘」，
 * **不是**「这本册子没传过网盘」（真凭据在 `网盘分发记录/分享链接总表.md`）。
 */
export interface NetdiskPointer {
  /** 分享链接（recipe.netdisk.链接 / link） */
  link: string | null;
  /** 提取码（recipe.netdisk.提取码 / pwd；缺了就从链接的 ?pwd= 里取） */
  code: string | null;
  /** 那一段的原文（JSON 串）——页面悬停给全量，省得再去翻库 */
  raw: string;
}

export interface SkuRow {
  id: string;
  name: string;
  type: string | null;
  status: string | null;
  /** 题单里有多少题（sku_item 行数） */
  items: number;
  /** 登记了多少件产出（sku_output 行数） */
  outputs: number;
  layout: string | null;
  editionCtx: string | null;
  netdisk: NetdiskPointer | null;
  /** recipe_json 存在但解析不了（如实标，不当作「没有配方」） */
  recipeBroken: boolean;
  /** 挂到圣域哪个打卡任务（null = 没挂桥） */
  taskId: number | null;
  createdAt: string | null;
}

export interface SkuListMeta {
  /** core 的 listSkus 这次返回了几本（= 窗口） */
  listed: number;
  /** listSkus 的上限（core zod: max(500)） */
  cap: number;
  /** true = 撞到上限了：更多的册子这一页看不到，筛选也只在这窗口里做 */
  capped: boolean;
  /** 窗口内过滤之后剩几本 */
  filtered: number;
  /**
   * 哪些筛选是**窗口内过滤**（core 的 listSkus 只吃 type/status 两维）。
   * 空数组 = 本次全是 core 侧的硬过滤，总数就是库口径。
   */
  windowFilters: string[];
  /** 当前按哪一列排（null = 没排，用默认的稳定序）。🔴 排序是**窗口内**排的 */
  sort: { field: string; desc: boolean } | null;
  /** 富化（逐本 getSku 读 layout/edition/recipe）跑了几本 */
  enriched: number;
  ms: number;
  warnings: string[];
}

export interface SkuListResponse {
  ok: boolean;
  /** ok=false 时的原文报错 */
  error?: string;
  data: SkuRow[];
  total: number;
  page: number;
  pageSize: number;
  meta: SkuListMeta | null;
}

/** 字节数 → 人读（本地产物就是几百 KB 的 PDF，给到一位小数够用） */
export function humanBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * `sku.recipe_json` → 网盘指针（纯函数，列表页与详情页共用一份，别抄第二份）。
 *
 * 🔴 只认 `netdisk` 段里明写的东西：链接/提取码（或 link/pwd）。
 * 🔴 坏 JSON **不当作「没有配方」**：`broken:true` 如实往上报，它本身就是要修的东西。
 */
export function parseNetdisk(recipeJson: string | null): {
  netdisk: NetdiskPointer | null;
  broken: boolean;
} {
  if (!recipeJson) return { netdisk: null, broken: false };
  let o: unknown;
  try {
    o = JSON.parse(recipeJson);
  } catch {
    return { netdisk: null, broken: true };
  }
  if (!o || typeof o !== "object") return { netdisk: null, broken: false };
  const seg = (o as Record<string, unknown>).netdisk;
  if (!seg || typeof seg !== "object") return { netdisk: null, broken: false };

  const r = seg as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const link = str(r.链接) ?? str(r.link);
  let code = str(r.提取码) ?? str(r.pwd);
  if (!code && link) {
    // 「一册一条链接」的规范里提取码就挂在 ?pwd= 上，取得到就别让人再去点开
    const m = /[?&]pwd=([0-9a-zA-Z]+)/.exec(link);
    code = m?.[1] ?? null;
  }
  return { netdisk: { link, code, raw: JSON.stringify(seg) }, broken: false };
}
