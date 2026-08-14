/**
 * core/shelf-reconcile.ts —— 两库对账：**货架 punch 的成品 ↔ 本库的 SKU / 网盘指针**
 * （AI:PRD-009 · D-B 第三页 `/shelf/reconcile`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库警示（接线文件头必须重申）
 *   货架库（punch）= `举一反三产物/资料库.db`（doc/question/asset/material/doc_member…）
 *   工厂库（本库）  = `codeplace-AI/knowledge-factory/data/资料库.db`（sku/sku_output/question…）
 *   两个文件同名、schema 完全不同。本模块**同时读两边**，因此格外要写清楚谁是谁。
 *
 * 🔴🔴 **差异只报不改**（PRD-009 §二 明写）。本模块零写：
 *    - 对 punch：物理只读（core/punch.ts 的三道锁）；
 *    - 对本库：只 SELECT，不 logMetric、不写审计行 —— 打开一个页面不该改库。
 *    对不上要怎么办（改哪边、合并成一本、还是各归各）是**人的判断**，
 *    这一页只负责把差异摆到桌面上。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 三条轴，强弱分明（别把弱键当结论）────────────────────────────────────────
 *   轴 A · 成品文件（**强键 = 绝对路径**）
 *        punch `asset.路径`  ↔  本库 `sku_output.gate_results_json.src`
 *        这是目前**唯一可机器对账**的键：两边都存了「这份 PDF/图在盘上的哪儿」。
 *   轴 B · 册子名（**弱键 = 归一化名称**，只能给线索）
 *        punch `doc.名称/组名`  ↔  本库 `sku.name`
 *        实测两边命名法不同（punch「七上绝对值压轴突破」↔ 本库「绝对值突破·十天打卡」），
 *        所以 fuzzy 命中一律标「待人工确认」，**绝不当成已对上**。
 *   轴 C · 网盘指针（挂在轴 B 的结果上）
 *        punch `doc.网盘链接/提取码`  ↔  本库 `sku.recipe_json.netdisk`
 *        🔴 两边都「没有」不是差异：punch 没链接=这本没传过网盘；
 *           本库配方没记 netdisk 段 ≠ 没传过网盘（真凭据在 网盘分发记录/分享链接总表.md）。
 *
 * 🔴 题级**不对账**：实测把本库 642 题按 punch 的 hash 口径（NFKC+去空白+sha1）重算，
 *    与 punch 的 2755 个不同 hash **交集 = 0**。两库的重叠发生在「书/成品」层，
 *    不在「题」层 —— 在这一页做题级比对只会产出 3230×642 次无意义比较。
 */
import { existsSync } from "node:fs";

import { getCoreDb, type CoreDbHandle } from "./db";
import { getPunchDb } from "./punch";
import { describeDbPath } from "./grading";
import { nowLocalISO } from "./time";
import { asset, sku, skuOutput } from "~/server/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// 归一化（两把尺子，各用各的）
// ---------------------------------------------------------------------------

/** 路径键：反斜杠拉平 + 小写（Windows 大小写不敏感，两库写法也不统一） */
export function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

/**
 * 册名键（**弱键**）：剥 `2.1 ` 这类管线序号前缀、去掉分隔符与空白、小写。
 * 🔴 只用来找线索，不用来下结论 —— 见文件头轴 B。
 */
export function bookKey(name: string): string {
  return name
    .trim()
    .replace(/^\d+\.\d+\s+/, "")
    .replace(/[\s·、,，.。\-—_（）()【】\[\]]/g, "")
    .toLowerCase();
}

/** `sku_output.gate_results_json` → 登记时那份**源绝对路径**（取不到就 null，不猜） */
export function srcOfGateJson(gate: string | null): string | null {
  if (!gate) return null;
  try {
    const o = JSON.parse(gate) as { src?: unknown };
    return typeof o.src === "string" && o.src.trim() !== ""
      ? o.src.trim()
      : null;
  } catch {
    return null;
  }
}

