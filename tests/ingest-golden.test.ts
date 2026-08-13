/**
 * 录题管道金标 —— REG-C2 / REG-C3 / REG-C4（AI:PRD-003 · 003-E）
 *
 * 与 `ingest-gates.test.ts`（REG-C1 逐闸一红一绿）的分工：那边钉**每道闸**的判定，
 * 这边钉**整条管道对一份固定料的结论**。闸各自没变、串起来的行为却变了（顺序、
 * 判档、谁先红），只有金标重放抓得住。
 *
 *   REG-C2  金标 payload 重放：固定 10 题（6 好料 + 4 坏料）→ accepted/queued/rejected
 *           与**逐题 verdict/code** 精确等于基准。管道行为漂移即被抓。
 *   REG-C3  题干图必审：带题干图入库 → review_queue 必现工单、question.review_required=1。
 *   REG-C4  实算闸样题：3 道计算题过 sympy 实算 **且** 逐行恒等全绿；
 *           1 道答案错必被拦（CALC_MISMATCH）；
 *           🔴 1 道**答案对、中间行错**必被拦（CALC_LINE_MISMATCH）——
 *           这一条是整份金标里最要紧的：它是 2026-07-30 那次事故的复刻，
 *           而「只重算最终答案」的闸对它完全免疫（本例里答案闸确实放行了）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 REG-C2/C4 跑在**「金标库」**上：真库 VACUUM INTO 出来的副本，
 *    再把**金标好料自己那几道题**按 match_key 摘掉。零写照旧（dryRun），
 *    且用例自己在跑前跑后各数一遍行，断言全等。
 *
 *    ⚠️ 原设计是直接打真库，理由是「查重闸读的是真库，拿副本验等于验了个别的库」。
 *    这条理由 2026-08-13（005-C）**到期**了：金标的 6 道好料全都逐条注着「未入库」——
 *    它们是从产线存量里挑的真题拷贝，而 005-C 干的正是**把产线存量接进库**
 *    （群卷第01期 445 题 + 绝对值册 84 题）。于是查重闸（⑦，在实算闸⑧**之前**）
 *    把 6 道好料全判 `DUPLICATE`，金标要验的判档与实算行为被整个遮住 ——
 *    REG-C4 那条「答案对、中间行错也要拦」的核心断言直接测不到了。
 *
 *    所以副本里按 match_key 摘掉这几行 = 把库恢复到金标料**赖以成立的那个前提**
 *    （「这几道题还没入库」），验的仍是同一条管道、同一份料、同一批闸。
 *    🔴 摘的只是**好料**那几行：坏料③（seq=9）要撞的是另一道真题，它照旧在库里，
 *    `DUPLICATE` 那条红灯仍由真数据触发，没被削掉。
 *    🔴 摘的是副本，真库一个字节不动。
 * 🔴 REG-C3 要真写（工单是写出来的），所以它走 VACUUM INTO 副本，各住独立目录
 *    （管道会往 `<库同级>/assets/` 拷图）。
 * 🔴 金标料 = `tests/fixtures/ingest-golden-20260813.json`，全是真题拷贝、逐条注明来源。
 *    基准变了要先问「是管道改对了还是改坏了」，别顺手改基准把红旗按灭。
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCoreDb,
  getCoreDb,
  matchKeyOfStem,
  runIngestBatch,
  type CoreDbHandle,
} from "~/core";

// ---------------------------------------------------------------------------
// 金标料
// ---------------------------------------------------------------------------

interface 逐题基准 {
  seq: number;
  verdict: "accepted" | "rejected";
  code: string | null;
  solutionGrade?: string | null;
  calcVerdict?: string | null;
  lineVerdict?: string | null;
  来源: string;
}

interface 金标组 {
  基准: {
    counts: {
      total: number;
      accepted: number;
      queued: number;
      rejected: number;
    };
    逐题?: 逐题基准[];
  };
  payload: Record<string, unknown>;
}

const 金标 = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/ingest-golden-20260813.json"),
    "utf8",
  ),
) as { 金标: 金标组; 实算: 金标组; 配图: 金标组 };

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 目录清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const dir = join(tmpdir(), `kf-golden-${process.pid}-${tag}`);
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

const 计数表 = [
  "question",
  "question_fts",
  "question_figure",
  "asset",
  "ingest_batch",
  "quarantine",
  "review_queue",
  "audit_log",
] as const;

async function 全表计数(h: CoreDbHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of 计数表) {
    const r = await h.client.execute(`SELECT COUNT(*) AS c FROM ${t}`);
    out[t] = Number((r.rows[0] as unknown as { c: number }).c);
  }
  return out;
}

/**
 * 金标库 = 真库副本 − 金标料里**基准不指望它撞库**的那几道题（见文件头）。
 *
 * 🔴 判据是 `基准.code !== 'DUPLICATE'`，不是「是不是好料」：
 *    实算组 seq=4 是**坏料**（真题面 + 故意改错的答案），基准要的是 `CALC_MISMATCH`；
 *    可查重闸⑦ 排在实算闸⑧ **之前**，它的题面一旦进了库，红的就变成 `DUPLICATE`，
 *    要验的答案闸压根跑不到。所以「不指望撞库的」一律恢复前提。
 * 🔴 反过来，金标组 seq=9 的基准**就是** `DUPLICATE`（原样再投一道已入库的题）——
 *    它要撞的那行一个字不动，那条红灯仍由真数据触发。
 * 返回处理的行数，跑的时候打出来：一行没动 = 金标料的「未入库」注释还成立。
 */
