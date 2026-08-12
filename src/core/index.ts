/**
 * core/ —— 🔴 唯一业务层，也是唯一公共出口（AI:PRD-001 · WP3）
 *
 * 外界（`src/app/**`、MCP 路由、`scripts/**`、页面 RSC）**只准从 `~/core` 进**：
 *   - 不许直接 import `drizzle-orm` / `@libsql/client` / `~/server/db`
 *     （ESLint no-restricted-imports 已把这条做成红灯，见 eslint.config.js）；
 *   - 也不许深挖 `~/core/xxx` 子模块 —— 要用什么就从这里 re-export 出去。
 *
 * 为什么非要一个窄口子：写路径全在 core 才谈得上「每次写都留审计行、都过闸、都关得上闸」。
 * 一旦页面能自己拿 db 写一行，审计链就有洞，而链有洞 = 整套「可对账」的说法作废。
 *
 * 目录：
 *   db.ts      连接工厂（PRAGMA / 写队列 / 单例）
 *   ids.ts     前缀+ULID 主键
 *   time.ts    本地 ISO 时间戳口径
 *   audit.ts   审计哈希链（规范化串口径 + 单点写 + 校验）
 *   write.ts   withCoreWrite —— 唯一写入口（开闸/业务写/审计/关闸 同一事务）
 *   health.ts  本地体检
 *   metrics.ts metric_event 打点
 *   gates/     闸骨架（真闸从 AI:PRD-003 起长）
 */

export {
  BUSY_TIMEOUT_MS,
  armConnection,
  closeCoreDb,
  createCoreDb,
  getCoreDb,
  type CoreDb,
  type CoreDbHandle,
  type CoreTx,
} from "./db";

export {
  ID_PREFIXES,
  ID_RE,
  isId,
  newId,
  parseIdPrefix,
  type IdPrefix,
} from "./ids";

export { LOCAL_ISO_RE, isLocalISO, nowLocalISO } from "./time";

export {
  AUDIT_CHAIN_VERSION,
  AUDIT_GENESIS_HASH,
  AUDIT_GENESIS_SEED,
  appendAudit,
  canonicalAuditString,
  digestArgs,
  hashOfRow,
  serializeRowRefs,
  sha256Hex,
  stableStringify,
  verifyAuditChain,
  type AppendAuditInput,
  type AuditActor,
  type AuditChainReport,
  type AuditReceipt,
  type AuditRow,
  type RowRef,
} from "./audit";

export {
  readWriteGate,
  withCoreWrite,
  type CoreWriteBody,
  type CoreWriteMeta,
  type CoreWriteReceipt,
} from "./write";

export { health, type HealthOptions, type HealthReport } from "./health";

export { logMetric, type MetricReceipt } from "./metrics";

export {
  PASS,
  fail,
  gateReportToJson,
  isFail,
  pass,
  runGates,
  type Gate,
  type GateCandidate,
  type GateFail,
  type GateItem,
  type GateOk,
  type GateReport,
  type GateResult,
  type RunGatesOptions,
} from "./gates";
