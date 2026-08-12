/**
 * KG 治理页的公共小工具（AI:PRD-002 · 002-D）
 *
 * 🔴 单独一个文件的理由：actions.ts 打了 "use server"，那种文件**只能导出 async 函数**
 *    （Next 的硬约束）。常量、纯函数、类型只能落在这里。
 */
import { KgError, KpNotFoundError, QueueError } from "~/core";

/**
 * 页面上的写操作，审计里一律记 actor='human'：
 * 点按钮的是人，即使 core 默认值是 agent。裁决人（review_queue.verdict_by）同理。
 */
export const PAGE_ACTOR = "human" as const;

/** 表单取值（FormData 的值可能是 File，一律按字符串收，去空白） */
export function field(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 异常 → 人话（带稳定错误码）。
 * 🔴 一个字都不吞：本地工具页，看不见原文的报错等于没报。
 */
export function humanError(e: unknown): string {
  if (e instanceof KgError || e instanceof QueueError) {
    return `[${e.code}] ${e.message}`;
  }
  if (e instanceof KpNotFoundError) {
    return `[${e.code}] ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 给路径挂一句回执（?ok= / ?err=，页面顶部显示成绿条/朱批红条） */
export function withMsg(
  path: string,
  msg: { ok?: string; err?: string },
): string {
  const p = new URLSearchParams();
  if (msg.err) p.set("err", msg.err);
  else if (msg.ok) p.set("ok", msg.ok);
  const s = p.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

/** searchParams 里取一个标量（Next 给的可能是数组） */
export function param(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

/** 版本树的人读标签：人教版 · 七下 */
export function treeLabel(t: {
  subject: string;
  edition: string;
  gradeSem: string;
}): string {
  return `${t.edition} · ${t.gradeSem}`;
}
