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
 *   kg.ts      KG 写原语（考点/别名/版本树/映射/merge_kp/批量导底 · AI:PRD-002）
 *   resolve.ts 考点解析读侧（resolve_kp 打分 + kp_context 卡片包 · AI:PRD-002）
 *   gates/     闸骨架（真闸从 AI:PRD-003 起长）
 *   backup.ts  VACUUM INTO 快照（+异地副本）
 *   grading.ts 🔴 圣域 审核.db **只读**连接（三道锁，见文件头）
 *   integrity.ts 对账六项 C1~C6
 *   status.ts  页面读侧（最近一次对账摘要 + 红旗条显示态纯函数）
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
  ID_PREFIX_TABLE,
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
  BACKUP_REASONS,
  backupDirFor,
  backupNow,
  dbUrlToPath,
  listBackups,
  type BackupReason,
  type BackupResult,
  type BackupRowCounts,
  type BackupSnapshotInfo,
} from "./backup";

export {
  GRADING_HASH_RECIPE,
  GRADING_RO_MARKER,
  assertGradingUrl,
  assertReadOnlyStatement,
  closeGradingDb,
  describeDbPath,
  fileUrlToPath,
  getGradingDb,
  gradingSchemaHash,
  gradingSchemaSnapshot,
  normalizeDdl,
  type GradingDbHandle,
  type GradingSchemaSnapshot,
  type GradingTableDdl,
} from "./grading";

export {
  AUDITED_TABLES,
  GRADING_SNAPSHOT_FILE,
  ROW_KEY_SEP,
  assetsDirFor,
  integrityCheck,
  normalizeAssetPath,
  rowRefId,
  type CheckId,
  type CheckLevel,
  type CheckResult,
  type IntegrityOptions,
  type IntegrityReport,
} from "./integrity";

export {
  INTEGRITY_METRIC_KIND,
  getLatestIntegritySummary,
  parseIntegritySummary,
  redFlagView,
  type IntegrityCheckItem,
  type IntegritySummary,
  type RedFlagState,
  type RedFlagView,
} from "./status";

export {
  KG_ERROR_CODES,
  KgError,
  MERGE_CHAIN_MAX_HOPS,
  addEditionNode,
  addEditionNodeInput,
  addKpAlias,
  createEditionTree,
  createEditionTreeInput,
  createKp,
  createKpInput,
  importKgBatch,
  importKgBatchInput,
  mapNodeKp,
  mergeKp,
  removeKpAlias,
  renameKp,
  resolveMergedKp,
  retireKp,
  setTreeStatus,
  unmapNodeKp,
  updateKpCard,
  type AddEditionNodeInput,
  type AliasAddResult,
  type CreateEditionTreeInput,
  type CreateKpInput,
  type ImportKgBatchInput,
  type ImportKgBatchResult,
  type KgErrorCode,
  type KgOptions,
  type KgReceipt,
  type KpRefCounts,
  type KpWriteResult,
  type MapResult,
  type MergeKpResult,
  type NodeWriteResult,
  type ResolvedKp,
  type RetireKpResult,
  type TreeWriteResult,
} from "./kg";

export {
  LOW_CONFIDENCE_AT,
  LOW_CONFIDENCE_KIND,
  TRIGRAM_MIN_CHARS,
  KpNotFoundError,
  ftsStringLiteral,
  kpContext,
  resolveKp,
  type KpCandidate,
  type KpContextCard,
  type KpContextOptions,
  type KpPlacement,
  type MatchedVia,
  type ResolveKpOptions,
  type ResolveKpResult,
} from "./resolve";

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
