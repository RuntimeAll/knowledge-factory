/**
 * `POST /api/grading/review/unrework` —— 撤回打回（AI:PRD-009 · 写操作白名单第六类）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 本产品对审核.db 没有写句柄。这条路由 spawn 圣域自己的原语：
 *
 *          cwd=订阅特训/_产线
 *          python 审核库.py unrework <代号> <天>
 *
 *      落库的是 `审核库.py::unrework`：未处理的 feedback 标 resolved_at +
 *      batches.status 从 'rework' 回到 'pending'。
 *
 * 🔴 为什么这一条必须有：审核台**没有**这个按钮 —— 打回之后想改主意，
 *    只能去命令行敲。终审内化要「不再需要打开 :7801」，那也不能把人赶去开终端。
 *    （原语本来就存在，这里只是把它接上按钮，不是新逻辑。）
 *
 * 🔴 同名异库警示：只碰圣域 `订阅特训/_产线/审核.db`；punch 库与本产品库都不碰。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { runReviewCli } from "~/app/grading/review/spawn";
import { 复核, 现状, 读学员天 } from "~/app/grading/review/write-guard";
import { 原文 } from "~/app/grading/review/query";
import { type ReviewWriteResponse } from "~/app/grading/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function 拒(error: string): NextResponse {
  const body: ReviewWriteResponse = {
    ok: false,
    error,
    argv: [],
    cwd: "",
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    after: null,
    notes: [],
  };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    return 拒(`请求体不是合法 JSON：${原文(e)}`);
  }

  const p = 读学员天(raw);
  if (!p.ok) return 拒(p.err);
  const { student, day } = p.v;

  const cur = await 现状(student, day);
  if (!cur.ok) return 拒(cur.err);
  const d = cur.detail;

  if (d.status !== "rework") {
    return 拒(
      `「${student} 第${day}天」当前不是「已打回」（status=${JSON.stringify(d.status)}），无需撤回。`,
    );
  }

  const run = await runReviewCli("unrework", [student, String(day)]);
  const { after, note } = await 复核(student, day);
  const notes: string[] = [];
  if (note) notes.push(note);
  notes.push(
    `本批未处理的 ${d.openFeedbackCount} 条反馈会被标成已处理（resolved_at=现在）——` +
      "反馈正文留档不删，历史仍看得见。",
  );

  const 成 = !run.spawnError && run.exitCode === 0;
  const res: ReviewWriteResponse = {
    ok: 成,
    ...(成
      ? {}
      : {
          error:
            run.spawnError ??
            (run.timedOut
              ? "审核库.py 跑超时被杀（>60s）——多半是库被别的进程锁着。"
              : `审核库.py 拒绝了这次撤回（exit ${String(run.exitCode)}）——原文见下方 stderr。`),
        }),
    argv: run.argv,
    cwd: run.cwd,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
    after,
    notes,
  };
  return NextResponse.json(res);
}
