/**
 * core/convert-punch.ts —— 产线出料 → kb-ingest/v1 转换器（AI:PRD-005 · 005-B）
 *
 * 三条产线现在吐三种形状的料，它们**都不是** kb-ingest/v1：
 *
 *   ① 对象根   `punch-ingest/v1` 老形态（一册一文件）  例：七上有理数与实数计算打卡/_源/_入库.json
 *   ② 数组根   2026-08-09 起的现行形态（一文件多管线 + 合刊元素）
 *                                                    例：七上第二单元打卡册/_源/_入库.json
 *   ③ 群卷题单 `订阅特训/群打卡/第01期/<线>/第N天/题单.json`（逐题结构化，字段名全不一样）
 *
 * 本文件把这三种**搬运**成 kb-ingest/v1 payload，然后交给 `runIngestBatch` 去过闸。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条纪律（这一层出事最贵，因为它在闸的**上游**）
 *
 * ① **题面一个字都不改**。`stem` 原样搬（剥指令词 / 清前缀 / 归一是**闸**的活，
 *    在管道相一里做，且做完留账）。转换层若顺手 trim 一下、顺手把 `\left(` 换成 `(`，
 *    那么「库里的题面」与「册子上印的题面」就永远对不上，而且没有任何账能查出来。
 *    （唯一的例外是 zod 契约层对 `stem` 的 `.trim()` —— 那是 kb-ingest/v1 自己的口径，
 *      不是本层动的手，见 ingest-schema.ts 的 `非空串`。）
 *
 * ② **未知字段如实进报告，不静默丢**。punch-ingest/v1 没有 schema 文件，字段是
 *    「谁写生成器谁说了算」，今天多一个 `册型`、明天多一个 `交付件` 都可能发生。
 *    认不出的键一律进 `unknownFields`，让人当场看见「这次有东西没搬过来」——
 *    这正是 punch 那边「认不出的契约 console.log 跳过」酿成的病，别在这儿重犯。
 *
 * ③ **归一必须显式记账**。null/空串→null、题型别名→字典值、册级考点下沉到题级，
 *    每一次都往 `normalizations` 里写一行。转换是「搬运 + 有据可查的折算」，
 *    不是「猜」——猜不出来的（题型认不出、考点没有）宁可留空让闸去红，也不编。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 转换 ≠ 入库。本文件**一个字节都不写库**（纯函数，连 handle 都不要）：
 *    产出的 payload 还要过 kb-ingest/v1 的十道闸，考点解析不出来、题面撞库、
 *    实算对不上，照样红灯。转换器的职责只有一个：把料摆成闸看得懂的样子。
 */
import { z } from "zod";

import {
  QTYPES,
  ingestPayloadSchema,
  type KbIngestPayload,
  type QType,
  type SourceDocKind,
} from "./ingest-schema";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 产线侧的契约串（对象根/数组根元素的 `契约` 字段） */
export const PUNCH_CONTRACT = "punch-ingest/v1";

/** 三种进料形态 */
export const PUNCH_FORMS = ["对象根", "数组根", "群卷题单"] as const;
export type PunchForm = (typeof PUNCH_FORMS)[number];

export const CONVERT_ERROR_CODES = [
  /** 认不出这是哪种料（既不是 punch-ingest/v1，也不像群卷题单） */
  "UNKNOWN_FORM",
  /** 入参根本不是 JSON 对象/数组 */
  "INVALID_INPUT",
  /** 认得出形态，但一道题都没有 */
  "EMPTY_SOURCE",
] as const;
export type ConvertErrorCode = (typeof CONVERT_ERROR_CODES)[number];

export class ConvertError extends Error {
  readonly code: ConvertErrorCode;
  constructor(code: ConvertErrorCode, message: string) {
    super(message);
    this.name = "ConvertError";
    this.code = code;
  }
}

/** 一个可投的单元 = 一次 runIngestBatch = 一个 ingest_batch */
export interface ConvertedUnit {
  /** 人读单元名（册·版本名 / 题单文件位置），报告与日志里靠它定位 */
  unit: string;
  form: PunchForm;
  /** 已过 ingest-schema 自检的 payload（可直接喂 runIngestBatch） */
  payload: KbIngestPayload;
  /** 本单元题数 */
  n: number;
  /** 本单元的搬运说明（哪些字段落到哪、哪些没收） */
  notes: string[];
}

