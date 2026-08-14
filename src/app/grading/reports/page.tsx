/**
 * 批改流水线 · 报告架（AI:PRD-008 · 设计稿 §二 批改流水线组第 4 页）
 *
 * 职责：已出件报告的**取件台**——列出来、看一眼、下载下来。
 * **不管**：出报告（那是批改线 export 的活）、发家长（🔴 永远是你手机上的人工动作）。
 *
 * 🔴 全只读：扫 `订阅特训/学员/<代号>/报告/*.png`（产线运行态，跨线契约 §一 只读），
 *    审核.db 走 mode=ro 只用来撞「这份报告是哪一批的」。本页一个字节都不写。
 */
import { PageHead } from "~/components/console/page-head";
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
  // 🔴 AI:PRD-009 打磨（检查单 §三·2）：名册读不出来只影响下拉候选（列表本身按目录扫，
  //    与 roster 无关）—— 但「只影响下拉」不等于「可以不说」：下拉少了人，
  //    看的人会以为那些学员没有报告。原文照登，页面照常用。
  let rosterError: string | undefined;
  try {
    codes = (await listRoster()).map((r) => r.code);
  } catch (e) {
    rosterError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <>
      <PageHead
        title={<>报告架</>}
        sub={
          <>
            已出件报告的取件台 —— 🔴
            发家长永远是你手机上的人工动作，页面只负责给件
          </>
        }
        source={
          <>
            目录扫描 {studentsRoot()}/&lt;代号&gt;/报告/*.png（只读）+ 审核.db
            batches（mode=ro，只用来撞批次与出件时间）
          </>
        }
      />

      <ReportShelf
        codes={codes}
        defaultCode={code || undefined}
        rosterError={rosterError}
      />
    </>
  );
}
