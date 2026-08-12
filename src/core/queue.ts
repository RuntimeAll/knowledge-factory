/**
 * core/queue.ts —— 审查队列原语（AI:PRD-002 · 002-D）
 *
 * review_queue 是「人裁一下」的唯一收口：resolve_kp 问不出来的说法（kind='kp低置信'）、
 * agent 想改 KG 的提议（kind='KG提议'）都在这张表上排队。本文件只干两件事：
 *   listQueueItems / getQueueItem —— 读（治理页列表与详情）
 *   verdictQueueItem              —— 裁（open → passed/rejected），经 withCoreWrite
 * 外加一枚组合原语 passQueueWithAlias（「补条别名就算结案」，见函数注释）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 两条本文件的铁律
 *
 * ① **终态不可再裁**。state 只允许 open → passed/rejected 这一跳；已终态的工单再判
 *    直接报错，而不是「顺手覆盖一下」—— 覆盖掉的是上一次裁决的人、时间和理由，
 *    而那三样正是这张表存在的全部意义。
 *
 * ② **verdict_note 是正文，不是摘要**。它落库（区别于 KgOptions.note 只进 args 的
 *    sha256 摘要）：驳回一条提议时「为什么驳」必须留得下来，不然下次同样的提议
 *    还会再来一遍，而没人记得上次为什么否了它。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { reviewQueue } from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import { addKpAlias, type AliasAddResult } from "./kg";
import { nowLocalISO } from "./time";
import { withCoreWrite } from "./write";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 建表 CHECK 里的固定值表（改字要连同 migration 一起改） */
export const QUEUE_KINDS = [
  "kp低置信",
  "图片",
  "KG提议",
  "模型转正",
  "新题草稿",
  "隔离",
  "抽查",
  "其他",
] as const;

export type QueueKind = (typeof QUEUE_KINDS)[number];

export const QUEUE_STATES = ["open", "passed", "rejected"] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** 裁决只有两个方向：过 / 不过（open 不是裁决结果，是没裁） */
export type QueueVerdict = "passed" | "rejected";

export interface QueueItem {
  id: string;
  kind: string | null;
  /** 多态弱引用（低置信工单不带 ref，见 resolve.ts） */
  refType: string | null;
  refId: string | null;
  /** 提议变更集/低置信上下文正文（JSON 串，原样端出，不在 core 里解释） */
  payloadJson: string | null;
  reason: string | null;
  signalsJson: string | null;
  state: string;
  verdictBy: string | null;
  verdictNote: string | null;
  createdAt: string | null;
  verdictAt: string | null;
}

/**
 * 稳定错误码（页面/MCP 照它翻人话，改文案别顺手改码）：
 *   INVALID_INPUT          入参没过 zod
 *   QUEUE_NOT_FOUND        工单不存在
 *   QUEUE_ALREADY_DECIDED  工单已终态（passed/rejected），不重复裁
 */
export const QUEUE_ERROR_CODES = [
  "INVALID_INPUT",
  "QUEUE_NOT_FOUND",
  "QUEUE_ALREADY_DECIDED",
] as const;

export type QueueErrorCode = (typeof QUEUE_ERROR_CODES)[number];

