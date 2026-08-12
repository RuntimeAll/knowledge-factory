/**
 * 合并回执的短期存放处（AI:PRD-002 · 002-D）
 *
 * mergeKp 的返回值（moved/dropped 逐表 + 主考点裁决 + errCodeDropped）是**一次性**的：
 * 合并做完，库里就只剩结果，没有哪张表记着「这次搬了几行、丢了几行」。
 * 而那份账恰恰是人要看的东西 —— 于是执行动作把它按审计行序号 seq 存在进程内存里，
 * 结果页按 seq 取。
 *
 * 🔴 明知的取舍：**进程重启就没了**（本地单进程工具，够用）。
 *    丢了也不影响正确性 —— 合并本身已经落库、审计行 seq 也在，结果页会如实说
 *    「这份回执散了，去看审计行 / 落点考点」，而不是装作没发生过。
 * 🔴 不落库的理由：为了页面好看往库里加一张「合并回执表」，就多一张要对账、要备份、
 *    要迁移的表；而它的唯一读者是刚点完按钮的那个人。不值。
 */
import { type CheckResult, type MergeKpResult } from "~/core";

export interface MergeReceipt {
  result: MergeKpResult;
  /** 合并后立刻跑的那次对账里的 C2（悬挂引用）；跑不动时为 null */
  c2: CheckResult | null;
  /** 那次对账整体有没有红旗 */
  integrityOk: boolean | null;
  /** 对账跑不动的原因（正常为 null） */
  integrityError: string | null;
  at: string;
}

/** 只留最近这些笔：这是给「刚点完」用的，不是历史档案 */
const 上限 = 20;

const 回执 = new Map<number, MergeReceipt>();

export function stashMergeReceipt(seq: number, receipt: MergeReceipt): void {
  回执.set(seq, receipt);
  while (回执.size > 上限) {
    const oldest = 回执.keys().next();
    if (oldest.done) break;
    回执.delete(oldest.value);
  }
}

export function readMergeReceipt(seq: number): MergeReceipt | null {
  return 回执.get(seq) ?? null;
}
