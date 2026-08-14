/**
 * core/punch.ts —— 资料货架（punch 库 `举一反三产物/资料库.db`）**只读**挂载 + 读侧
 * （AI:PRD-009 · D-B「punch-console 收编=只读挂载先行」）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库警示（每个接线文件头都要重申这一句，PRD-009 §四 红线）
 *
 *   货架库（punch）= `D:\workplace\ai-bkb\举一反三产物\资料库.db`
 *   工厂库（本库）  = `D:\workplace\ai-bkb\codeplace-AI\knowledge-factory\data\资料库.db`
 *
 *   **两个文件都叫「资料库.db」，路径不同、schema 完全不同、数据零交集。**
 *   本模块只连前者，且**只读**；本库的连接一律走 `core/db.ts`。
 *   任何脚本引用这两个库都必须写全路径 —— 混一次就是把六类资料的总账当成生产事实源。
 *   🔴 两库**绝不互写**：货架收编是「挂载来看」，不是「搬过来」。
 *      正式迁移与 v1(:8787)/v2(:3000) 退役 = 等用户最后点头，本卡一行都不动它。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 三道锁（照抄 core/grading.ts 对圣域的那三道，一道都不许省）：
 *   ① **声明锁**：`PUNCH_DB_URL` 必须显式带 `mode=ro`，否则 getPunchDb() 直接抛。
 *      不许「没带就默默补上」—— 配置里读不出「这是只读挂载」的意图，
 *      下一个人就会把它当普通库用。
 *   ② **物理锁**：`node:sqlite` 的 `readOnly: true`（SQLITE_OPEN_READONLY），
 *      连 SQLite 自己都拒绝写。@libsql/client 给不了这个（它只开读写句柄，
 *      而且把 `file:…?mode=ro` 当非法 URL 直接抛），所以这一处刻意偏离主栈。
 *   ③ **语句锁**：对外只给 `punchQuery()`，非 SELECT/WITH/PRAGMA 在发到库之前就抛
 *      （复用 grading.ts 的 assertReadOnlyStatement，两处一套口径）。
 *
 * 🔴 punch 库是 journal_mode=wal 且有一份**未 checkpoint 的 WAL**（实测 7.5MB）。
 *    只读打开要能读到 WAL 里的新数据，靠的是同目录的 `-shm`；读不到就报错，
 *    **绝不降级成读写重开**（那等于我们去替别人 checkpoint 他的库）。
 *
 * ── 状态模型：整体继承 punch-console v2 的口径，一个字不改 ────────────────────
 *   库里只存三个状态字段（task.状态 / doc.人工态 / question.实算），
 *   **泳道与体检全部现算**（存了就会过期，过期就是洞）。
 *   🔴 `doc.人工态` 是**唯一人工开关**，产线代码永远不许写它
 *      （2026-08-10 实伤：灯转绿被自动标「在售」，可用户根本没发布过。
 *       "能发" ≠ "已发"，中间隔着一次人工动作）。
 *      本产品对 punch 库物理只读，这条红线在这里是**天然满足**的。
 */
import { extname, resolve as resolvePath, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
// 🔴 只导类型：`import type` 编译期就擦掉，运行时不 require node:sqlite
//    （真正的加载在 getPunchDb() 里动态 import，Node < 22.5 才能给人话报错）
import type { DatabaseSync as DatabaseSyncClass } from "node:sqlite";

import {
  assertReadOnlyStatement,
  describeDbPath,
  fileUrlToPath,
} from "./grading";

// ---------------------------------------------------------------------------
// 连接串 / 句柄
// ---------------------------------------------------------------------------

/** 🔴 连接串里必须出现的只读声明 */
export const PUNCH_RO_MARKER = "mode=ro";

export interface PunchDbHandle {
  /** 原始连接串（含 mode=ro 声明） */
  readonly url: string;
  /** 落地文件路径 */
  readonly path: string;
  /** 🔴 唯一查询口：只吃 SELECT / WITH / PRAGMA */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

/**
 * 校验并解析货架连接串 → 文件路径。
 * 🔴 没有 `mode=ro` 就抛，不补、不猜。
 */
export function assertPunchUrl(url: string): string {
  if (!url || url.trim() === "") {
    throw new Error(
      "PUNCH_DB_URL 没设：资料货架（punch 库 举一反三产物/资料库.db）只读连接串缺失。" +
        '正确形如 PUNCH_DB_URL="file:D:/workplace/ai-bkb/举一反三产物/资料库.db?mode=ro"' +
        "（🔴 同名异库：这不是本库的 data/资料库.db）",
    );
  }
  if (!url.startsWith("file:")) {
    throw new Error(
      `货架连接串只支持 file: 本地库，收到 ${JSON.stringify(url)}`,
    );
  }
  if (!url.includes(PUNCH_RO_MARKER)) {
    throw new Error(
      "🔴 货架只读挂载必须显式 mode=ro：" +
        `PUNCH_DB_URL=${JSON.stringify(url)} 里没有 \`${PUNCH_RO_MARKER}\`。` +
        "punch 库是资料产线的总账，本产品对它只有 SELECT——" +
        "连接串里读不出这个意图就不许连（这里不会替你补上）。",
    );
  }
  return fileUrlToPath(url);
}

const pool = new Map<string, PunchDbHandle>();

/**
 * 拿货架只读句柄（同一 url 复用一条连接）。
 * @param url 覆盖连接串（测试/脚本用）；默认惰性读 process.env.PUNCH_DB_URL
 */
export async function getPunchDb(url?: string): Promise<PunchDbHandle> {
  const raw = url ?? process.env.PUNCH_DB_URL ?? "";
  const cached = pool.get(raw);
  if (cached) return cached;

  const path = assertPunchUrl(raw);

  let DatabaseSync: typeof DatabaseSyncClass;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    throw new Error(
      "货架只读连接需要 node:sqlite（Node ≥ 22.5）——" +
        "它是唯一能以 SQLITE_OPEN_READONLY 打开文件的驱动。" +
        `当前 Node ${process.version}。原始错误：${String(e)}`,
    );
  }

  let db: DatabaseSyncClass;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new Error(
      `货架库（punch 资料库.db）打不开：${path}\n` +
        "确认文件在、路径没写错。🔴 只读打开失败**绝不降级成读写重试**——" +
        "punch 库有一份未 checkpoint 的 WAL，读写打开等于替别人动他的库。\n" +
        `原始错误：${String(e)}`,
    );
  }

  const handle: PunchDbHandle = {
    url: raw,
    path,
    query<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): T[] {
      assertReadOnlyStatement(sql);
      return db.prepare(sql).all(...params) as T[];
    },
    close() {
      pool.delete(raw);
      db.close();
    },
  };
  pool.set(raw, handle);
  return handle;
}

