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
 *   retrieval.ts 🔴 三路检索唯一入口（SQL 硬过滤 → FTS+向量召回 → RRF k=60）
 *                + getQuestion / findSimilarQuestions / checkDuplicate（004-B）
 *                + kpAutoResolve 关键词落靶考点（004-C）
 *   fts.ts     question_fts 写侧投影 + 查询串构造（方案甲 · AI:PRD-003）
 *   ingest-schema.ts kb-ingest/v1 契约的机读正本（zod · AI:PRD-003）
 *   ingest.ts  录题管道 runIngestBatch（两相：零写相 + 单事务相 · AI:PRD-003）
 *   review.ts  审查队列三条处置链（图片审 / 草稿转正 / 隔离改判 · AI:PRD-003 003-D）
 *   assets.ts  资产读侧（hash → 登记行 + 落地路径 + Content-Type · AI:PRD-003 003-D）
 *   convert-punch.ts 产线出料 → kb-ingest/v1 转换器（纯函数 · AI:PRD-005 005-B）
 *   dedup.ts   出册前置闸 assertNoSoldDuplicates（撞了带出是哪本册子 · AI:PRD-005）
 *   sku.ts     SKU 登记原语（建册/装题/登记产出/改态 + 通向圣域的两座桥 · AI:PRD-005）
 *   model.ts   考察模型 提议/转正/驳回（exam_model + kind='模型转正' 工单 · AI:PRD-005）
 *              + 血缘上游 setModelOrigins / 变式族谱 getLineage（005-D）
 *   gates/     闸（骨架来自 001；十道录题闸在 AI:PRD-003 落地，逐闸一文件）
 *   backup.ts  VACUUM INTO 快照（+异地副本）
 *   grading.ts 🔴 圣域 审核.db **只读**连接（三道锁，见文件头）
 *   cause.ts   错因域写原语（error_cause/kp_error/cause_example/err_code_map/roster · AI:PRD-006）
 *   gradebridge.ts 🔴 学情挂桥读侧（**零写**）：公共桥 bridgeBatches +
 *                  群错误率 / 已做题集 / 错因分布 / 学情数据包（AI:PRD-006 · 006-B）
 *   integrity.ts 对账六项 C1~C6（C5 的桥已改调 gradebridge，全产品一份桥）
 *   status.ts  页面读侧（最近一次对账摘要 + 红旗条显示态纯函数）
 *   monitor.ts 系统监控读侧（录入批次台账 / 审计行列表 · AI:PRD-008 P3，零写）
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
  REGRESSION_METRIC_KIND,
  getLatestIntegritySummary,
  getLatestRegressionSummary,
  parseIntegritySummary,
  parseRegressionSummary,
  redFlagView,
  type IntegrityCheckItem,
  type IntegritySummary,
  type RedFlagState,
  type RedFlagView,
  type RegressionGateResult,
  type RegressionSummary,
} from "./status";

// ── AI:PRD-008 · P3 系统监控三页的只读列侧（🔴 全程零写，不产生审计行） ────────
export {
  listAuditRows,
  listIngestBatches,
  type AuditListResult,
  type AuditRowView,
  type IngestBatchBrief,
  type ListAuditOptions,
  type ListIngestBatchesOptions,
} from "./monitor";

// ── AI:PRD-009 · D-B 资料货架（punch 库只读挂载）────────────────────────────
// 🔴🔴 同名异库：punch 库 = `举一反三产物/资料库.db`，**不是**本库 data/资料库.db。
//      物理只读（三道锁见 core/punch.ts），两库绝不互写。
export {
  PUNCH_FILE_MAX_BYTES,
  PUNCH_FILE_MIME,
  PUNCH_RO_MARKER,
  SHELF_DOC_TYPES,
  SHELF_LANES,
  assertPunchUrl,
  closePunchDb,
  getPunchDb,
  getShelfDoc,
  grantPunchFile,
  gradeSplitWarnings,
  listShelfDocs,
  punchAssetRoot,
  shelfChecksOf,
  shelfLaneOf,
  shelfSeqOf,
  type PunchDbHandle,
  type PunchFileDeny,
  type PunchFileGrant,
  type ShelfAsset,
  type ShelfCheck,
  type ShelfCheckState,
  type ShelfDocDetail,
  type ShelfDocRow,
  type ShelfDocType,
  type ShelfFacet,
  type ShelfFacets,
  type ShelfLane,
  type ShelfListOptions,
  type ShelfListResult,
  type ShelfMaterial,
  type ShelfMemberLink,
  type ShelfPublishLog,
} from "./punch";