/** `sku.recipe_json` → netdisk 段（链接/提取码）。坏 JSON 如实标 broken，不当作「没有」 */
export function netdiskOfRecipe(recipeJson: string | null): {
  link: string | null;
  code: string | null;
  broken: boolean;
  present: boolean;
} {
  if (!recipeJson)
    return { link: null, code: null, broken: false, present: false };
  let o: unknown;
  try {
    o = JSON.parse(recipeJson);
  } catch {
    return { link: null, code: null, broken: true, present: false };
  }
  if (!o || typeof o !== "object") {
    return { link: null, code: null, broken: false, present: false };
  }
  const seg = (o as Record<string, unknown>).netdisk;
  if (!seg || typeof seg !== "object") {
    return { link: null, code: null, broken: false, present: false };
  }
  const r = seg as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const link = str(r.链接) ?? str(r.link);
  let code = str(r.提取码) ?? str(r.pwd);
  if (!code && link) {
    const m = /[?&]pwd=([0-9a-zA-Z]+)/.exec(link);
    code = m?.[1] ?? null;
  }
  return { link, code, broken: false, present: true };
}

/** 网盘链接比对前先摘掉 `?pwd=`（同一条链接带不带提取码参数，不该算不一致） */
export function linkKey(link: string | null): string | null {
  if (!link) return null;
  return link
    .trim()
    .replace(/[?&]pwd=[0-9a-zA-Z]+/g, "")
    .replace(/[?&]$/, "");
}

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

export interface FileMatchRow {
  /** 归一化后的路径键（表格 rowKey） */
  key: string;
  path: string;
  /** punch 侧 */
  punchDocId: number | null;
  punchDocName: string | null;
  punchAssetType: string | null;
  /** 本库侧 */
  kfSkuId: string | null;
  kfSkuName: string | null;
  kfOutputKind: string | null;
  kfHash: string | null;
  /** 文件此刻在不在盘上（两边的账都指着同一个盘） */
  onDisk: boolean;
}

/**
 * 一对「货架册子 ↔ 本库 SKU」的配对。
 *
 * 🔴 `how` 决定这一对能不能当结论用：
 *   - `路径`   = **强证据**：两边至少共用一份成品文件（轴 A 的强键推出来的）。
 *                实测两边命名法完全不同（「七上绝对值压轴突破」↔「绝对值突破·十天打卡」），
 *                所以**真正靠得住的配对全靠这一档**。
 *   - `名称`   = 归一化册名相等（弱，但基本可信）；
 *   - `名称疑似` = 一方的名字包含另一方（**只是线索**，要人拍板）。
 */
