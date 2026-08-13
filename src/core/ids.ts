/**
 * core/ids.ts —— 主键生成（AI:PRD-001 · WP3）
 *
 * 🔴 M1 §D-10：id 一律 TEXT，形如 `<前缀>_<ULID>`。
 *    - 前缀让 id 自带类型（`ref_type` 可自校验，日志里一眼看出是什么东西）；
 *    - ULID 按时间单调有序（索引不碎），26 位 Crockford Base32，无大小写歧义；
 *    - 🔴 绝不用整数自增/雪花号：雪花号经 JSON double 截尾是流过血的坑
 *      （teacher-mcp 全链路字符串传就是这么来的）。仅 audit_log.seq / metric_event.id
 *      用 INTEGER AUTOINCREMENT —— 那两张表需要的是严格序，且不跨系统传。
 */
import { ulid } from "ulid";

/**
 * 允许的 id 前缀 ↔ 归属表。加前缀 = 加一行，别在业务里现编字符串。
 *
 * | 前缀     | 表              |
 * |----------|-----------------|
 * | kp       | kp（考点概念层）|
 * | q        | question        |
 * | em       | exam_model      |
 * | ec       | error_cause     |
 * | sku      | sku             |
 * | skuout   | sku_output      |
 * | asset    | asset           |
 * | doc      | source_doc      |
 * | page     | source_page     |
 * | node     | edition_node    |
 * | tree     | edition_tree    |
 * | batch    | ingest_batch    |
 * | qr       | quarantine      |
 * | rq       | review_queue    |
 * | ledger   | ledger          |
 * | fig      | question_figure |
 */
export const ID_PREFIXES = [
  "kp",
  "q",
  "em",
  "ec",
  // 🔴 `skuout` 排在 `sku` 前面：ID_RE 的交替分支按序尝试，长的在前少一次回溯
  //    （JS 正则会回溯，两种顺序都判得对，但长前短后读起来才不用想第二遍）
  "skuout",
  "sku",
  "asset",
  "doc",
  "page",
  "node",
  "tree",
  "batch",
  "qr",
  "rq",
  "ledger",
  "fig",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * 前缀 ↔ 归属表（上表的机读版；WP4 对账 C1d 靠它把 review_queue 的多态 ref 路由到表）。
 * 🔴 Record<IdPrefix, string> 是编译期闸：加了前缀不补归属表，tsc 直接红。
 */
export const ID_PREFIX_TABLE: Record<IdPrefix, string> = {
  kp: "kp",
  q: "question",
  em: "exam_model",
  ec: "error_cause",
  skuout: "sku_output",
  sku: "sku",
  asset: "asset",
  doc: "source_doc",
  page: "source_page",
  node: "edition_node",
  tree: "edition_tree",
  batch: "ingest_batch",
  qr: "quarantine",
  rq: "review_queue",
  ledger: "ledger",
  fig: "question_figure",
};

/** Crockford Base32：0-9 + A-Z 去掉 I / L / O / U（防手抄歧义） */
const ULID_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

/** 单个 id 的形状闸（前缀必须在册） */
export const ID_RE = new RegExp(`^(?:${ID_PREFIXES.join("|")})_${ULID_BODY}$`);

/** 生成一个新 id */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** 取出 id 的前缀；形状不合规或前缀不在册返回 null */
export function parseIdPrefix(id: string): IdPrefix | null {
  if (!ID_RE.test(id)) return null;
  const prefix = id.slice(0, id.indexOf("_"));
  return prefix as IdPrefix;
}

/** 形状校验；给了 prefix 就连归属一起校（`isId(x, "kp")`） */
export function isId(id: string, prefix?: IdPrefix): boolean {
  const got = parseIdPrefix(id);
  if (got === null) return false;
  return prefix === undefined || got === prefix;
}
