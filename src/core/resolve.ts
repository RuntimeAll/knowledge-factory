/**
 * core/resolve.ts —— 考点解析读侧（AI:PRD-002 · 002-C）
 *
 * 两个函数，一条纪律：**kp_id 一律 resolve 出来，禁编造**。
 *   resolveKp(query)  ——「一句人话 → 候选考点」。出题/录题/挂载前的唯一入口。
 *   kpContext(kpId)   ——「一个考点 → 它是什么、在哪本书哪一节、身上挂了多少东西」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条本文件的铁律
 *
 * ① **MATCH 永不拼串**。query 整体转义成 FTS5 的字符串字面量（内部 `"` 翻倍）
 *    再走参数化占位符 —— 于是 `"`、`*`、`(`、`NEAR`、`OR` 这些 MATCH 语法字符
 *    全部退化成普通字符，既注入不了、也不会把查询语法搞崩（REG-D3 的先声）。
 *    ⛔ 反面：`MATCH '${q}'` 或 `MATCH ${q}*`——一个引号就能让 agent 的输入变成语法。
 *
 * ② **本文件只读，唯一的写是低置信入队列**（review_queue），且那一笔照样走
 *    withCoreWrite（开闸/写/审计/关闸 同一事务）。没有第二条写路径。
 *
 * ③ **查不到 ≠ 无话可说**。kpContext 撞上编造的 id，必须**带着最近似候选**报错
 *    （从 id 里能读出可读文本就拿去跑一次 resolveKp）；连候选都给不出时，
 *    也要把「下一步该调什么」写进 message。让 agent 自愈，别让它干瞪眼。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 打分口径（终稿；改这里等于改 agent 的判断依据，别顺手动）─────────────────
 *   exact-name / exact-alias  1.00        名或别名**全等**（ASCII 大小写不敏感）
 *   prefix                    0.85~0.95   词条以 query 开头；0.85 + 0.10×覆盖率
 *   trigram                   0.30~0.80   子串模糊命中；0.30 + 0.50×(0.5×bm25位次 + 0.5×覆盖率)
 *
 *   覆盖率 = query 字数 / 词条字数（截到 1）——「查 3 个字命中一个 12 字的长考点」
 *   本来就该比命中一个 4 字的考点更没底气，这是 bm25 之外的第二个信号。
 *   bm25位次 = 本批候选内的 min-max 归一（最优=1，最差=0；只有一条时=1）。
 *   🔴 bm25 是**批内相对**量，不是绝对分——它只回答「这批里谁更像」，
 *      「像不像得过 0.6 这道线」由覆盖率那一半兜着。
 *
 *   同一 kp 多路命中取**最高**分；同分时按 exact-name > exact-alias > prefix > trigram。
 *
 * ── 为什么 query < 3 字符要另走一条路 ────────────────────────────────────────
 *   kp_fts 用 trigram（3 字符一 token），**2 字以内的 query MATCH 恒空**
 *   （切不出一个完整 trigram）。所以「加减」「圆」这类短查询退到 LIKE
 *   前缀/包含路 —— 不是 FTS 坏了，是 tokenizer 的物理下限。
 */
import { z } from "zod";

import { reviewQueue } from "~/server/db/schema";
import { type AuditActor } from "./audit";
import { getCoreDb, type CoreDbHandle } from "./db";
import { newId } from "./ids";
import { KgError, resolveMergedKp } from "./kg";
import { nowLocalISO } from "./time";
import { withCoreWrite } from "./write";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/** 命中方式（描述的是**匹配形态**，不是哪个引擎算出来的） */
export type MatchedVia = "exact-alias" | "exact-name" | "prefix" | "trigram";

/** via 的优先序（同分时谁排前面）；数字越小越靠前 */
const VIA_RANK: Record<MatchedVia, number> = {
  "exact-name": 0,
  "exact-alias": 1,
  prefix: 2,
  trigram: 3,
};