export interface BookMatchRow {
  key: string;
  how: "路径" | "名称" | "名称疑似";
  /** how=路径 时：两边共用了几份文件（证据强度） */
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

export interface NetdiskRow {
  punchDocId: number;
  punchDocName: string;
  kfSkuId: string | null;
  kfSkuName: string | null;
  /** 这一对是怎么配上的（🔴 `名称疑似` 的行，结论本身就带问号） */
  pairedBy: BookMatchRow["how"] | null;
  punchLink: string | null;
  punchCode: string | null;
  kfLink: string | null;
  kfCode: string | null;
  /** 一致 / 不一致 / 只货架有 / 只工厂有 / 两边都没有 / 配方坏了 / 工厂没这本册子 */
  verdict:
    | "一致"
    | "链接不一致"
    | "提取码不一致"
    | "只货架有"
    | "只工厂有"
    | "两边都没有"
    | "配方坏了"
    | "工厂没这本册子";
  note: string;
}

export interface ShelfReconcileReport {
  takenAt: string;
  punchDbPath: string;
  kfDbPath: string;
  ms: number;
  /** 轴 A · 成品文件（绝对路径强键） */
  fileAxis: {
    punchAssets: number;
    kfOutputs: number;
    /** 本库产出行里**没记 src** 的（对不上不是差异，是登记时就没留下线索） */
    kfOutputsWithoutSrc: number;
    matched: FileMatchRow[];
    punchOnly: FileMatchRow[];
    kfOnly: FileMatchRow[];
    /** 账上有、盘上没有（两边合计，去重后） */
    missingOnDisk: FileMatchRow[];
    /** punchOnly 按目录根归堆（几百行，先给一张分布表再给明细） */
    punchOnlyByRoot: { root: string; n: number }[];
    kfOnlyByRoot: { root: string; n: number }[];
  };
  /** 轴 B · 册子名（弱键） */
  bookAxis: {
    punchDocs: number;
    kfSkus: number;
    matched: BookMatchRow[];
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
  /** 轴 C · 网盘指针 */
  netdiskAxis: {
    rows: NetdiskRow[];
    counts: Record<NetdiskRow["verdict"], number>;
  };
  /** punch 侧「声明了却没用」的四张空表（如实数一遍，别当成有数据） */
  punchEmptyTables: { table: string; rows: number; 说明: string }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 跑一次对账
// ---------------------------------------------------------------------------

/**
 * 现场跑一次两库对账。**零写**（不 logMetric、不留审计行）。
 * @param opts.punchUrl 覆盖货架连接串（测试用）
 * @param opts.handle   复用本库句柄
 */
export async function reconcileShelf(
  opts: { punchUrl?: string; handle?: CoreDbHandle } = {},
): Promise<ShelfReconcileReport> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const ph = await getPunchDb(opts.punchUrl);
  const kh = opts.handle ?? (await getCoreDb());

  // ── 取数：punch 侧 ────────────────────────────────────────────────────────
  const punchAssets = ph.query<{
    id: number;
    doc_id: number;
    类型: string;
    路径: string;
    名称: string | null;
  }>(
    `SELECT a.id, a.doc_id, a.类型, a.路径, d.名称
       FROM asset a LEFT JOIN doc d ON d.id = a.doc_id`,
  );
  const punchDocs = ph.query<{
    id: number;
    名称: string;
    类型: string;
    组名: string | null;
    版本名: string | null;
    人工态: string | null;
    网盘链接: string | null;
    提取码: string | null;
  }>(
    `SELECT id, 名称, 类型, 组名, 版本名, 人工态, 网盘链接, 提取码 FROM doc ORDER BY id`,
  );
  /**
   * 数一张 punch 表有几行。
   * 🔴 表名是**字面量联合**不是自由字符串：SQLite 的表名位置绑不了参数，
   *    只能拼串 —— 那就把可拼的名字锁死在类型里，不给「传进来一个变量」的机会。
   */
  const 空表 = (
    t: "collection_item" | "generator" | "task" | "publish_log",
  ): number =>
    Number(ph.query<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)[0]?.n ?? 0);

  // ── 取数：本库侧（只 SELECT）──────────────────────────────────────────────
  const kfSkus = await kh.db
    .select({
      id: sku.id,
      name: sku.name,
      type: sku.type,
      status: sku.status,
      recipeJson: sku.recipeJson,
    })
    .from(sku);
  const kfOutputs = await kh.db
    .select({
      id: skuOutput.id,
      skuId: skuOutput.skuId,
      kind: skuOutput.kind,
      gate: skuOutput.gateResultsJson,
      // 🔴 hash 一起取：本库这一侧的文件是**内容寻址**的，页面要给一条
      //    `/api/asset/<hash>` 的下载路（货架那侧走 /api/shelf/file 的绝对路径）
      hash: asset.hash,
    })
    .from(skuOutput)
    .leftJoin(asset, eq(asset.id, skuOutput.assetId));
  const skuById = new Map(kfSkus.map((s) => [s.id, s]));

  // ══ 轴 A · 成品文件（绝对路径强键）══════════════════════════════════════
  const punchByPath = new Map<string, (typeof punchAssets)[number]>();
  for (const a of punchAssets) {
    const k = pathKey(a.路径);
    if (!punchByPath.has(k)) punchByPath.set(k, a);
  }
  const kfByPath = new Map<
    string,
    { src: string; out: (typeof kfOutputs)[number] }
  >();
  let kfOutputsWithoutSrc = 0;
  for (const o of kfOutputs) {
    const src = srcOfGateJson(o.gate);
    if (!src) {
      kfOutputsWithoutSrc += 1;
      continue;
    }
    const k = pathKey(src);
    if (!kfByPath.has(k)) kfByPath.set(k, { src, out: o });
  }

