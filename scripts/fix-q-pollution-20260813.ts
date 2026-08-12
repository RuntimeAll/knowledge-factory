/**
 * scripts/fix-q-pollution-20260813.ts —— 🔴 **一次性数据污染修复**（AI:PRD-003 · 003-E3）
 *
 * 2026-08-13 跑过**一次**就退役。它修的是 G-3「回对原件」核查抓到的**真数据污染**：
 *
 *   备料抽取器 `_extract.py` 的切题护栏把 class 属性**全等**写死成 `<h2 class="spec"`，
 *   而《绝对值化简》专项卷第 2~5 个分节标题实际是 `<h2 class="spec brk">`（brk=分页）
 *   —— 正则不命中 ⇒ **下一节的标题整条落进上一题的尾巴**。
 *   于是 `q_index=3`（source_page_no=4）那道题的 stem 与 analysis 末尾，各多出 20 字：
 *
 *       "\n专项二 · 绝对值化简（二）数轴对称型"
 *
 *   这 20 字不是题面、不是解析，是**下一节的标题**。它跟着种子集 seq=59 一路灌进了库。
 *
 * 波及面（已逐一查证，见收卡报告）：
 *   · 该卷的段尾题 = q_index 3 / 7 / 11 / 15 都会中招（h2.spec.brk 紧跟在它们后面）；
 *   · 但备料只取了 [2, 3, 8, 12] 四道 ⇒ **库里只有 q_index=3 这一行被污染**；
 *   · 另一份专项卷（七上立方根估算与平方根双值）两个标题都是裸 `class="spec"`，旧护栏
 *     本来就命中 ⇒ 零波及。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/fix-q-pollution-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/fix-q-pollution-20260813.ts --commit   # 真跑
 * 退出码：0 = 复核 MATCH 且对账 red=0；1 = 复核对不上 / 有 red / 前置断言没过。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 六条纪律
 *
 * ① **只删末尾那 20 字，多一个字符都不动**。不 trim、不归一、不"顺手修排版"——
 *    删法是 `text.slice(0, -污染串.length)`，且**先断言 endsWith**：
 *    尾巴对不上就停手报账，绝不用正则去"大概匹配"。
 *    污染串以字面量写死在本文件里（见 污染串），diff 全文进收卡报告。
 *
 * ② **派生列必须跟着正本走**。题面变了却不重算派生 = 换一种污染：
 *      · `stem_plain`（= 分词后的检索投影正本列）里此刻躺着「专项 二 绝对值 化简 …」；
 *      · `match_key`（= 规范化题面 hash）算的是**带污染的**题面，查重从此对不上真题；
 *      · `question_fts` 三列同理。
 *    ⇒ 一次事务里四样一起改，一样都不许留在旧值上。
 *
 * ③ **同事务写 FTS 投影**（kb-ingest/v1 §6 纪律 1）。方案甲撤了 INSERT/UPDATE 触发器，
 *    改 stem/answer/analysis 的每条写路径都得自己调 `writeQuestionFts`，漏一次 =
 *    那题 FTS 永远查不到且不报错。分词口径与管道一致：**写侧 `mode:'search'`**。
 *
 * ④ **复核走真抽取逻辑，不在这儿抄一份**。修完从**源 HTML** 用**修好的** `_extract.py`
 *    （`--emit` 模式）重抽 q_index=3，再套上管道同款的 `stripLeadInstruction` +
 *    `cleanStemPrefix`，与库里读回来的值做**逐字节**比对（Buffer.equals，不是 ===）。
 *    自己写一份 TS 版 plain() 去比对 = 拿自己的答案对自己的答案，证不了任何事。
 *
 * ⑤ **一切经 core**（withCoreWrite）：开闸 → 业务写 → 审计行 → 关闸，同一事务。
 *    `tool='g3_fix_20260813'`，args 里写全**根因**与**核查出处**，rowRefs 如实上报。
 *
 * ⑥ **源文件只读**。`举一反三产物/` 一个字节都不碰；本脚本只写库里那一行。
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
const TOOL = "g3_fix_20260813";

/** 被污染的那一行（G-3 核查员定位；同批只有它一行中招） */
const QID = "q_01KZVF46KEXEA6F3229RQ8TXR4";

/**
 * 🔴 要删的污染串 —— **字面量写死**，20 个字符（含开头那个换行）。
 *    它是《绝对值化简》专项卷第二节的 `<h2 class="spec brk">` 标题，
 *    被坏掉的切题护栏当成了上一题的尾巴。
 */
const 污染串 = "\n专项二 · 绝对值化简（二）数轴对称型";

