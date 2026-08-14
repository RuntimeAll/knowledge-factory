/**
 * 终审台 · 写侧 —— 🔴🔴 **唯一写路径：spawn 圣域自己的 `审核库.py` CLI**
 * （AI:PRD-009 · 设计稿 §一 D-A + §四 红线）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **同名异库警示**：本模块间接动的是 **`订阅特训/_产线/审核.db`**（圣域批改账本），
 *      **不是** `举一反三产物/资料库.db`（punch 库，只读），
 *      **不是** 本产品的 `data/资料库.db`。
 *
 * 🔴🔴 **本产品对审核.db 没有任何写句柄**。这里不 open 库、不发 SQL、不碰文件。
 *      终审动作 = 起一个 python 进程跑圣域自己的原语（confirm --from / rework /
 *      unrework），我们只递参数、收 stdout/stderr、报退出码。
 *      污点判据（设计稿 §四）：全仓 grep 不到任何对审核.db 的非 ro 连接 —— 包括这儿。
 *
 * 🔴 **圣域一个字节不改**：不改 审核库.py、不改 审核台.py、不动 schema。
 *      CLI 缺的口子（机读输出/退出码分不清错因/pending 没有 CLI 出口）
 *      记进 `prd/PRD-009/给027的CLI需求清单.md` 走契约通报，读侧一律 mode=ro 绕。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 四个必须照做的实现细节（每一条都有出处） ────────────────────────────────
 *  ① **PYTHONIOENCODING=utf-8**（记忆 gbk-console-emoji-kills-script）：
 *     审核库.py 的成功输出全是 emoji 人话（🟢/🔶/↩）。子进程的 stdout 不是 tty，
 *     Windows 上默认走 GBK，emoji 直接 UnicodeEncodeError 把脚本打死 ——
 *     那会表现成「命令莫名其妙失败」，最难查的一类。
 *     （审核库.py 自己 `sys.stdout/stderr.reconfigure('utf-8')` 了，这里再上一道保险，
 *      顺带管住它 import 的那些模块。）
 *  ② **先拼 Buffer 再解码**：一个中文字 3 字节，chunk 边界会把它劈开；
 *     逐块 `toString('utf8')` 就会在报错原文里插进 �。
 *  ③ **子命令白名单**：审核库.py 的 `_main()` 是 `else: 打印全表 status` 兜底 ——
 *     子命令敲错**不报错、还 exit 0**（`exprot` 会打印全表并「成功」返回）。
 *     所以命令名在这边先过白名单，绝不让一个拼错的字符串静默退化成 status。
 *  ④ **临时 JSON 落系统 temp、用完就删**：`confirm` 只认 `--from <文件>`。
 *     🔴 那个文件绝不写进 `_产线/`（圣域目录里不许多出我们的文件）。
 *
 * 🔴 server only：node:child_process / node:fs / node:os，client 组件不许 import。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { productionLineDir, reviewCliFile } from "../paths";
import { type Verdict } from "../shared";

/**
 * 🔴 白名单：管理台只准跑这三条原语。
 *   confirm   终审确认（本产品一律 `--from <临时JSON>` 且**不带 --auto**）
 *   rework    打回重批
 *   unrework  撤回打回
 * 🔴 `ingest` / `export` **不在名单里**：那两条是产线执行权
 *   （ingest 要跑锚定闸读转录 JSON；export 会拉起 批改.py + photo_mark.py 出对外件，
 *    而出件前 agent 还得先写英雄卡总结 —— 设计稿 §一「确认 ≠ 出件」）。
 */
export const REVIEW_CLI_COMMANDS = ["confirm", "rework", "unrework"] as const;
export type ReviewCliCommand = (typeof REVIEW_CLI_COMMANDS)[number];

/** 超时：60s。终审三条原语都只动 SQLite，正常是毫秒级；到点杀掉比挂死好查 */
export const REVIEW_CLI_TIMEOUT_MS = 60_000;

export interface CliRun {
  /**
   * 真正跑的整条命令（argv[0] = 解释器）。
   * 🔴 原样上墙，人可以直接复制去命令行重跑 —— 解释器也要带上：
   *    换机时 GRADING_PYTHON 指的可能不是 PATH 上那个 python，
   *    回执里少这一截，人照着复制就跑的是另一个环境。
   */
  argv: string[];
  cwd: string;
  /** 被信号杀掉时为 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 进程压根没起来（python 不在 PATH / 脚本不在）——与「起来了但报错」分开 */
  spawnError?: string;
}

/**
 * python 解释器。
 * 🔴 默认 `python`（本机 3.11）。终审三条原语只 import 标准库
 * （sympy 只在 `_to_rational` 里 import，走 ingest 才碰得到），所以不挑环境。
 * 换机/换环境用 `GRADING_PYTHON` 指绝对路径。
 */
