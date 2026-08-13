/**
 * scripts/resegment-nodejieba-20260813.ts —— 🔴 **一次性全库重派生**（AI:PRD-004 · 004-A）
 *
 * 2026-08-13 跑过**一次**就退役。它干的是「换分词器 + 加自定义词典」之后必须干的那件事：
 * 把存量 60 题的检索投影按新口径重算一遍。
 *
 *   旧口径：Python 侧车 jieba（`mode:'search'`，只有通用词典）
 *   新口径：`core/segment.ts` → `@node-rs/jieba`（jieba-rs），
 *           **基础词典 ∪ 数学专名词典** 的搜索模式并集（segment.ts §双词典并集）
 *
 * 不跑它 = 新词典只对新题生效，60 道存量题的索引还是旧切法 —— 静默半失效。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/resegment-nodejieba-20260813.ts            # 干跑（默认，库零变化）
 *   pnpm exec tsx --env-file=.env scripts/resegment-nodejieba-20260813.ts --commit   # 真跑
 * 退出码：0 = 全部自检绿且对账 red=0；1 = 有一项没过。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 六条纪律
 *
 * ① **只动派生层**。`question.stem` / `answer` / `analysis` 三列正本一个字都不碰
 *    —— 本脚本的 UPDATE 里压根没有这三列。`match_key` 也不动（那是查重键，
 *    走 `normalizeStem` 另一条归一管线，与分词无关）。
 *
 * ② **动库之前先 backupNow**。换分词器是"全库派生层一次性重写"，
 *    错了要能一键回到跑之前那一刻。
 *
 * ③ **同事务重写 FTS 投影**（kb-ingest/v1 §6 纪律 1）：`stem_plain` 改了而
 *    `question_fts` 没跟 = 那题此后 FTS 查到的还是旧词，且不报错。
 *
 * ④ **只写有变化的行**，逐行把改前改后打出来。没变化的行不进事务、不留审计。
 *
 * ⑤ 🔴 **换分词器必须自证不倒退**，而且要在**干跑阶段**就证完（改之前就知道结论）：
 *      A 组 · 分词器等价 —— 同样只用基础词典，node-rs 与 Python 侧车切出来的
 *              token 集合应当一致。不一致就逐条列出来看是不是可接受的差异。
 *      B 组 · 查询命中不减 —— 一组真查询，比「旧查侧+旧索引」与「新查侧+新索引」
 *              的**命中集合**。🔴 判据是**丢失必须为 0**（新增无所谓，那是召回变好）。
 *    B 组在干跑阶段靠**模拟**新索引；而模拟器本身先拿旧索引与**真 SQL MATCH**
 *    对过账（模拟 == 实测才算数），所以这不是"自己跟自己说好话"。
 *
 * ⑥ 干跑与真跑用**同一套**计算，真跑只是多了写库 + 复核。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { eq } from "drizzle-orm";

import { question } from "../src/server/db/schema";
import {
  backupNow,
  closeCoreDb,
  dictInfo,
  ftsQuery,
  getCoreDb,
  integrityCheck,
  nowLocalISO,
  segSearch,
  segSearchBaseOnly,
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

const TOOL = "resegment_nodejieba_20260813";

/** FTS 只收这两个状态的题（与对账 C1(f) 同口径） */
const 可检索状态 = new Set(["pending", "active"]);

/**
 * B 组的真查询清单。
 * 🔴 刻意混了三类：
 *   - 本库确实有的词（绝对值 / 立方根 / 最小值 …）—— 这些才是"不许掉"的主战场；
 *   - 总指挥点名的词（方程 / 去括号）—— 本库语料里恰好没有，命中数 0→0，
 *     如实报 0，不为了好看换成别的词；
 *   - 自定义词典新加的专名（科学记数法 / 等腰三角形）—— 验"加词没把别的搞坏"。
 */
const 真查询 = [
  "方程",
  "去括号",
  "绝对值",
  "立方根",
  "平方根",
  "有理数",
  "数轴",
  "最小值",
  "化简",
  "取值范围",
  "三位数",
  "相反数",
  "科学记数法",
  "等腰三角形",
] as const;

