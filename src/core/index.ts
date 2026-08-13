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
 *   kgview.ts  KG 治理页读侧（总览统计 / 树全貌 / 引用计数 · AI:PRD-002）
 *   queue.ts   审查队列（列工单 / 裁决 / 补别名结案 · AI:PRD-002）
 *   sidecar.ts Python 侧车封装（sympy 实算专职 · AI:PRD-003；分词已于 004-A 移交 node）
 *   segment.ts 🔴 分词统一层（@node-rs/jieba + 数学专名词典 · AI:PRD-004 004-A）
 *   embed.ts   本地 ONNX 句向量（bge-small-zh-v1.5 · AI:PRD-004 004-A）
 *   vec.ts     向量序列化 + 余弦近邻暴力扫描（AI:PRD-004 004-A）
 *   fts.ts     question_fts 写侧投影 + 查询串构造（方案甲 · AI:PRD-003）
 *   ingest-schema.ts kb-ingest/v1 契约的机读正本（zod · AI:PRD-003）
 *   ingest.ts  录题管道 runIngestBatch（两相：零写相 + 单事务相 · AI:PRD-003）
 *   review.ts  审查队列三条处置链（图片审 / 草稿转正 / 隔离改判 · AI:PRD-003 003-D）
 *   assets.ts  资产读侧（hash → 登记行 + 落地路径 + Content-Type · AI:PRD-003 003-D）
 *   gates/     闸（骨架来自 001；十道录题闸在 AI:PRD-003 落地，逐闸一文件）
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
  kgOverview,
  kpRefCounts,
  listEditionTrees,
  treeOutline,
  type KgOverview,
  type KgViewOptions,
  type TreeNodeView,
  type TreeOutline,
  type TreeSummary,
} from "./kgview";

export {
  QUEUE_ERROR_CODES,
  QUEUE_KINDS,
  QUEUE_STATES,
  QueueError,
  countOpenQueueByKind,
  getQueueItem,
  listQueueItems,
  passQueueWithAlias,
  verdictQueueItem,
  type ListQueueOptions,
  type PassWithAliasInput,
  type PassWithAliasResult,
  type QueueErrorCode,
  type QueueItem,
  type QueueKind,
  type QueueState,
  type QueueVerdict,
  type QueueVerdictResult,
  type VerdictOptions,
} from "./queue";

export {
  SIDECAR_ERROR_CODES,
  SIDECAR_TIMEOUT_MS,
  SidecarError,
  calcVerify,
  lineVerify,
  pingSidecar,
  segmentText,
  segmentTexts,
  sidecarDir,
  sidecarPythonPath,
  sidecarStatus,
  type CalcVerdict,
  type CalcVerifyDetail,
  type CalcVerifyItem,
  type CalcVerifyResult,
  type LineVerifyBadLine,
  type LineVerifyItem,
  type LineVerifyResult,
  type LineVerifyVerdict,
  type SegmentInput,
  type SegmentMode,
  type SegmentOptions,
  type SegmentResult,
  type SidecarErrorCode,
  type SidecarOptions,
  type SidecarPing,
} from "./sidecar";

export {
  ftsQuery,
  writeQuestionFts,
  type FtsQueryOptions,
  type FtsQueryPlan,
  type QuestionFtsInput,
} from "./fts";

// ── AI:PRD-004 · 004-A 分词统一层 ───────────────────────────────────────────
//
// 🔴 全产品只有这一处分词。sidecar 的 segmentTexts 还在（上面那组导出），
//    但**只作为新旧口径对照的参照物**，业务路径一个字都别调它。
export {
  DICT_REL_PATH,
  deLatex,
  dictInfo,
  dictPath,
  loadDict,
  resetDict,
  segExact,
  segFeed,
  segSearch,
  segSearchBaseOnly,
  segSearchString,
  stripHtmlForSeg,
  type DictInfo,
} from "./segment";

// ── AI:PRD-004 · 004-A 语义轴底座 ───────────────────────────────────────────
export {
  EMBED_BATCH,
  EMBED_DIM,
  EMBED_ERROR_CODES,
  EMBED_MAX_TOKENS,
  EMBED_MODEL_ID,
  EmbedError,
  MODEL_FILES,
  MODEL_REL_DIR,
  embedFeed,
  embedModelVer,
  embedStatus,
  embedText,
  embedTexts,
  loadEmbedder,
  modelDir,
  resetEmbedder,
  type EmbedErrorCode,
  type EmbedOptions,
  type EmbedStatus,
} from "./embed";

