/**
 * core/sidecar.ts —— Python 侧车的 node 侧封装（AI:PRD-003 · 003-B）
 *
 * 侧车干两件 JS 生态里没有像样替代物的事（正本 = `sidecar/README.md`）：
 *   segment       去 LaTeX + jieba 分词 → `question_fts` 的写侧/查侧喂料（001 疑问一·方案甲）
 *   calc_verify   sympy 实算比对答案 → 「可实算即实算」闸 → `solution_grade` 判档
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条本文件的纪律
 *
 * ① **一次调用一个进程**，批量在**入参数组里**做。jieba 每次启动载词典 ~0.4s，
 *    一题一进程就是把这 0.4s 乘以题数。所以本文件的 API 全是数组进数组出，
 *    单条版（segmentText）只是薄壳，别拿它去 for 循环跑一整批。
 *
 * ② **环境不在 = 一句人话，不是一坨 ENOENT**。侧车是要人先装的（venv + pip），
 *    装没装是最常见的失败，报错必须直接把「跑哪条命令能修好」写在脸上
 *    —— 见 CONFIG_MISSING 的 message。
 *
 * ③ **不吞 mismatch，也不把 cannot_verify 美化成 verified**。本文件只做搬运，
 *    判定口径全在 python 侧；这边一个字都不许"顺手兜底"。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 解释器怎么找（依次）：
 *   1. `SIDECAR_PYTHON` 环境变量（CI / 换机 / uv 建的环境；可以是绝对路径，
 *      也可以是 PATH 上的命令名）；
 *   2. `<仓根>/sidecar/.venv-sidecar/Scripts/python.exe`（win）或 `bin/python3`（posix）。
 *   仓根 = 本文件往上三级；bundler 把 import.meta.url 搞没了就退到 process.cwd()。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 侧车超时：30s。到点杀进程报 TIMEOUT —— 挂死比报错更难查 */
export const SIDECAR_TIMEOUT_MS = 30_000;

export const SIDECAR_ERROR_CODES = [
  /** 装都没装（没 venv / 没 python / 没 main.py）—— message 里带安装命令 */
  "CONFIG_MISSING",
  /** 起得来但没起成（权限、被杀、非 0 退出） */
  "SPAWN_FAILED",
  /** 超过 SIDECAR_TIMEOUT_MS */
  "TIMEOUT",
  /** stdout 不是预期形状的 JSON（版本对不上？被别的输出污染了？） */
  "BAD_RESPONSE",
  /** 侧车自己报的业务错（{"ok":false}），code 在 detail 里 */
  "SIDECAR_ERROR",
] as const;

export type SidecarErrorCode = (typeof SIDECAR_ERROR_CODES)[number];

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  /** 侧车侧的原始错误码 / 子进程 stderr 尾巴，排障用 */
  readonly detail?: string;
  constructor(code: SidecarErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 分词粒度：exact=精确模式（默认）；search=搜索引擎模式（长词再切，召回高） */
export type SegmentMode = "exact" | "search";

export interface SegmentInput {
  id: string;
  text: string;
}

export interface SegmentResult {
  id: string;
  /** 去 LaTeX + jieba 后的**空格串**——unicode61 就靠这些空格切词 */
  segmented: string;
}

/** 实算三态；🔴 cannot_verify 是如实报，不是"大概对吧" */
export type CalcVerdict = "verified" | "mismatch" | "cannot_verify";

export interface CalcVerifyItem {
  id: string;
  stem: string;
  answer: string;
  /** 🔴 不参与 calc_verify 判定（那是最终答案级）；解析的逐行校验走 `lineVerify` */
  analysis?: string;
}

export interface CalcVerifyDetail {
  /** 人话原因（mismatch 时带实算值与答案值，直接可以贴给人看） */
  reason: string;
  /** 归一后真正拿去算的表达式串（null=题面根本没读成算式） */
  expr: string | null;
  /** 实算结果 */
  computed: string | null;
  /** 从 answer 里读出来的期望值 */
  expected: string | null;
}

export interface CalcVerifyResult {
  id: string;
  verdict: CalcVerdict;
  detail: CalcVerifyDetail;
}

// ── 逐行恒等（003-E）──────────────────────────────────────────────────────────

/**
 * 逐行恒等三态。
 * 🔴 `no_checkable_lines` 是**如实报**：含未知量的变形链（解方程/字母化简）本闸判不了
 *    （判它们要比解集，那是另一类闸），绝不为了"有结论"而猜。
 */
export type LineVerifyVerdict =
  "all_identical" | "line_mismatch" | "no_checkable_lines";

export interface LineVerifyItem {
  id: string;
  /** 解析原文（按行切；以等号开头的行 = 上一行的续行） */
  analysis?: string;
  /** 或者直接给转写好的链（首行 = 原式），与 逐行恒等校验.py 的 expr 模式同源 */
  lines?: readonly string[];
}

/** 断裂的那一行（人拿着它就能直接去核卷面） */
export interface LineVerifyBadLine {
  /** 行号（1 起，按解析原文/lines 的顺序） */
  line: number;
  /** 该行原文 */
  text: string;
  /** 本链的原式片段 */
  left: string;
  /** 对不上的那个片段 */
  right: string;
  /** right 的实算值 */
  computed: string;
  /** left（原式）的实算值 */
  expected: string;
}

export interface LineVerifyResult {
  id: string;
  verdict: LineVerifyVerdict;
  /** 做成了多少次比对（0 = no_checkable_lines） */
  checked: number;
  /** 识别出几条链（多小问的解析会有多条） */
  chains: number;
  reason: string;
  badLines: LineVerifyBadLine[];
}

export interface SidecarPing {
  /** 侧车协议版本（main.py 的 SIDECAR_VERSION） */
  sidecar: string;
  /** python / jieba / sympy 版本 */
  versions: Record<string, string>;
}

export interface SidecarOptions {
  /** 覆写解释器（优先级最高，压过 SIDECAR_PYTHON） */
  python?: string;
  /** 覆写超时 */
  timeoutMs?: number;
}

export interface SegmentOptions extends SidecarOptions {
  mode?: SegmentMode;
}

// ---------------------------------------------------------------------------
// 响应校验（zod：侧车是另一个语言的进程，边界上一律不信）
// ---------------------------------------------------------------------------

const 失败响应 = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

const 分词响应 = z.object({
  ok: z.literal(true),
  results: z.array(z.object({ id: z.string(), segmented: z.string() })),
});

const 实算响应 = z.object({
  ok: z.literal(true),
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["verified", "mismatch", "cannot_verify"]),
      detail: z.object({
        reason: z.string(),
        expr: z.string().nullable(),
        computed: z.string().nullable(),
        expected: z.string().nullable(),
      }),
    }),
  ),
});

