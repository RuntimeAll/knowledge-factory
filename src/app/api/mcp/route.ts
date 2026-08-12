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
 * 🔴 不做鉴权（本地内网单人用；真要上外网再挂 withMcpAuth，那是另一张卡的事）。
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMcpHandler } from "mcp-handler";

import pkg from "../../../../package.json";
import {
  backupNowInput,
  healthInput,
  integrityCheckInput,
  payloadToText,
  runBackupNow,
  runHealth,
  runIntegrityCheck,
  type ToolPayload,
} from "./tools";

/** core 要 node:fs / @libsql/client，edge runtime 跑不了。 */
export const runtime = "nodejs";
/** 体检/对账/备份都是「此刻的事实」，任何缓存或构建期预取都是错的。 */
export const dynamic = "force-dynamic";

export const SERVER_NAME = "knowledge-factory";

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
  },
  {
    serverInfo: { name: SERVER_NAME, version: pkg.version },
  },
);

export { handler as GET, handler as POST };
