/**
 * scripts/reverify-calc-20260813.ts —— 🔴 **一次性复核脚本**（AI:PRD-003 · 003-E2）
 *
 * 2026-08-13 跑过**一次**就退役。它补的是一个「口径放宽了，但已入库的题不会自己跟着变」
 * 的窟窿：
 *
 *   种子集入库时侧车的 `calc_verify` 只有**数值档**（收窄到纯数值是当时的保守选择），
 *   于是 5 道「合并同类项 / 化简」的计算题被如实判成 `cannot_verify`、降级 `analysis_only`。
 *   003-E2 给侧车补了**符号恒等档**（kb-sidecar/3）——那 5 道题现在判得死了。
 *   但库里躺着的判档是当初写下的，**不会自己变**：所以要把旧题捞出来重跑一遍。
 *
 * 验收 3-1 要「qtype='计算' 的题 calc_verified 率 = 100%」，本脚本就是它的交付物。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/reverify-calc-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/reverify-calc-20260813.ts --commit   # 真跑
 * 退出码：0 = 收尾断言全绿（计算题 100% calc_verified，且没有待人裁的 mismatch）；
 *         1 = 有 mismatch 待人裁 / 收尾断言没达标 / 对账有 red。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 五条纪律
 *
 * ① **题面 / 答案 / 解析一字不动**。本脚本只动两个**属性列**：
 *      `solution_grade`（判档）与 `qtype`（题型分类）。
 *    正文是事实，判档是对事实的**结论** —— 结论可以随口径改，事实不行。
 *
 * ② **mismatch 绝不自动改库**。侧车说「题面算出来的和答案对不上」＝ 这道题**本身**
 *    可能是错的（答案抄错 / 题面录错），那是要**人**去核卷面的事。
 *    脚本把它全文列出来交人裁，一个字都不改
 *    —— 记忆 [[report-no-hedging-user-decides]]：我有疑问的不擅自定。
 *
 * ③ **改 qtype 是分类修正，不是改题**。那道「请找出所有符合条件的整数 x，
 *    使得 |x-4|+|x+2|=6」本质是**解答题**（多解枚举 + 要写理由），当初被录成了「计算」。
 *    它永远不可能 `calc_verified`（判它要比**解集**，不是比恒等），
 *    留在「计算」里会让那条 100% 的验收线永远差一道，且是**分类错**造成的假账。
 *    🔴 认它靠**题面全文精确匹配**，不靠 id/序号：题面是 SSOT，id 换库就变。
 *
 * ④ **一切经 core**（withCoreWrite）：开闸 → 业务写 → 审计行 → 关闸，同一事务。
 *    `tool='reverify_calc_20260813'`，`rowRefs` 逐行全报（对账①靠它找孤儿行），
 *    每次写的**逐题理由**落 `gate_results_json`（人日后翻 audit_log 能看见为什么改）。
 *
 * ⑤ **不重写 FTS**。`question_fts` 的投影列只有 `stem_plain / answer / analysis`
 *    （见 drizzle/0001 + core/fts.ts 写侧投影），本脚本这两列一个都没碰
 *    ⇒ 索引与正表天然还是对齐的，收尾对账 C1(f) 会替这句话背书。
 *    同理 `updated_at` 也不动：红线说了只动那两列，改动时间由**审计链**记，不由业务列记。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { eq } from "drizzle-orm";

import { question } from "../src/server/db/schema";
import {
  backupNow,
  calcVerify,
  closeCoreDb,
  getCoreDb,
  integrityCheck,
  withCoreWrite,
  type CalcVerifyResult,
  type CoreDbHandle,
  type GateItem,
  type GateReport,
  type RowRef,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

/** 审计里的工具名（一次性脚本也要留名，日后翻 audit_log 认得出是谁干的） */
const TOOL = "reverify_calc_20260813";

/**
 * 🔴 分类修正的那一道，按**题面全文**认（见纪律③）。
 * 认不到就跳过并如实说（多半是已经改过了 —— 本脚本可重复跑，第二次是空跑）。
 */
const 改判为解答的题面 = "请找出所有符合条件的整数 x，使得 |x-4|+|x+2|=6。";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");

interface 待复核题 {
  id: string;
  stem: string;
  answer: string | null;
  analysis: string | null;
  qtype: string | null;
  solutionGrade: string;
}

// ---------------------------------------------------------------------------
// 取料
// ---------------------------------------------------------------------------

