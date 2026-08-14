/**
 * `GET /api/grading/review/batch?code=<代号>&day=<天>` —— 一个批次的全貌
 * （AI:PRD-009 · 设计稿 §一 D-A：逐题终审页的取数）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库警示：读的是**圣域** `订阅特训/_产线/审核.db`（mode=ro），
 *      不是 punch 库 `举一反三产物/资料库.db`，不是本产品的 `data/资料库.db`。
 *
 * 🔴 **零写**。返回：批次头 + 逐题（含已 parse 的 error_kp）+ 反馈历史 +
 *    每页原图在不在盘上 + 错因词表（正本 `_产线/err_kp.json`）。
 *    词表随取数一起给，与审核台把 `err_kp.KP_CN` 注进页面占位符同一个理由：
 *    🔴 码→中文前端不许硬写，只认正本。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from "next/server";

import { reviewBatch, reviewKpDict, 原文 } from "~/app/grading/review/query";
import { safeCode } from "~/app/grading/paths";
import { type ReviewBatchResponse } from "~/app/grading/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function 拒(error: string): NextResponse {
  const body: ReviewBatchResponse = {
    ok: false,
    error,
    data: null,
    kp: reviewKpDict(),
    gradingDbPath: null,
    warnings: [],
  };
  return NextResponse.json(body, { status: 200 });
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const codeRaw = (sp.get("code") ?? "").trim();
  const dayRaw = (sp.get("day") ?? "").trim();

  if (!codeRaw || !dayRaw) return 拒("要 code 与 day 两个参数。");
  const code = safeCode(codeRaw);
  if (!code) {
    return 拒(
      `代号 ${JSON.stringify(codeRaw)} 不能用（含路径分隔符 / 上跳 / 控制字符，或太长）——` +
        "它要拿去找原卷照片的目录。",
    );
  }
  const day = Number(dayRaw);
  if (!Number.isInteger(day) || day < 0 || day > 999) {
    return 拒(`天号 ${JSON.stringify(dayRaw)} 不是 0~999 的整数。`);
  }

  try {
    const r = await reviewBatch(code, day);
    const body: ReviewBatchResponse = {
      ok: true,
      data: r.detail,
      kp: reviewKpDict(),
      gradingDbPath: r.gradingDbPath,
      warnings: r.warnings,
    };
    // 🔴 批次不存在不是错误（ok:true + data:null）：页面要能说出「审核.db 里没有这一批」
    //    这句人话 + 怎么回事，而不是弹一个红色报错让人以为系统坏了。
    return NextResponse.json(body);
  } catch (e) {
    return 拒(`批次取数失败（原文照登）：${原文(e)}`);
  }
}