export class QueueError extends Error {
  readonly code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new QueueError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

const 队列id = z
  .string()
  .trim()
  .refine(
    (s) => /^rq_[0-9A-HJKMNP-TV-Z]{26}$/.test(s),
    "工单 id 形状不对：应形如 rq_<26位ULID>",
  );

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export interface ListQueueOptions {
  /** 只看某一类（不传=全部） */
  kind?: string;
  /** 只看某一态（不传=全部；治理页默认传 'open'） */
  state?: QueueState;
  /** 默认 50，上限 500 */
  limit?: number;
  handle?: CoreDbHandle;
}

const 列表入参 = z.object({
  kind: z.string().trim().min(1).optional(),
  state: z.enum(QUEUE_STATES).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

/**
 * 列工单（新的在前）。
 * 🔴 只读，不判、不改状态 —— 列表页刷十次也不会动一行。
 */
export async function listQueueItems(
  opts: ListQueueOptions = {},
): Promise<QueueItem[]> {
  const v = parseInput(列表入参, {
    kind: opts.kind,
    state: opts.state,
    limit: opts.limit,
  });
  const h = opts.handle ?? (await getCoreDb());

  const 条件 = [
    ...(v.kind ? [eq(reviewQueue.kind, v.kind)] : []),
    ...(v.state ? [eq(reviewQueue.state, v.state)] : []),
  ];

  const rows = await h.db
    .select()
    .from(reviewQueue)
    .where(条件.length > 0 ? and(...条件) : undefined)
    // created_at 可空（老行/外部写入），并列时再按 id（ULID 自带时序）兜底
    .orderBy(desc(reviewQueue.createdAt), desc(reviewQueue.id))
    .limit(v.limit);

  return rows.map(转成契约);
}

/** 取一条；没有就 null（详情页自己决定怎么说「没这条」） */
export async function getQueueItem(
  id: string,
  opts: { handle?: CoreDbHandle } = {},
): Promise<QueueItem | null> {
  const qid = parseInput(队列id, id);
  const h = opts.handle ?? (await getCoreDb());
  const rows = await h.db
    .select()
    .from(reviewQueue)
    .where(eq(reviewQueue.id, qid));
  const row = rows[0];
  return row ? 转成契约(row) : null;
}

/** 按 kind 数未决工单（总览页的「开放工单数」） */
export async function countOpenQueueByKind(
  opts: { handle?: CoreDbHandle } = {},
): Promise<{ kind: string; count: number }[]> {
  const h = opts.handle ?? (await getCoreDb());
  const rows = await h.db
    .select({ kind: reviewQueue.kind, c: sql<number>`count(*)` })
    .from(reviewQueue)
    .where(eq(reviewQueue.state, "open"))
    .groupBy(reviewQueue.kind);
  return rows.map((r) => ({
    kind: r.kind ?? "（未分类）",
    count: Number(r.c),
  }));
}

type QueueRow = typeof reviewQueue.$inferSelect;

function 转成契约(row: QueueRow): QueueItem {
  return {
    id: row.id,
    kind: row.kind,
    refType: row.refType,
    refId: row.refId,
    payloadJson: row.payloadJson,
    reason: row.reason,
    signalsJson: row.signalsJson,
    state: row.state,
    verdictBy: row.verdictBy,
    verdictNote: row.verdictNote,
    createdAt: row.createdAt,
    verdictAt: row.verdictAt,
  };
}

// ---------------------------------------------------------------------------
// 裁
// ---------------------------------------------------------------------------

export interface VerdictOptions {
  /** 🔴 谁裁的，必填且落库（'human' / 具体人名 / 'agent'）——没有署名的裁决等于没裁 */
  by: string;
  /** 裁决理由：**正文落库**（区别于别处的 note 只进 args 摘要） */
  note?: string;
  /** 审计 actor，默认 'human'（裁决按定义是人的动作；agent 自动裁请显式传） */
  actor?: AuditActor;
  handle?: CoreDbHandle;
  /** 审计里记的工具名，默认 'verdictQueueItem'（一次性脚本可签自己的批次名） */
  tool?: string;
}

export interface QueueVerdictResult {
  id: string;
  verdict: QueueVerdict;
  by: string;
  verdictAt: string;
  /** 对应的审计行序号 */
  seq: number;
}

const 裁决入参 = z.object({
  verdict: z.enum(["passed", "rejected"]),
  by: z.string().trim().min(1, "裁决人不能为空（谁裁的必须留名）"),
  note: z
    .string()
    .trim()
    .transform((s) => (s === "" ? null : s))
    .nullish(),
});

/**
 * 裁一条工单：open → passed/rejected，同时记下谁裁的、什么时候、为什么。
 *
 * 🔴 已终态的工单再判一次 = 报错（QUEUE_ALREADY_DECIDED），不覆盖。
 *    报错文案里带上「上次是谁、什么时候裁的」—— 撞上这个错的人多半是
 *    开着两个标签页，需要知道的是「另一边已经处理过了」而不是「失败了」。
 */
export async function verdictQueueItem(
  id: string,
  verdict: QueueVerdict,
  opts: VerdictOptions,
): Promise<QueueVerdictResult> {
  const qid = parseInput(队列id, id);
  const v = parseInput(裁决入参, {
    verdict,
    by: opts.by,
    note: opts.note,
  });
  const ts = nowLocalISO();

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "human",
      tool: opts.tool ?? "verdictQueueItem",
      args: { id: qid, verdict: v.verdict, by: v.by, note: v.note },
    },
    async (tx) => {
      const rows = await tx
        .select({
          id: reviewQueue.id,
          state: reviewQueue.state,
          verdictBy: reviewQueue.verdictBy,
          verdictAt: reviewQueue.verdictAt,
        })
        .from(reviewQueue)
        .where(eq(reviewQueue.id, qid));
      const row = rows[0];
      if (!row) {
        throw new QueueError("QUEUE_NOT_FOUND", `工单 ${qid} 不存在`);
      }
      if (row.state !== "open") {
        throw new QueueError(
          "QUEUE_ALREADY_DECIDED",
          `工单 ${qid} 已经是 ${row.state} 了` +
            `（${row.verdictBy ?? "未记名"} 于 ${row.verdictAt ?? "时间未知"} 裁的）` +
            `——终态不重裁，要翻案请另开工单说明理由`,
        );
      }
      await tx
        .update(reviewQueue)
        .set({
          state: v.verdict,
          verdictBy: v.by,
          verdictNote: v.note ?? null,
          verdictAt: ts,
        })
        .where(eq(reviewQueue.id, qid));
      return [{ table: "review_queue", id: qid, op: "update" as const }];
    },
    opts.handle,
  );

  return {
    id: qid,
    verdict: v.verdict,
    by: v.by,
    verdictAt: ts,
    seq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// 组合原语：补别名结案
// ---------------------------------------------------------------------------

export interface PassWithAliasInput {
  /** 别名挂到哪个考点（🔴 必须是 resolve_kp 给的真 id） */
  kpId: string;
  /** 要补的说法（多半就是工单 payload 里那句 query） */
  alias: string;
  by: string;
  note?: string;
}

export interface PassWithAliasResult {
  alias: AliasAddResult;
  verdict: QueueVerdictResult;
}

/**
 * 「补条别名就算结案」——低置信工单（kind='kp低置信'）最常见的处置方式：
 * agent 问了个词表里没有的说法，人认出它指的是哪个考点，把说法补进词表，工单判过。
 *
 * 🔴 两步是**两笔 core 写**（两条审计行），不是一个事务：
 *    别名先写、工单后判。中途失败（多半是另一边已经裁过了）会停在
 *    「别名已补、工单还开着」—— 这个中间态无害且可重跑：别名本来就该补，
 *    工单该谁裁还是谁裁。反过来（先判后补）失败才真难受：工单结了、词表没补，
 *    下次同一句话照样问不出来，而队列里再也没有这条线索。
 */
export async function passQueueWithAlias(
  queueId: string,
  input: PassWithAliasInput,
  opts: { actor?: AuditActor; handle?: CoreDbHandle } = {},
): Promise<PassWithAliasResult> {
  const qid = parseInput(队列id, queueId);
  const actor = opts.actor ?? "human";

  const alias = await addKpAlias(input.kpId, input.alias, {
    actor,
    handle: opts.handle,
    note: `工单 ${qid} 快捷加别名`,
  });

  const verdict = await verdictQueueItem(qid, "passed", {
    by: input.by,
    note: input.note ?? `已把「${input.alias}」补进 ${input.kpId} 的别名词表`,
    actor,
    handle: opts.handle,
  });

  return { alias, verdict };
}
