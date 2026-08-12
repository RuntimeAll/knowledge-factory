/**
 * scripts/ingest-seed-20260813.ts —— 🔴 **一次性种子集入库脚本**（AI:PRD-003 · 003-E）
 *
 * 2026-08-13 跑过**一次**就退役：它把 003 备料包的 61 道**真题**（绝对值打卡册 day1-3 ×36 /
 * 群卷第01期第二天 ×15 / 存量精选专项卷 ×10）经 `runIngestBatch` 灌进空的 question 表。
 * **它不是常驻录题通路**——日后录题一律走 MCP `kb_ingest` / `propose_question`，
 * 或产线接入（005）。留在仓里只为两件事：① 首批题是怎么进来的，有据可查；
 * ② 万一要重来，有个可复现的起点。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/ingest-seed-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/ingest-seed-20260813.ts --commit   # 真跑
 *   pnpm exec tsx --env-file=.env scripts/ingest-seed-20260813.ts --src <备料目录>
 * 退出码：0=（干跑）账已打印 /（真跑）四批全落且对账无 red；1=幂等闸拒绝 / 对账有 red。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 五条纪律
 *
 * ① **数据保真，一字不改**（G-3）。题面 / 答案 / 解析原样进 payload，
 *    脚本只做**转换层**的事：字段改名、位置三元组归一、来源四型补全、考点名 → kp ref。
 *    干跑发现红灯，**只许**改转换层（考点措辞、prov 补全）；题目本身有问题就让它被拦下、
 *    进隔离区、如实报——绝不为了「全过」去动题。
 *
 * ② **幂等闸按批 source 判**，不按 question 表空判：本卡后面还有「四红灯实证」要往
 *    同一个库里投料，表非空是常态；重复的是**这四批**，所以闸就守这四个 source。
 *
 * ③ **先干跑后真跑**。干跑（dryRun）库与磁盘零变化，把 61 道题的逐题逐闸账全打出来；
 *    看完再决定要不要 --commit。
 *
 * ④ **一批一个语义单元**。kb-ingest/v1 一批只带一个 sourceDoc，而「存量精选 10 题」
 *    横跨两份专项卷 HTML —— 所以它**拆成两批**投（③A/③B），不是把两份文档
 *    硬塞进一个 title 里。批数因此是 4 不是 3，这一处偏离在收卡报告里注明。
 *
 * ⑤ **一切经 core**：四批各一次 runIngestBatch（actor='human' —— 首批入库是人拍板的
 *    一次性动作），tool='runIngestBatch'，账全落 ingest_batch.gate_report_json。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeCoreDb,
  getCoreDb,
  integrityCheck,
  matchKeyOf,
  runIngestBatch,
  type CoreDbHandle,
  type IngestResult,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量（改这里之前先问：备料包是不是也换了）
// ---------------------------------------------------------------------------

/** 003 备料包（只读）。搬走了就用 --src 指过去。 */
const 备料目录默认 =
  "C:/Users/25606/AppData/Local/Temp/claude/d--workplace-ai-bkb/" +
  "10dedbaf-cfe0-4113-ae5f-e04875893b63/scratchpad/003-录题备料";

/** 🔴 幂等闸就守这四个 source（见文件头纪律②） */
const 批次源 = {
  册子: "绝对值压轴打卡册-day1-3@ingest-seed-20260813",
  群卷: "群卷第01期第二天·正式流程首录@ingest-seed-20260813",
  立方根: "存量精选·七上立方根估算与平方根双值@ingest-seed-20260813",
  绝对值化简: "存量精选·绝对值化简@ingest-seed-20260813",
} as const;

/** 册子的产线引用（来源清单 §2 给的准确路径） */
const 册子PIPELINE =
  "绝对值压轴打卡DSL@2026-08（源=举一反三产物/打卡/七上绝对值压轴突破/_源/punch_days.json）";

/** 群卷三线的产线引用前缀（每题按自己那条线拼准确路径） */
const 群卷PIPELINE前缀 = "群打卡产线DSL@第01期·第二天（源=";

/** 「第二天」→ 2：punchPos.day 是正整数，源里是中文序数 */
const 中文天 = new Map([
  ["第一天", 1],
  ["第二天", 2],
  ["第三天", 3],
  ["第四天", 4],
  ["第五天", 5],
  ["第六天", 6],
  ["第七天", 7],
]);

