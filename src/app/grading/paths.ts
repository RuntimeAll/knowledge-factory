/**
 * 批改流水线四页要碰的**盘上位置**（AI:PRD-008 · PRD-027 交互面）
 *
 * 🔴 server only：本文件用 node:path / process.env，client 组件一律不许 import 它。
 * 🔴 三处位置全在 ai-bkb 根下，但根在哪**不写死**：
 *      ① `AI_BKB_ROOT` 显式给了就用它；
 *      ② 否则从圣域连接串 `GRADING_DB_URL` 倒推（.../订阅特训/_产线/审核.db）——
 *         那一条本来就必须配（core/grading.ts 的三道锁之一），跟着它走不会漂；
 *      ③ 都没有才退到常量兜底，并在页面上说清楚「这是兜底值」。
 *
 * ── 谁能写 ─────────────────────────────────────────────────────────────────
 *   收件箱/            ✍️ 本产品**唯一写入方**（跨线契约 §一），且只写新增照片 +
 *                        向 _队列.jsonl 追加行；不改旧行、不删任何东西。
 *   订阅特训/学员/     🔒 产线运行态，本产品**只读**（报告架只列文件、只读字节）。
 *   订阅特训/_产线/    🔒 只读（产线配置.json 读档位；审核.db 走 core 的 mode=ro 句柄）。
 *                     🔴 AI:PRD-009 起多一种用法：**spawn 它自己的 `审核库.py` CLI**
 *                        （终审确认/打回/撤回）。那仍然不是「我们写圣域」——
 *                        执行体是圣域自己的代码，我们只递参数、收 stdout/stderr。
 *                        圣域文件本身一个字节都不改（连 .pyc 都是 python 自己写的）。
 */
import { join } from "node:path";

import { fileUrlToPath } from "~/core";

/** 兜底根（本机实况；只在 env 两条路都拿不到时才用，页面会标注） */
const FALLBACK_ROOT = "D:/workplace/ai-bkb";

/** 统一成正斜杠（Windows 上两种分隔符混着显示很难对） */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

export interface RootResolution {
  root: string;
  /** 从哪儿定出来的（页面要能说清楚） */
  via: "AI_BKB_ROOT" | "GRADING_DB_URL" | "兜底常量";
}

/** ai-bkb 工作区根 */
export function resolveRoot(): RootResolution {
  const explicit = process.env.AI_BKB_ROOT?.trim();
  if (explicit) return { root: norm(explicit), via: "AI_BKB_ROOT" };

  const url = process.env.GRADING_DB_URL?.trim();
  if (url) {
    try {
      const p = norm(fileUrlToPath(url)); // …/订阅特训/_产线/审核.db
      const i = p.indexOf("/订阅特训/");
      if (i > 0) return { root: p.slice(0, i), via: "GRADING_DB_URL" };
    } catch {
      // 连接串坏了不该把页面打死：退兜底，页面上照实标注来源
    }
  }
  return { root: FALLBACK_ROOT, via: "兜底常量" };
}

/** 收件箱根：`<ai-bkb>/收件箱`（PRD-027 watcher 的唯一消费面） */
export function inboxDir(): string {
  const explicit = process.env.GRADING_INBOX_DIR?.trim();
  return explicit ? norm(explicit) : `${resolveRoot().root}/收件箱`;
}

/** 收件事件流：`收件箱/_队列.jsonl`（append-only，单写方=本产品） */
export function inboxQueueFile(): string {
  return `${inboxDir()}/_队列.jsonl`;
}

/** 学员运行态根：`<ai-bkb>/订阅特训/学员`（🔒 只读） */
export function studentsRoot(): string {
  const explicit = process.env.GRADING_STUDENTS_ROOT?.trim();
  return explicit ? norm(explicit) : `${resolveRoot().root}/订阅特训/学员`;
}

/** 某学员的报告目录：`学员/<代号>/报告`（🔒 只读） */
export function reportDirOf(code: string): string {
  return `${studentsRoot()}/${code}/报告`;
}

/** 产线目录：`<ai-bkb>/订阅特训/_产线`（🔒 圣域本体；只读 + spawn 它自己的 CLI） */
export function productionLineDir(): string {
  return `${resolveRoot().root}/订阅特训/_产线`;
}