/** 备料抽取器（只读源 HTML；`--emit` 模式重抽一题供逐字节复核） */
const 抽取器 =
  "C:/Users/25606/AppData/Local/Temp/claude/d--workplace-ai-bkb/" +
  "10dedbaf-cfe0-4113-ae5f-e04875893b63/scratchpad/003-录题备料/_extract.py";

/** 重抽坐标：哪个专项卷的第几题（0based，= 库里 source_page_no - 1） */
const 重抽坐标 = { 专项: "绝对值化简", qIndex: 3 } as const;

/** 根因与核查出处（原样进 audit_log.args_digest 的入参正文 + gate_results_json） */
const 根因 =
  "备料抽取器 _extract.py 的切题护栏写死 '<h2 class=\"spec\"'（class 属性全等匹配），" +
  "而《绝对值化简》专项卷第 2~5 个分节标题实际是 '<h2 class=\"spec brk\">' ⇒ 正则不命中 ⇒ " +
  "下一节 h2 标题整条落进上一题的 stem 与 analysis 尾巴。已改成 '<h2[^>]*class=\"[^\"]*\\bspec\\b'（不依赖 class 全等）。";
const 核查出处 =
  "AI:PRD-003 · G-3「回对原件」核查（2026-08-13）：库内 " +
  QID +
  "（source_page_no=4 ⇒ q_index=3）的 stem 与 analysis 与源 HTML 首分歧点一致，" +
  "分歧后的内容 = 下一节 h2 标题；源 = 举一反三产物/专项卷/绝对值化简/_题目.html + _解析.html（只读）。";

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

// ---------------------------------------------------------------------------
// 重抽原件（🔴 走真抽取逻辑：调修好的 _extract.py --emit，不在 TS 里抄一份 plain()）
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
  新analysis: string | null;
  新stemPlainSeg: string;
  新answerSeg: string;
  新analysisSeg: string;
  新matchKey: string;
}

