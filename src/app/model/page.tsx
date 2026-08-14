/**
 * 生产管理 · 考察模型（AI:PRD-008 · P2 · 设计稿 §二·9）
 *
 * 🔴 页面本身只做一件事：把 core 的状态枚举取出来传给表格组件
 *    （枚举不许在前端抄第二份）。
 */
import { DataSourceNote } from "~/components/console/ui";
import { MODEL_STATUSES } from "~/core";
import { ModelTable } from "./table";

export const dynamic = "force-dynamic";

export default function ModelPage() {
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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>考察模型</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          每个模型出过多少题、指回哪个生成器文件 —— 不管建模/转正（那走 MCP）
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.listModels + core.getModel · 表 exam_model /
            question（model_id） · dsl_ref 在不在盘 = existsSync 现查
          </DataSourceNote>
        </span>
      </div>

      <ModelTable statuses={MODEL_STATUSES} />
    </>
  );
}
