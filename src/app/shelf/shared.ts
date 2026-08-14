/**
 * 资料货架三页的线上契约（AI:PRD-009 · D-B）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库（接线文件头必须重申）：
 *   本组页面读的是 **punch 库 = `举一反三产物/资料库.db`**（六类资料总账），
 *   **不是**本库的 `data/资料库.db`。两个文件同名、schema 完全不同。
 *   punch 库一律 `mode=ro`（core/punch.ts 三道锁），**两库绝不互写**。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 与 `app/sku/shared.ts` 同一个理由单独成文件：`/api/shelf/*`（server）与
 *    `table.tsx` / `panels.tsx`（client）要说同一种话，类型放这儿两边 import。
 * 🔴 本文件**不 import ~/core**：client 顺着它 import 会把 node:sqlite / libsql
 *    打进浏览器包（eslint 也拦）。所以这里的形状是**照 core 的类型重抄一份**——
 *    抄错了不会静默：API 路由把返回体标成本文件的类型，core 那边一改形状，
 *    路由当场编译不过（这就是那道机器闸）。
 */

// ---------------------------------------------------------------------------
// 六类 / 三态 / 泳道（枚举正本在 core，本文件只是**给 client 用的镜像**）
// ---------------------------------------------------------------------------

/** 🔴 六类全列（库里没有的类目也要出 tab，计数给 0）——理由见 core/punch.ts */
export const SHELF_TYPE_ORDER = [
  "打卡",
  "专项",
  "试卷",
  "讲义",
  "练习册",
  "课本",
] as const;

export type ShelfCheckStateView = "绿" | "缺" | "免";

export interface ShelfCheckView {
  name: string;
  state: ShelfCheckStateView;
  note: string;
}

export type ShelfLaneView = "在售" | "待整理" | "可发布" | "在产" | "停售";

/** 泳道 → antd tag 色（🔴 全站一套色，别在页面里现搓） */
export const LANE_COLOR: Record<ShelfLaneView, string> = {
  在售: "green",
  可发布: "blue",
  在产: "orange",
  待整理: "gold",
  停售: "default",
};

/** 泳道 → 一句话（悬停给出来，免得「可发布」被当成「已发布」） */
export const LANE_HINT: Record<ShelfLaneView, string> = {
  在售: "人工态标了「在售」——是人拍的板，不是算出来的",
  可发布:
    "🔴 灯全绿 = 能发，**不等于已发**：中间隔着一次人工动作（人工态只有人能点）",
  在产: "还差东西：看体检里哪一盏没绿",
  待整理: "东西齐了但没归拢过（老批次的物料/网盘/命名口径各批各样）",
  停售: "人工态标了「停售」",
};

export const CHECK_COLOR: Record<ShelfCheckStateView, string> = {
  绿: "green",
  缺: "orange",
  免: "default",
};

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export interface ShelfDocView {
  id: number;
  name: string;
  type: string;
  group: string | null;
  version: string | null;
  subject: string | null;
  grade: string | null;
  kpRaw: string | null;
  form: string | null;
  manualState: string | null;
  layoutKey: string | null;
  daySpecRaw: string | null;
  srcDir: string | null;
  netdiskLink: string | null;
  netdiskCode: string | null;
  onlineBookId: string | null;
  counts: {
    questions: number;
    green: number;
    red: number;
    materials: number;
    images: number;
    paperQ: number;
    paperA: number;
    combined: number;
    assets: number;
    members: number;
  };
  materialAccounts: string[];
  days: number | null;
  lane: ShelfLaneView;
  checks: ShelfCheckView[];
}

export interface ShelfFacetView {
  value: string;
  count: number;
}

export interface ShelfFacetsView {
  types: ShelfFacetView[];
  subjects: ShelfFacetView[];
  grades: ShelfFacetView[];
  lanes: ShelfFacetView[];
}

