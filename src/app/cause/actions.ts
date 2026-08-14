"use server";

/**
 * 错因管理页的写动作（AI:PRD-008 · P2 学情中心）
 *
 * 🔴 **写操作白名单**（设计稿 §六 D2 五类之一：补错因映射）。本文件只有**一个**动作：
 *      · mapErrCodeAction    补映射   = mapErrCode
 *    它是「读表单 → 调一个 core 原语 → 回执带回」，壳里没有业务逻辑。
 *
 * 🔴🔴 **改指 / 摘除已下线**（2026-08-14 验收判红：职责越界）。
 *    原本这儿还有 unmapErrCodeAction / remapErrCodeAction 两个动作 + 一页 `/cause/remap`，
 *    做法本身没毛病（二次确认、必填理由、审计全有），但**范围**不对：
 *    设计稿 §二·13 的操作列只点名「补映射」，§六 D2 的白名单五类也只有「补错因映射」，
 *    而删 err_code_map 行是破坏性写。要改判走 agent/MCP（core 的 unmapErrCode +
 *    mapErrCode，先摘后挂两条审计行）—— core 原语原样还在，只是页面不给这个口子。
 *    错因实体本身的建/退役（createErrorCause / retireCause）同理，不在页面上做。
 *
 * 沿用 002-D 定下的三条写法约定（正本注释在 `app/kg/actions.ts`）：
 *   ① actor 一律 human —— 页面上的写是人点的；
 *   ② 错误不抛给框架 —— catch 住翻人话，`?err=` 带回原页面（报错本身就是操作指引）；
 *   ③ redirect() 必须在 try 之外 —— 它靠抛 NEXT_REDIRECT 工作，包在 try 里会被自己吃掉。
 *
 * 🔴 core 的 mapErrCode 撞键**不静默覆盖**（抛 MAP_TAKEN），理由写在 core/cause.ts 里：
 *    这张表是历史统计的解释器，悄悄改一条映射等于把过去所有报表的口径也改了。
 *    所以本页的补映射只补**没映射过**的那些组，撞上已有映射就如实报错。
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { CauseError, mapErrCode } from "~/core";
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
