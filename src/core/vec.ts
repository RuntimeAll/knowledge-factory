/**
 * core/vec.ts —— 向量的序列化与近邻（AI:PRD-004 · 004-A · 语义轴读侧）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 存储口径（写死在这里，别处一律调本文件的函数，不许自己 Buffer.from）
 *
 *   `question_vec.embedding` = **Float32 小端连续字节**，长度 = 维度 × 4。
 *     - float32 不是 float64：精度对余弦排序绰绰有余，体积省一半（512 维 = 2KB/题）。
 *     - **小端**：x86 与 arm 都是小端，`Float32Array` 的内存布局直接就是它 ——
 *       所以 {@link blobToFloat32} 在对齐时能零拷贝地开视图。
 *       真跑到大端机器上会读出乱数，因此下面显式用 DataView 兜底，不赌平台。
 *     - **落库前已 L2 归一**（core/embed.ts 出厂就是单位向量）⇒
 *       **余弦相似度 == 点积**，检索侧不必再算模长。这条是本文件所有"只点积"的前提。
 *
 * 🔴 近邻策略：**暴力全扫**。60 题是 60 次点积（~0.03ms），十万题也就 ~50ms。
 *   本产品是本地单人资料库，题量到不了需要 HNSW/IVF 的量级，
 *   而向量索引带来的"重建、漂移、和主库对不上"三件事，成本远超它省的那点时间。
 *   真到了扛不住那天，换的是本文件里 {@link cosineTopK} 一个函数。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 混版闸（对账 C3 的读侧那一半）
 *   两个模型的向量混在一张表里，近邻在数学上就是无意义的 —— 但表面完全正常：
 *   有结果、有分数、排序也像模像样。所以本文件在**建索引时**就拦：
 *   库里 `embed_model_ver` 多于一种，或与当前 `EMBED_MODEL_VER` 不符，
 *   直接抛 {@link VecError}（MIXED_VERSION / VERSION_MISMATCH）。
 *   调用方接住它就该**降级为纯 FTS**（C3 的处置口径原话），而不是照常出结果。
 */
import { getCoreDb, type CoreDbHandle } from "./db";
import { EMBED_DIM, embedModelVer } from "./embed";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export const VEC_ERROR_CODES = [
  /** BLOB 字节数不是 4 的倍数 / 与期望维度对不上 */
  "BAD_BLOB",
  /** question_vec 里混着多个 embed_model_ver（🔴 近邻无意义，必须降级纯 FTS） */
  "MIXED_VERSION",
  /** 库内版本 ≠ 当前 EMBED_MODEL_VER（重算跑一半，或配置改了没重算） */
  "VERSION_MISMATCH",
] as const;

export type VecErrorCode = (typeof VEC_ERROR_CODES)[number];

