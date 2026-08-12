/**
 * F 域 · 学情连接域（只读挂载 + 我方仅一张维度表）
 *
 * 🔴 正本 = PRD-026/M1-数据模型.md §3.F。
 * 🔴 圣域 审核.db 的 batches / items / feedback / tasks / slots **绝不在本库建表**：
 *    只读 ATTACH（mode=ro），学情事实不复制不迁移，跨库统计在服务层现算（Q4/D-6）。
 */
import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 🔴 D-1：这是纯维度表（选题台过滤/交付指向的 FK 靶点）；
 *    学情事实（对错/错因/轮次）绝不落资料库.db，全部只读现算自 审核.db。
 */
export const roster = sqliteTable(
  "roster",
  {
    /** 学员代号（与圣域 batches.student/slots.student 同口径，🔴 不落真名） */
    code: text("code").primaryKey(),
    alias: text("alias"),
    grade: text("grade"),
    /** Q12：学生绑版本 */
    editionCtx: text("edition_ctx"),
    status: text("status"),
    joinedAt: text("joined_at"),
    note: text("note"),
  },
  () => [check("roster_status_ck", sql`status IN ('active','paused','closed')`)],
);