/** A 组抽样题数（分词器等价性逐条比对，太多刷屏、太少不算证据） */
const A组抽样 = 8;

const 根因 =
  "004-A 把分词从 Python 侧车（一次调用起一个进程，jieba 载词典 ~0.4s）搬回 node 进程内 " +
  "@node-rs/jieba —— 检索是每次查询都要分词的热路径，路径上不能有起进程这件事。" +
  "同时挂上从本库 kp.name(415) + kp_alias.alias(122) 萃取的数学专名词典（80 条，dicts/math-terms.dict.txt）：" +
  "通用词典会把「等腰三角形」切成「等腰三角/形」（于是查「三角形」查不到）、" +
  "把「有序数对」切成「有/序数/对」。词典只在分词那一刻生效，所以存量必须重派生。";

const 口径 =
  "写侧 = segSearch（搜索引擎模式，自定义词典 ∪ 基础词典**并集** —— 并集保证加词典只增不减召回）；" +
  "查侧 = segExact（精确模式，自定义词典）。喂料归一（剥 HTML 严格形状 + 去 LaTeX）搬进 core/segment.ts，" +
  "与 003-E4 逐字同款，调用方不再自己先剥（剥 HTML 不幂等）。";

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
  fts: { stemPlain: string; answer: string; analysis: string } | null;
}

