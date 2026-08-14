/**
 * 学情中心 · 学员名册（AI:PRD-008 · P2 · 设计稿 §二·11）
 *
 * 职责：代号名册 + 每人一行的概览（点亮原「学情」占位）。
 * **不管**：出报告（批改线出件）、建名册（upsertRoster 走 agent/MCP）。
 *
 * 🔴 这一页只搭壳：表格/筛选/取数全在 `table.tsx`（client）→ `/api/student`（只读）。
 * 🔴 roster 是**纯维度表**：学情事实（对错/错因/轮次）一个字都不复制进来，
 *    全部只读现算自圣域（审核.db，mode=ro）。
 */
import { DataSourceNote } from "~/components/console/ui";
import { StudentTable } from "./table";

export const dynamic = "force-dynamic";

export default function StudentRosterPage() {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>学员名册</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          谁在学、交了几次、挂没挂上桥 —— 🔴 全代号，无真名字段
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            表 roster（纯维度表）+ 圣域 审核.db（mode=ro 现算）· core.listRoster
            / bridgeBatches / getStudentView（与 MCP student_view 同一入口）
          </DataSourceNote>
        </span>
      </div>

      <StudentTable />
    </>
  );
}