/** 待复核集 = qtype='计算' 且还没拿到 calc_verified 的题 */
async function 取待复核(h: CoreDbHandle): Promise<待复核题[]> {
  const r = await h.client.execute(
    `SELECT id, stem, answer, analysis, qtype, solution_grade
       FROM question
      WHERE qtype = '计算' AND solution_grade <> 'calc_verified'
      ORDER BY id`,
  );
  return (
    r.rows as unknown as {
      id: string;
      stem: string;
      answer: string | null;
      analysis: string | null;
      qtype: string | null;
      solution_grade: string;
    }[]
  ).map((x) => ({
    id: x.id,
    stem: x.stem,
    answer: x.answer,
    analysis: x.analysis,
    qtype: x.qtype,
    solutionGrade: x.solution_grade,
  }));
}

// ---------------------------------------------------------------------------
// 账本（逐题理由进 audit_log.gate_results_json）
// ---------------------------------------------------------------------------

function 造账(名: string, items: GateItem[]): GateReport {
  return {
    ok: true,
    total: items.length,
    passed: items.length,
    failed: 0,
    skipped: 0,
    items: [{ name: 名, result: { ok: true }, ms: 0 }, ...items],
  };
}

/** 一条账目 = 一道题的理由；`name` 里写全（GateItem 只有这一处能放人话） */
function 账目(text: string): GateItem {
  return { name: text, result: { ok: true }, ms: 0 };
}

// ---------------------------------------------------------------------------
// 写：判档升档 / 分类修正
// ---------------------------------------------------------------------------

async function 升档(
  h: CoreDbHandle,
  命中: { q: 待复核题; r: CalcVerifyResult }[],
): Promise<number> {
  const items = 命中.map(({ q, r }) =>
    账目(
      `${q.id} 判档 ${q.solutionGrade}→calc_verified：${r.detail.reason}` +
        `（expr=${r.detail.expr ?? "—"} computed=${r.detail.computed ?? "—"} ` +
        `expected=${r.detail.expected ?? "—"}）`,
    ),
  );

  const receipt = await withCoreWrite(
    {
      actor: "agent",
      tool: TOOL,
      args: {
        动作: "solution_grade→calc_verified",
        依据: "kb-sidecar/3 符号恒等档复核通过",
        题: 命中.map(({ q, r }) => ({
          id: q.id,
          reason: r.detail.reason,
          computed: r.detail.computed,
          expected: r.detail.expected,
        })),
      },
      gateReport: 造账("符号恒等档复核（kb-sidecar/3）", items),
    },
    async (tx) => {
      const refs: RowRef[] = [];
      for (const { q } of 命中) {
        // 🔴 只 set 这一列。题面/答案/解析/updated_at 一个都不碰
        await tx
          .update(question)
          .set({ solutionGrade: "calc_verified" })
          .where(eq(question.id, q.id));
        refs.push({ table: "question", id: q.id, op: "update" });
      }
      return refs;
    },
    h,
  );

  say(
    `  审计 seq=${receipt.seq}  ts=${receipt.ts}  rowRefs=${receipt.rowRefs.length}`,
  );
  return receipt.rowRefs.length;
}

async function 改分类(h: CoreDbHandle, q: 待复核题): Promise<number> {
  const 理由 =
    `${q.id} 题型 计算→解答：题面是「求满足条件的所有整数」——多解枚举 + 要写理由，` +
    "本质是解答题，当初录成了计算。它永远不可能 calc_verified（判它要比解集，不是比恒等），" +
    "留在计算里会让验收线永远差一道，且差的是分类错造成的假账。" +
    "🔴 只改 qtype 这一列，题面/答案/解析一字未动。";

  const receipt = await withCoreWrite(
    {
      actor: "agent",
      tool: TOOL,
      args: { 动作: "qtype 计算→解答", id: q.id, 依据: 理由 },
      gateReport: 造账("题型分类修正", [账目(理由)]),
    },
    async (tx) => {
      await tx
        .update(question)
        .set({ qtype: "解答" })
        .where(eq(question.id, q.id));
      return [{ table: "question", id: q.id, op: "update" }] satisfies RowRef[];
    },
    h,
  );

  say(
    `  审计 seq=${receipt.seq}  ts=${receipt.ts}  rowRefs=${receipt.rowRefs.length}`,
  );
  return receipt.rowRefs.length;
}

// ---------------------------------------------------------------------------
// 收尾断言
// ---------------------------------------------------------------------------

