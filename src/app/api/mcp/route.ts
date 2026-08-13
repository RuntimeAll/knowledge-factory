/**
 * app/api/mcp/route.ts —— MCP 壳（AI:PRD-001 · WP5）
 *
 * 同进程 Streamable HTTP：agent 连的是 `http://<host>/api/mcp`，
 * 走的还是本进程的 `~/core` —— 没有第二套逻辑、没有跨进程 DB 连接，
 * 「网站看到什么，agent 就操作什么」这句话才成立。
 *
 * ── 版本口径（mcp-handler 2.1.0，跟 1.x 差别很大，别照旧记忆写） ──────────
 *   - 签名是 `createMcpHandler(initializeServer, options?)`，返回一个
 *     web 标准的 `(Request) => Promise<Response>`；
 *   - 🔴 **没有 basePath 参数了**（1.x 的 basePath/sseEndpoint/redisUrl/
 *     sessionIdGenerator 全部移除）。「挂在哪」= 这个文件放在哪：
 *     本文件位于 `src/app/api/mcp/`，所以端点就是 `/api/mcp`，
 *     handler 自己不看 pathname；
 *   - 无 Redis、无 SSE 会话：2.x 只服务 Streamable HTTP，
 *     2026-07-28 规范原生无状态，2025 era 客户端走 SDK 的 stateless 回落。
 *     GET/DELETE 这类会话操作一律 405 —— 这是正常的，不是坏了；
 *   - 工具注册只有 `registerTool(name, config, cb)`，
 *     `inputSchema` 要一个完整的 Standard Schema（`z.object({...})`），
 *     不再吃 1.x 的裸 shape。
 *
 * 🔴 端口不写死在代码里：冒烟用 `pnpm dev -- -p 3210`，正式端口等调度中心分配。
 * 🔴 本文件只做注册；入参校验、错误契约、返回外壳全在 ./tools.ts。
 * 🔴 工具数随卡增长：001 三个系统工具 + 002 两个考点工具 + 003 三个录题工具
 *    + 004-B 两个检索工具 = 10（tests/mcp.test.ts 有一条名单断言当漂移闸）。
 * 🔴 不做鉴权（本地内网单人用；真要上外网再挂 withMcpAuth，那是另一张卡的事）。
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";

import pkg from "../../../../package.json";
import {
  backupNowInput,
  getIngestBatchInput,
  getQuestionInput,
  healthInput,
  integrityCheckInput,
  kbIngestInput,
  kpContextInput,
  payloadToText,
  proposeQuestionInput,
  resolveKpInput,
  runBackupNow,
  runGetIngestBatch,
  runGetQuestion,
  runHealth,
  runIntegrityCheck,
  runKbIngest,
  runKpContext,
  runProposeQuestion,
  runResolveKp,
  runSearchQuestions,
  searchQuestionsInput,
  type ToolPayload,
} from "./tools";

/** core 要 node:fs / @libsql/client，edge runtime 跑不了。 */
export const runtime = "nodejs";
/** 体检/对账/备份都是「此刻的事实」，任何缓存或构建期预取都是错的。 */
export const dynamic = "force-dynamic";

/**
 * 🔴 不 export：route.ts 是 Next 的**约定文件**，只允许导出 HTTP 方法与
 *    runtime/dynamic 那几个约定 key。多导出一个常量，`next build` 的路由类型闸
 *    会直接红（"Property 'SERVER_NAME' is incompatible with index signature"）——
 *    dev 不查这条，所以这坑只有 build 才炸得出来（WP6 首次 build 抓到）。
 */
const SERVER_NAME = "knowledge-factory";

/**
 * ToolPayload → MCP 的 CallToolResult。
 *
 * 🔴 isError 只在**调用没跑通**时打（payload.ok=false）。
 *    对账查出红旗是「跑通了，结论难看」，那是 `{ok:true, data:{ok:false}}`，
 *    不打 isError —— 否则 agent 会去重试工具，而不是去修数据。
 */
