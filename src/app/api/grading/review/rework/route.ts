/**
 * `POST /api/grading/review/rework` —— 打回重批（AI:PRD-009 · 写操作白名单第六类）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 本产品对审核.db 没有写句柄。这条路由 spawn 圣域自己的原语：
 *
 *          cwd=订阅特训/_产线
 *          python 审核库.py rework <代号> <天> <哪里不对>
 *
 *      落库的是 `审核库.py::rework`：feedback 插一行（记在**当前轮**）+
 *      batches.status 置 'rework'。🔴 它**不改 round** —— 轮次要等 agent 重批时
 *      ingest/直批 看到上一状态是 rework 才 +1。页面不许自己解释成「轮次已+1」。
 *
 * 🔴 反馈正文原样递一个 argv（不 join、不裁行）。
 *    审核库.py CLI 那头是 `' '.join(sys.argv[4:])`：单个 argv 元素 join 出来就是它自己，
 *    换行/多空格原样保留 —— 前提是**不经 shell**（本仓 spawn 不开 shell）。
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

  const o = raw as Record<string, unknown>;
  const body文 = typeof o.body === "string" ? o.body.trim() : "";
  if (!body文) {
    return 拒(
      "打回必须写清哪里不对 —— 空反馈等于没说，agent 不知道要改什么" +
        "（审核库.py 的第一道 assert 就是这条）。",
    );
  }

  const cur = await 现状(student, day);
  if (!cur.ok) return 拒(cur.err);
  const d = cur.detail;

  if (d.status === "confirmed") {
    return 拒(
      `「${student} 第${day}天」已确认` +
        `${d.exportedAt ? `并已于 ${d.exportedAt} 出件` : ""}，不能再打回` +
        "（审核库.py：「要改先重新 ingest」）。\n" +
        `重批这一批要产线那头重跑 python 审核库.py ingest ${student} ${day} ——` +
        "那条原语**不在管理台的白名单里**：它要跑锚定闸、读转录 JSON、整批 DELETE+INSERT 覆盖 items，是产线执行权。",
    );
  }
  // 🔴🔴 已 rework 的批次**照样放行**（2026-08-15 验收修复）。
  //
  //   原实现在这儿 `return 拒(...)`，注释写的却是「CLI 允许…不拦，但要说清楚」——
  //   注释与代码相反，等于把圣域本来通的一条路在管理台这边堵死了：
  //     · 圣域 审核库.py::rework 只 assert `status != 'confirmed'`（第 319-320 行），
  //       rework 状态可以再插一条 feedback；
  //     · :7801 审核台.py 的「打回重批」按钮对 pending/rework 两种批次一律渲染，
  //       那条路在旧 UI 上是通的。
  //   而给出的替代指引（「建议直接改在原来那条里」）在**任何 UI 里都做不到** ——
  //   feedback 只有 INSERT，管理台没有编辑入口。结果是：打回后想补一句
  //   「第 12 题也不对」，只能回 :7801 或敲命令行 —— 正撞设计稿 §五·2
  //   「:7801 不再需要打开」这条判据。
  //   🔴 所以这里不拦，只把「会多插一条、轮次不动」写进回执 notes。
  const 补打回 = d.status === "rework";

  const run = await runReviewCli("rework", [student, String(day), body文]);
  const { after, note } = await 复核(student, day);
  const notes: string[] = [];
  if (note) notes.push(note);
  if (补打回) {
    notes.push(
      `这一批本来就是**已打回 · 待重批**（第 ${d.round} 轮，打回前有 ${d.openFeedbackCount} 条反馈还没被 agent 处理）——` +
        "本次是在**同一轮里追加一条** feedback，不是新起一轮；status 仍是 rework。" +
        "agent 重批时会看到这一轮下的**全部**反馈。",
    );
  }
  notes.push(
    "🔴 打回**不动轮次**：round 要等 agent 重批（ingest/直批 看到上一状态是 rework）时才 +1。",
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
              : `审核库.py 拒绝了这次打回（exit ${String(run.exitCode)}）——原文见下方 stderr。`),
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