async function 收尾(h: CoreDbHandle): Promise<number> {
  say("");
  say(杠);
  say("收尾核对");
  say(杠);

  const rep = await integrityCheck({ handle: h });
  const reds = rep.checks.filter((c) => !c.ok && c.level === "red");
  say("");
  say("① integrity_check 六项：");
  for (const c of rep.checks) {
    const tag = c.ok ? "[PASS]" : c.level === "red" ? "[RED ]" : "[warn]";
    say(`  ${tag} ${c.id} ${c.name}`);
  }
  say(
    `  结论：red=${reds.length}  warn=${rep.checks.filter((c) => !c.ok && c.level === "warn").length}`,
  );

  say("");
  say("② solution_grade × qtype 分布：");
  const dist = await h.client.execute(
    `SELECT qtype,
            COUNT(*) AS n,
            SUM(CASE WHEN solution_grade='calc_verified' THEN 1 ELSE 0 END) AS 实算过,
            SUM(CASE WHEN solution_grade='analysis_only' THEN 1 ELSE 0 END) AS 仅解析,
            SUM(CASE WHEN solution_grade='no_solution'   THEN 1 ELSE 0 END) AS 无解
       FROM question GROUP BY qtype ORDER BY n DESC`,
  );
  let 计算n = 0;
  let 计算实算 = 0;
  for (const row of dist.rows as unknown as Record<string, string | number>[]) {
    const n = Number(row.n);
    const v = Number(row.实算过);
    if (String(row.qtype) === "计算") {
      计算n = n;
      计算实算 = v;
    }
    say(
      `  ${String(row.qtype).padEnd(6)} n=${String(n).padStart(3)}  ` +
        `calc_verified=${String(v).padStart(3)}  analysis_only=${String(row.仅解析).padStart(3)}  ` +
        `no_solution=${String(row.无解).padStart(3)}  实算率=${n > 0 ? Math.round((v / n) * 100) : 0}%`,
    );
  }

  say("");
  say("③ 🔴 验收断言：qtype='计算' 的题 calc_verified 率 = 100%");
  const 达标 = 计算n > 0 && 计算实算 === 计算n;
  say(
    `  计算题 ${计算实算}/${计算n} = ${计算n > 0 ? Math.round((计算实算 / 计算n) * 100) : 0}%  ` +
      `${达标 ? "[PASS]" : "[FAIL]"}`,
  );
  if (!达标) {
    const 漏 = await h.client.execute(
      `SELECT id, solution_grade, substr(stem,1,60) AS stem
         FROM question WHERE qtype='计算' AND solution_grade<>'calc_verified' ORDER BY id`,
    );
    for (const r of 漏.rows as unknown as Record<string, string>[]) {
      say(`  🔴 ${r.id}  ${r.solution_grade}  「${r.stem}」`);
    }
  }

  return reds.length + (达标 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");

  say(杠);
  say("AI:PRD-003 · 003-E2 计算题实算复核（真库）");
  say(`  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}`);
  say(杠);

  const h = await getCoreDb();
  const 待 = await 取待复核(h);

  say("");
  say(
    `待复核（qtype='计算' 且 solution_grade<>'calc_verified'）：${待.length} 道`,
  );
  if (待.length === 0) {
    say("  —— 空集：要么已经跑过一遍了，要么这个库里就没有待复核的计算题。");
    const reds = await 收尾(h);
    await closeCoreDb();
    process.exitCode = reds === 0 ? 0 : 1;
    return;
  }

  // ── 一次进程算完一批（侧车纪律①：批量在入参数组里做）────────────────────
  const 结果 = await calcVerify(
    待.map((q) => ({ id: q.id, stem: q.stem, answer: q.answer ?? "" })),
  );
  const by = new Map(结果.map((r) => [r.id, r]));

  const 命中: { q: 待复核题; r: CalcVerifyResult }[] = [];
  const 打脸: { q: 待复核题; r: CalcVerifyResult }[] = [];
  const 仍判不了: { q: 待复核题; r: CalcVerifyResult }[] = [];

  say("");
  say(杠);
  say("逐题复核（kb-sidecar/3：数值档 → 符号恒等档）");
  say(杠);
  for (const q of 待) {
    const r = by.get(q.id);
    if (!r) throw new Error(`侧车没回 ${q.id} 的结果 —— 批量口径对不上，停手`);
    say(细);
    say(`${q.id}  [${r.verdict}]`);
    say(`  题面：${q.stem}`);
    say(`  答案：${(q.answer ?? "—").replace(/\n/g, " ⏎ ")}`);
    say(`  理由：${r.detail.reason}`);
    if (r.detail.expr !== null) {
      say(
        `  算式：${r.detail.expr}  →  computed=${r.detail.computed ?? "—"}  expected=${r.detail.expected ?? "—"}`,
      );
    }
    if (r.verdict === "verified") 命中.push({ q, r });
    else if (r.verdict === "mismatch") 打脸.push({ q, r });
    else 仍判不了.push({ q, r });
  }

  // ── mismatch：🔴 不改库，全文列出来交人裁 ───────────────────────────────
  if (打脸.length > 0) {
    say("");
    say(杠);
    say(`🔴 mismatch ${打脸.length} 道 —— **一个字都不改**，交人裁（见纪律②）`);
    say(杠);
    for (const { q, r } of 打脸) {
      say(细);
      say(`id      ${q.id}`);
      say(`qtype   ${q.qtype ?? "—"}   判档 ${q.solutionGrade}`);
      say(`题面    ${q.stem}`);
      say(`答案    ${q.answer ?? "—"}`);
      say(`解析    ${q.analysis ?? "—"}`);
      say(`侧车    ${r.detail.reason}`);
      say(
        `        expr=${r.detail.expr ?? "—"}  computed=${r.detail.computed ?? "—"}  expected=${r.detail.expected ?? "—"}`,
      );
      say("要人判的是：答案抄错了，还是题面数字录错了？");
    }
  }

  // ── cannot_verify：分类修正的那一道单独拎出来 ──────────────────────────
  const 待改分类 = 仍判不了.filter((x) => x.q.stem === 改判为解答的题面);
  const 其余判不了 = 仍判不了.filter((x) => x.q.stem !== 改判为解答的题面);

  say("");
  say(杠);
  say("处置计划");
  say(杠);
  say(`  ① 判档升 calc_verified：${命中.length} 道`);
  for (const { q } of 命中) say(`     ${q.id}  「${q.stem}」`);
  say(`  ② 题型改判 计算→解答：${待改分类.length} 道`);
  for (const { q } of 待改分类) say(`     ${q.id}  「${q.stem}」`);
  say(`  ③ 🔴 不动库、交人裁（mismatch）：${打脸.length} 道`);
  say(`  ④ 仍 cannot_verify 且不改分类（原样留着）：${其余判不了.length} 道`);
  for (const { q, r } of 其余判不了) {
    say(`     ${q.id}  「${q.stem}」 —— ${r.detail.reason}`);
  }

  if (!commit) {
    say("");
    say("干跑完毕（库零变化）。确认账没问题后再跑：--commit");
    await closeCoreDb();
    // 干跑不下结论，但 mismatch 得让人看见
    process.exitCode = 打脸.length === 0 ? 0 : 1;
    return;
  }

  say("");
  say(杠);
  say("🔴 真跑（--commit）");
  say(杠);
  // 动真库前先留一份快照：本脚本改的是判档结论，改错了要退回去得有个退路
  const bk = await backupNow({ reason: "manual" }, h);
  say(
    `  快照：${bk.path}（${bk.bytes} B，question=${bk.snapshotRowCounts.question}）`,
  );
  let 改了 = 0;
  if (命中.length > 0) {
    say(`① 判档升档 ${命中.length} 道：`);
    改了 += await 升档(h, 命中);
  } else {
    say("① 判档升档：无");
  }
  if (待改分类.length > 0) {
    for (const { q } of 待改分类) {
      say(`② 题型改判 ${q.id}：计算→解答`);
      改了 += await 改分类(h, q);
    }
  } else {
    say("② 题型改判：无");
  }
  say(`共改 ${改了} 行（全部只动 solution_grade / qtype 两列）。`);

  const reds = await 收尾(h);
  await closeCoreDb();

  say("");
  const 坏 = reds + (打脸.length > 0 ? 1 : 0);
  say(
    坏 === 0
      ? "结论：计算题实算复核完成，收尾断言全绿。"
      : `结论：🔴 还有 ${坏} 项要处理（对账 red ${reds} 项${打脸.length > 0 ? ` + mismatch ${打脸.length} 道待人裁` : ""}）。`,
  );
  process.exitCode = 坏 === 0 ? 0 : 1;
}

void main();
