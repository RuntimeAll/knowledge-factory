/**
 * 闸③ 考点标全（AI:PRD-003 · 003-C）—— 「标全三件套」里最硬的一条
 *
 * 规则：每题 ≥1 考点、**主考点恰一个**（不显式给就第一个当主）。
 * ref 两种形态，两条路：
 *
 *   kp_id 形状  → 直接查库：必须存在、且最终状态是 active。
 *                 命中 merged 壳 ⇒ 自动追链到落点并记 note（不静默换人）。
 *   名字        → resolveKp，🔴 **只认 confidence=1.0 的精确命中**（名全等或别名全等）。
 *                 - 唯一命中 → 取它；
 *                 - 一名多考点（真实例子：别名「绝对值压轴」指着 4 个考点）
 *                   → 红灯 AMBIGUOUS_KP，把 4 个候选全给回去，让喂料方指明 kp_id；
 *                 - 无精确命中 → 红灯 KP_NOT_FOUND，附最近似候选。
 *
 * 🔴 为什么录题这条路上「像」不算数（而 resolve_kp 那边 0.6 就算有把握）：
 *    resolve_kp 是**查**，候选给人/agent 挑，挑错了下一句就纠正；
 *    录题是**写**，挂错考点的题会一直躺在库里，被出题、被学情统计、被举一反三取料，
 *    错得悄无声息。所以这里的阈值不是 0.6 也不是 0.9，是 **1.0 或者红灯**。
 *
 * 🔴 resolveKp 一律传 `enqueue:false`：它默认会把低置信查询写进 review_queue，
 *    而那是**事务外的一次 core 写** —— 相一必须零写（dryRun 要能真 dry），
 *    相二的写只准发生在那一个事务里。
 */
import { isId } from "../ids";
import { resolveMergedKp } from "../kg";
import { resolveKp, type KpCandidate } from "../resolve";
import { type CoreDbHandle } from "../db";
import { fail, type Gate, type GateCandidate, type GateResult } from "./types";
import { type IngestItemCtx, type KpBinding } from "./ingest-context";

export const KP_CODES = {
  notFound: "KP_NOT_FOUND",
  ambiguous: "AMBIGUOUS_KP",
  idNotFound: "KP_ID_NOT_FOUND",
  notActive: "KP_NOT_ACTIVE",
  duplicate: "KP_DUPLICATE",
  primaryMulti: "KP_PRIMARY_MULTI",
} as const;

/** 精确命中的判据：名全等 / 别名全等（打分口径见 resolve.ts 文件头） */
export const EXACT_CONFIDENCE = 1;

function 候选转错误项(c: KpCandidate): GateCandidate {
  return {
    id: c.kpId,
    label: c.aliasHit ? `${c.name}（经别名「${c.aliasHit}」）` : c.name,
    score: c.confidence,
  };
}

interface KpRow {
  id: string;
  name: string;
  status: string;
}

async function 查考点(h: CoreDbHandle, id: string): Promise<KpRow | null> {
  const r = await h.client.execute({
    sql: "SELECT id, name, status FROM kp WHERE id = ?",
    args: [id],
  });
  return (r.rows[0] as unknown as KpRow) ?? null;
}

