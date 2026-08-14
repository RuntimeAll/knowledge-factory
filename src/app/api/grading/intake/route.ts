/**
 * `/api/grading/intake` —— 收卷录入（AI:PRD-008 · PRD-027 交互面）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 本路由是本组**唯一的写**（写操作白名单五类之一：收卷录入），而且写的**不是库**：
 *      POST → `收件箱/<代号>/<时间戳>/` 落新照片 + 向 `收件箱/_队列.jsonl` 追加一行。
 *
 *      跨线契约 §一/§二·6（`ai-bkb/跨线契约-无人值守批改与知识工厂.md`）：
 *        · 收件箱是 PRD-027 的地盘，**管理台上传 API 是唯一写入方**，
 *          且只写新增照片 —— 不改旧文件、不删任何东西（写盘一律 flag:"wx"，
 *          撞名直接失败，绝不覆盖别人的照片）；
 *        · `_队列.jsonl` **append-only**：一行 = {ts, code, files, status:"收件中"}，
 *          永不回头改旧行（watcher/编排器不写这个文件，状态记在它自己的台账）。
 *
 * 🔴 这里**一行都不碰审核.db**（G-1 红线：圣域只读），也不写本库 —— 收件是文件事件，
 *    落库发生在产线 收卷.py 那一步，那是 027 的执行权。因此本次写**没有审计行**：
 *    痕迹就是盘上的照片 + jsonl 那一行（页面把绝对路径原文回显给人看）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * GET  → 最近录入表（读 `_队列.jsonl` 尾 20 行；文件不存在 = 还没提交过，不是故障）
 * POST → 收卷（multipart/form-data：code / paperKind / files[]）
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { NextResponse } from "next/server";

import { bridgeBatches, listRoster, nowLocalISO } from "~/core";
import {
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  PAPER_KINDS,
  PHOTO_EXTS,
  type IntakeQueueLine,
  type IntakeRecentResponse,
  type IntakeRecentRow,
  type IntakeSubmitResponse,
  type PaperKind,
} from "~/app/grading/shared";
import {
  extOf,
  inboxDir,
  inboxQueueFile,
  safeCode,
  safePhotoName,
  stampOfIso,
  underRoot,
} from "~/app/grading/paths";

/** node:fs + core（node:sqlite / libsql）—— edge runtime 跑不了 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 最近录入表取尾多少行 */
const TAIL = 20;

