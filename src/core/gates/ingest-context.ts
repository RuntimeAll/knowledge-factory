/**
 * core/gates/ingest-context.ts —— 十道录题闸共用的输入契约（AI:PRD-003 · 003-C）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 分工：**管道做变换，闸做判定**
 *
 *   每个闸文件导出两样东西：
 *     ① 纯函数（`stripLeadInstruction` / `cleanStemPrefix` / `matchKeyOf` …）
 *        —— 确定性、无副作用、无 IO，可以脱离库单测；
 *     ② `Gate<IngestItemCtx>` 对象 —— 读 `derived`（管道相一已经用①算好的中间物），
 *        判红绿，并把「剥了什么 / 抽检了什么 / 有什么不拦路但要人看见的事」记进
 *        `derived.stripped / sampled / notes`。
 *
 *   为什么不让闸自己做变换：gates/README 写着「闸必须是确定性判定」。
 *   变换塞进闸里，闸就有了顺序耦合（第 5 闸的输入取决于第 4 闸改没改），
 *   单测一道闸得先跑前面四道 —— 那就不叫「每闸可单测」了。
 *
 * 🔴 `derived` 是**可变**的：闸把结论写回去（kp 绑定、判档、配图计划），
 *    管道相二照着它落库。这是刻意的 —— 闸的产出不只是红绿，还有「该怎么落」。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { type CalcVerifyResult, type LineVerifyResult } from "../sidecar";
import {
  type FigureRole,
  type KbIngestItem,
  type KbIngestPayload,
  type SolutionGrade,
} from "../ingest-schema";
import { type CoreDbHandle } from "../db";

/** 一张图的落地计划（相一只算 hash，真拷贝在相二） */
export interface FigurePlan {
  role: FigureRole;
  /** 契约里给的原路径（已解析成绝对路径） */
  srcPath: string;
  /** 文件内容 sha256 —— 也是 asset 的天然去重键（asset.hash 有 UNIQUE） */
  hash: string;
  bytes: number;
  /** 扩展名（含点，小写；没有就空串） */
  ext: string;
  /** 落地文件名 = <hash><ext>，相对 assets 仓根（对账 C1c 就按这个比） */
  fileName: string;
}

/** 一条考点绑定（ref 解析后的结果） */
export interface KpBinding {
  kpId: string;
  name: string;
  isPrimary: boolean;
  /** 契约里写的原文（名字或 id），出事回溯用 */
  ref: string;
  /** 命中的是 merged 壳、已追链到落点时标注（不静默换人） */
  resolvedFrom?: { id: string; name: string; hops: number };
}

/** 逐题的中间物（相一算出来，闸读它、也往里写结论） */
export interface ItemDerived {
  /** 剥掉句首裸指令词（及其前面的题号）之后的题面 */
  stemStripped: string;
  /** 再过一遍前缀清洗 = **真正落库的 question.stem** */
  stemClean: string;
  /** 剥掉了哪些片段（页页有账：剥了什么必须留得下来） */
  stripped: string[];
  /** 抽检标记（解析图不建工单，但要在账上留一笔） */
  sampled: string[];
  /** 不拦路、但必须让人看见的事（cannot_verify、merged 追链、默认主考点…） */
  notes: string[];
  /** 规范化题面的 sha256（查重键） */
  matchKey: string;
  /** 写侧分词投影（🔴 一律 sidecar mode='search'，长词再切多留 token） */
  stemPlainSeg: string;
  answerSeg: string;
  analysisSeg: string;
  /** 实算结论；非计算题 = null（不是「算过了没结论」，是「压根没送去算」） */
  calc: CalcVerifyResult | null;
  /**
   * 逐行恒等结论；没送去校（非计算题 / 没解析）= null。
   * 🔴 与 calc 是两个判据：calc 验最终答案，这个验过程的每一行（答案对过程错）。
   */
  lineVerify: LineVerifyResult | null;
  /** 考点绑定（kp 闸填） */
  kps: KpBinding[];
  /** 判档（solution-grade 闸填） */
  solutionGrade: SolutionGrade | null;
  /** 配图落地计划（figure 闸填） */
  figures: FigurePlan[];
  /** 有题干图 ⇒ 必人审（figure 闸填） */
  reviewRequired: boolean;
}

/** 批级上下文（逐题闸共享的只读环境 + 批内查重表） */
export interface IngestBatchCtx {
  handle: CoreDbHandle;
  payload: KbIngestPayload;
  /**
   * matchKey → 批内**第一个**用它的 seq。
   * 🔴 同批互撞也要拦：一次喂料里塞两道一模一样的题，落库时第二道会撞
   *    `idx_q_matchkey` 部分唯一索引直接 SQLITE_CONSTRAINT —— 整批回滚。
   *    与其让 59 道好题陪葬，不如在闸上把那一道拦下来。
   */
  keyOwner: Map<string, number>;
  /** 资产仓根（= 库文件同级的 assets/），配图闸算落地路径用 */
  assetsDir: string;
}

export interface IngestItemCtx {
  seq: number;
  item: KbIngestItem;
  derived: ItemDerived;
  batch: IngestBatchCtx;
}

/** 造一份空的 derived（字段全给默认值，免得下游到处判 undefined） */
export function emptyDerived(): ItemDerived {
  return {
    stemStripped: "",
    stemClean: "",
    stripped: [],
    sampled: [],
    notes: [],
    matchKey: "",
    stemPlainSeg: "",
    answerSeg: "",
    analysisSeg: "",
    calc: null,
    lineVerify: null,
    kps: [],
    solutionGrade: null,
    figures: [],
    reviewRequired: false,
  };
}
