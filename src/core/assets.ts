/**
 * core/assets.ts —— 资产读侧（AI:PRD-003 · 003-D）
 *
 * 图审工单要看图，页面就得有个地方把 `asset` 表里那一行变成「一份能返回给浏览器的
 * 字节 + 一个 Content-Type」。本文件只做这件事，**只读**：
 *   getAssetByHash()   内容 hash → 登记行 + 绝对路径 + 存不存在
 *   assetContentType() 文件名/kind → Content-Type（按扩展名，认不出就八位字节流）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 「库里查不到登记行的文件，视同不存在」
 *
 *   资产的唯一入口是 hash（内容寻址），而不是路径。原因有两条：
 *     ① 路径入参 = 目录穿越的邀请函。这里 URL 里给的是 hash，落地路径一律**从库里读**，
 *        外面拼不出别的路径来；
 *     ② assets/ 里出现了一个没有登记行的文件，本身就是对账 C1(c) 要抓的事故
 *        （「有文件查不到登记行」）。给它开一条能被读出去的路，等于把红旗按灭。
 *
 * 🔴 兜底再加一道：即使登记行的 path 被写成了 `../../别处`，解析后的绝对路径
 *    只要跑出资产仓根，一律按「不存在」处置（exists=false ⇒ 路由 404）。
 *    这不是防外部输入（外部输入进不来），是防**脏数据**变成任意文件读。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";

import { asset } from "~/server/db/schema";
import { dbUrlToPath } from "./backup";
import { getCoreDb, type CoreDbHandle } from "./db";
import { assetsDirFor, normalizeAssetPath } from "./integrity";

/** 扩展名 → Content-Type（只列本地资产仓真会出现的那几类） */
export const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** 认不出扩展名时的兜底：让浏览器下载而不是猜着渲染 */
export const ASSET_FALLBACK_CONTENT_TYPE = "application/octet-stream";

/**
 * 文件名（或 asset.kind）→ Content-Type。
 * 🔴 纯函数、可单测；路由不许自己现写一张 map。
 */
export function assetContentType(nameOrKind: string): string {
  const s = (nameOrKind ?? "").trim().toLowerCase();
  if (!s) return ASSET_FALLBACK_CONTENT_TYPE;
  const ext = (extname(s) || `.${s}`).replace(/^\./, "");
  return ASSET_CONTENT_TYPES[ext] ?? ASSET_FALLBACK_CONTENT_TYPE;
}

export interface AssetRecord {
  id: string;
  /** 仓内相对文件名（= `<hash><ext>`，见 gates/ingest-figure.gate.ts） */
  path: string;
  hash: string;
  kind: string | null;
  bytes: number | null;
  /** 落地绝对路径（资产仓根 + path） */
  absPath: string;
  /** 文件真在盘上吗（登记行在、文件不在 = 对账 C1(c) 的红旗，这里如实上报） */
  exists: boolean;
  /** 盘上实际字节数（不存在为 null；与 bytes 不等也如实给，判不判由调用方） */
  actualBytes: number | null;
  contentType: string;
}

export interface AssetReadOptions {
  handle?: CoreDbHandle;
  /** 资产仓根，默认 = 库文件同级的 assets/（测试传副本目录） */
  assetsDir?: string;
}

/**
 * 按内容 hash 取一份资产。查无登记行 = null（**不是**报错：路由照它 404）。
 *
 * ```ts
 * const a = await getAssetByHash("3f2a…");
 * if (!a?.exists) return 404;
 * new Response(readFileSync(a.absPath), { headers: { "Content-Type": a.contentType } });
 * ```
 */
export async function getAssetByHash(
  hash: string,
  opts: AssetReadOptions = {},
): Promise<AssetRecord | null> {
  const h = (hash ?? "").trim();
  if (!h) return null;

  const handle = opts.handle ?? (await getCoreDb());
  const rows = await handle.db
    .select()
    .from(asset)
    .where(eq(asset.hash, h))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const root = resolve(opts.assetsDir ?? assetsDirFor(dbUrlToPath(handle.url)));
  const abs = resolve(join(root, normalizeAssetPath(row.path)));

  // 🔴 跑出资产仓根 = 脏登记行，按「不存在」处置（绝不给它一条读文件的路）
  const inside = abs === root || abs.startsWith(root + sep);
  const exists = inside && existsSync(abs) && statSync(abs).isFile();

  return {
    id: row.id,
    path: row.path,
    hash: row.hash,
    kind: row.kind,
    bytes: row.bytes,
    absPath: abs,
    exists,
    actualBytes: exists ? statSync(abs).size : null,
    contentType: assetContentType(row.path || (row.kind ?? "")),
  };
}