export interface KpCandidate {
  kpId: string;
  name: string;
  /** 一律是 draft/active（词表与各条查询路都把 merged/retired 挡在外面） */
  status: string;
  /** 0~1，见文件头「打分口径」 */
  confidence: number;
  matchedVia: MatchedVia;
  /** 经别名命中时，命中的是哪条别名（人一眼看出「为什么它算候选」） */
  aliasHit?: string;
  /**
   * 🔴 防御分支：命中的是个 merged 壳，已按 merged_into 链落到这个活跃考点。
   * 正常不该出现（词表里没有 merged 壳），但**精确名/别名全等**那一路是直查 kp 表的，
   * 「用旧名字查旧考点」会走到这儿——这正是它存在的意义：旧名照样问得出落点。
   */
  resolvedFrom?: { id: string; name: string; hops: number };
}

export interface ResolveKpResult {
  /** 归一后的查询串（去首尾空白） */
  query: string;
  candidates: KpCandidate[];
  /** 候选为空，或 top1 < 0.6 —— 此时已入 review_queue（见 queued） */
  lowConfidence: boolean;
  /**
   * 低置信工单。created=false 表示同 query 已有未决工单，本次没重复开。
   * enqueue:false 或不低置信时为 null。
   */
  queued: { id: string; created: boolean } | null;
  /** 过程中吞不得的异常（如 merged 链断），不进 candidates 但必须让人看见 */
  warnings: string[];
}

export interface ResolveKpOptions {
  /** 返回几条候选，默认 8 */
  limit?: number;
  /** 连副本库/别的库时传 */
  handle?: CoreDbHandle;
  /** 入队列时记在审计里的 actor，默认 'agent' */
  actor?: AuditActor;
  /** 🔴 false = 低置信也不入队列（给「只是查一下」的场景，比如 kpContext 的兜底候选） */
  enqueue?: boolean;
}

/** 低于这条线就是「没把握」，要入队列交人裁 */
export const LOW_CONFIDENCE_AT = 0.6;
/** trigram tokenizer 的物理下限：query 短于它，MATCH 恒空 */
export const TRIGRAM_MIN_CHARS = 3;
/** review_queue 里低置信工单的 kind（建表 CHECK 里的固定值，别改字） */
export const LOW_CONFIDENCE_KIND = "kp低置信";

const DEFAULT_LIMIT = 8;
/** 从库里多捞几倍再去重排序（同一 kp 可能名+别名多路命中） */
const FETCH_FACTOR = 4;
const MIN_FETCH = 32;
/** merged_into 反查链的展开上限（防坏数据把递归拖死） */
const MERGED_FROM_MAX = 200;

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

/**
 * kpContext 撞上库里没有的 kp_id。
 * 🔴 candidates 是这个错误的**主体**，不是附赠：agent 编 id 多半是因为
 *    它心里有个名字，把名字还给它比骂它一句「不存在」有用得多。
 */
