/**
 * 闸⑩ 配图分级（AI:PRD-003 · 003-C）
 *
 * punch-ingest/v1 **没有题级配图**（备料 §8：图走目录约定、且只有册级宣发图），
 * 所以这一面是纯新增，无前身可抄。规则：
 *
 *   文件必须真存在、读得动 —— 路径写错、图还没生成、盘没挂上，一律红灯；
 *   内容 sha256 = asset 的天然去重键（asset.hash 上有 UNIQUE，同一张图全库一行）；
 *   role='stem'      → 🔴 **该题必人审**：question.review_required=1，批后开一张
 *                      kind='图片' 的工单。题干图错了 = 题目本身错了，不能只抽检；
 *   role='analysis'  → 抽检：只在 gate_report 里记一笔 sampled，不建工单。
 *                      解析图错了顶多讲解看着别扭，代价与「每张都排队等人审」不相称。
 *
 * 🔴 相一只算不拷：hash 与落地文件名在这儿定，真正的文件拷贝在相二
 *    （dryRun 必须连一个字节都不落盘 —— 拷了再回滚，就是 C1c 的
 *    「有文件查不到登记行」红旗）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

import { fail, type Gate, type GateResult } from "./types";
import { type FigurePlan, type IngestItemCtx } from "./ingest-context";

export const FIGURE_CODES = {
  fileMissing: "FIGURE_FILE_MISSING",
  unreadable: "FIGURE_UNREADABLE",
  notAFile: "FIGURE_NOT_A_FILE",
} as const;

/** 落地文件名：<sha256><ext>（内容寻址 ⇒ 同一张图只有一份） */
export function assetFileName(hash: string, ext: string): string {
  return `${hash}${ext.toLowerCase()}`;
}

/** 算一张图的落地计划（会读文件；路径不存在时抛给调用方处理） */
export function planFigure(
  srcPath: string,
  role: "stem" | "analysis",
): FigurePlan {
  const abs = isAbsolute(srcPath) ? srcPath : resolve(process.cwd(), srcPath);
  const buf = readFileSync(abs);
  const hash = createHash("sha256").update(buf).digest("hex");
  const ext = extname(abs).toLowerCase();
  return {
    role,
    srcPath: abs,
    hash,
    bytes: buf.byteLength,
    ext,
    fileName: assetFileName(hash, ext),
  };
}

export const ingestFigureGate: Gate<IngestItemCtx> = {
  name: "⑩配图分级",
  run(ctx: IngestItemCtx): GateResult {
    const 位置 = `seq=${ctx.seq}`;
    const figures = ctx.item.figures ?? [];
    const plans: FigurePlan[] = [];

    for (const [i, f] of figures.entries()) {
      const abs = isAbsolute(f.path) ? f.path : resolve(process.cwd(), f.path);
      if (!existsSync(abs)) {
        return fail({
          code: FIGURE_CODES.fileMissing,
          message: `${位置} figures[${i}] 的文件不存在：${abs} —— 路径写错了，或者图还没生成就先来录题了。`,
          recoverable: true,
        });
      }
      let stat;
      try {
        stat = statSync(abs);
      } catch (e) {
        return fail({
          code: FIGURE_CODES.unreadable,
          message: `${位置} figures[${i}] 读不动：${abs}（${e instanceof Error ? e.message : String(e)}）`,
          recoverable: true,
        });
      }
      if (!stat.isFile()) {
        return fail({
          code: FIGURE_CODES.notAFile,
          message: `${位置} figures[${i}] 指的不是一个文件：${abs}`,
          recoverable: true,
        });
      }
      try {
        plans.push(planFigure(f.path, f.role));
      } catch (e) {
        return fail({
          code: FIGURE_CODES.unreadable,
          message: `${位置} figures[${i}] 读不动：${abs}（${e instanceof Error ? e.message : String(e)}）`,
          recoverable: true,
        });
      }
    }

    ctx.derived.figures = plans;
    const 题干图 = plans.filter((p) => p.role === "stem");
    ctx.derived.reviewRequired = 题干图.length > 0;

    if (题干图.length > 0) {
      ctx.derived.notes.push(
        `有 ${题干图.length} 张题干图 ⇒ review_required=1，批后开一张 kind='图片' 的人审工单（题干图错=题目本身错，不抽检）`,
      );
    }
    for (const p of plans.filter((x) => x.role === "analysis")) {
      ctx.derived.sampled.push(`analysis:${p.fileName}`);
    }

    return { ok: true };
  },
};

export default ingestFigureGate;
