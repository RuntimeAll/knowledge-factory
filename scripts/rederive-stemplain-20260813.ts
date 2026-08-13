/**
 * scripts/rederive-stemplain-20260813.ts —— 🔴 **一次性全库重派生**（AI:PRD-003 · 003-E4）
 *
 * 2026-08-13 跑过**一次**就退役。它修的是 G-3 群卷路观察到的（备料 R2 早有预警）
 * **检索投影污染**：
 *
 *   群卷题面里三种格式混存，填空线是
 *     `<span style="display:inline-block;border-bottom:1px solid #000;min-width:3.4em"></span>`，
 *   选项栅格是 `<div style="display:grid;grid-template-columns:repeat(2,1fr);…">`。
 *   录题管道相一把 `stem` **原样**喂给 jieba ⇒ 分词串里躺着
 *     `span` / `style` / `display` / `inline` / `block` / `border` / `bottom` / `1px` / `solid` / `min` / `width` / `em`
 *   这些 token 不是题目的任何一部分，却进了 `question.stem_plain` 与 `question_fts`
 *   —— 搜「border」能搜出一堆填空题，而真正想搜的词被样式串挤在里头。
 *
 *   转换层已在 `core/fts.ts` 的 `stripHtmlForSeg` 修好（喂料前剥标签、解实体），
 *   本脚本负责把**存量**用修好的口径重算一遍。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/rederive-stemplain-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/rederive-stemplain-20260813.ts --commit   # 真跑
 * 退出码：0 = 复核全绿且对账 red=0；1 = 有一项没过。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 五条纪律
 *
 * ① **只动派生层**。`question.stem` / `answer` / `analysis` 三列正本**一个字都不碰** ——
 *    版面标记是源的一部分（渲染要用），该剥的是喂给分词器的那一份。
 *    本脚本的 UPDATE 语句里压根没有这三列。
 *
 * ② **`match_key` 不动**。它的归一管线（`ingest-dedup.gate.ts` 的 `normalizeStem`）
 *    本来就剥 HTML，这次改的是**分词喂料**那一路，两路各走各的。
 *    ⚠️ 但复核里会如实报出 `normalizeStem` 的一处**已知缺陷**（宽松 `<[^>]*>` 会吃数学
 *    不等号，真库 2 行中招）——挂账不修，见那个文件里的长注释。
 *
 * ③ **同事务重写 FTS 投影**（kb-ingest/v1 §6 纪律 1）。`stem_plain` 改了而 `question_fts`
 *    没跟 = 那题此后 FTS 查到的还是旧词，且不报错。
 *
 * ④ **一次侧车进程吃整批**。60 题 × 3 段 = 180 条文本一趟走完；
 *    一题一进程就是把 jieba 载词典那 0.4s 乘以题数（sidecar.ts 纪律①）。
 *
 * ⑤ **只写有变化的行**，逐行把改前改后打出来。没变化的行不进事务、不留审计 ——
 *    "全库重刷一遍"式的写会让审计链里多出 60 行"什么都没改"的记录。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { eq } from "drizzle-orm";

import { question } from "../src/server/db/schema";
import {
  closeCoreDb,
  getCoreDb,
  integrityCheck,
  normalizeStem,
  nowLocalISO,
  segmentTexts,
  stripHtmlForSeg,
  withCoreWrite,
  writeQuestionFts,
  type CoreDbHandle,
  type GateItem,
  type GateReport,
  type RowRef,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

const TOOL = "g3_fix3_rederive_20260813";

/** FTS 只收这两个状态的题（与对账 C1(f) 同口径） */
const 可检索状态 = new Set(["pending", "active"]);

/**
 * 🔴 回归断言用的「版面标记词」黑名单。
 *    分词串里出现它们 = 有 HTML 标签漏进了喂料。
 *    ⚠️ 刻意只收**纯标记词**：`grid`/`repeat`/`solid` 这类也算，但像 `top`/`left`
 *    这种英文常用词不收 —— 黑名单误伤比漏抓更难查。
 */
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
  "px",
  "em",
] as const;

