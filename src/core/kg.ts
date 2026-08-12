/**
 * core/kg.ts —— KG 写原语（AI:PRD-002 · 002-A）
 *
 * 概念层（kp / kp_alias）+ 版本树（edition_tree / edition_node / node_kp_map）的**全部写动作**
 * 都在这儿。导底脚本、KG 治理页、后续的 resolve_kp / 录题挂载一律调本文件，
 * 不许自己开事务、不许自己拼 UPDATE —— 一切经 withCoreWrite（开闸/写/审计/关闸 同一事务）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条本文件的铁律
 *
 * ① **事务里只用回调给的 tx**。db.ts §连接漂移：`transaction()` 之后 `client.execute`
 *    打到的是另一条连接（看不见事务内的写、还可能撞锁）。本文件所有 SQL 一律走 tx。
 *
 * ② **rowRefs 全量上报，复合键一律 rowRefId() 拼**。对账 C1a 是拿
 *    `AUDITED_TABLES[].idExpr` 反查 `audit_log.row_refs_json`，写侧少报一行 = 那行成孤儿 = 红旗。
 *    复合键的键序 = 建表主键顺序（kp_alias=kp_id|alias、node_kp_map=node_id|kp_id、
 *    question_kp=question_id|kp_id、kp_error=kp_id|cause_id、err_code_map=kp_id|err_code）。
 *    🔴 改挂一行 = 老键消失 + 新键出现，两条 rowRef 都要报（只报一条 → 新键那行没有审计覆盖）。
 *
 * ③ **不给「静默吞掉」留口子**。合并时 `INSERT OR IGNORE` 遇到 to 侧已有同题行会把
 *    from 侧那行连同它的 is_primary 一起丢掉 —— 题从此没有主考点，而且全程无红旗。
 *    所以主考点走显式裁决（见 mergeKp §③），别名/映射的去重也逐条计数上报。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 关于 `note`：只进 `args` 的 sha256 摘要（audit_log 不存入参正文），**查不回来**。
 * 要留可读的变更正文得写 ledger（'change' 台账），那是后续卡的事，本文件不越界。
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  editionNode,
  editionTree,
  errCodeMap,
  examModel,
  kp,
  kpAlias,
  kpEdge,
  kpError,
  nodeKpMap,
  questionKp,
} from "~/server/db/schema";
import { type AuditActor, type RowRef } from "./audit";
import { type CoreDbHandle, type CoreTx } from "./db";
import { newId } from "./ids";
import { rowRefId } from "./integrity";
import { nowLocalISO } from "./time";
import { withCoreWrite } from "./write";

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

/**
 * 稳定错误码（MCP 工具层照它翻错误契约，改文案别顺手改码）：
 *   INVALID_INPUT            入参没过 zod
 *   KP_NOT_FOUND             考点不存在
 *   KP_NOT_WRITABLE          考点不是 draft/active（merged 壳与 retired 一律不再改）
 *   KP_ALREADY_MERGED        from 已合并过（消息里带指向）
 *   KP_HAS_REFS              还有活引用，退役被拒（要么先清，要么显式 force）
 *   MERGE_SELF               from == to
 *   MERGE_TARGET_NOT_ACTIVE  合并目标不是 active（禁指向 merged/retired，防环断链）
 *   MERGE_CHAIN_CYCLE        merged_into 链成环
 *   MERGE_CHAIN_TOO_DEEP     merged_into 链超深（多半也是环）
 *   TREE_NOT_FOUND / TREE_NOT_ACTIVE / TREE_ACTIVE_CONFLICT / TREE_DUPLICATE
 *   NODE_NOT_FOUND / NODE_TREE_MISMATCH
 *   ALIAS_NOT_FOUND / MAP_NOT_FOUND
 *   BATCH_BAD_ROW            批量里有坏行（整批回滚）
 */
export const KG_ERROR_CODES = [
  "INVALID_INPUT",
  "KP_NOT_FOUND",
  "KP_NOT_WRITABLE",
  "KP_ALREADY_MERGED",
  "KP_HAS_REFS",
  "MERGE_SELF",
  "MERGE_TARGET_NOT_ACTIVE",
  "MERGE_CHAIN_CYCLE",
  "MERGE_CHAIN_TOO_DEEP",
  "TREE_NOT_FOUND",
  "TREE_NOT_ACTIVE",
  "TREE_ACTIVE_CONFLICT",
  "TREE_DUPLICATE",
  "NODE_NOT_FOUND",
  "NODE_TREE_MISMATCH",
  "ALIAS_NOT_FOUND",
  "MAP_NOT_FOUND",
  "BATCH_BAD_ROW",
] as const;

export type KgErrorCode = (typeof KG_ERROR_CODES)[number];

export class KgError extends Error {
  readonly code: KgErrorCode;
  constructor(code: KgErrorCode, message: string) {
    super(message);
    this.name = "KgError";
    this.code = code;
  }
}

/**
 * 取异常全文（含 cause）。
 * 🔴 drizzle 把底层报错包成 `Failed query: insert into ...`，SQLite 那句
 *    「UNIQUE constraint failed: index 'idx_edtree_active'」躺在 cause 里 ——
 *    不往下扒就只剩一句看不出所以然的 SQL。
 */
function 错误全文(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause =
    e.cause instanceof Error
      ? e.cause.message
      : typeof e.cause === "string"
        ? e.cause
        : "";
  return cause ? `${e.message} (cause: ${cause})` : e.message;
}

/** zod 报错翻成 KgError（带字段路径的人话，别把 ZodError 裸抛给 agent） */
function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new KgError(
      "INVALID_INPUT",
      `入参不合法：\n${z.prettifyError(r.error)}`,
    );
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// 公共入参形状
// ---------------------------------------------------------------------------

/** 每个写原语的尾参：谁在写、备注、以及（测试/脚本用的）库句柄 */
export interface KgOptions {
  /** 审计里的 actor，默认 'agent' */
  actor?: AuditActor;
  /** 备注：🔴 只进 args 摘要（sha256），正文不落库 */
  note?: string;
  /** 连副本库/别的库时传；不传走 getCoreDb() 单例 */
  handle?: CoreDbHandle;
}

/** 一次 KG 写的回执 */
export interface KgReceipt {
  /** 对应的审计行序号 */
  seq: number;
  rowRefs: RowRef[];
}

const idOf = (prefix: "kp" | "tree" | "node") =>
  z
    .string()
    .refine(
      (s) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(s),
      `id 形状不对：应形如 ${prefix}_<26位ULID>（用 newId('${prefix}') 生成）`,
    );

const kpIdSchema = idOf("kp");
const treeIdSchema = idOf("tree");
const nodeIdSchema = idOf("node");
const 非空 = (what: string) => z.string().trim().min(1, `${what}不能为空`);
/** 可空文本：给了就去空白，空串按 null 收（别让 '' 和 NULL 两种空并存） */
const 可空文本 = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .nullish();

/** 🔴 kp.status 建表 CHECK 有四值，但**能被创建**的只有 draft/active：
 *  merged 必须由 mergeKp 打（还要同时写 merged_into），retired 必须走 retireKp（要查引用）。 */
const 可创建考点状态 = z.enum(["draft", "active"]);

// ---------------------------------------------------------------------------
// 小工具（全部在 tx 内跑）
// ---------------------------------------------------------------------------

interface KpRow {
  id: string;
  name: string;
  status: string;
  mergedInto: string | null;
}

async function selectKp(tx: CoreTx, id: string): Promise<KpRow | undefined> {
  const rows = await tx
    .select({
      id: kp.id,
      name: kp.name,
      status: kp.status,
      mergedInto: kp.mergedInto,
    })
    .from(kp)
    .where(eq(kp.id, id));
  return rows[0];
}