// ---------------------------------------------------------------------------
// 备料形状（只声明本脚本真用到的字段；多余字段一律不碰）
// ---------------------------------------------------------------------------

interface 种子源 {
  kind: string;
  path: string;
  book?: string;
  day?: number | string;
  module?: string;
  no_in_day?: number;
  line?: string;
  batch?: string;
  no?: number;
  special?: string;
  级?: string;
  q_index_0based?: number;
  解析path?: string;
}

interface 种子题 {
  seq: number;
  stem: string;
  answer: string | null;
  analysis: string | null;
  source: 种子源;
  kp_pred: string[];
  qtype: string;
  has_figure: boolean;
}

function 读种子(srcDir: string): 种子题[] {
  const p = join(srcDir, "种子集.json");
  const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${p} 不是数组`);
  const out = raw as 种子题[];
  for (const it of out) {
    if (typeof it.seq !== "number" || typeof it.stem !== "string") {
      throw new Error(
        `种子集里有形状不对的条目：${JSON.stringify(it).slice(0, 120)}`,
      );
    }
    if (!Array.isArray(it.kp_pred) || it.kp_pred.length === 0) {
      throw new Error(`seq=${it.seq} 没有 kp_pred —— 考点是硬闸，备料就该带`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 转换层：种子题 → kb-ingest/v1 题（🔴 只改形状，不改内容）
// ---------------------------------------------------------------------------

function 考点(it: 种子题): { ref: string }[] {
  // 备料的 kp_pred 是 002 概念层的**考点名**；闸③ 只认 1.0 精确命中，
  // 名字对不上会红灯并给候选 —— 那正是我们要在干跑里看到的东西。
  return it.kp_pred.map((name) => ({ ref: name }));
}

function 册子题(it: 种子题): Record<string, unknown> {
  const s = it.source;
  return {
    seq: it.seq,
    stem: it.stem,
    answer: it.answer,
    analysis: it.analysis,
    qtype: it.qtype,
    kps: 考点(it),
    tags: [
      `册:${s.book ?? "绝对值突破·十天打卡"}`,
      `模块:${s.module ?? "未标"}`,
    ],
    prov: { type: "pipeline", pipelineRef: 册子PIPELINE },
    punchPos: {
      day: Number(s.day ?? 1),
      section: s.module ?? "未标",
      seq: Number(s.no_in_day ?? it.seq),
    },
  };
}

function 群卷题(it: 种子题): Record<string, unknown> {
  const s = it.source;
  const day = 中文天.get(String(s.day)) ?? 1;
  return {
    seq: it.seq,
    stem: it.stem,
    answer: it.answer,
    analysis: it.analysis,
    qtype: it.qtype,
    kps: 考点(it),
    tags: [
      `群卷:${s.batch ?? "第01期"}·${String(s.day)}`,
      `线:${s.line ?? "未标"}`,
    ],
    prov: {
      type: "pipeline",
      pipelineRef: `${群卷PIPELINE前缀}${s.path.replace(/\\/g, "/")}）`,
    },
    punchPos: {
      day,
      section: `${s.batch ?? "第01期"}·${s.line ?? "未标"}`,
      seq: Number(s.no ?? it.seq),
    },
  };
}

/**
 * 专项卷题（prov=scan）。
 *
 * 🔴 `page` 放的是**源生成器里的题序**（q_index_0based + 1），不是纸页码 ——
 *    源是 HTML，压根没有页。这一处口径写进 sourceDoc.note，别让后人以为库里那个
 *    source_page_no 是翻得到的页码。
 * 🔴 `figures` **不给**：seq 60/61 的图是生成器内联 SVG，磁盘上没有独立图片文件
 *    （备料 §5 R4 已查证）。找不到真图就不给图 —— 绝不为了让它过闸而造一张。
 *    代价是这两题会被闸⑥「说了如图却没给图」拦进隔离区，那是闸在正常工作。
 */
function 专项题(it: 种子题): Record<string, unknown> {
  const s = it.source;
  return {
    seq: it.seq,
    stem: it.stem,
    answer: it.answer,
    analysis: it.analysis,
    qtype: it.qtype,
    kps: 考点(it),
    tags: [`专项:${s.special ?? "未标"}`, `级:${s.级 ?? "未标"}`],
    prov: { type: "scan", page: Number(s.q_index_0based ?? 0) + 1 },
  };
}

// ---------------------------------------------------------------------------
// 四批
// ---------------------------------------------------------------------------

interface 批 {
  名: string;
  payload: Record<string, unknown>;
  说明: string;
}

function 造四批(seeds: 种子题[]): 批[] {
  const 册 = seeds.filter((x) => x.source.kind === "册子");
  const 群 = seeds.filter((x) => x.source.kind === "群卷");
  const 专 = seeds.filter((x) => x.source.kind === "专项卷");
  const 立方根 = 专.filter(
    (x) => x.source.special === "七上立方根估算与平方根双值",
  );
  const 化简 = 专.filter((x) => x.source.special === "绝对值化简");

  return [
    {
      名: "①册子·绝对值压轴打卡 day1-3",
      说明: `${册.length} 题 · prov=pipeline · 带 punchPos`,
      payload: {
        contract: "kb-ingest/v1",
        source: 批次源.册子,
        items: 册.map(册子题),
      },
    },
    {
      名: "②群卷·第01期第二天（验收 3-4 现实切换批）",
      说明: `${群.length} 题 · prov=pipeline · 三线各 5 题`,
      payload: {
        contract: "kb-ingest/v1",
        source: 批次源.群卷,
        items: 群.map(群卷题),
      },
    },
    {
      名: "③A 存量精选·七上立方根估算与平方根双值",
      说明: `${立方根.length} 题 · prov=scan · answer=null + analysis`,
      payload: {
        contract: "kb-ingest/v1",
        source: 批次源.立方根,
        sourceDoc: {
          title: "七上立方根估算与平方根双值（专项卷）",
          kind: "试卷",
          path: 立方根[0]?.source.path.replace(/\\/g, "/"),
          note:
            "源=Python 生成器 gen_lifang.py 的渲染产物 _题目.html/_解析.html（HTML 无页码）；" +
            "题级 page 位放的是生成器里的题序 q_index+1，不是纸页码。",
        },
        items: 立方根.map(专项题),
      },
    },
    {
      名: "③B 存量精选·绝对值化简",
      说明: `${化简.length} 题 · prov=scan · 含 2 题「如图」但源图是内联 SVG`,
      payload: {
        contract: "kb-ingest/v1",
        source: 批次源.绝对值化简,
        sourceDoc: {
          title: "绝对值化简（专项卷）",
          kind: "试卷",
          path: 化简[0]?.source.path.replace(/\\/g, "/"),
          note:
            "源=Python 生成器 gen_绝对值化简.py 的渲染产物 _题目.html/_解析.html（HTML 无页码）；" +
            "题级 page 位放的是生成器里的题序 q_index+1。图为内联 SVG，磁盘无独立图片文件。",
        },
        items: 化简.map(专项题),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");

function 打逐题账(r: IngestResult, 名: string): void {
  say(`${细}`);
  say(
    `${名}  counts=${JSON.stringify(r.counts)}${r.dryRun ? "  [dryRun]" : ""}`,
  );
  say(`${细}`);
  for (const it of r.gateReport.items) {
    const 标 =
      it.verdict === "accepted"
        ? it.reviewRequired
          ? "[需审]"
          : "[过]"
        : "[拒]";
    const 尾 =
      it.verdict === "accepted"
        ? `grade=${it.solutionGrade}` +
          (it.calcVerdict ? ` calc=${it.calcVerdict}` : "") +
          (it.lineVerdict ? ` line=${it.lineVerdict}` : "")
        : `${it.failure?.code}: ${it.failure?.message.slice(0, 160)}`;
    say(`  ${标} seq=${String(it.seq).padStart(2)} ${尾}`);
    if (it.stripped.length > 0)
      say(`         剥离：${it.stripped.join(" | ")}`);
    for (const n of it.notes) say(`         note：${n.slice(0, 180)}`);
  }
}

/** 干跑阶段的跨批查重（四批各自 dryRun，库里还没有行，撞车只有脚本自己看得见） */
function 跨批查重(批次: 批[]): void {
  const 见过 = new Map<string, string>();
  const 撞: string[] = [];
  for (const b of 批次) {
    for (const it of b.payload.items as { seq: number; stem: string }[]) {
      const k = matchKeyOf(it.stem);
      const 前 = 见过.get(k);
      if (前) 撞.push(`${前}  ⟷  ${b.名} seq=${it.seq}`);
      else 见过.set(k, `${b.名} seq=${it.seq}`);
    }
  }
  say("");
  say(
    "跨批查重（真跑是**逐批顺序**投的，第二批起会撞库；干跑时库是空的，所以在这儿先算一遍）：",
  );
  if (撞.length === 0) say("  61 题的 match_key 两两不撞。");
  else for (const line of 撞) say(`  🔴 ${line}`);
}

// ---------------------------------------------------------------------------
// 收尾核对（真跑后）
// ---------------------------------------------------------------------------

async function 收尾核对(h: CoreDbHandle): Promise<number> {
  say("");
  say(杠);
  say("收尾核对");
  say(杠);

  // ① 对账六项
  const rep = await integrityCheck({ handle: h });
  const reds = rep.checks.filter((c) => !c.ok && c.level === "red");
  say("");
  say("① integrity_check 六项：");
  for (const c of rep.checks) {
    const tag = c.ok ? "[PASS]" : c.level === "red" ? "[RED ]" : "[warn]";
    say(`  ${tag} ${c.id} ${c.name}`);
    for (const d of c.details) say(`         ${d}`);
  }
  say(
    `  结论：red=${reds.length}  warn=${rep.checks.filter((c) => !c.ok && c.level === "warn").length}`,
  );

  /** 小查询帮手：值一律转成串（打印用；要数就再 Number() 一次） */
  const q = async (sql: string): Promise<Record<string, string>[]> => {
    const r = await h.client.execute(sql);
    // libsql 的标量列只会是 string | number | bigint | null | Uint8Array，
    // 这里的查询全是 COUNT / 文本列，逐个转串即可
    const rows = r.rows as unknown as Record<
      string,
      string | number | bigint | null
    >[];
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, v === null ? "" : String(v)]),
      ),
    );
  };

  // ② provenance 抽查
  say("");
  say(
    "② provenance 抽查（scan 题必须有 source_doc + page；pipeline 题必须有 pipeline_ref）：",
  );
  for (const row of await q(
    `SELECT prov_type,
            COUNT(*) AS n,
            SUM(CASE WHEN source_doc_id IS NOT NULL THEN 1 ELSE 0 END) AS 有源文档,
            SUM(CASE WHEN source_page_no IS NOT NULL THEN 1 ELSE 0 END) AS 有页,
            SUM(CASE WHEN pipeline_ref IS NOT NULL THEN 1 ELSE 0 END) AS 有产线引用
       FROM question GROUP BY prov_type ORDER BY prov_type`,
  )) {
    say(
      `  ${String(row.prov_type).padEnd(9)} n=${row.n}  source_doc=${row.有源文档}  page=${row.有页}  pipeline_ref=${row.有产线引用}`,
    );
  }
  say("  —— scan 抽 3 行 ——");
  for (const row of await q(
    `SELECT q.id, q.source_page_no AS page, d.title, d.kind, substr(q.stem,1,28) AS stem
       FROM question q LEFT JOIN source_doc d ON d.id = q.source_doc_id
      WHERE q.prov_type='scan' ORDER BY q.id LIMIT 3`,
  )) {
    say(
      `  ${row.id}  page=${row.page}  doc=${row.title}(${row.kind})  「${row.stem}…」`,
    );
  }
  say("  —— pipeline 抽 3 行 ——");
  for (const row of await q(
    `SELECT id, substr(pipeline_ref,1,64) AS ref, substr(stem,1,26) AS stem
       FROM question WHERE prov_type='pipeline' ORDER BY id LIMIT 3`,
  )) {
    say(`  ${row.id}  ref=${row.ref}…  「${row.stem}…」`);
  }
  const 缺 = await q(
    `SELECT COUNT(*) AS n FROM question
      WHERE (prov_type='scan'     AND (source_doc_id IS NULL OR source_page_no IS NULL))
         OR (prov_type='pipeline' AND pipeline_ref IS NULL)`,
  );
  say(`  🔴 provenance 缺件行数（应为 0）：${缺[0]?.n}`);

  // ③ solution_grade 分布
  say("");
  say("③ solution_grade 分布：");
  for (const row of await q(
    `SELECT solution_grade, COUNT(*) AS n FROM question GROUP BY solution_grade ORDER BY n DESC`,
  )) {
    say(`  ${String(row.solution_grade).padEnd(15)} ${row.n}`);
  }

  // ④ 计算题的实算率
  say("");
  say(
    "④ 计算题 calc_verified 率（qtype='计算' 里判到 calc_verified 的比例）：",
  );
  for (const row of await q(
    `SELECT qtype,
            COUNT(*) AS n,
            SUM(CASE WHEN solution_grade='calc_verified' THEN 1 ELSE 0 END) AS 实算过
       FROM question GROUP BY qtype ORDER BY n DESC`,
  )) {
    const n = Number(row.n);
    const v = Number(row.实算过);
    say(
      `  ${String(row.qtype).padEnd(6)} n=${String(n).padStart(3)}  calc_verified=${String(v).padStart(3)}  ${n > 0 ? Math.round((v / n) * 100) : 0}%`,
    );
  }

  // ⑤ 总账
  say("");
  say("⑤ 总账：");
  for (const t of [
    "question",
    "question_kp",
    "question_tag",
    "question_fts",
    "question_figure",
    "asset",
    "source_doc",
    "ingest_batch",
    "quarantine",
    "review_queue",
  ]) {
    const r = await q(`SELECT COUNT(*) AS n FROM ${t}`);
    say(`  ${t.padEnd(16)} ${r[0]?.n}`);
  }
  say("  —— 隔离区（本次被闸拦下的题，如实留着）——");
  for (const row of await q(
    `SELECT id, substr(why,1,110) AS why FROM quarantine ORDER BY id`,
  )) {
    say(`  ${row.id}  ${row.why}`);
  }

  return reds.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes("--commit");
  const i = argv.indexOf("--src");
  const srcDir = i >= 0 ? (argv[i + 1] ?? 备料目录默认) : 备料目录默认;

  say(杠);
  say("AI:PRD-003 · 003-E 种子集入库（真库）");
  say(`  备料：${srcDir}`);
  say(
    `  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库与磁盘零变化）"}`,
  );
  say(杠);

  const seeds = 读种子(srcDir);
  const 批次 = 造四批(seeds);
  say("");
  say(`种子集 ${seeds.length} 题 → ${批次.length} 批：`);
  for (const b of 批次) say(`  ${b.名}：${b.说明}`);
  跨批查重(批次);

  const h = await getCoreDb();

  // ── 幂等闸（按批 source）────────────────────────────────────────────────
  const 已有 = await h.client.execute({
    sql: `SELECT source, COUNT(*) AS n FROM ingest_batch WHERE source IN (?,?,?,?) GROUP BY source`,
    args: Object.values(批次源),
  });
  if (已有.rows.length > 0) {
    say("");
    say(
      "🔴 幂等闸：这几批已经跑过了，拒绝重跑（重复灌会造出两套 id 的同一道题）：",
    );
    for (const r of 已有.rows as unknown as { source: string; n: number }[]) {
      say(`  ${r.source}  已有 ${r.n} 批`);
    }
    say("  要重来：先把那几个批次连同它们的题一起清掉，再跑本脚本。");
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── 相一：四批各干跑一次 ────────────────────────────────────────────────
  say("");
  say(杠);
  say("干跑（dryRun）—— 库与磁盘零变化，先把 61 道题的账全看一遍");
  say(杠);
  for (const b of 批次) {
    const r = await runIngestBatch(b.payload, {
      actor: "human",
      handle: h,
      dryRun: true,
    });
    打逐题账(r, `${b.名}（${b.说明}）`);
  }

  if (!commit) {
    say("");
    say("干跑完毕。确认账没问题后再跑：--commit");
    await closeCoreDb();
    return;
  }

  // ── 相二：真跑 ─────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("🔴 真跑（--commit）");
  say(杠);
  for (const b of 批次) {
    const r = await runIngestBatch(b.payload, { actor: "human", handle: h });
    打逐题账(r, `${b.名}（${b.说明}）`);
    say(`  batchId=${r.batchId}`);
    say(
      `  questionIds(${r.questionIds.length})=${r.questionIds.join(",") || "—"}`,
    );
    say(`  queueIds(${r.queueIds.length})=${r.queueIds.join(",") || "—"}`);
    say(
      `  quarantineIds(${r.quarantineIds.length})=${r.quarantineIds.join(",") || "—"}`,
    );
    say(`  backup=${r.backup?.path ?? "—"}`);
  }

  const reds = await 收尾核对(h);
  await closeCoreDb();
  say("");
  say(
    reds === 0
      ? "结论：种子集入库完成，对账无 red。"
      : `结论：🔴 对账有 ${reds} 项 red，去查上面的明细。`,
  );
  process.exitCode = reds === 0 ? 0 : 1;
}

void main();
