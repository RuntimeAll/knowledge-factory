/**
 * core/grading.ts —— 圣域（批改线 审核.db）只读连接（AI:PRD-001 · WP4）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 G-1 全局红线：审核.db 是**批改线的正本**，本产品对它只有 SELECT / PRAGMA。
 *      物理上不留写路径 —— 违反 = 事故（把别人产线的账本写坏，赔不起）。
 *
 * 三道锁（缺一不可，任何一道都能单独拦住写）：
 *   ① **声明锁**：`GRADING_DB_URL` 必须显式带 `mode=ro`，否则 getGradingDb() 直接抛。
 *      🔴 不许「没带就默默补上」—— 配置里读不出「这是只读挂载」的意图，
 *         下一个人就会把它当普通库用。声明是给人看的，得写出来。
 *   ② **物理锁**：用 `node:sqlite` 的 `readOnly: true` 打开，即 SQLITE_OPEN_READONLY。
 *      连 SQLite 自己都拒绝写（实测报 "attempt to write a readonly database"）。
 *   ③ **语句锁**：对外只给 gradingQuery()，非 SELECT/WITH/PRAGMA 的语句在发到库之前就抛；
 *      裸 handle 不出本模块（core barrel 不 re-export 它）。
 *
 * 🔴 为什么不用 @libsql/client（本仓其它地方都用它）：
 *    - 它把 `file:...?mode=ro` 当**非法 URL** 直接抛
 *      （@libsql/core/config.js：file: 方案只认 tls / authToken 两个查询参数，
 *       其余一律 `Unsupported URL query parameter`）；
 *    - 就算把参数摘掉，它打开的仍是**读写句柄**（O_RDWR）。对圣域来说
 *      「我保证不写」不如「操作系统不让我写」。所以这一处刻意偏离主栈。
 *    代价 = 需要 Node ≥ 22.5（node:sqlite）。本机 v24.11.1；低于该版本这里会给人话报错，
 *    只影响圣域对账（C4/C5），不影响本库自身的任何功能。
 *
 * 🔴 审核.db 现状 journal_mode=delete（实测），只读打开不会生成 -wal/-shm，
 *    圣域目录里不会因为我们多出任何文件。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
// 🔴 只导类型：`import type` 编译期就擦掉，运行时不会 require node:sqlite
//    （真正的加载是下面 getGradingDb() 里的动态 import，Node < 22.5 才能给人话报错）
import type { DatabaseSync as DatabaseSyncClass } from "node:sqlite";

import { nowLocalISO } from "./time";

/** 🔴 连接串里必须出现的只读声明 */
export const GRADING_RO_MARKER = "mode=ro";

/** 只读连接句柄（裸 db 不出本模块） */
export interface GradingDbHandle {
  /** 原始连接串（含 mode=ro 声明） */
  readonly url: string;
  /** 落地文件路径 */
  readonly path: string;
  /** 🔴 唯一查询口：只吃 SELECT / WITH / PRAGMA */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

// ---------------------------------------------------------------------------
// 连接串校验
// ---------------------------------------------------------------------------

/**
 * 校验并解析圣域连接串 → 文件路径。
 * 🔴 没有 `mode=ro` 就抛，不补、不猜。
 */
export function assertGradingUrl(url: string): string {
  if (!url || url.trim() === "") {
    throw new Error(
      "GRADING_DB_URL 没设：圣域（审核.db）只读连接串缺失。" +
        '正确形如 GRADING_DB_URL="file:D:/workplace/ai-bkb/订阅特训/_产线/审核.db?mode=ro"',
    );
  }
  if (!url.startsWith("file:")) {
    throw new Error(
      `圣域连接串只支持 file: 本地库，收到 ${JSON.stringify(url)}`,
    );
  }
  if (!url.includes(GRADING_RO_MARKER)) {
    throw new Error(
      "🔴 圣域只读挂载必须显式 mode=ro：" +
        `GRADING_DB_URL=${JSON.stringify(url)} 里没有 \`${GRADING_RO_MARKER}\`。` +
        "审核.db 是批改线正本，本产品对它只有 SELECT——" +
        "连接串里读不出这个意图就不许连（这里不会替你补上）。",
    );
  }
  return fileUrlToPath(url);
}

/** `file:` URL → 文件系统路径（顺带砍掉查询串；支持 file:D:/x、file:/x、file:///x） */
export function fileUrlToPath(url: string): string {
  let p = url.slice("file:".length);
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  p = decodeURIComponent(p);
  if (p.startsWith("//")) p = p.replace(/^\/+/, "/"); // file:///D:/x → /D:/x
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /D:/x → D:/x
  return p;
}

// ---------------------------------------------------------------------------
// 语句锁
// ---------------------------------------------------------------------------

/** 允许打到圣域的语句：只读三种开头 */
const READ_ONLY_STMT_RE = /^\s*(?:SELECT|WITH|PRAGMA)\b/i;

/** 🔴 语句锁：非只读语句在发到库之前就拦下（含「用分号夹带第二条」） */
export function assertReadOnlyStatement(sql: string): void {
  if (!READ_ONLY_STMT_RE.test(sql)) {
    throw new Error(
      `🔴 圣域只读：只接受 SELECT / WITH / PRAGMA，拒绝执行 ${JSON.stringify(sql.slice(0, 80))}`,
    );
  }
  // 去掉末尾分号后仍带分号 = 多语句，一律拒（不给「夹带一条 UPDATE」留缝）
  if (
    sql
      .trim()
      .replace(/;+\s*$/, "")
      .includes(";")
  ) {
    throw new Error("🔴 圣域只读：一次只准一条语句（检测到分号分隔的多语句）");
  }
}

// ---------------------------------------------------------------------------
// 连接（按 url 缓存）
// ---------------------------------------------------------------------------

const pool = new Map<string, GradingDbHandle>();

function resolveGradingUrl(url?: string): string {
  return url ?? process.env.GRADING_DB_URL ?? "";
}

/**
 * 拿圣域只读句柄（同一 url 复用一条连接）。
 * @param url 覆盖连接串（测试/脚本用）；默认惰性读 process.env.GRADING_DB_URL
 */
export async function getGradingDb(url?: string): Promise<GradingDbHandle> {
  const raw = resolveGradingUrl(url);
  const cached = pool.get(raw);
  if (cached) return cached;

  const path = assertGradingUrl(raw);

  let DatabaseSync: typeof DatabaseSyncClass;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    throw new Error(
      "圣域只读连接需要 node:sqlite（Node ≥ 22.5）——" +
        "它是唯一能以 SQLITE_OPEN_READONLY 打开文件的驱动，" +
        "@libsql/client 只给读写句柄，对审核.db 不够格。" +
        `当前 Node ${process.version}。原始错误：${String(e)}`,
    );
  }