/** 取考点，不存在就报错 */
async function mustKp(tx: CoreTx, id: string, 角色 = "考点"): Promise<KpRow> {
  const row = await selectKp(tx, id);
  if (!row) {
    throw new KgError(
      "KP_NOT_FOUND",
      `${角色} ${id} 不存在（🔴 kp_id 一律 resolve 出来，禁编造）`,
    );
  }
  return row;
}

/** 取考点并要求它还能改（draft/active）；merged 壳与 retired 一律拒 */
async function mustWritableKp(tx: CoreTx, id: string): Promise<KpRow> {
  const row = await mustKp(tx, id);
  if (row.status === "merged") {
    throw new KgError(
      "KP_ALREADY_MERGED",
      `考点 ${id} 已合并过，指向 ${row.mergedInto}——改它没意义，去改合并目标`,
    );
  }
  if (row.status !== "draft" && row.status !== "active") {
    throw new KgError(
      "KP_NOT_WRITABLE",
      `考点 ${id} 状态是 ${row.status}，不接受写入（只有 draft/active 能改）`,
    );
  }
  return row;
}

/** 🔴 挂载到 merged/retired 考点 = 对账 C2 当场红旗，写侧就拦掉 */
async function mustMountableKp(tx: CoreTx, id: string): Promise<KpRow> {
  const row = await mustKp(tx, id);
  if (row.status !== "draft" && row.status !== "active") {
    throw new KgError(
      row.status === "merged" ? "KP_ALREADY_MERGED" : "KP_NOT_WRITABLE",
      `考点 ${id} 状态是 ${row.status}${row.mergedInto ? `（指向 ${row.mergedInto}）` : ""}` +
        `，不能往它上面挂东西——挂了就是对账 C2 的悬挂引用`,
    );
  }
  return row;
}

/** kp 的引用面：C2 查的四张 + D-12 后加的 err_code_map + C 域 exam_model + P2 的 kp_edge */
export interface KpRefCounts {
  question_kp: number;
  node_kp_map: number;
  kp_error: number;
  kp_alias: number;
  err_code_map: number;
  exam_model: number;
  kp_edge: number;
  合计: number;
}

/** COUNT(*)：走 drizzle 查询构造器（libsql 的 count 可能回 bigint，统一 Number()） */
const 计数列 = { c: sql<number>`count(*)` };
function 取数(rows: { c: number }[]): number {
  return Number(rows[0]?.c ?? 0);
}

async function countKpRefs(tx: CoreTx, kpId: string): Promise<KpRefCounts> {
  const counts = {
    question_kp: 取数(
      await tx.select(计数列).from(questionKp).where(eq(questionKp.kpId, kpId)),
    ),
    node_kp_map: 取数(
      await tx.select(计数列).from(nodeKpMap).where(eq(nodeKpMap.kpId, kpId)),
    ),
    kp_error: 取数(
      await tx.select(计数列).from(kpError).where(eq(kpError.kpId, kpId)),
    ),
    kp_alias: 取数(
      await tx.select(计数列).from(kpAlias).where(eq(kpAlias.kpId, kpId)),
    ),
    err_code_map: 取数(
      await tx.select(计数列).from(errCodeMap).where(eq(errCodeMap.kpId, kpId)),
    ),
    exam_model: 取数(
      await tx.select(计数列).from(examModel).where(eq(examModel.kpId, kpId)),
    ),
    kp_edge: 取数(
      await tx
        .select(计数列)
        .from(kpEdge)
        .where(or(eq(kpEdge.fromKp, kpId), eq(kpEdge.toKp, kpId))),
    ),
  };
  return {
    ...counts,
    合计: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------------------
// 考点概念层
// ---------------------------------------------------------------------------

export const createKpInput = z.object({
  /** 不给就现生成；导底要先拿 id 建映射才传 */
  id: kpIdSchema.optional(),
  name: 非空("考点名"),
  /** 小低/小高/初中 */
  gradeBand: 可空文本,
  /** 两级软分类（字典值，不建表） */
  domain: 可空文本,
  topic: 可空文本,
  /** 考点卡片正文：口径/易错/教学建议 */
  cardMd: z.string().nullish(),
  status: 可创建考点状态.default("active"),
});

export type CreateKpInput = z.input<typeof createKpInput>;

export interface KpWriteResult extends KgReceipt {
  id: string;
}

/** 建一个考点（默认直接 active；拿不准就 'draft'，治理页审过再转正） */
export async function createKp(
  input: CreateKpInput,
  opts: KgOptions = {},
): Promise<KpWriteResult> {
  const v = parseInput(createKpInput, input);
  const id = v.id ?? newId("kp");
  const ts = nowLocalISO();

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "createKp",
      args: { id, name: v.name, status: v.status, note: opts.note },
    },
    async (tx) => {
      await tx.insert(kp).values({
        id,
        name: v.name,
        gradeBand: v.gradeBand ?? null,
        domain: v.domain ?? null,
        topic: v.topic ?? null,
        cardMd: v.cardMd ?? null,
        status: v.status,
        createdAt: ts,
        updatedAt: ts,
      });
      return [{ table: "kp", id, op: "insert" as const }];
    },
    opts.handle,
  );

  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

/** 改考点卡片正文（口径/易错/教学建议）；传 null = 清空 */
export async function updateKpCard(
  kpId: string,
  cardMd: string | null,
  opts: KgOptions = {},
): Promise<KpWriteResult> {
  const id = parseInput(kpIdSchema, kpId);
  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "updateKpCard",
      args: { kpId: id, cardMd, note: opts.note },
    },
    async (tx) => {
      await mustWritableKp(tx, id);
      await tx
        .update(kp)
        .set({ cardMd, updatedAt: nowLocalISO() })
        .where(eq(kp.id, id));
      return [{ table: "kp", id, op: "update" as const }];
    },
    opts.handle,
  );
  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

/**
 * 改活跃名。
 * 🔴 旧名不会自动进别名表 —— 要留检索入口就自己再调一次 addKpAlias（显式优于顺手）。
 */
export async function renameKp(
  kpId: string,
  newName: string,
  opts: KgOptions = {},
): Promise<KpWriteResult> {
  const id = parseInput(kpIdSchema, kpId);
  const name = parseInput(非空("考点名"), newName);
  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "renameKp",
      args: { kpId: id, name, note: opts.note },
    },
    async (tx) => {
      await mustWritableKp(tx, id);
      await tx
        .update(kp)
        .set({ name, updatedAt: nowLocalISO() })
        .where(eq(kp.id, id));
      return [{ table: "kp", id, op: "update" as const }];
    },
    opts.handle,
  );
  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

export interface RetireKpResult extends KpWriteResult {
  /** 退役时它身上还挂着多少引用（force 时会 >0） */
  refs: KpRefCounts;
}

/**
 * 退役考点。
 *
 * 🔴 默认拒绝还有引用的考点：question_kp/node_kp_map/kp_error/kp_alias 指向 retired
 *    就是对账 C2 的悬挂引用（合并后新考点漏题、统计劈半、错因候选走空）。
 *    「这个考点其实是重复的」不该走退役，走 mergeKp。
 * 🔴 `force: true` 是给「引用是垃圾数据、我随后手工清」用的逃逸阀 —— 它**会留下 C2 红旗**，
 *    留没留是你的账，别指望这里帮你悄悄删干净。
 */