export function reviewPython(): string {
  return process.env.GRADING_PYTHON?.trim() ?? "python";
}

/**
 * 跑一条圣域 CLI 原语。
 * @param cmd  子命令（白名单内）
 * @param args 子命令之后的参数（学员代号 / 天 / 反馈正文 / --from 路径 …）
 *
 * 🔴 `cwd` 必须是 `_产线`：审核库.py 自己按 `_HERE` 定位 审核.db 与同目录模块，
 *    但 `rework` 报错文案里给的命令（`python 审核库.py unrework …`）是相对写法，
 *    人照着复制时也得在那个目录里跑 —— cwd 对齐，人和机器看到的是同一条命令。
 */
export function runReviewCli(
  cmd: ReviewCliCommand,
  args: string[],
): Promise<CliRun> {
  if (!(REVIEW_CLI_COMMANDS as readonly string[]).includes(cmd)) {
    // 🔴 见文件头 ③：审核库.py 对未知子命令**不报错**，会静默打印全表并 exit 0。
    //    所以这道闸在这边把死；它不该被触发，触发了就是本文件被改坏了。
    return Promise.resolve({
      argv: [],
      cwd: productionLineDir(),
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError:
        `🔴 子命令「${String(cmd)}」不在白名单 ${REVIEW_CLI_COMMANDS.join("/")} 里 —— ` +
        "审核库.py 遇到不认识的子命令会静默打印全表并 exit 0（看起来像成功了），" +
        "所以这里先拦住，绝不发给它。",
    });
  }

  const cwd = productionLineDir();
  const argv = [reviewPython(), reviewCliFile(), cmd, ...args];

  return new Promise<CliRun>((resolve) => {
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          // ① 见文件头：emoji 输出在 GBK 控制台会直接杀掉脚本
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
        },
      });
    } catch (e) {
      resolve({
        argv,
        cwd,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: `起不来 python（${reviewPython()}）：${
          e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        }`,
      });
      return;
    }

    // ② 见文件头：先攒 Buffer，最后一次性解码（中文/emoji 会跨 chunk 边界）
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, REVIEW_CLI_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    const done = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        argv,
        cwd,
        exitCode: code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    child.on("error", (e: Error) => {
      done(
        null,
        `子进程起不来或跑不动：${e.name}: ${e.message}` +
          `（解释器=${reviewPython()}；换机请设 GRADING_PYTHON 指绝对路径）`,
      );
    });
    child.on("close", (code) => done(code));
  });
}

// ---------------------------------------------------------------------------
// confirm 的临时 JSON
// ---------------------------------------------------------------------------

export interface ConfirmFileHandle {
  /** 传给 `--from` 的绝对路径 */
  path: string;
  /** 写进去的原文（回执里上墙，人一眼能核我们递了什么） */
  text: string;
  /** 用完必须调；删不掉就把原因端回去（不静默） */
  cleanup(): string | null;
}

/**
 * 把终审判定写成 `审核库.py confirm --from` 吃的 JSON。
 *
 * 🔴 只写 `verdicts` 一个键。
 *    `disputes` **永远不写**：`confirm_from` 见到非空 disputes 直接拒绝确认
 *    （「复核员自己都没定下来的题只能上报用户拍板」）——管理台上点下去的是**人的终审**，
 *    本来就没有「未决分歧」这回事；写一个空数组进去只会让人以为这条路能带分歧。
 * 🔴 `--auto` 也**永远不传**（见 confirm 路由）：不带 = auto 落 NULL = 记作人工，
 *    与审核台点「确认保存」完全同义。
 * 🔴 文件落系统 temp，不落 `_产线/`（圣域目录里不许多出我们的文件）。
 */
export function writeConfirmFile(
  student: string,
  day: number,
  verdicts: Record<string, Verdict>,
): ConfirmFileHandle {
  const dir = mkdtempSync(join(tmpdir(), "kf-review-"));
  const path = join(dir, `终审-${student}-第${day}天.json`);
  const text = JSON.stringify({ verdicts }, null, 2);
  // 🔴 utf8 无 BOM：审核库.py 走 `open(path, encoding='utf-8')`，BOM 会让 json.load 直接崩
  writeFileSync(path, text, { encoding: "utf8" });
  return {
    path,
    text,
    cleanup(): string | null {
      try {
        rmSync(dir, { recursive: true, force: true });
        return null;
      } catch (e) {
        return `临时终审 JSON 没删掉：${dir}（${
          e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        }）—— 里面只有本次的判定，没有凭据，但请顺手清一下。`;
      }
    },
  };
}
