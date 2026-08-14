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
 * 🔴🔴 下拉 = **名册 ∪ 圣域里出现过的代号**（2026-08-14 修 · 验收判红）：
 *    只吃 roster 时现役 6 人里有 2 人（困呆眠 / 小宇川奈子）选不到、提交还被后端硬拒 ——
 *    而他们当天刚出批次和报告。学情事实全在圣域，roster 只是维度表：
 *    交过卷的人必须能收卷，没登记名册就在选项上标出来（并在提交回执里说一声）。
 */
import { Alert } from "antd";

import { DataSourceNote } from "~/components/console/ui";
import { bridgeBatches, listRoster } from "~/core";
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

  // 圣域里交过卷、但名册没登记的代号（/student 页早就知道有这些人，本页不能装不知道）
  let strays: string[] = [];
  let strayError: string | undefined;
  try {
    const b = await bridgeBatches();
    const 名册 = new Set(roster.map((r) => r.code));
    strays = [
      ...new Set(
        b.batches
          .map((x) => x.student)
          .filter((s): s is string => !!s && s.trim() !== ""),
      ),
    ]
      .filter((c) => !名册.has(c))
      .sort();
  } catch (e) {
    strayError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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
            {inboxQueueFile()}（跨线契约 §二·6，append-only）· 学员 = core
            listRoster ∪ bridgeBatches（圣域 batches.student）
          </DataSourceNote>
        </span>
      </div>

      {strayError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="圣域里有哪些代号，这次没查出来（原文照登）"
          description={
            <span style={{ fontSize: 12.5 }}>
              {strayError}
              <br />
              🔴 后果：下拉里**只有名册那几个人** ——
              交过卷但没登记名册的学员这次选不到。 别当成「他不存在」。
            </span>
          }
        />
      ) : null}

      <IntakeForm
        roster={roster}
        strays={strays}
        rosterError={rosterError}
        inboxDir={inboxDir()}
        queuePath={inboxQueueFile()}
        rootVia={via}
      />
    </>
  );
}