export async function retireKp(
  kpId: string,
  opts: KgOptions & { force?: boolean } = {},
): Promise<RetireKpResult> {
  const id = parseInput(kpIdSchema, kpId);
  let refs: KpRefCounts | null = null;

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "retireKp",
      args: { kpId: id, force: opts.force ?? false, note: opts.note },
    },
    async (tx) => {
      await mustWritableKp(tx, id);
      refs = await countKpRefs(tx, id);
      if (refs.合计 > 0 && !opts.force) {
        const 明细 = Object.entries(refs)
          .filter(([k, v]) => k !== "合计" && v > 0)
          .map(([k, v]) => `${k}=${v}`)
          .join("、");
        throw new KgError(
          "KP_HAS_REFS",
          `考点 ${id} 还有 ${refs.合计} 条引用（${明细}），退役被拒。` +
            `重复考点请走 mergeKp 合并；确认是垃圾引用要强退，传 force:true（🔴 会留 C2 红旗）`,
        );
      }
      await tx
        .update(kp)
        .set({ status: "retired", updatedAt: nowLocalISO() })
        .where(eq(kp.id, id));
      return [{ table: "kp", id, op: "update" as const }];
    },
    opts.handle,
  );

  return {
    id,
    seq: receipt.seq,
    rowRefs: receipt.rowRefs,
    refs: refs ?? {
      question_kp: 0,
      node_kp_map: 0,
      kp_error: 0,
      kp_alias: 0,
      err_code_map: 0,
      exam_model: 0,
      kp_edge: 0,
      合计: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 别名词表（resolve_kp 的料）
// ---------------------------------------------------------------------------

export interface AliasAddResult extends KgReceipt {
  /** false = 本来就有这条别名（幂等，没动库） */
  inserted: boolean;
}

/**
 * 加一条别名。同一 alias 允许指向多个考点（resolve_kp 返回候选、不武断），
 * 所以这里只防同 (kp_id, alias) 重复，不防「这个词别人也在用」。
 */
export async function addKpAlias(
  kpId: string,
  alias: string,
  opts: KgOptions = {},
): Promise<AliasAddResult> {
  const id = parseInput(kpIdSchema, kpId);
  const word = parseInput(非空("别名"), alias);
  let inserted = false;

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "addKpAlias",
      args: { kpId: id, alias: word, note: opts.note },
    },
    async (tx) => {
      await mustMountableKp(tx, id);
      const existed = await tx
        .select({ alias: kpAlias.alias })
        .from(kpAlias)
        .where(and(eq(kpAlias.kpId, id), eq(kpAlias.alias, word)));
      if (existed.length > 0) return []; // 幂等：没动行，就不报 rowRef
      await tx.insert(kpAlias).values({ kpId: id, alias: word });
      inserted = true;
      return [
        { table: "kp_alias", id: rowRefId(id, word), op: "insert" as const },
      ];
    },
    opts.handle,
  );

  return { inserted, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

/** 删一条别名；没这条就报错（删不存在的东西多半是搞错了对象，不静默） */
export async function removeKpAlias(
  kpId: string,
  alias: string,
  opts: KgOptions = {},
): Promise<KgReceipt> {
  const id = parseInput(kpIdSchema, kpId);
  const word = parseInput(非空("别名"), alias);

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "removeKpAlias",
      args: { kpId: id, alias: word, note: opts.note },
    },
    async (tx) => {
      const existed = await tx
        .select({ alias: kpAlias.alias })
        .from(kpAlias)
        .where(and(eq(kpAlias.kpId, id), eq(kpAlias.alias, word)));
      if (existed.length === 0) {
        throw new KgError(
          "ALIAS_NOT_FOUND",
          `考点 ${id} 上没有别名「${word}」，删不动`,
        );
      }
      await tx
        .delete(kpAlias)
        .where(and(eq(kpAlias.kpId, id), eq(kpAlias.alias, word)));
      return [
        { table: "kp_alias", id: rowRefId(id, word), op: "delete" as const },
      ];
    },
    opts.handle,
  );
  return { seq: receipt.seq, rowRefs: receipt.rowRefs };
}

// ---------------------------------------------------------------------------
// 版本树
// ---------------------------------------------------------------------------

export const createEditionTreeInput = z.object({
  id: treeIdSchema.optional(),
  subject: 非空("学科"),
  /** 人教/浙教… */
  edition: 非空("教材版本"),
  /** 七上/三下… */
  gradeSem: 非空("册"),
  version: z.number().int().positive().default(1),
  /**
   * 🔴 必填，没有默认值。
   * 库里「同一 subject×edition×grade_sem 至多一棵 active」是**部分唯一索引**
   * （`WHERE status='active'`）：status 留 NULL 的树既躲过这道索引、也躲过
   * `CHECK(status IN ('active','readonly'))`（SQL 里 NULL 的 CHECK 判定不为假 = 放行）。
   * 也就是说「不传 status」= 悄悄绕开活跃树唯一闸，还查不出来。所以这里不给默认值，
   * 逼调用方每次显式说清楚这棵树是现役还是归档。
   */
  status: z.enum(["active", "readonly"]),
});

export type CreateEditionTreeInput = z.input<typeof createEditionTreeInput>;

export interface TreeWriteResult extends KgReceipt {
  id: string;
}

/**
 * 建一棵版本树。
 *
 * 🔴 「同册第二棵 active」不在这里预检，判据只留一份在库里（部分唯一索引 `idx_edtree_active`）——
 *    代码里再抄一份唯一性判定就是两个事实源，早晚漂移。
 *    这里只做一件事：把库甩回来的那句 `Failed query: insert into "edition_tree" …`
 *    翻成人话（原文照样带着），别让调用方对着一坨 SQL 猜自己撞了哪道闸。
 */
export async function createEditionTree(
  input: CreateEditionTreeInput,
  opts: KgOptions = {},
): Promise<TreeWriteResult> {
  const v = parseInput(createEditionTreeInput, input);
  const id = v.id ?? newId("tree");

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "createEditionTree",
      args: {
        id,
        subject: v.subject,
        edition: v.edition,
        gradeSem: v.gradeSem,
        version: v.version,
        status: v.status,
        note: opts.note,
      },
    },
    async (tx) => {
      const 册 = `${v.subject}/${v.edition}/${v.gradeSem}`;
      try {
        await tx.insert(editionTree).values({
          id,
          subject: v.subject,
          edition: v.edition,
          gradeSem: v.gradeSem,
          version: v.version,
          status: v.status,
          createdAt: nowLocalISO(),
        });
      } catch (e) {
        const raw = 错误全文(e);
        // 🔴 两道唯一闸报的都是「UNIQUE constraint failed: edition_tree.…」，
        //    差别只在列清单里带不带 edition_tree.version（实测口径，见 tests/kg.test.ts）：
        //      带 version → 表级 UNIQUE(subject,edition,grade_sem,version) = 版本号重复
        //      不带       → 部分唯一索引 idx_edtree_active = 同册已有活跃树
        if (
          /UNIQUE constraint failed:[^\n]*edition_tree\.grade_sem/i.test(raw)
        ) {
          if (/edition_tree\.version/i.test(raw)) {
            throw new KgError(
              "TREE_DUPLICATE",
              `${册} 的 version=${v.version} 已经建过了，换个版本号。原始报错：${raw}`,
            );
          }
          throw new KgError(
            "TREE_ACTIVE_CONFLICT",
            `${册} 已经有一棵活跃树了——先把它 setTreeStatus(...,'readonly') 再建新的` +
              `（同册双 active 树=检索双份考点候选）。原始报错：${raw}`,
          );
        }
        throw e;
      }
      return [{ table: "edition_tree", id, op: "insert" as const }];
    },
    opts.handle,
  );

  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

/**
 * 切树状态（新版本教材上架 = 老树转 readonly、新树转 active）。
 * 转 active 前先查同册有没有别的 active 树，有就报出**是哪棵**（索引只会甩一句
 * UNIQUE constraint failed，看不出占位的是谁）。索引仍是最终闸。
 */