/** 转出来了但过不了 kb-ingest/v1 自检的单元（🔴 不投，原因原样端出） */
export interface ConvertFailure {
  unit: string;
  /** 'SCHEMA'=没过 zod；'NO_KP'=题挂不上考点（kb-ingest 禁孤题） */
  code: "SCHEMA" | "NO_KP";
  message: string;
  /** NO_KP 时：哪几道题没有考点（批内 seq） */
  seqs?: number[];
}

/** 有意跳过的元素（合刊那种「不挂题」的登记元素） */
export interface ConvertSkip {
  unit: string;
  why: string;
}

/** 认不出的字段（🔴 如实上报，不静默丢） */
export interface UnknownField {
  /** 在哪一层碰到的（`items[3]` / `版本[0]` / 根） */
  where: string;
  keys: string[];
  /** 取一个值当样本，方便人一眼认出这是什么 */
  sample: string;
}

export interface ConvertResult {
  form: PunchForm;
  units: ConvertedUnit[];
  failed: ConvertFailure[];
  skipped: ConvertSkip[];
  unknownFields: UnknownField[];
  /** 每一次显式归一都在这儿留一行 */
  normalizations: string[];
  warnings: string[];
  counts: { units: number; items: number; failed: number; skipped: number };
}

export interface ConvertOptions {
  /** 落 `ingest_batch.source`（喂料方标识）。默认 `punch-convert@v1` */
  source?: string;
  /**
   * 覆盖 `prov.pipelineRef`（脚本名@版本）。
   * 🔴 不传就按形态推（见 §pipelineRef 推导），并在 warnings 里说明推的是什么。
   */
  pipelineRef?: string;
  /** 源文件路径（CLI 传进来的那个）：用于推单元名 / sourceDoc.path */
  filePath?: string;
  /** 册头补丁：群卷题单没有册头，`sourceDoc.title` 必须由外面给 */
  sourceDoc?: {
    title?: string;
    kind?: SourceDocKind;
    path?: string;
    note?: string;
  };
  /** 考点兜底：题级、册级都没有考点时用它（写考点名或 kp_id，闸③再解析） */
  kps?: string[];
  /**
   * 🔴 群卷题单专用：产线的 `anchor` / `kp_group` 说法 → 词表 ref 的**显式映射表**。
   *
   * 为什么非要它（005-C 实测三种对不上的形态，缺一条都投不进去）：
   *   ① **歧义**：`sign` 在词表里同时是「有理数的加减混合运算」与「有理数的加法法则」
   *      的别名，`去括号` 同时是一个考点的**正名**和另一个考点的别名 —— 闸③照规矩红
   *      `AMBIGUOUS_KP`（它没做错，是产线的说法本来就指不明）；
   *   ② **不是考点名**：绝对值线有一条 anchor 整个是 LaTeX
   *      （`\(\frac{\left|a\right|}{a}+…\) 型的计算`）—— 这种串不该进词表当别名（那是往
   *      词表里倒垃圾），只能在这儿显式指向「符号商 |a|/a 型的计算」；
   *   ③ **anchor 为空**：手写固定卷那两天没有 anchor，只有 `kp_group`（「小数运算与简算」
   *      这类**题组名**，不是考点名）。
   *
   * 口径：先查 `anchor`，没命中再查 `kp_group`；命中就拿映射值当 `kps[].ref` 并记一条
   * normalization。🔴 **映射表不代替闸** —— 表里没有的照原样送闸③，对不上照样红灯，
   * 而不是在这里"猜一个最像的"。
   */
  kpMap?: Readonly<Record<string, string>>;
  /** 群卷题单的位置补丁（题单本身不带 day/section） */
  punch?: { day: number; section?: string };
  /** 题单形态的默认题型（题单没有题型字段） */
  qtype?: QType;
}

// ---------------------------------------------------------------------------
// 字段表（🔴 唯一一份：认不认得出全看它）
// ---------------------------------------------------------------------------

/** 册级（对象根 / 数组根元素） */
const 册级已知 = new Set([
  "契约",
  "册",
  "组名",
  "册型",
  "成员",
  "类型",
  "科目",
  "年级",
  "源目录",
  "交付件",
  "版本",
]);

