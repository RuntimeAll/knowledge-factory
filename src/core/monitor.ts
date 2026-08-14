/**
 * core/monitor.ts —— 系统监控三页的只读列侧（AI:PRD-008 · P3）
 *
 * 补的是地基交接说明「遗留 5」里卡住两页的两个函数：
 *   - {@link listIngestBatches}  /ingest 录入批次台账（core 只有 getIngestBatch 单条）
 *   - {@link listAuditRows}      /audit 审计日志（core 只有 verifyAuditChain 校验，没有列行）
 *
 * 🔴🔴 **全文件零写**：只有 SELECT，一条 INSERT/UPDATE 都没有，也就不产生审计行。
 *    这是刻意的 —— 监督面每刷新一次就往 audit_log 里追一行的话，
 *    「谁动了库」这张表会被浏览器刷成噪音，而它恰恰是本页要看的东西。
 *
 * 🔴 时间筛选一律走 `substr(ts,1,10)` 比日期前缀，不做时区换算：
 *    库里存的是**本地** ISO（core/time.ts 口径，形如 `2026-08-14T10:45:40+08:00`），
 *    前 10 位就是本地那一天。拿 Date 去 parse 再比，反而会因为 UTC 归一化把
 *    当天早上 8 点前的行推到前一天去。
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { auditLog, ingestBatch, quarantine } from "~/server/db/schema";
import type { RowRef } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import type { IngestCounts } from "./ingest";

/** 一次调用最多列多少行（页面分页在这之内做；本地库当下 44 批 / 547 审计行） */
const MAX_LIMIT = 500;

