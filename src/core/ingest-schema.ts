/**
 * core/ingest-schema.ts —— kb-ingest/v1 契约的 **机读正本**（AI:PRD-003 · 003-C）
 *
 * 人读正本 = `contracts/kb-ingest-v1.md`（含与 punch-ingest/v1 的字段映射表）。
 * 两份必须同步改：这边加字段 = 那边加一行，别让喂料方照着过期文档写 payload。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 为什么先有 schema 文件再有管道（备料报告 R1 的教训）
 *
 *   punch-ingest/v1 **没有 schema 文件**：契约由「消费端类型声明 + 生产端 payload
 *   构造」两处代码共同定义，唯一的运行期校验是「契约串对不上就 console.log 跳过」
 *   —— 不报错、不退出、当次入库静默少一册。kb-ingest/v1 从第一天就反过来：
 *   **契约是一份文件**，坏料在门口被拒（红灯 + 人话 + 怎么改），绝不静默降级。
 *
 * 🔴 本文件只管**形状**，不管**语义**。
 *   - 形状（这里）：字段在不在、类型对不对、批内 seq 有没有撞、答案与解析是不是全空；
 *   - 语义（gates/）：provenance 四型的必填项、考点 ref 解析得出解析不出、
 *     题面纯不纯、撞没撞库里的老题、算得对算不对。
 *   分开的理由：形状错 = **整批拒**（连逐题闸都不进，因为连题在哪都读不出来）；
 *   语义错 = **逐题拒**（一道坏题不该连累另外 59 道好题）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 常量（全是字典值：改这里 = 改契约，别在别处现编字符串）
// ---------------------------------------------------------------------------

/** 契约串。喂料方必须原样写在 payload.contract 里 */
export const KB_INGEST_CONTRACT = "kb-ingest/v1";

/**
 * 题型字典。
 * 🔴 `计算` 是**唯一**触发「可实算即实算」闸的题型（见 gates/ingest-calc.gate.ts），
 *    所以它不是随口一填的标签 —— 填了 `计算` 就等于宣称「这题机器算得出来」。
 */
export const QTYPES = [
  "计算",
  "填空",
  "选择",
  "解答",
  "判断",
  "作图",
  "证明",
  "应用",
  "其他",
] as const;
export type QType = (typeof QTYPES)[number];

/** 源文档类型（与 source_doc.kind 的建表 CHECK 一字不差） */
export const SOURCE_DOC_KINDS = [
  "册子",
  "群卷",
  "试卷",
  "讲义",
  "其他",
] as const;
export type SourceDocKind = (typeof SOURCE_DOC_KINDS)[number];

/** provenance 四型（与 question.prov_type 的建表 CHECK 一字不差） */
export const PROV_TYPES = ["scan", "pipeline", "manual", "model"] as const;
export type ProvType = (typeof PROV_TYPES)[number];

/** 配图角色：题干图必人审，解析图抽检（分级审核，见 gates/ingest-figure.gate.ts） */
export const FIGURE_ROLES = ["stem", "analysis"] as const;
export type FigureRole = (typeof FIGURE_ROLES)[number];

/** 解答成色三档（与 question.solution_grade 的建表 CHECK 一字不差） */
export const SOLUTION_GRADES = [
  "calc_verified",
  "analysis_only",
  "no_solution",
] as const;
export type SolutionGrade = (typeof SOLUTION_GRADES)[number];

// ---------------------------------------------------------------------------
// zod
// ---------------------------------------------------------------------------

const 非空串 = (名: string) => z.string().trim().min(1, `${名} 不能为空`);

/** 可空文本：null / "" / 全空白 一律归一成 null（下游只判 null，不再判空串） */
const 可空文本 = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    const s = (v ?? "").trim();
    return s.length > 0 ? s : null;
  });

/**
 * 考点引用：`ref` 既可以是考点名（走 resolve_kp 精确命中），也可以是 kp_id。
 * 🔴 一道题至少一个考点、**主考点恰一个**（不显式给 isPrimary 就第一个当主）——
 *    数据模型里 `idx_qkp_primary` 是部分唯一索引，多一个主考点直接 UNIQUE 失败；
 *    与其让 agent 撞 SQLite 的错，不如在这儿说清楚。
 */
export const kpRefSchema = z.object({
  ref: 非空串("kps[].ref（考点名或 kp_id）"),
  isPrimary: z.boolean().optional(),
});

export const figureSchema = z.object({
  role: z.enum(FIGURE_ROLES),
  /** 磁盘路径（绝对，或相对进程 cwd）；文件必须真存在，闸会读它算 hash */
  path: 非空串("figures[].path"),
});

/**
 * 来源四型。**每型缺什么就是缺什么**，由 provenance 闸逐型判（这里只管形状）：
 *   scan     批级 sourceDoc + 题级 page
 *   pipeline pipelineRef（脚本名@版本 + 参数摘要）
 *   model    modelId（且该模型 status='active'）
 *   manual   createdBy（manual 不当无条件逃逸阀）
 */
export const provSchema = z.object({
  type: z.enum(PROV_TYPES),
  page: z.number().int().positive().optional(),
  pipelineRef: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  createdBy: z.string().trim().min(1).optional(),
});