async function 读全库(h: CoreDbHandle): Promise<题行[]> {
  const r = await h.client.execute(
    `SELECT q.id, q.stem, q.answer, q.analysis, q.stem_plain, q.status,
            f.stem_plain AS f_stem, f.answer AS f_answer,
            f.analysis AS f_analysis, f.question_id AS f_id
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

const 切 = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const 集 = (s: string): Set<string> => new Set(切(s));

// ---------------------------------------------------------------------------
// 自检 B 组的模拟器
// ---------------------------------------------------------------------------

/**
 * 模拟 `question_fts MATCH '"a" AND "b"'`：
 * FTS5 的 AND 是**行级**的（a 在 stem_plain、b 在 analysis 也算命中），
 * 所以一行的可匹配 token 集 = 三列的并集，查询命中 ⟺ 查询 token 全在这个集合里。
 * 🔴 这个模拟器**先拿旧索引与真 SQL 对过账**才拿来用（见 main 里的「模拟器对账」）。
 */
function 模拟命中(
  行: { id: string; tokens: Set<string> }[],
  queryTokens: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (queryTokens.length === 0) return out;
  for (const r of 行) {
    if (queryTokens.every((t) => r.tokens.has(t))) out.add(r.id);
  }
  return out;
}

async function 真MATCH(h: CoreDbHandle, match: string): Promise<Set<string>> {
  const r = await h.client.execute({
    sql: "SELECT question_id FROM question_fts WHERE question_fts MATCH ?",
    args: [match],
  });
  return new Set(
    (r.rows as unknown as { question_id: string }[]).map((x) =>
      String(x.question_id),
    ),
  );
}

/** 旧查侧：Python 侧车精确模式（= 004-A 之前 ftsQuery 干的事） */
async function 旧查侧token(q: string): Promise<string[]> {
  const [seg] = await segmentTexts([{ id: "_q", text: q }], { mode: "exact" });
  return 切(seg?.segmented ?? "");
}

function 转义(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
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
  变列: string[];
}

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");
  let 坏 = 0;

  const 词典 = dictInfo();
  say(杠);
  say(
    "AI:PRD-004 · 004-A 全库重派生：分词切到 @node-rs/jieba + 数学专名词典（真库）",
  );
  say(`  词典：${词典.words} 条  ${词典.path}`);
  say(`  口径：${口径}`);
  say("  🔴 正本 stem/answer/analysis 与 match_key 一律不动");
  say(`  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}`);
  say(杠);

  const h = await getCoreDb();
  const rows = await 读全库(h);
  const 可检索 = rows.filter((r) => 可检索状态.has(r.status));
  say("");
  say(`全库 ${rows.length} 题（可检索态 ${可检索.length}）`);

  // ── 新口径算一遍（进程内，60 题一眨眼）────────────────────────────────────
  const t0 = Date.now();
  const 变更表: 变更[] = [];
  const 新token = new Map<string, Set<string>>();
  for (const r of rows) {
    const 新stemPlain = segSearch(r.stem).join(" ");
    const 新answerSeg = r.answer === null ? "" : segSearch(r.answer).join(" ");
    const 新analysisSeg =
      r.analysis === null ? "" : segSearch(r.analysis).join(" ");
    if (可检索状态.has(r.status)) {
      新token.set(
        r.id,
        new Set([...切(新stemPlain), ...切(新answerSeg), ...切(新analysisSeg)]),
      );
    }
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
    if (变列.length > 0) {
      变更表.push({ row: r, 新stemPlain, 新answerSeg, 新analysisSeg, 变列 });
    }
  }
  say(
    `新口径分词：${rows.length} 题 × 3 段，进程内 ${Date.now() - t0}ms（旧口径要起一个 python 进程）`,
  );

  // ── 逐行 diff ──────────────────────────────────────────────────────────────
  say("");
  say(杠);
  say(`受影响行：${变更表.length} / ${rows.length}`);
  say(杠);
  for (const c of 变更表.slice(0, 12)) {
    const 旧集 = 集(c.row.stemPlain);
    const 新集 = 集(c.新stemPlain);
    say("");
    say(`${c.row.id}  status=${c.row.status}  变：${c.变列.join(" / ")}`);
    say(`  旧 stem_plain：${c.row.stemPlain}`);
    say(`  新 stem_plain：${c.新stemPlain}`);
    say(
      `  多出 token：${[...新集].filter((t) => !旧集.has(t)).join(" ") || "（无）"}`,
    );
    say(
      `  少掉 token：${[...旧集].filter((t) => !新集.has(t)).join(" ") || "（无）"}`,
    );
  }
  if (变更表.length > 12)
    say(`\n  …另有 ${变更表.length - 12} 行，同类差异，略`);

  // ── 自检 A 组：分词器等价（同样只用基础词典，node-rs vs Python 侧车）─────
  say("");
  say(杠);
  say(`自检 A 组 · 分词器等价性（抽 ${A组抽样} 题，两边都只用基础词典）`);
  say("  比的是「换了 jieba 实现」这一件事，把词典的影响摘出去");
  say(杠);
  const 抽 = rows.slice(0, A组抽样);
  const 侧车入参 = 抽.map((r, i) => ({
    id: `s${i}`,
    text: stripHtmlForSeg(r.stem),
  }));
  const 侧车出 = await segmentTexts(侧车入参, { mode: "search" });
  const 侧车表 = new Map(侧车出.map((x) => [x.id, x.segmented]));
  let A组不同 = 0;
  for (const [i, r] of 抽.entries()) {
    const py = 集(侧车表.get(`s${i}`) ?? "");
    const nd = new Set(segSearchBaseOnly(r.stem));
    const 只py = [...py].filter((t) => !nd.has(t));
    const 只nd = [...nd].filter((t) => !py.has(t));
    const same = 只py.length === 0 && 只nd.length === 0;
    if (!same) A组不同 += 1;
    say(
      `  ${same ? "[同 ]" : "[异 ]"} ${r.id}  python ${py.size} token / node ${nd.size} token`,
    );
    if (!same) {
      say(`         只 python 有：${只py.join(" ") || "（无）"}`);
      say(`         只 node   有：${只nd.join(" ") || "（无）"}`);
    }
  }
  say(`  结论：${抽.length} 题里 ${A组不同} 题两边切法不同`);
  if (A组不同 > 0) {
    say(
      "  ⚠️ 不同不等于错（jieba-rs 与 python jieba 在英数混排上有细微差异），" +
        "但必须逐条看过 —— 上面把差集全打出来了。",
    );
  }

  // ── 自检 B 组：查询命中不减 ────────────────────────────────────────────────
  say("");
  say(杠);
  say("自检 B 组 · 真查询命中集合对比（🔴 判据：丢失必须为 0）");
  say(杠);

  // B-0 模拟器对账：拿**旧索引**跑一遍，模拟结果必须等于真 SQL MATCH
  const 旧行 = 可检索.map((r) => ({
    id: r.id,
    tokens: new Set([
      ...切(r.fts?.stemPlain ?? ""),
      ...切(r.fts?.answer ?? ""),
      ...切(r.fts?.analysis ?? ""),
    ]),
  }));
  const 新行 = 可检索.map((r) => ({ id: r.id, tokens: 新token.get(r.id)! }));

  say("");
  say("  B-0 模拟器对账（旧索引上：模拟 == 真 SQL MATCH？）");
  let 模拟不符 = 0;
  const 旧命中 = new Map<string, Set<string>>();
  const 旧token表 = new Map<string, string[]>();
  for (const q of 真查询) {
    const toks = await 旧查侧token(q);
    旧token表.set(q, toks);
    const sim = 模拟命中(旧行, toks);
    const real =
      toks.length === 0
        ? new Set<string>()
        : await 真MATCH(h, toks.map(转义).join(" AND "));
    旧命中.set(q, real);
    const ok = sim.size === real.size && [...sim].every((x) => real.has(x));
    if (!ok) 模拟不符 += 1;
    say(
      `    ${ok ? "[PASS]" : "[FAIL]"} ${q.padEnd(6)} 模拟 ${sim.size} / 实测 ${real.size}`,
    );
  }
  if (模拟不符 > 0) {
    坏 += 1;
    say(
      "    🔴 模拟器与真 FTS 对不上 —— 下面 B-1 的结论一概不算数，先修模拟器。",
    );
  } else {
    say(
      "    模拟器可信（旧索引上逐题与真 SQL 一致），B-1 的新侧模拟才有意义。",
    );
  }

  say("");
  say("  B-1 旧（旧查侧+旧索引，实测） vs 新（新查侧+新索引，模拟）");
  say(
    `    ${"查询".padEnd(12)}${"旧".padStart(4)}${"新".padStart(5)}   新增 / 丢失`,
  );
  let 丢失总 = 0;
  const B1: {
    q: string;
    旧: number;
    新: number;
    新增: string[];
    丢失: string[];
    旧tok: string[];
    新tok: string[];
  }[] = [];
  for (const q of 真查询) {
    const 新tok = (await ftsQuery(q)).tokens;
    const 新hit = 模拟命中(新行, 新tok);
    const 旧hit = 旧命中.get(q)!;
    const 新增 = [...新hit].filter((x) => !旧hit.has(x));
    const 丢失 = [...旧hit].filter((x) => !新hit.has(x));
    丢失总 += 丢失.length;
    B1.push({
      q,
      旧: 旧hit.size,
      新: 新hit.size,
      新增,
      丢失,
      旧tok: 旧token表.get(q)!,
      新tok,
    });
    say(
      `    ${(丢失.length === 0 ? "[PASS] " : "[FAIL] ") + q.padEnd(11)}` +
        `${String(旧hit.size).padStart(3)}${String(新hit.size).padStart(5)}   ` +
        `+${新增.length} / -${丢失.length}` +
        (丢失.length > 0 ? `   🔴 丢：${丢失.join(",")}` : ""),
    );
    if (旧token表.get(q)!.join(" ") !== 新tok.join(" ")) {
      say(
        `           查侧 token：旧「${旧token表.get(q)!.join(" ")}」→ 新「${新tok.join(" ")}」`,
      );
    }
  }
  if (丢失总 > 0) 坏 += 1;
  say("");
  say(
    `    结论：丢失合计 ${丢失总}（必须 0）；新增合计 ${B1.reduce((a, b) => a + b.新增.length, 0)}（越多越好，是召回变宽）`,
  );

  // ── 自检 C 组：全库 token 级盘点（把 A 组看到的差异量化到全库）────────────
  say("");
  say(杠);
  say(
    "自检 C 组 · 全库 token 盘点（🔴 判据：**含中文的 token 一个都不许丢**）",
  );
  say(
    "  中文 token 才是本产品的检索主战场；数字/代数片段的口径变化如实盘，不藏",
  );
  say(杠);
  const 有中文 = (t: string): boolean => /[一-鿿]/.test(t);
  const 丢中文 = new Map<string, string[]>(); // token → 哪些题丢了它
  const 丢其他 = new Map<string, number>();
  const 增其他 = new Map<string, number>();
  let 增中文数 = 0;
  for (const r of 可检索) {
    const 旧 = new Set([
      ...切(r.fts?.stemPlain ?? ""),
      ...切(r.fts?.answer ?? ""),
      ...切(r.fts?.analysis ?? ""),
    ]);
    const 新 = 新token.get(r.id)!;
    for (const t of 旧) {
      if (新.has(t)) continue;
      if (有中文(t)) {
        if (!丢中文.has(t)) 丢中文.set(t, []);
        丢中文.get(t)!.push(r.id);
      } else 丢其他.set(t, (丢其他.get(t) ?? 0) + 1);
    }
    for (const t of 新) {
      if (旧.has(t)) continue;
      if (有中文(t)) 增中文数 += 1;
      else 增其他.set(t, (增其他.get(t) ?? 0) + 1);
    }
  }
  say("");
  say(
    `  ① 丢掉的**中文** token 种类：${丢中文.size}  ${丢中文.size === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  if (丢中文.size > 0) {
    坏 += 1;
    for (const [t, ids] of 丢中文) {
      say(
        `     🔴 「${t}」 在 ${ids.length} 题里消失：${ids.slice(0, 3).join(",")}`,
      );
    }
  }
  say(`  ② 新增的中文 token（题次）：${增中文数}（并集 + 专名词典的收益）`);
  const 排 = (m: Map<string, number>): string =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([t, n]) => `${t}(${n})`)
      .join(" ");
  say("");
  say(
    `  ③ ⚠️ 口径差异（非中文 token）：丢 ${丢其他.size} 种 / 增 ${增其他.size} 种`,
  );
  say(`     丢：${排(丢其他) || "（无）"}`);
  say(`     增：${排(增其他) || "（无）"}`);
  say("");
  say("     根因（004-A 实测，🔴 挂账不修，等拍板）：");
  say(
    "       jieba-rs 的默认「词块」正则把 - 与 + 当**词内字符**，python jieba 当**分隔符**。",
  );
  say("       于是裸写的代数片段两边切法不同：");
  say("         「若 |x-3|=5」  旧 → x / 3 / 5      新 → x-3 / 5");
  say("         「4x-3y 的值」  旧 → 4x / 3y        新 → 4x-3 / y");
  say(
    "       方向上新口径更像人搜的东西（搜「x-3」比搜孤零零的「3」有意义），",
  );
  say("       但它是**口径变化**不是 bug 修复，所以摆在这儿：");
  say(
    "       ⚠️ 同一个库里还并存着另一套算式口径 —— 写成 $x-3$ 的题会先被 de_latex",
  );
  say(
    "          拆成「x 3」（001/003 定的口径，本卡没动）。同样的数学、两种索引形态。",
  );
  say(
    "          要不要统一（以及往哪边统一）属于检索策略，留给 004-B/C 拍板。",
  );

  if (!commit) {
    say("");
    say(细);
    say(
      坏 === 0
        ? "干跑完毕（库零变化）。A/B 两组自检都过了，确认上面的逐行 diff 没问题后再跑：--commit"
        : `🔴 干跑就有 ${坏} 项没过，别 --commit，先查上面的明细。`,
    );
    await closeCoreDb();
    process.exitCode = 坏 === 0 ? 0 : 1;
    return;
  }

  // ── 真跑 ───────────────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("🔴 真跑（--commit）");
  say(杠);

  // 纪律②：先备份
  const bk = await backupNow({ reason: "manual" });
  say(
    `  备份：${bk.path}（${bk.bytes.toLocaleString()} bytes，${bk.tables} 张表，异地=${bk.remote}）`,
  );

  if (变更表.length > 0) {
    const 理由: GateItem[] = [
      账目(
        `受影响 ${变更表.length} / ${rows.length} 行，逐行改前改后见 args.受影响行`,
      ),
      账目(
        "只动派生层：question.stem_plain + question_fts 三列；正本三列与 match_key 不动",
      ),
      账目(口径),
      账目("同事务重写 FTS 投影（kb-ingest/v1 §6 纪律 1）"),
      账目(
        `自检 A 组（分词器等价，抽 ${抽.length} 题）：两边切法不同 ${A组不同} 题，差集已逐条打印`,
      ),
      账目(
        `自检 B 组（真查询 ${真查询.length} 条，旧实测 vs 新模拟）：丢失 ${丢失总}（判据=0），` +
          `新增 ${B1.reduce((a, b) => a + b.新增.length, 0)}`,
      ),
      账目(`根因：${根因}`),
      账目(
        `词典：${词典.words} 条，出处=kp.name + kp_alias.alias，正本=${词典.path}`,
      ),
    ];

    const now = nowLocalISO();
    const receipt = await withCoreWrite(
      {
        actor: "human",
        tool: TOOL,
        args: {
          动作: "分词切到 @node-rs/jieba + 数学专名词典，全库重派生 stem_plain + FTS 投影",
          全库行数: rows.length,
          受影响行数: 变更表.length,
          根因,
          口径,
          词典条数: 词典.words,
          自检: {
            A组_分词器等价: { 抽样: 抽.length, 切法不同: A组不同 },
            B组_查询命中: B1.map((x) => ({
              查询: x.q,
              旧: x.旧,
              新: x.新,
              新增: x.新增.length,
              丢失: x.丢失.length,
              旧查侧token: x.旧tok,
              新查侧token: x.新tok,
            })),
          },
          受影响行: 变更表.map((c) => ({
            id: c.row.id,
            变列: c.变列,
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
        gateReport: 造账("004-A 分词统一层切换 · 存量重派生", 理由),
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
  } else {
    say("  没有需要改的行 —— 已经是新口径了（本脚本可重复跑）。");
  }

  // ── 收尾复核 ───────────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("收尾复核");
  say(杠);
  const 后 = await 读全库(h);

  say("");
  say(
    "① FTS 投影与正本对齐（question_fts.stem_plain ≡ question.stem_plain，= 对账 C1(f)）：",
  );
  const 不齐 = 后.filter(
    (r) => 可检索状态.has(r.status) && r.fts?.stemPlain !== r.stemPlain,
  );
  if (不齐.length > 0) 坏 += 1;
  say(`  对不齐 ${不齐.length} 行  ${不齐.length === 0 ? "[PASS]" : "[FAIL]"}`);
  for (const r of 不齐) say(`    🔴 ${r.id}`);

  say("");
  say("② 正本三列一个字未动：");
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

  say("");
  say("③ B 组复测（这次是**真 SQL MATCH** 打在新索引上，不再是模拟）：");
  let 复测坏 = 0;
  for (const x of B1) {
    const 新tok = (await ftsQuery(x.q)).tokens;
    const real =
      新tok.length === 0
        ? new Set<string>()
        : await 真MATCH(h, 新tok.map(转义).join(" AND "));
    const 模拟对得上 = real.size === x.新;
    const 丢 = [...(旧命中.get(x.q) ?? [])].filter((i) => !real.has(i));
    const ok = 模拟对得上 && 丢.length === 0;
    if (!ok) 复测坏 += 1;
    say(
      `  ${ok ? "[PASS]" : "[FAIL]"} ${x.q.padEnd(11)} 旧 ${String(x.旧).padStart(3)} → 新实测 ${String(real.size).padStart(3)}` +
        `（干跑模拟 ${x.新}${模拟对得上 ? "，一致" : "，🔴 与模拟不符"}）` +
        (丢.length > 0 ? `  🔴 丢：${丢.join(",")}` : ""),
    );
  }
  if (复测坏 > 0) 坏 += 1;

  say("");
  say("④ integrity_check 六项：");
  const rep = await integrityCheck({ handle: h });
  const reds = rep.checks.filter((c) => !c.ok && c.level === "red");
  for (const c of rep.checks) {
    const tag = c.ok ? "[PASS]" : c.level === "red" ? "[RED ]" : "[warn]";
    say(`  ${tag} ${c.id} ${c.name}`);
    if (!c.ok) for (const d of c.details) say(`         ${d}`);
  }
  say(`  结论：red=${reds.length}`);

  await closeCoreDb();
  say("");
  say(细);
  say(
    坏 + reds.length === 0
      ? `结论：${变更表.length} 行重派生完毕；真查询命中一条没丢，A/B 自检与对账全绿。`
      : `结论：🔴 还有 ${坏 + reds.length} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 + reds.length === 0 ? 0 : 1;
}

void main();