/** 版本级 */
const 版本级已知 = new Set(["版本名", "layout_key", "day_spec", "考点", "题"]);

/** 题级 */
const 题级已知 = new Set([
  "day",
  "section",
  "seq",
  "stem",
  "answer",
  "analysis",
  "考点",
  "题型",
  "难度",
  "来源",
  "实算",
]);

/** 群卷题单题级 */
const 题单级已知 = new Set([
  "no",
  "q",
  "ans",
  "kp",
  "diag",
  "kp_group",
  "anchor",
]);

/**
 * 题型别名 → kb-ingest/v1 字典值。
 *
 * 🔴 `口算 → 计算` 是**有后果**的一次折算：`计算` 是唯一触发「可实算即实算」闸的题型
 *    （见 gates/ingest-calc.gate.ts），折过去等于替产线宣称「这题机器算得出来」。
 *    对口算题这恰恰成立（`(-10)+(+6)` 就是纯算式），所以折；折了必记账。
 * 🔴 表里没有的题型**一律不猜**：留空（qtype 可选），并往 warnings 里写一行。
 */
const QTYPE_ALIAS: Readonly<Record<string, QType>> = {
  计算: "计算",
  计算题: "计算",
  口算: "计算",
  填空: "填空",
  填空题: "填空",
  选择: "选择",
  选择题: "选择",
  解答: "解答",
  解答题: "解答",
  判断: "判断",
  判断题: "判断",
  作图: "作图",
  证明: "证明",
  应用: "应用",
  应用题: "应用",
  其他: "其他",
};

