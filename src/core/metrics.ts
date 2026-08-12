/**
 * core/metrics.ts —— 指标打点（AI:PRD-001 · WP3）
 *
 * metric_event 是北极星对账的取数面（M1 §指标）：agent 一次过闸率、resolve 改判、
 * 语意轴命中贡献、审核无改动率、备份成败……检索调用本身也落这（kind='search'），
 * 评测集从真实查询里抽，不另造。
 *
 * 🔴 打点也走 withCoreWrite —— 它是一次库写，就得留审计行。
 *    「顺手写一行不算写」正是审计出洞的开始。
 */
import { metricEvent } from "~/server/db/schema";
import { stableStringify } from "./audit";
import { type CoreDbHandle } from "./db";
import { nowLocalISO } from "./time";
import { withCoreWrite } from "./write";

export interface MetricReceipt {
  /** metric_event.id */
  id: number;
  /** 对应的审计行序号 */
  seq: number;
}

/**
 * 记一条指标。
 * @param kind  指标类别（'gate_pass' / 'search' / 'backup' / 'resolve_override' …）
 * @param ref   关联对象（question_id / kp_id / batch_id / 学员代号…），没有传 null
 * @param value 任意可 JSON 的载荷，落 value_json（确定性序列化）
 */
export async function logMetric(
  kind: string,
  ref: string | null,
  value: unknown,
  handle?: CoreDbHandle,
): Promise<MetricReceipt> {
  let metricId = -1;

  const receipt = await withCoreWrite(
    { actor: "system", tool: "logMetric", args: { kind, ref } },
    async (tx) => {
      const inserted = await tx
        .insert(metricEvent)
        .values({
          ts: nowLocalISO(),
          kind,
          ref,
          valueJson: stableStringify(value),
        })
        .returning({ id: metricEvent.id });
      const id = inserted[0]?.id;
      if (typeof id !== "number") {
        throw new Error("logMetric：metric_event 没拿到自增 id");
      }
      metricId = id;
      return [{ table: "metric_event", id: String(id), op: "insert" as const }];
    },
    handle,
  );

  return { id: metricId, seq: receipt.seq };
}
