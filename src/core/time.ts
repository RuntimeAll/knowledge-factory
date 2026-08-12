/**
 * core/time.ts —— 时间口径（AI:PRD-001 · WP3）
 *
 * 🔴 M1 全库约定：时间戳一律 TEXT、ISO-8601、**本地时区带偏移**（`2026-08-12T15:04:05+08:00`），
 *    不用 UTC 的 `Z` 后缀。理由：这库是给人看的本地知识库，报告/台账/打卡日期全按本地日历切；
 *    存 UTC 会让「8 月 12 日那天」在跨零点时对不上，而带偏移的本字面量既能直读又能被解析回准确时刻。
 *    偏移为 0 时写 `+00:00`（不写 `Z`），保证格式单一、字符串可正则可比较。
 */

/** 本地 ISO 时间戳的形状闸；入库前不确定的字符串都该过一遍 */
export const LOCAL_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 当前时刻的本地 ISO-8601 字符串（秒精度 + 时区偏移）。
 * 传 `at` 可用于测试或补录历史时刻。
 */
export function nowLocalISO(at: Date = new Date()): string {
  // getTimezoneOffset() 返回的是「UTC - 本地」的分钟数，东八区是 -480；取反才是偏移量
  const offsetMin = -at.getTimezoneOffset();
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);

  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
  const zone = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return `${date}T${time}${zone}`;
}

/** 是不是合规的本地 ISO 时间戳 */
export function isLocalISO(value: string): boolean {
  return LOCAL_ISO_RE.test(value);
}