export async function setTreeStatus(
  treeId: string,
  status: "active" | "readonly",
  opts: KgOptions = {},
): Promise<TreeWriteResult> {
  const id = parseInput(treeIdSchema, treeId);
  const st = parseInput(z.enum(["active", "readonly"]), status);

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "setTreeStatus",
      args: { treeId: id, status: st, note: opts.note },
    },
    async (tx) => {
      const rows = await tx
        .select({
          id: editionTree.id,
          subject: editionTree.subject,
          edition: editionTree.edition,
          gradeSem: editionTree.gradeSem,
        })
        .from(editionTree)
        .where(eq(editionTree.id, id));
      const tree = rows[0];
      if (!tree) {
        throw new KgError("TREE_NOT_FOUND", `版本树 ${id} 不存在`);
      }
      if (st === "active") {
        const 占位 = await tx
          .select({ id: editionTree.id })
          .from(editionTree)
          .where(
            and(
              eq(editionTree.subject, tree.subject),
              eq(editionTree.edition, tree.edition),
              eq(editionTree.gradeSem, tree.gradeSem),
              eq(editionTree.status, "active"),
            ),
          );
        const 别人 = 占位.filter((t) => t.id !== id);
        if (别人.length > 0) {
          throw new KgError(
            "TREE_ACTIVE_CONFLICT",
            `${tree.subject}/${tree.edition}/${tree.gradeSem} 已经有活跃树 ${别人
              .map((t) => t.id)
              .join(
                "、",
              )}——先把它转 readonly 再切（同册双 active 树=检索双份考点候选）`,
          );
        }
      }
      await tx
        .update(editionTree)
        .set({ status: st })
        .where(eq(editionTree.id, id));
      return [{ table: "edition_tree", id, op: "update" as const }];
    },
    opts.handle,
  );

  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

export const addEditionNodeInput = z.object({
  id: nodeIdSchema.optional(),
  treeId: treeIdSchema,
  /** 章节父节点；顶层不传 */
  parentId: nodeIdSchema.nullish(),
  /** 1=章 2=节 3=课时…（正本没有硬编码层级表，按树自己的口径来） */
  level: z.number().int().nonnegative().nullish(),
  name: 非空("节点名"),
  sort: z.number().int().nullish(),
});

export type AddEditionNodeInput = z.input<typeof addEditionNodeInput>;

export interface NodeWriteResult extends KgReceipt {
  id: string;
}

/**
 * 往树上挂一个章节节点。
 * 两道本地闸（库里没有对应约束，不查就是脏数据）：
 *   - 树必须是 active（readonly 是归档版本，不再长节点）；
 *   - parent 必须属于同一棵树（跨树父子=章节树静默串味，外键管不到这个）。
 */
export async function addEditionNode(
  input: AddEditionNodeInput,
  opts: KgOptions = {},
): Promise<NodeWriteResult> {
  const v = parseInput(addEditionNodeInput, input);
  const id = v.id ?? newId("node");

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "addEditionNode",
      args: { id, treeId: v.treeId, name: v.name, note: opts.note },
    },
    async (tx) => {
      await assertTreeWritable(tx, v.treeId);
      if (v.parentId) await assertParentInTree(tx, v.parentId, v.treeId);
      await tx.insert(editionNode).values({
        id,
        treeId: v.treeId,
        parentId: v.parentId ?? null,
        level: v.level ?? null,
        name: v.name,
        sort: v.sort ?? null,
      });
      return [{ table: "edition_node", id, op: "insert" as const }];
    },
    opts.handle,
  );

  return { id, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

async function assertTreeWritable(tx: CoreTx, treeId: string): Promise<void> {
  const rows = await tx
    .select({ id: editionTree.id, status: editionTree.status })
    .from(editionTree)
    .where(eq(editionTree.id, treeId));
  const tree = rows[0];
  if (!tree) throw new KgError("TREE_NOT_FOUND", `版本树 ${treeId} 不存在`);
  if (tree.status !== "active") {
    throw new KgError(
      "TREE_NOT_ACTIVE",
      `版本树 ${treeId} 是 ${tree.status ?? "NULL"}，不接受改动（归档树只读）`,
    );
  }
}

async function assertParentInTree(
  tx: CoreTx,
  parentId: string,
  treeId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: editionNode.id, treeId: editionNode.treeId })
    .from(editionNode)
    .where(eq(editionNode.id, parentId));
  const parent = rows[0];
  if (!parent) {
    throw new KgError("NODE_NOT_FOUND", `父节点 ${parentId} 不存在`);
  }
  if (parent.treeId !== treeId) {
    throw new KgError(
      "NODE_TREE_MISMATCH",
      `父节点 ${parentId} 属于树 ${parent.treeId}，不是 ${treeId}——章节树不许跨树认亲`,
    );
  }
}

export interface MapResult extends KgReceipt {
  /** false = 本来就映射着（幂等，没动库） */
  inserted: boolean;
}

/** 章节叶 ↔ 考点映射（新版本教材=新树+新映射，概念层不动） */
export async function mapNodeKp(
  nodeId: string,
  kpId: string,
  opts: KgOptions = {},
): Promise<MapResult> {
  const n = parseInput(nodeIdSchema, nodeId);
  const k = parseInput(kpIdSchema, kpId);
  let inserted = false;

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "mapNodeKp",
      args: { nodeId: n, kpId: k, note: opts.note },
    },
    async (tx) => {
      const node = await tx
        .select({ id: editionNode.id })
        .from(editionNode)
        .where(eq(editionNode.id, n));
      if (node.length === 0) {
        throw new KgError("NODE_NOT_FOUND", `章节节点 ${n} 不存在`);
      }
      await mustMountableKp(tx, k);
      const existed = await tx
        .select({ nodeId: nodeKpMap.nodeId })
        .from(nodeKpMap)
        .where(and(eq(nodeKpMap.nodeId, n), eq(nodeKpMap.kpId, k)));
      if (existed.length > 0) return [];
      await tx.insert(nodeKpMap).values({ nodeId: n, kpId: k });
      inserted = true;
      return [
        { table: "node_kp_map", id: rowRefId(n, k), op: "insert" as const },
      ];
    },
    opts.handle,
  );

  return { inserted, seq: receipt.seq, rowRefs: receipt.rowRefs };
}

/** 撤一条章节↔考点映射；没这条就报错 */
export async function unmapNodeKp(
  nodeId: string,
  kpId: string,
  opts: KgOptions = {},
): Promise<KgReceipt> {
  const n = parseInput(nodeIdSchema, nodeId);
  const k = parseInput(kpIdSchema, kpId);

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "unmapNodeKp",
      args: { nodeId: n, kpId: k, note: opts.note },
    },
    async (tx) => {
      const existed = await tx
        .select({ nodeId: nodeKpMap.nodeId })
        .from(nodeKpMap)
        .where(and(eq(nodeKpMap.nodeId, n), eq(nodeKpMap.kpId, k)));
      if (existed.length === 0) {
        throw new KgError("MAP_NOT_FOUND", `节点 ${n} 上没挂考点 ${k}，撤不动`);
      }
      await tx
        .delete(nodeKpMap)
        .where(and(eq(nodeKpMap.nodeId, n), eq(nodeKpMap.kpId, k)));
      return [
        { table: "node_kp_map", id: rowRefId(n, k), op: "delete" as const },
      ];
    },
    opts.handle,
  );
  return { seq: receipt.seq, rowRefs: receipt.rowRefs };
}

// ---------------------------------------------------------------------------
// 合并链解析
// ---------------------------------------------------------------------------

/** merged_into 链的追链上限；正常链长 1~2，超这个数基本就是数据坏了 */
export const MERGE_CHAIN_MAX_HOPS = 32;

export interface ResolvedKp {
  /** 追到头的那个考点 */
  id: string;
  name: string;
  /** 'active' 是常态；'draft'/'retired' 也可能是链尾（它们不带 merged_into） */
  status: string;
  /** 追了几跳（0 = 入参本身就没被合并过） */
  hops: number;
  /** 完整路径，含起点与终点 */
  chain: string[];
}

