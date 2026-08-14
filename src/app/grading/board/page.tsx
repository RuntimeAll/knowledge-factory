/**
 * 批改流水线 · 批改看板（AI:PRD-008 · 设计稿 §二 批改流水线组第 2 页）
 *
 * 职责：今日流水一行一批——从收件到出件的状态一眼看完。
 * **不管**：终审（那在审核台 :7801，页面只给直链）、判定口径（产线正本的事）。
 *
 * 🔴 全只读：审核.db 走 core 的 mode=ro 句柄（G-1 红线），收件段读 `_队列.jsonl`。
 * 🔴 两段不合并：收件段（事件流）与批改段（审核.db）各是各的行 ——
 *    编排台账没建之前，谁也没资格把它们 join 成一条（唯一事实源纪律）。
 */
import { PageHead } from "~/components/console/page-head";
import { listRoster } from "~/core";
import { BoardTable } from "./table";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function GradingBoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const code = one(sp, "code");

  let codes: string[] = [];
  // 🔴 AI:PRD-009 打磨（检查单 §三·2 错误态）：名册读不出来原来是 `catch {}` 静默吞掉的，
  //    页面上只表现为「学员下拉少了一半人」—— 看的人以为这些学员不存在。
  //    读不出来不该拦住整页（批次表与 roster 无关），但必须说出来。
  let rosterError: string | undefined;
  try {
    codes = (await listRoster()).map((r) => r.code);
  } catch (e) {
    rosterError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <>
      <PageHead
        title={<>批改看板</>}
        sub={<>一行一批：收件中 → 待认卷 → 批改中 → 待审核 / 已放行 / 已出件</>}
        source={
          <>
            审核.db（mode=ro：batches / items / feedback）+ core bridgeBatches
            挂桥 + 收件箱/_队列.jsonl 收件段 —— 本页零写
          </>
        }
      />

      <BoardTable
        codes={codes}
        defaultCode={code || undefined}
        rosterError={rosterError}
      />
    </>
  );
}
