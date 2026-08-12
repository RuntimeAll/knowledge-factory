/**
 * 闸① 契约（AI:PRD-003 · 003-C）—— kb-ingest/v1 的 zod 校验
 *
 * 🔴 **结构错 = 整批拒，不进逐题。** 理由：形状读不出来的时候，「第几题坏了」
 *    这个问题本身就没有答案（items 可能压根不是数组）。逐题闸拿不到题，
 *    硬跑只会产出一份「全批红」的假账。
 *
 * 🔴 对照 punch-ingest/v1：那边的契约校验是 `p.契约 !== INGEST_CONTRACT →
 *    console.log 跳过` —— 不报错、不退出、当次入库静默少一册。本闸是它的反面：
 *    认不出的契约、缺字段、批内 seq 撞车，一律红灯 + 人话 + 「怎么改」。
 */
import { z } from "zod";

import {
  ingestPayloadSchema,
  KB_INGEST_CONTRACT,
  type KbIngestPayload,
} from "../ingest-schema";
import { fail, type Gate, type GateResult } from "./types";

export const INGEST_CONTRACT_CODE = "INGEST_CONTRACT_INVALID";

/** 校验结果：过了给 payload，没过给错误契约（调用方决定是抛还是记账） */
export type ContractCheck =
  | { ok: true; payload: KbIngestPayload }
  | { ok: false; result: GateResult & { ok: false } };

const 示例 = JSON.stringify(
  {
    contract: KB_INGEST_CONTRACT,
    source: "每日打卡@2026-08-12",
    sourceDoc: { title: "七上绝对值压轴突破", kind: "册子" },
    items: [
      {
        seq: 1,
        stem: "$3+5\\times 2$",
        answer: "13",
        qtype: "计算",
        kps: [{ ref: "有理数的乘方", isPrimary: true }],
        prov: { type: "pipeline", pipelineRef: "gen_打卡.py@2026-08-10" },
      },
    ],
  },
  null,
  0,
);

/** 纯校验（无 IO）：raw → payload 或错误契约 */
export function checkContract(raw: unknown): ContractCheck {
  const r = ingestPayloadSchema.safeParse(raw);
  if (r.success) return { ok: true, payload: r.data };
  return {
    ok: false,
    result: fail({
      code: INGEST_CONTRACT_CODE,
      message: `kb-ingest/v1 契约没过（结构错 = 整批拒，一道题都不入库）：\n${z.prettifyError(r.error)}`,
      // 结构是喂料方自己拼的，改 payload 就能过 ⇒ 可恢复
      recoverable: true,
      example: 示例,
    }),
  };
}

export const ingestContractGate: Gate<unknown> = {
  name: "①契约 kb-ingest/v1",
  run(raw: unknown): GateResult {
    const r = checkContract(raw);
    return r.ok ? { ok: true } : r.result;
  },
};

export default ingestContractGate;