export class KpNotFoundError extends Error {
  readonly code = "KP_NOT_FOUND" as const;
  readonly kpId: string;
  readonly candidates: KpCandidate[];
  constructor(kpId: string, candidates: KpCandidate[], message: string) {
    super(message);
    this.name = "KpNotFoundError";
    this.kpId = kpId;
    this.candidates = candidates;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type Args = Array<string | number | null>;

async function q<T>(
  h: CoreDbHandle,
  sql: string,
  args: Args = [],
): Promise<T[]> {
  const r = await h.client.execute({ sql, args });
  return r.rows as unknown as T[];
}

async function count(h: CoreDbHandle, sql: string, args: Args = []) {
  const rows = await q<{ c: number | bigint }>(h, sql, args);
  return Number(rows[0]?.c ?? 0);
}

/** 按码点数数（`"绝对值".length` 在 BMP 内没问题，但别赌所有输入都在 BMP） */
function 字数(s: string): number {
  return Array.from(s).length;
}

/**
 * 把整个 query 包成 FTS5 的**字符串字面量**（内部 `"` 翻倍）。
 * 于是 `*` `(` `:` `NEAR` `OR` 全成普通字符，MATCH 语法一个字都拼不进去。
 */
export function ftsStringLiteral(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** LIKE 的通配符转义（`\` 做 escape 字符，SQL 侧要写 ESCAPE '\'） */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 保留 3 位小数（浮点尾巴进 JSON 很难看，也没意义） */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** 覆盖率：query 占词条的比例，截到 1 */
function coverage(query: string, term: string): number {
  const t = 字数(term);
  return t === 0 ? 0 : clamp01(字数(query) / t);
}

// ---------------------------------------------------------------------------
// resolve_kp
// ---------------------------------------------------------------------------

interface Hit {
  kpId: string;
  name: string;
  status: string;
  confidence: number;
  via: MatchedVia;
  aliasHit?: string;
  /** 这一条是从哪个 merged 壳落过来的（⑤ 转换时挂上） */
  resolvedFrom?: { id: string; name: string; hops: number };
}

interface KpRowLite {
  id: string;
  name: string;
  status: string;
}

const queryInput = z
  .string()
  .trim()
  .min(1, "查询词不能为空（要按名字找考点，给个词；一个字也行）");

/**
 * 一句人话 → 候选考点。
 *
 * 四条路一起跑，同 kp 取最高分：精确名 / 精确别名 / 前缀 / trigram 子串
 * （query < 3 字符时 trigram 换成 LIKE 包含路，理由见文件头）。
 *
 * 🔴 top1 < 0.6 或一条候选都没有 = lowConfidence，**当场入 review_queue**
 *    （同 query 已有未决工单就不重复开）。这条队列是词表的「缺口清单」：
 *    agent 问不出来的说法，就是词表该补的别名。
 */
export async function resolveKp(
  query: string,
  opts: ResolveKpOptions = {},
): Promise<ResolveKpResult> {
  const r = queryInput.safeParse(query);
  if (!r.success) {
    throw new KgError("INVALID_INPUT", z.prettifyError(r.error));
  }
  const qs = r.data;
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  const h = opts.handle ?? (await getCoreDb());
  const fetchN = Math.max(MIN_FETCH, limit * FETCH_FACTOR);
  const warnings: string[] = [];
  const hits: Hit[] = [];

  // ── ① 精确：活跃名全等 ────────────────────────────────────────────────────
  //    🔴 这一路（也只有这一路）连 merged 壳一起查：用旧名字查旧考点，
  //       应该问得出它的落点，而不是「查无此考点」。落点转换在下面统一做。
  for (const row of await q<KpRowLite>(
    h,
    `SELECT id, name, status FROM kp
      WHERE name = ? COLLATE NOCASE AND status IN ('draft','active','merged')`,
    [qs],
  )) {
    hits.push({ ...row, kpId: row.id, confidence: 1, via: "exact-name" });
  }

  // ── ② 精确：别名全等 ──────────────────────────────────────────────────────
  for (const row of await q<KpRowLite & { alias: string }>(
    h,
    `SELECT k.id AS id, k.name AS name, k.status AS status, a.alias AS alias
       FROM kp_alias a JOIN kp k ON k.id = a.kp_id
      WHERE a.alias = ? COLLATE NOCASE AND k.status IN ('draft','active','merged')`,
    [qs],
  )) {
    hits.push({
      kpId: row.id,
      name: row.name,
      status: row.status,
      confidence: 1,
      via: "exact-alias",
      aliasHit: row.alias,
    });
  }

  // ── ③ 前缀：名或别名以 query 开头（0.85 + 0.10×覆盖率）───────────────────
  const prefixPat = `${likeEscape(qs)}%`;
  for (const row of await q<KpRowLite & { term: string; kind: string }>(
    h,
    `SELECT id, name, status, name AS term, 'name' AS kind FROM kp
      WHERE status IN ('draft','active') AND name LIKE ? ESCAPE '\\'
     UNION ALL
     SELECT k.id, k.name, k.status, a.alias AS term, 'alias' AS kind
       FROM kp_alias a JOIN kp k ON k.id = a.kp_id
      WHERE k.status IN ('draft','active') AND a.alias LIKE ? ESCAPE '\\'
     LIMIT ?`,
    [prefixPat, prefixPat, fetchN],
  )) {
    hits.push({
      kpId: row.id,
      name: row.name,
      status: row.status,
      confidence: round3(0.85 + 0.1 * coverage(qs, row.term)),
      via: "prefix",
      ...(row.kind === "alias" ? { aliasHit: row.term } : {}),
    });
  }

  // ── ④ 模糊子串 ────────────────────────────────────────────────────────────
  if (字数(qs) >= TRIGRAM_MIN_CHARS) {
    // trigram MATCH（🔴 query 整体转义成字符串字面量 + 参数化，语法字符进不来）
    const rows = await q<KpRowLite & { term: string; kind: string; s: number }>(
      h,
      `SELECT k.id AS id, k.name AS name, k.status AS status,
              f.term AS term, f.kind AS kind, bm25(kp_fts) AS s
         FROM kp_fts f JOIN kp k ON k.id = f.kp_id
        WHERE kp_fts MATCH ? AND k.status IN ('draft','active')
        ORDER BY s LIMIT ?`,
      [ftsStringLiteral(qs), fetchN],
    );
    // bm25 越负越好；批内 min-max 归一（只有一条时视作最优）
    const scores = rows.map((x) => Number(x.s));
    const best = Math.min(...scores);
    const worst = Math.max(...scores);
    const span = worst - best;
    for (const row of rows) {
      const t = span > 0 ? (worst - Number(row.s)) / span : 1;
      hits.push({
        kpId: row.id,
        name: row.name,
        status: row.status,
        confidence: round3(
          0.3 + 0.5 * (0.5 * t + 0.5 * coverage(qs, row.term)),
        ),
        via: "trigram",
        ...(row.kind === "alias" ? { aliasHit: row.term } : {}),
      });
    }
  } else {
    // 🔴 短查询退路：trigram 切不出 token，MATCH 恒空。走 LIKE 包含，
    //    没有 bm25 可用 ⇒ 只按覆盖率给分（落在 0.3~0.8 带的下半段，符合它的把握程度）。
    const containsPat = `%${likeEscape(qs)}%`;
    for (const row of await q<KpRowLite & { term: string; kind: string }>(
      h,
      `SELECT id, name, status, name AS term, 'name' AS kind FROM kp
        WHERE status IN ('draft','active') AND name LIKE ? ESCAPE '\\'
       UNION ALL
       SELECT k.id, k.name, k.status, a.alias AS term, 'alias' AS kind
         FROM kp_alias a JOIN kp k ON k.id = a.kp_id
        WHERE k.status IN ('draft','active') AND a.alias LIKE ? ESCAPE '\\'
       LIMIT ?`,
      [containsPat, containsPat, fetchN],
    )) {
      hits.push({
        kpId: row.id,
        name: row.name,
        status: row.status,
        confidence: round3(0.3 + 0.5 * coverage(qs, row.term)),
        via: "trigram",
        ...(row.kind === "alias" ? { aliasHit: row.term } : {}),
      });
    }
  }

  // ── ⑤ merged 壳落点转换（防御分支，见 KpCandidate.resolvedFrom）───────────
  const resolved: Hit[] = [];
  for (const hit of hits) {
    if (hit.status !== "merged") {
      resolved.push(hit);
      continue;
    }
    try {
      const landed = await resolveMergedKp(h, hit.kpId);
      if (landed.status !== "draft" && landed.status !== "active") {
        warnings.push(
          `命中「${hit.name}」(${hit.kpId}) 是 merged 壳，落点 ${landed.id} 状态是 ${landed.status}——不作候选。`,
        );
        continue;
      }
      resolved.push({
        ...hit,
        kpId: landed.id,
        name: landed.name,
        status: landed.status,
        resolvedFrom: { id: hit.kpId, name: hit.name, hops: landed.hops },
      });
    } catch (e) {
      // 🔴 链断/成环不许吞：候选给不出，但必须让人看见
      warnings.push(
        `命中「${hit.name}」(${hit.kpId}) 是 merged 壳，但追链失败：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── ⑥ 同 kp 取最高分（同分按 via 优先序）──────────────────────────────────
  const byKp = new Map<string, Hit>();
  for (const hit of resolved) {
    const old = byKp.get(hit.kpId);
    if (
      !old ||
      hit.confidence > old.confidence ||
      (hit.confidence === old.confidence &&
        VIA_RANK[hit.via] < VIA_RANK[old.via])
    ) {
      byKp.set(hit.kpId, hit);
    }
  }

  const candidates: KpCandidate[] = [...byKp.values()]
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        VIA_RANK[a.via] - VIA_RANK[b.via] ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map((hit) => {
      return {
        kpId: hit.kpId,
        name: hit.name,
        status: hit.status,
        confidence: hit.confidence,
        matchedVia: hit.via,
        ...(hit.aliasHit ? { aliasHit: hit.aliasHit } : {}),
        ...(hit.resolvedFrom ? { resolvedFrom: hit.resolvedFrom } : {}),
      };
    });

  const top = candidates[0]?.confidence ?? 0;
  const lowConfidence = candidates.length === 0 || top < LOW_CONFIDENCE_AT;

  let queued: ResolveKpResult["queued"] = null;
  if (lowConfidence && opts.enqueue !== false) {
    queued = await 入低置信队列(h, qs, candidates, top, opts.actor ?? "agent");
  }

  return { query: qs, candidates, lowConfidence, queued, warnings };
}

/** 低置信入队列（同 query 未决工单去重） */
async function 入低置信队列(
  h: CoreDbHandle,
  query: string,
  candidates: KpCandidate[],
  top: number,
  actor: AuditActor,
): Promise<{ id: string; created: boolean }> {
  const 已有 = await 查未决工单(h, query);
  if (已有) return { id: 已有, created: false };

  const id = newId("rq");
  const reason =
    candidates.length === 0
      ? `resolve_kp 查「${query}」一条候选都没有——词表里没有这个说法，要么补别名，要么这个考点还没建。`
      : `resolve_kp 查「${query}」最高置信只有 ${top}（< ${LOW_CONFIDENCE_AT}）——` +
        `候选 ${candidates.length} 条，最像的是「${candidates[0]?.name}」，请人裁：是它就补条别名，不是就建考点。`;

  let created = true;
  await withCoreWrite(
    {
      actor,
      tool: "resolve_kp",
      args: { query, top, candidates: candidates.length },
    },
    async (tx) => {
      // 事务内再查一次（单写者下几乎不会发生，但重复工单是纯噪音，顺手挡掉）
      const 又有 = await 查未决工单(h, query);
      if (又有) {
        created = false;
        return [];
      }
      await tx.insert(reviewQueue).values({
        id,
        kind: LOW_CONFIDENCE_KIND,
        // 🔴 ref_type/ref_id 留空：低置信工单指不向任何一行（C1d 只查带 ref 的行）
        payloadJson: JSON.stringify({ query, top, candidates }),
        reason,
        state: "open",
        createdAt: nowLocalISO(),
      });
      return [{ table: "review_queue", id, op: "insert" as const }];
    },
    h,
  );

  return { id, created };
}

async function 查未决工单(
  h: CoreDbHandle,
  query: string,
): Promise<string | null> {
  const rows = await q<{ id: string }>(
    h,
    `SELECT id FROM review_queue
      WHERE kind = ? AND state = 'open'
        AND json_extract(payload_json, '$.query') = ?
      ORDER BY id LIMIT 1`,
    [LOW_CONFIDENCE_KIND, query],
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// kp_context
// ---------------------------------------------------------------------------

export interface KpPlacement {
  treeId: string;
  subject: string;
  edition: string;
  gradeSem: string;
  /** 'active' = 现役教材版本；'readonly' = 归档版本 */
  treeStatus: string | null;
  nodeId: string;
  /** 根 → 该节点的名字链，如 ['第一章 有理数','1.2.4 绝对值'] */
  path: string[];
}

export interface KpContextCard {
  kp: {
    id: string;
    name: string;
    status: string;
    gradeBand: string | null;
    domain: string | null;
    topic: string | null;
    cardMd: string | null;
  };
  /** 别名词表（resolve_kp 的料） */
  aliases: string[];
  /** 🔴 反查链：哪些考点被合并进了它（递归展开，含间接） */
  mergedFrom?: { id: string; name: string }[];
  /** 它在各版本教材里的落点 */
  placements: KpPlacement[];
  counts: { questions: number; examModels: number; errorCauses: number };
  /** 入参是 merged 壳时：从哪个 id 追过来的、追了几跳 */
  resolvedThrough?: { originalId: string; hops: number; chain: string[] };
}

export interface KpContextOptions {
  handle?: CoreDbHandle;
}

interface KpFullRow {
  id: string;
  name: string;
  status: string;
  grade_band: string | null;
  domain: string | null;
  topic: string | null;
  card_md: string | null;
}

/**
 * 一个考点 → 卡片包（是什么 / 别名 / 在哪本书哪一节 / 身上挂了多少题·模型·错因）。
 *
 * 🔴 入参是 merged 壳 → 自动追链到活跃考点，并在 resolvedThrough 里标明白
 *    （不静默换人：agent 拿着旧 id 问，得知道自己拿到的是别人的卡片）。
 * 🔴 入参是编造的 id → 抛 KpNotFoundError，**带最近似候选**（见该类注释）。
 */
export async function kpContext(
  kpId: string,
  opts: KpContextOptions = {},
): Promise<KpContextCard> {
  const h = opts.handle ?? (await getCoreDb());
  const 入参 = String(kpId ?? "").trim();

  const 起点 = (
    await q<KpFullRow>(
      h,
      `SELECT id, name, status, grade_band, domain, topic, card_md
         FROM kp WHERE id = ?`,
      [入参],
    )
  )[0];

  if (!起点) throw await 查无此考点(h, 入参);

  // ── merged 壳 → 追链落点 ──────────────────────────────────────────────────
  let row = 起点;
  let resolvedThrough: KpContextCard["resolvedThrough"];
  if (起点.status === "merged") {
    const landed = await resolveMergedKp(h, 起点.id);
    const 落点 = (
      await q<KpFullRow>(
        h,
        `SELECT id, name, status, grade_band, domain, topic, card_md
           FROM kp WHERE id = ?`,
        [landed.id],
      )
    )[0];
    if (!落点) {
      // resolveMergedKp 已经保证落点存在，走到这只可能是并发删行
      throw await 查无此考点(h, landed.id);
    }
    row = 落点;
    resolvedThrough = {
      originalId: 起点.id,
      hops: landed.hops,
      chain: landed.chain,
    };
  }

  const id = row.id;

  const aliases = (
    await q<{ alias: string }>(
      h,
      "SELECT alias FROM kp_alias WHERE kp_id = ? ORDER BY alias",
      [id],
    )
  ).map((a) => a.alias);

  const mergedFrom = await 反查合并来源(h, id);

  // ── 落点：node_kp_map → edition_node（沿 parent 上溯到根）→ edition_tree ──
  const nodes = await q<{
    node_id: string;
    tree_id: string | null;
    subject: string | null;
    edition: string | null;
    grade_sem: string | null;
    tree_status: string | null;
  }>(
    h,
    `SELECT n.id AS node_id, n.tree_id AS tree_id,
            t.subject AS subject, t.edition AS edition,
            t.grade_sem AS grade_sem, t.status AS tree_status
       FROM node_kp_map m
       JOIN edition_node n ON n.id = m.node_id
       LEFT JOIN edition_tree t ON t.id = n.tree_id
      WHERE m.kp_id = ?
      ORDER BY t.subject, t.edition, t.grade_sem, n.sort, n.id`,
    [id],
  );

  const placements: KpPlacement[] = [];
  for (const n of nodes) {
    placements.push({
      treeId: n.tree_id ?? "",
      subject: n.subject ?? "",
      edition: n.edition ?? "",
      gradeSem: n.grade_sem ?? "",
      treeStatus: n.tree_status,
      nodeId: n.node_id,
      path: await 节点路径(h, n.node_id),
    });
  }

  const counts = {
    questions: await count(
      h,
      "SELECT COUNT(*) AS c FROM question_kp WHERE kp_id = ?",
      [id],
    ),
    examModels: await count(
      h,
      "SELECT COUNT(*) AS c FROM exam_model WHERE kp_id = ?",
      [id],
    ),
    errorCauses: await count(
      h,
      "SELECT COUNT(*) AS c FROM kp_error WHERE kp_id = ?",
      [id],
    ),
  };

  return {
    kp: {
      id: row.id,
      name: row.name,
      status: row.status,
      gradeBand: row.grade_band,
      domain: row.domain,
      topic: row.topic,
      cardMd: row.card_md,
    },
    aliases,
    ...(mergedFrom.length > 0 ? { mergedFrom } : {}),
    placements,
    counts,
    ...(resolvedThrough ? { resolvedThrough } : {}),
  };
}

/** 根 → 该节点的名字链（递归 CTE，带深度上限防坏数据死循环） */
async function 节点路径(h: CoreDbHandle, nodeId: string): Promise<string[]> {
  const rows = await q<{ name: string }>(
    h,
    `WITH RECURSIVE up(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM edition_node WHERE id = ?
        UNION ALL
        SELECT n.id, n.parent_id, n.name, up.depth + 1
          FROM edition_node n JOIN up ON n.id = up.parent_id
         WHERE up.depth < 32
      )
      SELECT name FROM up ORDER BY depth DESC`,
    [nodeId],
  );
  return rows.map((r) => r.name);
}

/** 哪些考点被合并进了它（递归展开：A→B→C，查 C 能看到 A 和 B） */
async function 反查合并来源(
  h: CoreDbHandle,
  id: string,
): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>([id]);
  let 待查 = [id];
  while (待查.length > 0 && out.length < MERGED_FROM_MAX) {
    const 本轮: string[] = [];
    for (const cur of 待查) {
      const rows = await q<{ id: string; name: string }>(
        h,
        "SELECT id, name FROM kp WHERE merged_into = ? ORDER BY id",
        [cur],
      );
      for (const r of rows) {
        if (seen.has(r.id)) continue; // 环：见过就不再展开
        seen.add(r.id);
        out.push(r);
        本轮.push(r.id);
      }
    }
    待查 = 本轮;
  }
  return out;
}

/**
 * 造一个「查无此考点」的错误，**尽力带上候选**。
 *
 * 编造的 id 有两种形态，处置不同：
 *   kp_绝对值压轴  → `kp_` 后面不是 ULID 形状 ⇒ 里面是可读文本，拿去跑 resolveKp；
 *   kp_01JXXX…    → 纯 ULID 形状 ⇒ 猜不出人想找什么，candidates 空，
 *                   但 message 必须写清「用 resolve_kp 按名字查」。
 */
async function 查无此考点(
  h: CoreDbHandle,
  id: string,
): Promise<KpNotFoundError> {
  const 可读 = 从id里读出文本(id);
  const 头 = `考点 ${id} 不存在（🔴 kp_id 一律 resolve 出来，禁编造）。`;

  if (可读 === null) {
    return new KpNotFoundError(
      id,
      [],
      头 +
        "这个 id 是合法 ULID 形状但库里没有这行，猜不出你要找什么——" +
        '按名字查请先调 resolve_kp（例：resolve_kp{"query":"绝对值"}），拿它给的 kpId 再调 kp_context。',
    );
  }

  // 🔴 enqueue:false：这是「帮你找补」的顺手一查，不是 agent 的正经检索，
  //    没把握也不该往人的待办队列里塞工单。
  const { candidates } = await resolveKp(可读, {
    handle: h,
    limit: 5,
    enqueue: false,
  });

  if (candidates.length === 0) {
    return new KpNotFoundError(
      id,
      [],
      头 +
        `从 id 里读出的是「${可读}」，但按这个词也查不到任何考点——` +
        "要么换个说法调 resolve_kp，要么这个考点确实还没建（建了才谈得上挂载）。",
    );
  }

  const 列表 = candidates
    .map((c) => `${c.kpId}「${c.name}」(${c.confidence})`)
    .join("、");
  return new KpNotFoundError(
    id,
    candidates,
    头 +
      `从 id 里读出的是「${可读}」，最近似的候选：${列表}——` +
      "挑一个真 kpId 再调 kp_context；都不对就调 resolve_kp 换个说法。",
  );
}

/** ULID 本体形状（Crockford Base32，26 位） */
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 从（编造的）id 里抠出可读文本；纯 ULID 形状返回 null */
export function 从id里读出文本(id: string): string | null {
  const body = id.startsWith("kp_") ? id.slice(3) : id;
  if (ULID_SHAPE.test(body)) return null;
  const t = body.trim();
  return t.length > 0 ? t : null;
}