export class VecError extends Error {
  readonly code: VecErrorCode;
  readonly detail?: string;
  constructor(code: VecErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "VecError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/**
 * Float32Array → 可直接进 BLOB 列的字节（**小端**）。
 * 🔴 显式逐个 setFloat32(le) 而不是 `Buffer.from(v.buffer)`：后者跟着平台字节序走，
 *    在大端机器上落进库的就是另一套字节，而库文件是要跨机器搬的。
 */
export function float32ToBlob(v: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
}

/**
 * BLOB 字节 → Float32Array（**按小端读**）。
 * @param expectDim 传了就断言维度（默认 {@link EMBED_DIM}；传 0 = 不校验）
 */
export function blobToFloat32(
  blob: Uint8Array | ArrayBuffer,
  expectDim: number = EMBED_DIM,
): Float32Array {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (u8.byteLength % 4 !== 0) {
    throw new VecError(
      "BAD_BLOB",
      `向量 BLOB 长度 ${u8.byteLength} 不是 4 的倍数 —— 存的不是 float32 数组`,
    );
  }
  const n = u8.byteLength / 4;
  if (expectDim > 0 && n !== expectDim) {
    throw new VecError(
      "BAD_BLOB",
      `向量 BLOB 是 ${n} 维，期望 ${expectDim} 维 —— 多半是换过模型却没全量重算`,
    );
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

// ---------------------------------------------------------------------------
// 纯数学
// ---------------------------------------------------------------------------

/**
 * 点积。🔴 两边都是单位向量时它**就是**余弦相似度 ——
 * 本产品落库的向量出厂即归一，所以主路只用它。
 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new VecError(
      "BAD_BLOB",
      `点积两边维度不同：${a.length} vs ${b.length}`,
    );
  }
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** L2 归一（返回新数组）。零向量原样返回 —— 除以 0 会得到一串 NaN，比 0 更难查 */
export function l2Normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return new Float32Array(v);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/**
 * 通用余弦（不假设已归一）。给单测与"外来向量"用；
 * 主路走 {@link dot}，别在热路径上重复算模长。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return ab / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// 进程内索引（暴力扫描的那张表）
// ---------------------------------------------------------------------------

export interface VecIndex {
  /** question_id → 单位向量 */
  vectors: Map<string, Float32Array>;
  /** 库内唯一的 embed_model_ver */
  modelVer: string;
  /** 建索引时的库指纹（行数 + 最新 updated_at），用来判要不要重建 */
  fingerprint: string;
  dim: number;
}

let 索引: VecIndex | null = null;

/** 丢掉索引（回填脚本写完必须调，否则同进程后续检索还在用旧向量） */
export function invalidateVecIndex(): void {
  索引 = null;
}

async function 指纹(h: CoreDbHandle): Promise<string> {
  const r = await h.client.execute(
    "SELECT COUNT(*) AS c, IFNULL(MAX(updated_at),'') AS m FROM question_vec",
  );
  const row = r.rows[0] as unknown as { c: number; m: string } | undefined;
  return `${row?.c ?? 0}@${row?.m ?? ""}`;
}

/**
 * 建（或复用）进程内向量索引。
 *
 * 🔴 缓存不是"载一次就永远不管"：每次进来先查一次
 *    `COUNT(*) + MAX(updated_at)`（一条极廉价的 SQL），指纹变了就重建。
 *    宁可每次查询多花 0.1ms，也不要"回填完了检索还在用旧向量"这种
 *    只在特定顺序下出现、复现不了的错。
 *
 * 🔴 混版直接抛（见文件头混版闸）——调用方接住 VecError 应降级为纯 FTS。
 */
export async function loadVecIndex(handle?: CoreDbHandle): Promise<VecIndex> {
  const h = handle ?? (await getCoreDb());
  const fp = await 指纹(h);
  if (索引?.fingerprint === fp) return 索引;

  const vers = (
    await h.client.execute(
      "SELECT DISTINCT embed_model_ver AS v FROM question_vec ORDER BY v",
    )
  ).rows.map((r) => String((r as unknown as { v: string }).v));

  const configured = embedModelVer();
  if (vers.length > 1) {
    throw new VecError(
      "MIXED_VERSION",
      `question_vec 混着 ${vers.length} 个 embed_model_ver：${vers.join("、")}。` +
        "🔴 两个向量空间混排，近邻在数学上无意义（而表面上完全正常）。" +
        "处置：语义轴降级为纯 FTS，直到全量重算完（对账 C3 同一口径）。",
    );
  }
  if (vers.length === 1 && vers[0] !== configured) {
    throw new VecError(
      "VERSION_MISMATCH",
      `库内向量版本 ${vers[0]} ≠ 当前 EMBED_MODEL_VER=${configured}。` +
        "要么配置改了没重算，要么重算跑了一半。处置同上：先降级纯 FTS。",
    );
  }

  const rows = (
    await h.client.execute("SELECT question_id, embedding FROM question_vec")
  ).rows as unknown as { question_id: string; embedding: Uint8Array }[];

  const vectors = new Map<string, Float32Array>();
  for (const r of rows) {
    vectors.set(String(r.question_id), blobToFloat32(r.embedding));
  }
  索引 = {
    vectors,
    modelVer: vers[0] ?? configured,
    fingerprint: fp,
    dim: EMBED_DIM,
  };
  return 索引;
}

// ---------------------------------------------------------------------------
// TopK
// ---------------------------------------------------------------------------

export interface VecHit {
  questionId: string;
  /** 余弦相似度（两边都是单位向量 ⇒ 就是点积），[-1, 1] */
  score: number;
}

export interface CosineTopKOptions {
  /** 取前几条，默认 20 */
  limit?: number;
  /**
   * 候选白名单：只在这些 question_id 里找。
   * 🔴 三路检索的用法就是它 —— SQL 轴/FTS 轴先把候选缩到几百条，
   *    语义轴只在候选里排序，而不是每次都扫全库。
   */
  ids?: readonly string[];
  /** 分数下限（含）；不设 = 不过滤 */
  minScore?: number;
  handle?: CoreDbHandle;
}

/**
 * 暴力近邻：`queryVec` 与库里每条向量点积，取前 K。
 *
 * ```ts
 * const [q] = await embedTexts(["怎么解一元一次方程"]);
 * const hits = await cosineTopK(q, { limit: 5 });
 * // [{ questionId: 'q_01K…', score: 0.72 }, …]
 * ```
 *
 * 🔴 排序**稳定且确定**：先按分数降序，分数相同按 question_id 升序。
 *    ULID 主键单调，所以"同分时谁在前"永远一样 —— 金标测试要的就是这个。
 * 🔴 queryVec 会被归一（外面传进来的不一定是单位向量），库内向量假定已归一。
 */
export async function cosineTopK(
  queryVec: Float32Array,
  options: CosineTopKOptions = {},
): Promise<VecHit[]> {
  const limit = options.limit ?? 20;
  if (limit <= 0) return [];
  const idx = await loadVecIndex(options.handle);
  if (queryVec.length !== idx.dim) {
    throw new VecError(
      "BAD_BLOB",
      `查询向量是 ${queryVec.length} 维，库里是 ${idx.dim} 维`,
    );
  }
  const q = l2Normalize(queryVec);

  const hits: VecHit[] = [];
  const push = (questionId: string, v: Float32Array): void => {
    const score = dot(q, v);
    if (options.minScore !== undefined && score < options.minScore) return;
    hits.push({ questionId, score });
  };

  if (options.ids) {
    // 白名单模式：只算候选，缺向量的题**跳过**（不是报错）——
    // "有题无向量"是 C1(b) 的 warn 态（缺量待补），不该让整次检索炸掉。
    for (const id of options.ids) {
      const v = idx.vectors.get(id);
      if (v) push(id, v);
    }
  } else {
    for (const [id, v] of idx.vectors) push(id, v);
  }

  hits.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.questionId < b.questionId
        ? -1
        : a.questionId > b.questionId
          ? 1
          : 0,
  );
  return hits.slice(0, limit);
}