const 根因 =
  "录题管道相一把 stem/answer/analysis **原样**喂给 jieba 分词，" +
  '而群卷题面的填空线是 <span style="display:inline-block;border-bottom:1px solid #000;…"></span>、' +
  '选项栅格是 <div style="display:grid;…">（备料 R2 实测三种格式混存）⇒ ' +
  "span/style/display/border 等版面标记词进了 question.stem_plain 与 question_fts，成了检索词。" +
  "已在 core/fts.ts 加 stripHtmlForSeg（喂料前剥标签 + 解实体）并接进管道相一；本脚本重算存量。";
const 核查出处 =
  "AI:PRD-003 · G-3「回对原件」核查（2026-08-13）群卷路范围外观察，R2 预警成真。" +
  "剥法只认「标签形状」</?[a-zA-Z][^<>]*>：数学裸不等号（有理数 a < 0、用 < 或 > 或 = 号填空、" +
  "1 000 < 50 653 < 1 000 000）一个字都不许吃 —— 核查员方法论坑①。";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");

// ---------------------------------------------------------------------------
// 取料
// ---------------------------------------------------------------------------

interface 题行 {
  id: string;
  stem: string;
  answer: string | null;
  analysis: string | null;
  stemPlain: string;
  status: string;
  /** question_fts 里那三列现值（没有投影行则为 null） */
  fts: { stemPlain: string; answer: string; analysis: string } | null;
}

async function 读全库(h: CoreDbHandle): Promise<题行[]> {
  const r = await h.client.execute(
    `SELECT q.id            AS id,
            q.stem          AS stem,
            q.answer        AS answer,
            q.analysis      AS analysis,
            q.stem_plain    AS stem_plain,
            q.status        AS status,
            f.stem_plain    AS f_stem,
            f.answer        AS f_answer,
            f.analysis      AS f_analysis,
            f.question_id   AS f_id
       FROM question q
       LEFT JOIN question_fts f ON f.question_id = q.id
      ORDER BY q.id`,
  );
  return (r.rows as unknown as Record<string, string | null>[]).map((row) => ({
    id: String(row.id),
    stem: String(row.stem ?? ""),
    answer: row.answer === null ? null : String(row.answer),
    analysis: row.analysis === null ? null : String(row.analysis),
    stemPlain: String(row.stem_plain ?? ""),
    status: String(row.status),
    fts:
      row.f_id === null || row.f_id === undefined
        ? null
        : {
            stemPlain: String(row.f_stem ?? ""),
            answer: String(row.f_answer ?? ""),
            analysis: String(row.f_analysis ?? ""),
          },
  }));
}

/** 分词串里命中了哪些版面标记词 */
function 命中标记词(seg: string): string[] {
  const toks = new Set(
    seg
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase()),
  );
  return 标记词.filter((w) => toks.has(w));
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

