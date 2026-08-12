/**
 * core/backup.ts —— 快照备份（AI:PRD-001 · WP4 / R-SYS-0）
 *
 * 主路 = `VACUUM INTO`：SQLite 自己保证的**一致性快照**（内部开只读事务，
 * 边备份边有人写也不会拿到半条事务）。产物是一个可以直接 open 的完整 .db，
 * 不是 dump 文本 —— 恢复 = 把文件拷回去，没有第二套解析代码可以出错。
 *
 * 🔴 为什么不是 `.backup` / 文件复制：
 *    - 裸复制 .db 文件在有写入时会拿到撕裂页（尤其 -wal 存在时）；
 *    - VACUUM INTO 顺带把库整理紧实，产物即「新库」，恢复演练验证的就是它。
 * 🔴 FTS5 建成自含式（migration 0001）正是为了这条：VACUUM INTO 出来的副本自带索引，
 *    恢复后不用重建 —— schema.test 已经把这个前提钉住了。
 *
 * 时间点：
 *   - `daily`      每日手跑 / 计划任务（scripts/backup.ps1）
 *   - `batch`      批次增量钩：003 的 ingest 提交后调 backupNow({reason:'batch'})
 *                  （🔴 本卡只留这个口子，不做调用方）
 *   - `manual`     临时手动
 *   - `pre-restore` 恢复演练/真恢复动手前的保命快照
 *
 * 异地副本：env `BACKUP_REMOTE_DIR` 设了就再复制一份过去；没设 = 跳过并如实上报
 * （🔴 不静默 —— 「以为有异地其实没有」是备份体系最贵的误会）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { createClient } from "@libsql/client";

import { armConnection, getCoreDb, type CoreDbHandle } from "./db";
import { logMetric } from "./metrics";
import { nowLocalISO } from "./time";

export type BackupReason = "daily" | "batch" | "manual" | "pre-restore";

export const BACKUP_REASONS: readonly BackupReason[] = [
  "daily",
  "batch",
  "manual",
  "pre-restore",
];

export interface BackupRowCounts {
  kp: number;
  question: number;
  audit_log: number;
}

export interface BackupResult {
  reason: BackupReason;
  takenAt: string;
  /** 快照文件绝对路径 */
  path: string;
  bytes: number;
  /** 快照里 sqlite_master 的 type='table' 张数（WP2 基线 41）——顺带证明快照打得开 */
  tables: number;
  /** 三个基准计数：从**快照文件**里数出来的，不是从主库 */
  snapshotRowCounts: BackupRowCounts;
  /** 'copied' | 'skipped(BACKUP_REMOTE_DIR unset)' | 'failed: …' */
  remote: string;
  /** 异地副本路径（没做异地就没有这个字段） */
  remotePath?: string;
  ms: number;
}

/** `file:` URL → 绝对文件路径（相对路径按 cwd 解） */
export function dbUrlToPath(url: string): string {
  if (!url.startsWith("file:")) {
    throw new Error(`只支持 file: 本地库，收到 ${JSON.stringify(url)}`);
  }
  let p = url.slice("file:".length);
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  p = decodeURIComponent(p);
  if (p.startsWith("//")) p = p.replace(/^\/+/, "/");
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return resolve(process.cwd(), p);
}

/** 备份目录 = 库文件同级的 `backup/`（跟着库走，副本库做备份也落它自己旁边） */
export function backupDirFor(dbPath: string): string {
  return join(dirname(dbPath), "backup");
}

/** 20260812-164530 */
function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** SQLite 字符串字面量转义（路径里的单引号翻倍） */
function sqlLit(p: string): string {
  return `'${p.replace(/\\/g, "/").replace(/'/g, "''")}'`;
}

async function countRowsInSnapshot(
  snapshotPath: string,
): Promise<{ tables: number; counts: BackupRowCounts }> {
  const c = createClient({ url: `file:${snapshotPath.replace(/\\/g, "/")}` });
  try {
    const one = async (sqlText: string): Promise<number> => {
      const r = await c.execute(sqlText);
      return Number((r.rows[0] as unknown as { c: number | bigint }).c);
    };
    const tables = await one(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'",
    );
    return {
      tables,
      counts: {
        kp: await one("SELECT COUNT(*) AS c FROM kp"),
        question: await one("SELECT COUNT(*) AS c FROM question"),
        audit_log: await one("SELECT COUNT(*) AS c FROM audit_log"),
      },
    };
  } finally {
    c.close();
  }
}

