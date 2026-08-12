/**
 * core/gates/index.ts —— 串闸执行器（AI:PRD-001 · WP3 骨架）
 *
 * 🔴 默认「跑完全部再判」而不是「见红就停」：一次入库要让 agent 看见 **全部** 问题，
 *    否则它改一条重试一次，来回十趟。要急停（比如后面的闸依赖前面闸的前提）
 *    才显式传 stopOnFail。
 */
import {
  isFail,
  type Gate,
  type GateFail,
  type GateItem,
  type GateReport,
  type GateResult,
} from "./types";

export * from "./types";

export interface RunGatesOptions {
  /** 见红即停，剩下的闸计入 skipped（默认 false = 跑完全部，页页有账） */
  stopOnFail?: boolean;
}

/** 串行跑一组闸，聚合成 gate_report */
export async function runGates<TInput>(
  gates: readonly Gate<TInput>[],
  input: TInput,
  options: RunGatesOptions = {},
): Promise<GateReport> {
  const items: GateItem[] = [];
  let firstFailure: GateFail | undefined;
  let skipped = 0;

  for (const gate of gates) {
    if (firstFailure && options.stopOnFail) {
      skipped += 1;
      continue;
    }
    const startedAt = Date.now();
    const result: GateResult = await gate.run(input);
    items.push({ name: gate.name, result, ms: Date.now() - startedAt });
    if (isFail(result) && !firstFailure) firstFailure = result;
  }

  const failed = items.filter((i) => isFail(i.result)).length;
  return {
    ok: failed === 0 && skipped === 0,
    total: gates.length,
    passed: items.length - failed,
    failed,
    skipped,
    items,
    ...(firstFailure ? { firstFailure } : {}),
  };
}

/** gate_report → audit_log.gate_results_json（没跑闸就写 null，不写 "{}" 冒充跑过） */
export function gateReportToJson(report?: GateReport | null): string | null {
  return report ? JSON.stringify(report) : null;
}
