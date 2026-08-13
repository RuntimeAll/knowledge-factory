/**
 * core/sku.ts —— SKU 登记原语（AI:PRD-005 · 005-B）
 *
 * 「一本册子」在这套系统里由三张表描述（M1 §3.E）：
 *   sku          它是什么（打卡/专项/合刊/讲义/练习册/卷）、叫什么、按什么配方出的
 *   sku_item     它装了哪些题、第几位（🔴 ord 就是卷面题号，学情回流按它对位）
 *   sku_output   它出了哪些件（题目卷 PDF / 答案卷 PDF / 宣传图 / 物料）
 * 外加两座**通向圣域的桥**：
 *   grading_task_map    打卡任务 ↔ 天卷 SKU（1:1）
 *   grading_batch_link  批改批次 ↔ 任务（存量批次的人工补录桥）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 幽灵映射防线（001 疑问附录的执行落地）—— 本文件存在的头号理由
 *
 *   `grading_task_map.task_id` / `grading_batch_link.batch_id` 是 **INTEGER PRIMARY KEY**，
 *   在 SQLite 里那是 **rowid 的别名**：INSERT 时不给值，它**不会报错**，
 *   而是**静默自增**一个号 —— 于是库里凭空多出一条「task_id=1 指向某 sku」的映射，
 *   而圣域 tasks 表里那个 1 号任务跟它毫无关系。这条幽灵映射会：
 *     · 让对账 C4(b)/(c) 拿错的 nq 去比题单数（红旗指向错误的地方）；
 *     · 让学情回流把甲的作答算到乙的卷子上（错得悄无声息）。
 *
 *   所以本文件对这两张表只有一种写法：
 *     ① **显式传值**（zod 强制必填正整数，不给就报错，绝不让它走自增）；
 *     ② **入库前查只读侧存在性**（getGradingDb → tasks/batches），查不到就拒。
 *   圣域是**只读参照物**：任务不是我们建的，我们只登记「哪本册子对应它」。
 *
 * 🔴 `sku_item.question_id` 在建表里可空（M1 给「占位题位」留的口子），
 *    但**写侧一律强制非空**：一个没有题的题位，在出卷、对账、学情三处都只会
 *    变成一个查不出原因的窟窿。要占位请先建题（哪怕是草稿题）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 全部写经 withCoreWrite（开闸/业务写/审计/关闸 同一事务），无例外。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  asset,
  // 表对象在这儿换个名字，只为别和函数名 mapGradingTask / linkGradingBatch 混
  gradingBatchLink as gradingBatchLinkTable,
  gradingTaskMap as gradingTaskMapTable,
  question,
  sku,
  skuItem,
  skuOutput,
} from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { dbUrlToPath } from "./backup";
import { getCoreDb, type CoreDbHandle } from "./db";
import { assetFileName } from "./gates/ingest-figure.gate";
import { getGradingDb } from "./grading";
import { newId } from "./ids";
import { assetsDirFor, rowRefId } from "./integrity";
import { stemBrief } from "./retrieval";
import { nowLocalISO } from "./time";
import { withCoreWrite, type RowRef } from "./write";

// ---------------------------------------------------------------------------
// 契约（字典值与建表 CHECK 一字不差）
// ---------------------------------------------------------------------------

export const SKU_TYPES = [
  "打卡",
  "专项",
  "合刊",
  "讲义",
  "练习册",
  "卷",
] as const;
export type SkuType = (typeof SKU_TYPES)[number];

export const SKU_STATUSES = ["draft", "active", "retired"] as const;
export type SkuStatus = (typeof SKU_STATUSES)[number];

export const SKU_OUTPUT_KINDS = [
  "pdf_q",
  "pdf_a",
  "png",
  "物料",
  "其他",
] as const;
export type SkuOutputKind = (typeof SKU_OUTPUT_KINDS)[number];

/**
 * 稳定错误码（MCP/页面照它翻人话，改文案别顺手改码）：
 *   INVALID_INPUT       入参没过 zod
 *   SKU_NOT_FOUND       册子不存在
 *   QUESTION_NOT_FOUND  题不存在（🔴 sku_item 不许挂空题位）
 *   ORD_TAKEN           这个位次已经有题了（sku_item 主键 (sku_id, ord)）
 *   QUESTION_TAKEN      这道题已经在这本册里了（(sku_id, question_id) 唯一）
 *   TASK_NOT_FOUND      圣域 tasks 里没有这个 task_id（🔴 幽灵映射防线）
 *   TASK_TAKEN          这个 task 已经登记过别的册子（grading_task_map 主键）
 *   SKU_TAKEN           这本册子已经挂在别的 task 上（sku_id 唯一）
 *   BATCH_NOT_FOUND     圣域 batches 里没有这个 batch_id
 *   BATCH_TAKEN         这个批次已经补录过
 *   FILE_MISSING        产出文件不在盘上/读不动
 *   GRADING_UNREACHABLE 圣域只读连接开不了（配置/权限/Node 版本）
 */
