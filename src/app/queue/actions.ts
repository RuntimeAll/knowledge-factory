"use server";

/**
 * 审查队列页的写动作（AI:PRD-003 · 003-D）
 *
 * 沿用 002-D 的三条写法约定（正本注释在 `app/kg/actions.ts`）：
 *   ① actor 一律 human —— 页面上的写是人点的；
 *   ② 错误不抛给框架 —— catch 住翻人话，`?err=` 带回原页面（报错本身就是操作指引）；
 *   ③ redirect() 必须在 try 之外 —— 它靠抛 NEXT_REDIRECT 工作，包在 try 里会被自己吃掉。
 *
 * 🔴 本文件仍然「壳里没有业务逻辑」：每个动作都是「读表单 → 调一个 core 原语 → 回执带回」。
 *    图审是不是该摘 review_required、转正红了要不要保留工单、隔离行怎么结 ——
 *    全在 core/review.ts 里判，页面只负责把结果说给人听。
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  passFigureReview,
  passQueueWithAlias,
  promoteDraftQuestion,
  rejectFigureReview,
  resolveQuarantine,
  verdictQueueItem,
  type PrecheckRed,
} from "~/core";
import { PAGE_ACTOR, field, humanError, withMsg } from "../kg/shared";

/** 回哪一页（tab 保住，否则处置完一条就被弹回默认 tab，处理一列工单要点二十次） */
function 回队列(fd: FormData): string {
  const tab = field(fd, "tab");
  const state = field(fd, "state");
  const p = new URLSearchParams();
  if (tab) p.set("tab", tab);
  if (state) p.set("state", state);
  const s = p.toString();
  return s ? `/queue?${s}` : "/queue";
}

/** 红灯清单 → 一段人话（🔴 原文照登，不缩成「有 N 处错误」） */
function 红灯人话(reds: PrecheckRed[]): string {
  return reds.map((r) => `${r.gate}[${r.code}] ${r.message}`).join("\n");
}

// ---------------------------------------------------------------------------
// 通用裁决（kp低置信 / KG提议 / 其他）
// ---------------------------------------------------------------------------

export async function verdictQueueAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const verdict = field(fd, "verdict") === "rejected" ? "rejected" : "passed";
  const note = field(fd, "note");
  const back = 回队列(fd);

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

  revalidatePath("/queue");
  redirect(withMsg(back, msg));
}

/** 低置信工单快捷处置：把那句问不出来的说法补成别名，工单同时判过 */
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

  revalidatePath("/queue");
  redirect(withMsg("/queue?tab=kp", msg));
}

// ---------------------------------------------------------------------------
// 图片工单
// ---------------------------------------------------------------------------

/** 图审通过（core 单事务串完：图 passed → 全过则摘必审 → 工单判过） */
export async function passFigureAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const note = field(fd, "note");
  const back = 回队列(fd);

  let msg: { ok?: string; err?: string };
  try {
    const r = await passFigureReview(id, {
      by: PAGE_ACTOR,
      note: note || undefined,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok:
        `图审通过：${r.figureIds.length} 张题干图判 passed，` +
        (r.reviewRequired === 0
          ? `题 ${r.questionId} 已摘掉必审（review_required=0）`
          : `题 ${r.questionId} 还有没过的题干图，继续挂着必审`) +
        `（审计行 seq ${r.seq}）`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/queue");
  redirect(withMsg(back, msg));
}

/** 图审驳回（走确认页，理由必填）——题**保持**必审，不自动隔离 */
export async function rejectFigureAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const note = field(fd, "note");

  let msg: { ok?: string; err?: string };
  try {
    const r = await rejectFigureReview(id, {
      by: PAGE_ACTOR,
      note,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok:
        `图审驳回：${r.figureIds.length} 张题干图判 rejected；` +
        `题 ${r.questionId} 仍是 review_required=1（换图/改题/退役由你定，系统不替你决定）。`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/queue");
  redirect(withMsg("/queue?tab=figure", msg));
}

// ---------------------------------------------------------------------------
// 新题草稿
// ---------------------------------------------------------------------------

/**
 * 草稿转正：以工单 payload 为单题批跑管道。
 * 🔴 管道又红了 = 工单保持 open，把**新红灯原文**贴回页面（别吞成一句「失败了」）。
 */
export async function promoteDraftAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const back = 回队列(fd);

  let msg: { ok?: string; err?: string };
  try {
    const r = await promoteDraftQuestion(id, {
      by: PAGE_ACTOR,
      actor: PAGE_ACTOR,
    });
    msg = r.promoted
      ? {
          ok:
            `已转正入库：${r.questionId}（批 ${r.batchId}）` +
            (r.precheck.reviewRequired
              ? "；该题带题干图，另开了一张图审工单"
              : "") +
            "。题落 status=pending。",
        }
      : {
          err:
            "转正没成 —— 管道这次又红了，工单还开着（改完 payload 再来）：\n" +
            红灯人话(r.precheck.reds),
        };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/queue");
  redirect(withMsg(back, msg));
}

// ---------------------------------------------------------------------------
// 隔离区
// ---------------------------------------------------------------------------

/** 改判重投：拿人改过的 JSON 单题重投；还红就零写返回，页面显示新红灯 */
export async function reingestQuarantineAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const raw = field(fd, "payload");
  const note = field(fd, "note");
  const back = `/queue/quarantine/${id}`;

  let msg: { ok?: string; err?: string };
  try {
    let edited: unknown = undefined;
    if (raw) {
      try {
        edited = JSON.parse(raw);
      } catch (e) {
        throw new Error(
          `你改的 JSON 解析不了：${e instanceof Error ? e.message : String(e)}` +
            "（多半是漏了逗号或引号；原样贴回文本框改一改再提交）",
        );
      }
    }
    const r = await resolveQuarantine(id, {
      action: "reingest",
      editedPayload: edited,
      by: PAGE_ACTOR,
      note: note || undefined,
      actor: PAGE_ACTOR,
    });
    msg = r.resolved
      ? {
          ok: `改判重投成功：题已入库 ${r.questionId}（批 ${r.batchId}），本条隔离行已结（${r.resolvedAt}）。`,
        }
      : {
          err:
            "重投还是红的 —— 隔离行原样留着（🔴 没有因为这次重试多长一行），继续改：\n" +
            红灯人话(r.precheck?.reds ?? []),
        };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/queue");
  // 成了回列表；没成留在编辑页 —— 人还要接着改那段 JSON
  redirect(withMsg(msg.err ? back : "/queue?tab=quarantine", msg));
}

/** 废弃（破坏性 · 走确认页，理由必填） */
export async function discardQuarantineAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const note = field(fd, "note");

  let msg: { ok?: string; err?: string };
  try {
    const r = await resolveQuarantine(id, {
      action: "discard",
      by: PAGE_ACTOR,
      note,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok: `隔离行 ${id} 已废弃（${r.resolvedAt}）——理由已记进 quarantine.why 的处置行。`,
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/queue");
  redirect(withMsg("/queue?tab=quarantine", msg));
}
