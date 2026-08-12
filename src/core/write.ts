/**
 * core/write.ts —— 唯一写入口（AI:PRD-001 · WP3）
 *
 * 库里 32 张表各挂着两只防裸写触发器：UPDATE / DELETE 只有在
 * `_write_gate.allowed = 1` 时才放行，否则 RAISE(ABORT)。开闸的只能是这里。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同一事务纪律（总指挥拍板 · 对抗核查后的闭合方案）—— 谁把它拆开谁就是事故
 *
 *   一次 core 写 = 一个事务，里面严格five步：
 *     ① UPDATE _write_gate SET allowed=1     开闸
 *     ② 业务写回调（拿到 rowRefs）
 *     ③ appendAudit(...)                     审计行与业务写同事务，🔴 每次写必留，无例外
 *     ④ UPDATE _write_gate SET allowed=0     关闸
 *     ⑤ COMMIT
 *
 *   为什么这五步必须在**同一个事务**里（这是 M1 设计里「session 上下文变量」的等价物
 *   —— SQLite 压根没有会话变量这种物理设施，只能拿事务原子性去顶）：
 *
 *   1. **崩不出敞开的闸**：任何异常/进程被杀 ⇒ 整个事务回滚 ⇒ ① 那条 UPDATE 一起没了
 *      ⇒ 闸自动回到 0。不存在「崩在开闸态、库从此裸奔」这种状态。
 *      如果把开闸做成独立事务再 COMMIT，崩在中间就真的留下一个敞开的闸。
 *   2. **开闸窗口内没人溜得进来**：SQLite 是单写者，BEGIN IMMEDIATE 一上写锁，
 *      别的连接连写事务都开不起来（只会 SQLITE_BUSY）。所以「趁你开闸我插一脚」
 *      在物理上不成立 —— 前提正是闸的开关和业务写共处一个写事务。
 *   3. **静息态恒为 0**：提交后闸必然是 0（④ 在 ⑤ 之前）；裸连接任何时候连上来读到的
 *      都是 0，UPDATE/DELETE 一律被拒。
 *   4. **审计不可能漏**：③ 和业务写同生共死。业务写成功而审计失败 ⇒ 一起回滚；
 *      不存在「改了库但查不到是谁改的」。
 *
 *   ⛔ 反面教材（一条都不许）：
 *      - 把 ① 单独 COMMIT 再开第二个事务写业务；
 *      - 事务里用 handle.client.execute（那是**另一条连接**，见 db.ts §连接漂移）；
 *      - 业务写完再「顺手」在事务外补审计。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";

import {
  appendAudit,
  digestArgs,
  serializeRowRefs,
  type AuditActor,
  type RowRef,
} from "./audit";
import { armConnection, getCoreDb, type CoreDbHandle, type CoreTx } from "./db";
import { gateReportToJson, type GateReport } from "./gates";

export type { RowRef } from "./audit";

export interface CoreWriteMeta {
  /** 谁在写：agent=模型自主 / human=人点的 / proxy=代人执行 / system=定时任务 */
  actor: AuditActor;
  /** 工具名（MCP 工具名或 core 函数名），审计里靠它归类 */
  tool: string;
  /** 入参正文：只取 sha256 摘要入库，正文不落 audit_log */
  args?: unknown;
  /** 过闸账本；有闸就传，整份序列化进 gate_results_json */
  gateReport?: GateReport | null;
}

/**
 * 业务写回调：拿到事务句柄，写完把「动了哪些行」报回来。
 * 🔴 回调里只准用 tx，不准碰 handle.client / getCoreDb()。
 * 🔴 rowRefs 不是可选的礼节 —— 对账①靠 json_each 它来找孤儿行。
 */
export type CoreWriteBody = (tx: CoreTx) => Promise<RowRef[]>;

export interface CoreWriteReceipt {
  /** 本次写对应的审计行序号 */
  seq: number;
  ts: string;
  prevHash: string;
  rowRefs: RowRef[];
}

/**
 * 全仓唯一的写入口。
 *
 * ```ts
 * const receipt = await withCoreWrite(
 *   { actor: "agent", tool: "upsert_roster", args: { code } },
 *   async (tx) => {
 *     await tx.insert(roster).values({ code, alias, status: "active" });
 *     return [{ table: "roster", id: code, op: "insert" }];
 *   },
 * );
 * ```
 */
export async function withCoreWrite(
  meta: CoreWriteMeta,
  body: CoreWriteBody,
  handle?: CoreDbHandle,
): Promise<CoreWriteReceipt> {
  const h = handle ?? (await getCoreDb());

  // 串行化：「武装连接 → 开事务」这两步之间不能被另一笔写插进去换掉连接
  return h.serialize(async () => {
    // 🔴 外键是每连接生效的，而 transaction() 会换连接 ⇒ 每次开事务前重新武装
    await armConnection(h);

    // drizzle 的 libsql transaction() 走 client.transaction()，默认 mode="write"
    // ⇒ BEGIN IMMEDIATE（立刻拿写锁）。回调抛错 ⇒ 自动 ROLLBACK 并原样上抛。
    return h.db.transaction(async (tx) => {
      // ① 开闸
      await tx.run(sql`UPDATE _write_gate SET allowed = 1 WHERE id = 1`);

      // ② 业务写
      const rowRefs = await body(tx);

      // ③ 审计行（同事务，无例外）
      const receipt = await appendAudit(tx, {
        actor: meta.actor,
        tool: meta.tool,
        argsDigest: digestArgs(meta.args ?? null),
        gateResultsJson: gateReportToJson(meta.gateReport),
        rowRefsJson: serializeRowRefs(rowRefs),
      });

      // ④ 关闸（⑤ COMMIT 由 drizzle 在回调正常返回后发出）
      await tx.run(sql`UPDATE _write_gate SET allowed = 0 WHERE id = 1`);

      return { ...receipt, rowRefs };
    });
  });
}

/** 读一眼静息闸状态（对账/health 用；正常永远是 0） */
export async function readWriteGate(handle?: CoreDbHandle): Promise<number> {
  const h = handle ?? (await getCoreDb());
  const r = await h.client.execute(
    "SELECT allowed FROM _write_gate WHERE id=1",
  );
  const row = r.rows[0] as unknown as { allowed: number } | undefined;
  return row ? Number(row.allowed) : -1;
}