type KpReader = CoreTx | CoreDbHandle;

function isHandle(src: KpReader): src is CoreDbHandle {
  return typeof (src as CoreDbHandle).serialize === "function";
}

async function readKpRow(
  src: KpReader,
  id: string,
): Promise<KpRow | undefined> {
  if (isHandle(src)) {
    const r = await src.client.execute({
      sql: "SELECT id, name, status, merged_into AS mergedInto FROM kp WHERE id = ?",
      args: [id],
    });
    return r.rows[0] as unknown as KpRow | undefined;
  }
  return selectKp(src, id);
}

/**
 * 顺着 merged_into 把旧 id 解析到落点考点（读侧一切查询的前置动作：
 * resolve_kp / search_questions 拿到 merged 的 kp_id 一律先过这里）。
 *
 * 🔴 防环两道：走过的 id 记在 visited（撞上=报错），再加一道跳数上限兜底。
 *    环在 mergeKp 侧本来就进不来（目标必须 active），但库不是只有 core 能写过
 *    ——读侧不设防就是一个死循环把进程挂住。
 *
 * @param src tx（合并事务内追链）或库句柄（读侧）
 */
export async function resolveMergedKp(
  src: KpReader,
  kpId: string,
): Promise<ResolvedKp> {
  const start = parseInput(kpIdSchema, kpId);
  const chain: string[] = [start];
  const visited = new Set<string>([start]);

  let cur = await readKpRow(src, start);
  if (!cur) {
    throw new KgError(
      "KP_NOT_FOUND",
      `考点 ${start} 不存在（追链起点就查不到）`,
    );
  }

  while (cur.status === "merged") {
    const next = cur.mergedInto;
    if (!next) {
      // 建表 CHECK 保证 merged 必带 merged_into，真撞上说明库被绕过写坏了
      throw new KgError(
        "KP_NOT_FOUND",
        `考点 ${cur.id} 标着 merged 却没有 merged_into——链断了，库被绕过 core 改过`,
      );
    }
    if (visited.has(next)) {
      throw new KgError(
        "MERGE_CHAIN_CYCLE",
        `merged_into 链成环：${[...chain, next].join(" → ")}`,
      );
    }
    if (chain.length > MERGE_CHAIN_MAX_HOPS) {
      throw new KgError(
        "MERGE_CHAIN_TOO_DEEP",
        `merged_into 链超过 ${MERGE_CHAIN_MAX_HOPS} 跳，多半是坏数据：${chain.join(" → ")}`,
      );
    }
    const row = await readKpRow(src, next);
    if (!row) {
      throw new KgError(
        "KP_NOT_FOUND",
        `考点 ${cur.id} 的 merged_into 指向 ${next}，而 ${next} 不存在`,
      );
    }
    chain.push(next);
    visited.add(next);
    cur = row;
  }

  return {
    id: cur.id,
    name: cur.name,
    status: cur.status,
    hops: chain.length - 1,
    chain,
  };
}

// ---------------------------------------------------------------------------
// merge_kp（M1 · D-11）
// ---------------------------------------------------------------------------

/** 一张「(kp_id, 另一半键)」型引用表的重挂计划 */
interface RemapPlan {
  table: string;
  /** from 侧现有的另一半键 */
  fromKeys: string[];
  /** to 侧已有的另一半键 */
  toKeys: Set<string>;
  /** 🔴 复合 rowRef.id 拼法，键序必须与 AUDITED_TABLES 的 idExpr 一致 */
  refId: (kpId: string, otherKey: string) => string;
  /** 删掉 from 侧这批「to 侧已有」的重复行 */
  deleteDup: (keys: string[]) => Promise<void>;
  /** 把 from 侧剩下的行整体改挂到 to（重复行已删，不会撞主键） */
  moveRest: () => Promise<void>;
}

interface RemapOutcome {
  refs: RowRef[];
  moved: number;
  dropped: number;
  droppedKeys: string[];
}

/**
 * 通用重挂：**先删重复、再整体改挂**。
 *
 * 为什么不是 `INSERT OR IGNORE ... SELECT` + `DELETE`：那条路上「被 IGNORE 掉的行」
 * 一声不响，调用方永远不知道丢了什么（question_kp 上丢的就是主考点）。
 * 这里重复行是**算出来的**，逐条计数、逐条上报 rowRef。
 */
async function runRemap(
  plan: RemapPlan,
  fromId: string,
  toId: string,
): Promise<RemapOutcome> {
  const dup = plan.fromKeys.filter((k) => plan.toKeys.has(k));
  const rest = plan.fromKeys.filter((k) => !plan.toKeys.has(k));
  const refs: RowRef[] = [];

  if (dup.length > 0) {
    await plan.deleteDup(dup);
    for (const k of dup) {
      refs.push({ table: plan.table, id: plan.refId(fromId, k), op: "delete" });
    }
  }
  if (rest.length > 0) {
    await plan.moveRest();
    for (const k of rest) {
      // 🔴 改挂 = 老键消失 + 新键出现，两条都得报（少报新键 → C1a 说那行没审计覆盖）
      refs.push({ table: plan.table, id: plan.refId(fromId, k), op: "delete" });
      refs.push({ table: plan.table, id: plan.refId(toId, k), op: "insert" });
    }
  }
  return { refs, moved: rest.length, dropped: dup.length, droppedKeys: dup };
}

export interface MergeKpResult extends KgReceipt {
  from: string;
  to: string;
  /** 各表整体改挂过去的行数 */
  moved: Record<string, number>;
  /** 各表因 to 侧已有同键而丢弃的 from 行数（去重，不是丢数据） */
  dropped: Record<string, number>;
  /** 主考点跟着搬过去（to 侧原本没这道题） */
  primaryKept: string[];
  /** 🔴 to 侧原有次行被显式提为主（否则 OR IGNORE 会把这题的主考点静默吞掉） */
  primaryPromoted: string[];
  /** to 侧该题已有 primary，from 行降为次（防御分支，见函数注释） */
  primaryDemoted: string[];
  /** err_code_map 里 to 侧已占同一 err_code、from 侧映射被丢弃的码（可能指向不同错因） */
  errCodeDropped: string[];
  /** kp_edge 重挂后变成自环而直接删掉的边 */
  edgeSelfLoops: string[];
}

/**
 * 🔴 考点合并（M1 §D-11）—— core 单事务原语。
 *
 * 语义（一条都不许省，省哪条哪条就成静默数据丢失）：
 *   ① 校验：from/to 都在；from ∈ {draft, active}；**to 必须 active**（指向 merged/retired
 *      就是给自己造环和断链）；from ≠ to；
 *   ② 引用表全量重挂到 to：question_kp / node_kp_map / kp_error / kp_alias
 *      （+ err_code_map / kp_edge，见下方「四表之外」）；
 *   ③ 主考点显式裁决（见 primaryKept / primaryPromoted / primaryDemoted）；
 *   ④ exam_model.kp_id 同事务改指到 to；
 *   ⑤ from 壳保留：status='merged' + merged_into=to（旧 id 反查得到落点）；
 *   ⑥ rowRefs 全量上报。
 *
 * ── ③ 主考点为什么必须「显式裁决」 ──────────────────────────────────────
 *   库里有 `CREATE UNIQUE INDEX idx_qkp_primary ON question_kp(question_id) WHERE is_primary=1`
 *   ——**一题至多一个主考点**。于是同一道题在 from 侧是 primary、在 to 侧也是 primary
 *   这件事物理上不成立，真正会发生的冲突只有一种：
 *     from 侧 (Q, from, is_primary=1)，to 侧已有 (Q, to, is_primary=0)。
 *   naive 的 `INSERT OR IGNORE` 在这里会因为主键已存在而丢掉 from 那行，
 *   **连同它的 primary 标记一起丢** ⇒ 这道题从此没有主考点，判错因候选集直接走空，全程无红旗。
 *   所以本实现把 to 侧那行**显式提为 primary**（primaryPromoted），而不是靠 IGNORE。
 *   primaryDemoted 是防御分支：真出现「to 侧该题已经是 primary」（意味着索引被人绕过/丢了），
 *   就按 D-11 的口径把 from 行降为次（即直接丢弃它的 primary），并如实上报。
 *
 * ── 四表之外（⚠️ 超出 D-11 明文的两张表，理由写在这里备查） ───────────────
 *   D-11 成文时列的是「五表」（其中 cause_example 无 kp 列，是笔误）。但库里带 kp 外键的
 *   还有 **err_code_map**（D-12 后加的 (kp_id, err_code) 复合键）和 **kp_edge**（P2 占位）。
 *   不重挂它们，合并后这两张表就指着一个 merged 壳 —— 而对账 C2 的引用表清单里没有它们，
 *   于是**连红旗都不会亮**。合并的全部意义就是「from 之后彻底没人再指」，所以这里一并重挂。
 *   err_code_map 重挂时若 to 侧已占同一 err_code（可能映到别的错因），保留 to 的、丢弃 from 的，
 *   并在 errCodeDropped 里逐条列出来交给人看 —— 不静默。
 */
