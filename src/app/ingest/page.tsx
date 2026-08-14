/**
 * 题库管理 · 录入批次（AI:PRD-008 · P3 · 设计稿 §二·4）
 *
 * 职责：每一次投料的台账——什么时候、谁投的、多少进多少拒、闸报告。
 * **不管**重投（命令行的事）。
 *
 * 🔴 页面本体只画标题与数据源小字，表格是 client 组件（ProTable 三段式）。
 *    这一页没有任何 server 端取数：批次列表要跟着搜索条件走，放在 client 更直接。
 * 🔴 全页只读，一个按钮都不改库。
 *
 * 🆕 AI:PRD-009 打磨（检查单 4「看到即可达」）：`?batch=<批次 id>` 直接把那一批的
 *    全账抽屉打开。别处（题目详情的出处 tab、隔离行详情的「来自批」）看得见批次 id，
 *    以前**点不进去** —— 抽屉状态只活在组件里，地址栏说不出「哪一批」。
 */
import { PageHead } from "~/components/console/page-head";
import { IngestTable } from "./table";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function IngestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const batch = one(sp, "batch");

  return (
    <>
      <PageHead
        title={<>录入批次</>}
        sub={<>每一次投料的台账 —— 不管重投（命令行的事）</>}
        source={
          <>
            core.listIngestBatches / core.getIngestBatch（= MCP get_ingest_batch
            同一函数）· 表 ingest_batch（gate_report_json 全账）+ quarantine
          </>
        }
      />

      <IngestTable initialBatch={batch || undefined} />
    </>
  );
}