function 账目(text: string): GateItem {
  return { name: text, result: { ok: true }, ms: 0 };
}

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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface 变更 {
  row: 题行;
  新stemPlain: string;
  新answerSeg: string;
  新analysisSeg: string;
  /** 变在哪几列 */
  变列: string[];
  旧标记词: string[];
}

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");

  say(杠);
  say("AI:PRD-003 · 003-E4 检索投影全库重派生（真库）");
  say(
    "  口径：分词喂料先过 stripHtmlForSeg（剥标签 + 解实体），写侧 mode='search'",
  );
  say("  🔴 正本 stem/answer/analysis 与 match_key 一律不动");
  say(`  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}`);
  say(杠);

  const h = await getCoreDb();
  const rows = await 读全库(h);
  say("");
  say(
    `全库 ${rows.length} 题（可检索态 ${rows.filter((r) => 可检索状态.has(r.status)).length}）`,
  );

  // ── 一趟侧车吃整批（纪律④）────────────────────────────────────────────────
  const inputs: { id: string; text: string }[] = [];
  rows.forEach((r, i) => {
    inputs.push({ id: `s${i}`, text: stripHtmlForSeg(r.stem) });
    if (r.answer !== null)
      inputs.push({ id: `a${i}`, text: stripHtmlForSeg(r.answer) });
    if (r.analysis !== null)
      inputs.push({ id: `n${i}`, text: stripHtmlForSeg(r.analysis) });
  });
  say(`侧车分词：${inputs.length} 条文本，一个进程`);
  const seg = await segmentTexts(inputs, { mode: "search" });
  const byId = new Map(seg.map((x) => [x.id, x.segmented]));

  // ── 挑出有变化的行（纪律⑤）──────────────────────────────────────────────
  const 变更表: 变更[] = [];
  for (const [i, r] of rows.entries()) {
    const 新stemPlain = byId.get(`s${i}`) ?? "";
    const 新answerSeg = byId.get(`a${i}`) ?? "";
    const 新analysisSeg = byId.get(`n${i}`) ?? "";
    const 变列: string[] = [];
    if (新stemPlain !== r.stemPlain) 变列.push("stem_plain");
    if (可检索状态.has(r.status)) {
      if (r.fts === null) 变列.push("fts(缺投影)");
      else {
        if (r.fts.stemPlain !== 新stemPlain) 变列.push("fts.stem_plain");
        if (r.fts.answer !== 新answerSeg) 变列.push("fts.answer");
        if (r.fts.analysis !== 新analysisSeg) 变列.push("fts.analysis");
      }
    }
    if (变列.length === 0) continue;
    变更表.push({
      row: r,
      新stemPlain,
      新answerSeg,
      新analysisSeg,
      变列,
      旧标记词: 命中标记词(r.stemPlain),
    });
  }

  say("");
  say(杠);
  say(`受影响行：${变更表.length} / ${rows.length}`);
  say(杠);
  for (const c of 变更表) {
    say("");
    say(`${c.row.id}  status=${c.row.status}  变：${c.变列.join(" / ")}`);
    say(
      `  正本 stem（不动）：${c.row.stem.slice(0, 150)}${c.row.stem.length > 150 ? "…" : ""}`,
    );
    say(`  旧 stem_plain：${c.row.stemPlain}`);
    say(`  新 stem_plain：${c.新stemPlain}`);
    say(
      `  剥掉的标记词：${c.旧标记词.join("、") || "（无——本行只是 FTS 投影没对齐）"}`,
    );
  }

  // ── 🔴 剥法安全性自证：正本一个字都没少（只是标签没了）────────────────────
  say("");
  say(杠);
  say("剥法安全自证（🔴 数学裸不等号绝不能被吃）");
  say(杠);
  const 裸不等号 = rows.filter(
    (r) =>
      /<(?![a-zA-Z/])/.test(r.stem) || /<(?![a-zA-Z/])/.test(r.analysis ?? ""),
  );
  say(
    `题面/解析里带**裸不等号 <**（后面不跟字母，不可能是标签）的行：${裸不等号.length}`,
  );
  let 吃字 = 0;
  for (const r of 裸不等号) {
    const 剥后 = stripHtmlForSeg(r.stem);
    // 数一数原文里的 `<` 与 `>`：剥标签只该拿走**成对属于标签**的那些。
    // 本行没有真标签时，剥前剥后的 `<`/`>` 个数必须一模一样。
    const 有真标签 = /<\/?[a-zA-Z][^<>]*>/.test(r.stem);
    const n0 = (r.stem.match(/[<>]/g) ?? []).length;
    const n1 = (剥后.match(/[<>]/g) ?? []).length;
    const ok = 有真标签 || n0 === n1;
    if (!ok) 吃字 += 1;
    say(
      `  ${ok ? "[PASS]" : "[FAIL]"} ${r.id}  真标签=${有真标签 ? "有" : "无"}  ` +
        `不等号 ${n0}→${n1}   ${r.stem.replace(/\n/g, "⏎").slice(0, 78)}`,
    );
  }
  say(`  结论：被吃掉不等号的行 ${吃字} —— 必须是 0`);

  // ── ⚠️ 挂账：match_key 的归一管线有一处已知缺陷（本卡不改，如实报）────────
  say("");
  say(杠);
  say("⚠️ 挂账（不改，等拍板）：normalizeStem 的宽松剥法会吃数学不等号");
  say(杠);
  const 宽松 = /<[^>]*>/g;
  const 严格 = /<\/?[a-zA-Z][^<>]*>/g;
  const 中招 = rows.filter(
    (r) => r.stem.replace(宽松, " ") !== r.stem.replace(严格, " "),
  );
  say(
    `  match_key 算在「被吃过字的题面」上的行：${中招.length} / ${rows.length}`,
  );
  for (const r of 中招) {
    say(`   · ${r.id}`);
    say(`     原文      ：${r.stem.replace(/\n/g, "⏎").slice(0, 96)}`);
    say(`     现归一结果：${normalizeStem(r.stem).slice(0, 96)}`);
  }
  say(
    "  后果：查重键失真（两道只在被吃那段上有区别的题会撞成同一道 ⇒ 假 DUPLICATE 红灯）。",
  );
  say(
    "  🔴 不在本卡改：换归一口径 = 全库 match_key 作废重算 + 撞键预检，属要拍板的动作。",
  );

  if (变更表.length === 0) {
    say("");
    say("没有需要改的行 —— 已经是新口径了（本脚本可重复跑）。");
  }

  if (!commit) {
    say("");
    say("干跑完毕（库零变化）。确认上面的逐行 diff 没问题后再跑：--commit");
    await closeCoreDb();
    process.exitCode = 吃字 === 0 ? 0 : 1;
    return;
  }

  // ── 真跑：一个事务写完所有变化行 ─────────────────────────────────────────
  if (变更表.length > 0) {
    say("");
    say(杠);
    say("🔴 真跑（--commit）");
    say(杠);

    const 理由: GateItem[] = [
      账目(
        `受影响 ${变更表.length} / ${rows.length} 行，逐行改前改后见 args.受影响行`,
      ),
      账目(
        "只动派生层：question.stem_plain + question_fts 三列；正本三列与 match_key 不动",
      ),
      账目(
        "分词口径：喂料先 stripHtmlForSeg（剥标签 + 解实体），写侧 mode='search'（与管道一致）",
      ),
      账目("同事务重写 FTS 投影（kb-ingest/v1 §6 纪律 1）"),
      账目(`根因：${根因}`),
      账目(`核查出处：${核查出处}`),
    ];

    const now = nowLocalISO();
    const receipt = await withCoreWrite(
      {
        actor: "human",
        tool: TOOL,
        args: {
          动作: "按修好的转换层（剥 HTML）全库重派生 stem_plain + FTS 投影",
          全库行数: rows.length,
          受影响行数: 变更表.length,
          根因,
          核查出处,
          受影响行: 变更表.map((c) => ({
            id: c.row.id,
            变列: c.变列,
            剥掉的标记词: c.旧标记词,
            改前: {
              stem_plain: c.row.stemPlain,
              fts_answer: c.row.fts?.answer ?? null,
              fts_analysis: c.row.fts?.analysis ?? null,
            },
            改后: {
              stem_plain: c.新stemPlain,
              fts_answer: c.新answerSeg,
              fts_analysis: c.新analysisSeg,
            },
          })),
        },
        gateReport: 造账("G-3 群卷路·检索投影去版面标记", 理由),
      },
      async (tx) => {
        const rowRefs: RowRef[] = [];
        for (const c of 变更表) {
          await tx
            .update(question)
            .set({ stemPlain: c.新stemPlain, updatedAt: now })
            .where(eq(question.id, c.row.id));
          if (可检索状态.has(c.row.status)) {
            await writeQuestionFts(tx, {
              questionId: c.row.id,
              stemPlain: c.新stemPlain,
              answerSeg: c.新answerSeg,
              analysisSeg: c.新analysisSeg,
            });
          }
          rowRefs.push({ table: "question", id: c.row.id, op: "update" });
        }
        return rowRefs;
      },
      h,
    );
    say(
      `  审计 seq=${receipt.seq}  ts=${receipt.ts}  rowRefs=${receipt.rowRefs.length}`,
    );
  }

  // ── 收尾复核 ───────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("收尾复核");
  say(杠);
  let 坏 = 吃字;
  const 后 = await 读全库(h);

  say("");
  say("① 全库 stem_plain 无版面标记词：");
  const 脏 = 后
    .map((r) => ({ id: r.id, hits: 命中标记词(r.stemPlain) }))
    .filter((x) => x.hits.length > 0);
  if (脏.length > 0) 坏 += 1;
  say(`  命中 ${脏.length} 行  ${脏.length === 0 ? "[PASS]" : "[FAIL]"}`);
  for (const x of 脏) say(`    🔴 ${x.id}  ${x.hits.join("、")}`);

  say("");
  say("② question_fts 三列同样干净：");
  const 脏f = 后
    .filter((r) => r.fts !== null)
    .map((r) => ({
      id: r.id,
      hits: [
        ...命中标记词(r.fts!.stemPlain),
        ...命中标记词(r.fts!.answer),
        ...命中标记词(r.fts!.analysis),
      ],
    }))
    .filter((x) => x.hits.length > 0);
  if (脏f.length > 0) 坏 += 1;
  say(`  命中 ${脏f.length} 行  ${脏f.length === 0 ? "[PASS]" : "[FAIL]"}`);
  for (const x of 脏f) say(`    🔴 ${x.id}  ${x.hits.join("、")}`);

  say("");
  say(
    "③ FTS 投影与正本对齐（question_fts.stem_plain ≡ question.stem_plain）：",
  );
  const 不齐 = 后.filter(
    (r) => 可检索状态.has(r.status) && r.fts?.stemPlain !== r.stemPlain,
  );
  if (不齐.length > 0) 坏 += 1;
  say(`  对不齐 ${不齐.length} 行  ${不齐.length === 0 ? "[PASS]" : "[FAIL]"}`);
  for (const r of 不齐) say(`    🔴 ${r.id}`);

  say("");
  say("④ 正本三列一个字未动（本次只该改派生层）：");
  const 动了 = 后.filter((r) => {
    const 原 = rows.find((x) => x.id === r.id);
    return (
      原 !== undefined &&
      (原.stem !== r.stem ||
        原.answer !== r.answer ||
        原.analysis !== r.analysis)
    );
  });
  if (动了.length > 0) 坏 += 1;
  say(
    `  被动过的正本行 ${动了.length}  ${动了.length === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  for (const r of 动了) say(`    🔴 ${r.id}`);

  say("");
  say("⑤ integrity_check 六项：");
  const rep = await integrityCheck({ handle: h });
  const reds = rep.checks.filter((c) => !c.ok && c.level === "red");
  for (const c of rep.checks) {
    const tag = c.ok ? "[PASS]" : c.level === "red" ? "[RED ]" : "[warn]";
    say(`  ${tag} ${c.id} ${c.name}`);
    if (!c.ok && c.level === "red")
      for (const d of c.details) say(`         ${d}`);
  }
  say(
    `  结论：red=${reds.length}  warn=${rep.checks.filter((c) => !c.ok && c.level === "warn").length}`,
  );

  await closeCoreDb();
  say("");
  say(细);
  say(
    坏 + reds.length === 0
      ? `结论：${变更表.length} 行重派生完毕，全库检索投影已无版面标记词，对账无 red。`
      : `结论：🔴 还有 ${坏 + reds.length} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 + reds.length === 0 ? 0 : 1;
}

void main();