const 逐行响应 = z.object({
  ok: z.literal(true),
  results: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["all_identical", "line_mismatch", "no_checkable_lines"]),
      checked: z.number(),
      chains: z.number(),
      reason: z.string(),
      badLines: z.array(
        z.object({
          line: z.number(),
          text: z.string(),
          left: z.string(),
          right: z.string(),
          computed: z.string(),
          expected: z.string(),
        }),
      ),
    }),
  ),
});

const 探活响应 = z.object({
  ok: z.literal(true),
  sidecar: z.string(),
  versions: z.record(z.string(), z.string()),
});

// ---------------------------------------------------------------------------
// 解释器与脚本定位
// ---------------------------------------------------------------------------

const IS_WIN = process.platform === "win32";

function 仓根候选(): string[] {
  const out: string[] = [];
  try {
    // <仓根>/src/core/sidecar.ts → 往上三级
    out.push(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    );
  } catch {
    // bundler 环境下 import.meta.url 可能不是 file: URL —— 不算错，退到 cwd
  }
  out.push(process.cwd());
  return out;
}

/** 侧车目录（含 main.py）；找不到就抛 CONFIG_MISSING */
export function sidecarDir(): string {
  for (const root of 仓根候选()) {
    const dir = join(root, "sidecar");
    if (existsSync(join(dir, "main.py"))) return dir;
  }
  throw new SidecarError(
    "CONFIG_MISSING",
    `找不到侧车脚本 sidecar/main.py（找过：${仓根候选()
      .map((r) => join(r, "sidecar"))
      .join(" / ")}）。仓库是不是没拉全？`,
  );
}

/** 本次要用的解释器路径；不做存在性检查（命令名形式要交给 PATH 去解析） */
export function sidecarPythonPath(options: SidecarOptions = {}): string {
  const explicit = options.python ?? process.env.SIDECAR_PYTHON;
  if (explicit) return explicit;
  const dir = sidecarDir();
  return IS_WIN
    ? join(dir, ".venv-sidecar", "Scripts", "python.exe")
    : join(dir, ".venv-sidecar", "bin", "python3");
}

/** 装好了没（给 health / 页面提示用；不抛，只回一句人话） */
export function sidecarStatus(options: SidecarOptions = {}): {
  ok: boolean;
  python: string;
  reason?: string;
} {
  try {
    const python = sidecarPythonPath(options);
    // 命令名（不含分隔符）交给 PATH，这里查不了，按"待运行时确认"处理
    const 像路径 = python.includes("/") || python.includes("\\");
    if (像路径 && !existsSync(python)) {
      return { ok: false, python, reason: 安装提示(python) };
    }
    return { ok: true, python };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, python: "", reason };
  }
}