function 原文(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ---------------------------------------------------------------------------
// GET：最近录入（只读）
// ---------------------------------------------------------------------------

/** 一行 JSON → 表格行；解析不了就把原文挂在 badLine 上（不静默跳过） */
function 解析行(raw: string, lineNo: number): IntakeRecentRow {
  const 空 = (err?: string): IntakeRecentRow => ({
    lineNo,
    ts: null,
    code: null,
    files: [],
    status: null,
    paperKind: null,
    badLine: raw,
    ...(err ? { parseError: err } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return 空(原文(e));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return 空("这一行不是 JSON 对象");
  }
  const o = parsed as Record<string, unknown>;
  const files = Array.isArray(o.files)
    ? o.files.filter((x): x is string => typeof x === "string")
    : [];
  return {
    lineNo,
    ts: typeof o.ts === "string" ? o.ts : null,
    code: typeof o.code === "string" ? o.code : null,
    files,
    status: typeof o.status === "string" ? o.status : null,
    paperKind: typeof o.卷型 === "string" ? o.卷型 : null,
  };
}

export function GET(): NextResponse {
  const queuePath = inboxQueueFile();
  try {
    if (!existsSync(queuePath)) {
      const body: IntakeRecentResponse = {
        ok: true,
        data: [],
        total: 0,
        queuePath,
        exists: false,
        lines: 0,
      };
      return NextResponse.json(body);
    }
    const text = readFileSync(queuePath, "utf8");
    const all = text.split(/\r?\n/);
    // 行号按文件里的真实位置算（尾部空行不算一行）
    const rows: IntakeRecentRow[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const line = all[i] ?? "";
      if (line.trim() === "") continue;
      rows.push(解析行(line, i + 1));
    }
    const tail = rows.slice(-TAIL).reverse(); // 新的在上
    const body: IntakeRecentResponse = {
      ok: true,
      data: tail,
      total: tail.length,
      queuePath,
      exists: true,
      lines: rows.length,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: IntakeRecentResponse = {
      ok: false,
      error: `读收件队列失败：${原文(e)}（文件=${queuePath}）`,
      data: [],
      total: 0,
      queuePath,
      exists: existsSync(queuePath),
      lines: 0,
    };
    return NextResponse.json(body, { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// POST：收卷（🔴 唯一的写）
// ---------------------------------------------------------------------------

/** 表单里的一格 → 字符串（File 那种格子一律当没填，不做 [object Object] 那种蠢事） */
function 文本(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function 拒(error: string): NextResponse {
  const body: IntakeSubmitResponse = { ok: false, error };
  // 🔴 HTTP 仍 200：错误原文要原样端到页面上（与 /api/questions 同一约定），
  //    前端按 ok 判断，不靠状态码猜。
  return NextResponse.json(body, { status: 200 });
}

export async function POST(req: Request): Promise<NextResponse> {
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch (e) {
    return 拒(`表单读不出来（不是 multipart/form-data？）：${原文(e)}`);
  }

  // ── 学员代号：字符安全 + 必须在 roster 里 ──────────────────────────────
  const codeRaw = 文本(fd.get("code"));
  if (!codeRaw) return 拒("没选学员 —— 代号是收件箱的目录名，不能空。");
  const code = safeCode(codeRaw);
  if (!code) {
    return 拒(
      `代号 ${JSON.stringify(codeRaw)} 不能当目录名（含路径分隔符 / 上跳 / 控制字符，或太长）。`,
    );
  }
  // ── 代号必须**认得出来**：名册 ∪ 圣域里出现过的代号 ────────────────────────
  //
  // 🔴🔴 2026-08-14 修（验收判红）：原来只认 roster（4 人），而批改线现役是 6 人 ——
  //    「困呆眠」「小宇川奈子」当天刚出批次和报告，却在本页选不到、提交也被硬拒。
  //    这页是设计稿定义的「你唯一的动作」，对 1/3 现役学员不可用是硬伤。
  //    ⇒ 认「圣域 batches.student 里出现过」的代号：他们本来就是真学员（交过卷），
  //      而这道闸真正要防的是**手打错字建出一个幽灵目录**，不是防没登记名册的人。
  //    ⇒ 但要**说一声**（notes）：没登记名册 = 选题台/交付指向拿不到年级与版本语境。
  const 注记: string[] = [];
  let 名册: { code: string }[];
  try {
    名册 = await listRoster();
  } catch (e) {
    return 拒(`读 roster 失败（代号得先对得上名册才敢建目录）：${原文(e)}`);
  }
  if (!名册.some((r) => r.code === code)) {
    let 圣域代号: string[] = [];
    let 圣域错: string | null = null;
    try {
      const b = await bridgeBatches();
      圣域代号 = [
        ...new Set(
          b.batches
            .map((x) => x.student)
            .filter((s): s is string => !!s && s.trim() !== ""),
        ),
      ];
    } catch (e) {
      圣域错 = 原文(e);
    }
    if (!圣域代号.includes(code)) {
      return 拒(
        `认不出代号「${code}」—— 名册里没有，圣域（审核.db）也没有他的批次。` +
          "收件箱按代号分目录，认不出的代号多半是打错字（建出来就是个没人管的幽灵目录）。\n" +
          `名册代号：${名册.map((r) => r.code).join("、") || "（一个都没有）"}\n` +
          `圣域出现过的代号：${圣域代号.join("、") || (圣域错 ? `（读不出来：${圣域错}）` : "（一个都没有）")}\n` +
          "真是新学员：先 upsertRoster 登记（🔴 只落代号不落真名）再收卷。",
      );
    }
    注记.push(
      `代号「${code}」只在圣域出现过，roster 里没登记 —— 收件照收（学情事实全在圣域），` +
        "但选题台/交付指向拿不到他的年级与版本语境。补登记走 upsertRoster（agent/MCP），页面上不做。",
    );
  }

  // ── 卷型（可选；只在手选时进 jsonl） ──────────────────────────────────
  const kindRaw = 文本(fd.get("paperKind")) || "auto";
  const paperKind: PaperKind = (PAPER_KINDS as readonly string[]).includes(
    kindRaw,
  )
    ? (kindRaw as PaperKind)
    : "auto";

  // ── 照片 ───────────────────────────────────────────────────────────────
  const files = fd.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return 拒("一张照片都没有 —— 先把卷子拍的图拖进来。");
  if (files.length > MAX_PHOTOS) {
    return 拒(
      `一次最多 ${MAX_PHOTOS} 张，这次给了 ${files.length} 张（超这个数多半是选错了目录）。`,
    );
  }
  for (const f of files) {
    const ext = extOf(f.name);
    if (!(PHOTO_EXTS as readonly string[]).includes(ext)) {
      return 拒(
        `「${f.name}」不是照片（扩展名 ${ext || "（无）"}）——只收 ${PHOTO_EXTS.join(" / ")}。`,
      );
    }
    if (f.size > MAX_PHOTO_BYTES) {
      return 拒(
        `「${f.name}」有 ${(f.size / 1024 / 1024).toFixed(1)}MB，超过单张上限 ${MAX_PHOTO_BYTES / 1024 / 1024}MB。`,
      );
    }
    if (f.size === 0) return 拒(`「${f.name}」是 0 字节 —— 空文件不收。`);
  }

  // ── 落盘：收件箱/<代号>/<时间戳>/ ─────────────────────────────────────
  const ts = nowLocalISO();
  const base = underRoot(inboxDir(), code);
  let stamp = stampOfIso(ts);
  let dir = underRoot(base, stamp);
  // 同一秒再提交一次：不合并、不覆盖，另起一个目录（一批 = 一次提交）
  for (let n = 2; existsSync(dir) && n <= 20; n += 1) {
    stamp = `${stampOfIso(ts)}-${n}`;
    dir = underRoot(base, stamp);
  }
  if (existsSync(dir)) {
    return 拒(
      `目录已存在且试了 20 个后缀都撞上：${dir}（这不该发生，去看一眼收件箱）`,
    );
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return 拒(`建目录失败：${dir}\n${原文(e)}`);
  }

  const saved: string[] = [];
  const rel: string[] = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i]!;
      // 🔴 序号前缀锁住**拍摄顺序**：整页直读要按页序看，文件系统的字典序靠不住
      const name = `${String(i + 1).padStart(2, "0")}_${safePhotoName(f.name)}`;
      const bytes = Buffer.from(await f.arrayBuffer());
      // 🔴 flag "wx"：撞名直接抛，绝不覆盖（契约：只写新增，不改不删）
      writeFileSync(underRoot(dir, name), bytes, { flag: "wx" });
      saved.push(name);
      // 相对收件箱根的路径（watcher 与看板都按这个口径认这批图）
      rel.push(`${code}/${stamp}/${name}`);
    }
  } catch (e) {
    // 🔴 写了一半：已经落盘的**不删**（删是我们没有的权限），如实报告写进去几张。
    //    下面照样把 jsonl 那一行补上 —— 让 watcher 看得见这批残件，比留个孤儿目录强。
    const queuePath = inboxQueueFile();
    let lineText: string | undefined;
    if (saved.length > 0) {
      try {
        lineText = 追加队列行(queuePath, { ts, code, files: rel, paperKind });
      } catch {
        /* 队列写不进去的原因跟着主错误一起报，别把它盖掉 */
      }
    }
    const body: IntakeSubmitResponse = {
      ok: false,
      error:
        `写照片写到第 ${saved.length + 1} 张时失败：${原文(e)}\n` +
        `🔴 已落盘的 ${saved.length} 张**没有回滚**（收件箱只准新增，删不是我们的权限）——` +
        `目录 ${dir} 请人工看一眼。`,
      dir,
      saved,
      ...(lineText ? { line: lineText, queuePath } : {}),
    };
    return NextResponse.json(body, { status: 200 });
  }

  // ── 追加事件流一行（append-only） ─────────────────────────────────────
  const queuePath = inboxQueueFile();
  let lineText: string;
  try {
    lineText = 追加队列行(queuePath, { ts, code, files: rel, paperKind });
  } catch (e) {
    const body: IntakeSubmitResponse = {
      ok: false,
      error:
        `照片已写进 ${dir}（${saved.length} 张），但 _队列.jsonl 追加失败：${原文(e)}\n` +
        "watcher 是盯目录的，这批照片仍会被捡到；只是本页「最近录入」看不见它。",
      dir,
      saved,
      queuePath,
    };
    return NextResponse.json(body, { status: 200 });
  }

  const body: IntakeSubmitResponse = {
    ok: true,
    dir,
    saved,
    line: lineText,
    queuePath,
    ...(注记.length > 0 ? { notes: 注记 } : {}),
  };
  return NextResponse.json(body);
}

/**
 * 向 `_队列.jsonl` 追加一行（契约四键 + 手选卷型才多的第五键）。
 * @returns 真正写进去的那一行原文（页面原样回显，省得人再去开文件）
 */
function 追加队列行(
  queuePath: string,
  arg: { ts: string; code: string; files: string[]; paperKind: PaperKind },
): string {
  const line: IntakeQueueLine = {
    ts: arg.ts,
    code: arg.code,
    files: arg.files,
    status: "收件中",
    // 🔴 auto 不写：契约四键是正本，能不加键就不加（加了要走 §三 通报）
    ...(arg.paperKind === "auto" ? {} : { 卷型: arg.paperKind }),
  };
  const text = JSON.stringify(line);
  mkdirSync(inboxDir(), { recursive: true });
  // 🔴 appendFileSync：只往后追加，永不回头改旧行
  appendFileSync(queuePath, text + "\n", "utf8");
  return text;
}