/**
 * punch 兼容位：punch-ingest/v1 的位置三元组 (day, section, seq)。
 * 🔴 入库落 `question_tag`（`src:d1-s有理数混合运算-q3`），**不进 question 的列**——
 *    打卡册的位置是「它在那本册子里的坐标」，不是题目本身的属性。
 */
export const punchPosSchema = z.object({
  day: z.number().int().positive(),
  section: 非空串("punchPos.section"),
  seq: z.number().int().positive(),
});

/** 题级字段表（🔴 唯一一份：批量与单题提议两个 schema 都从它长出来，别抄第二遍） */
const 题级字段 = {
  /** 批内序号（1 起，批内唯一）。红灯定位、quarantine 回溯全靠它 */
  seq: z.number().int().positive(),
  stem: 非空串("stem（题面）"),
  answer: 可空文本,
  analysis: 可空文本,
  qtype: z.enum(QTYPES).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  kps: z.array(kpRefSchema).min(1, "每题至少挂一个考点（禁孤题）"),
  tags: z.array(非空串("tags[]")).optional(),
  figures: z.array(figureSchema).optional(),
  prov: provSchema,
  /** Q12 显式版本适用（如「浙教」）；不填 = 版本通用 */
  editionScope: z.string().trim().min(1).optional(),
  punchPos: punchPosSchema.optional(),
};

/** 题级跨字段校验（两个 schema 共用同一份，语义不许各长各的） */
function 校验单题(
  item: {
    answer: string | null;
    analysis: string | null;
    kps: { isPrimary?: boolean }[];
  },
  ctx: z.RefinementCtx,
): void {
  // 🔴 R3（备料报告）：三路源的答案/解析结构不一 —— 册子与群卷「有 answer 无解析」，
  //    专项卷「有解析无独立 answer」。两种都合法，**都没有**才是红。
  if (item.answer === null && item.analysis === null) {
    ctx.addIssue({
      code: "custom",
      path: ["answer"],
      message:
        "answer 与 analysis 至少要有一个（都没有 = no_solution，这种题进了库也不能出，先补一个再录）",
    });
  }
  const 主 = item.kps.filter((k) => k.isPrimary === true).length;
  if (主 > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["kps"],
      message: `主考点只能有一个，你标了 ${主} 个（其余的去掉 isPrimary 即可；不标则默认第一个为主）`,
    });
  }
}

export const ingestItemSchema = z.object(题级字段).superRefine(校验单题);

/**
 * 单题提议（`propose_question`）的题级变体：**seq 可省**（AI:PRD-003 · 003-D）。
 *
 * 🔴 只差这一个字段：零星录题是「一次一道」，逼 agent 写 `seq: 1` 属于仪式。
 *    单题批在 core 里自动补 1，别的语义（考点必挂、答案解析至少一个、主考点唯一）
 *    与批量录题**一字不差**（同一个 `校验单题`）—— 提议态不是降级通道，
 *    只是「先排队等人看」。
 *
 * 🔴 为什么从字段表重建而不是 `ingestItemSchema.extend/safeExtend`：zod v4 不许在
 *    带 refinement 的对象上**覆盖已有键**（extend 直接抛，safeExtend 在类型上退化成
 *    never）。要改已有键，只能在加 refinement 之前分叉。
 */
export const proposeItemSchema = z
  .object({ ...题级字段, seq: 题级字段.seq.optional() })
  .superRefine(校验单题);

export const sourceDocSchema = z.object({
  title: 非空串("sourceDoc.title"),
  kind: z.enum(SOURCE_DOC_KINDS),
  path: z.string().trim().min(1).optional(),
  /** 源文件内容 hash：同 hash 视为同一份文档，批与批之间自动复用同一行 */
  hash: z.string().trim().min(1).optional(),
  pages: z.number().int().positive().optional(),
  note: z.string().trim().min(1).optional(),
});

export const ingestPayloadSchema = z
  .object({
    contract: z.literal(KB_INGEST_CONTRACT, {
      error: `contract 必须是 "${KB_INGEST_CONTRACT}"（认不出的契约一律整批拒，不像 punch 那样静默跳过）`,
    }),
    /** 喂料方标识：skill/脚本名@版本（落 ingest_batch.source，出事要找得到人） */
    source: 非空串("source（喂料方 skill/脚本@版本）"),
    sourceDoc: sourceDocSchema.optional(),
    items: z.array(ingestItemSchema).min(1, "items 不能是空批"),
  })
  .superRefine((p, ctx) => {
    const 见过 = new Map<number, number>();
    p.items.forEach((it, i) => {
      const 首次 = 见过.get(it.seq);
      if (首次 !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "seq"],
          message: `seq=${it.seq} 在批内重复（items[${首次}] 已经用了）——seq 是红灯定位与隔离回溯的唯一坐标，必须批内唯一`,
        });
      } else {
        见过.set(it.seq, i);
      }
    });
  });

export type KbIngestItem = z.output<typeof ingestItemSchema>;
export type KbProposeItem = z.output<typeof proposeItemSchema>;
export type KbIngestPayload = z.output<typeof ingestPayloadSchema>;
export type KbIngestSourceDoc = z.output<typeof sourceDocSchema>;
export type KbIngestKpRef = z.output<typeof kpRefSchema>;
export type KbIngestFigure = z.output<typeof figureSchema>;
export type KbIngestProv = z.output<typeof provSchema>;