export const SKU_ERROR_CODES = [
  "INVALID_INPUT",
  "SKU_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "ORD_TAKEN",
  "QUESTION_TAKEN",
  "TASK_NOT_FOUND",
  "TASK_TAKEN",
  "SKU_TAKEN",
  "BATCH_NOT_FOUND",
  "BATCH_TAKEN",
  "FILE_MISSING",
  "GRADING_UNREACHABLE",
] as const;
export type SkuErrorCode = (typeof SKU_ERROR_CODES)[number];

export class SkuError extends Error {
  readonly code: SkuErrorCode;
  constructor(code: SkuErrorCode, message: string) {
    super(message);
    this.name = "SkuError";
    this.code = code;
  }
}

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new SkuError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

/** JSON 列的入参：给对象就 stringify，给串就原样（已经是 JSON 的不二次编码） */
function jsonCol(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  return JSON.stringify(v);
}

const skuId校验 = z
  .string()
  .trim()
  .refine(
    (s) => /^sku_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "sku id 形状不对：应形如 sku_<26位ULID>（来自 register_sku 的返回，别自己编）",
  );

// ---------------------------------------------------------------------------
// ① 建册
// ---------------------------------------------------------------------------

export interface RegisterSkuInput {
  type: SkuType;
  name: string;
  /** 出这本册的配方（生成器/参数/天数…），对象或 JSON 串都行 */
  recipeJson?: unknown;
  /** 版式键（punch 的 layout_key） */
  layout?: string;
  /** 🔴 Q12：生产动作显式带版本（"人教七上" / "浙教"） */
  editionCtx?: string;
  status?: SkuStatus;
  actor?: AuditActor;
  handle?: CoreDbHandle;
}

export interface RegisterSkuResult {
  skuId: string;
  name: string;
  type: SkuType;
  status: SkuStatus;
  createdAt: string;
  seq: number;
}

const 建册入参 = z.object({
  type: z.enum(SKU_TYPES),
  name: z.string().trim().min(1, "册名不能为空（它是人认这本册子的唯一凭据）"),
  recipeJson: z.unknown().optional(),
  layout: z.string().trim().min(1).optional(),
  editionCtx: z.string().trim().min(1).optional(),
  status: z.enum(SKU_STATUSES).default("draft"),
});

/**
 * 登记一本册子（SKU）。
 * 🔴 默认 `draft`：登记 ≠ 上架。改态走 {@link setSkuStatus}，那一步才是「开卖」。
 */
