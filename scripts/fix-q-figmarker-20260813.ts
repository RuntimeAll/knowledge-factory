/**
 * scripts/fix-q-figmarker-20260813.ts —— 🔴 **一次性数据污染修复**（AI:PRD-003 · 003-E4）
 *
 * 2026-08-13 跑过**一次**就退役。E3 那份（`fix-q-pollution-20260813.ts`）修的是
 * 「切题护栏漏了 class ⇒ 下一节标题落进上一题尾巴」；本份修的是 G-3 专项路 P1
 * 抓到的**另一处**污染 —— 内部占位串留在了题面里：
 *
 *   `q_01KZVFBGNZZCZY86M9YXFRHHYS`（= 备料 seq=60，专项卷《绝对值化简》q_index=8）
 *   是「配图重投题」：它的图在源里是**内联 `<svg>`**，磁盘上没有图片文件，
 *   备料抽取器把图位转写成固定占位串 `［图·内联SVG］`（契约 §2.4）。
 *   003-E 的实证演练把那段 SVG 原样抽出来落成 .svg 配上 `figures` 重投 —— 图进来了，
 *   **可题面里那 9 个字没删**。闸⑥ 当时的判据是「声称有图 **且** figures 为空 ⇒ 红」，
 *   figures 给了就放行 ⇒ 占位串一路灌进库。
 *
 *   于是库里躺着：
 *     `…分别表示有理数 a，b，c。\n［图·内联SVG］(1) 填空：…`
 *                              ↑ 这 9 个字不是题面，是备料层的红旗；
 *                                而且它直接顶着 `(1)` —— 卷面上连个空隙都没有。
 *
 * 修法 = **只删这 9 个字**。删完题面正好等于「源件文本去掉 svg 元素后」的样子
 * （`…c。\n(1) 填空：…`），核查员指出的那处空白差异随之归一 —— 不需要另外补空格。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/fix-q-figmarker-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/fix-q-figmarker-20260813.ts --commit   # 真跑
 * 退出码：0 = 复核 MATCH 且对账 red=0；1 = 复核对不上 / 有 red / 前置断言没过。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 六条纪律（照抄 E3 那份，一条不减）
 *
 * ① **只删那 9 个字，多一个字符都不动**。不 trim、不补空格、不"顺手修排版"——
 *    删法是「按下标切两段拼起来」，且**先断言恰好出现一次**：
 *    出现 0 次或 2 次以上就停手报账，绝不用正则去"大概匹配"。
 *
 * ② **派生列必须跟着正本走**。题面变了却不重算派生 = 换一种污染：
 *      · `stem_plain` 里此刻躺着「图 内联 SVG」三个 token（搜「SVG」能搜出这道数学题）；
 *      · `match_key` 算的是**带占位串的**题面；
 *      · `question_fts` 三列同理。
 *    ⇒ 一次事务里四样一起改。
 *
 * ③ **同事务写 FTS 投影**（kb-ingest/v1 §6 纪律 1）。漏一次 = 那题 FTS 永远查不到且不报错。
 *    分词口径与管道一致：**写侧 `mode:'search'`**，且喂料先过 `stripHtmlForSeg`（003-E4）。
 *
 * ④ **复核走真抽取逻辑**。修完从**源 HTML** 用 `_extract.py --emit 绝对值化简 8` 重抽，
 *    按契约 §2.4 口径去掉占位串（图的信息由 `figures` 通道承载，占位串本就不该在题面里），
 *    再套管道同款的 `stripLeadInstruction` + `cleanStemPrefix`，与库里读回来的值做
 *    **逐字节**比对（Buffer.equals，不是 ===）。
 *    🔴 并且**另证一路**：emit 出来的原文与库内旧值必须逐字节全等 ——
 *    这条一过，就排除了「库里的值其实还有别的地方与源不同」的可能，
 *    「去掉占位串」才真的是唯一差异。
 *
 * ⑤ **一切经 core**（withCoreWrite）：开闸 → 业务写 → 审计行 → 关闸，同一事务。
 *    `tool='g3_fix2_20260813'`，args 里写全**根因**与**核查出处**，rowRefs 如实上报。
 *
 * ⑥ **源文件只读**。`举一反三产物/` 与备料存档一个字节都不碰；本脚本只写库里那一行。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";

import { question } from "../src/server/db/schema";
import {
  cleanStemPrefix,
  closeCoreDb,
  getCoreDb,
  integrityCheck,
  matchKeyOf,
  nowLocalISO,
  segmentTexts,
  stripHtmlForSeg,
  stripLeadInstruction,
  withCoreWrite,
  writeQuestionFts,
  type CoreDbHandle,
  type GateItem,
  type GateReport,
  type RowRef,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量（改这里之前先问：核查结论是不是也换了）
// ---------------------------------------------------------------------------

/** 审计里的工具名（一次性脚本也要留名，日后翻 audit_log 认得出是谁干的） */
const TOOL = "g3_fix2_20260813";

