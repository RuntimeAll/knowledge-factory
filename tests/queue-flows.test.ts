/**
 * 审查队列三条处置链端到端（AI:PRD-003 · 003-D）
 *
 * 沿用 ingest.test.ts 的范式：真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑，
 * **每份副本各住一个独立目录**（管道会往 `<库同级>/assets/` 拷图）。
 *
 * 测试在精不在多，只钉三条链各自「必须永远成立」的那几件事：
 *   ① 图片链绿路：图判 passed ⇒ 该题所有题干图都过 ⇒ review_required 摘成 0，工单判过（单事务）；
 *   ② 图片链红路：驳回要理由、题**保持**必审、终态不重裁、拿错链子处置报 KIND_MISMATCH；
 *   ③ 草稿链绿路：propose 只开工单不入库 ⇒ promote 才落库（FTS 投影跟上）+ 工单判过记 questionId；
 *   ④ 草稿链红路：预检红照样开工单，转正**零写**返回新红灯、工单仍 open（别吞、别偷偷隔离）；
 *   ⑤ 隔离链绿路：坏料 → quarantine → 改好重投 → 落库 + 原行 resolved_at + why 留处置行；
 *   ⑥ 隔离链红路：还红 = 零写（隔离区不因重试长行）；废弃要理由；已结不重复处置；
 *   ⑦ 读侧：getIngestBatch 全账 + 隔离计数；getAssetByHash 命中/未命中。
 */
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  QueueError,
  createCoreDb,
  getAssetByHash,
  getDraftCard,
  getFigureReviewCard,
  getIngestBatch,
  getQuarantineRow,
  getQueueItem,
  listQuarantine,
  passFigureReview,
  promoteDraftQuestion,
  proposeQuestion,
  readWriteGate,
  rejectFigureReview,
  resolveQuarantine,
  runIngestBatch,
  verifyAuditChain,
  type CoreDbHandle,
  type IngestResult,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 目录清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

function 目录(tag: string): string {
  return join(tmpdir(), `kf-flows-${process.pid}-${tag}`);
}

/** 一份副本 = 一个独立目录（库 + assets/ + backup/ 全在里面） */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const dir = 目录(tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  目录清单.push(dir);

  const p = join(dir, "资料库.db");
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  const h = await createCoreDb(fileUrl(p));
  句柄清单.push(h);
  return h;
}

async function 数(h: CoreDbHandle, table: string): Promise<number> {
  const r = await h.client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number((r.rows[0] as unknown as { c: number }).c);
}

const 计数表 = [
  "question",
  "question_fts",
  "question_figure",
  "quarantine",
  "review_queue",
  "ingest_batch",
  "audit_log",
] as const;

async function 全表计数(h: CoreDbHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of 计数表) out[t] = await 数(h, t);
  return out;
}

async function 一行<T>(
  h: CoreDbHandle,
  sql: string,
  args: unknown[] = [],
): Promise<T | undefined> {
  const r = await h.client.execute({ sql, args: args as never[] });
  return r.rows[0] as unknown as T | undefined;
}

/** 造一道带题干图的题并真入库（图审工单的来料） */
async function 带图入库(h: CoreDbHandle, tag: string): Promise<IngestResult> {
  const 图 = join(目录(tag), "shuzhou.png");
  writeFileSync(图, `PNG-FAKE-数轴图-${tag}`);
  return runIngestBatch(
    {
      contract: "kb-ingest/v1",
      source: "queue-flows.test@fig",
      items: [
        {
          seq: 1,
          stem: "如图，数轴上的三点 A、B、C 分别表示有理数 a，b，c。化简：|a−b|−|a−c|",
          analysis: "由数轴定号后逐项去壳。",
          qtype: "解答",
          kps: [{ ref: "绝对值的几何意义与数轴距离" }],
          figures: [{ role: "stem", path: 图 }],
          prov: { type: "manual", createdBy: "003-D 单测" },
        },
      ],
    },
    { actor: "system", handle: h, backup: false },
  );
}

/** 一道好题（真考点 + 算得对），propose/reingest 共用 */
function 好题(stem: string) {
  return {
    stem,
    answer: "13",
    qtype: "计算",
    kps: [{ ref: "绝对值的概念" }],
    prov: { type: "manual", createdBy: "003-D 单测" },
  };
}

