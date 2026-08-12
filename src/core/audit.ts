/**
 * core/audit.ts —— 审计哈希链（AI:PRD-001 · WP3）
 *
 * audit_log 是 append-only 的哈希链：每行的 `prev_hash` = sha256(**上一行的规范化串**)。
 * 库里另有两只无条件 RAISE 的触发器（migration 0002），开着写闸也改不动、删不掉这张表
 * ——所以「改历史」只能靠删库重建，而删库重建会被备份 + 对账抓到。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 规范化串（canonical string）口径 —— 一经首行写入 **永不变更**
 *
 *   JSON.stringify([
 *     "kb-audit/v1",     // ① 版本前缀打头：将来真要改口径，只能出 v2 并整链重算（=换库）
 *     seq,               // ② 数字，原样（INTEGER AUTOINCREMENT）
 *     ts,                // ③ 以下全是字符串或 null
 *     actor,
 *     tool,
 *     args_digest,
 *     gate_results_json,
 *     row_refs_json,
 *     prev_hash,
 *   ])
 *
 *   - 固定键序的 **数组** 形式（不是对象）：数组天然有序，不依赖任何 key 排序约定；
 *   - 缺失 / NULL 一律写 `null`（不是 ""、不是省略）；
 *   - 不做 unicode 转义、不改空白：Node 的 JSON.stringify 对同一输入是确定性的。
 *
 *   为什么口径不能变：链上每一行的 prev_hash 都是「用当时的口径」算出来的，
 *   改一个字段的位置/空值表示 = 全历史校验立刻全红，只能整链重算。
 *   ⇒ 加字段也不行（要加只能开 kb-audit/v2 + 迁移）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * hmac 列 M1 阶段 **留 NULL**：默认纯链（防误改可检测、防蓄意伪造有限，诚实标注）。
 * 要加固就把密钥放另一个 Windows 账户目录再填这列 —— 那是后置决定，不在本卡。
 */
import { createHash } from "node:crypto";

import { asc, desc, gt } from "drizzle-orm";

import { auditLog } from "~/server/db/schema";
import { getCoreDb, type CoreDbHandle, type CoreTx } from "./db";
import { nowLocalISO } from "./time";

/** 🔴 链版本；改它 = 换库 */
export const AUDIT_CHAIN_VERSION = "kb-audit/v1";

/** 创世种子：链上第一行（seq=1）的 prev_hash = sha256(本串) */
export const AUDIT_GENESIS_SEED = `${AUDIT_CHAIN_VERSION}:genesis:资料库.db`;

export type AuditActor = "agent" | "human" | "proxy" | "system";

/** 参与哈希的 audit_log 行（hmac 不进链——它是旁挂加固，不是链的一环） */
export interface AuditRow {
  seq: number;
  ts: string | null;
  actor: string | null;
  tool: string | null;
  argsDigest: string | null;
  gateResultsJson: string | null;
  rowRefsJson: string | null;
  prevHash: string | null;
}

/** 一次写动了哪些行（对账①要 json_each 它，形状不许变） */
export interface RowRef {
  table: string;
  id: string;
  op: "insert" | "update" | "delete";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 🔴 创世行的 prev_hash */
export const AUDIT_GENESIS_HASH = sha256Hex(AUDIT_GENESIS_SEED);

/** 缺失 / NULL 一律归一成 null（不是 ""、不是省略）——口径的一部分 */
function nullish(v: string | null | undefined): string | null {
  return v ?? null;
}

/** 🔴 规范化串：口径见文件头，改这个函数 = 改库 */
export function canonicalAuditString(row: AuditRow): string {
  return JSON.stringify([
    AUDIT_CHAIN_VERSION,
    row.seq,
    nullish(row.ts),
    nullish(row.actor),
    nullish(row.tool),
    nullish(row.argsDigest),
    nullish(row.gateResultsJson),
    nullish(row.rowRefsJson),
    nullish(row.prevHash),
  ]);
}

/** 下一行应当携带的 prev_hash */
export function hashOfRow(row: AuditRow): string {
  return sha256Hex(canonicalAuditString(row));
}

// ---------------------------------------------------------------------------
// 参数摘要
// ---------------------------------------------------------------------------

function normalizeForDigest(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === "function" || t === "symbol") return null;
  if (t === "bigint") return (value as bigint).toString();
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (t === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort())
      out[k] = normalizeForDigest(src[k]);
    return out;
  }
  return value;
}

