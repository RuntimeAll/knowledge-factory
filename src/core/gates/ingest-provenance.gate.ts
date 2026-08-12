/**
 * 闸② provenance 四型（AI:PRD-003 · 003-C）
 *
 * question 表上已经有四条 CHECK 顶着（`question_prov_*_ck`），本闸不是重复劳动 ——
 * CHECK 只会在 INSERT 那一刻抛一句 `CHECK constraint failed`，
 * 而那时候：整批已经在事务里了（一道坏题回滚 60 道好题），agent 也拿不到
 * 「你缺的是 sourceDoc 还是 page」。闸把这两件事都提前到入库前。
 *
 * 四型各缺什么：
 *   scan     批级 sourceDoc **且** 题级 prov.page（扫描件不能只说「来自某本书」）
 *   pipeline pipelineRef（脚本名@版本 + 参数摘要 —— 出了错要能重跑同一版）
 *   model    modelId 存在**且** status='active'（🔴 查库；proposed/deprecated 的模型
 *            生成的题不该进库，见 c-model.ts 注释「生成题只认 active 模型」）
 *   manual   createdBy（🔴 manual 不当无条件逃逸阀：手录也得留下是谁录的）
 */
import { type CoreDbHandle } from "../db";
import { fail, type Gate, type GateResult } from "./types";
import { type IngestItemCtx } from "./ingest-context";

export const PROV_CODES = {
  scanNoDoc: "PROV_SCAN_NO_SOURCE_DOC",
  scanNoPage: "PROV_SCAN_NO_PAGE",
  pipelineNoRef: "PROV_PIPELINE_NO_REF",
  modelNoId: "PROV_MODEL_NO_ID",
  modelNotFound: "PROV_MODEL_NOT_FOUND",
  modelNotActive: "PROV_MODEL_NOT_ACTIVE",
  manualNoCreator: "PROV_MANUAL_NO_CREATED_BY",
} as const;

async function 查模型(
  h: CoreDbHandle,
  id: string,
): Promise<{ id: string; name: string; status: string } | null> {
  const r = await h.client.execute({
    sql: "SELECT id, name, status FROM exam_model WHERE id = ?",
    args: [id],
  });
  return (
    (r.rows[0] as unknown as { id: string; name: string; status: string }) ??
    null
  );
}

/** 近似候选：模型 id 编错了，把活跃模型列几个回去（错误契约的 candidates） */
async function 活跃模型候选(h: CoreDbHandle) {
  const r = await h.client.execute(
    "SELECT id, name FROM exam_model WHERE status='active' ORDER BY id LIMIT 5",
  );
  return (r.rows as unknown as { id: string; name: string }[]).map((m) => ({
    id: m.id,
    label: m.name,
  }));
}

export const ingestProvenanceGate: Gate<IngestItemCtx> = {
  name: "②来源 provenance",
  async run(ctx: IngestItemCtx): Promise<GateResult> {
    const { prov } = ctx.item;
    const 位置 = `seq=${ctx.seq}`;

    switch (prov.type) {
      case "scan": {
        if (!ctx.batch.payload.sourceDoc) {
          return fail({
            code: PROV_CODES.scanNoDoc,
            message: `${位置} prov.type='scan' 但批级没给 sourceDoc —— 扫描件必须说清楚扫的是哪份文档（title+kind），否则这题此后无从溯源。`,
            recoverable: true,
            example: `"sourceDoc": { "title": "七上必刷题", "kind": "册子", "hash": "<文件sha256>" }`,
          });
        }
        if (prov.page === undefined) {
          return fail({
            code: PROV_CODES.scanNoPage,
            message: `${位置} prov.type='scan' 但没给 page —— 「哪份文档」还差「第几页」才叫可溯源（question.source_page_no 建表 CHECK 也要它）。`,
            recoverable: true,
            example: `"prov": { "type": "scan", "page": 37 }`,
          });
        }
        return { ok: true };
      }

      case "pipeline": {
        if (!prov.pipelineRef) {
          return fail({
            code: PROV_CODES.pipelineNoRef,
            message: `${位置} prov.type='pipeline' 但没给 pipelineRef —— 产线出的题必须留下「哪个脚本的哪一版」，否则出了系统性错误没法按批召回。`,
            recoverable: true,
            example: `"prov": { "type": "pipeline", "pipelineRef": "gen_打卡.py@2026-08-10" }`,
          });
        }
        return { ok: true };
      }

      case "model": {
        if (!prov.modelId) {
          return fail({
            code: PROV_CODES.modelNoId,
            message: `${位置} prov.type='model' 但没给 modelId —— 模型生成的题必须指明是哪个 exam_model 生的。`,
            recoverable: true,
            example: `"prov": { "type": "model", "modelId": "em_01J…" }`,
          });
        }
        const m = await 查模型(ctx.batch.handle, prov.modelId);
        if (!m) {
          return fail({
            code: PROV_CODES.modelNotFound,
            message: `${位置} modelId=${prov.modelId} 在 exam_model 里查无此行（🔴 id 一律查出来，禁编造）。`,
            recoverable: true,
            nextTool: "list_exam_models",
            candidates: await 活跃模型候选(ctx.batch.handle),
          });
        }
        if (m.status !== "active") {
          return fail({
            code: PROV_CODES.modelNotActive,
            message: `${位置} 模型「${m.name}」(${m.id}) 的 status='${m.status}'，不是 active —— proposed 是「还没转正的提议」、deprecated 是「已经下架」，两者生成的题都不该进库（见 c-model.ts：生成题只认 active 模型）。要么先把模型转正，要么换一个活跃模型。`,
            recoverable: false,
            candidates: await 活跃模型候选(ctx.batch.handle),
          });
        }
        return { ok: true };
      }

      case "manual": {
        if (!prov.createdBy) {
          return fail({
            code: PROV_CODES.manualNoCreator,
            message: `${位置} prov.type='manual' 但没给 createdBy —— 🔴 manual 不是无条件逃逸阀：手录的题同样要留下是谁录的（建表 CHECK 也拦）。`,
            recoverable: true,
            example: `"prov": { "type": "manual", "createdBy": "王老师" }`,
          });
        }
        return { ok: true };
      }
    }
  },
};

export default ingestProvenanceGate;