async function 摘掉好料(h: CoreDbHandle): Promise<number> {
  const keys = new Set<string>();
  for (const 组 of [金标.金标, 金标.实算]) {
    const items = (组.payload.items ?? []) as { seq: number; stem: string }[];
    for (const b of 组.基准.逐题 ?? []) {
      if (b.code === "DUPLICATE") continue; // 🔴 这条基准就是要撞，留着
      const it = items.find((x) => x.seq === b.seq);
      if (it) keys.add(matchKeyOfStem(it.stem));
    }
  }
  if (keys.size === 0) return 0;
  const 占位 = [...keys].map(() => "?").join(",");
  const ids = (
    await h.client.execute({
      sql: `SELECT id FROM question WHERE match_key IN (${占位})`,
      args: [...keys],
    })
  ).rows.map((r) => String((r as unknown as { id: string }).id));
  if (ids.length === 0) return 0;

  // 🔴 不用 DELETE，改 `status='retired'`（下架）：
  //    ① 查重闸⑦ 与部分唯一索引 `idx_q_matchkey` 是同一条口径 ——
  //       `WHERE match_key = ? AND status IN ('pending','active')` ——
  //       下架的题**天然不参与查重**，正是我们要的「这几道题还没入库」的效果；
  //    ② DELETE 要顺着 sku_item / question_figure / cause_example… 一路拆外键，
  //       拆漏一张表就是 FOREIGN KEY failed，而且这份清单会随 schema 长 ——
  //       夹具不该背这个维护负担。
  // 🔴 副本上也有静息闸（裸写会被触发器 ABORT）——这里是**造夹具**不是业务写，
  //    照 tests/core.test.ts 的既有做法把闸掰开、做完立刻关回去。
  //    关回去很要紧：C1(e) 就是查 `_write_gate.allowed`，敞着闸的副本自己就是红的。
  await h.client.execute("UPDATE _write_gate SET allowed=1 WHERE id=1");
  try {
    for (const id of ids) {
      await h.client.execute({
        sql: "UPDATE question SET status = 'retired' WHERE id = ?",
        args: [id],
      });
    }
  } finally {
    await h.client.execute("UPDATE _write_gate SET allowed=0 WHERE id=1");
  }
  return ids.length;
}

let 真库: CoreDbHandle;
let 金标库: CoreDbHandle;