// 两库对账（🔴 差异只报不改，零写）
export {
  bookKey,
  linkKey,
  netdiskOfRecipe,
  pathKey,
  reconcileShelf,
  srcOfGateJson,
  type BookMatchRow,
  type FileMatchRow,
  type NetdiskRow,
  type ShelfReconcileReport,
} from "./shelf-reconcile";

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
  KNN_CONF_MAX,
  KNN_CONF_MIN,
  KNN_MIN_COS,
  KNN_TOP_QUESTIONS,
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
  vecAxisStatus,
  type CosineTopKOptions,
  type VecAxisStatus,
  type VecErrorCode,
  type VecHit,
  type VecIndex,
} from "./vec";

// ── AI:PRD-004 · 004-B 三路检索管线 ─────────────────────────────────────────
//
// 🔴 检索只有这一个入口：MCP 的 search_questions 与题库检索页（004-C）
//    调的是同一个 searchQuestions。页面一套、工具一套 = 两套口径，
//    而「页面看得见的题 agent 查不到」是最难查的一类故障。
export {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SOLUTION_GRADES,
  DEFAULT_STATUSES,
  FTS_SCAN_CAP,
  QUESTION_STATUSES,
  RETRIEVAL_ERROR_CODES,
  RRF_K,
  STEM_BRIEF_CHARS,
  RetrievalError,
  checkDuplicate,
  findSimilarQuestions,
  getQuestion,
  rrfFuse,
  searchParamsSchema,
  searchQuestions,
  stemBrief,
  type AxisHit,
  type CheckDuplicateOptions,
  type DuplicateExactHit,
  type DuplicateResult,
  type FusedRow,
  type GetQuestionOptions,
  type HitSources,
  type KpAutoResolved,
  type KpAxisHit,
  type QuestionCard,
  type QuestionFigureView,
  type QuestionKpBrief,
  type QuestionProvenance,
  type RetrievalErrorCode,
  type SearchAxes,
  type SearchHit,
  type SearchOptions,
  type SearchParams,
  type SearchResult,
  type SimilarHit,
  type SimilarOptions,
  type SimilarResult,
} from "./retrieval";

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

// ── AI:PRD-005 · 005-B 产线接入 ─────────────────────────────────────────────
//
// 🔴 转换器（产线出料 → kb-ingest/v1）是**纯函数**：不碰库、不写盘。
//    它的产物还要走 runIngestBatch 的十道闸 —— 转换只负责把料摆成闸看得懂的样子。
export {
  CONVERT_ERROR_CODES,
  ConvertError,
  PUNCH_CONTRACT,
  PUNCH_FORMS,
  convertPunchIngest,
  detectPunchForm,
  type ConvertFailure,
  type ConvertOptions,
  type ConvertResult,
  type ConvertSkip,
  type ConvertedUnit,
  type ConvertErrorCode,
  type PunchForm,
  type UnknownField,
} from "./convert-punch";

/**
 * 出册前置闸：这批题**是不是已经卖过了**（撞了带出是哪本册子）。
 * 🔴 与录题闸⑦查重不同的是**归因**：闸⑦说「撞了 q_01KZ…」，这里说「撞了《绝对值突破》第 37 题，在售」。
 */
export {
  SIMILAR_REPORT_AT,
  assertNoSoldDuplicates,
  matchKeyOfStem,
  type AssertSoldOptions,
  type DupHit,
  type SkuOwner,
  type SoldCollision,
  type SoldDupItem,
  type SoldDupResult,
  type SoldSimilar,
} from "./dedup";

