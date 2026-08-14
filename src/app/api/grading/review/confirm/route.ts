/**
 * `POST /api/grading/review/confirm` —— 终审确认（AI:PRD-009 · 写操作白名单第六类）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **本产品对审核.db 没有写句柄**。这条路由不 open 库、不发一条 SQL。
 *      它做的是：把人在页面上点出来的 {题号: √/×/去掉} 写成一个**临时 JSON**，
 *      然后 spawn 圣域自己的原语：
 *
 *          cwd=订阅特训/_产线
 *          python 审核库.py confirm <代号> <天> --from <临时JSON>
 *
 *      落库的每一个字节都由 `审核库.py::confirm_from → confirm` 写 ——
 *      单写方在代码层原样保持（设计稿 §一 D-A / §四 红线）。
 *
 * 🔴🔴 **不传 `--auto`**。`confirm_from` 只认 `auto ∈ (None, 'L2代审')`，
 *      不带 = `batches.auto` 落 NULL = **记作人工确认**，与审核台点「确认保存」
 *      （`DB.confirm(..., auto 不传)`）完全同义。
 *      'L1静默'/'L2静默' 是 直批.py 自己标的，管理台永远不许冒充。
 *
 * 🔴🔴 **确认 ≠ 出件**（2026-08-12 用户拍板）。这里只把 status 落成 confirmed；
 *      报告要等 agent 拿着已确认的结果写完英雄卡总结 + 错题诊断，再跑
 *      `python 审核库.py export <代号> <天>`。所以本路由**绝不**顺手 export
 *      （审核台 `/api/confirm` 那两个恒空的 `files`/`warns` 就是这条纪律的化石）。
 *
 * 🔴 同名异库警示：全程只碰圣域 `订阅特训/_产线/审核.db`，
 *    与 punch 库 `举一反三产物/资料库.db`、本产品 `data/资料库.db` 无关，两库绝不互写。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { runReviewCli, writeConfirmFile } from "~/app/grading/review/spawn";
import { 复核, 现状, 读学员天 } from "~/app/grading/review/write-guard";
import { 原文 } from "~/app/grading/review/query";
import {
  VERDICTS,
  type ReviewWriteResponse,
  type Verdict,
} from "~/app/grading/shared";

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
  // HTTP 200 + ok:false（与本组其它路由同一约定：错误原文原样上墙，不靠状态码猜）
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
  const vRaw = o.verdicts;
  if (typeof vRaw !== "object" || vRaw === null || Array.isArray(vRaw)) {
    return 拒('verdicts 必须是 {"题号": "√"} 形状的对象。');
  }
  const 允许重确认 = o.allowReconfirm === true;

  // ── 判定值面：只认 审核库.py 的 VERDICTS，越界一律拒（'?' 不是终审值） ────
  const verdicts: Record<string, Verdict> = {};
  const 越界: string[] = [];
  const 坏题号: string[] = [];
  for (const [k, v] of Object.entries(vRaw as Record<string, unknown>)) {
    const q = Number(k);
    if (!Number.isInteger(q)) {
      坏题号.push(k);
      continue;
    }
    if (typeof v !== "string" || !(VERDICTS as readonly string[]).includes(v)) {
      越界.push(`第${k}题=${JSON.stringify(v)}`);
      continue;
    }
    verdicts[String(q)] = v as Verdict;
  }
  if (坏题号.length > 0) {
    return 拒(
      `verdicts 里有不是整数的题号：${坏题号.join("、")}（审核库.py 会在 int(k) 上抛 ValueError）。`,
    );
  }
  if (越界.length > 0) {
    return 拒(
      `终审值只能是 ${VERDICTS.join(" / ")}，越界：${越界.join("、")}。` +
        "（'?' 是**预判**里的「交人工」，不是终审值。）",
    );
  }

  // ── 预检（不替 CLI 判，只为把话说在前头；CLI 的闸照跑） ──────────────────
  const cur = await 现状(student, day);
  if (!cur.ok) return 拒(cur.err);
  const d = cur.detail;

  if (d.itemCount === 0) {
    return 拒(
      `批次 #${d.batchId}（${student} 第${day}天）一道题都没有，没什么可确认的 —— ` +
        "多半是批次建了但判定还没回来。",
    );
  }
  if (d.status === "rework") {
    return 拒(
      `「${student} 第${day}天」现在是**已打回 · 待重批**（第 ${d.round} 轮），不许绕过重批直接确认。\n` +
        "两条路：① 等 agent 重批完（重批会重新 ingest，轮次 +1）；" +
        "② 你改主意了 → 本页「撤回打回」按钮（等价于 python 审核库.py unrework " +
        `${student} ${day}），状态回到待审后再确认。`,
    );
  }
  if (d.status === "confirmed" && !允许重确认) {
    return 拒(
      `「${student} 第${day}天」已经在 ${d.confirmedAt ?? "（时间未记）"} 确认过了` +
        `（放行来源：${d.auto ?? "人工"}${d.exportedAt ? `；已于 ${d.exportedAt} 出件` : ""}）。\n` +
        "🔴 再确认一次会**覆盖** confirmed_at 与放行来源（审核库.py 的 confirm 对已确认批次没有二次拦截），" +
        "已出件的报告**不会**跟着重出。确实要改判，请在确认弹窗里勾选「我知道这会覆盖上一次的确认记录」。",
    );
  }

  // 全题闸 + 幽灵题号（CLI 也各有一道；这里先报，好让人一眼看见差哪几题）
  const 库内题号 = new Set(d.items.map((it) => it.qno));
  const 缺 = d.items
    .map((it) => it.qno)
    .filter((q) => verdicts[String(q)] === undefined);
  if (缺.length > 0) {
    return 拒(
      `还有 ${缺.length} 道题没给终审判定：第 ${缺.join("、")} 题。` +
        "（审核库.py 的全题闸要求每道题都过一遍人眼 —— 缺一道就整批拒绝。）",
    );
  }
  const 幽灵 = Object.keys(verdicts)
    .map(Number)
    .filter((q) => !库内题号.has(q));
  if (幽灵.length > 0) {
    return 拒(
      `判定里有本批次没有的题号：第 ${幽灵.join("、")} 题（本批共 ${d.itemCount} 题：` +
        `第 ${d.items.map((it) => it.qno).join("、")} 题）。`,
    );
  }

  // ── 真跑（🔴 唯一写路径） ──────────────────────────────────────────────
  const notes: string[] = [];
  let handle;
  try {
    handle = writeConfirmFile(student, day, verdicts);
  } catch (e) {
    return 拒(`临时终审 JSON 写不出来（系统 temp 目录不可写？）：${原文(e)}`);
  }

  const run = await runReviewCli("confirm", [
    student,
    String(day),
    "--from",
    handle.path,
    // 🔴 这里**没有** --auto：不带 = auto 落 NULL = 记作人工确认。见文件头。
  ]);
  const 清理 = handle.cleanup();
  if (清理) notes.push(清理);
  notes.push(`递给 --from 的 JSON 原文：${handle.text.replace(/\s+/g, " ")}`);

  const { after, note } = await 复核(student, day);
  if (note) notes.push(note);

  const 成 = !run.spawnError && run.exitCode === 0;
  const body: ReviewWriteResponse = {
    ok: 成,
    ...(成
      ? {}
      : {
          error:
            run.spawnError ??
            (run.timedOut
              ? `审核库.py 跑超时被杀（>60s）—— 终审只动 SQLite，正常是毫秒级，` +
                "多半是库被别的进程锁着（另一个审核台/CLI 正在写）。"
              : `审核库.py 拒绝了这次确认（exit ${String(run.exitCode)}）——原文见下方 stderr。`),
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
  return NextResponse.json(body);
}