  let db: DatabaseSyncClass;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new Error(
      `圣域（审核.db）打不开：${path}\n` +
        "确认文件在、路径没写错（🔴 只读打开失败绝不降级成读写重试）。" +
        `原始错误：${String(e)}`,
    );
  }

  const handle: GradingDbHandle = {
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

/** 关掉所有圣域连接（脚本收尾 / 测试隔离） */
export function closeGradingDb(): void {
  for (const h of [...pool.values()]) h.close();
}

// ---------------------------------------------------------------------------
// schema 快照（契约附件的生成口径 = 对账 C4a 的重算口径，同一份代码）
// ---------------------------------------------------------------------------

export interface GradingTableDdl {
  name: string;
  /**
   * 🔴 **原样 DDL**（sqlite_master 里怎么写就怎么存，换行/缩进/`--` 注释全留着）。
   *    为什么不存规范化版：批改线的 DDL 是「一列一行 + 行尾 `--` 注释」的写法，
   *    空白一折叠，注释就把它后面那些列吞进去了（`status …, -- pending/confirmed created_at TEXT,`）
   *    ——人一眼看过去会以为没有 created_at 这列。M1 §3.F 手抄漏 4 列的教训就是这么来的，
   *    快照文件必须**人能核**。规范化只发生在算 hash 的时候（见 gradingSchemaHash）。
   */
  sql: string;
}

export interface GradingSchemaSnapshot {
  takenAt: string;
  /** 相对表述（不写死本机绝对路径） */
  dbPath: string;
  schemaHash: string;
  tables: GradingTableDdl[];
  /** hash 配方，写进文件免得后人靠猜 */
  hashRecipe: string;
}

export const GRADING_HASH_RECIPE =
  "sha256(JSON.stringify(tables.map(t => ({name, sql: t.sql.replace(/\\s+/g,' ').trim()})))) " +
  "—— tables 按 name 升序；文件里存的 sql 是原样 DDL，规范化只在算 hash 时做（缩进/换行改了不算 schema 变更）";

/** DDL 规范化：连续空白折叠成一个空格再 trim（缩进/换行的差异不该算作 schema 变更） */
export function normalizeDdl(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 🔴 快照哈希：生成脚本与对账 C4a 共用这一个函数，口径不可能漂。
 *    入参给原样 DDL 即可 —— 规范化在函数内部做，两侧不会一个规范化一个没有。
 */
export function gradingSchemaHash(tables: readonly GradingTableDdl[]): string {
  const canon = tables.map((t) => ({ name: t.name, sql: normalizeDdl(t.sql) }));
  return createHash("sha256")
    .update(JSON.stringify(canon), "utf8")
    .digest("hex");
}

/** 相对表述：能截到 ai-bkb 根就截，截不到就原样（宁可长也不写假的） */
export function describeDbPath(absPath: string): string {
  const p = absPath.replace(/\\/g, "/");
  const i = p.indexOf("/ai-bkb/");
  return i >= 0 ? p.slice(i + "/ai-bkb/".length) + "（相对 ai-bkb 根）" : p;
}

/**
 * 现场读圣域 sqlite_master 出一份 schema 快照。
 * 🔴 只 SELECT；M1 §3.F 教训「快照禁手抄」的机器版。
 */
export async function gradingSchemaSnapshot(
  url?: string,
): Promise<GradingSchemaSnapshot> {
  const h = await getGradingDb(url);
  const rows = h.query<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
  );
  // 🔴 存原样 DDL（人要能核），hash 那步才规范化
  const tables = rows.map((r) => ({ name: r.name, sql: r.sql ?? "" }));
  return {
    takenAt: nowLocalISO(),
    dbPath: describeDbPath(h.path),
    schemaHash: gradingSchemaHash(tables),
    tables,
    hashRecipe: GRADING_HASH_RECIPE,
  };
}