beforeAll(async () => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
  真库 = await getCoreDb();
  金标库 = await 造副本("replay");
  const 摘 = await 摘掉好料(金标库);
  // 🔴 摘 0 行 = 金标好料一道都不在库里（前提本来就成立），也是合法状态；
  //    这里只把数字打出来，不断言 —— 断言它反而会随「存量接没接进来」漂。
  process.stdout.write(`  [金标库] 摘掉已入库的好料 ${摘} 行（真库不动）\n`);
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
// REG-C5（003-E4）：真库检索投影的两条**存量**红线
// ---------------------------------------------------------------------------

describe("REG-C5 真库检索投影干净（真库 · 只读）", () => {
  it("🔴 全库 stem_plain / question_fts 里没有一个版面标记词", async () => {
    // 群卷题面的填空线是 <span style="…border-bottom…">、选项栅格是 <div style="display:grid…">，
    // 曾经原样喂给 jieba ⇒ span/style/display/border 成了检索词（G-3 群卷路观察）。
    // 转换层已加 stripHtmlForSeg，存量已由 scripts/rederive-stemplain-20260813.ts 重派生。
    // 这一条守的是**存量不再退回去**：新料由闸与管道守，老料由这里守。
    const 标记词 = [
      "span",
      "style",
      "display",
      "border",
      "bottom",
      "inline",
      "block",
      "div",
      "grid",
      "solid",
    ];
    const 脏 = 标记词
      .map(
        (w) =>
          `(SELECT COUNT(*) FROM question WHERE ' '||lower(stem_plain)||' ' LIKE '% ${w} %')`,
      )
      .concat(
        标记词.map(
          (w) =>
            `(SELECT COUNT(*) FROM question_fts WHERE ' '||lower(stem_plain)||' ' LIKE '% ${w} %'` +
            ` OR ' '||lower(answer)||' ' LIKE '% ${w} %'` +
            ` OR ' '||lower(analysis)||' ' LIKE '% ${w} %')`,
        ),
      )
      .join(" + ");
    const r = await 真库.client.execute(`SELECT ${脏} AS c`);
    expect(Number((r.rows[0] as unknown as { c: number }).c)).toBe(0);
  });

  it("🔴 全库正本 stem/answer/analysis 里没有内部占位串『［图』", async () => {
    // 契约 §2.4：占位串是备料层的红旗，图的信息由 question_figure 承载。
    // 闸⑥ 的 STEM_INTERNAL_MARKER 守新料；这一条守存量（q_…HHYS 那道配图重投题曾漏进来）。
    const r = await 真库.client.execute(
      `SELECT COUNT(*) AS c FROM question
        WHERE stem LIKE '%［图%' OR answer LIKE '%［图%' OR analysis LIKE '%［图%'
           OR stem LIKE '%[图%'  OR answer LIKE '%[图%'  OR analysis LIKE '%[图%'`,
    );
    expect(Number((r.rows[0] as unknown as { c: number }).c)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REG-C2
// ---------------------------------------------------------------------------

describe("REG-C2 金标 payload 重放（10 题含 4 坏料，金标库 · 零写）", () => {
  it("counts 与逐题 verdict/code 精确等于基准，且库一个字节没动", async () => {
    const 前 = await 全表计数(金标库);

    const r = await runIngestBatch(金标.金标.payload, {
      actor: "system",
      handle: 金标库,
      dryRun: true,
    });

    // ── counts 精确等于基准 ────────────────────────────────────────────────
    expect(r.counts).toEqual(金标.金标.基准.counts);

    // ── 逐题 verdict/code 精确等于基准（错在哪一条，一眼看得出）──────────────
    const 实得 = r.gateReport.items.map((it) => ({
      seq: it.seq,
      verdict: it.verdict,
      code: it.failure?.code ?? null,
    }));
    const 期望 = 金标.金标.基准.逐题!.map((b) => ({
      seq: b.seq,
      verdict: b.verdict,
      code: b.code,
    }));
    expect(实得).toEqual(期望);

    // ── 判档也钉住：好料落哪一档是管道的结论，不是自由发挥 ────────────────────
    for (const b of 金标.金标.基准.逐题!) {
      if (b.verdict !== "accepted") continue;
      const it = r.gateReport.items.find((x) => x.seq === b.seq)!;
      expect(it.solutionGrade, `seq=${b.seq}（${b.来源}）判档`).toBe(
        b.solutionGrade,
      );
    }

    // ── 坏料一条都不许落库 ────────────────────────────────────────────────
    expect(r.questionIds).toEqual([]);
    expect(r.batchId).toBe(null);

    // 🔴 零写自证：dryRun 说自己不写，那就当场数一遍
    expect(await 全表计数(金标库)).toEqual(前);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// REG-C4
// ---------------------------------------------------------------------------

describe("REG-C4 实算闸样题（金标库 · 零写）", () => {
  it("3 道计算题实算 + 逐行恒等全绿；答案错被拦；🔴 答案对但中间行错也被拦", async () => {
    const 前 = await 全表计数(金标库);

    const r = await runIngestBatch(金标.实算.payload, {
      actor: "system",
      handle: 金标库,
      dryRun: true,
    });

    expect(r.counts).toEqual(金标.实算.基准.counts);

    for (const b of 金标.实算.基准.逐题!) {
      const it = r.gateReport.items.find((x) => x.seq === b.seq)!;
      expect(it.verdict, `seq=${b.seq} verdict`).toBe(b.verdict);
      expect(it.failure?.code ?? null, `seq=${b.seq} code`).toBe(b.code);
      expect(it.calcVerdict, `seq=${b.seq} calcVerdict`).toBe(b.calcVerdict);
      expect(it.lineVerdict, `seq=${b.seq} lineVerdict`).toBe(b.lineVerdict);
    }

    // 答案错：红灯里带得出实算值与卷面答案，人拿着就能判是答案抄错还是题面抄错
    const 答案错 = r.gateReport.items.find((x) => x.seq === 4)!;
    expect(答案错.failure?.message).toContain("10"); // 实算值
    expect(答案错.failure?.message).toContain("11"); // 卷面答案

    // 🔴 中间行错：答案闸**放行**（calcVerdict=verified），逐行闸拦下 ——
    //    这正是「只重算最终答案」验不出的那一类，也是本条回归存在的全部理由。
    const 过程错 = r.gateReport.items.find((x) => x.seq === 5)!;
    expect(过程错.calcVerdict).toBe("verified");
    expect(过程错.failure?.code).toBe("CALC_LINE_MISMATCH");
    expect(过程错.failure?.message).toContain("-8+3-54"); // 断裂的那一行
    expect(过程错.failure?.message).toContain("-59"); // 它实际算出来的值
    expect(过程错.failure?.message).toContain("49"); // 而原式是 49

    expect(await 全表计数(金标库)).toEqual(前);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// REG-C3
// ---------------------------------------------------------------------------

describe("REG-C3 题干图必审（副本 · 真写）", () => {
  it("带题干图入库 ⇒ review_required=1 + 队列里必现一张 kind='图片' 的 open 工单", async () => {
    const tag = "figure";
    const h = await 造副本(tag);
    const 图 = join(tmpdir(), `kf-golden-${process.pid}-${tag}`, "shuzhou.png");
    writeFileSync(图, "PNG-FAKE-数轴四点图");

    const payload = structuredClone(金标.配图.payload) as {
      items: Record<string, unknown>[];
    };
    payload.items[0]!.figures = [{ role: "stem", path: 图 }];

    const r = await runIngestBatch(payload, {
      actor: "system",
      handle: h,
      backup: false,
    });

    expect(r.counts).toEqual(金标.配图.基准.counts);
    // 🔴 queued 是 accepted 的**子集**：这题既进了库、又挂着必审
    expect(r.counts.queued).toBe(1);
    expect(r.questionIds).toHaveLength(1);
    expect(r.queueIds).toHaveLength(1);

    const q = (
      await h.client.execute({
        sql: "SELECT review_required, status FROM question WHERE id = ?",
        args: [r.questionIds[0]!],
      })
    ).rows[0] as unknown as { review_required: number; status: string };
    expect(Number(q.review_required)).toBe(1);
    expect(q.status).toBe("pending");

    const w = (
      await h.client.execute({
        sql: "SELECT kind, ref_type, ref_id, state FROM review_queue WHERE id = ?",
        args: [r.queueIds[0]!],
      })
    ).rows[0] as unknown as Record<string, string>;
    expect(w.kind).toBe("图片");
    expect(w.ref_type).toBe("question");
    expect(w.ref_id).toBe(r.questionIds[0]);
    expect(w.state).toBe("open");

    // 图按内容 hash 落资产仓（页面按 hash 取图）
    // 🔴 按 question_id 取：副本里已经有 003-E 首批那张过了审的图，不加条件会拿错行
    const f = (
      await h.client.execute({
        sql: "SELECT f.role, f.review_state, a.hash, a.kind FROM question_figure f JOIN asset a ON a.id = f.asset_id WHERE f.question_id = ?",
        args: [r.questionIds[0]!],
      })
    ).rows[0] as unknown as Record<string, string>;
    expect(f.role).toBe("stem");
    expect(f.review_state).toBe("pending");
    expect(f.kind).toBe("png");
    expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});