export {
  SKU_ERROR_CODES,
  SKU_OUTPUT_KINDS,
  SKU_STATUSES,
  SKU_TYPES,
  SkuError,
  addSkuItems,
  getSku,
  linkGradingBatch,
  listSkus,
  listSkusOfQuestion,
  mapGradingTask,
  registerSku,
  registerSkuOutput,
  setSkuStatus,
  type AddSkuItemsResult,
  type LinkGradingBatchResult,
  type ListSkusOptions,
  type MapGradingTaskResult,
  type QuestionSkuPlacement,
  type RegisterSkuInput,
  type RegisterSkuOutputInput,
  type RegisterSkuOutputResult,
  type RegisterSkuResult,
  type SetSkuStatusResult,
  type SkuBrief,
  type SkuCard,
  type SkuErrorCode,
  type SkuItemInput,
  type SkuItemView,
  type SkuOutputKind,
  type SkuOutputView,
  type SkuStatus,
  type SkuType,
} from "./sku";

// ── AI:PRD-006 · 006-B 错因域 ───────────────────────────────────────────────
//
// 🔴 err_code_map 是**复合键 (kp_id, err_code)**：同一个产线码在不同考点下是
//    不同的错因实体（dist 在混合运算线=运算律简算，在整式线=去括号/合并同类项，
//    006 备料 §四有交付级实证）。单键表会把两种能力并成一个数。
export {
  CAUSE_ERROR_CODES,
  CAUSE_EXAMPLE_MIN,
  CAUSE_STATUSES,
  CauseError,
  ROSTER_STATUSES,
  addCauseExample,
  createErrorCause,
  getCause,
  listCauses,
  listRoster,
  mapErrCode,
  mapKpError,
  retireCause,
  unmapErrCode,
  unmapKpError,
  upsertRoster,
  type AddCauseExampleResult,
  type CauseBrief,
  type CauseCard,
  type CauseErrorCode,
  type CauseStatus,
  type CreateErrorCauseInput,
  type CreateErrorCauseResult,
  type KpErrorResult,
  type ListCausesOptions,
  type MapErrCodeResult,
  type RetireCauseResult,
  type RosterStatus,
  type UpsertRosterInput,
  type UpsertRosterResult,
} from "./cause";

// ── AI:PRD-006 · 006-B 学情挂桥读侧（🔴 全程零写） ──────────────────────────
//
// 🔴 桥只有这一份实现（对账 C5 也调它）。桥键 = slots(student, day)，
//    绝不是 batches.task_id（死列）。所有对外统计一律带 matched/total 覆盖口径。
export {
  COPY_REMINDER_MARKERS,
  RATE_RUBRIC,
  VERDICT_OK,
  VERDICT_SKIP,
  VERDICT_WRONG,
  bridgeBatches,
  bridgedItems,
  causeDistribution,
  getStudentView,
  isCopyReminderNote,
  kpGroupErrorRate,
  studentDoneSet,
  type BridgeOptions,
  type BridgeReport,
  type BridgeTask,
  type BridgedBatch,
  type BridgedItem,
  type BridgedItemKp,
  type BridgedItemsResult,
  type CauseDistRow,
  type CauseDistributionResult,
  type CauseForm,
  type CoverageView,
  type FormBucket,
  type KpErrorRateRow,
  type KpGroupErrorRateResult,
  type StudentBatchView,
  type StudentDoneSetResult,
  type StudentKpRow,
  type StudentViewResult,
  type UnmappedCode,
} from "./gradebridge";

export {
  MODEL_ERROR_CODES,
  MODEL_QUEUE_KIND,
  MODEL_STATUSES,
  ModelError,
  activateModel,
  getLineage,
  getModel,
  listModels,
  proposeModel,
  rejectModel,
  resolveKpRef,
  setModelOrigins,
  type LineageModel,
  type LineageOptions,
  type LineageQuestion,
  type LineageView,
  type ListModelsOptions,
  type ModelBrief,
  type ModelCard,
  type ModelErrorCode,
  type ModelStatus,
  type ModelVerdictResult,
  type ProposeModelInput,
  type ProposeModelResult,
  type ResolvedKpRef,
  type SetModelOriginsResult,
} from "./model";

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
