/**
 * core/gates/types.ts —— 闸的契约（AI:PRD-001 · WP3 骨架）
 *
 * 本卡只立骨架和执行器，真闸从 AI:PRD-003 起一个个长（每闸一文件、可单测）。
 *
 * 🔴 失败 shape 和「错误契约」对齐（技术设计 §5 / 回归清单 REG-G2）：
 *      { ok:false, code, message(可操作), example?, recoverable, nextTool?, candidates? }
 *    ——agent 是主要消费者，它要靠这个 shape **自愈**：
 *      code       给机器分支（稳定枚举串，不许改文案时顺手改它）；
 *      message    给人和 agent 读，必须写「怎么改」而不是「你错了」；
 *      recoverable 直接决定 agent 该重试还是该停下来问人；
 *      candidates id 类校验失败必附最近似候选 —— 把「逼你去检索」做成引导而不是惩罚。
 */

export interface GateOk {
  ok: true;
}

/** 候选项：id 类校验失败时回给 agent 的「你是不是想找这个」 */
export interface GateCandidate {
  id?: string;
  label: string;
  /** 相似度/置信度，0-1；没有就不填，别编 */
  score?: number;
  note?: string;
}

export interface GateFail {
  ok: false;
  /** 稳定错误码，如 `KP_NOT_FOUND` / `STEM_HAS_INSTRUCTION_WORD` */
  code: string;
  /** 人话 + 可操作：说清楚怎么改才能过 */
  message: string;
  /** 能不能靠改参数重试过闸；false = 停下来问人 */
  recoverable: boolean;
  /** 一个改对了的例子 */
  example?: string;
  /** 建议下一步调哪个工具（如 `resolve_kp`） */
  nextTool?: string;
  /** id 类失败必附最近似候选 */
  candidates?: GateCandidate[];
}

export type GateResult = GateOk | GateFail;

/** 一道闸 = 一个名字 + 一个纯判定（可异步，因为要查库） */
export interface Gate<TInput = unknown> {
  readonly name: string;
  run(input: TInput): GateResult | Promise<GateResult>;
}

/** 逐项结果（页页有账：过了的也留一行） */
export interface GateItem {
  name: string;
  result: GateResult;
  /** 该闸耗时（ms），用来抓慢闸 */
  ms: number;
}

/** gate_report：整串闸的账本，直接序列化进 audit_log.gate_results_json */
export interface GateReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  /** 因为前面已经红了而没跑的闸数（stopOnFail 模式下才可能 >0） */
  skipped: number;
  items: GateItem[];
  /** 第一处失败，方便直接回给调用方当错误契约 */
  firstFailure?: GateFail;
}

export const PASS: GateOk = { ok: true };

/** 造一个通过结果 */
export function pass(): GateOk {
  return PASS;
}

/** 造一个失败结果（强制你把 code/message/recoverable 写全） */
export function fail(init: Omit<GateFail, "ok">): GateFail {
  return { ok: false, ...init };
}

export function isFail(r: GateResult): r is GateFail {
  return r.ok === false;
}