async function 修(h: CoreDbHandle, 旧: 题行, 计划: 修复计划): Promise<number> {
  const 理由 = [
    账目(
      `${QID} stem：删末尾 ${污染串.length} 字污染串（${旧.stem.length}→${计划.新stem.length}），其余一字未动`,
    ),
    账目(
      `${QID} analysis：删末尾 ${污染串.length} 字污染串（${(旧.analysis ?? "").length}→${(计划.新analysis ?? "").length}），其余一字未动`,
    ),
    账目(
      `${QID} stem_plain：题面变了，按写侧口径 mode='search' 重新分词（派生列必须跟着正本走）`,
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
        动作: "删 stem/analysis 末尾的下一节标题串（数据污染修复）",
        id: QID,
        污染串,
        污染串长度: 污染串.length,
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
          analysis: 计划.新analysis,
          stem_plain: 计划.新stemPlainSeg,
          match_key: 计划.新matchKey,
        },
      },
      gateReport: 造账("G-3 回对原件·数据污染修复", 理由),
    },
    async (tx) => {
      await tx
        .update(question)
        .set({
          stem: 计划.新stem,
          analysis: 计划.新analysis,
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
    `① 重抽原件逐字节比对（源 HTML → 修好的 _extract.py --emit ${重抽坐标.专项} ${重抽坐标.qIndex} → 套管道同款变换 → 对库）：`,
  );
  const 抽 = 重抽();
  // 管道里 question.stem = cleanStemPrefix(stripLeadInstruction(item.stem))，
  // analysis 则是原样落库 —— 复核必须走同一条变换链，不能拿生料直接比
  const ins = stripLeadInstruction(抽.stem);
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

  // ② 污染串必须在库里彻底绝迹（全表扫，不只这一行）
  say("");
  say("② 污染串全库绝迹扫描（question 三列 + question_fts 三列）：");
  // 正本三列是原文，按污染串原样扫全表
  const 特征 = "%绝对值化简（二）数轴对称型%";
  const 残 = await h.client.execute({
    sql: `SELECT COUNT(*) AS c FROM question
           WHERE stem LIKE ? OR answer LIKE ? OR analysis LIKE ?`,
    args: [特征, 特征, 特征],
  });
  const 残n = Number((残.rows[0] as unknown as { c: number }).c);
  // 🔴 stem_plain 与 question_fts 存的是**分词串**（污染串会被切成「专项 二 绝对值 …
  //    数 对称 轴对称 型」），原样 LIKE 一条都扫不到 —— 得按分词后仍连着的片段扫，
  //    且只扫这一行（别的题里出现「对称」是人家的正当题面）。
  const 特征f = "%对称%";
  const 残f = await h.client.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM question
              WHERE id = ? AND stem_plain LIKE ?) +
            (SELECT COUNT(*) FROM question_fts
              WHERE question_id = ? AND (stem_plain LIKE ? OR answer LIKE ? OR analysis LIKE ?))
            AS c`,
    args: [QID, 特征f, QID, 特征f, 特征f, 特征f],
  });
  const 残fn = Number((残f.rows[0] as unknown as { c: number }).c);
  if (残n > 0 || 残fn > 0) 坏 += 1;
  say(
    `  正本原文命中 ${残n} 行 / 本行分词投影命中 ${残fn} 处  ${残n === 0 && 残fn === 0 ? "[PASS]" : "[FAIL]"}`,
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
    say(`         fts.analysis　：${proj.analysis.slice(0, 90)}…`);
  }

  // ⑤ 对账六项
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

  return 坏 + reds.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");

  say(杠);
  say("AI:PRD-003 · 003-E3 数据污染修复（真库）");
  say(`  目标：${QID}`);
  say(`  删除：${显(污染串)}  （${污染串.length} 字）`);
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

  // ── 前置断言：尾巴必须真的是那 20 字（对不上就停手，绝不"大概匹配"）──────
  const stem脏 = 旧.stem.endsWith(污染串);
  const ana脏 = (旧.analysis ?? "").endsWith(污染串);
  say("");
  say("前置断言：");
  say(`  stem 尾巴 == 污染串     ${stem脏 ? "[YES]" : "[NO ]"}`);
  say(`  analysis 尾巴 == 污染串 ${ana脏 ? "[YES]" : "[NO ]"}`);

  if (!stem脏 && !ana脏) {
    say("");
    say("两列都不带污染串 —— 已经修过了（本脚本可重复跑）。直接走复核。");
    const 坏 = await 复核(h);
    await closeCoreDb();
    say("");
    say(坏 === 0 ? "结论：复核全绿。" : `结论：🔴 复核有 ${坏} 项没过。`);
    process.exitCode = 坏 === 0 ? 0 : 1;
    return;
  }
  if (!stem脏 || !ana脏) {
    say("");
    say(
      "🔴 只有一列带污染串 —— 与核查结论（两列都中招）不符，停手。" +
        "先搞清库被谁动过，别在半截状态上继续改。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── 造修复计划 ───────────────────────────────────────────────────────────
  const 新stem = 旧.stem.slice(0, -污染串.length);
  const 新analysis = (旧.analysis ?? "").slice(0, -污染串.length);

  // 分词：与管道同口径（写侧 mode='search'；answer 为 null 则投影落空串）
  const 分词入参 = [
    { id: "s", text: 新stem },
    ...(旧.answer !== null ? [{ id: "a", text: 旧.answer }] : []),
    { id: "n", text: 新analysis },
  ];
  const seg = await segmentTexts(分词入参, { mode: "search" });
  const byId = new Map(seg.map((r) => [r.id, r.segmented]));
  const 计划: 修复计划 = {
    新stem,
    新analysis,
    新stemPlainSeg: byId.get("s") ?? "",
    新answerSeg: byId.get("a") ?? "",
    新analysisSeg: byId.get("n") ?? "",
    新matchKey: matchKeyOf(新stem),
  };

  say("");
  say("改后全文（计划）：");
  say(细);
  say(`  stem      (${计划.新stem.length}字)  ${显(计划.新stem)}`);
  say(
    `  analysis  (${计划.新analysis?.length ?? 0}字)  ${显(计划.新analysis)}`,
  );
  say(`  stem_plain ${计划.新stemPlainSeg}`);
  say(`  match_key ${计划.新matchKey}`);
  say(`  fts.analysis ${计划.新analysisSeg.slice(0, 90)}…`);

  say("");
  say("逐列 delta（🔴 只许是「删末尾污染串」，别的都是事故）：");
  say(
    `  stem      ${旧.stem.length} → ${计划.新stem.length}  delta=${显(旧.stem.slice(计划.新stem.length))}  前缀相同=${旧.stem.startsWith(计划.新stem)}`,
  );
  say(
    `  analysis  ${(旧.analysis ?? "").length} → ${计划.新analysis?.length ?? 0}  delta=${显((旧.analysis ?? "").slice(计划.新analysis?.length ?? 0))}  前缀相同=${(旧.analysis ?? "").startsWith(计划.新analysis ?? "")}`,
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
    `  改了 ${n} 行（stem / analysis / stem_plain / match_key / updated_at + FTS 投影）`,
  );

  const 坏 = await 复核(h);
  await closeCoreDb();
  say("");
  say(
    坏 === 0
      ? "结论：污染已清，重抽原件逐字节 MATCH，对账无 red。"
      : `结论：🔴 还有 ${坏} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 === 0 ? 0 : 1;
}

void main();