  /** 盘上在不在：同一条路径只 stat 一次（几百次本地 stat，几十毫秒） */
  const diskCache = new Map<string, boolean>();
  const onDisk = (p: string): boolean => {
    const c = diskCache.get(p);
    if (c !== undefined) return c;
    let ok = false;
    try {
      ok = existsSync(p);
    } catch {
      ok = false;
    }
    diskCache.set(p, ok);
    return ok;
  };

  const mkRow = (
    key: string,
    pa: (typeof punchAssets)[number] | undefined,
    kf: { src: string; out: (typeof kfOutputs)[number] } | undefined,
  ): FileMatchRow => {
    const path = pa?.路径 ?? kf?.src ?? key;
    const s = kf ? skuById.get(kf.out.skuId ?? "") : undefined;
    return {
      key,
      path,
      punchDocId: pa ? Number(pa.doc_id) : null,
      punchDocName: pa?.名称 ?? null,
      punchAssetType: pa?.类型 ?? null,
      kfSkuId: s?.id ?? null,
      kfSkuName: s?.name ?? null,
      kfOutputKind: kf?.out.kind ?? null,
      kfHash: kf?.out.hash ?? null,
      onDisk: onDisk(path),
    };
  };

  const matched: FileMatchRow[] = [];
  const punchOnly: FileMatchRow[] = [];
  const kfOnly: FileMatchRow[] = [];
  for (const [k, pa] of punchByPath) {
    const kf = kfByPath.get(k);
    if (kf) matched.push(mkRow(k, pa, kf));
    else punchOnly.push(mkRow(k, pa, undefined));
  }
  for (const [k, kf] of kfByPath) {
    if (!punchByPath.has(k)) kfOnly.push(mkRow(k, undefined, kf));
  }

  /** 路径 → 归堆用的目录根（截到 ai-bkb 下面两层，够看清是哪条产线的东西） */
  const rootOf = (p: string): string => {
    const s = p.replace(/\\/g, "/");
    const i = s.toLowerCase().indexOf("/ai-bkb/");
    const rel = i >= 0 ? s.slice(i + "/ai-bkb/".length) : s;
    return rel.split("/").slice(0, 2).join("/") + "/";
  };
  const byRoot = (rows: FileMatchRow[]): { root: string; n: number }[] => {
    const m = new Map<string, number>();
    for (const r of rows)
      m.set(rootOf(r.path), (m.get(rootOf(r.path)) ?? 0) + 1);
    return [...m.entries()]
      .map(([root, n]) => ({ root, n }))
      .sort((a, b) => b.n - a.n);
  };

  const missingOnDisk = [...matched, ...punchOnly, ...kfOnly].filter(
    (r) => !r.onDisk,
  );

  // ══ 轴 B · 册子配对：**先用轴 A 的强键推，名字只作补充** ══════════════════
  //   实测两边命名法完全不同（「七上绝对值压轴突破」↔「绝对值突破·十天打卡」），
  //   纯靠名字对账的命中数是 **0/79** —— 而共用文件一比就对上了。
  //   所以顺序是：路径推出的强配对优先，同一对不再被弱键覆盖。
  const docById = new Map(punchDocs.map((d) => [Number(d.id), d]));
  const bookMatched: BookMatchRow[] = [];
  const seenPair = new Set<string>();
  const punchMatchedIds = new Set<number>();
  const kfMatchedIds = new Set<string>();

  const pushPair = (
    how: BookMatchRow["how"],
    docId: number,
    skuId: string,
    sharedFiles: number,
  ): void => {
    const pk = `${docId}::${skuId}`;
    if (seenPair.has(pk)) return;
    const d = docById.get(docId);
    const s = skuById.get(skuId);
    if (!d || !s) return;
    seenPair.add(pk);
    bookMatched.push({
      key: pk,
      how,
      sharedFiles,
      punchDocId: docId,
      punchDocName: d.名称,
      punchType: d.类型,
      punchVersion: d.版本名,
      punchLane: d.人工态,
      kfSkuId: s.id,
      kfSkuName: s.name,
      kfType: s.type,
      kfStatus: s.status,
    });
    punchMatchedIds.add(docId);
    kfMatchedIds.add(skuId);
  };

