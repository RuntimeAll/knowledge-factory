/**
 * 批改流水线 · 收卷录入（AI:PRD-008 · 设计稿 §二 批改流水线组第 1 页）
 *
 * 职责：**你唯一要做的动作**——选学员 → 传图 → 提交。提交即写
 * `收件箱/<代号>/<时间戳>/` 并向 `_队列.jsonl` 追加一行成待办，watcher 自动接手。
 * **不管**：认卷、批改、终审、出件（那是产线与审核台的事，本页只负责把料交进去）。
 *
 * 🔴 本页是**写操作白名单五类**里的「收卷录入」，写动作全在 `/api/grading/intake`
 *    （POST），页面只负责收集 + 二次确认。
 * 🔴 名册从 core 的 listRoster 读（全代号，无真名字段）——枚举不在前端抄第二份。
 */
import { DataSourceNote } from "~/components/console/ui";
import { listRoster } from "~/core";
import { inboxDir, inboxQueueFile, resolveRoot } from "../paths";
import { IntakeForm } from "./form";

export const dynamic = "force-dynamic";

export default async function IntakePage() {
  let roster: {
    code: string;
    grade: string | null;
    editionCtx: string | null;
    status: string | null;
  }[] = [];
  let rosterError: string | undefined;
  try {
    const rows = await listRoster();
    roster = rows.map((r) => ({
      code: r.code,
      grade: r.grade,
      editionCtx: r.editionCtx,
      status: r.status,
    }));
  } catch (e) {
    rosterError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  const { via } = resolveRoot();

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
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>收卷录入</h1>
        <span style={{ fontSize: 12.5, color: "#909399" }}>
          选学员 → 传图 → 提交即入队；认卷、开批、存疑推送由流水线接手，不用你开
          session
        </span>
        <span style={{ marginLeft: "auto" }}>
          <DataSourceNote>
            写 = {inboxDir()}/&lt;代号&gt;/&lt;时间戳&gt;/ + 追加{" "}
            {inboxQueueFile()}（跨线契约 §二·6，append-only）· 名册 = core
            listRoster
          </DataSourceNote>
        </span>
      </div>

      <IntakeForm
        roster={roster}
        rosterError={rosterError}
        inboxDir={inboxDir()}
        queuePath={inboxQueueFile()}
        rootVia={via}
      />
    </>
  );
}