/** 被污染的那一行（G-3 专项路 P1 定位；全库只有它一行带占位串） */
const QID = "q_01KZVFBGNZZCZY86M9YXFRHHYS";

/**
 * 🔴 要删的占位串 —— **字面量写死**，9 个字符。
 *    全角方括号 + 「图」+ 间隔号 + 「内联SVG」+ 全角右方括号，见契约 §2.4。
 */
const 占位串 = "［图·内联SVG］";

/** 备料抽取器（只读源 HTML；`--emit` 模式重抽一题供逐字节复核） */
const 抽取器 =
  "C:/Users/25606/AppData/Local/Temp/claude/d--workplace-ai-bkb/" +
  "10dedbaf-cfe0-4113-ae5f-e04875893b63/scratchpad/003-录题备料/_extract.py";

/** 重抽坐标：哪个专项卷的第几题（0based，= 库里 source_page_no - 1） */
const 重抽坐标 = { 专项: "绝对值化简", qIndex: 8 } as const;

/** 根因与核查出处（原样进 audit_log.args_digest 的入参正文 + gate_results_json） */
const 根因 =
  "闸⑥ 占位红旗的判据原为「题面声称有图 **且** figures 为空 ⇒ 红」，" +
  "于是 003-E 的配图实证演练把内联 SVG 渲成 .svg、配上 figures 重投时闸放行了，" +
  "而题面里的内部占位串『" +
  占位串 +
  "』没有在喂料侧删掉 ⇒ 原样灌进库、会印到卷面上。" +
  "闸已改成「出现即红」（新码 STEM_INTERNAL_MARKER，与 figures 给没给无关），契约 §2.4 同步补第 4 条。";
const 核查出处 =
  "AI:PRD-003 · G-3「回对原件」核查（2026-08-13）专项路 P1：库内 " +
  QID +
  "（source_page_no=9 ⇒ q_index=8）的 stem 含 9 字内部占位串，" +
  "而源 HTML 此处是 <svg> 元素、不是文字；且占位串与后文 '(1)' 之间没有任何间隔。" +
  "源 = 举一反三产物/专项卷/绝对值化简/_题目.html（只读）。" +
  "目标口径（契约 §2.4）：库内 stem ≡ 源纯文本去掉 svg 元素后的样子，图的信息由 question_figure 承载。";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");
/** 打印用：把换行显式化，免得"尾巴多了个 \n"在终端里看不出来 */
const 显 = (s: string | null): string =>
  s === null ? "—" : s.replace(/\n/g, "⏎");

// ---------------------------------------------------------------------------
// 取料
// ---------------------------------------------------------------------------

interface 题行 {
  id: string;
  stem: string;
  answer: string | null;
  analysis: string | null;
  stemPlain: string | null;
  matchKey: string | null;
  qtype: string | null;
  status: string;
  sourcePageNo: number | null;
  updatedAt: string | null;
}

