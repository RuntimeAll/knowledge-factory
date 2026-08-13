/**
 * core/embed.ts —— 本地句向量（AI:PRD-004 · 004-A · 语义轴底座）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 模型：**bge-small-zh-v1.5**（512 维，CLS pooling + L2 归一），ONNX，**全本地跑**。
 *   运行时 = `onnxruntime-node`（CPU EP，二进制随包，不联网）
 *          + `@huggingface/tokenizers`（纯 JS BERT WordPiece，零原生依赖）
 *   模型文件 = `models/bge-small-zh-v1.5/`（**不进 git**，见 .gitignore；
 *              重建命令 = `pwsh scripts/fetch-embed-model.ps1`，源是 ModelScope）
 *
 * 🔴 为什么不用云 embedding API：本产品是本地资料库，题面是自家资产，
 *    而且检索是**每次查询都要跑**的热路径 —— 出网 = 又贵又慢又多一个会挂的东西。
 *    实测本机：会话加载 ~0.5s（一次），batch=4 推理 ~30ms。
 * 🔴 为什么不用 ModelScope 之外的源：本机 HF 大文件走代理会被掐（记忆在案），
 *    ModelScope 直连稳定。fetch 脚本按 Sha256 校验，下歪了当场红。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 四条纪律
 *
 * ① **版本与库里的向量必须同一个**。写进 `question_vec.embed_model_ver` 的值
 *    只有一个来源：环境变量 `EMBED_MODEL_VER`。本文件在**每次 embed 之前**核对
 *    「配置的版本 == 真正加载的模型」，对不上直接抛 —— 不许出现"配置写着 A、
 *    实际跑的是 B、库里标着 A"这种查都查不出来的错位（对账 C3 的另一半在这儿）。
 *
 * ② **维度自检**。第一次推理完必须是 512 维，不是就抛 DIM_MISMATCH。
 *    模型文件被换成别的 bge 变体（base=768）时，唯一的症状否则就是
 *    「近邻结果变得莫名其妙」——而 BLOB 里长度不对根本没人看得见。
 *
 * ③ **喂料 = 自然语句，不是分词串**（喂什么的理由见 {@link embedFeed}）。
 *
 * ④ **模型没装就报人话**。和侧车同一条：报错里直接写"跑哪条命令能修好"。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Tokenizer } from "@huggingface/tokenizers";

import { segFeed } from "./segment";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 模型标识 = 目录名 = `EMBED_MODEL_VER` 该有的值 */
export const EMBED_MODEL_ID = "bge-small-zh-v1.5";

/** 模型目录（相对仓根）；🔴 gitignore，靠 fetch 脚本重建 */
export const MODEL_REL_DIR = `models/${EMBED_MODEL_ID}`;

/** 句向量维度（bge-small = 512）。写死是为了当断言用，不是当配置用 */
export const EMBED_DIM = 512;

/** BERT 位置编码上限；超了必须截断，不然 ONNX 直接报错 */
export const EMBED_MAX_TOKENS = 512;

/** 一次喂进 ONNX 的条数。小批多次比一次巨批省内存，且长短句不会互相撑爆 padding */
export const EMBED_BATCH = 16;

/** 模型目录里必须齐的三件套 */
export const MODEL_FILES = [
  "model.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
] as const;

export const EMBED_ERROR_CODES = [
  /** `EMBED_MODEL_VER` 没配 —— 配了才知道该往 question_vec 里写什么版本 */
  "CONFIG_MISSING",
  /** 模型文件缺 —— message 里带重建命令 */
  "MODEL_MISSING",
  /** 配置的版本 ≠ 实际加载的模型（🔴 纪律①） */
  "VERSION_MISMATCH",
  /** 推理出来的维度不是 EMBED_DIM（🔴 纪律②） */
  "DIM_MISMATCH",
  /** onnxruntime / tokenizer 自己炸了 */
  "RUNTIME_FAILED",
] as const;

export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[number];