function 安装提示(python: string): string {
  return (
    `Python 侧车没装：找不到解释器 ${python}。\n` +
    `修法（一次性，见 sidecar/README.md）：\n` +
    `  cd sidecar\n` +
    `  python -m venv .venv-sidecar\n` +
    `  .\\.venv-sidecar\\Scripts\\python.exe -m pip install -r requirements.txt\n` +
    `或设环境变量 SIDECAR_PYTHON 指向一个装了 jieba+sympy 的解释器。`
  );
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function 安全解析JSON(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * 起一个侧车进程跑一个请求。
 * 🔴 stdout 只取 JSON，stderr 只在报错时当线索用（jieba 载词典的日志走 stderr，是正常噪声）。
 */
async function 调侧车(req: unknown, options: SidecarOptions): Promise<unknown> {
  const python = sidecarPythonPath(options);
  const script = join(sidecarDir(), "main.py");
  const 像路径 = python.includes("/") || python.includes("\\");
  if (像路径 && !existsSync(python)) {
    throw new SidecarError("CONFIG_MISSING", 安装提示(python));
  }

  const timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;

  const { stdout, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((ok, bad) => {
    const child = spawn(python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let 已了结 = false;

    const timer = setTimeout(() => {
      if (已了结) return;
      已了结 = true;
      child.kill();
      bad(
        new SidecarError(
          "TIMEOUT",
          `侧车 ${timeoutMs}ms 没返回，已杀进程（题量太大就分批，别加超时）`,
          Buffer.concat(errChunks).toString("utf8").slice(-500),
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => outChunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));

    child.on("error", (e: NodeJS.ErrnoException) => {
      if (已了结) return;
      已了结 = true;
      clearTimeout(timer);
      bad(
        e.code === "ENOENT"
          ? new SidecarError("CONFIG_MISSING", 安装提示(python), e.message)
          : new SidecarError(
              "SPAWN_FAILED",
              `侧车起不来：${e.message}`,
              e.code,
            ),
      );
    });

    child.on("close", (code) => {
      if (已了结) return;
      已了结 = true;
      clearTimeout(timer);
      const out = Buffer.concat(outChunks).toString("utf8");
      const err = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) {
        bad(
          new SidecarError(
            "SPAWN_FAILED",
            `侧车退出码 ${code}（正常一律 0，业务失败也走 JSON）`,
            err.slice(-500),
          ),
        );
        return;
      }
      ok({ stdout: out, stderr: err });
    });

    // 🔴 写完必 end：侧车是 stdin.read() 读到 EOF 才动手的
    child.stdin.end(JSON.stringify(req), "utf8");
  });

  let parsed: unknown;
  try {
    parsed = 安全解析JSON(stdout.trim());
  } catch {
    throw new SidecarError(
      "BAD_RESPONSE",
      `侧车 stdout 不是 JSON：${stdout.slice(0, 200)}`,
      stderr.slice(-500),
    );
  }

  const 失败 = 失败响应.safeParse(parsed);
  if (失败.success) {
    throw new SidecarError(
      "SIDECAR_ERROR",
      `侧车报错：${失败.data.error.message}`,
      失败.data.error.code,
    );
  }
  return parsed;
}

function 校验<T>(schema: z.ZodType<T>, parsed: unknown, op: string): T {
  const r = schema.safeParse(parsed);
  if (!r.success) {
    throw new SidecarError(
      "BAD_RESPONSE",
      `侧车 ${op} 响应形状不对（侧车版本对不上？）`,
      JSON.stringify(r.error.issues).slice(0, 500),
    );
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// 三个 op
// ---------------------------------------------------------------------------

/** 批量分词。空数组直接返回，不白起进程 */
export async function segmentTexts(
  texts: readonly SegmentInput[],
  options: SegmentOptions = {},
): Promise<SegmentResult[]> {
  if (texts.length === 0) return [];
  const parsed = await 调侧车(
    { op: "segment", mode: options.mode ?? "exact", texts },
    options,
  );
  return 校验(分词响应, parsed, "segment").results;
}

/**
 * 单条分词（薄壳）。
 * 🔴 一整批题别拿它 for 循环——那是 N 个 python 进程，见文件头纪律①。
 */
export async function segmentText(
  text: string,
  options: SegmentOptions = {},
): Promise<string> {
  const [first] = await segmentTexts([{ id: "_", text }], options);
  return first?.segmented ?? "";
}

/** 批量实算核对 */
export async function calcVerify(
  items: readonly CalcVerifyItem[],
  options: SidecarOptions = {},
): Promise<CalcVerifyResult[]> {
  if (items.length === 0) return [];
  const parsed = await 调侧车({ op: "calc_verify", items }, options);
  return 校验(实算响应, parsed, "calc_verify").results;
}

/**
 * 批量逐行恒等校验（003-E）。
 *
 * 🔴 与 {@link calcVerify} 是**两件事**，不能互相替代：
 *    calcVerify 验最终答案（答案抄错），lineVerify 验过程每一行（答案对、过程错）。
 *    后者正是 2026-07-30 那次事故里唯一能抓住问题的判据。
 */
export async function lineVerify(
  items: readonly LineVerifyItem[],
  options: SidecarOptions = {},
): Promise<LineVerifyResult[]> {
  if (items.length === 0) return [];
  const parsed = await 调侧车({ op: "line_verify", items }, options);
  return 校验(逐行响应, parsed, "line_verify").results;
}

/** 探活：装没装、装的是哪几个版本 */
export async function pingSidecar(
  options: SidecarOptions = {},
): Promise<SidecarPing> {
  const parsed = await 调侧车({ op: "ping" }, options);
  const r = 校验(探活响应, parsed, "ping");
  return { sidecar: r.sidecar, versions: r.versions };
}
