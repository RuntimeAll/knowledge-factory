/**
 * 生产管理 · 考察模型（AI:PRD-008 · P2 · 设计稿 §二·9）
 *
 * 🔴 页面本身只做一件事：把 core 的状态枚举取出来传给表格组件
 *    （枚举不许在前端抄第二份）。
 */
import { PageHead } from "~/components/console/page-head";
import { MODEL_STATUSES } from "~/core";
import { ModelTable } from "./table";

export const dynamic = "force-dynamic";

export default function ModelPage() {
  return (
    <>
      {/* 🔴 flexWrap：窄屏上不换行，右边的数据源小字会把标题挤成竖排（全站页头一律 wrap） */}
      <PageHead
        title={<>考察模型</>}
        sub={
          <>
            每个模型出过多少题、指回哪个生成器文件 —— 不管建模/转正（那走 MCP）
          </>
        }
        source={
          <>
            core.listModels + core.getModel · 表 exam_model /
            question（model_id） · dsl_ref 在不在盘 = existsSync 现查
          </>
        }
      />

      <ModelTable statuses={MODEL_STATUSES} />
    </>
  );
}