/** 关掉所有货架连接（脚本收尾 / 测试隔离） */
export function closePunchDb(): void {
  for (const h of [...pool.values()]) h.close();
}

// ---------------------------------------------------------------------------
// 六类资料 / 三态 / 泳道
// ---------------------------------------------------------------------------

/**
 * 🔴 六类资料 = punch 侧 `doc.类型` 的声明全集（正本在 punch 的 schema.ts）。
 *    **声明有六类，库里现在只有两类有行**（打卡/专项）——
 *    货架的分类 tab 六类全列、计数如实给 0，绝不因为「现在没有」就把 tab 藏掉：
 *    藏掉之后，人会以为这个产品不支持讲义/试卷。
 */
export const SHELF_DOC_TYPES = [
  "打卡",
  "专项",
  "试卷",
  "讲义",
  "练习册",
  "课本",
] as const;
export type ShelfDocType = (typeof SHELF_DOC_TYPES)[number];

/** 体检三态：绿=过了；缺=还差这一项（黄灯，提醒不拦路）；免=这一类本来就不查这项 */
export type ShelfCheckState = "绿" | "缺" | "免";
export interface ShelfCheck {
  name: string;
  state: ShelfCheckState;
  note: string;
}

/** 现算泳道（人工态优先，为空才走体检灯） */
export const SHELF_LANES = [
  "在售",
  "待整理",
  "可发布",
  "在产",
  "停售",
] as const;
export type ShelfLane = (typeof SHELF_LANES)[number];

/** 一行货架资料（punch `doc` + 五张表的现算计数）。🔴 键名转 ASCII，方便当线上契约走 */
export interface ShelfDocRow {
  id: number;
  /** doc.名称（多管线册里带 `2.1 ` 这样的序号前缀） */
  name: string;
  type: string;
  /** doc.组名 = **归属**（不是属性）：合刊/多管线册靠它折叠 */
  group: string | null;
  /** doc.版本名（正册/基础版/提高版/平行卷…）；`(名称,版本名)` 是 punch 侧的幂等键 */
  version: string | null;
  subject: string | null;
  grade: string | null;
  /** doc.考点：JSON string[] 原串（解析失败就原样端出去，不猜） */
  kpRaw: string | null;
  /** doc.册型：单册 / 合刊 */
  form: string | null;
  /** doc.人工态：在售 / 待整理 / 停售 / null（null = 交回四盏灯现算） */
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
    /** 图A + 图B（小红书配图） */
    images: number;
    paperQ: number;
    paperA: number;
    combined: number;
    /** asset 全部行数 */
    assets: number;
    /** 作为合刊时有几个成员册 */
    members: number;
  };
  /** 在用物料覆盖了哪几个号（A/B） */
  materialAccounts: string[];
  /** day_spec 解出来的天数（解不出就 null） */
  days: number | null;
  lane: ShelfLane;
  checks: ShelfCheck[];
}

function parseDaySpec(
  s: string | null,
): { 天数: number; 每天: Record<string, number> } | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as { 天数?: unknown; 每天?: unknown };
    if (typeof o.天数 === "number") {
      return {
        天数: o.天数,
        每天: (o.每天 ?? {}) as Record<string, number>,
      };
    }
  } catch {
    /* 卡里手改坏了就当没有 —— 体检会退化成「按题数判」，如实写在说明里 */
  }
  return null;
}

// ---- 单项体检（各档按需拼装；口径与 punch-console v2 lib/library.ts 逐字一致）

function chk题目齐(d: ShelfDocRow): ShelfCheck {
  const spec = parseDaySpec(d.daySpecRaw);
  const 应有 = spec
    ? spec.天数 * Object.values(spec.每天 || {}).reduce((a, b) => a + b, 0)
    : null;
  if (应有) {
    return {
      name: "题目齐",
      state: d.counts.questions >= 应有 ? "绿" : "缺",
      note: `${d.counts.questions} / ${应有} 题（${spec!.天数} 天规格）`,
    };
  }
  return {
    name: "题目齐",
    state: d.counts.questions > 0 ? "绿" : "缺",
    note:
      d.counts.questions > 0
        ? `${d.counts.questions} 题（无 day_spec，按题数判）`
        : "题目未入库",
  };
}

/**
 * 实算绿。
 * `无题时` 决定这一类「题还没入库」算什么：
 *   打卡=缺（题就是商品，没题等于没做完）；专项=免（题级回收随使用，不该拖着它变红）。
 */
function chk实算(d: ShelfDocRow, 无题时: ShelfCheckState): ShelfCheck {
  const 待算 = d.counts.questions - d.counts.green - d.counts.red;
  if (d.counts.questions === 0) {
    return {
      name: "实算绿",
      state: 无题时,
      note: 无题时 === "免" ? "题未拆到题级，不判" : "无题可算",
    };
  }
  return {
    name: "实算绿",
    state: d.counts.red === 0 && 待算 === 0 ? "绿" : "缺",
    note: `绿 ${d.counts.green} / 红 ${d.counts.red} / 待算 ${待算}`,
  };
}

function chk物料齐(accounts: string[]): ShelfCheck {
  const set = new Set(accounts);
  return {
    name: "物料齐",
    state: set.has("A") && set.has("B") ? "绿" : "缺",
    note: set.size
      ? `在用 ${[...set].sort().join("/")} 号${set.size < 2 ? "（缺一号）" : ""}`
      : "没有在用物料",
  };
}

function chk网盘挂(d: ShelfDocRow): ShelfCheck {
  return {
    name: "网盘挂",
    state: d.netdiskLink ? "绿" : "缺",
    note: d.netdiskLink
      ? `已挂${d.netdiskCode ? ` · 码 ${d.netdiskCode}` : ""}`
      : "没有网盘链接",
  };
}

/** 产物在：题目卷+答案卷成对，或一份题解合订卷；只有逐页图也算（交付图在就是交付过） */
function chk产物在(d: ShelfDocRow): ShelfCheck {
  const c = d.counts;
  const 页图 = c.assets - c.paperQ - c.paperA - c.combined;
  if (c.paperQ > 0 && c.paperA > 0) {
    return {
      name: "产物在",
      state: "绿",
      note: `题目卷 ${c.paperQ} / 答案卷 ${c.paperA}`,
    };
  }
  if (c.combined > 0) {
    return { name: "产物在", state: "绿", note: `合订卷 ${c.combined} 份` };
  }
  if (页图 > 0) {
    return {
      name: "产物在",
      state: "绿",
      note: `${页图} 张成品图（无独立卷）`,
    };
  }
  return {
    name: "产物在",
    state: "缺",
    note: `题目卷 ${c.paperQ} / 答案卷 ${c.paperA}`,
  };
}