/** 确定性 JSON：对象键升序、undefined→null、Date→ISO、bigint→字符串 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForDigest(value)) ?? "null";
}

/** args_digest = sha256(参数规范化 JSON)；参数正文不入库（可能很大、可能含正文） */
export function digestArgs(args: unknown): string {
  return sha256Hex(stableStringify(args));
}

/** row_refs_json：显式按 table/id/op 三键落，保证 json_each 侧口径稳定 */
export function serializeRowRefs(refs: readonly RowRef[]): string {
  return JSON.stringify(
    refs.map((r) => ({ table: r.table, id: r.id, op: r.op })),
  );
}

// ---------------------------------------------------------------------------
// 写入（单点）
// ---------------------------------------------------------------------------

export interface AppendAuditInput {
  actor: AuditActor;
  tool: string;
  argsDigest?: string | null;
  gateResultsJson?: string | null;
  rowRefsJson?: string | null;
  /** 覆盖时间戳（补录/测试用）；默认 nowLocalISO() */
  ts?: string;
}

export interface AuditReceipt {
  seq: number;
  ts: string;
  prevHash: string;
}

/**
 * 🔴 全仓唯一往 audit_log 写行的地方，且必须在调用方的事务里跑
 *    ——审计行和业务写同生共死，业务回滚了审计也不该留下。
 */
export async function appendAudit(
  tx: CoreTx,
  input: AppendAuditInput,
): Promise<AuditReceipt> {
  const tail = await tx
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

  const prevHash = tail[0] ? hashOfRow(tail[0]) : AUDIT_GENESIS_HASH;
  const ts = input.ts ?? nowLocalISO();

  const inserted = await tx
    .insert(auditLog)
    .values({
      ts,
      actor: input.actor,
      tool: input.tool,
      argsDigest: input.argsDigest ?? null,
      gateResultsJson: input.gateResultsJson ?? null,
      rowRefsJson: input.rowRefsJson ?? null,
      prevHash,
      // hmac 故意不填：M1 默认纯链
    })
    .returning({ seq: auditLog.seq });

  const seq = inserted[0]?.seq;
  if (typeof seq !== "number") {
    throw new Error(
      "appendAudit：INSERT ... RETURNING seq 没拿到序号，链写入不可信",
    );
  }
  return { seq, ts, prevHash };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface AuditChainReport {
  ok: boolean;
  /** 校验过的行数 */
  checkedRows: number;
  /** 第一处断链所在 seq（ok=true 时不出现） */
  brokenAtSeq?: number;
  /** 断链原因人话版 */
  reason?: string;
  /** 链尾 seq（空链=null） */
  headSeq: number | null;
  /** 下一行应携带的 prev_hash（空链=创世哈希） */
  nextPrevHash: string;
}

const VERIFY_PAGE = 1000;

/**
 * 从 seq 最小的一行开始顺序重算，逐行比对 prev_hash。
 * 只读；分页扫，链再长也不会把库全拉进内存。
 */
export async function verifyAuditChain(
  handle?: CoreDbHandle,
): Promise<AuditChainReport> {
  const h = handle ?? (await getCoreDb());

  let cursor = -1;
  let checkedRows = 0;
  let previous: AuditRow | null = null;
  let expected = AUDIT_GENESIS_HASH;

  for (;;) {
    const page: AuditRow[] = await h.db
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
      .where(gt(auditLog.seq, cursor))
      .orderBy(asc(auditLog.seq))
      .limit(VERIFY_PAGE);

    if (page.length === 0) break;

    for (const row of page) {
      if (row.prevHash !== expected) {
        return {
          ok: false,
          checkedRows,
          brokenAtSeq: row.seq,
          reason:
            previous === null
              ? `seq=${row.seq} 是链首，prev_hash 应为创世哈希 ${AUDIT_GENESIS_HASH}，实为 ${String(row.prevHash)}`
              : `seq=${row.seq} 的 prev_hash 对不上 seq=${previous.seq} 的规范化串哈希（期望 ${expected}，实为 ${String(row.prevHash)}）`,
          headSeq: previous?.seq ?? null,
          nextPrevHash: expected,
        };
      }
      checkedRows += 1;
      previous = row;
      expected = hashOfRow(row);
      cursor = row.seq;
    }

    if (page.length < VERIFY_PAGE) break;
  }

  return {
    ok: true,
    checkedRows,
    headSeq: previous?.seq ?? null,
    nextPrevHash: expected,
  };
}