function toResult(payload: ToolPayload<unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: payloadToText(payload) }],
    ...(payload.ok ? {} : { isError: true }),
  };
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "health",
      {
        title: "本地体检",
        description:
          "体检本地资料库：是否可达、表数、审计链尾游标、写闸是否静息、journal_mode。" +
          "毫秒级返回；deep=true 才顺带全量重算审计链（行多会慢）。" +
          "返回 { ok, data:{ ok, url, tableCount, auditHeadSeq, auditNextPrevHash, writeGate, gateResting, journalMode, foreignKeys, busyTimeoutMs, chain? } }。",
        inputSchema: healthInput,
      },
      async (args) => toResult(await runHealth(args)),
    );

    server.registerTool(
      "integrity_check",
      {
        title: "对账六项",
        description:
          "跑完整对账 C1~C6（审计覆盖与登记对齐 / 悬挂引用 / 向量版本单一 / 圣域契约 / 挂桥覆盖率 / 活跃树唯一），全程只读。" +
          "返回 { ok, data:{ ok, generatedAt, checks:[{id,name,ok,level(red|warn),details[],stats}] } }；" +
          "🔴 data.ok=false 表示查出了 red（warn 不拦），这是一次成功的调用、只是结论难看——该去修数据，不是重试本工具。",
        inputSchema: integrityCheckInput,
      },
      async () => toResult(await runIntegrityCheck()),
    );

    server.registerTool(
      "backup_now",
      {
        title: "立刻快照备份",
        description:
          "对本地资料库做一次 VACUUM INTO 一致性快照，落到 data/backup/；配了 BACKUP_REMOTE_DIR 就再复制一份异地（没配会如实上报 skipped，不静默）。" +
          "reason 取 daily/batch/manual，默认 manual。" +
          "返回 { ok, data:{ reason, takenAt, path, bytes, tables, snapshotRowCounts:{kp,question,audit_log}, remote, remotePath?, ms } }。",
        inputSchema: backupNowInput,
      },
      async (args) => toResult(await runBackupNow(args)),
    );

    server.registerTool(
      "resolve_kp",
      {
        title: "查考点（考点唯一入口）",
        description:
          "🔴 **出题 / 录题 / 挂载考点之前先调它**——kp_id 一律 resolve 出来，禁凭印象编。" +
          "给一句人话（'绝对值' / '一元一次方程'），回候选考点列表；" +
          "支持子串模糊（'绝对值'命中'绝对值的化简'）与别名，query 短于 3 字自动退前缀/包含路。" +
          "返回 { ok, data:{ query, candidates:[{kpId,name,status,confidence(0~1),matchedVia(exact-name|exact-alias|prefix|trigram),aliasHit?,resolvedFrom?}], lowConfidence, queued, warnings } }。" +
          "🔴 lowConfidence=true（没候选或最高分<0.6）表示**别硬挑一个**：系统已自动开一张待裁工单，" +
          "该换个说法再查，或如实告诉人「这个考点词表里还没有」。",
        inputSchema: resolveKpInput,
      },
      async (args) => toResult(await runResolveKp(args)),
    );

    server.registerTool(
      "kp_context",
      {
        title: "考点卡片包",
        description:
          "取一个考点的全貌：口径卡片(cardMd) / 别名 / 它在各版本教材的章节落点 / 身上挂了多少题·考察模型·错因。" +
          "入参 kp_id 必须来自 resolve_kp。传 merged 壳会自动追链到活跃考点并在 resolvedThrough 标明。" +
          "返回 { ok, data:{ kp:{id,name,status,gradeBand,domain,topic,cardMd}, aliases[], mergedFrom?, placements:[{subject,edition,gradeSem,path:['章','节']}], counts:{questions,examModels,errorCauses}, resolvedThrough? } }。" +
          "🔴 编造的 kp_id 会回 ok:false / code=KP_NOT_FOUND，**错误体里带 candidates**（能从 id 里读出文本时）——照着改成真 id 再调。",
        inputSchema: kpContextInput,
      },
      async (args) => toResult(await runKpContext(args)),
    );

    // ── 录题三工具（AI:PRD-003 · 003-D）────────────────────────────────────

    server.registerTool(
      "kb_ingest",
      {
        title: "批量录题（唯一入口）",
        description:
          "🔴 **一切批量入题只走这里**：一次调用 = 一个 ingest_batch，全套硬闸逐题跑" +
          "（来源 provenance / 考点标全 / 题面禁指令词 / 前缀清洗 / 占位红旗 / 查重 / 可实算即实算 / 判档 / 配图分级）。" +
          "入参就是 kb-ingest/v1 的 payload（contract + source + items[]，可带 sourceDoc），外加 dry_run。" +
          "🔴 **红灯题不落库、进隔离区**（quarantine，带原样 payload + 为什么），一道坏题不连累同批好题；" +
          "题干图入库即必审（question.review_required=1 + 一张 kind='图片' 工单）。" +
          "dry_run=true 只验不写：库与磁盘零变化，拿完整逐题结论。" +
          "返回 { ok, data:{ batchId, dryRun, counts:{total,accepted,queued,rejected}, " +
          "perItem:[{seq,verdict(accepted|needs_review|rejected),questionId,reds:[{gate,code,message}]}], " +
          "questionIds, queueIds, quarantineIds, backupPath, fullReport } }。" +
          "🔴 perItem 是**逐题小结**；每题每闸的详账落在库里，用 get_ingest_batch(batch_id) 取。" +
          "🔴 kps[].ref 一律先 resolve_kp 查真考点，编 id/编名字会被闸③直接拒。",
        inputSchema: kbIngestInput,
      },
      async (args) => toResult(await runKbIngest(args)),
    );

    server.registerTool(
      "propose_question",
      {
        title: "提议一道题（提议态，人审转正）",
        description:
          "会话里零星碰到一道值得收的题 —— 走这里，**不直接入库**：先跑一遍零写预检（同一套闸），" +
          "然后开一张 kind='新题草稿' 的待审工单，人在队列页点「转正」才真入库。" +
          "🔴 预检红了照样开工单（红灯原样附在工单里，让人看着改）；只有 payload 结构错才当场退回给你。" +
          "整本书/整张卷请走 kb_ingest，别一道一道提议。" +
          "返回 { ok, data:{ queueId, seq, precheck:{ ok, verdict, reds:[{gate,code,message}], stripped, notes, " +
          "matchKey, solutionGrade, calcVerdict, lineVerdict, kpIds, primaryKpId, reviewRequired } } }。",
        inputSchema: proposeQuestionInput,
      },
      async (args) => toResult(await runProposeQuestion(args)),
    );

    server.registerTool(
      "get_ingest_batch",
      {
        title: "取一次录题批的全账",
        description:
          "按 batch_id 取批行 + **逐题逐闸全账**（gate_report_json 全量，含被剥片段、实算结论、每道闸的结果）+ 关联隔离计数。" +
          "kb_ingest 的返回只给逐题小结，要看「到底是哪道闸、原话怎么说的」就调它。" +
          "返回 { ok, data:{ id, contractVer, source, payloadHash, counts, status, createdAt, committedAt, " +
          "gateReport:{ ok, contract, items:[{seq,verdict,questionId,gates:{items:[{name,result,ms}]},failure,stripped,notes,…}], counts }, " +
          "gateReportRaw, questionIds, quarantine:{total,open,resolved,openIds} } }。" +
          "🔴 id 写错回 ok:false / code=NOT_FOUND（dry_run 不落批，所以它没有 batchId）。",
        inputSchema: getIngestBatchInput,
      },
      async (args) => toResult(await runGetIngestBatch(args)),
    );

    // ── 检索两工具（AI:PRD-004 · 004-B）──────────────────────────────────────

    server.registerTool(
      "search_questions",
      {
        title: "查题库（三路检索唯一入口）",
        description:
          "🔴 **出题 / 组卷 / 排重之前先查库**——先检索后动手，别凭印象编题，也别翻文件夹。" +
          "三条轴可任意组合：" +
          "①标签硬过滤（kpIds/difficulty/qtype/solutionGrade/editionScope/statuses/excludeQuestionIds），" +
          "②keywords 走**字面**（jieba 分词后逐词 AND；全词一条都不中会自动退成 OR 再查一次，结果标 degraded），" +
          "③semanticQuery 走**语意**（句向量近邻，能吃「含字母的绝对值怎么讨论」这种说不出关键词的问法）。" +
          "②③ 都给时按 RRF(k=60) 融合，且**只在①的候选集内**排名。" +
          "🔴 kpIds 一律先 resolve_kp 查真 id（merged 旧 id 会自动折叠到活跃落点）。" +
          "🔴 默认排除 solution_grade='no_solution'（连解析都没有的题），要看得显式传。" +
          "返回 { ok, data:{ query(参数回显), total, candidateCount, " +
          "axes:{sql:{count},fts:{active,count,degraded,op,tokens},vector:{active,count,modelVer}}, " +
          "degraded, warnings, ms, " +
          "hits:[{questionId,stemBrief,qtype,difficulty,solutionGrade,status,kps(★=主考点),rrfScore," +
          "sources:{fts?:{rank,score},vector?:{rank,score},sqlOnly?}}], fullText } }。" +
          "🔴 每条命中都带 **sources 来源标注**：哪条轴召回的、排第几——挑题时看得见理由。" +
          "🔴 hits 是**摘要**（题面截断、无答案解析）；全文用 get_question 取。" +
          "🔴 warnings 里出现「语意轴已降级」= 向量版本混杂/模型没装（对账 C3），" +
          "这次只有 FTS 在干活，结果照常可用但少一条轴——别当成没发生。",
        inputSchema: searchQuestionsInput,
      },
      async (args) => toResult(await runSearchQuestions(args)),
    );

    server.registerTool(
      "get_question",
      {
        title: "取一道题的全量卡片",
        description:
          "按 question_id 取**全文**：题面/答案/解析正本 + 考点(带主标) + 自由标签 + " +
          "配图(资产 hash 与审核态) + provenance 四型细节(scan 的源文档与页码 / model 的考察模型 / " +
          "pipeline 的产线标识 / manual 的录入人，外加录题批次) + 有没有向量。" +
          "search_questions 只给摘要，要读原文、要核出处、要看配图审没审，就调它。" +
          "返回 { ok, data:{ id, stem, answer, analysis, qtype, difficulty, solutionGrade, status, " +
          "reviewRequired, matchKey, editionScope, kps[], tags[], figures[], provenance, hasVector, createdAt, updatedAt } }。" +
          "🔴 id 写错回 ok:false / code=QUESTION_NOT_FOUND，且 **candidates 是空的**——" +
          "题 id 是纯 ULID，猜不出近似的（这点和 kp_context 不同）。照 message 说的回去调 search_questions。",
        inputSchema: getQuestionInput,
      },
      async (args) => toResult(await runGetQuestion(args)),
    );
  },
  {
    serverInfo: { name: SERVER_NAME, version: pkg.version },
  },
);

export { handler as GET, handler as POST };
