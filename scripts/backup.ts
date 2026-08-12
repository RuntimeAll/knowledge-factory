/**
 * 出一份库快照（AI:PRD-001 · WP4 / R-SYS-0）——薄脚本，逻辑全在 core/backup.ts。
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/backup.ts [--reason daily|batch|manual|pre-restore]
 * 日常走 PowerShell 包装：  .\scripts\backup.ps1 [-Reason daily]
 *
 * 🔴 备份自己也留痕：core 里 backupNow() 完成后会 logMetric('backup', …)，
 *    连带一条审计行——「今天到底备了没」查库就知道，不靠人记。
 */
import {
  BACKUP_REASONS,
  backupNow,
  closeCoreDb,
  type BackupReason,
} from "../src/core/index";

function parseReason(argv: string[]): BackupReason {
  const i = argv.findIndex(
    (a) => a === "--reason" || a.startsWith("--reason="),
  );
  if (i < 0) return "daily";
  const raw = argv[i]?.includes("=")
    ? (argv[i]?.split("=", 2)[1] ?? "")
    : (argv[i + 1] ?? "");
  if ((BACKUP_REASONS as readonly string[]).includes(raw)) {
    return raw as BackupReason;
  }
  throw new Error(
    `--reason 只认 ${BACKUP_REASONS.join(" / ")}，收到 ${JSON.stringify(raw)}`,
  );
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const reason = parseReason(process.argv.slice(2));
  const r = await backupNow({ reason });

  const L = [
    `快照已出（reason=${r.reason}，耗时 ${r.ms}ms）`,
    `  文件  ：${r.path}`,
    `  大小  ：${mb(r.bytes)}（${r.bytes} 字节）`,
    `  表数  ：${r.tables}`,
    `  行数  ：kp=${r.snapshotRowCounts.kp} / question=${r.snapshotRowCounts.question} / audit_log=${r.snapshotRowCounts.audit_log}`,
    `  异地  ：${r.remote}${r.remotePath ? ` → ${r.remotePath}` : ""}`,
  ];
  process.stdout.write(L.join("\n") + "\n");
  await closeCoreDb();
}

void main();