  // ① 强：轴 A 对上的每份文件都给出一对 (doc, sku)，按对聚合共用文件数
  const shared = new Map<string, number>();
  for (const m of matched) {
    if (m.punchDocId === null || m.kfSkuId === null) continue;
    const pk = `${m.punchDocId}::${m.kfSkuId}`;
    shared.set(pk, (shared.get(pk) ?? 0) + 1);
  }
  for (const [pk, n] of shared) {
    const [docId, skuId] = pk.split("::");
    pushPair("路径", Number(docId), skuId!, n);
  }

  // ② 弱：归一化册名相等 / 一方包含另一方（punch 侧「名称」与「组名」都试）
  const kfKeyed = kfSkus.map((s) => ({ s, k: bookKey(s.name) }));
  for (const d of punchDocs) {
    const keys = [bookKey(d.名称), d.组名 ? bookKey(d.组名) : ""].filter(
      Boolean,
    );
    for (const { s, k } of kfKeyed) {
      const how: BookMatchRow["how"] | null = keys.includes(k)
        ? "名称"
        : keys.some(
              (pk) =>
                pk.length >= 4 &&
                k.length >= 4 &&
                (k.includes(pk) || pk.includes(k)),
            )
          ? "名称疑似"
          : null;
      if (how) pushPair(how, Number(d.id), s.id, 0);
    }
  }

  // ══ 轴 C · 网盘指针 ════════════════════════════════════════════════════
  const netdiskRows: NetdiskRow[] = [];
  for (const d of punchDocs) {
    const pLink = d.网盘链接?.trim() ?? null;
    const pCode = d.提取码?.trim() ?? null;
    // 一本 punch 册子可能连到多个 sku（fuzzy），逐对出一行；一个都没连到也出一行
    const pairs = bookMatched.filter((b) => b.punchDocId === Number(d.id));
    if (pairs.length === 0) {
      if (!pLink) continue; // 两边都没有、也没配对 —— 没有可报的差异
      netdiskRows.push({
        punchDocId: Number(d.id),
        punchDocName: d.名称,
        kfSkuId: null,
        kfSkuName: null,
        pairedBy: null,
        punchLink: pLink,
        punchCode: pCode,
        kfLink: null,
        kfCode: null,
        verdict: "工厂没这本册子",
        note: "货架挂了网盘链接，但本库按册名找不到对应 SKU（弱键，可能只是命名不同）",
      });
      continue;
    }
    for (const b of pairs) {
      const s = skuById.get(b.kfSkuId);
      const nd = netdiskOfRecipe(s?.recipeJson ?? null);
      let verdict: NetdiskRow["verdict"];
      let note = "";
      if (nd.broken) {
        verdict = "配方坏了";
        note =
          "本库 sku.recipe_json 解析不了（坏 JSON）—— 不是「没有配方」，是这份配方要修";
      } else if (pLink && nd.link) {
        if (linkKey(pLink) !== linkKey(nd.link)) {
          verdict = "链接不一致";
          note =
            "🔴 同一本册子两边记了不同的分享链接 —— 发出去的是哪一条要人来定";
        } else if ((pCode ?? "") !== (nd.code ?? "")) {
          verdict = "提取码不一致";
          note = "链接同一条，提取码记得不一样";
        } else {
          verdict = "一致";
          note = "链接与提取码都对得上";
        }
      } else if (pLink && !nd.link) {
        verdict = "只货架有";
        note =
          "本库 recipe_json 里没有 netdisk 段 —— 它的意思是「配方里没记网盘」，不是「没传过网盘」";
      } else if (!pLink && nd.link) {
        verdict = "只工厂有";
        note = "货架 doc.网盘链接 是空的，本库配方里却有链接";
      } else {
        verdict = "两边都没有";
        note = "两边都没记网盘 —— 不是差异，只是这本册子没有网盘指针";
      }
      netdiskRows.push({
        punchDocId: Number(d.id),
        punchDocName: d.名称,
        kfSkuId: b.kfSkuId,
        kfSkuName: b.kfSkuName,
        pairedBy: b.how,
        punchLink: pLink,
        punchCode: pCode,
        kfLink: nd.link,
        kfCode: nd.code,
        verdict,
        note:
          b.how === "名称疑似"
            ? `${note}（🔴 这一对是**名字像**配上的，不是同一本也说不定 —— 先认对不对再看链接）`
            : note,
      });
    }
  }
  const counts = {
    一致: 0,
    链接不一致: 0,
    提取码不一致: 0,
    只货架有: 0,
    只工厂有: 0,
    两边都没有: 0,
    配方坏了: 0,
    工厂没这本册子: 0,
  } as Record<NetdiskRow["verdict"], number>;
  for (const r of netdiskRows) counts[r.verdict] += 1;

