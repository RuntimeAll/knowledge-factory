"use server";

/**
 * SKU 台账页的写动作（AI:PRD-008 · P2 · 白名单第二类「上架/下架」）
 *
 * 🔴 这一页只有**一个**写动作：改 sku.status。设计稿 §六 D2 的白名单五类里，
 *    生产管理占的就是这一类；建册/装题/登记产出/出卷全是**数据生产类**，
 *    一律走 agent/MCP，页面连按钮都不给（给了就等于开第二条写路径）。
 * 🔴 调的是 core 现成的原语 {@link setSkuStatus} —— 页面不自造写路径：
 *    core 的写全经 withCoreWrite（开闸/业务写/审计/关闸 同一事务），
 *    页面绕过去写一行，审计链就有洞，「可对账」整套说法作废。
 * 🔴 二次确认在**页面侧**做（`/sku/[id]/status` 那张确认页），本文件只管执行 ——
 *    与 003-D 的「破坏性动作走确认页」一个规矩。
 *
 * 沿用 002-D 的三条写法约定（正本注释在 `app/kg/actions.ts`）：
 *   ① actor 一律 human —— 页面上的写是人点的；
 *   ② 错误不抛给框架 —— catch 住翻人话，`?err=` 带回原页面（报错本身就是操作指引）；
 *   ③ redirect() 必须在 try 之外 —— 它靠抛 NEXT_REDIRECT 工作，包在 try 里会被自己吃掉。
 *
 * 🔴 helper 为什么不复用 `app/kg/shared.ts`：那份的 humanError 只认 KgError /
 *    QueueError，本页抛的是 SkuError。"use server" 文件又只准导出 async 函数，
 *    所以这几个私器就地放在本文件里（不导出）。
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SKU_STATUSES, SkuError, setSkuStatus, type SkuStatus } from "~/core";

/** 页面上的写，审计里一律记 actor='human'（点按钮的是人） */
const PAGE_ACTOR = "human" as const;

function field(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** 异常 → 人话（带稳定错误码）。🔴 一个字都不吞 */
function humanError(e: unknown): string {
  if (e instanceof SkuError) return `[${e.code}] ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** 给路径挂一句回执（?ok= / ?err=） */
function withMsg(path: string, msg: { ok?: string; err?: string }): string {
  const p = new URLSearchParams();
  if (msg.err) p.set("err", msg.err);
  else if (msg.ok) p.set("ok", msg.ok);
  const s = p.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

/** 回哪一页：确认页带过来的 back（只认站内路径，防开放重定向） */
function backOf(fd: FormData, dflt: string): string {
  const b = field(fd, "back");
  return b.startsWith("/") && !b.startsWith("//") ? b : dflt;
}

/**
 * 上架 / 下架（sku.status: draft → active → retired，反向也行）。
 *
 * 🔴 core 的 setSkuStatus **不校验流转方向**（下架的册子重新上架是真事），
 *    但每一跳都留审计行 —— 页面照实说，不假装这里有个状态机。
 */
export async function setSkuStatusAction(fd: FormData): Promise<void> {
  const id = field(fd, "id");
  const to = field(fd, "to");
  const note = field(fd, "note");
  const back = backOf(fd, `/sku/${id}`);

  let msg: { ok?: string; err?: string };
  try {
    if (!(SKU_STATUSES as readonly string[]).includes(to)) {
      throw new Error(
        `目标状态「${to}」不在 sku 的三态里（${SKU_STATUSES.join(
          " / ",
        )}）——地址栏被改过？`,
      );
    }
    const r = await setSkuStatus(id, to as SkuStatus, {
      note: note || undefined,
      actor: PAGE_ACTOR,
    });
    msg = {
      ok:
        `册子 ${r.skuId} 的状态：${r.from ?? "（原来是空）"} → ${r.to}` +
        `（审计行 seq ${r.seq}）` +
        (note ? `；备注已记进审计参数：${note}` : ""),
    };
  } catch (e) {
    msg = { err: humanError(e) };
  }

  revalidatePath("/sku");
  revalidatePath(`/sku/${id}`);
  redirect(withMsg(back, msg));
}
