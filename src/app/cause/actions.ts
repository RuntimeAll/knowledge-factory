"use server";

/**
 * 错因管理页的写动作（AI:PRD-008 · P2 学情中心）
 *
 * 🔴 **写操作白名单**（设计稿 §六 D2 五类之一：补错因映射）。本文件只有三个动作，
 *    每个都是「读表单 → 调一个 core 原语 → 回执带回」，壳里没有业务逻辑：
 *      · mapErrCodeAction    补映射   = mapErrCode
 *      · unmapErrCodeAction  摘除     = unmapErrCode
 *      · remapErrCodeAction  改指     = unmapErrCode + mapErrCode（🔴 core 规定的先摘后挂）
 *    错因实体本身的建/退役（createErrorCause / retireCause）**不在页面上做** ——
 *    那是数据生产类的写，走 agent/MCP。
 *
 * 沿用 002-D 定下的三条写法约定（正本注释在 `app/kg/actions.ts`）：
 *   ① actor 一律 human —— 页面上的写是人点的；
 *   ② 错误不抛给框架 —— catch 住翻人话，`?err=` 带回原页面（报错本身就是操作指引）；
 *   ③ redirect() 必须在 try 之外 —— 它靠抛 NEXT_REDIRECT 工作，包在 try 里会被自己吃掉。
 *
 * 🔴 为什么改指不是一个原语：core 的 mapErrCode 撞键**不静默覆盖**（抛 MAP_TAKEN），
 *    理由写在 core/cause.ts 里 —— 这张表是历史统计的解释器，悄悄改一条映射等于把
 *    过去所有报表的口径也改了。先摘后挂 = 两条审计行，翻账能看见「什么时候改的、
 *    从谁改到谁」。本动作照这条规矩串两步，**并且如实报告半路失败**（摘掉了没挂上
 *    就是 unmapped，页面会说清楚下一步该干什么，绝不假装成功）。
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { CauseError, mapErrCode, unmapErrCode } from "~/core";
import { PAGE_ACTOR, field, humanError, withMsg } from "../kg/shared";

/** CauseError → 人话（带稳定错误码与候选考点；一个字不吞） */
function 人话(e: unknown): string {
  if (e instanceof CauseError) {
    const 候选 =
      e.candidates && e.candidates.length > 0
        ? `\n候选考点：${e.candidates
            .map((c) => `${c.name}(${c.kpId})`)
            .join("、")}`
        : "";
    return `[${e.code}] ${e.message}${候选}`;
  }
  return humanError(e);
}

/** 补映射：登记一条 (考点, 码) → 错因 的翻译。 */
export async function mapErrCodeAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");
  const errCode = field(fd, "errCode");
  const causeId = field(fd, "causeId");

  let msg: { ok?: string; err?: string };
  try {
    const r = await mapErrCode(kpId, errCode, causeId, {
      by: PAGE_ACTOR,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok:
        `已登记：(考点「${r.kpName}」, 码 ${r.errCode}) → 错因「${r.causeName}」` +
        `（审计行 seq ${r.seq}，mapped_by=${r.mappedBy ?? "—"} / ${r.mappedAt}）。` +
        "🔴 这条映射即刻改变历史统计的解释：以前落进 unmapped 的这些码次，从现在起会算到这个错因头上。",
    };
  } catch (e) {
    msg = { err: 人话(e) };
  }

  revalidatePath("/cause");
  redirect(withMsg("/cause", msg));
}

/** 摘除：拿掉一条 (考点, 码) → 错因 映射（这个码会当场回到 unmapped 红旗里）。 */
export async function unmapErrCodeAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");
  const errCode = field(fd, "errCode");

  let msg: { ok?: string; err?: string };
  try {
    const r = await unmapErrCode(kpId, errCode, { actor: PAGE_ACTOR });
    msg = {
      ok:
        `已摘除：(考点「${r.kpName}」, 码 ${r.errCode}) 不再指向 ${r.causeId}` +
        `（审计行 seq ${r.seq}）。🔴 这个码从现在起进 unmapped 红旗队列 ——` +
        "它没有被静默丢掉，红旗会一直带着 batch/qno 样本指路。",
    };
  } catch (e) {
    msg = { err: 人话(e) };
  }

  revalidatePath("/cause");
  redirect(withMsg("/cause", msg));
}

/**
 * 改指：把一条 (考点, 码) 从旧错因改到新错因。
 * 🔴 严格照 core 的规矩走「先摘后挂」两步两条审计行；半路失败**如实报告**。
 */
export async function remapErrCodeAction(fd: FormData): Promise<void> {
  const kpId = field(fd, "kpId");
  const errCode = field(fd, "errCode");
  const causeId = field(fd, "causeId");

  let msg: { ok?: string; err?: string };
  let 摘了 = false;
  try {
    const 摘 = await unmapErrCode(kpId, errCode, { actor: PAGE_ACTOR });
    摘了 = true;
    const 挂 = await mapErrCode(kpId, errCode, causeId, {
      by: PAGE_ACTOR,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok:
        `已改指：(考点「${挂.kpName}」, 码 ${挂.errCode}) 从 ${摘.causeId} → ` +
        `错因「${挂.causeName}」(${挂.causeId})。两条审计行：摘 seq ${摘.seq} / 挂 seq ${挂.seq}。`,
    };
  } catch (e) {
    msg = {
      err: 摘了
        ? `🔴 半路失败：旧映射**已经摘掉了**，新的没挂上 —— ` +
          `(考点 ${kpId}, 码 ${errCode}) 现在没有映射，它已经回到 unmapped 红旗队列里。\n` +
          `请立刻在「补映射」页把它挂到你想要的错因上。原文报错：\n${人话(e)}`
        : 人话(e),
    };
  }

  revalidatePath("/cause");
  redirect(withMsg("/cause", msg));
}
