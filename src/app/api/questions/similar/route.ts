/**
 * GET /api/questions/similar?id=q_…&limit=10 —— 「相似题」弹层的取数口
 * （AI:PRD-008 · 设计稿 §二·2「操作列：查看｜相似题（find_similar 弹层）」）
 *
 * 🔴 与 MCP 的 find_similar **同一个 core 函数**（findSimilarQuestions）：
 *    页面看得见的近邻和 agent 查到的必须是同一批，两套实现 = 两套口径。
 * 🔴 零写：`metric:false`（翻弹层是浏览动作，不该污染真实查询打点）。
 * 🔴 语意轴降级时**如实说**：degraded=true + warnings 原文照登，
 *    绝不悄悄回一个空列表让人以为「这题没有相似题」。
 */
import { NextResponse } from "next/server";

import { RetrievalError, findSimilarQuestions } from "~/core";
import type { SimilarResponse } from "~/app/question/shared";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  const id = (sp.get("id") ?? "").trim();
  const n = Number(sp.get("limit"));
  const limit =
    Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : DEFAULT_LIMIT;

  if (!id) {
    const body: SimilarResponse = {
      ok: false,
      error: "没给题 id（?id=q_…）",
      questionId: "",
      stemBrief: "",
      hits: [],
      degraded: false,
      modelVer: null,
      warnings: [],
      ms: 0,
    };
    return NextResponse.json(body, { status: 200 });
  }

  try {
    const r = await findSimilarQuestions(id, { limit, metric: false });
    const body: SimilarResponse = {
      ok: true,
      questionId: r.questionId,
      stemBrief: r.stemBrief,
      hits: r.hits.map((h) => ({
        questionId: h.questionId,
        stemBrief: h.stemBrief,
        score: h.score,
        qtype: h.qtype,
        status: h.status,
        solutionGrade: h.solutionGrade,
        kps: h.kps.map((k) => ({
          kpId: k.kpId,
          name: k.name,
          isPrimary: k.isPrimary,
        })),
      })),
      degraded: r.degraded,
      modelVer: r.modelVer,
      warnings: r.warnings,
      ms: r.ms,
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: SimilarResponse = {
      ok: false,
      error:
        e instanceof RetrievalError
          ? `${e.code}：${e.message}`
          : e instanceof Error
            ? `${e.name}: ${e.message}`
            : String(e),
      questionId: id,
      stemBrief: "",
      hits: [],
      degraded: false,
      modelVer: null,
      warnings: [],
      ms: 0,
    };
    // 🔴 HTTP 仍 200：错误原文端到弹层里（与 /api/questions 同一约定）
    return NextResponse.json(body, { status: 200 });
  }
}