export interface ShelfListResponse {
  ok: boolean;
  /** ok=false 时的原文报错（🔴 原文照登，不吞） */
  error?: string;
  data: ShelfDocView[];
  total: number;
  facets: ShelfFacetsView | null;
  meta: {
    totalDocs: number;
    windowFilters: string[];
    dbPath: string;
    ms: number;
    warnings: string[];
  } | null;
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

export interface ShelfMaterialView {
  id: number;
  account: string;
  isActive: boolean;
  title: string | null;
  body: string | null;
  topicsRaw: string | null;
  goodsDesc: string | null;
  netdiskWords: string | null;
  burned: boolean;
  createdAt: string | null;
}

export interface ShelfAssetView {
  id: number;
  type: string;
  path: string;
  ord: number | null;
  renderedAt: string | null;
}

export interface ShelfMemberView {
  id: number;
  name: string;
  version: string | null;
  type: string;
  questions: number;
}

export interface ShelfPublishLogView {
  id: number;
  materialId: number;
  account: string | null;
  date: string | null;
  result: string | null;
  note: string | null;
}

export interface ShelfDocDetailView {
  doc: ShelfDocView;
  materials: ShelfMaterialView[];
  assets: ShelfAssetView[];
  questionGroups: { section: string | null; qtype: string | null; n: number }[];
  members: ShelfMemberView[];
  includedIn: ShelfMemberView[];
  publishLogs: ShelfPublishLogView[];
  dbPath: string;
}

// ---------------------------------------------------------------------------
// 资产分类（🔴 两条坑写死在这里，别在页面里再判一次）
// ---------------------------------------------------------------------------

/**
 * 这件资产是「卷」还是「图」。
 *
 * 🔴🔴 必须用 `includes("卷")`，**不能用 endsWith("卷")** ——
 *      库里有 `题目卷A` / `答案卷B` 这种「角色+版」的类型（两套版面骨架的册子），
 *      endsWith 判不到，它们会被当成图片渲染成一片碎图（punch-console 点名的坑）。
 */
export function assetIsPaper(type: string): boolean {
  return type.includes("卷");
}

/**
 * 这件资产属于哪个号（A/B）。
 * `图A`/`图B`、`题目卷A`/`答案卷B` → A/B；`页图`/`题目卷`/`答案卷`/`合订卷` → null（不分号）。
 * 🔴 分号是**发布纪律**：配图必须跟文案同号（A 号的文案配 A 号的图），
 *    所以详情页的 A/B 开关同时管物料和配图两块。
 */
export function assetAccount(type: string): "A" | "B" | null {
  if (type.endsWith("A")) return "A";
  if (type.endsWith("B")) return "B";
  return null;
}

/** 预览/下载一份货架文件的地址（🔴 绝对路径在手机上等于没给，一律走这条） */
export function shelfFileUrl(absPath: string, download = false): string {
  const q = new URLSearchParams({ p: absPath });
  if (download) q.set("download", "1");
  return `/api/shelf/file?${q.toString()}`;
}

/** 话题词：JSON 数组串 → 数组（坏串就原样当成一个词，不吞） */
export function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const o: unknown = JSON.parse(raw);
    return Array.isArray(o) ? o.map((x) => String(x)) : [String(o)];
  } catch {
    return [raw];
  }
}

/** 名称里的前缀序号（`2.10 乘除混合运算` → 210）——组内要按**数值**排，不能字典序 */
export function seqOfName(name: string): number | null {
  const m = /^(\d+)\.(\d+)\s/.exec(name);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

// ---------------------------------------------------------------------------
// 对账（/shelf/reconcile）
// ---------------------------------------------------------------------------

export interface FileMatchView {
  key: string;
  path: string;
  punchDocId: number | null;
  punchDocName: string | null;
  punchAssetType: string | null;
  kfSkuId: string | null;
  kfSkuName: string | null;
  kfOutputKind: string | null;
  kfHash: string | null;
  onDisk: boolean;
}

export interface BookMatchView {
  key: string;
  how: "路径" | "名称" | "名称疑似";
  sharedFiles: number;
  punchDocId: number;
  punchDocName: string;
  punchType: string;
  punchVersion: string | null;
  punchLane: string | null;
  kfSkuId: string;
  kfSkuName: string;
  kfType: string | null;
  kfStatus: string | null;
}

export type NetdiskVerdictView =
  | "一致"
  | "链接不一致"
  | "提取码不一致"
  | "只货架有"
  | "只工厂有"
  | "两边都没有"
  | "配方坏了"
  | "工厂没这本册子";

export interface NetdiskRowView {
  punchDocId: number;
  punchDocName: string;
  kfSkuId: string | null;
  kfSkuName: string | null;
  pairedBy: BookMatchView["how"] | null;
  punchLink: string | null;
  punchCode: string | null;
  kfLink: string | null;
  kfCode: string | null;
  verdict: NetdiskVerdictView;
  note: string;
}

export interface ReconcileReportView {
  takenAt: string;
  punchDbPath: string;
  kfDbPath: string;
  ms: number;
  fileAxis: {
    punchAssets: number;
    kfOutputs: number;
    kfOutputsWithoutSrc: number;
    matched: FileMatchView[];
    punchOnly: FileMatchView[];
    kfOnly: FileMatchView[];
    missingOnDisk: FileMatchView[];
    punchOnlyByRoot: { root: string; n: number }[];
    kfOnlyByRoot: { root: string; n: number }[];
  };
  bookAxis: {
    punchDocs: number;
    kfSkus: number;
    matched: BookMatchView[];
    punchOnly: {
      id: number;
      name: string;
      type: string;
      lane: string | null;
    }[];
    kfOnly: {
      id: string;
      name: string;
      type: string | null;
      status: string | null;
    }[];
  };
  netdiskAxis: {
    rows: NetdiskRowView[];
    counts: Record<NetdiskVerdictView, number>;
  };
  punchEmptyTables: { table: string; rows: number; 说明: string }[];
  warnings: string[];
}

export interface ReconcileResponse {
  ok: boolean;
  error?: string;
  report: ReconcileReportView | null;
}

/** 网盘判词 → tag 色（🔴「两边都没有」不是差异，别给它红色） */
export const NETDISK_COLOR: Record<NetdiskVerdictView, string> = {
  一致: "green",
  链接不一致: "red",
  提取码不一致: "orange",
  只货架有: "blue",
  只工厂有: "blue",
  两边都没有: "default",
  配方坏了: "red",
  工厂没这本册子: "default",
};
