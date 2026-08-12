"use server";

/**
 * KG 治理页的写动作（AI:PRD-002 · 002-D）
 *
 * 每个动作都是「读表单 → 调一个 core 原语 → 回执带回页面」三步，**壳里没有业务逻辑**：
 * 校验、闸、审计行全在 core（app 层连 db 都 import 不到，ESLint 红线管着）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条本文件的写法约定
 *
 * ① **actor 一律 human**：页面上的写是人点的。core 的默认值是 agent，别省这一笔——
 *    审计里分不清人和 agent，「谁改的」就答不上来。
 *
 * ② **错误不抛给框架**：catch 住，翻成人话，用 `?err=` 带回原页面显示成朱批红。
 *    裸抛的结果是 Next 的错误页（生产还会被抹成 "an error occurred"），
 *    而 KG 的报错本身就是**操作指引**（「先转 readonly 再切」「重复考点走 mergeKp」），
 *    丢了它等于把人晾在那儿。
 *
 * ③ **redirect() 必须在 try 之外**：它靠抛 NEXT_REDIRECT 工作，包在 try 里会被
 *    自己的 catch 吃掉，页面就永远停在原地。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addKpAlias,
  integrityCheck,
  mergeKp,
  passQueueWithAlias,
  removeKpAlias,
  retireKp,
  setTreeStatus,
  verdictQueueItem,
  type CheckResult,
  type MergeKpResult,
} from "~/core";
import { stashMergeReceipt } from "./merge-store";
import { PAGE_ACTOR, field, humanError, withMsg } from "./shared";

/** 页面写操作在审计里的备注前缀（note 只进 args 摘要，这里图的是 tool+actor 之外的一点上下文） */
const NOTE = "KG 治理页";

// ---------------------------------------------------------------------------
// 版本树管理
// ---------------------------------------------------------------------------