async function 读题(h: CoreDbHandle, id: string): Promise<题行 | null> {
  const r = await h.client.execute({
    sql: `SELECT id, stem, answer, analysis, stem_plain, match_key,
                 qtype, status, source_page_no, updated_at
            FROM question WHERE id = ?`,
    args: [id],
  });
  const row = r.rows[0] as unknown as Record<string, string | number | null>;
  if (!row) return null;
  return {
    id: String(row.id),
    stem: String(row.stem),
    answer: row.answer === null ? null : String(row.answer),
    analysis: row.analysis === null ? null : String(row.analysis),
    stemPlain: row.stem_plain === null ? null : String(row.stem_plain),
    matchKey: row.match_key === null ? null : String(row.match_key),
    qtype: row.qtype === null ? null : String(row.qtype),
    status: String(row.status),
    sourcePageNo:
      row.source_page_no === null ? null : Number(row.source_page_no),
    updatedAt: row.updated_at === null ? null : String(row.updated_at),
  };
}

/** 读回 question_fts 那一行（复核投影是不是真跟着改了） */
async function 读投影(
  h: CoreDbHandle,
  id: string,
): Promise<{ stemPlain: string; answer: string; analysis: string } | null> {
  const r = await h.client.execute({
    sql: `SELECT stem_plain, answer, analysis FROM question_fts WHERE question_id = ?`,
    args: [id],
  });
  const row = r.rows[0] as unknown as Record<string, string | null>;
  if (!row) return null;
  return {
    stemPlain: String(row.stem_plain ?? ""),
    answer: String(row.answer ?? ""),
    analysis: String(row.analysis ?? ""),
  };
}

/** 这道题挂了几张图（占位串该删的底气：图是真的进来了） */
async function 读配图(
  h: CoreDbHandle,
  id: string,
): Promise<{ role: string; path: string; bytes: number }[]> {
  const r = await h.client.execute({
    sql: `SELECT f.role AS role, a.path AS path, a.bytes AS bytes
            FROM question_figure f JOIN asset a ON a.id = f.asset_id
           WHERE f.question_id = ?`,
    args: [id],
  });
  return (
    r.rows as unknown as { role: string; path: string; bytes: number }[]
  ).map((x) => ({
    role: String(x.role),
    path: String(x.path),
    bytes: Number(x.bytes),
  }));
}

// ---------------------------------------------------------------------------
// 重抽原件（🔴 走真抽取逻辑：调 _extract.py --emit，不在 TS 里抄一份 plain()）
// ---------------------------------------------------------------------------

interface 重抽结果 {
  stem: string;
  analysis: string | null;
}