export async function registerSku(
  input: RegisterSkuInput,
): Promise<RegisterSkuResult> {
  const v = parseInput(建册入参, {
    type: input.type,
    name: input.name,
    recipeJson: input.recipeJson,
    layout: input.layout,
    editionCtx: input.editionCtx,
    status: input.status,
  });
  const id = newId("sku");
  const ts = nowLocalISO();

  const receipt = await withCoreWrite(
    {
      actor: input.actor ?? "agent",
      tool: "registerSku",
      args: { id, type: v.type, name: v.name, status: v.status },
    },
    async (tx) => {
      await tx.insert(sku).values({
        id,
        type: v.type,
        name: v.name,
        recipeJson: jsonCol(v.recipeJson),
        layout: v.layout ?? null,
        editionCtx: v.editionCtx ?? null,
        status: v.status,
        createdAt: ts,
      });
      return [{ table: "sku", id, op: "insert" as const }];
    },
    input.handle,
  );

  return {
    skuId: id,
    name: v.name,
    type: v.type,
    status: v.status,
    createdAt: ts,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// ② 装题
// ---------------------------------------------------------------------------

export interface SkuItemInput {
  questionId: string;
  /** 位次 = 卷面题号（🔴 学情回流按 ord=qno 对位，不是随便一个排序字段） */
  ord: number;
}

export interface AddSkuItemsResult {
  skuId: string;
  added: SkuItemInput[];
  /** 装完这本册一共几题（= 对账 C4(c) 要与 tasks.nq 相等的那个数） */
  total: number;
  seq: number;
}

const 装题入参 = z.object({
  items: z
    .array(
      z.object({
        questionId: z
          .string()
          .trim()
          .min(1, "questionId 不能为空（🔴 sku_item 不许挂空题位）"),
        ord: z.number().int().positive("ord 从 1 起（它就是卷面题号）"),
      }),
    )
    .min(1, "items 不能是空的"),
});

/**
 * 往册子里装题。
 *
 * 🔴 三道前置校验（撞了给**人话**，不给 SQLite 的 UNIQUE 原文）：
 *    册子在不在 / 题在不在 / 位次与题在这本册里有没有占过。
 * 🔴 一次事务装完：装一半的册子比没装更难查。
 */
export async function addSkuItems(
  skuId: string,
  items: SkuItemInput[],
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<AddSkuItemsResult> {
  const id = parseInput(skuId校验, skuId);
  const v = parseInput(装题入参, { items });
  const h = opts.handle ?? (await getCoreDb());

  const 册 = await h.db.select().from(sku).where(eq(sku.id, id)).limit(1);
  if (!册[0]) {
    throw new SkuError(
      "SKU_NOT_FOUND",
      `册子 ${id} 不存在 —— 先 register_sku。`,
    );
  }

  // 批内自撞（同一次调用里给了两个一样的 ord / question）
  const 见过ord = new Map<number, string>();
  const 见过题 = new Map<string, number>();
  for (const it of v.items) {
    const 旧 = 见过ord.get(it.ord);
    if (旧 !== undefined) {
      throw new SkuError(
        "ORD_TAKEN",
        `本次入参里 ord=${it.ord} 出现了两次（${旧} 与 ${it.questionId}）—— 一个位次只能坐一道题。`,
      );
    }
    见过ord.set(it.ord, it.questionId);
    const 旧位 = 见过题.get(it.questionId);
    if (旧位 !== undefined) {
      throw new SkuError(
        "QUESTION_TAKEN",
        `本次入参里题 ${it.questionId} 出现了两次（ord=${旧位} 与 ${it.ord}）—— 同一本册里一道题只装一次。`,
      );
    }
    见过题.set(it.questionId, it.ord);
  }

  // 题必须真存在（🔴 挂一个不存在的题 id = 出卷时才发现的窟窿）
  const qids = [...见过题.keys()];
  const 有的 = await h.db
    .select({ id: question.id })
    .from(question)
    .where(inArray(question.id, qids));
  const 有 = new Set(有的.map((r) => r.id));
  const 缺 = qids.filter((x) => !有.has(x));
  if (缺.length > 0) {
    throw new SkuError(
      "QUESTION_NOT_FOUND",
      `这些题在库里查无此行：${缺.slice(0, 8).join("、")}${缺.length > 8 ? " …" : ""}` +
        `（共 ${缺.length} 个）—— 题 id 一律来自 search_questions / kb_ingest 的返回，禁编造。`,
    );
  }

  // 与已装的撞
  const 已装 = await h.db
    .select({ ord: skuItem.ord, questionId: skuItem.questionId })
    .from(skuItem)
    .where(eq(skuItem.skuId, id));
  const 占位 = new Map(已装.map((r) => [Number(r.ord), r.questionId]));
  const 已有题 = new Map(
    已装
      .filter((r) => r.questionId !== null)
      .map((r) => [r.questionId!, Number(r.ord)]),
  );
  for (const it of v.items) {
    const 坐着 = 占位.get(it.ord);
    if (坐着 !== undefined) {
      throw new SkuError(
        "ORD_TAKEN",
        `《${册[0].name}》的第 ${it.ord} 位已经坐着 ${坐着 ?? "（空题位）"} 了` +
          `（sku_item 主键是 (sku_id, ord)）—— 要换题先把那一位撤下来，别撞位。`,
      );
    }
    const 位 = 已有题.get(it.questionId);
    if (位 !== undefined) {
      throw new SkuError(
        "QUESTION_TAKEN",
        `题 ${it.questionId} 已经在《${册[0].name}》的第 ${位} 位了` +
          `（(sku_id, question_id) 唯一）—— 同一本册里一道题只装一次。`,
      );
    }
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "addSkuItems",
      args: { skuId: id, n: v.items.length },
    },
    async (tx) => {
      const rowRefs: RowRef[] = [];
      for (const it of v.items) {
        await tx.insert(skuItem).values({
          skuId: id,
          questionId: it.questionId,
          ord: it.ord,
        });
        rowRefs.push({
          table: "sku_item",
          id: rowRefId(id, it.ord),
          op: "insert",
        });
      }
      return rowRefs;
    },
    opts.handle,
  );

  const total = 已装.length + v.items.length;
  return { skuId: id, added: v.items, total, seq: receipt.seq };
}

// ---------------------------------------------------------------------------
// ③ 登记产出（成品文件）
// ---------------------------------------------------------------------------

export interface RegisterSkuOutputInput {
  kind: SkuOutputKind;
  /** 成品文件的绝对路径（或相对进程 cwd）。🔴 会读它算 sha256 并拷进资产仓 */
  filePath: string;
  /** 登记附注（这份是哪一版、发的是哪条网盘链接…） */
  note?: string;
  actor?: AuditActor;
  handle?: CoreDbHandle;
  /** 资产仓根，默认 = 库文件同级的 assets/（测试传副本目录） */
  assetsDir?: string;
}

export interface RegisterSkuOutputResult {
  outputId: string;
  skuId: string;
  kind: SkuOutputKind;
  assetId: string;
  hash: string;
  bytes: number;
  /** 仓内文件名 = `<sha256><ext>`（内容寻址，同一份文件全库一行） */
  fileName: string;
  /** true = 这份内容仓里本来就有（同 hash 复用，没有重复占盘） */
  reused: boolean;
  seq: number;
}

const 产出入参 = z.object({
  kind: z.enum(SKU_OUTPUT_KINDS),
  filePath: z.string().trim().min(1, "filePath 不能为空"),
  note: z.string().trim().min(1).optional(),
});

/**
 * 登记一份成品产出（题目卷 PDF / 答案卷 PDF / 宣传图 / 物料）。
 *
 * 🔴 与题级配图**同一套资产口径**（003 的 `gates/ingest-figure.gate.ts`）：
 *    内容 sha256 → `data/assets/<hash><ext>`，`asset.hash` 上有 UNIQUE ⇒ 同一份文件全库一行。
 *    好处不是省盘，是**「库里查不到登记行的文件视同不存在」**这条规矩得以贯彻到成品层：
 *    发出去的那份 PDF，事后能用 hash 一字节不差地对回来。
 *
 * 🔴 M1 不改 schema，sku_output 没有 note 列 —— 登记附注寄存在 `gate_results_json`
 *    （那一列本来就是「这份产出的账」），连同源路径与字节数一起，写清楚不藏着。
 */
export async function registerSkuOutput(
  skuId: string,
  input: RegisterSkuOutputInput,
): Promise<RegisterSkuOutputResult> {
  const id = parseInput(skuId校验, skuId);
  const v = parseInput(产出入参, {
    kind: input.kind,
    filePath: input.filePath,
    note: input.note,
  });
  const h = input.handle ?? (await getCoreDb());

  const 册 = await h.db.select().from(sku).where(eq(sku.id, id)).limit(1);
  if (!册[0]) {
    throw new SkuError(
      "SKU_NOT_FOUND",
      `册子 ${id} 不存在 —— 先 register_sku。`,
    );
  }

  const abs = isAbsolute(v.filePath)
    ? v.filePath
    : resolve(process.cwd(), v.filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new SkuError(
      "FILE_MISSING",
      `产出文件不在盘上（或不是文件）：${abs} —— 路径写错了，或者册子还没出件就先来登记了。`,
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (e) {
    throw new SkuError(
      "FILE_MISSING",
      `产出文件读不动：${abs}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
  const hash = createHash("sha256").update(buf).digest("hex");
  const ext = extname(abs).toLowerCase();
  const fileName = assetFileName(hash, ext);

  const assetsDir = input.assetsDir ?? assetsDirFor(dbUrlToPath(h.url));
  mkdirSync(assetsDir, { recursive: true });
  const target = join(assetsDir, fileName);
  const reused = existsSync(target);
  if (!reused) copyFileSync(abs, target);

  const outputId = newId("skuout");
  const ts = nowLocalISO();
  let assetId = "";

  try {
    const receipt = await withCoreWrite(
      {
        actor: input.actor ?? "agent",
        tool: "registerSkuOutput",
        args: { skuId: id, kind: v.kind, hash },
      },
      async (tx) => {
        const rowRefs: RowRef[] = [];
        const 已有 = await tx
          .select({ id: asset.id })
          .from(asset)
          .where(eq(asset.hash, hash))
          .limit(1);
        if (已有[0]?.id) {
          assetId = 已有[0].id;
        } else {
          assetId = newId("asset");
          await tx.insert(asset).values({
            id: assetId,
            path: fileName,
            hash,
            kind: ext.replace(/^\./, "") || null,
            bytes: buf.byteLength,
            createdAt: ts,
          });
          rowRefs.push({ table: "asset", id: assetId, op: "insert" });
        }

        await tx.insert(skuOutput).values({
          id: outputId,
          skuId: id,
          kind: v.kind,
          assetId,
          gateResultsJson: JSON.stringify({
            note: v.note ?? null,
            src: abs,
            bytes: buf.byteLength,
          }),
          createdAt: ts,
        });
        rowRefs.push({ table: "sku_output", id: outputId, op: "insert" });
        return rowRefs;
      },
      input.handle,
    );

    return {
      outputId,
      skuId: id,
      kind: v.kind,
      assetId,
      hash,
      bytes: buf.byteLength,
      fileName,
      reused,
      seq: receipt.seq,
    };
  } catch (e) {
    // 🔴 文件系统不在事务里，只能补偿：事务挂了就把**本次新拷的**删掉
    //    （已存在的同 hash 文件是别人的，动不得）——否则对账 C1(c) 会红
    //    「有文件查不到登记行」。
    if (!reused) {
      try {
        rmSync(target, { force: true });
      } catch {
        /* 删不掉留个孤儿文件，C1(c) 会亮红旗提醒人清 —— 不掩盖原始异常 */
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// ④ 改态
// ---------------------------------------------------------------------------

export interface SetSkuStatusResult {
  skuId: string;
  from: string | null;
  to: SkuStatus;
  seq: number;
}

/**
 * 改册子的态：draft（登记了）→ active（在售）→ retired（下架）。
 * 🔴 不校验流转方向（下架的册子重新上架是真事），但每一跳都留审计行。
 */
export async function setSkuStatus(
  skuId: string,
  status: SkuStatus,
  opts: { note?: string; actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<SetSkuStatusResult> {
  const id = parseInput(skuId校验, skuId);
  const to = parseInput(z.enum(SKU_STATUSES), status);
  const h = opts.handle ?? (await getCoreDb());

  const rows = await h.db
    .select({ status: sku.status })
    .from(sku)
    .where(eq(sku.id, id))
    .limit(1);
  if (!rows[0]) {
    throw new SkuError("SKU_NOT_FOUND", `册子 ${id} 不存在。`);
  }

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "setSkuStatus",
      args: { skuId: id, to, note: opts.note ?? null },
    },
    async (tx) => {
      await tx.update(sku).set({ status: to }).where(eq(sku.id, id));
      return [{ table: "sku", id, op: "update" as const }];
    },
    opts.handle,
  );

  return { skuId: id, from: rows[0].status, to, seq: receipt.seq };
}

// ---------------------------------------------------------------------------
// ⑤ 通向圣域的两座桥
// ---------------------------------------------------------------------------

export interface MapGradingTaskResult {
  taskId: number;
  skuId: string;
  /** 圣域那条任务的样子（只读回显，证明「真的查过」） */
  task: {
    date: string | null;
    line: string | null;
    book: string | null;
    day: number | null;
    nq: number | null;
    kind: string | null;
  };
  /** 对账 C4(c) 的预判：tasks.nq 与本册题数对不对得上 */
  nqCheck: { nq: number | null; items: number; ok: boolean; note: string };
  createdAt: string;
  seq: number;
}

const 桥入参 = z.object({
  taskId: z
    .number()
    .int()
    .positive(
      "task_id 必须显式给一个正整数 —— 🔴 grading_task_map.task_id 是 rowid 别名，" +
        "不给值它会**静默自增**出一条幽灵映射（谁也查不出来）",
    ),
  note: z.string().trim().min(1).optional(),
});

/**
 * 登记「圣域的打卡任务 ↔ 我们的天卷 SKU」（1:1）。
 *
 * 🔴 两道防线（见文件头「幽灵映射防线」）：
 *    ① taskId 显式必传（zod 拦）；
 *    ② 入库前查**只读侧** tasks.id 真的有这一行（getGradingDb），查不到就拒。
 *
 * 🔴 nq 对不上**不拦**，但如实回显：题可能还没装完（先建桥后装题是常见顺序），
 *    真正的红旗由对账 C4(c) 在事后统一亮 —— 这里给的是「你现在就该知道」的提示。
 */
export async function mapGradingTask(
  taskId: number,
  skuId: string,
  opts: {
    note?: string;
    actor?: AuditActor;
    handle?: CoreDbHandle;
    /** 圣域只读连接串（默认惰性读 env GRADING_DB_URL） */
    gradingUrl?: string;
  } = {},
): Promise<MapGradingTaskResult> {
  const id = parseInput(skuId校验, skuId);
  const v = parseInput(桥入参, { taskId, note: opts.note });
  const h = opts.handle ?? (await getCoreDb());

  const 册 = await h.db.select().from(sku).where(eq(sku.id, id)).limit(1);
  if (!册[0]) {
    throw new SkuError(
      "SKU_NOT_FOUND",
      `册子 ${id} 不存在 —— 先 register_sku。`,
    );
  }

  // ── 防线②：圣域里真的有这个 task 吗 ──────────────────────────────────────
  let grading;
  try {
    grading = await getGradingDb(opts.gradingUrl);
  } catch (e) {
    throw new SkuError(
      "GRADING_UNREACHABLE",
      `圣域（审核.db）只读连接开不了，挂桥前的存在性校验做不了，拒绝登记：${String(e)}`,
    );
  }
  const t = grading.query<{
    id: number;
    date: string | null;
    line: string | null;
    book: string | null;
    day: number | null;
    nq: number | null;
    kind: string | null;
  }>("SELECT id, date, line, book, day, nq, kind FROM tasks WHERE id = ?", [
    v.taskId,
  ])[0];
  if (!t) {
    const 近 = grading
      .query<{ id: number; date: string | null; line: string | null }>(
        "SELECT id, date, line FROM tasks ORDER BY id DESC LIMIT 5",
      )
      .map((r) => `${r.id}(${r.date ?? "?"}/${r.line ?? "?"})`);
    throw new SkuError(
      "TASK_NOT_FOUND",
      `圣域 tasks 里没有 id=${v.taskId} —— 🔴 任务不是我们建的（收卷.py 建的），` +
        "这里只登记「哪本册子对应它」。最近几条任务：" +
        (近.join("、") || "（一条都没有）"),
    );
  }

  // ── 唯一性（撞了给人话，不给 SQLite 原文）──────────────────────────────
  const 撞task = await h.db
    .select()
    .from(gradingTaskMapTable)
    .where(eq(gradingTaskMapTable.taskId, v.taskId))
    .limit(1);
  if (撞task[0]) {
    throw new SkuError(
      "TASK_TAKEN",
      `task_id=${v.taskId} 已经登记给 ${撞task[0].skuId} 了（1 task = 1 天卷，主键唯一）。` +
        "要改指向，先撤掉旧登记 —— 覆盖会让学情悄悄换一本册子对位。",
    );
  }
  const 撞sku = await h.db
    .select()
    .from(gradingTaskMapTable)
    .where(eq(gradingTaskMapTable.skuId, id))
    .limit(1);
  if (撞sku[0]) {
    throw new SkuError(
      "SKU_TAKEN",
      `册子 ${id} 已经挂在 task_id=${撞sku[0].taskId} 上了（sku_id 唯一）。`,
    );
  }

  const 题数 = (
    await h.db
      .select({ ord: skuItem.ord })
      .from(skuItem)
      .where(eq(skuItem.skuId, id))
  ).length;
  const nq = t.nq === null || t.nq === undefined ? null : Number(t.nq);
  const nqOk = nq !== null && nq === 题数;
  const ts = nowLocalISO();

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "mapGradingTask",
      args: { taskId: v.taskId, skuId: id, note: v.note ?? null },
    },
    async (tx) => {
      // 🔴 taskId **显式写入**：这是幽灵映射防线的最后一格
      await tx.insert(gradingTaskMapTable).values({
        taskId: v.taskId,
        skuId: id,
        note: v.note ?? null,
        createdAt: ts,
      });
      return [
        {
          table: "grading_task_map",
          id: String(v.taskId),
          op: "insert" as const,
        },
      ];
    },
    opts.handle,
  );

  return {
    taskId: v.taskId,
    skuId: id,
    task: {
      date: t.date,
      line: t.line,
      book: t.book,
      day: t.day === null ? null : Number(t.day),
      nq,
      kind: t.kind,
    },
    nqCheck: {
      nq,
      items: 题数,
      ok: nqOk,
      note: nqOk
        ? "题单数与 tasks.nq 一致（对账 C4(c) 绿）"
        : nq === null
          ? "🔴 这条任务的 nq 是 NULL（多半是「其他」兜底任务，本来就没有参照卷）——" +
            "对账 C4(c) 会红：无题单的任务不该登记上桥。"
          : `⚠️ tasks.nq=${nq} ≠ 本册题数 ${题数} —— 装完题再回来核一遍；` +
            "不一致会让对账 C4(c) 红（学情按 ord=qno 对位会整体错行）。",
    },
    createdAt: ts,
    seq: receipt.seq,
  };
}

export interface LinkGradingBatchResult {
  batchId: number;
  taskId: number;
  /** 圣域那条批次的样子（只读回显） */
  batch: { student: string | null; day: number | null; round: number | null };
  createdAt: string;
  seq: number;
}

const 补录入参 = z.object({
  batchId: z
    .number()
    .int()
    .positive(
      "batch_id 必须显式给一个正整数 —— 🔴 与 task_id 同理：INTEGER PRIMARY KEY 是 rowid 别名，" +
        "不给值会静默自增出一条幽灵补录",
    ),
  taskId: z.number().int().positive("task_id 必须显式给一个正整数"),
  note: z.string().trim().min(1).optional(),
});

/**
 * 人工补录桥：批改批次 → 打卡任务。
 *
 * 用途：收卷.py 上线前的存量批次没有 slots 行，`(student, day)` 那条自动路挂不上桥
 * （对账 C5 会把它们列成 warn 明细）。这里给人一条「我知道这批是那天的卷」的补录口。
 *
 * 🔴 同样两道防线：batchId/taskId 显式必传 + 双向查只读侧存在性。
 * 🔴 补录**不代表**那个 task 已经登记了 SKU —— C5 仍要求 task 在 grading_task_map 里，
 *    所以这里顺带提示一句（不拦：先补录后建册是合理顺序）。
 */
export async function linkGradingBatch(
  batchId: number,
  taskId: number,
  opts: {
    note?: string;
    actor?: AuditActor;
    handle?: CoreDbHandle;
    gradingUrl?: string;
  } = {},
): Promise<LinkGradingBatchResult> {
  const v = parseInput(补录入参, { batchId, taskId, note: opts.note });
  const h = opts.handle ?? (await getCoreDb());

  let grading;
  try {
    grading = await getGradingDb(opts.gradingUrl);
  } catch (e) {
    throw new SkuError(
      "GRADING_UNREACHABLE",
      `圣域（审核.db）只读连接开不了，补录前的存在性校验做不了，拒绝写入：${String(e)}`,
    );
  }
  const b = grading.query<{
    id: number;
    student: string | null;
    day: number | null;
    round: number | null;
  }>("SELECT id, student, day, round FROM batches WHERE id = ?", [
    v.batchId,
  ])[0];
  if (!b) {
    throw new SkuError(
      "BATCH_NOT_FOUND",
      `圣域 batches 里没有 id=${v.batchId} —— 批次是批改线建的，这里只补一条「它属于哪天的卷」。`,
    );
  }
  const t = grading.query<{ id: number }>("SELECT id FROM tasks WHERE id = ?", [
    v.taskId,
  ])[0];
  if (!t) {
    throw new SkuError(
      "TASK_NOT_FOUND",
      `圣域 tasks 里没有 id=${v.taskId} —— 补录桥的另一端也必须是真任务。`,
    );
  }

  const 撞 = await h.db
    .select()
    .from(gradingBatchLinkTable)
    .where(eq(gradingBatchLinkTable.batchId, v.batchId))
    .limit(1);
  if (撞[0]) {
    throw new SkuError(
      "BATCH_TAKEN",
      `batch_id=${v.batchId} 已经补录到 task_id=${撞[0].taskId} 了（主键唯一，不覆盖）。`,
    );
  }

  const ts = nowLocalISO();
  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: "linkGradingBatch",
      args: { batchId: v.batchId, taskId: v.taskId, note: v.note ?? null },
    },
    async (tx) => {
      await tx.insert(gradingBatchLinkTable).values({
        batchId: v.batchId,
        taskId: v.taskId,
        note: v.note ?? null,
        createdAt: ts,
      });
      return [
        {
          table: "grading_batch_link",
          id: String(v.batchId),
          op: "insert" as const,
        },
      ];
    },
    opts.handle,
  );

  return {
    batchId: v.batchId,
    taskId: v.taskId,
    batch: {
      student: b.student,
      day: b.day === null ? null : Number(b.day),
      round: b.round === null ? null : Number(b.round),
    },
    createdAt: ts,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// 读侧
// ---------------------------------------------------------------------------

export interface SkuItemView {
  ord: number;
  questionId: string | null;
  stemBrief: string | null;
  status: string | null;
}

export interface SkuOutputView {
  id: string;
  kind: string | null;
  assetId: string | null;
  hash: string | null;
  path: string | null;
  bytes: number | null;
  /** gate_results_json 里那份登记附注（note/src/bytes） */
  note: string | null;
  createdAt: string | null;
}

export interface SkuCard {
  id: string;
  type: string | null;
  name: string;
  recipeJson: string | null;
  layout: string | null;
  editionCtx: string | null;
  status: string | null;
  createdAt: string | null;
  items: SkuItemView[];
  outputs: SkuOutputView[];
  /** 挂没挂到圣域任务上（null=没挂） */
  taskMap: {
    taskId: number;
    note: string | null;
    createdAt: string | null;
  } | null;
  counts: { items: number; outputs: number };
}

/** 一本册子的全貌（题单 + 产出 + 挂桥）。只读。 */
export async function getSku(
  skuId: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<SkuCard | null> {
  const id = (skuId ?? "").trim();
  if (!id) return null;
  const h = opts.handle ?? (await getCoreDb());

  const rows = await h.db.select().from(sku).where(eq(sku.id, id)).limit(1);
  const s = rows[0];
  if (!s) return null;

  const items = await h.db
    .select({
      ord: skuItem.ord,
      questionId: skuItem.questionId,
      stem: question.stem,
      status: question.status,
    })
    .from(skuItem)
    .leftJoin(question, eq(question.id, skuItem.questionId))
    .where(eq(skuItem.skuId, id))
    .orderBy(asc(skuItem.ord));

  const outputs = await h.db
    .select({
      id: skuOutput.id,
      kind: skuOutput.kind,
      assetId: skuOutput.assetId,
      gate: skuOutput.gateResultsJson,
      createdAt: skuOutput.createdAt,
      hash: asset.hash,
      path: asset.path,
      bytes: asset.bytes,
    })
    .from(skuOutput)
    .leftJoin(asset, eq(asset.id, skuOutput.assetId))
    .where(eq(skuOutput.skuId, id))
    .orderBy(asc(skuOutput.createdAt), asc(skuOutput.id));

  const bridge = await h.db
    .select()
    .from(gradingTaskMapTable)
    .where(eq(gradingTaskMapTable.skuId, id))
    .limit(1);

  return {
    id: s.id,
    type: s.type,
    name: s.name,
    recipeJson: s.recipeJson,
    layout: s.layout,
    editionCtx: s.editionCtx,
    status: s.status,
    createdAt: s.createdAt,
    items: items.map((r) => ({
      ord: Number(r.ord),
      questionId: r.questionId,
      stemBrief: r.stem === null ? null : stemBrief(r.stem),
      status: r.status,
    })),
    outputs: outputs.map((r) => ({
      id: r.id,
      kind: r.kind,
      assetId: r.assetId,
      hash: r.hash ?? null,
      path: r.path ?? null,
      bytes: r.bytes ?? null,
      note: 读附注(r.gate),
      createdAt: r.createdAt,
    })),
    taskMap: bridge[0]
      ? {
          taskId: Number(bridge[0].taskId),
          note: bridge[0].note,
          createdAt: bridge[0].createdAt,
        }
      : null,
    counts: { items: items.length, outputs: outputs.length },
  };
}

export interface ListSkusOptions {
  type?: SkuType;
  status?: SkuStatus;
  /** 默认 50，上限 500 */
  limit?: number;
  handle?: CoreDbHandle;
}

export interface SkuBrief {
  id: string;
  type: string | null;
  name: string;
  status: string | null;
  createdAt: string | null;
  items: number;
  outputs: number;
  taskId: number | null;
}

/** 列册子（新的在前）。只读。 */
export async function listSkus(
  opts: ListSkusOptions = {},
): Promise<SkuBrief[]> {
  const v = parseInput(
    z.object({
      type: z.enum(SKU_TYPES).optional(),
      status: z.enum(SKU_STATUSES).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    { type: opts.type, status: opts.status, limit: opts.limit },
  );
  const h = opts.handle ?? (await getCoreDb());

  const 条件 = [
    ...(v.type ? [eq(sku.type, v.type)] : []),
    ...(v.status ? [eq(sku.status, v.status)] : []),
  ];
  const rows = await h.db
    .select()
    .from(sku)
    .where(条件.length > 0 ? and(...条件) : undefined)
    .orderBy(desc(sku.createdAt), desc(sku.id))
    .limit(v.limit);

  const out: SkuBrief[] = [];
  for (const s of rows) {
    const items = await h.db
      .select({ ord: skuItem.ord })
      .from(skuItem)
      .where(eq(skuItem.skuId, s.id));
    const outputs = await h.db
      .select({ id: skuOutput.id })
      .from(skuOutput)
      .where(eq(skuOutput.skuId, s.id));
    const bridge = await h.db
      .select({ taskId: gradingTaskMapTable.taskId })
      .from(gradingTaskMapTable)
      .where(eq(gradingTaskMapTable.skuId, s.id))
      .limit(1);
    out.push({
      id: s.id,
      type: s.type,
      name: s.name,
      status: s.status,
      createdAt: s.createdAt,
      items: items.length,
      outputs: outputs.length,
      taskId: bridge[0] ? Number(bridge[0].taskId) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 私器
// ---------------------------------------------------------------------------

/** 产出行的登记附注（寄存在 gate_results_json，见 registerSkuOutput 的注释） */
function 读附注(gate: string | null): string | null {
  if (!gate) return null;
  try {
    const o = JSON.parse(gate) as { note?: unknown };
    return typeof o.note === "string" ? o.note : null;
  } catch {
    return null;
  }
}