export class EmbedError extends Error {
  readonly code: EmbedErrorCode;
  readonly detail?: string;
  constructor(code: EmbedErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "EmbedError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 定位与体检
// ---------------------------------------------------------------------------

function 仓根候选(): string[] {
  const out: string[] = [];
  try {
    out.push(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    );
  } catch {
    // bundler 下 import.meta.url 可能不是 file: URL —— 退到 cwd
  }
  out.push(process.cwd());
  return out;
}

function 重建命令(): string {
  return (
    "模型没装（或装歪了）。重建（一次性，联网 ~95MB，走 ModelScope 直连）：\n" +
    "  powershell -File scripts\\fetch-embed-model.ps1\n" +
    "🔴 模型文件刻意不进 git（95MB 二进制，仓库会被撑死），所以换机/新 clone 必跑一次。"
  );
}

/** 模型目录绝对路径；不做完整性检查（那是 {@link embedStatus} 的事） */
export function modelDir(): string {
  for (const root of 仓根候选()) {
    const d = join(root, MODEL_REL_DIR);
    if (existsSync(d)) return d;
  }
  return join(仓根候选()[0]!, MODEL_REL_DIR);
}

export interface EmbedStatus {
  ok: boolean;
  dir: string;
  /** 每个必需文件在不在、多大 */
  files: { name: string; ok: boolean; bytes: number }[];
  /** 配置的 EMBED_MODEL_VER（没配 = null） */
  configuredVer: string | null;
  /** ok=false 时的人话原因（含修法） */
  reason?: string;
}

/** 装没装（给体检页 / 报告 / 脚本用；**不抛**，只回一句人话） */
export function embedStatus(): EmbedStatus {
  const dir = modelDir();
  const files = MODEL_FILES.map((name) => {
    const p = join(dir, name);
    const ok = existsSync(p);
    return { name, ok, bytes: ok ? statSync(p).size : 0 };
  });
  const configuredVer = process.env.EMBED_MODEL_VER ?? null;
  const 缺 = files.filter((f) => !f.ok).map((f) => f.name);
  if (缺.length > 0) {
    return {
      ok: false,
      dir,
      files,
      configuredVer,
      reason: `模型目录 ${dir} 缺文件：${缺.join("、")}。\n${重建命令()}`,
    };
  }
  if (configuredVer === null) {
    return {
      ok: false,
      dir,
      files,
      configuredVer,
      reason:
        "EMBED_MODEL_VER 没配 —— 不知道该往 question_vec.embed_model_ver 写什么。\n" +
        `修法：.env 里加 EMBED_MODEL_VER="${EMBED_MODEL_ID}"`,
    };
  }
  if (configuredVer !== EMBED_MODEL_ID) {
    return {
      ok: false,
      dir,
      files,
      configuredVer,
      reason:
        `EMBED_MODEL_VER=${configuredVer}，但 ${MODEL_REL_DIR} 装的是 ${EMBED_MODEL_ID}。\n` +
        "🔴 这个错位最阴：库里向量会被标成一个它其实不是的版本，对账 C3 反而是绿的。",
    };
  }
  return { ok: true, dir, files, configuredVer };
}

/**
 * 当前该写进 `question_vec.embed_model_ver` 的版本。
 * 🔴 唯一来源是环境变量（不是常量）——常量只用来核对它没写歪（见纪律①）。
 */
export function embedModelVer(): string {
  const v = process.env.EMBED_MODEL_VER;
  if (!v) {
    throw new EmbedError(
      "CONFIG_MISSING",
      "EMBED_MODEL_VER 没配，拒绝生成向量 —— 落库的向量必须带得动版本号，" +
        "否则换模型时分不清哪些该重算（对账 C3 就是干这个的）。\n" +
        `修法：.env 里加 EMBED_MODEL_VER="${EMBED_MODEL_ID}"`,
    );
  }
  if (v !== EMBED_MODEL_ID) {
    throw new EmbedError(
      "VERSION_MISMATCH",
      `EMBED_MODEL_VER=${v}，而本代码加载的模型是 ${EMBED_MODEL_ID}（${MODEL_REL_DIR}）。` +
        "🔴 两者必须一致：不一致就会把 B 模型的向量标成 A 版本，C3 查不出来。\n" +
        `修法：要么把 .env 改回 "${EMBED_MODEL_ID}"，要么换模型时同步改 core/embed.ts 的 EMBED_MODEL_ID + fetch 脚本 + 全量重算。`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// 单例（会话 + 分词器；载一次管到进程结束）
// ---------------------------------------------------------------------------

/** onnxruntime-node 的最小面（只用到这几样，不把整个包的类型摊进来） */
interface OrtTensor {
  readonly dims: readonly number[];
  readonly data: Float32Array;
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  InferenceSession: {
    create(path: string, opts?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: BigInt64Array,
    dims: readonly number[],
  ) => unknown;
}

interface 引擎 {
  session: OrtSession;
  tokenizer: Tokenizer;
  Tensor: OrtModule["Tensor"];
  padId: number;
  dir: string;
}

let 单例: Promise<引擎> | null = null;

async function 建引擎(): Promise<引擎> {
  const st = embedStatus();
  if (!st.ok) {
    const code: EmbedErrorCode = st.files.some((f) => !f.ok)
      ? "MODEL_MISSING"
      : st.configuredVer === null
        ? "CONFIG_MISSING"
        : "VERSION_MISMATCH";
    throw new EmbedError(code, st.reason!);
  }
  const dir = st.dir;

  let tokenizer: Tokenizer;
  try {
    tokenizer = new Tokenizer(
      JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as object,
      JSON.parse(
        readFileSync(join(dir, "tokenizer_config.json"), "utf8"),
      ) as object,
    );
  } catch (e) {
    throw new EmbedError(
      "RUNTIME_FAILED",
      `分词器建不起来（tokenizer.json 坏了？重下一次）：${String(e)}`,
    );
  }

  // 🔴 惰性 import：onnxruntime-node 是原生模块，顶层 import 会被 Next 的
  //    打包器扫进去（.node 文件它处理不了）。这里晚到真要推理时才加载。
  let ort: OrtModule;
  try {
    ort = (await import("onnxruntime-node")) as unknown as OrtModule;
  } catch (e) {
    throw new EmbedError(
      "RUNTIME_FAILED",
      `onnxruntime-node 加载失败（装依赖时被跳过了？跑 pnpm install）：${String(e)}`,
    );
  }

  let session: OrtSession;
  try {
    // logSeverityLevel:3 = 只留 error：ORT 默认会往 stderr 刷一堆 warning，
    // 而本产品的脚本输出是要人逐行读的账本，噪声必须掐掉。
    session = await ort.InferenceSession.create(join(dir, "model.onnx"), {
      logSeverityLevel: 3,
    });
  } catch (e) {
    throw new EmbedError(
      "RUNTIME_FAILED",
      `ONNX 会话建不起来：${String(e)}\n${重建命令()}`,
    );
  }

  return {
    session,
    tokenizer,
    Tensor: ort.Tensor,
    padId: tokenizer.token_to_id("[PAD]") ?? 0,
    dir,
  };
}

/** 预热（把 ~0.5s 的模型加载挪到第一次查询之前）；也用来在脚本开头验环境 */
export async function loadEmbedder(): Promise<{ dir: string; ver: string }> {
  const ver = embedModelVer();
  const e = await (单例 ??= 建引擎());
  return { dir: e.dir, ver };
}

/** 丢掉单例（单测换环境变量、脚本跑完释放内存时用） */
export function resetEmbedder(): void {
  单例 = null;
}

// ---------------------------------------------------------------------------
// 喂料
// ---------------------------------------------------------------------------

/**
 * 向量喂料 = **去 HTML + 去 LaTeX 后的自然语句**（🔴 不是分词串）。
 *
 * 三个选项摆一起看，为什么选中间这个：
 *
 *   a. 原始 `stem`      —— 里面躺着 `<span style="display:inline-block;…">` 和
 *                          `\frac`/`\times`。512 个 token 的预算被样式串吃掉一半，
 *                          而且 BERT 会把 `style`/`display` 当成有语义的英文词。
 *   b. `stem_plain`     —— 那是**空格分词串**（"解 一元 一次 方程"）。
 *                          语义模型吃的是自然语句：中文被空格劈开后 WordPiece 边界
 *                          与位置关系全变了，向量明显退化。分词串是给 FTS 的，不是给它的。
 *   c. ✅ `segFeed(stem)` —— 与分词**同一套喂料归一**（剥 HTML、去 LaTeX），
 *                          但**不分词**，保持句子原样。
 *
 * 选 c 还有一个对账上的好处：FTS 轴与向量轴对「这道题的正文到底是什么」
 * 有**同一个定义**。两条轴各用一套口径，出了问题连比都没法比。
 */
export function embedFeed(text: string | null | undefined): string {
  return segFeed(text);
}

// ---------------------------------------------------------------------------
// 推理
// ---------------------------------------------------------------------------

/** 截断到 EMBED_MAX_TOKENS：保住首 [CLS] 与尾 [SEP]，砍中间 */
function 截断(ids: number[]): number[] {
  if (ids.length <= EMBED_MAX_TOKENS) return ids;
  const head = ids.slice(0, EMBED_MAX_TOKENS - 1);
  head.push(ids[ids.length - 1]!); // [SEP]
  return head;
}

async function 跑一批(
  e: 引擎,
  batch: readonly string[],
): Promise<Float32Array[]> {
  const encoded = batch.map((t) => {
    const enc = e.tokenizer.encode(t.length > 0 ? t : "[UNK]", {
      return_token_type_ids: true,
    });
    return 截断([...enc.ids]);
  });
  const maxLen = Math.max(...encoded.map((x) => x.length), 1);
  const B = encoded.length;
  const ids = new BigInt64Array(B * maxLen);
  const mask = new BigInt64Array(B * maxLen);
  const types = new BigInt64Array(B * maxLen);
  const padId = BigInt(e.padId);
  encoded.forEach((row, i) => {
    for (let j = 0; j < maxLen; j++) {
      const at = i * maxLen + j;
      if (j < row.length) {
        ids[at] = BigInt(row[j]!);
        mask[at] = 1n;
      } else {
        ids[at] = padId;
        mask[at] = 0n;
      }
      types[at] = 0n;
    }
  });

  const dims = [B, maxLen] as const;
  let out: Record<string, OrtTensor>;
  try {
    out = await e.session.run({
      input_ids: new e.Tensor("int64", ids, dims),
      attention_mask: new e.Tensor("int64", mask, dims),
      token_type_ids: new e.Tensor("int64", types, dims),
    });
  } catch (err) {
    throw new EmbedError("RUNTIME_FAILED", `ONNX 推理失败：${String(err)}`);
  }

  const lhs = out.last_hidden_state;
  if (!lhs) {
    throw new EmbedError(
      "RUNTIME_FAILED",
      `模型输出里没有 last_hidden_state（有的是：${Object.keys(out).join("、")}）——` +
        "模型文件换过？本代码按 bge 的 encoder 输出取 CLS。",
    );
  }
  const H = lhs.dims[2] ?? 0;
  if (H !== EMBED_DIM) {
    throw new EmbedError(
      "DIM_MISMATCH",
      `推理出来是 ${H} 维，期望 ${EMBED_DIM} 维（${EMBED_MODEL_ID}）。` +
        "🔴 多半是模型文件被换成了别的 bge 变体（base=768）。" +
        "维度错了库里 BLOB 长度也跟着错，而近邻只会变得「莫名其妙」，不会报错。",
    );
  }

  // CLS pooling（bge 系列的官方口径就是取第 0 个 token）+ L2 归一。
  // 归一在这里做掉：落库的向量一律是单位向量 ⇒ 余弦 == 点积，检索侧不必再算模长。
  const data = lhs.data;
  const vecs: Float32Array[] = [];
  for (let i = 0; i < B; i++) {
    const v = new Float32Array(EMBED_DIM);
    const base = i * maxLen * H;
    for (let d = 0; d < EMBED_DIM; d++) v[d] = data[base + d]!;
    let n = 0;
    for (let d = 0; d < EMBED_DIM; d++) n += v[d]! * v[d]!;
    n = Math.sqrt(n);
    if (n > 0) for (let d = 0; d < EMBED_DIM; d++) v[d] = v[d]! / n;
    vecs.push(v);
  }
  return vecs;
}

export interface EmbedOptions {
  /** 一批多少条，默认 {@link EMBED_BATCH} */
  batchSize?: number;
  /**
   * 喂料前是否过 {@link embedFeed}（剥 HTML + 去 LaTeX），默认 true。
   * 传 false = 你自己已经归一好了（回填脚本要自己留 diff 时用）。
   */
  normalize?: boolean;
}

/**
 * 文本 → 单位向量（Float32Array，长度 {@link EMBED_DIM}）。
 *
 * ```ts
 * const [v] = await embedTexts(["解一元一次方程 2x+1=7"]);
 * v.length; // 512，且 Σv² == 1
 * ```
 *
 * 🔴 顺序与入参一一对应；空数组直接返回，不白载模型。
 * 🔴 每次调用先核对 `EMBED_MODEL_VER`（纪律①）—— 版本对不上宁可不干活。
 */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  embedModelVer(); // 🔴 先过版本闸，再载模型
  const e = await (单例 ??= 建引擎());
  const feed =
    options.normalize === false ? [...texts] : texts.map((t) => embedFeed(t));
  const size = options.batchSize ?? EMBED_BATCH;
  const out: Float32Array[] = [];
  for (let i = 0; i < feed.length; i += size) {
    out.push(...(await 跑一批(e, feed.slice(i, i + size))));
  }
  return out;
}

/** 单条（薄壳）。整批别拿它 for 循环——那是把 padding 与调度开销乘以条数 */
export async function embedText(
  text: string,
  options: EmbedOptions = {},
): Promise<Float32Array> {
  const [v] = await embedTexts([text], options);
  return v!;
}