/**
 * 出一份快照。
 *
 * ```ts
 * const r = await backupNow({ reason: "daily" });
 * // r.path / r.bytes / r.snapshotRowCounts
 * ```
 *
 * 🔴 备份本身也留痕：完成后 logMetric('backup', path, …) —— 那是一次 core 写，
 *    连带一条审计行。「备份成没成」将来能从库里查，不靠人记。
 */
export async function backupNow(
  opts: { reason: BackupReason },
  handle?: CoreDbHandle,
): Promise<BackupResult> {
  const t0 = Date.now();
  const h = handle ?? (await getCoreDb());
  const dbPath = dbUrlToPath(h.url);
  const dir = backupDirFor(dbPath);
  mkdirSync(dir, { recursive: true });

  const takenAt = nowLocalISO();
  const base = basename(dbPath).replace(/\.db$/i, "");
  let target = join(dir, `${base}-${opts.reason}-${stamp(new Date())}.db`);
  // VACUUM INTO 拒绝写已存在的文件；同秒内跑两次就加序号，别让它炸在这
  for (let i = 2; existsSync(target); i++) {
    target = join(dir, `${base}-${opts.reason}-${stamp(new Date())}-${i}.db`);
  }

  // 排进写队列：VACUUM 不能在事务里跑，也不该和一笔 core 写抢连接
  await h.serialize(async () => {
    await armConnection(h);
    await h.client.execute(`VACUUM INTO ${sqlLit(target)}`);
  });

  const bytes = statSync(target).size;
  const { tables, counts } = await countRowsInSnapshot(target);

  // 异地副本（有配才做，没配如实说跳过）
  let remote = "skipped(BACKUP_REMOTE_DIR unset)";
  let remotePath: string | undefined;
  const remoteDir = process.env.BACKUP_REMOTE_DIR?.trim();
  if (remoteDir) {
    try {
      mkdirSync(remoteDir, { recursive: true });
      remotePath = join(remoteDir, basename(target));
      copyFileSync(target, remotePath);
      remote = "copied";
    } catch (e) {
      remote = `failed: ${String(e)}`;
      remotePath = undefined;
    }
  }

  const result: BackupResult = {
    reason: opts.reason,
    takenAt,
    path: target,
    bytes,
    tables,
    snapshotRowCounts: counts,
    remote,
    ...(remotePath ? { remotePath } : {}),
    ms: Date.now() - t0,
  };

  await logMetric("backup", target, result, h);
  return result;
}

// ---------------------------------------------------------------------------
// 只读：列快照（WP6 页面「备份」卡的取数口）
// ---------------------------------------------------------------------------

export interface BackupSnapshotInfo {
  /** 文件名（备份卡上显示的就是它） */
  file: string;
  /** 绝对路径 */
  path: string;
  bytes: number;
  /** 文件 mtime，本地 ISO（与全库时间口径一致） */
  mtime: string;
  /** 从文件名解出的时间点；解不出=unknown（手工拷进来的文件也照列，不假装没有） */
  reason: BackupReason | "unknown";
}

/** `资料库-daily-20260812-172733.db` → daily */
function reasonOf(file: string): BackupReason | "unknown" {
  for (const r of BACKUP_REASONS) {
    if (file.includes(`-${r}-`)) return r;
  }
  return "unknown";
}

/**
 * 列备份目录里的快照，新→旧。
 *
 * 🔴 事实源是**文件系统**不是库：备份的意义就在于「库没了它还在」，
 *    所以「有没有备份」这个问题不能靠查库回答（库能答说明库还活着，
 *    而这正是要备份的那个前提）。metric_event 里的 backup 行只是留痕，不是账本。
 */
export async function listBackups(
  options: { dir?: string; limit?: number } = {},
  handle?: CoreDbHandle,
): Promise<BackupSnapshotInfo[]> {
  const dir =
    options.dir ??
    backupDirFor(dbUrlToPath((handle ?? (await getCoreDb())).url));
  if (!existsSync(dir)) return [];

  const out: BackupSnapshotInfo[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".db")) continue;
    const full = join(dir, e.name);
    const st = statSync(full);
    out.push({
      file: e.name,
      path: full,
      bytes: st.size,
      mtime: nowLocalISO(st.mtime),
      reason: reasonOf(e.name),
    });
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  return typeof options.limit === "number" ? out.slice(0, options.limit) : out;
}
