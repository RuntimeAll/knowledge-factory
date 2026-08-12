/**
 * /kg/queue —— 老地址，永久搬到 /queue（AI:PRD-003 · 003-D）
 *
 * 002-D 时队列只有「KG 提议 / kp低置信」两类，挂在 KG 治理页下面顺理成章。
 * 003 起队列长出了图审、新题草稿、隔离区 —— 它已经不是 KG 的附属品，而是
 * **全域的处置台**，所以升成顶级路由 /queue。
 *
 * 🔴 老地址留一个重定向而不是直接删：书签、旧回执链接（?ok= 那种）都还在外面跑着，
 *    404 会让人以为「功能没了」。带上 tab=kp —— 从 KG 页过来的人要找的多半就是低置信那一类。
 */
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function KgQueueMoved(): never {
  redirect("/queue?tab=kp");
}