  // ── 空表清点（声明了却从没用过的四张）────────────────────────────────────
  const punchEmptyTables = [
    {
      table: "collection_item",
      rows: 空表("collection_item"),
      说明: "题级引用（合刊排版取题）。册级归属走 doc_member，这张一直没用",
    },
    {
      table: "generator",
      rows: 空表("generator"),
      说明: "出题通式登记。本库对应的是 exam_model（22 条在用）",
    },
    {
      table: "task",
      rows: 空表("task"),
      说明: "收件台任务（v1 的队列下单要落这儿）",
    },
    {
      table: "publish_log",
      rows: 空表("publish_log"),
      说明: "发布流水。发布是用户手机人工发，没有回写通路，所以一直是 0",
    },
  ];

  // ── 如实提醒 ────────────────────────────────────────────────────────────
  if (kfOutputsWithoutSrc > 0) {
    warnings.push(
      `本库有 ${kfOutputsWithoutSrc} 件产出的 gate_results_json 里**没记 src** —— ` +
        "它们在轴 A 上既不算对上也不算独有（没有可比的键），不是「差异」。",
    );
  }
  const 强配对 = bookMatched.filter((b) => b.how === "路径").length;
  const 弱配对 = bookMatched.length - 强配对;
  if (弱配对 > 0) {
    warnings.push(
      `轴 B 里有 ${弱配对} 对是**靠名字**配上的（不是同一本也说不定）——` +
        "🔴 一律当线索看，要不要认成同一本请人拍板；" +
        `真正可信的是那 ${强配对} 对**共用成品文件**的强配对。`,
    );
  }
  if (强配对 === 0 && bookMatched.length === 0 && punchDocs.length > 0) {
    warnings.push(
      "两库在册子层**一对都没配上**：既没有共用成品文件，名字也对不上 —— " +
        "这说明两边现在是各记各的账（不是数据丢了）。",
    );
  }
  warnings.push(
    "🔴 本页只报差异、不改任何一边：punch 库物理只读，本库这一页也零写（不留审计行）。",
  );

  return {
    takenAt: nowLocalISO(),
    punchDbPath: describeDbPath(ph.path),
    kfDbPath: "codeplace-AI/knowledge-factory/data/资料库.db（相对 ai-bkb 根）",
    ms: Date.now() - t0,
    fileAxis: {
      punchAssets: punchAssets.length,
      kfOutputs: kfOutputs.length,
      kfOutputsWithoutSrc,
      matched,
      punchOnly,
      kfOnly,
      missingOnDisk,
      punchOnlyByRoot: byRoot(punchOnly),
      kfOnlyByRoot: byRoot(kfOnly),
    },
    bookAxis: {
      punchDocs: punchDocs.length,
      kfSkus: kfSkus.length,
      matched: bookMatched,
      punchOnly: punchDocs
        .filter((d) => !punchMatchedIds.has(Number(d.id)))
        .map((d) => ({
          id: Number(d.id),
          name: d.名称,
          type: d.类型,
          lane: d.人工态,
        })),
      kfOnly: kfSkus
        .filter((s) => !kfMatchedIds.has(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
        })),
    },
    netdiskAxis: { rows: netdiskRows, counts },
    punchEmptyTables,
    warnings,
  };
}