export async function mergeKp(
  fromId: string,
  toId: string,
  opts: KgOptions = {},
): Promise<MergeKpResult> {
  const from = parseInput(kpIdSchema, fromId);
  const to = parseInput(kpIdSchema, toId);
  if (from === to) {
    throw new KgError("MERGE_SELF", `from 和 to 是同一个考点 ${from}，合什么`);
  }

  const moved: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const primaryKept: string[] = [];
  const primaryPromoted: string[] = [];
  const primaryDemoted: string[] = [];
  let errCodeDropped: string[] = [];
  const edgeSelfLoops: string[] = [];

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "mergeKp",
      args: { from, to, note: opts.note },
    },
    async (tx) => {
      // ── ① 校验 ──────────────────────────────────────────────────────────
      const fromRow = await mustKp(tx, from, "被合并考点(from)");
      const toRow = await mustKp(tx, to, "合并目标(to)");

      if (fromRow.status === "merged") {
        throw new KgError(
          "KP_ALREADY_MERGED",
          `考点 ${from} 已合并过，指向 ${fromRow.mergedInto}——` +
            `要接着合就拿落点当 from（resolveMergedKp 追得到）`,
        );
      }
      if (fromRow.status !== "draft" && fromRow.status !== "active") {
        throw new KgError(
          "KP_NOT_WRITABLE",
          `考点 ${from} 状态是 ${fromRow.status}，不能当合并来源（只有 draft/active 能合）`,
        );
      }
      if (toRow.status !== "active") {
        throw new KgError(
          "MERGE_TARGET_NOT_ACTIVE",
          `合并目标 ${to} 状态是 ${toRow.status}` +
            `${toRow.mergedInto ? `（指向 ${toRow.mergedInto}）` : ""}` +
            `——目标必须 active（合到 merged/retired 上=造环断链，D-11）`,
        );
      }

      const refs: RowRef[] = [];

      // ── ② + ③ question_kp（带主考点裁决）─────────────────────────────────
      const qFrom = await tx
        .select({
          questionId: questionKp.questionId,
          isPrimary: questionKp.isPrimary,
        })
        .from(questionKp)
        .where(eq(questionKp.kpId, from));
      const qTo = await tx
        .select({
          questionId: questionKp.questionId,
          isPrimary: questionKp.isPrimary,
        })
        .from(questionKp)
        .where(eq(questionKp.kpId, to));
      const toPrimaryOf = new Map(
        qTo.map((r) => [r.questionId, r.isPrimary ?? 0]),
      );

      const 重复题: string[] = [];
      const 待改挂题: string[] = [];
      for (const r of qFrom) {
        const fromPrimary = (r.isPrimary ?? 0) === 1;
        if (toPrimaryOf.has(r.questionId)) {
          重复题.push(r.questionId);
          if (fromPrimary) {
            if (toPrimaryOf.get(r.questionId) === 1) {
              primaryDemoted.push(r.questionId); // 防御分支（索引在就走不到）
            } else {
              primaryPromoted.push(r.questionId);
            }
          }
        } else {
          待改挂题.push(r.questionId);
          if (fromPrimary) primaryKept.push(r.questionId);
        }
      }

      // 🔴 顺序不能换：必须先删掉 from 侧那行，才敢把 to 侧那行提成 primary
      //    （部分唯一索引 idx_qkp_primary 是即时判定的，一题两 primary 当场 ABORT）
      if (重复题.length > 0) {
        await tx
          .delete(questionKp)
          .where(
            and(
              eq(questionKp.kpId, from),
              inArray(questionKp.questionId, 重复题),
            ),
          );
        for (const q of 重复题) {
          refs.push({
            table: "question_kp",
            id: rowRefId(q, from),
            op: "delete",
          });
        }
      }
      if (primaryPromoted.length > 0) {
        await tx
          .update(questionKp)
          .set({ isPrimary: 1 })
          .where(
            and(
              eq(questionKp.kpId, to),
              inArray(questionKp.questionId, primaryPromoted),
            ),
          );
        for (const q of primaryPromoted) {
          refs.push({
            table: "question_kp",
            id: rowRefId(q, to),
            op: "update",
          });
        }
      }
      if (待改挂题.length > 0) {
        // 重复行已删干净，剩下的整体改挂不会撞 PK；is_primary 原样跟着走
        await tx
          .update(questionKp)
          .set({ kpId: to })
          .where(eq(questionKp.kpId, from));
        for (const q of 待改挂题) {
          refs.push({
            table: "question_kp",
            id: rowRefId(q, from),
            op: "delete",
          });
          refs.push({
            table: "question_kp",
            id: rowRefId(q, to),
            op: "insert",
          });
        }
      }
      moved.question_kp = 待改挂题.length;
      dropped.question_kp = 重复题.length;

      // ── ② node_kp_map（PK = node_id | kp_id）────────────────────────────
      const nFrom = await tx
        .select({ nodeId: nodeKpMap.nodeId })
        .from(nodeKpMap)
        .where(eq(nodeKpMap.kpId, from));
      const nTo = await tx
        .select({ nodeId: nodeKpMap.nodeId })
        .from(nodeKpMap)
        .where(eq(nodeKpMap.kpId, to));
      const nOut = await runRemap(
        {
          table: "node_kp_map",
          fromKeys: nFrom.map((r) => r.nodeId),
          toKeys: new Set(nTo.map((r) => r.nodeId)),
          refId: (kpId, nodeId) => rowRefId(nodeId, kpId),
          deleteDup: (keys) =>
            tx
              .delete(nodeKpMap)
              .where(
                and(eq(nodeKpMap.kpId, from), inArray(nodeKpMap.nodeId, keys)),
              )
              .then(() => undefined),
          moveRest: () =>
            tx
              .update(nodeKpMap)
              .set({ kpId: to })
              .where(eq(nodeKpMap.kpId, from))
              .then(() => undefined),
        },
        from,
        to,
      );
      refs.push(...nOut.refs);
      moved.node_kp_map = nOut.moved;
      dropped.node_kp_map = nOut.dropped;

      // ── ② kp_error（PK = kp_id | cause_id）──────────────────────────────
      const eFrom = await tx
        .select({ causeId: kpError.causeId })
        .from(kpError)
        .where(eq(kpError.kpId, from));
      const eTo = await tx
        .select({ causeId: kpError.causeId })
        .from(kpError)
        .where(eq(kpError.kpId, to));
      const eOut = await runRemap(
        {
          table: "kp_error",
          fromKeys: eFrom.map((r) => r.causeId),
          toKeys: new Set(eTo.map((r) => r.causeId)),
          refId: (kpId, causeId) => rowRefId(kpId, causeId),
          deleteDup: (keys) =>
            tx
              .delete(kpError)
              .where(
                and(eq(kpError.kpId, from), inArray(kpError.causeId, keys)),
              )
              .then(() => undefined),
          moveRest: () =>
            tx
              .update(kpError)
              .set({ kpId: to })
              .where(eq(kpError.kpId, from))
              .then(() => undefined),
        },
        from,
        to,
      );
      refs.push(...eOut.refs);
      moved.kp_error = eOut.moved;
      dropped.kp_error = eOut.dropped;

      // ── ② kp_alias（PK = kp_id | alias）─────────────────────────────────
      const aFrom = await tx
        .select({ alias: kpAlias.alias })
        .from(kpAlias)
        .where(eq(kpAlias.kpId, from));
      const aTo = await tx
        .select({ alias: kpAlias.alias })
        .from(kpAlias)
        .where(eq(kpAlias.kpId, to));
      const aOut = await runRemap(
        {
          table: "kp_alias",
          fromKeys: aFrom.map((r) => r.alias),
          toKeys: new Set(aTo.map((r) => r.alias)),
          refId: (kpId, alias) => rowRefId(kpId, alias),
          deleteDup: (keys) =>
            tx
              .delete(kpAlias)
              .where(and(eq(kpAlias.kpId, from), inArray(kpAlias.alias, keys)))
              .then(() => undefined),
          moveRest: () =>
            tx
              .update(kpAlias)
              .set({ kpId: to })
              .where(eq(kpAlias.kpId, from))
              .then(() => undefined),
        },
        from,
        to,
      );
      refs.push(...aOut.refs);
      moved.kp_alias = aOut.moved;
      dropped.kp_alias = aOut.dropped;
      // 注：from 的**活跃名**不自动写进 to 的别名表（本卡不做）。旧名仍查得到——
      // from 壳还在库里带着 name，resolve_kp 命中它再追 merged_into 就落到 to。

      // ── ② err_code_map（PK = kp_id | err_code；D-12 后加，不在 D-11 明文里）──
      const cFrom = await tx
        .select({ errCode: errCodeMap.errCode })
        .from(errCodeMap)
        .where(eq(errCodeMap.kpId, from));
      const cTo = await tx
        .select({ errCode: errCodeMap.errCode })
        .from(errCodeMap)
        .where(eq(errCodeMap.kpId, to));
      const cOut = await runRemap(
        {
          table: "err_code_map",
          fromKeys: cFrom.map((r) => r.errCode),
          toKeys: new Set(cTo.map((r) => r.errCode)),
          refId: (kpId, errCode) => rowRefId(kpId, errCode),
          deleteDup: (keys) =>
            tx
              .delete(errCodeMap)
              .where(
                and(
                  eq(errCodeMap.kpId, from),
                  inArray(errCodeMap.errCode, keys),
                ),
              )
              .then(() => undefined),
          moveRest: () =>
            tx
              .update(errCodeMap)
              .set({ kpId: to })
              .where(eq(errCodeMap.kpId, from))
              .then(() => undefined),
        },
        from,
        to,
      );
      refs.push(...cOut.refs);
      moved.err_code_map = cOut.moved;
      dropped.err_code_map = cOut.dropped;
      errCodeDropped = cOut.droppedKeys;

      // ── ② kp_edge（P2 占位表；两端都可能指 from，还可能重挂成自环）────────
      const edges = await tx
        .select({
          fromKp: kpEdge.fromKp,
          toKp: kpEdge.toKp,
          type: kpEdge.type,
        })
        .from(kpEdge)
        .where(or(eq(kpEdge.fromKp, from), eq(kpEdge.toKp, from)));
      let edgeMoved = 0;
      for (const e of edges) {
        const nf = e.fromKp === from ? to : e.fromKp;
        const nt = e.toKp === from ? to : e.toKp;
        await tx
          .delete(kpEdge)
          .where(
            and(
              eq(kpEdge.fromKp, e.fromKp),
              eq(kpEdge.toKp, e.toKp),
              eq(kpEdge.type, e.type),
            ),
          );
        refs.push({
          table: "kp_edge",
          id: rowRefId(e.fromKp, e.toKp, e.type),
          op: "delete",
        });
        if (nf === nt) {
          // 合并把一条边的两端拉到同一个考点上 = 自环，没有意义，直接丢并如实上报
          edgeSelfLoops.push(rowRefId(e.fromKp, e.toKp, e.type));
          continue;
        }
        await tx
          .insert(kpEdge)
          .values({ fromKp: nf, toKp: nt, type: e.type })
          .onConflictDoNothing();
        refs.push({
          table: "kp_edge",
          id: rowRefId(nf, nt, e.type),
          op: "insert",
        });
        edgeMoved += 1;
      }
      moved.kp_edge = edgeMoved;
      dropped.kp_edge = edgeSelfLoops.length;

      // ── ④ exam_model.kp_id 改指 ─────────────────────────────────────────
      const models = await tx
        .select({ id: examModel.id })
        .from(examModel)
        .where(eq(examModel.kpId, from));
      if (models.length > 0) {
        await tx
          .update(examModel)
          .set({ kpId: to })
          .where(eq(examModel.kpId, from));
        for (const m of models) {
          refs.push({ table: "exam_model", id: m.id, op: "update" });
        }
      }
      moved.exam_model = models.length;
      dropped.exam_model = 0;

      // ── ⑤ from 壳：留着供旧 id 反查 ──────────────────────────────────────
      await tx
        .update(kp)
        .set({ status: "merged", mergedInto: to, updatedAt: nowLocalISO() })
        .where(eq(kp.id, from));
      refs.push({ table: "kp", id: from, op: "update" });

      // ── ⑥ 全量 rowRefs ─────────────────────────────────────────────────
      return refs;
    },
    opts.handle,
  );

  return {
    from,
    to,
    seq: receipt.seq,
    rowRefs: receipt.rowRefs,
    moved,
    dropped,
    primaryKept,
    primaryPromoted,
    primaryDemoted,
    errCodeDropped,
    edgeSelfLoops,
  };
}

