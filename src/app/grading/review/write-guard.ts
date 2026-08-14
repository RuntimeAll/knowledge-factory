/**
 * 终审台 · 三条写路由的共同前置（AI:PRD-009 · 设计稿 §一 D-A）
 *
 * 🔴🔴 同名异库警示：这里读的是圣域 `订阅特训/_产线/审核.db`（mode=ro），
 *      不是 punch 库 `举一反三产物/资料库.db`，也不是本产品的 `data/资料库.db`。
 *
 * ── 为什么写之前还要自己读一遍库 ─────────────────────────────────────────────
 *   审核库.py 自己有全套闸（批次在不在、rework 不许直接确认、全题必须有终审值…），
 *   而且**那才是权威**。这里的预检**不替它判**，只做两件它做不了的事：
 *     ① 让二次确认 Modal 说得出**影响面**（这批多少题、翻了哪几道案、会覆盖什么）——
 *        点头之前看得见自己在动什么（设计稿 §三·7）；
 *     ② 撞闸时先给一句**带页面指路**的人话（「先撤回打回」在本页就有按钮），
 *        而不是只把 CLI 那句「请先撤回打回：python 审核库.py unrework …」甩出去。
 *   🔴 预检过了不等于放行：CLI 的闸照跑，它拒了就照原文上墙。
 *
 * 🔴 server only。
 */
import { safeCode } from "../paths";
import { type ReviewBatchBrief, type ReviewBatchDetail } from "../shared";
import { reviewBatch, 原文 } from "./query";

export interface 学员天 {
  student: string;
  day: number;
}

export type 解析结果 = { ok: true; v: 学员天 } | { ok: false; err: string };

/** 请求体 → (代号, 天)。🔴 代号要拿去拼真实路径与命令行参数，一个字符都不能马虎。 */
export function 读学员天(body: unknown): 解析结果 {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, err: "请求体不是 JSON 对象。" };
  }
  const o = body as Record<string, unknown>;

  const raw = typeof o.student === "string" ? o.student.trim() : "";
  if (!raw) return { ok: false, err: "没给学员代号（student）。" };
  const student = safeCode(raw);
  if (!student) {
    return {
      ok: false,
      err:
        `代号 ${JSON.stringify(raw)} 不能用（含路径分隔符 / 上跳 / 控制字符，或太长）——` +
        "它要当命令行参数递给 审核库.py，也要当目录名去找原卷照片。",
    };
  }

  const dayRaw = o.day;
  const day =
    typeof dayRaw === "number"
      ? dayRaw
      : typeof dayRaw === "string" && dayRaw.trim() !== ""
        ? Number(dayRaw)
        : NaN;
  if (!Number.isInteger(day) || day < 0 || day > 999) {
    return {
      ok: false,
      err: `天号 ${JSON.stringify(dayRaw)} 不是 0~999 的整数（batches.day 是 INTEGER）。`,
    };
  }

  return { ok: true, v: { student, day } };
}

export type 现状结果 =
  { ok: true; detail: ReviewBatchDetail } | { ok: false; err: string };

/** 取批次现状（mode=ro）。批次不存在 = 明确的拒绝，不让 CLI 去撞。 */
export async function 现状(student: string, day: number): Promise<现状结果> {
  let r: Awaited<ReturnType<typeof reviewBatch>>;
  try {
    r = await reviewBatch(student, day);
  } catch (e) {
    return {
      ok: false,
      err: `读圣域（审核.db，mode=ro）失败：${原文(e)}`,
    };
  }
  if (!r.detail) {
    return {
      ok: false,
      err:
        `审核.db 里没有「${student} 第${day}天」这个批次（batches 按 UNIQUE(student, day) 建）。` +
        "批次是产线 ingest / 直批 建的，管理台不建批次 —— 先确认这一天的卷真的批过了。",
    };
  }
  return { ok: true, detail: r.detail };
}

/** 事后复核：写完再用 mode=ro 读一遍，报**实际**落成什么样（CLI 的成功输出机读不了） */
export async function 复核(
  student: string,
  day: number,
): Promise<{ after: ReviewBatchBrief | null; note: string | null }> {
  try {
    const r = await reviewBatch(student, day);
    return r.detail
      ? { after: r.detail, note: null }
      : {
          after: null,
          note: "跑完再读库时找不到这个批次了（这不该发生，去看一眼 审核.db）。",
        };
  } catch (e) {
    return {
      after: null,
      note: `跑完的事后复核读不出来（${原文(e)}）—— CLI 的回执见上面原文，库里到底成没成请自行核对。`,
    };
  }
}
