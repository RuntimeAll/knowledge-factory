/**
 * lib/sort-window.ts —— 「窗口内排序」小件（AI:PRD-008 · 列头可排序）
 *
 * 设计稿 §〇·1 要求「每张表列头可排序」，而 core 的几个 list* / search* **都没有
 * order by 这一维**（它们的序是稳定序或相关性序）。所以排序落在取数路由这一层：
 * 把取回的窗口排一遍，再切页。
 *
 * 🔴 两条纪律，抄这个文件的人必须一起抄走：
 *   ① **先排后切**：路由必须在切页之前排，而且要保证窗口已经取尽 ——
 *      拿"前 100 条"排完再取第 5 页，是错的、而且错得看不出来。
 *   ② **null 恒排最后**（升序降序都是）：`—` 挤在最前面会让人以为这一列坏了。
 *
 * 🔴 中文按 localeCompare 排（"绝对值" 与 "有理数" 的先后是给人看的），
 *    数字按数值排 —— 别把数字当字符串排（10 会跑到 2 前面）。
 */

/** 一行里怎么取出用来排的值；返回 null = 这行这一列没有值 */
export type SortAccessor<T> = (row: T) => string | number | null;

/**
 * 按 accessor 就地排序。
 * @param desc 降序（页面上点第二下）
 */
export function sortWindow<T>(
  rows: T[],
  accessor: SortAccessor<T>,
  desc: boolean,
): void {
  rows.sort((a, b) => {
    const x = accessor(a);
    const y = accessor(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; // 🔴 null 恒后
    if (y === null) return -1;
    const c =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return desc ? -c : c;
  });
}

/**
 * 解析 `?sort=<字段>&order=asc|desc`。
 * 🔴 字段走白名单：地址栏是人能手改的地方，不在表里的一律当没给（不是报错，是忽略）。
 * 🔴 默认降序：列头点一下多半想看"最大的/最新的"那一头。
 */
export function parseSort<K extends string>(
  sp: URLSearchParams,
  allow: readonly K[],
): { field: K; desc: boolean } | null {
  const raw = (sp.get("sort") ?? "").trim();
  if (!raw || !(allow as readonly string[]).includes(raw)) return null;
  return {
    field: raw as K,
    desc: (sp.get("order") ?? "").trim().toLowerCase() !== "asc",
  };
}