function chk源文件在(d: ShelfDocRow): ShelfCheck {
  return {
    name: "源文件在",
    state: d.srcDir ? "绿" : "缺",
    note: d.srcDir ? "已登记路径" : "没登记源文件路径",
  };
}

function chk有产物(d: ShelfDocRow): ShelfCheck {
  return {
    name: "产物在",
    state: d.counts.assets > 0 ? "绿" : "缺",
    note: d.counts.assets > 0 ? `${d.counts.assets} 个文件` : "没挂产物文件",
  };
}

function chk档案在(d: ShelfDocRow): ShelfCheck {
  const ok = Boolean(d.srcDir) || d.counts.assets > 0;
  return {
    name: "档案在",
    state: ok ? "绿" : "缺",
    note: ok
      ? `已挂档${d.counts.assets ? ` · ${d.counts.assets} 个文件` : ""}`
      : "没有路径也没有文件",
  };
}

/**
 * 🔴 体检**按类型分档**（PRD-023 分型处理规程 §7，收编时整体继承）。
 *
 * 一刀切是上一版最大的洞：专项/试卷根本没有小红书物料和网盘，
 * 拿打卡那四项去量它们，永远红、永远卡在「在产」泳道 —— 已经产完的册子也显示没做完。
 *
 *   打卡（可售商品）      题目齐 / 实算绿 / 物料齐(A+B) / 网盘挂
 *   打卡·合刊             成员齐 / 物料齐 / 网盘挂    ← 合订本自己不挂题
 *   专项 · 合卷           产物在 / 实算（有题才判，没拆题=免）
 *   试卷 · 讲义 · 练习册  源文件在 / 产物在 / 实算=免（规程红线：不逐题实算）
 *   课本                  档案在（规程红线：绝不判「题量>0」）
 */
export function shelfChecksOf(d: ShelfDocRow): ShelfCheck[] {
  switch (d.type) {
    case "打卡": {
      if (d.form === "合刊") {
        return [
          {
            name: "成员齐",
            state: d.counts.members > 0 ? "绿" : "缺",
            note:
              d.counts.members > 0
                ? `由 ${d.counts.members} 册合订`
                : "还没挂成员册",
          },
          chk物料齐(d.materialAccounts),
          chk网盘挂(d),
        ];
      }
      return [
        chk题目齐(d),
        chk实算(d, "缺"),
        chk物料齐(d.materialAccounts),
        chk网盘挂(d),
      ];
    }
    case "专项":
      return [chk产物在(d), chk实算(d, "免")];
    case "试卷":
    case "讲义":
    case "练习册":
      return [
        chk源文件在(d),
        chk有产物(d),
        { ...chk实算(d, "免"), state: "免" },
      ];
    case "课本":
      return [chk档案在(d)];
    default:
      return [chk有产物(d)];
  }
}

/**
 * 一份资料现在处在哪条泳道。
 *
 * 🔴 **人工态优先于现算**，但只有人工态里写死的那几个值才拦得住现算 ——
 *    人工态为空时一律走体检灯现算，**别在这里替人做判断**。
 * 🆕 `待整理`：库里那批老打卡与老专项，灯可能全绿（题在、实算过），
 *    但**还没做过归一整理**（物料口径/网盘/命名/归属各批各样）。
 *    与「在产」的区别：在产=还差东西；待整理=东西齐了但没归拢过。
 */