// ---------------------------------------------------------------------------
// 批量导底
// ---------------------------------------------------------------------------

const 批量考点 = z.object({
  /** 🔴 批量里 id 必填：aliases / maps 要靠它交叉引用，生成不出来 */
  id: kpIdSchema,
  name: 非空("考点名"),
  gradeBand: 可空文本,
  domain: 可空文本,
  topic: 可空文本,
  cardMd: z.string().nullish(),
  status: 可创建考点状态.default("active"),
});

const 批量节点 = z.object({
  id: nodeIdSchema,
  treeId: treeIdSchema,
  parentId: nodeIdSchema.nullish(),
  level: z.number().int().nonnegative().nullish(),
  name: 非空("节点名"),
  sort: z.number().int().nullish(),
});

export const importKgBatchInput = z.object({
  kps: z.array(批量考点).default([]),
  aliases: z
    .array(z.object({ kpId: kpIdSchema, alias: 非空("别名") }))
    .default([]),
  /** 一批最多带一棵树（导底就是「一棵树 + 它的节点 + 映射」） */
  tree: z
    .object({
      id: treeIdSchema,
      subject: 非空("学科"),
      edition: 非空("教材版本"),
      gradeSem: 非空("册"),
      version: z.number().int().positive().default(1),
      status: z.enum(["active", "readonly"]),
    })
    .optional(),
  nodes: z.array(批量节点).default([]),
  maps: z
    .array(z.object({ nodeId: nodeIdSchema, kpId: kpIdSchema }))
    .default([]),
});