/** 册级 `类型` → source_doc.kind（认不出落「其他」并记账） */
const KIND_ALIAS: Readonly<Record<string, SourceDocKind>> = {
  打卡: "册子",
  册子: "册子",
  练习册: "册子",
  合刊: "册子",
  专项: "册子",
  讲义: "讲义",
  试卷: "试卷",
  群卷: "群卷",
  群打卡: "群卷",
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type 对象 = Record<string, unknown>;

function 是对象(v: unknown): v is 对象 {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 可空文本归一：null / "" / 全空白 → null（口径与 ingest-schema 的 `可空文本` 一致） */
function 文本或空(v: unknown): string | null {
  if (typeof v !== "string") return v === null || v === undefined ? null : null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function 非空字符串(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function 正整数(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** 采一个样本值给人看（不做深拷贝，只截一段字符串） */
function 样本(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const t = s ?? "null";
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** 收未知键（🔴 纪律②的实现） */
function 收未知(
  obj: 对象,
  known: Set<string>,
  where: string,
  into: UnknownField[],
): void {
  const keys = Object.keys(obj).filter((k) => !known.has(k));
  if (keys.length === 0) return;
  into.push({
    where,
    keys,
    sample: keys.map((k) => `${k}=${样本(obj[k])}`).join("；"),
  });
}

/** 字符串数组归一（考点列表这类：null / 单串 / 数组 都吃得下） */
function 串数组(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return 非空字符串(v) ? [v.trim()] : [];
  if (Array.isArray(v)) {
    return v.map(非空字符串).filter((s): s is string => s !== null);
  }
  return [];
}

// ---------------------------------------------------------------------------
// 形态识别
// ---------------------------------------------------------------------------

/** 判形态。认不出就抛 —— 认不出还硬转，转出来的是什么谁也说不清 */
export function detectPunchForm(json: unknown): PunchForm {
  if (是对象(json)) {
    if (json.契约 === PUNCH_CONTRACT) return "对象根";
    throw new ConvertError(
      "UNKNOWN_FORM",
      `对象根但 契约=${JSON.stringify(json.契约 ?? null)}，不是 "${PUNCH_CONTRACT}" ——` +
        "认不出的契约一律拒（🔴 punch 那边的做法是 console.log 跳过，本层不学）。",
    );
  }
  if (!Array.isArray(json)) {
    throw new ConvertError(
      "INVALID_INPUT",
      `进料不是 JSON 对象/数组（拿到 ${typeof json}）—— 三种形态分别是：` +
        "对象根 punch-ingest/v1、数组根 punch-ingest/v1、群卷题单.json（数组，元素带 no/q/ans）。",
    );
  }
  const arr: unknown[] = json as unknown[];
  if (arr.length === 0) {
    throw new ConvertError("EMPTY_SOURCE", "数组根但一个元素都没有。");
  }
  const 头 = arr[0];
  if (是对象(头) && 头.契约 === PUNCH_CONTRACT) return "数组根";
  if (是对象(头) && "q" in 头 && ("no" in 头 || "ans" in 头)) return "群卷题单";
  throw new ConvertError(
    "UNKNOWN_FORM",
    `数组根，但首元素既不是 punch-ingest/v1（缺 契约），也不像群卷题单（缺 no/q/ans）。` +
      `首元素的键：${Object.keys(是对象(头) ? 头 : {}).join("、") || "（不是对象）"}`,
  );
}

// ---------------------------------------------------------------------------
// 搬运：punch 册 → kb payload
// ---------------------------------------------------------------------------

interface 搬运上下文 {
  opts: ConvertOptions;
  unknown: UnknownField[];
  normalizations: Set<string>;
  warnings: Set<string>;
}

/**
 * pipelineRef 推导（🔴 punch-ingest/v1 **不带生成器版本号**，如实标注）：
 *   对象根/数组根 → `<源目录>\gen_打卡.py@<册>·<版本名>`（册·版本名占版本位）
 *   群卷题单     → `题单.json@<父目录>`（连生成器是谁都推不出来，只能记位置）
 * 要真版本一律显式传 `pipelineRef`。
 */
function 推pipelineRef(
  ctx: 搬运上下文,
  args:
    | { form: "册"; 源目录: string | null; 册: string; 版本名: string | null }
    | { form: "题单"; filePath: string | null },
): string {
  if (ctx.opts.pipelineRef) return ctx.opts.pipelineRef;
  if (args.form === "册") {
    const 脚本 = args.源目录 ? `${args.源目录}\\gen_打卡.py` : "gen_打卡.py";
    const 版 = args.版本名 ? `${args.册}·${args.版本名}` : args.册;
    ctx.warnings.add(
      `prov.pipelineRef 是**推**出来的：${脚本}@${版}（punch-ingest/v1 不带生成器版本号，这里用「册·版本名」占版本位）。` +
        "要能按版本召回，请显式传 pipelineRef。",
    );
    return `${脚本}@${版}`;
  }
  const p = args.filePath ?? "题单.json";
  const 位置 = p.split(/[\\/]/).slice(-3).join("/");
  ctx.warnings.add(
    `prov.pipelineRef 是**推**出来的：题单.json@${位置}（群卷题单里没有任何生成器标识，只能记文件位置）。` +
      "要能按批召回，请显式传 pipelineRef，例如 出群卷-批量.py@第01期。",
  );
  return `题单.json@${位置}`;
}

/** 一册（一个 版本 元素）→ 一个 payload */
function 搬一册(
  ctx: 搬运上下文,
  册: 对象,
  版本: 对象,
  序: { 册序: number; 版序: number },
): {
  unit: string;
  payload: unknown;
  n: number;
  notes: string[];
  无考点: number[];
} {
  const notes: string[] = [];
  const 册名 = 非空字符串(册.册) ?? `（无册名·第${序.册序 + 1}个元素）`;
  const 版本名 = 非空字符串(版本.版本名);
  const unit = 版本名 && 版本名 !== "定版" ? `${册名}·${版本名}` : 册名;

  收未知(册, 册级已知, `[${序.册序}] ${册名}`, ctx.unknown);
  收未知(版本, 版本级已知, `[${序.册序}].版本[${序.版序}]`, ctx.unknown);

  // ── 册级：只有 源目录 落进 sourceDoc，其余按契约 §3 明确不收 ──────────────
  const 源目录 = 非空字符串(册.源目录);
  const 类型 = 非空字符串(册.类型);
  const kind: SourceDocKind =
    ctx.opts.sourceDoc?.kind ?? (类型 ? (KIND_ALIAS[类型] ?? "其他") : "册子");
  if (类型 && !KIND_ALIAS[类型]) {
    ctx.warnings.add(
      `册「${册名}」的 类型=「${类型}」不在 kind 别名表里，sourceDoc.kind 落「其他」（不猜）。`,
    );
  }
  if (册.交付件 !== undefined) {
    const 条 =
      `册「${册名}」带 交付件（成品 PDF 指针）：按契约 §3 **不收进题库** —— ` +
      "它属 SKU 产出（sku_output），请用 register_sku 的 outputs 登记。";
    notes.push(条);
    // 🔴 同时进全局 warnings：带 交付件 的多半正是那个「不挂题」的合刊元素，
    //    而它会被跳过 —— 只写在单元 notes 里，这条提示就跟着单元一起消失了。
    ctx.warnings.add(条);
  }
  if (册.组名 || 册.册型 || 册.成员 || 册.类型 || 册.科目 || 册.年级) {
    notes.push(
      "册/组名/册型/成员/类型/科目/年级 按契约 §3 不收：那是册子的结构与学段，" +
        "题挂考点、考点自带学段（KG 双层）。",
    );
  }

  const 层名 = `${unit}`;
  const 册级考点 = 串数组(版本.考点);
  const items: unknown[] = [];
  const 无考点: number[] = [];
  const 题 = Array.isArray(版本.题) ? 版本.题 : [];

  for (const [i, raw] of 题.entries()) {
    if (!是对象(raw)) {
      ctx.warnings.add(
        `${层名} 的 题[${i}] 不是对象，跳过（原值：${样本(raw)}）`,
      );
      continue;
    }
    收未知(raw, 题级已知, `${层名} 题[${i}]`, ctx.unknown);

    const seq = i + 1; // 🔴 批内 seq 用**下标**，不用 题[].seq（那是「一天里的第几题」，全册会重号）
    const stem = typeof raw.stem === "string" ? raw.stem : "";
    const answer = 文本或空(raw.answer);
    const analysis = 文本或空(raw.analysis);
    if (raw.answer !== undefined && answer === null) {
      ctx.normalizations.add(
        "answer 的空串/全空白一律归一成 null（下游只判 null）",
      );
    }

    // 题型：折算记账，认不出留空
    const 题型 = 非空字符串(raw.题型);
    let qtype: QType | undefined;
    if (题型) {
      const hit = QTYPE_ALIAS[题型];
      if (hit) {
        qtype = hit;
        if (hit !== 题型) {
          ctx.normalizations.add(
            `题型「${题型}」→ 字典值「${hit}」` +
              (hit === "计算"
                ? "（🔴 计算是唯一触发实算闸的题型：折过去等于宣称机器算得出来）"
                : ""),
          );
        }
      } else {
        ctx.warnings.add(
          `题型「${题型}」不在字典里（${QTYPES.join("/")}），本题 qtype 留空 —— 不猜。`,
        );
      }
    }

    // 考点：题级 → 册级 → opts 兜底，三级都空就记下来（kb-ingest 禁孤题）
    const 题考点 = 串数组(raw.考点);
    let kpRefs = 题考点;
    if (kpRefs.length === 0 && 册级考点.length > 0) {
      kpRefs = 册级考点;
      ctx.normalizations.add(
        `册级 版本[].考点 下沉到题级 kps（契约 §3：从册级裸字符串数组降到题级 kp 解析）`,
      );
    }
    if (kpRefs.length === 0 && (ctx.opts.kps?.length ?? 0) > 0) {
      kpRefs = ctx.opts.kps!;
      ctx.normalizations.add(
        `题级/册级都没有考点，用外面给的兜底考点：${kpRefs.join("、")}`,
      );
    }
    if (kpRefs.length === 0) 无考点.push(seq);

    const tags: string[] = [];
    const 来源 = 非空字符串(raw.来源);
    if (来源) {
      // 🔴 来源是**一行自由文本**（"母题=用户 2026-08-10 给的教辅照片…"），
      //    contract §3 把它折成 prov 四型；四型只留得下「哪个脚本@哪版」，
      //    原话不能丢 —— 挂成标签跟着题走，日后按来源召回还找得到。
      tags.push(`来源:${来源}`);
      ctx.normalizations.add(
        "题[].来源（自由文本）→ prov=pipeline + 原话挂成标签 `来源:<原文>`（不丢原话）",
      );
    }
    if (raw.实算 !== undefined) {
      ctx.normalizations.add(
        "题[].实算 按契约 §3 **刻意不收**：产线自报的绿不作数，管道自己用 sympy 算一遍。",
      );
    }

    const day = 正整数(raw.day);
    const section = 非空字符串(raw.section);
    const 题内seq = 正整数(raw.seq);
    const 难度 = 正整数(raw.难度);

    items.push({
      seq,
      stem, // 🔴 原样，一个字不改
      answer,
      analysis,
      ...(qtype ? { qtype } : {}),
      ...(难度 === null ? {} : { difficulty: 难度 }),
      kps: kpRefs.map((ref, idx) => ({
        ref,
        ...(idx === 0 ? { isPrimary: true } : {}),
      })),
      ...(tags.length > 0 ? { tags } : {}),
      prov: {
        type: "pipeline",
        pipelineRef: 推pipelineRef(ctx, {
          form: "册",
          源目录,
          册: 册名,
          版本名,
        }),
      },
      ...(day && section && 题内seq
        ? { punchPos: { day, section, seq: 题内seq } }
        : {}),
    });
  }

  const payload = {
    contract: "kb-ingest/v1",
    source: ctx.opts.source ?? "punch-convert@v1",
    sourceDoc: {
      title: ctx.opts.sourceDoc?.title ?? unit,
      kind,
      ...((ctx.opts.sourceDoc?.path ?? 源目录)
        ? { path: ctx.opts.sourceDoc?.path ?? 源目录! }
        : {}),
      note:
        ctx.opts.sourceDoc?.note ??
        `来自 ${PUNCH_CONTRACT}${版本名 ? ` · 版本=${版本名}` : ""}` +
          (非空字符串(版本.layout_key)
            ? ` · layout=${版本.layout_key as string}`
            : ""),
    },
    items,
  };

  // 🔴 不给 sourceDoc.hash：punch 料里没有源文件 hash，而 _入库.json 的内容 hash
  //    会随「加了一天」而变 —— 拿它当 hash，同一册会一天开一行 source_doc。
  //    不给 hash 时管道按 (title, kind) 复用同一行，正是我们要的。
  notes.push(
    "sourceDoc 不带 hash：punch 料无源文件 hash；管道按 (title,kind) 跨批复用同一行 source_doc。",
  );

  return { unit, payload, n: items.length, notes, 无考点 };
}

/** 群卷题单 → 一个 payload */
function 搬题单(
  ctx: 搬运上下文,
  rows: unknown[],
): {
  unit: string;
  payload: unknown;
  n: number;
  notes: string[];
  无考点: number[];
} {
  const notes: string[] = [];
  const p = ctx.opts.filePath ?? "题单.json";
  const 位置 = p.split(/[\\/]/).slice(-3).join("/");
  const unit = ctx.opts.sourceDoc?.title ?? 位置;
  const items: unknown[] = [];
  const 无考点: number[] = [];

  for (const [i, raw] of rows.entries()) {
    if (!是对象(raw)) {
      ctx.warnings.add(`题单[${i}] 不是对象，跳过（原值：${样本(raw)}）`);
      continue;
    }
    收未知(raw, 题单级已知, `题单[${i}]`, ctx.unknown);

    const seq = 正整数(raw.no) ?? i + 1;
    const stem = typeof raw.q === "string" ? raw.q : "";
    const answer = 文本或空(raw.ans);

    // 🔴 kp/kp_group/anchor 三个字段各是什么，别混：
    //    kp        = 错因码（err_kp.json 的 sign/order/pow/abs…），**不是** 002 词表的考点 id；
    //    kp_group  = 人读的题组名；
    //    anchor    = 主锚（这一题考的那个说法）——最接近「考点」的一个。
    //    所以：三者一律进标签留痕；考点 ref 用 anchor（或 kp_group）送闸③做**精确**匹配，
    //    匹配不上会红灯 —— 那正是要的：宁可红灯让人去补别名，也不把错因码当考点挂上去。
    const kp码 = 串数组(raw.kp);
    const kp_group = 非空字符串(raw.kp_group);
    const anchor = 非空字符串(raw.anchor);
    const diag = 非空字符串(raw.diag);

    const tags: string[] = [
      ...kp码.map((k) => `kp:${k}`),
      ...(kp_group ? [`kp_group:${kp_group}`] : []),
      ...(anchor ? [`anchor:${anchor}`] : []),
      // 🔴 diag（错因诊断位）本卡不入库 —— 它是 006 错因域的料。
      //    这里只留一个「有没有」的标记，别把内容塞进标签当垃圾场。
      ...(diag ? ["diag:有"] : []),
    ];
    if (diag) {
      ctx.normalizations.add(
        "题单 diag（错因诊断）本卡不入库（006 错因域的料），只留标记标签 `diag:有`",
      );
    }
    if (kp码.length > 0) {
      ctx.normalizations.add(
        "题单 kp（错因码，如 abs/sign）→ 标签 `kp:<码>`，**不当考点挂载**（它不是 002 词表的考点）",
      );
    }

    // kpMap：产线说法 → 词表 ref 的显式映射（先 anchor 后 kp_group，见 ConvertOptions.kpMap）
    const 查表 = (s: string | null): string | undefined =>
      s !== null && ctx.opts.kpMap ? ctx.opts.kpMap[s] : undefined;
    const 映射键 = 查表(anchor) !== undefined ? anchor : 查表(kp_group) !== undefined ? kp_group : null;
    const 映射值 = 查表(anchor) ?? 查表(kp_group);

    const kpRefs =
      (ctx.opts.kps?.length ?? 0) > 0
        ? ctx.opts.kps!
        : 映射值 !== undefined
          ? [映射值]
          : anchor
            ? [anchor]
            : kp_group
              ? [kp_group]
              : [];
    if (kpRefs.length === 0) 无考点.push(seq);
    else if ((ctx.opts.kps?.length ?? 0) > 0) {
      /* 兜底考点那条已在上面记过账 */
    } else if (映射值 !== undefined) {
      ctx.normalizations.add(
        `考点 ref 经 kpMap 显式映射：「${映射键}」→「${映射值}」` +
          "（产线说法在词表里歧义/不是考点名/为空时的唯一正当出路；映射值仍要过闸③精确匹配）",
      );
    } else {
      ctx.normalizations.add(
        `考点 ref 取自 ${anchor ? "anchor（主锚）" : "kp_group（题组名）"} —— 送闸③做精确匹配，对不上会红灯（不硬挂）`,
      );
    }

    items.push({
      seq,
      stem,
      answer,
      analysis: null,
      ...(ctx.opts.qtype ? { qtype: ctx.opts.qtype } : {}),
      kps: kpRefs.map((ref, idx) => ({
        ref,
        ...(idx === 0 ? { isPrimary: true } : {}),
      })),
      tags,
      prov: {
        type: "pipeline",
        pipelineRef: 推pipelineRef(ctx, {
          form: "题单",
          filePath: ctx.opts.filePath ?? null,
        }),
      },
      ...(ctx.opts.punch
        ? {
            punchPos: {
              day: ctx.opts.punch.day,
              section: ctx.opts.punch.section ?? "群卷",
              seq,
            },
          }
        : {}),
    });
  }

  notes.push(
    "群卷题单没有册头：sourceDoc.title 取文件位置（或外面给的 title），kind 落「群卷」。",
  );

  return {
    unit,
    payload: {
      contract: "kb-ingest/v1",
      source: ctx.opts.source ?? "punch-convert@v1",
      sourceDoc: {
        title: unit,
        kind: ctx.opts.sourceDoc?.kind ?? "群卷",
        ...((ctx.opts.sourceDoc?.path ?? ctx.opts.filePath)
          ? { path: ctx.opts.sourceDoc?.path ?? ctx.opts.filePath! }
          : {}),
        note: ctx.opts.sourceDoc?.note ?? "来自 订阅特训 群卷题单.json",
      },
      items,
    },
    n: items.length,
    notes,
    无考点,
  };
}

// ---------------------------------------------------------------------------
// 总入口
// ---------------------------------------------------------------------------

/**
 * 产线出料 → kb-ingest/v1。
 *
 * ```ts
 * const r = convertPunchIngest(JSON.parse(readFileSync(p, "utf8")), { filePath: p });
 * for (const u of r.units) await runIngestBatch(u.payload, { actor: "agent" });
 * ```
 *
 * 🔴 **一个单元 = 一次 runIngestBatch**。数组根里有几条管线就出几个 payload ——
 *    不合并：合并了 sourceDoc 只能留一个册名，「这题出自哪本」当场失真。
 *
 * 🔴 转出来的 payload 先过 `ingestPayloadSchema` 自检；没过的**不投**，
 *    进 `failed` 原样端出（带 z.prettifyError 的逐字段人话）。
 *
 * @throws ConvertError 认不出形态 / 进料不是 JSON 对象数组
 */
export function convertPunchIngest(
  json: unknown,
  options: ConvertOptions = {},
): ConvertResult {
  const form = detectPunchForm(json);
  const ctx: 搬运上下文 = {
    opts: options,
    unknown: [],
    normalizations: new Set(),
    warnings: new Set(),
  };

  const units: ConvertedUnit[] = [];
  const failed: ConvertFailure[] = [];
  const skipped: ConvertSkip[] = [];

  const 收单元 = (r: {
    unit: string;
    payload: unknown;
    n: number;
    notes: string[];
    无考点: number[];
  }): void => {
    if (r.n === 0) {
      skipped.push({
        unit: r.unit,
        why: "这个元素一道题都没挂（合刊/登记型元素：题在各成员册里，见备料 §1.1）",
      });
      return;
    }
    if (r.无考点.length > 0) {
      failed.push({
        unit: r.unit,
        code: "NO_KP",
        message:
          `${r.无考点.length}/${r.n} 道题挂不上考点（题级没有、册级也没有）——` +
          "kb-ingest/v1 禁孤题（每题至少一个考点）。" +
          "处置：给册子补 版本[].考点，或转换时用 kps 兜底指定（先 resolve_kp 查真考点名）。",
        seqs: r.无考点.slice(0, 20),
      });
      return;
    }
    const parsed = ingestPayloadSchema.safeParse(r.payload);
    if (!parsed.success) {
      failed.push({
        unit: r.unit,
        code: "SCHEMA",
        message:
          "转出来的 payload 没过 kb-ingest/v1 自检：\n" +
          z.prettifyError(parsed.error),
      });
      return;
    }
    units.push({
      unit: r.unit,
      form,
      payload: parsed.data,
      n: r.n,
      notes: r.notes,
    });
  };

  if (form === "群卷题单") {
    收单元(搬题单(ctx, json as unknown[]));
  } else {
    const 册们 = form === "对象根" ? [json as 对象] : (json as unknown[]);
    for (const [ci, 册raw] of 册们.entries()) {
      if (!是对象(册raw)) {
        skipped.push({ unit: `[${ci}]`, why: `不是对象（${样本(册raw)}）` });
        continue;
      }
      if (册raw.契约 !== PUNCH_CONTRACT) {
        skipped.push({
          unit: 非空字符串(册raw.册) ?? `[${ci}]`,
          why: `契约=${JSON.stringify(册raw.契约 ?? null)}，不是 ${PUNCH_CONTRACT} —— 认不出就不转（不猜）`,
        });
        continue;
      }
      const 版本们 = Array.isArray(册raw.版本) ? 册raw.版本 : [];
      if (版本们.length === 0) {
        skipped.push({
          unit: 非空字符串(册raw.册) ?? `[${ci}]`,
          why: "没有 版本[]（登记型元素）",
        });
        continue;
      }
      for (const [vi, 版本raw] of 版本们.entries()) {
        if (!是对象(版本raw)) {
          skipped.push({
            unit: `${非空字符串(册raw.册) ?? `[${ci}]`}·版本[${vi}]`,
            why: "版本元素不是对象",
          });
          continue;
        }
        收单元(搬一册(ctx, 册raw, 版本raw, { 册序: ci, 版序: vi }));
      }
    }
  }

  const items = units.reduce((s, u) => s + u.n, 0);
  if (units.length === 0 && failed.length === 0) {
    ctx.warnings.add(
      "一个可投单元都没有（全被跳过）—— 检查是不是喂了一份只有合刊/登记元素的文件。",
    );
  }

  return {
    form,
    units,
    failed,
    skipped,
    unknownFields: ctx.unknown,
    normalizations: [...ctx.normalizations],
    warnings: [...ctx.warnings],
    counts: {
      units: units.length,
      items,
      failed: failed.length,
      skipped: skipped.length,
    },
  };
}
