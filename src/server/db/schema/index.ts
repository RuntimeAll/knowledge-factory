/**
 * 资料库.db schema barrel —— 六域 32 张普通表。
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3（A~G 六域逐表终稿）。改表先改正本再改这里。
 * 🔴 不在 drizzle schema 里的库对象（只走 raw SQL migration，见 drizzle/*.sql）：
 *    - question_fts（FTS5 虚拟表）+ 3 只同步触发器 —— 0001
 *    - _write_gate 写令牌表 + 64 只防裸写触发器 —— 0002
 */
export * from "./a-kg";
export * from "./b-question";
export * from "./c-model";
export * from "./d-error";
export * from "./e-production";
export * from "./f-roster";
export * from "./g-system";