beforeAll(() => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  for (const dir of 目录清单) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放晚于 close()，删不掉只是留个临时目录 */
    }
  }
});

// ---------------------------------------------------------------------------
// ① 图片链绿路
// ---------------------------------------------------------------------------

describe("① 图片工单 · 通过", () => {
  it("卡片看得到题与图 → passFigureReview 单事务：图 passed + 题摘掉必审 + 工单判过", async () => {
    const h = await 造副本("fig-pass");
    const r = await 带图入库(h, "fig-pass");
    const queueId = r.queueIds[0]!;
    const questionId = r.questionIds[0]!;

    // 卡片：题面 + 图（hash 是页面取图的唯一钥匙）
    const card = await getFigureReviewCard(queueId, { handle: h });
    expect(card.item.kind).toBe("图片");
    expect(card.question?.id).toBe(questionId);
    expect(card.question?.reviewRequired).toBe(1);
    expect(card.figures).toHaveLength(1);
    expect(card.figures[0]!.role).toBe("stem");
    expect(card.figures[0]!.reviewState).toBe("pending");
    expect(card.figures[0]!.hash).toMatch(/^[0-9a-f]{64}$/);

    const 审计前 = await 数(h, "audit_log");
    const res = await passFigureReview(queueId, {
      by: "human",
      note: "图与题面对得上",
      handle: h,
    });

    expect(res.verdict).toBe("passed");
    expect(res.questionId).toBe(questionId);
    expect(res.figureIds).toHaveLength(1);
    expect(res.reviewRequired).toBe(0);

    // 🔴 单事务：三处一起变
    const fig = await 一行<{ review_state: string }>(
      h,
      "SELECT review_state FROM question_figure WHERE question_id = ?",
      [questionId],
    );
    expect(fig?.review_state).toBe("passed");
    const q = await 一行<{ review_required: number }>(
      h,
      "SELECT review_required FROM question WHERE id = ?",
      [questionId],
    );
    expect(Number(q?.review_required)).toBe(0);
    const item = await getQueueItem(queueId, { handle: h });
    expect(item?.state).toBe("passed");
    expect(item?.verdictBy).toBe("human");
    expect(item?.verdictNote).toBe("图与题面对得上");

    // 一笔写 = 一条审计行；闸静息、链没断
    expect(await 数(h, "audit_log")).toBe(审计前 + 1);
    const audit = await 一行<{ tool: string; refs: string }>(
      h,
      "SELECT tool, row_refs_json AS refs FROM audit_log ORDER BY seq DESC LIMIT 1",
    );
    expect(audit?.tool).toBe("passFigureReview");
    expect(audit?.refs).toContain("question_figure");
    expect(audit?.refs).toContain("review_queue");
    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ② 图片链红路
// ---------------------------------------------------------------------------

describe("② 图片工单 · 驳回与误用", () => {
  it("驳回必须写理由；驳回后题**保持**必审；终态不重裁；拿错链子报 KIND_MISMATCH", async () => {
    const h = await 造副本("fig-reject");
    const r = await 带图入库(h, "fig-reject");
    const queueId = r.queueIds[0]!;
    const questionId = r.questionIds[0]!;

    await expect(
      rejectFigureReview(queueId, { by: "human", handle: h }),
    ).rejects.toMatchObject({ name: "QueueError", code: "INVALID_INPUT" });

    const res = await rejectFigureReview(queueId, {
      by: "human",
      note: "图是隔壁那题的数轴，点位对不上",
      handle: h,
    });
    expect(res.verdict).toBe("rejected");
    expect(res.reviewRequired).toBe(1);

    const fig = await 一行<{ review_state: string }>(
      h,
      "SELECT review_state FROM question_figure WHERE question_id = ?",
      [questionId],
    );
    expect(fig?.review_state).toBe("rejected");
    // 🔴 题继续挂着必审、也没被自动隔离（怎么处置是人的决定）
    const q = await 一行<{ review_required: number; status: string }>(
      h,
      "SELECT review_required, status FROM question WHERE id = ?",
      [questionId],
    );
    expect(Number(q?.review_required)).toBe(1);
    expect(q?.status).toBe("pending");

    await expect(
      passFigureReview(queueId, { by: "另一个人", handle: h }),
    ).rejects.toMatchObject({ code: "QUEUE_ALREADY_DECIDED" });

    // 拿图审工单去走草稿链：类别不对，直接拒（别把两条链混着用）
    await expect(
      promoteDraftQuestion(queueId, { by: "human", handle: h }),
    ).rejects.toMatchObject({ code: "QUEUE_KIND_MISMATCH" });

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ③ 草稿链绿路
// ---------------------------------------------------------------------------

describe("③ 新题草稿 · 提议 → 转正", () => {
  it("propose 只开工单不入库；promote 才落库（FTS 跟上）+ 工单判过记下 questionId", async () => {
    const h = await 造副本("draft-ok");
    const 前 = await 全表计数(h);

    const p = await proposeQuestion({
      item: 好题("计算：3+5×2"),
      source: "queue-flows.test@propose",
      note: "会话里顺手录的",
      handle: h,
    });
    expect(p.precheck.ok).toBe(true);
    expect(p.precheck.reds).toEqual([]);
    expect(p.precheck.calcVerdict).toBe("verified");
    expect(p.precheck.stripped.join()).toContain("计算：");

    // 🔴 提议 ≠ 入库：只多了一条工单
    const 提议后 = await 全表计数(h);
    expect(提议后.question).toBe(前.question);
    expect(提议后.review_queue).toBe(前.review_queue! + 1);

    const card = await getDraftCard(p.queueId, { handle: h });
    expect(card.item.kind).toBe("新题草稿");
    expect(card.item.state).toBe("open");
    expect(card.draft.source).toBe("queue-flows.test@propose");
    expect(card.draft.item.stem).toBe("计算：3+5×2");
    expect(card.draft.precheck.ok).toBe(true);

    const r = await promoteDraftQuestion(p.queueId, {
      by: "human",
      handle: h,
      backup: false,
    });
    expect(r.promoted).toBe(true);
    expect(r.questionId).toBeTruthy();
    expect(r.batchId).toBeTruthy();
    expect(r.ingest.counts).toEqual({
      total: 1,
      accepted: 1,
      queued: 0,
      rejected: 0,
    });

    const q = await 一行<{ stem: string; status: string; batch: string }>(
      h,
      "SELECT stem, status, ingest_batch_id AS batch FROM question WHERE id = ?",
      [r.questionId!],
    );
    expect(q?.stem).toBe("3+5×2"); // 「计算：」已剥
    expect(q?.status).toBe("pending");
    expect(q?.batch).toBe(r.batchId);

    // FTS 投影跟上了（方案甲：写侧职责）
    expect(await 数(h, "question_fts")).toBe(前.question_fts! + 1);

    const item = await getQueueItem(p.queueId, { handle: h });
    expect(item?.state).toBe("passed");
    expect(item?.verdictNote).toContain(r.questionId!);

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ④ 草稿链红路
// ---------------------------------------------------------------------------

describe("④ 新题草稿 · 预检红照样开工单，转正零写", () => {
  it("红的也进队列（让人看着改）；转正被拦下时工单仍 open 且库零变化", async () => {
    const h = await 造副本("draft-red");

    const p = await proposeQuestion({
      item: {
        stem: "已知 |x-3|=5，则 x=________。",
        answer: "x=8 或 x=-2",
        qtype: "填空",
        kps: [{ ref: "绝对值宇宙无敌考点" }],
        prov: { type: "manual", createdBy: "003-D 单测" },
      },
      handle: h,
    });
    expect(p.precheck.ok).toBe(false);
    expect(p.precheck.reds.map((x) => x.code)).toContain("KP_NOT_FOUND");
    // 红灯的人话原样带出来（页面就靠它告诉人「哪儿不对、怎么改」）
    expect(p.precheck.reds[0]!.message).toContain("绝对值宇宙无敌考点");
    expect(p.precheck.reds[0]!.gate).toBe("③考点标全");

    const card = await getDraftCard(p.queueId, { handle: h });
    expect(card.item.state).toBe("open");
    expect(card.item.reason).toContain("KP_NOT_FOUND");

    const 前 = await 全表计数(h);
    const r = await promoteDraftQuestion(p.queueId, {
      by: "human",
      handle: h,
      backup: false,
    });

    expect(r.promoted).toBe(false);
    expect(r.questionId).toBe(null);
    expect(r.batchId).toBe(null);
    expect(r.verdict).toBe(null);
    // 🔴 新红灯原样端出来（页面照它显示），不吞
    expect(r.precheck.reds.map((x) => x.code)).toContain("KP_NOT_FOUND");

    // 🔴 零写：题没进、隔离区没长行、审计链没动
    expect(await 全表计数(h)).toEqual(前);
    // 工单还开着，等人改
    expect((await getQueueItem(p.queueId, { handle: h }))?.state).toBe("open");

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ⑤ 隔离链绿路
// ---------------------------------------------------------------------------

describe("⑤ 隔离区 · 改判重投", () => {
  it("坏料进隔离 → 改好重投 → 题落库 + 原行 resolved_at + why 留下处置行", async () => {
    const h = await 造副本("qr-fix");
    const 批 = await runIngestBatch(
      {
        contract: "kb-ingest/v1",
        source: "queue-flows.test@qr",
        items: [
          {
            seq: 7,
            stem: "计算：12−(−8)+(−5)",
            answer: "15",
            qtype: "计算",
            kps: [{ ref: "绝对值宇宙无敌考点" }],
            prov: { type: "manual", createdBy: "003-D 单测" },
          },
        ],
      },
      { actor: "system", handle: h, backup: false },
    );
    expect(批.counts.rejected).toBe(1);
    const qrId = 批.quarantineIds[0]!;

    const open = await listQuarantine({ handle: h });
    expect(open.map((x) => x.id)).toContain(qrId);
    expect(open.find((x) => x.id === qrId)!.why).toContain("KP_NOT_FOUND");

    // 人把考点改对了再投（页面就是把这段 JSON 放进 textarea 让人改）
    const 原料 = JSON.parse(
      (await getQuarantineRow(qrId, { handle: h }))!.payloadJson,
    ) as Record<string, unknown>;
    const r = await resolveQuarantine(qrId, {
      action: "reingest",
      editedPayload: { ...原料, kps: [{ ref: "绝对值的概念" }] },
      by: "human",
      note: "考点名写错了，改成真考点",
      handle: h,
      backup: false,
    });

    expect(r.resolved).toBe(true);
    expect(r.questionId).toBeTruthy();
    expect(r.precheck?.calcVerdict).toBe("verified");

    const q = await 一行<{ stem: string; status: string }>(
      h,
      "SELECT stem, status FROM question WHERE id = ?",
      [r.questionId!],
    );
    expect(q?.stem).toBe("12−(−8)+(−5)");
    expect(q?.status).toBe("pending");

    const 结后 = await getQuarantineRow(qrId, { handle: h });
    expect(结后?.resolvedAt).toBeTruthy();
    expect(结后?.why).toContain("【处置】");
    expect(结后?.why).toContain(r.questionId!);
    expect(结后?.why).toContain("考点名写错了");
    // 结掉的不再挡在人眼前
    expect(
      (await listQuarantine({ handle: h })).map((x) => x.id),
    ).not.toContain(qrId);

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ⑥ 隔离链红路 + 废弃
// ---------------------------------------------------------------------------

describe("⑥ 隔离区 · 重投还红 / 废弃 / 不重复处置", () => {
  it("还红=零写（隔离区不因重试长行）；废弃要理由；已结的不重复处置", async () => {
    const h = await 造副本("qr-red");
    const 批 = await runIngestBatch(
      {
        contract: "kb-ingest/v1",
        source: "queue-flows.test@qr2",
        items: [
          {
            seq: 1,
            stem: "计算：3+5×2",
            answer: "14",
            qtype: "计算",
            kps: [{ ref: "绝对值的概念" }],
            prov: { type: "manual", createdBy: "003-D 单测" },
          },
        ],
      },
      { actor: "system", handle: h, backup: false },
    );
    expect(批.counts.rejected).toBe(1);
    const qrId = 批.quarantineIds[0]!;

    // 改了个寂寞（答案还是 14）：预检照样红
    const 前 = await 全表计数(h);
    const 再投 = await resolveQuarantine(qrId, {
      action: "reingest",
      by: "human",
      handle: h,
      backup: false,
    });
    expect(再投.resolved).toBe(false);
    expect(再投.questionId).toBe(null);
    expect(再投.precheck?.reds.map((x) => x.code)).toContain("CALC_MISMATCH");
    // 🔴 重试不在隔离区多长一行，也不留审计行
    expect(await 全表计数(h)).toEqual(前);
    expect((await getQuarantineRow(qrId, { handle: h }))?.resolvedAt).toBe(
      null,
    );

    await expect(
      resolveQuarantine(qrId, { action: "discard", by: "human", handle: h }),
    ).rejects.toMatchObject({ name: "QueueError", code: "INVALID_INPUT" });

    const 废 = await resolveQuarantine(qrId, {
      action: "discard",
      by: "human",
      note: "这题答案本来就抄错了，题源已作废",
      handle: h,
    });
    expect(废.resolved).toBe(true);
    expect(废.questionId).toBe(null);
    const 行 = await getQuarantineRow(qrId, { handle: h });
    expect(行?.resolvedAt).toBeTruthy();
    expect(行?.why).toContain("废弃：这题答案本来就抄错了");

    await expect(
      resolveQuarantine(qrId, {
        action: "discard",
        by: "human",
        note: "再来一次",
        handle: h,
      }),
    ).rejects.toMatchObject({ code: "QUARANTINE_ALREADY_RESOLVED" });

    await expect(
      resolveQuarantine("qr_01JZZZZZZZZZZZZZZZZZZZZZZZ", {
        action: "discard",
        by: "human",
        note: "不存在的行",
        handle: h,
      }),
    ).rejects.toBeInstanceOf(QueueError);

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// ⑦ 读侧：批全账 + 资产
// ---------------------------------------------------------------------------

describe("⑦ 读侧 · getIngestBatch / getAssetByHash", () => {
  it("批账全量取得（含逐题逐闸 + 隔离计数）；资产按 hash 命中、乱 hash 回 null", async () => {
    const h = await 造副本("read");
    const dir = 目录("read");
    const r = await 带图入库(h, "read");

    const rec = (await getIngestBatch(r.batchId!, { handle: h }))!;
    expect(rec.id).toBe(r.batchId);
    expect(rec.contractVer).toBe("kb-ingest/v1");
    expect(rec.status).toBe("committed");
    expect(rec.counts).toEqual({
      total: 1,
      accepted: 1,
      queued: 1,
      rejected: 0,
    });
    expect(rec.questionIds).toEqual(r.questionIds);
    expect(rec.quarantine).toEqual({
      total: 0,
      open: 0,
      resolved: 0,
      openIds: [],
    });
    // 🔴 全账在库里：逐题逐闸九道，一道不少
    expect(rec.gateReport?.items).toHaveLength(1);
    expect(rec.gateReport?.items[0]!.gates.items).toHaveLength(9);
    expect(rec.gateReportRaw).toContain("⑩配图分级");

    expect(await getIngestBatch("batch_不存在", { handle: h })).toBe(null);

    // 资产：hash → 登记行 + 落地文件（页面据此渲染 /api/asset/<hash>）
    const card = await getFigureReviewCard(r.queueIds[0]!, { handle: h });
    const hash = card.figures[0]!.hash!;
    const a = (await getAssetByHash(hash, {
      handle: h,
      assetsDir: join(dir, "assets"),
    }))!;
    expect(a.hash).toBe(hash);
    expect(a.path).toBe(`${hash}.png`);
    expect(a.exists).toBe(true);
    expect(a.contentType).toBe("image/png");
    expect(readFileSync(a.absPath).toString()).toContain("PNG-FAKE");

    // 🔴 库里查不到登记行的，一律当不存在（null ⇒ 路由 404）
    expect(
      await getAssetByHash("0".repeat(64), {
        handle: h,
        assetsDir: join(dir, "assets"),
      }),
    ).toBe(null);
    expect(await getAssetByHash("  ", { handle: h })).toBe(null);
  }, 120_000);
});