export const ingestKpGate: Gate<IngestItemCtx> = {
  name: "③考点标全",
  async run(ctx: IngestItemCtx): Promise<GateResult> {
    const h = ctx.batch.handle;
    const 位置 = `seq=${ctx.seq}`;
    const 绑定: KpBinding[] = [];

    // 主考点：显式标了几个（schema 已拦 >1，这里是防御 + 默认第一个）
    const 显式主 = ctx.item.kps.filter((k) => k.isPrimary === true);
    if (显式主.length > 1) {
      return fail({
        code: KP_CODES.primaryMulti,
        message: `${位置} 标了 ${显式主.length} 个主考点 —— 主考点恰一个（判错因、按考点召回都从主考点走；两个主考点在 idx_qkp_primary 上直接 UNIQUE 失败）。`,
        recoverable: true,
      });
    }

    for (const [i, ref] of ctx.item.kps.entries()) {
      const 是主 = 显式主.length > 0 ? ref.isPrimary === true : i === 0;

      // ── 路 A：ref 是 kp_id ────────────────────────────────────────────────
      if (isId(ref.ref, "kp")) {
        const row = await 查考点(h, ref.ref);
        if (!row) {
          return fail({
            code: KP_CODES.idNotFound,
            message: `${位置} kps[${i}].ref=${ref.ref} 在库里查无此考点（🔴 kp_id 一律 resolve 出来，禁编造）。按名字查请先调 resolve_kp，拿它给的 kpId 再录。`,
            recoverable: true,
            nextTool: "resolve_kp",
          });
        }
        let 落点 = row;
        let resolvedFrom: KpBinding["resolvedFrom"];
        if (row.status === "merged") {
          // 追链（成环/断链会抛 KgError，让它上抛——那是数据坏了，不是这题的错）
          const landed = await resolveMergedKp(h, row.id);
          const 行 = await 查考点(h, landed.id);
          if (!行) {
            return fail({
              code: KP_CODES.idNotFound,
              message: `${位置} kps[${i}].ref=${ref.ref} 是 merged 壳，追链落到 ${landed.id}，但那一行也不在库里（数据坏了，先去 KG 治理页看合并链）。`,
              recoverable: false,
            });
          }
          落点 = 行;
          resolvedFrom = { id: row.id, name: row.name, hops: landed.hops };
          ctx.derived.notes.push(
            `考点 ${row.id}「${row.name}」已合并，自动追链 ${landed.hops} 跳落到 ${落点.id}「${落点.name}」`,
          );
        }
        if (落点.status !== "active") {
          return fail({
            code: KP_CODES.notActive,
            message: `${位置} 考点「${落点.name}」(${落点.id}) 的 status='${落点.status}'，不是 active —— draft 是「建了还没审」、retired 是「已退役」，题挂上去等于把 KG 的闸绕开。先去 KG 治理页把它转正，或换一个活跃考点。`,
            recoverable: false,
          });
        }
        绑定.push({
          kpId: 落点.id,
          name: 落点.name,
          isPrimary: 是主,
          ref: ref.ref,
          ...(resolvedFrom ? { resolvedFrom } : {}),
        });
        continue;
      }

      // ── 路 B：ref 是名字（或别名）─────────────────────────────────────────
      const r = await resolveKp(ref.ref, {
        handle: h,
        limit: 8,
        enqueue: false, // 🔴 相一零写，见文件头
        // 🔴 knn:false（AI:PRD-004 · 004-B）：本闸**只认精确命中**（confidence
        //    必须 == EXACT_CONFIDENCE），而近邻投票封顶 0.65 —— 它一条都不可能
        //    被接受。开着它只有两个后果：每道过不了闸的题白付一次载模型的钱
        //    （整书录入就是几十上百次），以及在错误提示里塞一个「最像的是 X，
        //    置信 0.35」的语义猜测——而这里要的是"名字/别名对不对得上"。
        knn: false,
      });
      const 精确 = r.candidates.filter((c) => c.confidence >= EXACT_CONFIDENCE);

      if (精确.length === 0) {
        return fail({
          code: KP_CODES.notFound,
          message:
            `${位置} kps[${i}].ref=「${ref.ref}」没有**精确**命中任何考点` +
            (r.candidates.length > 0
              ? `（最像的是「${r.candidates[0]?.name}」，置信 ${r.candidates[0]?.confidence}）` +
                " —— 录题只认名/别名全等（1.0），像不算数：挂错的考点会一直影响出题与学情。" +
                "确认是它就直接传它的 kpId，或者去 KG 治理页给它补一条别名。"
              : " —— 词表里没有这个说法。要么换个说法，要么这个考点还没建（建了才谈得上挂载）。"),
          recoverable: true,
          nextTool: "resolve_kp",
          candidates: r.candidates.slice(0, 5).map(候选转错误项),
        });
      }

      if (精确.length > 1) {
        return fail({
          code: KP_CODES.ambiguous,
          message:
            `${位置} kps[${i}].ref=「${ref.ref}」精确命中了 ${精确.length} 个考点 —— ` +
            "同一个说法指着好几个考点（典型：别名「绝对值压轴」下挂着一整族），机器替你挑就是瞎猜。" +
            "从下面的候选里挑一个，直接传 kp_id。",
          recoverable: true,
          nextTool: "kp_context",
          candidates: 精确.map(候选转错误项),
        });
      }

      const hit = 精确[0]!;
      if (hit.status !== "active") {
        return fail({
          code: KP_CODES.notActive,
          message: `${位置} 「${ref.ref}」命中考点「${hit.name}」(${hit.kpId})，但它的 status='${hit.status}'，不是 active —— 先转正再挂题。`,
          recoverable: false,
        });
      }
      if (hit.resolvedFrom) {
        ctx.derived.notes.push(
          `考点「${ref.ref}」命中的是已合并的 ${hit.resolvedFrom.id}「${hit.resolvedFrom.name}」，自动追链 ${hit.resolvedFrom.hops} 跳落到 ${hit.kpId}「${hit.name}」`,
        );
      }
      绑定.push({
        kpId: hit.kpId,
        name: hit.name,
        isPrimary: 是主,
        ref: ref.ref,
        ...(hit.resolvedFrom ? { resolvedFrom: hit.resolvedFrom } : {}),
      });
    }

    // ── 解析后的去重（两个不同说法可能落到同一个考点）────────────────────────
    const 见过 = new Map<string, number>();
    for (const [i, b] of 绑定.entries()) {
      const 首 = 见过.get(b.kpId);
      if (首 !== undefined) {
        return fail({
          code: KP_CODES.duplicate,
          message: `${位置} kps[${首}]=「${绑定[首]!.ref}」与 kps[${i}]=「${b.ref}」解析后是同一个考点 ${b.kpId}「${b.name}」（question_kp 主键是 (question_id, kp_id)，重复会直接撞主键）。去掉一个。`,
          recoverable: true,
        });
      }
      见过.set(b.kpId, i);
    }

    if (显式主.length === 0) {
      ctx.derived.notes.push(
        `没显式指定主考点，按契约默认取第一个：${绑定[0]?.kpId}「${绑定[0]?.name}」`,
      );
    }
    ctx.derived.kps = 绑定;
    return { ok: true };
  },
};

export default ingestKpGate;
