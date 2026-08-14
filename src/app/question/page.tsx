/**
 * 题库管理 · 题目管理（AI:PRD-008 · 地基 · 设计稿 §二·2）
 *
 * 🔴 这是**新的主入口**：菜单上的「题目管理」指这儿。
 *    004-C 的 `/search`（三路检索的实验台：轴仪表盘、零命中建议、找相似）
 *    原样保留、但不挂菜单 —— 它是调检索口径用的，不是日常盘题用的。
 * 🔴 页面本身只做一件事：把 core 的四张枚举表（题型/状态/判档/来源）取出来
 *    传给表格组件。枚举**不许在前端抄第二份**：抄出来的那份迟早跟契约漂。
 */
import { DataSourceNote } from "~/components/console/ui";
import {
  DEFAULT_STATUSES,
  PROV_TYPES,
  QTYPES,
  QUESTION_STATUSES,
  SOLUTION_GRADES,
} from "~/core";
import { QuestionTable } from "./table";

export const dynamic = "force-dynamic";

export default function QuestionPage() {
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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>题目管理</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          找题、盘题 —— 不管改题（录入线的事）、不管组卷（生产域）
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            core.searchQuestions（与 MCP search_questions 同一入口）· 表
            question / question_kp / question_fts / question_vec
          </DataSourceNote>
        </span>
      </div>

      <QuestionTable
        qtypes={QTYPES}
        statuses={QUESTION_STATUSES}
        grades={SOLUTION_GRADES}
        provTypes={PROV_TYPES}
        defaultStatuses={DEFAULT_STATUSES}
      />
    </>
  );
}