export type ImportKgBatchInput = z.input<typeof importKgBatchInput>;

export interface ImportKgBatchResult extends KgReceipt {
  counts: {
    kps: number;
    aliases: number;
    trees: number;
    nodes: number;
    maps: number;
  };
  /** 本批落库的 id（调用方拿去接着建映射/写日志） */
  ids: { kps: string[]; tree: string | null; nodes: string[] };
}

/**
 * 一次事务灌一整批 KG（导底主路：prod biz_subject 整树 → 概念层 + 章节树 + 映射初稿）。
 *
 * 🔴 **全进或全不进**：任何一条坏行都让整批回滚，不留半棵树。
 *    半棵树比没有树坏得多 —— 它看起来是好的，等到出题时才发现某一章没有考点。
 * 🔴 id 由调用方生成（newId('kp'|'tree'|'node')）：aliases/nodes/maps 之间要靠 id 交叉引用，
 *    不可能等库里生成完再回填。
 *
 * 落库顺序 = 依赖顺序：kps → tree → nodes（父在子前，本函数自己拓扑排）→ aliases → maps。
 * 每一段落库前就地校验它的引用（这时前面几段已经在事务里了，直接查库就行）。
 */
export async function importKgBatch(
  payload: ImportKgBatchInput,
  opts: KgOptions = {},
): Promise<ImportKgBatchResult> {
  const v = parseInput(importKgBatchInput, payload);
  const ts = nowLocalISO();

  const receipt = await withCoreWrite(
    {
      actor: opts.actor ?? "agent",
      tool: "importKgBatch",
      args: {
        kps: v.kps.length,
        aliases: v.aliases.length,
        tree: v.tree?.id ?? null,
        nodes: v.nodes.length,
        maps: v.maps.length,
        note: opts.note,
      },
    },
    async (tx) => {
      const refs: RowRef[] = [];

      // ── 考点 ───────────────────────────────────────────────────────────
      assertNoDup(
        v.kps.map((k) => k.id),
        "kps[].id",
      );
      for (const k of v.kps) {
        await tx.insert(kp).values({
          id: k.id,
          name: k.name,
          gradeBand: k.gradeBand ?? null,
          domain: k.domain ?? null,
          topic: k.topic ?? null,
          cardMd: k.cardMd ?? null,
          status: k.status,
          createdAt: ts,
          updatedAt: ts,
        });
        refs.push({ table: "kp", id: k.id, op: "insert" });
      }

      // ── 树 ─────────────────────────────────────────────────────────────
      if (v.tree) {
        await tx.insert(editionTree).values({
          id: v.tree.id,
          subject: v.tree.subject,
          edition: v.tree.edition,
          gradeSem: v.tree.gradeSem,
          version: v.tree.version,
          status: v.tree.status,
          createdAt: ts,
        });
        refs.push({ table: "edition_tree", id: v.tree.id, op: "insert" });
      }

      // ── 节点（父在子前）─────────────────────────────────────────────────
      assertNoDup(
        v.nodes.map((n) => n.id),
        "nodes[].id",
      );
      for (const n of 拓扑排节点(v.nodes)) {
        await assertTreeWritable(tx, n.treeId);
        if (n.parentId) await assertParentInTree(tx, n.parentId, n.treeId);
        await tx.insert(editionNode).values({
          id: n.id,
          treeId: n.treeId,
          parentId: n.parentId ?? null,
          level: n.level ?? null,
          name: n.name,
          sort: n.sort ?? null,
        });
        refs.push({ table: "edition_node", id: n.id, op: "insert" });
      }

      // ── 别名 ───────────────────────────────────────────────────────────
      for (const a of v.aliases) {
        await mustMountableKpInBatch(tx, a.kpId, `aliases 里的 kpId`);
        const existed = await tx
          .select({ alias: kpAlias.alias })
          .from(kpAlias)
          .where(and(eq(kpAlias.kpId, a.kpId), eq(kpAlias.alias, a.alias)));
        if (existed.length > 0) continue; // 幂等
        await tx.insert(kpAlias).values({ kpId: a.kpId, alias: a.alias });
        refs.push({
          table: "kp_alias",
          id: rowRefId(a.kpId, a.alias),
          op: "insert",
        });
      }

      // ── 映射 ───────────────────────────────────────────────────────────
      for (const m of v.maps) {
        const node = await tx
          .select({ id: editionNode.id })
          .from(editionNode)
          .where(eq(editionNode.id, m.nodeId));
        if (node.length === 0) {
          throw new KgError(
            "BATCH_BAD_ROW",
            `maps 里的 nodeId ${m.nodeId} 不存在（本批也没建它）——整批回滚`,
          );
        }
        await mustMountableKpInBatch(tx, m.kpId, "maps 里的 kpId");
        const existed = await tx
          .select({ nodeId: nodeKpMap.nodeId })
          .from(nodeKpMap)
          .where(
            and(eq(nodeKpMap.nodeId, m.nodeId), eq(nodeKpMap.kpId, m.kpId)),
          );
        if (existed.length > 0) continue; // 幂等
        await tx.insert(nodeKpMap).values({ nodeId: m.nodeId, kpId: m.kpId });
        refs.push({
          table: "node_kp_map",
          id: rowRefId(m.nodeId, m.kpId),
          op: "insert",
        });
      }

      return refs;
    },
    opts.handle,
  );

  return {
    seq: receipt.seq,
    rowRefs: receipt.rowRefs,
    counts: {
      kps: v.kps.length,
      aliases: v.aliases.length,
      trees: v.tree ? 1 : 0,
      nodes: v.nodes.length,
      maps: v.maps.length,
    },
    ids: {
      kps: v.kps.map((k) => k.id),
      tree: v.tree?.id ?? null,
      nodes: v.nodes.map((n) => n.id),
    },
  };
}

function assertNoDup(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new KgError("BATCH_BAD_ROW", `${what} 里 ${id} 重复出现——整批回滚`);
    }
    seen.add(id);
  }
}

/** 批量里的考点引用：查得到 + 能挂（draft/active），否则整批回滚 */
async function mustMountableKpInBatch(
  tx: CoreTx,
  kpId: string,
  where: string,
): Promise<void> {
  const row = await selectKp(tx, kpId);
  if (!row) {
    throw new KgError(
      "BATCH_BAD_ROW",
      `${where} ${kpId} 不存在（本批也没建它）——整批回滚`,
    );
  }
  if (row.status !== "draft" && row.status !== "active") {
    throw new KgError(
      "BATCH_BAD_ROW",
      `${where} ${kpId} 状态是 ${row.status}，挂不上去（会成 C2 悬挂引用）——整批回滚`,
    );
  }
}

/**
 * 节点按父子关系排序：父在前。
 * 外键是即时判定的（PRAGMA foreign_keys=ON），子节点先插会当场 FK 失败。
 * 批外的 parentId（指向库里已有的节点）不参与排序，交给 assertParentInTree 校。
 */
function 拓扑排节点<T extends { id: string; parentId?: string | null }>(
  nodes: T[],
): T[] {
  const 批内 = new Set(nodes.map((n) => n.id));
  const 待排 = [...nodes];
  const 已排: T[] = [];
  const 已出 = new Set<string>();

  while (待排.length > 0) {
    const 本轮 = 待排.filter(
      (n) => !n.parentId || !批内.has(n.parentId) || 已出.has(n.parentId),
    );
    if (本轮.length === 0) {
      throw new KgError(
        "BATCH_BAD_ROW",
        `nodes 的 parent 关系成环，排不出插入顺序：${待排.map((n) => n.id).join("、")}`,
      );
    }
    for (const n of 本轮) {
      已排.push(n);
      已出.add(n.id);
    }
    待排.splice(0, 待排.length, ...待排.filter((n) => !已出.has(n.id)));
  }
  return 已排;
}
