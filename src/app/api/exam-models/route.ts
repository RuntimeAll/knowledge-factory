/**
 * GET /api/exam-models —— 考察模型页（/model）的取数口（AI:PRD-008 · P2 生产管理）
 *
 * 🔴 为什么不叫 `/api/models`：仓根 `.gitignore` 有一条**没加锚点**的 `models/`
 *    （本意是拦 95MB 的本地 ONNX 模型目录 `/models/`），未加锚点的模式会命中
 *    **任何一层**同名目录 —— `src/app/api/models/` 于是在 `git status` 里根本
 *    不出现，提交时静默丢文件、线上 404。改名绕开；治本是把那行改成 `/models/`
 *    （已在交接说明里挂了 TODO，本卡不动仓根共享文件）。
 *
 * 🔴 **零写**：列模型而已。建模/转正（proposeModel → activateModel）是 MCP 的活，
 *    页面连按钮都不给（设计稿 §二·9 明写「不管建模/转正」）。
 * 🔴 app 层不许碰 db：只 import `~/core`（eslint 红线）。
 *
 * ── 🔴 逐条读卡（N+1）的理由，同 /api/skus ──────────────────────────────────
 *   `listModels` 的摘要面只有 8 列，**没有** kp_name / questionCount / originQids ——
 *   而设计稿要的列正是「归位考点 / 出题数 / 母题数」。所以逐条 `getModel` 补齐。
 *   本地库 22 个模型，代价可忽略；治本是给 core 的摘要面补这三列（TODO，见交接说明）。
 *
 * ── 🔴 dsl_ref 在不在盘 ─────────────────────────────────────────────────────
 *   `existsSync(splitDslRef(dsl_ref).file)`：**必须先切掉 `#函数名` 那截**，
 *   连着一起查永远 false（把在盘的文件报成不在盘，比不报更坏）。
 *   查不到不是错误，是「生成器搬走了/删了」这件事本身 —— 页面用 ✓/✗ 如实标。
 */
import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { MODEL_STATUSES, getModel, listModels, type ModelStatus } from "~/core";
import { parseSort, sortWindow } from "~/lib/sort-window";
import {
  splitDslRef,
  type ModelListResponse,
  type ModelRow,
} from "~/app/model/shared";

export const dynamic = "force-dynamic";

/** listModels 的上限（core zod: max(500)）——本地库 22 个模型 */
const CAP = 500;
/** 可排序的列（口径与两条排序纪律见 ~/lib/sort-window） */
const SORT_FIELDS = [
  "name",
  "kpName",
  "status",
  "questionCount",
  "originCount",
  "difficulty",
  "onDisk",
  "activatedAt",
] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SORT_OF: Record<SortField, (r: ModelRow) => string | number | null> = {
  name: (r) => r.name,
  kpName: (r) => r.kpName,
  status: (r) => r.status,
  questionCount: (r) => r.questionCount,
  originCount: (r) => r.originCount,
  difficulty: (r) => r.difficulty,
  // 在盘 > 不在盘 > 没记 dsl_ref（把"能重跑的模型"排到一头）
  onDisk: (r) => (r.dslOnDisk === null ? 0 : r.dslOnDisk ? 2 : 1),
  activatedAt: (r) => r.activatedAt,
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function intParam(sp: URLSearchParams, key: string, dflt: number): number {
  const n = Number(sp.get(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

export async function GET(req: Request): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;

  const page = intParam(sp, "page", 1);
  const pageSize = Math.min(
    intParam(sp, "pageSize", DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const statusRaw = (sp.get("status") ?? "").trim();
  const status = (MODEL_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as ModelStatus)
    : null;
  const kpId = (sp.get("kp") ?? "").trim();
  const name = (sp.get("name") ?? "").trim();
  const onDiskRaw = (sp.get("onDisk") ?? "").trim();
  const sort = parseSort<SortField>(sp, SORT_FIELDS);

  const t0 = Date.now();
  try {
    const briefs = await listModels({
      ...(status ? { status } : {}),
      ...(kpId ? { kpId } : {}),
      limit: CAP,
    });

    const rows: ModelRow[] = [];
    const warnings: string[] = [];
    for (const b of briefs) {
      const { file, fragment } = splitDslRef(b.dslRef);
      let kpName: string | null = null;
      let questionCount = 0;
      let originCount = 0;
      let openQueueId: string | null = null;
      try {
        const card = await getModel(b.id);
        if (card) {
          kpName = card.kpName;
          questionCount = card.questionCount;
          originCount = card.originQids.length;
          openQueueId = card.openQueueId;
        }
      } catch (e) {
        // 🔴 一个模型读不出来不该让整页白屏：那一行照出，原文挂 warnings
        warnings.push(
          `${b.name}（${b.id}）的卡读不出来：${
            e instanceof Error ? e.message : String(e)
          } —— 这一行的考点名/出题数/母题数是空的，不代表库里没有。`,
        );
      }

      let dslOnDisk: boolean | null = null;
      if (file) {
        try {
          dslOnDisk = existsSync(file);
        } catch {
          // 盘符不在/权限不足也算「查不到」，但别让它中断整张表
          dslOnDisk = false;
        }
      }

      rows.push({
        id: b.id,
        name: b.name,
        status: b.status,
        kpId: b.kpId,
        kpName,
        difficulty: b.difficulty,
        questionCount,
        originCount,
        openQueueId,
        dslRef: b.dslRef,
        dslFile: file,
        dslFragment: fragment,
        dslOnDisk,
        createdAt: b.createdAt,
        activatedAt: b.activatedAt,
      });
    }

    // ── 窗口内过滤（core 的 listModels 没有这两维）──────────────────────────
    const windowFilters: string[] = [];
    let filtered = rows;
    if (name) {
      windowFilters.push(`模型名/考点名包含「${name}」`);
      const kw = name.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.name.toLowerCase().includes(kw) ||
          (r.kpName ?? "").toLowerCase().includes(kw),
      );
    }
    if (onDiskRaw === "yes" || onDiskRaw === "no" || onDiskRaw === "none") {
      const 说法 =
        onDiskRaw === "yes"
          ? "生成器在盘"
          : onDiskRaw === "no"
            ? "生成器不在盘"
            : "没记 dsl_ref";
      windowFilters.push(说法);
      filtered = filtered.filter((r) =>
        onDiskRaw === "none"
          ? r.dslOnDisk === null
          : onDiskRaw === "yes"
            ? r.dslOnDisk === true
            : r.dslOnDisk === false,
      );
    }

    // 🔴 先排后切（窗口是一次取尽的 500 条，排序覆盖整个窗口）
    if (sort) sortWindow(filtered, SORT_OF[sort.field], sort.desc);

    const start = (page - 1) * pageSize;
    const body: ModelListResponse = {
      ok: true,
      data: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
      meta: {
        listed: briefs.length,
        cap: CAP,
        capped: briefs.length >= CAP,
        filtered: filtered.length,
        windowFilters,
        sort,
        ms: Date.now() - t0,
        warnings,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    const body: ModelListResponse = {
      ok: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      data: [],
      total: 0,
      page,
      pageSize,
      meta: null,
    };
    return NextResponse.json(body, { status: 200 });
  }
}