function 重抽(): 重抽结果 {
  const py = process.env.EXTRACT_PYTHON ?? "python";
  const out = execFileSync(
    py,
    [抽取器, "--emit", 重抽坐标.专项, String(重抽坐标.qIndex)],
    {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const line = out.split(/\r?\n/).find((l) => l.startsWith("__EMIT__"));
  if (!line) {
    throw new Error(
      `重抽失败：_extract.py --emit 没吐 __EMIT__ 行。原样输出：\n${out.slice(0, 800)}`,
    );
  }
  const j = JSON.parse(line.slice("__EMIT__".length)) as {
    stem: string;
    analysis: string | null;
  };
  return { stem: j.stem, analysis: j.analysis };
}

/** 逐字节比对（🔴 Buffer.equals，不是 ===：要的是字节级相等，不是"看起来一样"） */
function 字节相等(a: string, b: string): boolean {
  return Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"));
}

/** 首个字节分歧点（对不上时报出来，别只说一句"不等"） */
function 首分歧(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 出现次数（断言"恰好一次"用） */
function 数出现(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** 删掉唯一那一处（🔴 按下标切两段，不用 replace/正则） */
function 删唯一(hay: string, needle: string): string {
  const i = hay.indexOf(needle);
  return hay.slice(0, i) + hay.slice(i + needle.length);
}

// ---------------------------------------------------------------------------
// 账本（逐条理由进 audit_log.gate_results_json）
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
// 写
// ---------------------------------------------------------------------------

interface 修复计划 {
  新stem: string;
  新stemPlainSeg: string;
  新answerSeg: string;
  新analysisSeg: string;
  新matchKey: string;
}

async function 修(h: CoreDbHandle, 旧: 题行, 计划: 修复计划): Promise<number> {
  const 理由 = [
    账目(
      `${QID} stem：删掉唯一一处 ${占位串.length} 字内部占位串「${占位串}」（${旧.stem.length}→${计划.新stem.length}），其余一字未动`,
    ),
    账目(`${QID} analysis：不动（本行解析里没有占位串，已断言）——只改该改的列`),
    账目(
      `${QID} stem_plain：题面变了，按写侧口径 mode='search' 重新分词（喂料先过 stripHtmlForSeg）`,
    ),
    账目(
      `${QID} match_key：${旧.matchKey?.slice(0, 12)}…→${计划.新matchKey.slice(0, 12)}…（规范化题面 hash，题面变了必须跟）`,
    ),
    账目(
      `${QID} question_fts：同事务重写三段投影（kb-ingest/v1 §6 纪律 1，漏一次那题 FTS 永远查不到）`,
    ),
    账目(`根因：${根因}`),
    账目(`核查出处：${核查出处}`),
  ];

  const now = nowLocalISO();
  const receipt = await withCoreWrite(
    {
      actor: "human",
      tool: TOOL,
      args: {
        动作: "删 stem 里的内部占位串『［图·内联SVG］』（数据污染修复）",
        id: QID,
        占位串,
        占位串长度: 占位串.length,
        根因,
        核查出处,
        改前: {
          stem: 旧.stem,
          analysis: 旧.analysis,
          stem_plain: 旧.stemPlain,
          match_key: 旧.matchKey,
        },
        改后: {
          stem: 计划.新stem,
          analysis: 旧.analysis,
          stem_plain: 计划.新stemPlainSeg,
          match_key: 计划.新matchKey,
        },
      },
      gateReport: 造账("G-3 专项路 P1·内部占位串清除", 理由),
    },
    async (tx) => {
      await tx
        .update(question)
        .set({
          stem: 计划.新stem,
          stemPlain: 计划.新stemPlainSeg,
          matchKey: 计划.新matchKey,
          updatedAt: now,
        })
        .where(eq(question.id, QID));

      // 🔴 同事务重写检索投影（纪律③）
      await writeQuestionFts(tx, {
        questionId: QID,
        stemPlain: 计划.新stemPlainSeg,
        answerSeg: 计划.新answerSeg,
        analysisSeg: 计划.新analysisSeg,
      });

      return [{ table: "question", id: QID, op: "update" }] satisfies RowRef[];
    },
    h,
  );

  say(
    `  审计 seq=${receipt.seq}  ts=${receipt.ts}  rowRefs=${receipt.rowRefs.length}`,
  );
  return receipt.rowRefs.length;
}

// ---------------------------------------------------------------------------
// 收尾复核
// ---------------------------------------------------------------------------

async function 复核(h: CoreDbHandle): Promise<number> {
  say("");
  say(杠);
  say("收尾复核");
  say(杠);

  let 坏 = 0;

  // ① 🔴 重抽原件逐字节比对
  say("");
  say(
    `① 重抽原件逐字节比对（源 HTML → _extract.py --emit ${重抽坐标.专项} ${重抽坐标.qIndex} → ` +
      `按契约 §2.4 去占位串 → 套管道同款变换 → 对库）：`,
  );
  const 抽 = 重抽();
  // 🔴 emit 出来的**还带**占位串 —— 那是备料层注入的红旗（契约 §2.4），不是源文本。
  //    比对目标是「源纯文本」：图的信息由 question_figure 承载，题面里不留内部记号。
  const 抽净 =
    数出现(抽.stem, 占位串) === 1 ? 删唯一(抽.stem, 占位串) : 抽.stem;
  // 管道里 question.stem = cleanStemPrefix(stripLeadInstruction(item.stem))，
  // analysis 则是原样落库 —— 复核必须走同一条变换链，不能拿生料直接比
  const ins = stripLeadInstruction(抽净);
  const cl = cleanStemPrefix(ins.text.trim());
  const 期望stem = cl.text;
  const 期望analysis = 抽.analysis;

  const 现 = await 读题(h, QID);
  if (!现) {
    say(`  🔴 ${QID} 不在库里了`);
    return 坏 + 1;
  }
  for (const [名, 期望, 实际] of [
    ["stem", 期望stem, 现.stem],
    ["analysis", 期望analysis ?? "", 现.analysis ?? ""],
  ] as const) {
    const eq_ = 字节相等(期望, 实际);
    if (!eq_) 坏 += 1;
    say(
      `  [${eq_ ? "MATCH" : "DIFF "}] ${名.padEnd(8)} 源重抽 ${Buffer.byteLength(期望, "utf8")}B/${期望.length}字  ` +
        `库内 ${Buffer.byteLength(实际, "utf8")}B/${实际.length}字`,
    );
    if (!eq_) {
      const i = 首分歧(期望, 实际);
      say(`         🔴 首分歧 @${i}`);
      say(`         源重抽：${显(期望)}`);
      say(`         库内　：${显(实际)}`);
    }
  }
  if (ins.stripped.length > 0 || cl.stripped.length > 0) {
    say(
      `         （变换链剥离：${[...ins.stripped, ...cl.stripped].join(" | ") || "无"}）`,
    );
  }

  // ② 占位串必须在**全库正本**里彻底绝迹（不只这一行、不只 stem）
  say("");
  say("② 内部占位串全库绝迹扫描（question 三列正本）：");
  const 残 = await h.client.execute({
    sql: `SELECT COUNT(*) AS c FROM question
           WHERE stem LIKE '%［图%' OR answer LIKE '%［图%' OR analysis LIKE '%［图%'
              OR stem LIKE '%[图%'  OR answer LIKE '%[图%'  OR analysis LIKE '%[图%'`,
    args: [],
  });
  const 残n = Number((残.rows[0] as unknown as { c: number }).c);
  // 🔴 stem_plain 与 question_fts 存的是**分词串**（占位串会被切成「图 内联 SVG」），
  //    原样 LIKE 一条都扫不到 —— 得按分词后仍在的特征词扫。
  const 残f = await h.client.execute(
    `SELECT
       (SELECT COUNT(*) FROM question     WHERE stem_plain LIKE '%SVG%' OR stem_plain LIKE '%内联%') +
       (SELECT COUNT(*) FROM question_fts WHERE stem_plain LIKE '%SVG%' OR stem_plain LIKE '%内联%'
                                             OR answer     LIKE '%SVG%' OR analysis   LIKE '%SVG%')
       AS c`,
  );
  const 残fn = Number((残f.rows[0] as unknown as { c: number }).c);
  if (残n > 0 || 残fn > 0) 坏 += 1;
  say(
    `  正本原文命中 ${残n} 行 / 分词投影命中 ${残fn} 处  ${残n === 0 && 残fn === 0 ? "[PASS]" : "[FAIL]"}`,
  );

  // ③ match_key 与题面对得上
  say("");
  say("③ match_key 自洽（= matchKeyOf(库内 stem)）：");
  const 应有 = matchKeyOf(现.stem);
  const 自洽 = 应有 === 现.matchKey;
  if (!自洽) 坏 += 1;
  say(
    `  库内 ${现.matchKey?.slice(0, 16)}…  应为 ${应有.slice(0, 16)}…  ${自洽 ? "[PASS]" : "[FAIL]"}`,
  );

  // ④ FTS 投影与正本对得上
  say("");
  say("④ FTS 投影对齐（question_fts.stem_plain ≡ question.stem_plain）：");
  const proj = await 读投影(h, QID);
  const 投影齐 = proj !== null && proj.stemPlain === (现.stemPlain ?? "");
  if (!投影齐) 坏 += 1;
  say(`  ${投影齐 ? "[PASS]" : "[FAIL]"} 投影 ${proj ? "在" : "不在"}`);
  if (proj) {
    say(`         fts.stem_plain：${proj.stemPlain}`);
    say(`         q.stem_plain　：${现.stemPlain ?? ""}`);
  }

  // ⑤ 图还在（删占位串的底气 = 图的信息真的由 question_figure 承载着）
  say("");
  say("⑤ 图仍挂在 question_figure（占位串能删的前提）：");
  const figs = await 读配图(h, QID);
  if (figs.length === 0) 坏 += 1;
  say(`  ${figs.length > 0 ? "[PASS]" : "[FAIL]"} ${figs.length} 张`);
  for (const f of figs) say(`         role=${f.role} ${f.bytes}B ${f.path}`);

  // ⑥ 对账六项
  say("");
  say("⑥ integrity_check 六项：");
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

  return 坏 + reds.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");

  say(杠);
  say("AI:PRD-003 · 003-E4 内部占位串清除（真库）");
  say(`  目标：${QID}`);
  say(`  删除：${占位串}  （${占位串.length} 字）`);
  say(`  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}`);
  say(杠);

  const h = await getCoreDb();
  const 旧 = await 读题(h, QID);
  if (!旧) {
    say(`🔴 库里没有 ${QID} —— 停手（别在错的库上动手）`);
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  say("");
  say("改前全文：");
  say(细);
  say(
    `  status=${旧.status}  qtype=${旧.qtype ?? "—"}  source_page_no=${旧.sourcePageNo ?? "—"}`,
  );
  say(`  stem      (${旧.stem.length}字)  ${显(旧.stem)}`);
  say(`  answer    ${显(旧.answer)}`);
  say(`  analysis  (${(旧.analysis ?? "").length}字)  ${显(旧.analysis)}`);
  say(`  stem_plain ${显(旧.stemPlain)}`);
  say(`  match_key ${旧.matchKey ?? "—"}`);
  say(`  updated_at ${旧.updatedAt ?? "—"}`);
  const figs0 = await 读配图(h, QID);
  say(
    `  配图      ${figs0.length} 张：${figs0.map((f) => `${f.role}/${f.bytes}B`).join("、") || "无"}`,
  );

  // ── 前置断言 ─────────────────────────────────────────────────────────────
  const n占 = 数出现(旧.stem, 占位串);
  const n占A = 数出现(旧.analysis ?? "", 占位串);
  say("");
  say("前置断言：");
  say(`  stem 里占位串出现次数     ${n占}  ${n占 === 1 ? "[YES]" : "[NO ]"}`);
  say(`  analysis 里占位串出现次数 ${n占A}  ${n占A === 0 ? "[YES]" : "[NO ]"}`);
  say(
    `  图已挂在 question_figure   ${figs0.length} 张  ${figs0.length > 0 ? "[YES]" : "[NO ]"}`,
  );

  if (n占 === 0 && n占A === 0) {
    say("");
    say("两列都不带占位串 —— 已经修过了（本脚本可重复跑）。直接走复核。");
    const 坏 = await 复核(h);
    await closeCoreDb();
    say("");
    say(坏 === 0 ? "结论：复核全绿。" : `结论：🔴 复核有 ${坏} 项没过。`);
    process.exitCode = 坏 === 0 ? 0 : 1;
    return;
  }
  if (n占 !== 1 || n占A !== 0) {
    say("");
    say(
      "🔴 与核查结论（stem 恰一处、analysis 零处）不符，停手。" +
        "先搞清库被谁动过，别在半截状态上继续改。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  if (figs0.length === 0) {
    say("");
    say(
      "🔴 这道题一张图都没挂 —— 那删掉占位串就等于**把图的信息整个抹掉**（残题）。" +
        "本脚本只处理「图已挂、占位串没删」这一种；没图的题该走隔离区补图，不是在这儿删字。停手。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── 🔴 另证一路：库内旧值必须与源重抽逐字节全等 ───────────────────────────
  //    这条一过，「去掉占位串」才真的是库与源之间的唯一差异。
  say("");
  say("旁证（库内旧值 ≡ 源重抽原文，逐字节）：");
  const 抽0 = 重抽();
  const 旁证 = 字节相等(抽0.stem, 旧.stem);
  say(
    `  ${旁证 ? "[MATCH]" : "[DIFF ]"} 源重抽 ${Buffer.byteLength(抽0.stem, "utf8")}B  库内 ${Buffer.byteLength(旧.stem, "utf8")}B`,
  );
  if (!旁证) {
    say(`  🔴 首分歧 @${首分歧(抽0.stem, 旧.stem)}`);
    say(`     源重抽：${显(抽0.stem)}`);
    say(`     库内　：${显(旧.stem)}`);
    say(
      "  🔴 库内值与源重抽对不上 —— 那么「只差一个占位串」这个前提就不成立，停手去查。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── 造修复计划 ───────────────────────────────────────────────────────────
  const 新stem = 删唯一(旧.stem, 占位串);

  // 分词：与管道同口径（写侧 mode='search'，喂料先剥 HTML；answer 为 null 则投影落空串）
  const 分词入参 = [
    { id: "s", text: stripHtmlForSeg(新stem) },
    ...(旧.answer !== null
      ? [{ id: "a", text: stripHtmlForSeg(旧.answer) }]
      : []),
    ...(旧.analysis !== null
      ? [{ id: "n", text: stripHtmlForSeg(旧.analysis) }]
      : []),
  ];
  const seg = await segmentTexts(分词入参, { mode: "search" });
  const byId = new Map(seg.map((r) => [r.id, r.segmented]));
  const 计划: 修复计划 = {
    新stem,
    新stemPlainSeg: byId.get("s") ?? "",
    新answerSeg: byId.get("a") ?? "",
    新analysisSeg: byId.get("n") ?? "",
    新matchKey: matchKeyOf(新stem),
  };

  say("");
  say("改后全文（计划）：");
  say(细);
  say(`  stem      (${计划.新stem.length}字)  ${显(计划.新stem)}`);
  say(`  analysis  (不动)`);
  say(`  stem_plain ${计划.新stemPlainSeg}`);
  say(`  match_key ${计划.新matchKey}`);

  say("");
  say("逐列 delta（🔴 只许是「删掉那 9 个字」，别的都是事故）：");
  const i占 = 旧.stem.indexOf(占位串);
  say(
    `  stem      ${旧.stem.length} → ${计划.新stem.length}  delta=-${旧.stem.length - 计划.新stem.length} 字 @${i占}` +
      `  前段相同=${旧.stem.startsWith(计划.新stem.slice(0, i占))}` +
      `  后段相同=${旧.stem.endsWith(计划.新stem.slice(i占))}`,
  );
  say(`  删掉的是：${显(旧.stem.slice(i占, i占 + 占位串.length))}`);
  say(
    `  接缝处　：…${显(计划.新stem.slice(Math.max(0, i占 - 14), i占 + 14))}…`,
  );

  // ── 查重预检：新 match_key 不能撞库里别的可检索题（部分唯一索引会抛）────
  const 撞 = await h.client.execute({
    sql: `SELECT id FROM question
           WHERE match_key = ? AND id <> ? AND status IN ('pending','active')`,
    args: [计划.新matchKey, QID],
  });
  if (撞.rows.length > 0) {
    say("");
    say(
      `🔴 新 match_key 撞库（${(撞.rows as unknown as { id: string }[]).map((r) => r.id).join(",")}）—— ` +
        "说明干净题面在库里已另有一行，那是「同题两行」的问题，得人裁，不是本脚本改得了的。停手。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  say("  查重预检：新 match_key 不撞库 [PASS]");

  if (!commit) {
    say("");
    say("干跑完毕（库零变化）。确认 diff 没问题后再跑：--commit");
    await closeCoreDb();
    return;
  }

  say("");
  say(杠);
  say("🔴 真跑（--commit）");
  say(杠);
  const n = await 修(h, 旧, 计划);
  say(
    `  改了 ${n} 行（stem / stem_plain / match_key / updated_at + FTS 投影）`,
  );

  const 坏 = await 复核(h);
  await closeCoreDb();
  say("");
  say(
    坏 === 0
      ? "结论：占位串已清，重抽原件逐字节 MATCH，对账无 red。"
      : `结论：🔴 还有 ${坏} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 === 0 ? 0 : 1;
}

void main();