export function shelfLaneOf(d: ShelfDocRow, checks?: ShelfCheck[]): ShelfLane {
  if (d.manualState === "在售") return "在售";
  if (d.manualState === "停售") return "停售";
  if (d.manualState === "待整理") return "待整理";
  const cs = checks ?? shelfChecksOf(d);
  const 待判 = cs.filter((c) => c.state !== "免");
  return 待判.length > 0 && 待判.every((c) => c.state === "绿")
    ? "可发布"
    : "在产";
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/** 🔴 一处 SELECT 两处用（列表 + 详情），免得两边的计数口径漂 */
const DOC_SELECT = `
  d.id, d.名称, d.类型, d.组名, d.版本名, d.科目, d.年级, d.考点, d.册型,
  d.人工态, d.layout_key, d.day_spec, d.源文件路径, d.网盘链接, d.提取码, d.线上book_id,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id) AS 题数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '绿') AS 绿数,
  (SELECT COUNT(*) FROM question q WHERE q.doc_id = d.id AND q.实算 = '红') AS 红数,
  (SELECT COUNT(*) FROM material m WHERE m.doc_id = d.id AND m.is_active = 1) AS 物料数,
  (SELECT group_concat(DISTINCT m.账号) FROM material m WHERE m.doc_id = d.id AND m.is_active = 1) AS 物料账号,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 IN ('图A','图B')) AS 图数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '题目卷') AS 题卷数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '答案卷') AS 答卷数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id AND a.类型 = '合订卷') AS 合订数,
  (SELECT COUNT(*) FROM asset a WHERE a.doc_id = d.id) AS 产物数,
  (SELECT COUNT(*) FROM doc_member dm WHERE dm.合刊doc_id = d.id) AS 成员数`;

/** punch 库那一行的原始形状（中文列名照抄，只在本文件里出现） */
interface RawDocRow {
  id: number;
  名称: string;
  类型: string;
  组名: string | null;
  版本名: string | null;
  科目: string | null;
  年级: string | null;
  考点: string | null;
  册型: string | null;
  人工态: string | null;
  layout_key: string | null;
  day_spec: string | null;
  源文件路径: string | null;
  网盘链接: string | null;
  提取码: string | null;
  线上book_id: string | null;
  题数: number;
  绿数: number;
  红数: number;
  物料数: number;
  物料账号: string | null;
  图数: number;
  题卷数: number;
  答卷数: number;
  合订数: number;
  产物数: number;
  成员数: number;
}

function toShelfRow(r: RawDocRow): ShelfDocRow {
  const accounts = (r.物料账号 ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const row: ShelfDocRow = {
    id: Number(r.id),
    name: r.名称,
    type: r.类型,
    group: r.组名,
    version: r.版本名,
    subject: r.科目,
    grade: r.年级,
    kpRaw: r.考点,
    form: r.册型,
    manualState: r.人工态,
    layoutKey: r.layout_key,
    daySpecRaw: r.day_spec,
    srcDir: r.源文件路径,
    netdiskLink: r.网盘链接,
    netdiskCode: r.提取码,
    onlineBookId: r.线上book_id,
    counts: {
      questions: Number(r.题数),
      green: Number(r.绿数),
      red: Number(r.红数),
      materials: Number(r.物料数),
      images: Number(r.图数),
      paperQ: Number(r.题卷数),
      paperA: Number(r.答卷数),
      combined: Number(r.合订数),
      assets: Number(r.产物数),
      members: Number(r.成员数),
    },
    materialAccounts: accounts,
    days: parseDaySpec(r.day_spec)?.天数 ?? null,
    // 下面两项马上现算覆盖（先占位，不留 undefined）
    lane: "在产",
    checks: [],
  };
  row.checks = shelfChecksOf(row);
  row.lane = shelfLaneOf(row, row.checks);
  return row;
}

export interface ShelfFacet {
  value: string;
  count: number;
}

export interface ShelfFacets {
  /** 🔴 六类**全列**（库里没有的给 0），理由见 SHELF_DOC_TYPES */
  types: ShelfFacet[];
  subjects: ShelfFacet[];
  grades: ShelfFacet[];
  /** 现算的，只能在窗口里数 */
  lanes: ShelfFacet[];
}

export interface ShelfListOptions {
  type?: string;
  subject?: string;
  grade?: string;
  /** 🔴 泳道是**现算**的，只能在取回的窗口里过滤（SQL 里没有这一维） */
  lane?: string;
  /** 名称/组名/版本名 包含匹配（窗口内） */
  keyword?: string;
  url?: string;
}

export interface ShelfListResult {
  rows: ShelfDocRow[];
  facets: ShelfFacets;
  /** 库里一共几行 doc（不受筛选影响） */
  totalDocs: number;
  /** 哪些维度是**窗口内过滤**（如实上墙） */
  windowFilters: string[];
  /** 货架库落地路径（相对 ai-bkb 根的表述） */
  dbPath: string;
  ms: number;
  /** 收编待拍板项等如实提醒（不改数据，只报） */
  warnings: string[];
}

/**
 * 🔴 年级口径分裂的**如实提醒**（不合并、不猜）。
 *
 *   实测：`七年级上册` 32 行与 `七上` 13 行并存 —— 按年级筛会分裂成两堆。
 *   这是 PRD-009 收编「最该先拍板的六件事」第 1 条，**要用户拍板**，
 *   在这里悄悄归一等于替人做了决定，而且改的是别人库里的口径。
 *   所以：只报，不改。
 */
export function gradeSplitWarnings(grades: ShelfFacet[]): string[] {
  // 只认「简写 ↔ 全称」这一种分裂（`七上` ↔ `七年级上册`）：
  // 🔴 `五年级` 与 `五年级上册` 不算同一种写法（一个是学年、一个是学期），
  //    把它们也报成分裂等于替人下了一个错判断。
  const 简写 = /^([一二三四五六七八九])([上下])$/;
  const out: string[] = [];
  for (const g of grades) {
    const m = 简写.exec(g.value);
    if (!m) continue;
    const 对应 = `${m[1]}年级${m[2]}册`;
    const other = grades.find((x) => x.value === 对应);
    if (other) {
      out.push(
        `年级口径分裂：「${other.value}」${other.count} 本 与 「${g.value}」${g.count} 本` +
          "是同一个年级的两种写法 —— 按年级筛会分裂成两堆。" +
          "🔴 货架只如实列、不合并：拉齐口径要改 punch 库的数据，" +
          "而本产品对它只读（这是 PRD-009 收编待拍板第 1 条）。",
      );
    }
  }
  return out;
}

/** 名称里的前缀序号（`2.10 乘除混合运算` → 210），没有就 null */
export function shelfSeqOf(name: string): number | null {
  const m = /^(\d+)\.(\d+)\s/.exec(name);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

/**
 * 列货架资料。
 * 🔴 一次取尽（doc 只有几十行，没有分页的必要），排序/泳道过滤都在窗口内做，
 *    `windowFilters` 如实说明哪几维是窗口内过滤的。
 */
export async function listShelfDocs(
  opts: ShelfListOptions = {},
): Promise<ShelfListResult> {
  const t0 = Date.now();
  const h = await getPunchDb(opts.url);

  const clauses: string[] = [];
  const args: unknown[] = [];
  if (opts.type) {
    clauses.push("d.类型 = ?");
    args.push(opts.type);
  }
  if (opts.subject) {
    clauses.push("d.科目 = ?");
    args.push(opts.subject);
  }
  if (opts.grade) {
    clauses.push("d.年级 = ?");
    args.push(opts.grade);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = h.query<RawDocRow>(
    `SELECT ${DOC_SELECT} FROM doc d ${where} ORDER BY d.类型, d.组名, d.名称, d.版本名`,
    args,
  );
  let rows = raw.map(toShelfRow);

  const windowFilters: string[] = [];
  const kw = (opts.keyword ?? "").trim().toLowerCase();
  if (kw) {
    windowFilters.push(`名称/组名/版本名 包含「${opts.keyword!.trim()}」`);
    rows = rows.filter((r) =>
      `${r.name} ${r.group ?? ""} ${r.version ?? ""}`
        .toLowerCase()
        .includes(kw),
    );
  }
  if (opts.lane) {
    windowFilters.push(
      `泳道 = ${opts.lane}（🔴 泳道是现算的，库里没有这一列，只能在取回的窗口里筛）`,
    );
    rows = rows.filter((r) => r.lane === opts.lane);
  }

  // ── facets：类型六类全列；科目/年级只列库里真有的；泳道在**全量窗口**上数
  //    🔴 facets 必须按**全库**数，不能按筛完的结果数 —— 否则选了「打卡」之后，
  //       类型 tab 上的其它几类会变成 0，看起来像库里突然没有了。
  //    没下 SQL 过滤时直接复用上面那次取数，不白扫第二遍。
  const 全量 =
    clauses.length === 0
      ? raw.map(toShelfRow)
      : h.query<RawDocRow>(`SELECT ${DOC_SELECT} FROM doc d`).map(toShelfRow);
  const 计数 = (pick: (r: ShelfDocRow) => string | null): ShelfFacet[] => {
    const m = new Map<string, number>();
    for (const r of 全量) {
      const v = pick(r);
      if (v === null || v === "") continue;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  const typeCounts = new Map(
    计数((r) => r.type).map((f) => [f.value, f.count]),
  );
  const facets: ShelfFacets = {
    types: SHELF_DOC_TYPES.map((t) => ({
      value: t,
      count: typeCounts.get(t) ?? 0,
    })),
    subjects: 计数((r) => r.subject),
    grades: 计数((r) => r.grade),
    lanes: 计数((r) => r.lane),
  };

  const warnings = gradeSplitWarnings(facets.grades);
  // 🔴 声明了六类、库里只有两类 —— 如实说一句，免得人以为筛坏了
  const 空类 = facets.types.filter((t) => t.count === 0).map((t) => t.value);
  if (空类.length > 0) {
    warnings.push(
      `六类资料里 ${空类.join("、")} 现在**一本都没有**（不是筛错了）：` +
        "punch 侧 doc.类型 声明六类，实际入库的只有 " +
        facets.types
          .filter((t) => t.count > 0)
          .map((t) => `${t.value} ${t.count}`)
          .join(" / ") +
        "。",
    );
  }
  // 类型不在六类里的（脏值）也要报，别静默吞掉
  const 野类 = [...typeCounts.keys()].filter(
    (t) => !SHELF_DOC_TYPES.includes(t as ShelfDocType),
  );
  if (野类.length > 0) {
    warnings.push(
      `punch 库里出现了六类之外的 doc.类型：${野类.join("、")} —— 分类 tab 上没有它们的位置，请核对。`,
    );
  }

  return {
    rows,
    facets,
    totalDocs: 全量.length,
    windowFilters,
    dbPath: describeDbPath(h.path),
    ms: Date.now() - t0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

export interface ShelfMemberLink {
  id: number;
  name: string;
  version: string | null;
  type: string;
  questions: number;
}

export interface ShelfMaterial {
  id: number;
  account: string;
  isActive: boolean;
  title: string | null;
  body: string | null;
  /** 话题词：JSON 数组原串（解析在展示层做，坏串照登） */
  topicsRaw: string | null;
  goodsDesc: string | null;
  netdiskWords: string | null;
  /** 🔴 burned = 「发过即烧」防同质化开关；实测库里全 0（这个机制没启用） */
  burned: boolean;
  createdAt: string | null;
}

export interface ShelfAsset {
  id: number;
  type: string;
  /** 本机绝对路径（🔴 手机上等于没给，预览一律走 /api/shelf/file） */
  path: string;
  ord: number | null;
  renderedAt: string | null;
}

export interface ShelfPublishLog {
  id: number;
  materialId: number;
  account: string | null;
  date: string | null;
  result: string | null;
  note: string | null;
}

export interface ShelfDocDetail {
  doc: ShelfDocRow;
  materials: ShelfMaterial[];
  assets: ShelfAsset[];
  /** 题目分组统计（按 section × 题型） */
  questionGroups: { section: string | null; qtype: string | null; n: number }[];
  members: ShelfMemberLink[];
  includedIn: ShelfMemberLink[];
  /** 发布台账（punch `publish_log`）；实测 0 行，空态口径见页面 */
  publishLogs: ShelfPublishLog[];
  dbPath: string;
}

export async function getShelfDoc(
  id: number,
  opts: { url?: string } = {},
): Promise<ShelfDocDetail | null> {
  const h = await getPunchDb(opts.url);
  const raw = h.query<RawDocRow>(
    `SELECT ${DOC_SELECT} FROM doc d WHERE d.id = ?`,
    [id],
  );
  const r0 = raw[0];
  if (!r0) return null;
  const doc = toShelfRow(r0);

  const materials = h
    .query<{
      id: number;
      账号: string;
      is_active: number;
      标题: string | null;
      正文: string | null;
      话题词: string | null;
      商品描述: string | null;
      网盘分享语: string | null;
      burned: number;
      created_at: string | null;
    }>(
      `SELECT id, 账号, is_active, 标题, 正文, 话题词, 商品描述, 网盘分享语, burned, created_at
         FROM material WHERE doc_id = ? ORDER BY 账号, id`,
      [id],
    )
    .map((m) => ({
      id: Number(m.id),
      account: m.账号,
      isActive: Number(m.is_active) === 1,
      title: m.标题,
      body: m.正文,
      topicsRaw: m.话题词,
      goodsDesc: m.商品描述,
      netdiskWords: m.网盘分享语,
      burned: Number(m.burned) === 1,
      createdAt: m.created_at,
    }));

  const assets = h
    .query<{
      id: number;
      类型: string;
      路径: string;
      配图顺序: number | null;
      rendered_at: string | null;
    }>(
      `SELECT id, 类型, 路径, 配图顺序, rendered_at FROM asset WHERE doc_id = ?
        ORDER BY 类型, 配图顺序, 路径`,
      [id],
    )
    .map((a) => ({
      id: Number(a.id),
      type: a.类型,
      path: a.路径,
      ord: a.配图顺序 === null ? null : Number(a.配图顺序),
      renderedAt: a.rendered_at,
    }));

  const questionGroups = h
    .query<{ section: string | null; 题型: string | null; c: number }>(
      `SELECT section, 题型, COUNT(*) c FROM question WHERE doc_id = ?
        GROUP BY section, 题型 ORDER BY c DESC`,
      [id],
    )
    .map((q) => ({ section: q.section, qtype: q.题型, n: Number(q.c) }));

  const MEMBER_COLS = `x.id, x.名称, x.版本名, x.类型,
      (SELECT COUNT(*) FROM question q WHERE q.doc_id = x.id) AS 题数`;
  const toMember = (m: {
    id: number;
    名称: string;
    版本名: string | null;
    类型: string;
    题数: number;
  }): ShelfMemberLink => ({
    id: Number(m.id),
    name: m.名称,
    version: m.版本名,
    type: m.类型,
    questions: Number(m.题数),
  });
  const members = h
    .query<Parameters<typeof toMember>[0]>(
      `SELECT ${MEMBER_COLS} FROM doc_member m JOIN doc x ON x.id = m.成员doc_id
        WHERE m.合刊doc_id = ? ORDER BY m.排序, x.名称`,
      [id],
    )
    .map(toMember);
  const includedIn = h
    .query<Parameters<typeof toMember>[0]>(
      `SELECT ${MEMBER_COLS} FROM doc_member m JOIN doc x ON x.id = m.合刊doc_id
        WHERE m.成员doc_id = ? ORDER BY x.名称`,
      [id],
    )
    .map(toMember);

  const publishLogs = h
    .query<{
      id: number;
      material_id: number;
      账号: string | null;
      日期: string | null;
      结果: string | null;
      备注: string | null;
    }>(
      `SELECT p.id, p.material_id, m.账号, p.日期, p.结果, p.备注
         FROM publish_log p LEFT JOIN material m ON m.id = p.material_id
        WHERE m.doc_id = ? ORDER BY p.日期 DESC, p.id DESC`,
      [id],
    )
    .map((p) => ({
      id: Number(p.id),
      materialId: Number(p.material_id),
      account: p.账号,
      date: p.日期,
      result: p.结果,
      note: p.备注,
    }));

  return {
    doc,
    materials,
    assets,
    questionGroups,
    members,
    includedIn,
    publishLogs,
    dbPath: describeDbPath(h.path),
  };
}

// ---------------------------------------------------------------------------
// 货架题目浏览（AI:PRD-009 验收修复 · 2026-08-15）
//
// 🔴🔴 为什么补这一段：punch 库的 3230 道题（分布在 15 本册子里）在货架上**一道都
//      看不到** —— 本模块原来对 question 表只有 COUNT/GROUP BY，从没 select 过 stem。
//      而 punch-console v2 有整张 `/questions` 页（关键词 + 考点 + 题型/册筛选、
//      考点覆盖条、逐题题面/实算/第几天·section·seq），册详情页还有一条
//      「到题目库看这册的题 →」。设计稿 §五·3 的判据是「/shelf 与 punch-console
//      功能对照**零缺项**（浏览面）」，少一整张页显然不是零缺项。
//      「两库题零交集、不该跳本库 /question」只解释了**不能跳哪儿**，
//      没有替代「在货架里能看这册的题」。
//
// 🔴 仍然是 mode=ro 的 SELECT，一个字都不写。
// ---------------------------------------------------------------------------

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ豈-﫿]/;
const ALNUM_RE = /[0-9A-Za-z]/;

/**
 * 🔴 punch 侧 FTS 的**分词口径**（逐字照搬 punch-console v2 `src/db/fts.ts`）。
 *
 *   `question_fts` 建的是 `fts5(stem, tokenize='unicode61')`，而 unicode61 把
 *   一整串汉字当成**一个 token**（「三位数乘两位数」只索引成一个词，搜「乘法」
 *   永远命中不了）。所以 v2 在**入库前**就把中文切成 bigram（相邻两字）、
 *   英数原样保留，空格拼接后才塞进 FTS —— 实测索引里存的是 `6 2` 这种。
 *   ⇒ 查询端必须用**同一把切法**，口径才对得上；这里不是重新发明，是照抄。
 *
 * 🔴 这是纯函数、可单测（tests/punch-guard.test.ts 钉着它与 v2 同口径）。
 */
export function punchFtsTokenize(text: string): string[] {
  const out: string[] = [];
  const s = (text || "").normalize("NFKC");
  let buf = "";
  const cjkRun: string[] = [];
  const flushAlnum = (): void => {
    if (buf) {
      out.push(buf.toLowerCase());
      buf = "";
    }
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 0) return;
    if (cjkRun.length === 1) out.push(cjkRun[0]!);
    else {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        out.push(cjkRun[i]! + cjkRun[i + 1]!);
      }
    }
    cjkRun.length = 0;
  };
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      flushAlnum();
      cjkRun.push(ch);
    } else if (ALNUM_RE.test(ch)) {
      flushCjk();
      buf += ch;
    } else {
      flushAlnum();
      flushCjk();
    }
  }
  flushAlnum();
  flushCjk();
  return out;
}

/**
 * 关键词 → FTS5 MATCH 表达式（逐词 AND，每个词加引号防注入/防语法字符）。
 * 🔴 用户敲的 `"`、`*`、`NEAR` 这些在 FTS5 里都是语法 —— 一律当字面词处理。
 */
export function toPunchMatchExpr(kw: string): string {
  const toks = punchFtsTokenize(kw).filter((t) => t.trim() !== "");
  if (toks.length === 0) return "";
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

/** 一道货架题（punch `question` + 它所属册的名字）。🔴 键名转 ASCII，当线上契约走 */
export interface PunchQuestionRow {
  id: number;
  docId: number | null;
  docName: string | null;
  docVersion: string | null;
  day: number | null;
  section: string | null;
  seq: number | null;
  stem: string;
  answer: string | null;
  qtype: string | null;
  /** 考点：JSON 数组原串解析出来的数组（坏串原样当一个词，不吞） */
  kps: string[];
  /** 实算三态：绿 / 红 / 未算 */
  calc: string | null;
  source: string | null;
}

export interface PunchQuestionOptions {
  keyword?: string;
  docId?: number;
  qtype?: string;
  kp?: string;
  /** 一次最多取多少（默认 60，上限 500）——货架是浏览面，不做深翻页 */
  limit?: number;
  url?: string;
}

export interface PunchQuestionResult {
  rows: PunchQuestionRow[];
  /** 满足过滤条件的总数（关键词轴命中数在 hitCount） */
  filteredTotal: number;
  /** 关键词轴命中数；没给关键词时 = filteredTotal */
  hitCount: number;
  /** 题型 facet（全库口径，不随筛选变 —— 变了看起来像库里突然没有了） */
  qtypes: ShelfFacet[];
  /** 有题的册（值是 doc.id 的字符串） */
  docs: (ShelfFacet & { name: string; version: string | null })[];
  /** 考点覆盖：已标 / 未标 / 逐考点计数（在**当前过滤集**上算，考点维除外） */
  coverage: { tagged: number; untagged: number; items: ShelfFacet[] };
  dbPath: string;
  ms: number;
  /** 🔴 降级/口径提醒，一条不吞 */
  warnings: string[];
}

function parseKps(raw: string | null): string[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const o: unknown = JSON.parse(raw);
    return Array.isArray(o) ? o.map((x) => String(x)) : [String(o)];
  } catch {
    return [raw];
  }
}

const Q_SELECT = `
  q.id, q.doc_id, d.名称 AS 册名, d.版本名, q.day, q.section, q.seq,
  q.stem, q.answer, q.题型, q.考点, q.实算, q.来源`;

interface RawQuestionRow {
  id: number;
  doc_id: number | null;
  册名: string | null;
  版本名: string | null;
  day: number | null;
  section: string | null;
  seq: number | null;
  stem: string;
  answer: string | null;
  题型: string | null;
  考点: string | null;
  实算: string | null;
  来源: string | null;
}

function toQuestionRow(r: RawQuestionRow): PunchQuestionRow {
  return {
    id: Number(r.id),
    docId: r.doc_id === null ? null : Number(r.doc_id),
    docName: r.册名,
    docVersion: r.版本名,
    day: r.day === null ? null : Number(r.day),
    section: r.section,
    seq: r.seq === null ? null : Number(r.seq),
    stem: r.stem,
    answer: r.answer,
    qtype: r.题型,
    kps: parseKps(r.考点),
    calc: r.实算,
    source: r.来源,
  };
}

/**
 * 列货架的题（**只读**）。
 *
 * 检索面（对照 v2 那张 /questions）：
 *   · 关键词 → FTS5（同一把 bigram 切法）；MATCH 炸了或零命中就退成 `LIKE`，
 *     并在 warnings 里**如实说降级了**（不假装是「库里没有」）；
 *   · 册 / 题型 / 考点 → SQL 硬过滤（考点是 JSON 数组文本，按 `%"考点名"%` 匹配，
 *     带引号才不会让「乘法」把「乘法分配律」也捞进来——v2 的口径）；
 *   · 🔴 **语意轴没有搬过来**：punch 的 `向量` 是 v2 自己那套 sidecar 模型算的，
 *     本产品用另一套 ONNX 句向量，两边不同源，拿本库的模型去查它的向量是错的。
 *     所以这里只有两路，页面上照实写着（绝不假装三路）。
 */
export async function listPunchQuestions(
  opts: PunchQuestionOptions = {},
): Promise<PunchQuestionResult> {
  const t0 = Date.now();
  const h = await getPunchDb(opts.url);
  const warnings: string[] = [];
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 500);

  const clauses: string[] = [];
  const args: unknown[] = [];
  if (opts.docId !== undefined && Number.isFinite(opts.docId)) {
    clauses.push("q.doc_id = ?");
    args.push(opts.docId);
  }
  if (opts.qtype) {
    clauses.push("q.题型 = ?");
    args.push(opts.qtype);
  }
  if (opts.kp) {
    // 🔴 带引号匹配（v2 口径）：不带的话「乘法」会把「乘法分配律」也捞进来
    clauses.push("q.考点 LIKE ?");
    args.push(`%"${opts.kp}"%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const filteredTotal = Number(
    h.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM question q ${where}`,
      args,
    )[0]?.c ?? 0,
  );

  const kw = (opts.keyword ?? "").trim();
  let rows: PunchQuestionRow[] = [];
  let hitCount = filteredTotal;

  if (!kw) {
    rows = h
      .query<RawQuestionRow>(
        `SELECT ${Q_SELECT} FROM question q LEFT JOIN doc d ON d.id = q.doc_id
         ${where} ORDER BY q.doc_id, q.day, q.section, q.seq LIMIT ?`,
        [...args, limit],
      )
      .map(toQuestionRow);
  } else {
    const match = toPunchMatchExpr(kw);
    let ftsRows: RawQuestionRow[] = [];
    let ftsCount = 0;
    if (match) {
      try {
        const w2 = ["question_fts MATCH ?", ...clauses];
        ftsCount = Number(
          h.query<{ c: number }>(
            `SELECT COUNT(*) AS c FROM question_fts f JOIN question q ON q.id = f.rowid
             WHERE ${w2.join(" AND ")}`,
            [match, ...args],
          )[0]?.c ?? 0,
        );
        ftsRows = h.query<RawQuestionRow>(
          `SELECT ${Q_SELECT} FROM question_fts f
             JOIN question q ON q.id = f.rowid
             LEFT JOIN doc d ON d.id = q.doc_id
           WHERE ${w2.join(" AND ")}
           ORDER BY bm25(question_fts) LIMIT ?`,
          [match, ...args, limit],
        );
      } catch (e) {
        warnings.push(
          `关键词轴（FTS5）没跑成，已退成 LIKE 逐字包含：${
            e instanceof Error ? `${e.name}: ${e.message}` : String(e)
          }`,
        );
        ftsRows = [];
      }
    } else {
      warnings.push(
        `「${kw}」切不出任何可检索的词（标点/空白），关键词轴退成 LIKE 逐字包含。`,
      );
    }

    if (ftsRows.length > 0) {
      rows = ftsRows.map(toQuestionRow);
      hitCount = ftsCount;
    } else {
      // 🔴 退成 LIKE：FTS 索引可能落后于 question 表（产线那边是手工同步、0 触发器），
      //    这时候「FTS 零命中」不代表「库里没有这句话」——退一步再查一次，并说清楚。
      const w3 = [...clauses, "q.stem LIKE ?"];
      const likeArgs = [...args, `%${kw}%`];
      hitCount = Number(
        h.query<{ c: number }>(
          `SELECT COUNT(*) AS c FROM question q WHERE ${w3.join(" AND ")}`,
          likeArgs,
        )[0]?.c ?? 0,
      );
      rows = h
        .query<RawQuestionRow>(
          `SELECT ${Q_SELECT} FROM question q LEFT JOIN doc d ON d.id = q.doc_id
           WHERE ${w3.join(" AND ")}
           ORDER BY q.doc_id, q.day, q.section, q.seq LIMIT ?`,
          [...likeArgs, limit],
        )
        .map(toQuestionRow);
      if (match && warnings.length === 0) {
        warnings.push(
          `关键词「${kw}」在 FTS 索引里零命中，已退成 LIKE 逐字包含（命中 ${hitCount} 条）——` +
            "punch 的 FTS 是产线手工同步的（0 触发器），索引可能落后于 question 表。",
        );
      }
    }
  }

  // ── facets：题型与册按**全库**数（筛完再数会让其它选项看起来消失了）
  const qtypes = h
    .query<{ v: string | null; c: number }>(
      `SELECT 题型 AS v, COUNT(*) AS c FROM question WHERE 题型 IS NOT NULL
        GROUP BY 题型 ORDER BY c DESC, v`,
    )
    .filter((r) => r.v !== null)
    .map((r) => ({ value: r.v!, count: Number(r.c) }));
  const docs = h
    .query<{ id: number; name: string; version: string | null; c: number }>(
      `SELECT d.id AS id, d.名称 AS name, d.版本名 AS version, COUNT(q.id) AS c
         FROM doc d JOIN question q ON q.doc_id = d.id
        GROUP BY d.id ORDER BY c DESC, d.名称`,
    )
    .map((r) => ({
      value: String(r.id),
      count: Number(r.c),
      name: r.name,
      version: r.version,
    }));

  // ── 考点覆盖：在当前过滤集上算（考点这一维本身除外，否则永远是 100%）
  const covClauses = clauses.filter((c) => !c.startsWith("q.考点"));
  const covArgs: unknown[] = [];
  {
    // 重新按 covClauses 的顺序取参数（clauses 与 args 是同序 push 的）
    let i = 0;
    for (const c of clauses) {
      if (!c.startsWith("q.考点")) covArgs.push(args[i]);
      i++;
    }
  }
  const covWhere = (extra: string[]): string => {
    const all = [...covClauses, ...extra];
    return all.length ? `WHERE ${all.join(" AND ")}` : "";
  };
  const tagged = Number(
    h.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM question q ${covWhere(["q.考点 IS NOT NULL", "q.考点 <> ''", "q.考点 <> '[]'"])}`,
      covArgs,
    )[0]?.c ?? 0,
  );
  const untagged = Number(
    h.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM question q ${covWhere(["(q.考点 IS NULL OR q.考点 = '' OR q.考点 = '[]')"])}`,
      covArgs,
    )[0]?.c ?? 0,
  );
  const items = h
    .query<{ kp: string; c: number }>(
      `SELECT je.value AS kp, COUNT(*) AS c
         FROM question q, json_each(q.考点) je
        ${covWhere(["q.考点 IS NOT NULL", "json_valid(q.考点)"])}
        GROUP BY je.value ORDER BY c DESC, kp`,
      covArgs,
    )
    .map((r) => ({ value: String(r.kp), count: Number(r.c) }));

  if (rows.length >= limit && hitCount > rows.length) {
    warnings.push(
      `命中 ${hitCount} 条，本页只取回前 ${limit} 条（货架是浏览面，不做深翻页）——收窄条件即可看到后面的题。`,
    );
  }

  return {
    rows,
    filteredTotal,
    hitCount,
    qtypes,
    docs,
    coverage: { tagged, untagged, items },
    dbPath: describeDbPath(h.path),
    ms: Date.now() - t0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 🔴 资产文件放行闸（图片/PDF 预览的唯一通路）
// ---------------------------------------------------------------------------

/** 放行的扩展名 → Content-Type（只放图与 PDF；.py/.json/.db 这类一律不放） */
export const PUNCH_FILE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

/** 一次读进内存的上限（本地产物就是几百 KB 的 PDF / 几 MB 的图） */
export const PUNCH_FILE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 货架资产根 = **punch 库文件所在目录**（`举一反三产物/`）。
 * 🔴 不写死常量：库在哪，资产就在哪（实测 694 条 asset.路径 全在这个根下的
 *    打卡/ 专项卷/ 合卷/ 三个子目录里）。根从连接串推出来，改库位置不用改代码。
 */
export function punchAssetRoot(dbPath: string): string {
  const p = resolvePath(dbPath);
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i > 0 ? p.slice(0, i) : p;
}

export interface PunchFileGrant {
  ok: true;
  absPath: string;
  mime: string;
  bytes: number;
  /** 这份文件在 punch 里的登记行（哪本册子的什么角色） */
  registered: { assetId: number; docId: number; type: string; docName: string };
}
export interface PunchFileDeny {
  ok: false;
  /** 400 参数不对 / 403 不放行 / 404 不存在 / 413 太大 */
  status: 400 | 403 | 404 | 413;
  reason: string;
}

/**
 * 四道闸放行一份货架文件（**只读**，闸的顺序就是排查顺序）：
 *   ① 登记闸：路径必须在 punch `asset.路径` 里有登记行 ——
 *      🔴 与本库 `/api/asset/<hash>` 同一条哲学：**库里查不到登记行的文件视同不存在**。
 *      比 punch-console v1/v2 的「整个工作区放行」窄得多：那边给的是「根内任意文件」，
 *      这边给的是「账上真有这一件」。
 *   ② 边界闸：resolve 后必须仍在货架资产根内（挡 `..` 穿越 / 软链跳出）。
 *   ③ 类型闸：扩展名白名单（图 + PDF）。
 *   ④ 体积闸：≤ 64MB（要一次读进内存，见 route 里的「绝不流转」红线）。
 */
export async function grantPunchFile(
  rawPath: string,
  opts: { url?: string } = {},
): Promise<PunchFileGrant | PunchFileDeny> {
  const p = (rawPath ?? "").trim();
  if (!p || p.includes("\0")) {
    return { ok: false, status: 400, reason: "路径为空（或含非法字符）" };
  }

  const h = await getPunchDb(opts.url);
  const abs = resolvePath(p);

  // ① 登记闸：拿绝对路径去 asset 表反查（Windows 大小写不敏感，两边都归一化后比）
  const key = abs.replace(/\\/g, "/").toLowerCase();
  const hit = h.query<{
    id: number;
    doc_id: number;
    类型: string;
    路径: string;
    名称: string;
  }>(
    `SELECT a.id, a.doc_id, a.类型, a.路径, d.名称
       FROM asset a LEFT JOIN doc d ON d.id = a.doc_id
      WHERE lower(replace(a.路径, '\\', '/')) = ?`,
    [key],
  )[0];
  if (!hit) {
    return {
      ok: false,
      status: 403,
      reason:
        `punch 的 asset 表里没有这条路径的登记行：${abs}\n` +
        "🔴 货架只放行**账上真有**的产物件（与本库 /api/asset/<hash> 同一条哲学：" +
        "库里查不到登记行的文件视同不存在）。产物换了位置就重跑产线的 import 让账对上，" +
        "不要在这里开一条读任意文件的路。",
    };
  }

  // ② 边界闸
  const root = punchAssetRoot(h.path);
  const rel = abs.slice(0, root.length).toLowerCase() === root.toLowerCase();
  if (!rel || abs.length <= root.length || abs[root.length] !== sep) {
    return {
      ok: false,
      status: 403,
      reason: `这条登记路径不在货架资产根内，不放行。\n登记路径：${abs}\n货架资产根：${root}`,
    };
  }

  // ③ 类型闸
  const ext = extname(abs).toLowerCase();
  const mime = PUNCH_FILE_MIME[ext];
  if (!mime) {
    return {
      ok: false,
      status: 403,
      reason: `不放行的文件类型：${ext || "（没有扩展名）"} —— 货架只放行图片与 PDF。`,
    };
  }

  // ④ 存在 + 体积
  if (!existsSync(abs)) {
    return {
      ok: false,
      status: 404,
      reason:
        `登记行在（asset ${hit.id} · 册「${hit.名称}」的${hit.类型}），文件却不在盘上：${abs}\n` +
        "这是「账上有、盘上没有」的差异，去 /shelf/reconcile 看这一类还有多少。",
    };
  }
  const st = statSync(abs);
  if (!st.isFile()) {
    return { ok: false, status: 400, reason: `不是文件：${abs}` };
  }
  if (st.size > PUNCH_FILE_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      reason: `文件太大（${(st.size / 1048576).toFixed(0)}MB），本路由只吐 64MB 以内`,
    };
  }

  return {
    ok: true,
    absPath: abs,
    mime,
    bytes: st.size,
    registered: {
      assetId: Number(hit.id),
      docId: Number(hit.doc_id),
      type: hit.类型,
      docName: hit.名称,
    },
  };
}
