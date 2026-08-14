/**
 * 批改流水线 · 报告架（AI:PRD-008 · 设计稿 §二 批改流水线组第 4 页）
 *
 * 职责：已出件报告的**取件台**——列出来、看一眼、下载下来。
 * **不管**：出报告（那是批改线 export 的活）、发家长（🔴 永远是你手机上的人工动作）。
 *
 * 🔴 全只读：扫 `订阅特训/学员/<代号>/报告/*.png`（产线运行态，跨线契约 §一 只读），
 *    审核.db 走 mode=ro 只用来撞「这份报告是哪一批的」。本页一个字节都不写。
 */
import { DataSourceNote } from "~/components/console/ui";
import { listRoster } from "~/core";
import { studentsRoot } from "../paths";
import { ReportShelf } from "./shelf";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const code = one(sp, "code");

  let codes: string[] = [];
  try {
    codes = (await listRoster()).map((r) => r.code);
  } catch {
    // 名册读不出来只影响下拉候选（列表本身按目录扫，与 roster 无关）
  }

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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>报告架</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          已出件报告的取件台 —— 🔴
          发家长永远是你手机上的人工动作，页面只负责给件
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            目录扫描 {studentsRoot()}/&lt;代号&gt;/报告/*.png（只读）+ 审核.db
            batches（mode=ro，只用来撞批次与出件时间）
          </DataSourceNote>
        </span>
      </div>

      <ReportShelf codes={codes} defaultCode={code || undefined} />
    </>
  );
}
