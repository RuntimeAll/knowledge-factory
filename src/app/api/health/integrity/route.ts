/**
 * GET /api/health/integrity —— 现跑一次对账六项（AI:PRD-008 · P3 · 设计稿 §二·16）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 `metric:false` 是这条路由存在的**前提，不是可调的选项**
 *
 *   integrityCheck() 默认收尾会 logMetric('integrity_check') —— 那是一次 core 写，
 *   连带一条审计行。页面上放一个「跑一次」的按钮，如果每点一下就往审计链里追一行：
 *     ① 审计链会被点击噪音填满（隔壁 /audit 页看的就是它）；
 *     ② 首页红旗条读的是「最近一次对账摘要」，页面上随手跑的这一次会**顶掉**
 *        命令行/回归跑出来的那次正式结论 —— 监督面把自己的账本改了。
 *   所以本路由一律 metric:false：**这一跑不进库、不算数、不留痕**，
 *   它只是把六项现在的样子端到屏幕上。要留痕的正式对账走命令行
 *   （scripts/integrity-check.ts，页面上那条复制条就是它）。
 *
 *   ⇒ 于是本路由满足「页面不触发任何写」：integrityCheck 除了那条 logMetric
 *      全程只 SELECT（对本库、对圣域都是；圣域连接由 assertGradingUrl 强制 mode=ro）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 GET 而不是 POST：因为它确实什么都不改。
 * 🔴 慢是正常的：要连圣域、逐表扫审计覆盖、遍历 assets 目录 —— 所以它是
 *    **点了才跑**，不在页面打开时自动跑（页面默认显示的是最近一次的摘要）。
 */
import { NextResponse } from "next/server";

import { integrityCheck } from "~/core";
import type { CheckView, IntegrityRunResponse } from "~/app/health/shared";

export const dynamic = "force-dynamic";
/** 对账要读文件系统 + 开圣域连接，edge runtime 跑不了 */
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const t0 = Date.now();
  try {
    // 🔴 metric:false —— 见文件头，这是前提不是选项
    const report = await integrityCheck({ metric: false });
    const checks: CheckView[] = report.checks.map((c) => ({
      id: c.id,
      name: c.name,
      ok: c.ok,
      level: c.level,
      details: c.details,
      stats: c.stats ?? {},
    }));
    const body: IntegrityRunResponse = {
      ok: true,
      report: { ok: report.ok, generatedAt: report.generatedAt, checks },
      ms: Date.now() - t0,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: IntegrityRunResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      report: null,
      ms: Date.now() - t0,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