function clamp(n: number | undefined, dflt: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// 录入批次台账（/ingest）
// ---------------------------------------------------------------------------

export interface IngestBatchBrief {
  id: string;
  contractVer: string;
  source: string;
  /** 'open' | 'committed' | 'failed'（库里 CHECK 约束的三态） */
  status: string | null;
  counts: IngestCounts;
  createdAt: string | null;
  committedAt: string | null;
  /** gate_report_json 在不在 —— 不在的话「闸报告」没东西可展，按钮该置灰而不是弹个空层 */
  hasGateReport: boolean;
  /** 本批的隔离行（管道拒了的题原样躺在那儿）：未结 / 总数 */
  quarantineOpen: number;
  quarantineTotal: number;
}

export interface ListIngestBatchesOptions {
  /** 来源子串（source LIKE %kw%，大小写按 SQLite 默认 = ASCII 不敏感、中文精确） */
  source?: string;
  status?: string;
  /** 起止日期（`YYYY-MM-DD`，含当天；比的是本地日期前缀） */
  from?: string;
  to?: string;
  limit?: number;
  handle?: CoreDbHandle;
}

/**
 * 列录入批次，新→旧。
 *
 * 🔴 排序用 `id` 倒序而不是 created_at：批次 id 是 ULID（发号即单调），
 *    而 created_at 是秒精度字符串 —— 群卷接入那种一秒连投三批的场景（库里就有），
 *    按 ts 排序名次不稳定，页面上会看见两次刷新顺序不一样。
 */
export async function listIngestBatches(
  opts: ListIngestBatchesOptions = {},
): Promise<IngestBatchBrief[]> {
  const h = opts.handle ?? (await getCoreDb());
  const limit = clamp(opts.limit, 200);

  const conds: SQL[] = [];
  const source = opts.source?.trim();
  if (source) conds.push(sql`${ingestBatch.source} LIKE ${`%${source}%`}`);
  if (opts.status?.trim())
    conds.push(eq(ingestBatch.status, opts.status.trim()));
  if (opts.from?.trim()) {
    conds.push(
      sql`substr(${ingestBatch.createdAt}, 1, 10) >= ${opts.from.trim()}`,
    );
  }
  if (opts.to?.trim()) {
    conds.push(
      sql`substr(${ingestBatch.createdAt}, 1, 10) <= ${opts.to.trim()}`,
    );
  }

  const rows = await h.db
    .select({
      id: ingestBatch.id,
      contractVer: ingestBatch.contractVer,
      source: ingestBatch.source,
      status: ingestBatch.status,
      nTotal: ingestBatch.nTotal,
      nAccepted: ingestBatch.nAccepted,
      nQueued: ingestBatch.nQueued,
      nRejected: ingestBatch.nRejected,
      createdAt: ingestBatch.createdAt,
      committedAt: ingestBatch.committedAt,
      // 🔴 只取「在不在」不取正文：gate_report_json 单批能到 76KB，
      //    列表页 44 行全拉进来就是几 MB，而列表根本不显示它（详情才读）。
      hasGate: sql<number>`CASE WHEN ${ingestBatch.gateReportJson} IS NULL THEN 0 ELSE 1 END`,
    })
    .from(ingestBatch)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(ingestBatch.id))
    .limit(limit);

  // 隔离计数一次性按批分组取回（不逐行查，44 批就是 44 次往返）
  const qr = await h.db
    .select({
      batchId: quarantine.batchId,
      total: sql<number>`COUNT(*)`,
      open: sql<number>`SUM(CASE WHEN ${quarantine.resolvedAt} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(quarantine)
    .groupBy(quarantine.batchId);
  const qrOf = new Map(qr.map((r) => [r.batchId ?? "", r]));

  return rows.map((b) => {
    const q = qrOf.get(b.id);
    return {
      id: b.id,
      contractVer: b.contractVer,
      source: b.source,
      status: b.status,
      counts: {
        total: Number(b.nTotal ?? 0),
        accepted: Number(b.nAccepted ?? 0),
        queued: Number(b.nQueued ?? 0),
        rejected: Number(b.nRejected ?? 0),
      },
      createdAt: b.createdAt,
      committedAt: b.committedAt,
      hasGateReport: Number(b.hasGate) === 1,
      quarantineOpen: Number(q?.open ?? 0),
      quarantineTotal: Number(q?.total ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// 审计日志（/audit）
// ---------------------------------------------------------------------------

export interface AuditRowView {
  seq: number;
  ts: string | null;
  actor: string | null;
  tool: string | null;
  argsDigest: string | null;
  /** row_refs_json 解析后；解析不动 = null（原文照留在 rowRefsRaw，读侧不炸） */
  rowRefs: RowRef[] | null;
  rowRefsRaw: string | null;
  /** 这次写有没有带闸账（只有过闸的写路径才有）；正文不驮，详情再说 */
  hasGateResults: boolean;
  prevHash: string | null;
}

export interface ListAuditOptions {
  actor?: string;
  tool?: string;
  /** 起止日期（`YYYY-MM-DD`，含当天） */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  handle?: CoreDbHandle;
}

export interface AuditListResult {
  rows: AuditRowView[];
  /** 命中条件的总行数（分页用） */
  total: number;
  /** 全表出现过的 actor / tool（筛选下拉的候选，不受当前条件影响） */
  actors: string[];
  tools: string[];
}

function parseRowRefs(raw: string | null): RowRef[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const out: RowRef[] = [];
    for (const x of v) {
      if (typeof x !== "object" || x === null) continue;
      const o = x as Record<string, unknown>;
      if (typeof o.table !== "string" || typeof o.id !== "string") continue;
      const op = o.op;
      out.push({
        table: o.table,
        id: o.id,
        op:
          op === "insert" || op === "update" || op === "delete" ? op : "insert",
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 列审计行，seq 倒序（新→旧）+ 真 offset 分页。
 *
 * 🔴 只读，且**不做任何链校验** —— 校验是 {@link import("./audit").verifyAuditChain}
 *    的事（页面顶部横幅调它）。列表要能翻得快，校验要从创世行整链重算，
 *    两件事混在一起会让翻页慢得没人愿意翻。
 */
export async function listAuditRows(
  opts: ListAuditOptions = {},
): Promise<AuditListResult> {
  const h = opts.handle ?? (await getCoreDb());
  const limit = clamp(opts.limit, 50);
  const offset =
    typeof opts.offset === "number" && opts.offset > 0
      ? Math.floor(opts.offset)
      : 0;

  const conds: SQL[] = [];
  if (opts.actor?.trim()) conds.push(eq(auditLog.actor, opts.actor.trim()));
  if (opts.tool?.trim()) conds.push(eq(auditLog.tool, opts.tool.trim()));
  if (opts.from?.trim()) {
    conds.push(sql`substr(${auditLog.ts}, 1, 10) >= ${opts.from.trim()}`);
  }
  if (opts.to?.trim()) {
    conds.push(sql`substr(${auditLog.ts}, 1, 10) <= ${opts.to.trim()}`);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const [rows, totalRow, actorRows, toolRows] = await Promise.all([
    h.db
      .select({
        seq: auditLog.seq,
        ts: auditLog.ts,
        actor: auditLog.actor,
        tool: auditLog.tool,
        argsDigest: auditLog.argsDigest,
        rowRefsJson: auditLog.rowRefsJson,
        prevHash: auditLog.prevHash,
        hasGate: sql<number>`CASE WHEN ${auditLog.gateResultsJson} IS NULL THEN 0 ELSE 1 END`,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.seq))
      .limit(limit)
      .offset(offset),
    h.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(auditLog)
      .where(where),
    h.db
      .selectDistinct({ actor: auditLog.actor })
      .from(auditLog)
      .orderBy(auditLog.actor),
    h.db
      .selectDistinct({ tool: auditLog.tool })
      .from(auditLog)
      .orderBy(auditLog.tool),
  ]);

  return {
    rows: rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      actor: r.actor,
      tool: r.tool,
      argsDigest: r.argsDigest,
      rowRefs: parseRowRefs(r.rowRefsJson),
      rowRefsRaw: r.rowRefsJson,
      hasGateResults: Number(r.hasGate) === 1,
      prevHash: r.prevHash,
    })),
    total: Number(totalRow[0]?.c ?? 0),
    actors: actorRows.map((a) => a.actor).filter((v): v is string => !!v),
    tools: toolRows.map((t) => t.tool).filter((v): v is string => !!v),
  };
}
