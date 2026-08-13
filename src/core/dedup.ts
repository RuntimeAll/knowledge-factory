/**
 * core/dedup.ts —— 出册前置闸：这批题**是不是已经卖过了**（AI:PRD-005 · 005-B）
 *
 * 录题管道里已经有闸⑦查重（`gates/ingest-dedup.gate.ts`），它回答的是
 * 「这题库里有没有」。本文件回答的是产线真正怕的那个问题：
 *
 *   🔴 **「这题我是不是已经装进某一本卖出去的册子里了」**
 *
 * 差别在**归因**：闸⑦撞了只会说「撞了 q_01KZ…」，而出册的人需要知道的是
 * 「撞的是《绝对值突破·十天打卡》第 37 题，那本已经在售」——
 * 前者只能让人停手，后者才能让人决策（换题 / 换套 / 就是要复用）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 两层结论，永远分开摆（与 checkDuplicate 同一条纪律）
 *
 *   collisions（拦）  match_key 撞上 = 归一后**一模一样**，这是事实判断。
 *                     撞到的题若挂在某个 SKU 上 ⇒ 带出是哪本、什么型、什么态；
 *                     没挂 SKU 也照报（撞的是库存题，同样是重复）。
 *   similar（不拦）    向量相似，只报不拦。**同款不同参是合法生产**：
 *                     打卡册天天出「同一个模板换数」的题，余弦 0.97 是常态，
 *                     拦了就等于不许出题。给人看，别替人裁。
 *
 * 🔴 match_key 必须与管道**同一把尺子**算：先剥指令词、再清前缀，最后 matchKeyOf。
 *    少剥一层，这里算出来的键就和入库时的键不是一个东西 —— 断言会绿、入库照样撞，
 *    那比没有断言更糟（它给了一个假的放心）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { embedTexts } from "./embed";
import { getCoreDb, type CoreDbHandle } from "./db";
import { matchKeyOf } from "./gates/ingest-dedup.gate";
import { stripLeadInstruction } from "./gates/ingest-instruction.gate";
import { cleanStemPrefix } from "./gates/ingest-prefix.gate";
import { stemBrief } from "./retrieval";
import { cosineTopK, vecAxisStatus } from "./vec";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/**
 * 语义相似的**报告线**（不是拦截线）。
 * 0.95 以上仍然天天出现在合法生产里（同模板换数），所以它只进 warnings。
 */
export const SIMILAR_REPORT_AT = 0.95;

/** 撞到的题挂在哪本册子上 */
export interface SkuOwner {
  skuId: string;
  name: string;
  type: string | null;
  status: string | null;
  /** 在那本册里的位次（sku_item.ord） */
  ord: number | null;
}

/** 撞到的一道库内题 */
export interface DupHit {
  questionId: string;
  status: string;
  stemBrief: string;
  /** 🔴 空数组 = 撞的是库存题（没进过任何册子），照样是重复 */
  skus: SkuOwner[];
}

export interface SoldCollision {
  /** 入参里的批内序号（没给就是下标+1） */
  seq: number;
  /** 入参数组下标（定位用，seq 可能是喂料方自己的编号） */
  index: number;
  matchKey: string;
  stemBrief: string;
  hits: DupHit[];
}

export interface SoldSimilar {
  seq: number;
  index: number;
  questionId: string;
  score: number;
  stemBrief: string;
  skus: SkuOwner[];
}

export interface SoldDupResult {
  /** 🔴 = 没有 collisions（similar 不影响它） */
  ok: boolean;
  checked: number;
  collisions: SoldCollision[];
  /** 只报不拦的语义近似（≥ threshold） */
  similar: SoldSimilar[];
  /** 报告线 */
  threshold: number;
  /** 语意轴没开/降级时为 true，similar 恒空 —— 如实说，不假装查过 */
  degraded: boolean;
  warnings: string[];
}

export interface SoldDupItem {
  /** 批内序号（不给就用下标+1） */
  seq?: number;
  stem: string;
}

export interface AssertSoldOptions {
  handle?: CoreDbHandle;
  /** 关掉语义轴（大批量时省一次向量计算）。默认开 */
  similar?: boolean;
  /** 报告线，默认 {@link SIMILAR_REPORT_AT} */
  similarAt?: number;
  /** 每题取几条语义近邻，默认 3 */
  similarTopK?: number;
}

// ---------------------------------------------------------------------------
// 实现
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

/**
 * 与管道相一**同款**的题面变换 → match_key。
 * 🔴 顺序不能换：先剥指令词（「计算：」），再清前缀（题号/标签），最后算键。
 */
export function matchKeyOfStem(stem: string): string {
  const ins = stripLeadInstruction(stem ?? "");
  const cl = cleanStemPrefix(ins.text.trim());
  return matchKeyOf(cl.text);
}

/** 一批题 id → 各自挂在哪些 SKU 上 */
async function 归因(
  h: CoreDbHandle,
  questionIds: string[],
): Promise<Map<string, SkuOwner[]>> {
  const out = new Map<string, SkuOwner[]>();
  if (questionIds.length === 0) return out;
  const 占位 = questionIds.map(() => "?").join(",");
  const rows = await q<{
    question_id: string;
    ord: number | null;
    sku_id: string;
    name: string;
    type: string | null;
    status: string | null;
  }>(
    h,
    `SELECT si.question_id AS question_id, si.ord AS ord,
            s.id AS sku_id, s.name AS name, s.type AS type, s.status AS status
       FROM sku_item si JOIN sku s ON s.id = si.sku_id
      WHERE si.question_id IN (${占位})
      ORDER BY s.created_at, si.ord`,
    questionIds,
  );
  for (const r of rows) {
    const list = out.get(r.question_id) ?? [];
    list.push({
      skuId: r.sku_id,
      name: r.name,
      type: r.type,
      status: r.status,
      ord: r.ord === null ? null : Number(r.ord),
    });
    out.set(r.question_id, list);
  }
  return out;
}