export {
  VEC_ERROR_CODES,
  VecError,
  blobToFloat32,
  cosine,
  cosineTopK,
  dot,
  float32ToBlob,
  invalidateVecIndex,
  l2Normalize,
  loadVecIndex,
  type CosineTopKOptions,
  type VecErrorCode,
  type VecHit,
  type VecIndex,
} from "./vec";

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

// ── AI:PRD-003 · 录题 ───────────────────────────────────────────────────────

export {
  FIGURE_ROLES,
  KB_INGEST_CONTRACT,
  PROV_TYPES,
  QTYPES,
  SOLUTION_GRADES,
  SOURCE_DOC_KINDS,
  figureSchema,
  ingestItemSchema,
  ingestPayloadSchema,
  kpRefSchema,
  proposeItemSchema,
  provSchema,
  punchPosSchema,
  sourceDocSchema,
  type FigureRole,
  type KbIngestFigure,
  type KbIngestItem,
  type KbIngestKpRef,
  type KbIngestPayload,
  type KbIngestProv,
  type KbIngestSourceDoc,
  type KbProposeItem,
  type ProvType,
  type QType,
  type SolutionGrade,
  type SourceDocKind,
} from "./ingest-schema";

export {
  INGEST_ERROR_CODES,
  ITEM_GATES,
  IngestError,
  getIngestBatch,
  punchPosTag,
  runIngestBatch,
  type IngestBatchRecord,
  type IngestCounts,
  type IngestGateReport,
  type IngestItemReport,
  type IngestResult,
  type RunIngestOptions,
} from "./ingest";

// ── AI:PRD-003 · 003-D 审查队列处置 ─────────────────────────────────────────

export {
  getDraftCard,
  getFigureReviewCard,
  getQuarantineRow,
  itemReds,
  listQuarantine,
  passFigureReview,
  precheckOf,
  promoteDraftQuestion,
  proposeQuestion,
  rejectFigureReview,
  resolveQuarantine,
  type DraftCard,
  type DraftPayload,
  type FigureReviewCard,
  type FigureReviewOptions,
  type FigureReviewResult,
  type FigureView,
  type ListQuarantineOptions,
  type PrecheckRed,
  type PrecheckSummary,
  type PromoteDraftOptions,
  type PromoteDraftResult,
  type ProposeQuestionInput,
  type ProposeQuestionResult,
  type QuarantineRow,
  type ResolveQuarantineOptions,
  type ResolveQuarantineResult,
} from "./review";

export {
  ASSET_CONTENT_TYPES,
  ASSET_FALLBACK_CONTENT_TYPE,
  assetContentType,
  getAssetByHash,
  type AssetReadOptions,
  type AssetRecord,
} from "./assets";

/**
 * 十道录题闸的公共面（逐闸一文件，`gates/ingest-*.gate.ts`）。
 * 🔴 这里只导出**纯函数与错误码**：闸对象本身由管道串（ITEM_GATES），
 *    外面不该自己挑几道闸跑一遍就说「过闸了」。
 */
export {
  INGEST_CONTRACT_CODE,
  checkContract,
  type ContractCheck,
} from "./gates/ingest-contract.gate";
export { PROV_CODES } from "./gates/ingest-provenance.gate";
export { EXACT_CONFIDENCE, KP_CODES } from "./gates/ingest-kp.gate";
export {
  BARE_INSTRUCTIONS,
  INSTRUCTION_CODES,
  META_WORDS,
  findMetaWords,
  stripLeadInstruction,
  type StripResult,
} from "./gates/ingest-instruction.gate";
export {
  PREFIX_CODES,
  cleanStemPrefix,
  prefixResidue,
  type CleanResult,
} from "./gates/ingest-prefix.gate";
export {
  PLACEHOLDER_CODES,
  declaresFigure,
  internalMarkerIn,
  isPurePlaceholder,
} from "./gates/ingest-placeholder.gate";
export {
  DEDUP_CODES,
  matchKeyOf,
  normalizeStem,
} from "./gates/ingest-dedup.gate";
export {
  CALC_CODES,
  isCalcCandidate,
  isLineVerifyCandidate,
  looksLikePureExpression,
} from "./gates/ingest-calc.gate";
export {
  GRADE_CODES,
  decideSolutionGrade,
} from "./gates/ingest-solution-grade.gate";
export {
  FIGURE_CODES,
  assetFileName,
  planFigure,
} from "./gates/ingest-figure.gate";
export {
  emptyDerived,
  type FigurePlan,
  type IngestBatchCtx,
  type IngestItemCtx,
  type ItemDerived,
  type KpBinding,
} from "./gates/ingest-context";
