/**
 * core/health.ts —— 本地体检（AI:PRD-001 · WP3）
 *
 * 只回答「库还活着吗、地基还是原来那副样子吗」这类**便宜且确定**的问题：
 * 库可达 / 表数 / 审计链尾 / 静息闸 / journal_mode。
 *
 * 🔴 这不是 integrity_check（六项对账：孤儿行、审计覆盖、全链重算…… 那是 WP4）。
 *    health 要能被随手调、毫秒级返回；链的**全量**重算不在这儿跑，
 *    这里只报链尾游标（seq + 下一行应带的 prev_hash）。
 * 🔴 journal_mode 现状是 delete，本函数只**如实上报**不改它 ——
 *    切不切 WAL 是总指挥层面的决定，core 不许偷偷动。
 */
import { desc } from "drizzle-orm";

import { auditLog } from "~/server/db/schema";
import {
  AUDIT_GENESIS_HASH,
  hashOfRow,
  verifyAuditChain,
  type AuditChainReport,
} from "./audit";
import { armConnection, getCoreDb, type CoreDbHandle } from "./db";
import { nowLocalISO } from "./time";
import { readWriteGate } from "./write";

export interface HealthReport {
  /** 库可达 + 闸静息 + （若做了链校验）链完好 */
  ok: boolean;
  url: string;
  checkedAt: string;
  /** sqlite_master 里 type='table' 的张数（含 FTS 影子表与机制表；WP2 基线=41） */
  tableCount: number;
  /** 审计链尾 seq；空链=null */
  auditHeadSeq: number | null;
  /** 下一行应携带的 prev_hash；空链=创世哈希 */
  auditNextPrevHash: string;
  /** 静息闸；🔴 正常恒为 0，非 0 = 有人把闸拆成独立事务或手动开了没关 */
  writeGate: number;
  gateResting: boolean;
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  /** 只有 deep=true 才有：全链重算结果 */
  chain?: AuditChainReport;
}

export interface HealthOptions {
  /** 顺带全量重算审计链（行多会慢，默认不做） */
  deep?: boolean;
}

async function scalar<T>(
  handle: CoreDbHandle,
  sqlText: string,
  column: string,
): Promise<T | undefined> {
  const r = await handle.client.execute(sqlText);
  const row = r.rows[0] as unknown as Record<string, T> | undefined;
  return row?.[column];
}

export async function health(
  options: HealthOptions = {},
  handle?: CoreDbHandle,
): Promise<HealthReport> {
  const h = handle ?? (await getCoreDb());
  // 排进写队列再体检：PRAGMA 是每连接的，而写事务会换连接（db.ts §连接漂移）。
  // 不排队的话可能读到「一条刚被懒建、还没武装」的连接，报出假的 foreign_keys=off。
  return h.serialize(() => collect(h, options));
}

async function collect(
  h: CoreDbHandle,
  options: HealthOptions,
): Promise<HealthReport> {
  await armConnection(h);

  const tableCount = Number(
    (await scalar<number>(
      h,
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'",
      "c",
    )) ?? 0,
  );
  const journalMode = String(
    (await scalar<string>(h, "PRAGMA journal_mode", "journal_mode")) ??
      "unknown",
  );
  const foreignKeys =
    Number(
      (await scalar<number>(h, "PRAGMA foreign_keys", "foreign_keys")) ?? 0,
    ) === 1;
  const busyTimeoutMs = Number(
    (await scalar<number>(h, "PRAGMA busy_timeout", "timeout")) ?? 0,
  );

  const writeGate = await readWriteGate(h);
  const gateResting = writeGate === 0;

  // 链尾游标：不重算全链，只看最后一行
  const chainHead = options.deep
    ? await verifyAuditChain(h)
    : await headOnly(h);

  return {
    ok: gateResting && tableCount > 0 && chainHead.ok,
    url: h.url,
    checkedAt: nowLocalISO(),
    tableCount,
    auditHeadSeq: chainHead.headSeq,
    auditNextPrevHash: chainHead.nextPrevHash,
    writeGate,
    gateResting,
    journalMode,
    foreignKeys,
    busyTimeoutMs,
    ...(options.deep ? { chain: chainHead } : {}),
  };
}

/** 只取链尾（O(1)），不做校验 */
async function headOnly(handle: CoreDbHandle): Promise<AuditChainReport> {
  const tail = await handle.db
    .select({
      seq: auditLog.seq,
      ts: auditLog.ts,
      actor: auditLog.actor,
      tool: auditLog.tool,
      argsDigest: auditLog.argsDigest,
      gateResultsJson: auditLog.gateResultsJson,
      rowRefsJson: auditLog.rowRefsJson,
      prevHash: auditLog.prevHash,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  const head = tail[0];
  return {
    ok: true,
    checkedRows: 0,
    headSeq: head?.seq ?? null,
    nextPrevHash: head ? hashOfRow(head) : AUDIT_GENESIS_HASH,
  };
}