/** 产线旋钮文件：`订阅特训/_产线/产线配置.json`（🔒 只读，档位正本） */
export function pipelineConfigFile(): string {
  return `${productionLineDir()}/产线配置.json`;
}

/**
 * 🔴🔴 终审写的**唯一执行体**：`_产线/审核库.py`（AI:PRD-009 · 设计稿 §一 D-A）。
 *
 * 管理台的「确认这批 / 打回 / 撤回打回」全部 spawn 这个脚本的 CLI 原语
 * （confirm --from / rework / unrework），一行写逻辑都不复制过来：
 * 审核.db 的单写方在代码层原样保持 = 圣域自己。
 */
export function reviewCliFile(): string {
  return `${productionLineDir()}/审核库.py`;
}

/**
 * 错因考点七码词表**正本**：`_产线/err_kp.json`。
 * 🔴 与审核台同一份（它把 `err_kp.KP_CN` 注进页面占位符 `__KPCN_JSON__`）——
 *    码→中文的映射前端不许硬写，这里也只读正本，读不到就报出来，不退化成空表
 *    （err_kp.py 的原话：「读不到 / 格式不对 → 直接抛错退出，绝不静默退化成空词表」）。
 */
export function errKpFile(): string {
  return `${productionLineDir()}/err_kp.json`;
}

/** 某学员某天的批改拍照目录：`学员/<代号>/批改拍照/第NN天`（🔒 只读） */
export function photoDirOf(code: string, day: number): string {
  return `${studentsRoot()}/${code}/批改拍照/第${String(day).padStart(2, "0")}天`;
}

/**
 * 某页原卷照片：`…/第NN天/照片-p<页>.jpg`（🔒 只读）。
 * 🔴 页号**不是扫目录扫出来的**，是 `SELECT DISTINCT items.page` 来的
 *    （与审核台 `/photo?s=&d=&p=` 同一口径）：库里说有第 3 页，盘上没有，
 *    那就是「照片缺了」这条事实，页面要说出来，不能靠少列一页把它藏掉。
 */
export function photoFileOf(code: string, day: number, page: number): string {
  return `${photoDirOf(code, day)}/照片-p${page}.jpg`;
}

// ---------------------------------------------------------------------------
// 名字安全（🔴 我们要拿这些字符串去拼真实路径，一个都不能马虎）
// ---------------------------------------------------------------------------

/** 路径里绝不允许出现的东西：分隔符、盘符冒号、上跳、控制字符、Windows 保留符 */
const 危险字符 = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * 代号是否可以安全地当目录名。
 * 🔴 代号还必须在 roster 里 —— 这个函数只管「字符安全」，不管「这人存不存在」，
 *    两道校验缺一不可（调用处两条都做了）。
 */
export function safeCode(code: string): string | null {
  const s = code.trim();
  if (!s) return null;
  if (s === "." || s === "..") return null;
  if (s.includes("..")) return null;
  if (危险字符.test(s)) return null;
  if (s.length > 40) return null;
  return s;
}

/**
 * 上传文件名 → 安全的落盘名（保留原名的可读部分，不安全的字符换成 `_`）。
 * 🔴 只取 basename：浏览器在选文件夹上传时会带相对路径（`day5/1.jpg`），
 *    直接用会在收件箱里长出一层没人预期的目录。
 */
export function safePhotoName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_");
  return cleaned.length > 80 ? cleaned.slice(-80) : cleaned || "photo";
}

/** 扩展名（小写、带点）；没有扩展名就返回空串 */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i).toLowerCase();
}

/** `2026-08-14T15:30:12+08:00` → `20260814-153012`（当批文件名前缀；🔴 收件箱平铺一层，不建时间戳子目录） */
export function stampOfIso(iso: string): string {
  const d = iso.slice(0, 10).replace(/-/g, "");
  const t = iso.slice(11, 19).replace(/:/g, "");
  return `${d}-${t}`;
}

/** 拼绝对路径（统一正斜杠输出，Windows 下 join 会给反斜杠） */
export function underRoot(base: string, ...segs: string[]): string {
  return norm(join(base, ...segs));
}