/**
 * 出册前置闸：这批题撞没撞已售/库存。
 *
 * ```ts
 * const r = await assertNoSoldDuplicates(items.map((it) => ({ seq: it.seq, stem: it.stem })));
 * if (!r.ok) for (const c of r.collisions) {
 *   console.log(`seq=${c.seq} 撞：`, c.hits.flatMap((h) => h.skus.map((s) => s.name)));
 * }
 * ```
 *
 * 🔴 只读，一个字节都不写库（它是**出册前**的问句，不是入库动作）。
 */
export async function assertNoSoldDuplicates(
  items: SoldDupItem[],
  options: AssertSoldOptions = {},
): Promise<SoldDupResult> {
  const list = Array.isArray(items) ? items : [];
  const h = options.handle ?? (await getCoreDb());
  const threshold = options.similarAt ?? SIMILAR_REPORT_AT;
  const topK = Math.max(1, Math.trunc(options.similarTopK ?? 3));
  const warnings: string[] = [];

  const 行 = list.map((it, index) => {
    const stem = String(it.stem ?? "");
    return {
      index,
      seq: it.seq ?? index + 1,
      stem,
      key: matchKeyOfStem(stem),
    };
  });
  const 空题 = 行.filter((r) => r.stem.trim() === "");
  if (空题.length > 0) {
    warnings.push(
      `有 ${空题.length} 道题的 stem 是空的（seq=${空题.map((r) => r.seq).join("、")}）——` +
        "空题面算不出 match_key，这里照算（空串的 hash），但它们本来就过不了录题闸⑥。",
    );
  }

  // ── 硬撞：match_key ────────────────────────────────────────────────────────
  const collisions: SoldCollision[] = [];
  const keys = [...new Set(行.map((r) => r.key))];
  const 撞到 = new Map<
    string,
    { id: string; status: string; stem: string }[]
  >();
  if (keys.length > 0) {
    const 占位 = keys.map(() => "?").join(",");
    const rows = await q<{
      id: string;
      status: string;
      stem: string;
      match_key: string;
    }>(
      h,
      `SELECT id, status, stem, match_key
         FROM question
        WHERE match_key IN (${占位}) AND status IN ('pending','active')
        ORDER BY id`,
      keys,
    );
    for (const r of rows) {
      const l = 撞到.get(r.match_key) ?? [];
      l.push({
        id: String(r.id),
        status: String(r.status),
        stem: String(r.stem),
      });
      撞到.set(r.match_key, l);
    }
  }

  const 归属 = await 归因(
    h,
    [...撞到.values()].flat().map((x) => x.id),
  );

  for (const r of 行) {
    const hitRows = 撞到.get(r.key);
    if (!hitRows || hitRows.length === 0) continue;
    collisions.push({
      seq: r.seq,
      index: r.index,
      matchKey: r.key,
      stemBrief: stemBrief(r.stem),
      hits: hitRows.map((x) => ({
        questionId: x.id,
        status: x.status,
        stemBrief: stemBrief(x.stem),
        skus: 归属.get(x.id) ?? [],
      })),
    });
  }

  // ── 软报：语义近似（只报不拦）──────────────────────────────────────────────
  const similar: SoldSimilar[] = [];
  let degraded = false;
  if (options.similar === false) {
    warnings.push(
      "语意轴本次被显式关掉（similar:false）：只做了 match_key 硬撞。",
    );
    degraded = true;
  } else if (行.length === 0) {
    degraded = false;
  } else {
    const st = await vecAxisStatus(h);
    if (!st.ok) {
      degraded = true;
      warnings.push(
        `语意轴降级，本次只做了 match_key 硬撞：${st.reason ?? "原因不明"}` +
          "（🔴 这意味着「同款不同参」这类近似撞车这次没查——不是没有）",
      );
    } else {
      // 🔴 一次 embedTexts 吃整批：一题一次会把 300 题的批拖成 300 次模型调用
      const vecs = await embedTexts(行.map((r) => r.stem));
      const 近邻: { row: (typeof 行)[number]; id: string; score: number }[] =
        [];
      for (const [i, v] of vecs.entries()) {
        const row = 行[i]!;
        const top = await cosineTopK(v, { limit: topK, handle: h });
        for (const t of top) {
          if (t.score < threshold) continue;
          近邻.push({ row, id: t.questionId, score: t.score });
        }
      }
      if (近邻.length > 0) {
        const ids = [...new Set(近邻.map((x) => x.id))];
        const 占位 = ids.map(() => "?").join(",");
        const rows = await q<{ id: string; stem: string }>(
          h,
          `SELECT id, stem FROM question WHERE id IN (${占位})`,
          ids,
        );
        const 题面 = new Map(rows.map((x) => [String(x.id), String(x.stem)]));
        const 近邻归属 = await 归因(h, ids);
        for (const x of 近邻) {
          similar.push({
            seq: x.row.seq,
            index: x.row.index,
            questionId: x.id,
            score: Math.round(x.score * 10000) / 10000,
            stemBrief: stemBrief(题面.get(x.id) ?? ""),
            skus: 近邻归属.get(x.id) ?? [],
          });
        }
        warnings.push(
          `语义相似 ≥${threshold} 的有 ${similar.length} 处 —— **只报不拦**：` +
            "同模板换数本来就该长得像，是不是重复得人来判。",
        );
      }
    }
  }

  return {
    ok: collisions.length === 0,
    checked: 行.length,
    collisions,
    similar,
    threshold,
    degraded,
    warnings,
  };
}
