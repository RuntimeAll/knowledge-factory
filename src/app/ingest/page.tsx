/**
 * 题库管理 · 录入批次（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 职责：每一次投料的台账——什么时候、谁投的、多少进多少拒、闸报告。
 * **不管**重投（命令行的事）。
 *
 * 🔴 页面本体只画标题与数据源小字，表格是 client 组件（ProTable 三段式）。
 *    这一页没有任何 server 端取数：批次列表要跟着搜索条件走，放在 client 更直接。
 * 🔴 全页只读，一个按钮都不改库。
 */
import { DataSourceNote } from "~/components/console/ui";
import { IngestTable } from "./table";

export const dynamic = "force-dynamic";

export default function IngestPage() {
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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>录入批次</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          每一次投料的台账 —— 不管重投（命令行的事）
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.listIngestBatches / core.getIngestBatch（= MCP get_ingest_batch
            同一函数）· 表 ingest_batch（gate_report_json 全账）+ quarantine
          </DataSourceNote>
        </span>
      </div>

      <IngestTable />
    </>
  );
}