/** 切一棵树的现役/归档状态（撞上同册双 active 时把 core 的人话原样端出来） */
export async function setTreeStatusAction(fd: FormData): Promise<void> {
  const treeId = field(fd, "treeId");
  const status = field(fd, "status") === "active" ? "active" : "readonly";
  const label = field(fd, "label") || treeId;

  let msg: { ok?: string; err?: string };
  try {
    await setTreeStatus(treeId, status, { actor: PAGE_ACTOR, note: NOTE });
    msg = {
      ok: `${label} 已切成 ${status === "active" ? "现役 active" : "归档 readonly"}`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/kg");
  redirect(withMsg("/kg", msg));
}

// ---------------------------------------------------------------------------
// 别名词表
// ---------------------------------------------------------------------------

export async function addAliasAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");
  const alias = field(fd, "alias");

  let msg: { ok?: string; err?: string };
  try {
    const r = await addKpAlias(kpId, alias, { actor: PAGE_ACTOR, note: NOTE });
    msg = {
      ok: r.inserted
        ? `别名「${alias}」已加（审计行 seq ${r.seq}）`
        : `别名「${alias}」本来就在，没重复加（幂等）`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath(`/kg/kp/${kpId}`);
  redirect(withMsg(`/kg/kp/${kpId}`, msg));
}

export async function removeAliasAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");
  const alias = field(fd, "alias");

  let msg: { ok?: string; err?: string };
  try {
    const r = await removeKpAlias(kpId, alias, {
      actor: PAGE_ACTOR,
      note: NOTE,
    });
    msg = { ok: `别名「${alias}」已删（审计行 seq ${r.seq}）` };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath(`/kg/kp/${kpId}`);
  redirect(withMsg(`/kg/kp/${kpId}`, msg));
}

// ---------------------------------------------------------------------------
// 退役（破坏性 · 页面上走确认页两步提交）
// ---------------------------------------------------------------------------

export async function retireKpAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");

  let msg: { ok?: string; err?: string };
  try {
    const r = await retireKp(kpId, { actor: PAGE_ACTOR, note: NOTE });
    msg = {
      ok:
        `考点已退役（审计行 seq ${r.seq}）。退役时身上的引用：` +
        `${r.refs.合计} 条 —— 它从此不再是可挂载的考点。`,
    };
  } catch (e) {
    // 🔴 KP_HAS_REFS 的报错里带着逐表明细和「重复考点请走 mergeKp」的指引，原样端出来
    msg = { err: humanError(e) };
  }

  revalidatePath(`/kg/kp/${kpId}`);
  redirect(withMsg(`/kg/kp/${kpId}`, msg));
}

// ---------------------------------------------------------------------------
// 合并（破坏性 · 页面上走预览页两步提交）
// ---------------------------------------------------------------------------

/**
 * 执行合并，然后**立刻跑一次对账**，把 C2（悬挂引用）的结论一起存进回执。
 *
 * 🔴 为什么非要跟着跑对账：合并是本系统唯一会把「一个考点身上所有引用整体搬家」的动作，
 *    漏搬一张表的后果是悄悄的（题挂在 merged 壳上，检索照样返回空）。C2 就是这件事的
 *    机器背书 —— 绿了才敢说这次合并干净。它慢（扫全表 + 连圣域），但一次合并跑一次值。
 */
export async function mergeKpAction(fd: FormData): Promise<void> {
  const from = field(fd, "from");
  const to = field(fd, "to");
  const back =
    `/kg/merge/preview?from=${encodeURIComponent(from)}` +
    `&to=${encodeURIComponent(to)}`;

  let result: MergeKpResult;
  try {
    result = await mergeKp(from, to, { actor: PAGE_ACTOR, note: NOTE });
  } catch (e) {
    revalidatePath("/kg");
    redirect(withMsg(back, { err: humanError(e) }));
  }

  let c2: CheckResult | null = null;
  let integrityOk: boolean | null = null;
  let integrityError: string | null = null;
  try {
    const report = await integrityCheck();
    c2 = report.checks.find((c) => c.id === "C2") ?? null;
    integrityOk = report.ok;
  } catch (e) {
    integrityError = humanError(e);
  }

  stashMergeReceipt(result.seq, {
    result,
    c2,
    integrityOk,
    integrityError,
    at: new Date().toISOString(),
  });

  revalidatePath("/kg");
  redirect(`/kg/merge/done/${result.seq}`);
}

// ---------------------------------------------------------------------------
// 审查队列
// ---------------------------------------------------------------------------

/** 通过 / 驳回一条工单（驳回在页面上走确认页，理由落 verdict_note） */
export async function verdictQueueAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const verdict = field(fd, "verdict") === "rejected" ? "rejected" : "passed";
  const note = field(fd, "note");

  let msg: { ok?: string; err?: string };
  try {
    const r = await verdictQueueItem(id, verdict, {
      by: PAGE_ACTOR,
      note: note || undefined,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok: `工单 ${id} 已${verdict === "passed" ? "通过" : "驳回"}（审计行 seq ${r.seq}）`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/kg/queue");
  redirect(withMsg("/kg/queue", msg));
}

/**
 * 低置信工单的快捷处置：把工单里那句问不出来的说法，补成某个考点的别名，工单同时判过。
 * 一次点击串完两笔 core 写（顺序与失败语义见 core/queue.ts 的 passQueueWithAlias）。
 */
export async function quickAliasAction(fd: FormData): Promise<void> {
  const queueId = field(fd, "queueId");
  const kpId = field(fd, "kpId");
  const alias = field(fd, "alias");
  const kpName = field(fd, "kpName") || kpId;

  let msg: { ok?: string; err?: string };
  try {
    const r = await passQueueWithAlias(
      queueId,
      { kpId, alias, by: PAGE_ACTOR },
      { actor: PAGE_ACTOR },
    );
    msg = {
      ok:
        `「${alias}」已${r.alias.inserted ? "补进" : "本来就在"}「${kpName}」的别名词表` +
        `（别名 seq ${r.alias.seq} / 裁决 seq ${r.verdict.seq}），工单已通过。`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/kg/queue");
  redirect(withMsg("/kg/queue", msg));
}
