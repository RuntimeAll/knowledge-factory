/**
 * scripts/ingest-drill-20260813.ts —— 🔴 **一次性实证脚本**（AI:PRD-003 · 003-E）
 *
 * 2026-08-13 跑过**一次**就退役。它在**真库**上证两件事（验收 3-2 / 3-3）：
 *
 *   ① 四红灯实证：四份坏料各投一个小批，**全部被拒、零落库**，隔离区留下四行；
 *   ② 配图审链实测：把种子集里因「说了如图却没给图」被拦下的 seq=60 从隔离区捞出来，
 *      配上**源文档里那张真图**重投 → 开图审工单 → 人审通过 → 摘掉必审。
 *
 * 用法（分相跑，中间要去页面看红旗条上的 amber 徽章）：
 *   pnpm exec tsx --env-file=.env scripts/ingest-drill-20260813.ts --phase redlight
 *   pnpm exec tsx --env-file=.env scripts/ingest-drill-20260813.ts --phase figure-ingest
 *   pnpm exec tsx --env-file=.env scripts/ingest-drill-20260813.ts --phase figure-pass
 * 退出码：0=该相全部如期；1=有一处不如期（哪一处见输出）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 四条纪律
 *
 * ① **坏料由真题改造，每份注明改造自哪一道**。凭空编的坏料只能证明「闸认得出我编的错」，
 *    证不了「闸认得出产线真会犯的错」。
 *
 * ② **①②④ 号坏料取自源文件里【未入库】的邻题**（打卡册 day4），不取种子集那 61 道 ——
 *    那 61 道已经在库里了，拿它们做坏料会顺带撞查重闸，一份坏料同时亮两盏红灯，
 *    就分不清是哪道闸拦下的。③ 号坏料反过来：它**就是要**撞查重，所以用已入库的原题。
 *
 * ③ **图是从源文档里抽出来的，不是画的**。seq=60 那张数轴图在生成器渲染产物
 *    `_题目.html` 里是内联 SVG（备料 §5 R4 已查证：磁盘上没有独立图片文件）。
 *    本脚本把那段 `<svg>…</svg>` **原样**抽出来落成 .svg 文件，只补一个 standalone SVG
 *    必需的 `xmlns` 属性（内联在 HTML 里时浏览器隐式补，独立文件必须显式写）——
 *    图形一个点都没动，并且落盘前会拿备料里的同一段做**逐字节比对**。
 *
 * ④ **全程经 core**：坏料走 runIngestBatch，改判重投走 resolveQuarantine，
 *    图审走 passFigureReview —— 一笔写都不绕过审计。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeCoreDb,
  getCoreDb,
  getFigureReviewCard,
  getQuarantineRow,
  IngestError,
  listQuarantine,
  passFigureReview,
  resolveQuarantine,
  runIngestBatch,
  type CoreDbHandle,
  type IngestResult,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

const 备料目录 =
  "C:/Users/25606/AppData/Local/Temp/claude/d--workplace-ai-bkb/" +
  "10dedbaf-cfe0-4113-ae5f-e04875893b63/scratchpad/003-录题备料";

/** 打卡册 DSL 正本（只读）——①②④ 号坏料的真题来源 */
const 打卡DSL =
  "D:/workplace/ai-bkb/举一反三产物/打卡/七上绝对值压轴突破/_源/punch_days.json";

/** 绝对值化简专项卷的渲染产物（只读）——seq=60 那张数轴图的**源文档** */
const 化简题目HTML =
  "D:/workplace/ai-bkb/举一反三产物/专项卷/绝对值化简/_题目.html";

/** 抽出来的真图落在哪（内容最终按 hash 进 data/assets/，这里只是过路） */
const 图落地目录 = join(tmpdir(), "kf-drill-20260813");

const 审图人 = "fable-acceptance";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");

// ---------------------------------------------------------------------------
// 真题来源（读，不改）
// ---------------------------------------------------------------------------

interface 打卡题 {
  q: string;
  a: string;
}

/** 打卡册 day-N 的第 i 道题（1 起，按模块顺序连号）——与备料 §2 的 no_in_day 同一口径 */
function 打卡真题(
  day: number,
  noInDay: number,
): { q: string; a: string; 模块: string } {
  const d = JSON.parse(readFileSync(打卡DSL, "utf8")) as {
    days: { day: number; modules: { title: string; items: 打卡题[] }[] }[];
  };
  const 天 = d.days.find((x) => x.day === day);
  if (!天) throw new Error(`${打卡DSL} 里没有 day=${day}`);
  let n = 0;
  for (const m of 天.modules) {
    for (const it of m.items) {
      n += 1;
      if (n === noInDay) return { q: it.q, a: it.a, 模块: m.title };
    }
  }
  throw new Error(`day=${day} 没有第 ${noInDay} 题`);
}

/** 种子集里的一条（做 ③ 号重复料 / 找 seq=60 的原样 payload 用） */
function 种子(seq: number): Record<string, unknown> {
  const arr = JSON.parse(
    readFileSync(join(备料目录, "种子集.json"), "utf8"),
  ) as Record<string, unknown>[];
  const it = arr.find((x) => x.seq === seq);
  if (!it) throw new Error(`备料里没有 seq=${seq}`);
  return it;
}

// ---------------------------------------------------------------------------
// 相一：四红灯
// ---------------------------------------------------------------------------

function 打账(r: IngestResult, 名: string): void {
  say(细);
  say(`${名}`);
  say(细);
  say(`  counts=${JSON.stringify(r.counts)}`);
  say(`  batchId=${r.batchId}`);
  say(`  questionIds=${r.questionIds.join(",") || "（空 —— 零落库）"}`);
  say(`  quarantineIds=${r.quarantineIds.join(",") || "—"}`);
  for (const it of r.gateReport.items) {
    say(`  逐闸账（seq=${it.seq}）：`);
    for (const g of it.gates.items) {
      if (g.result.ok) {
        say(`    [过] ${g.name}  ${g.ms}ms`);
      } else {
        say(`    [红] ${g.name}  ${g.ms}ms  code=${g.result.code}`);
        say(`         ${g.result.message}`);
        if (g.result.candidates?.length) {
          for (const c of g.result.candidates.slice(0, 5)) {
            say(
              `         候选：${c.id ?? "—"}  ${c.label}${c.score !== undefined ? `  (${c.score})` : ""}`,
            );
          }
        }
      }
    }
    say(`  firstFailure=${it.failure?.code ?? "—"}`);
  }
}

async function 相_四红灯(h: CoreDbHandle): Promise<number> {
  say(杠);
  say("相一 · 四红灯实证（真库，四个小批各 1 题，期望：全部被拒、零落库）");
  say(杠);

  const 前 = Number(
    (
      (await h.client.execute("SELECT COUNT(*) AS n FROM question"))
        .rows[0] as unknown as {
        n: number;
      }
    ).n,
  );
  say(`  投料前 question 行数 = ${前}`);

  const d4q1 = 打卡真题(4, 1);
  const d4q3 = 打卡真题(4, 3);
  const s1 = 种子(1);
  let 不如期 = 0;

  const 期望 = async (
    名: string,
    payload: Record<string, unknown>,
    code: string,
  ): Promise<void> => {
    const r = await runIngestBatch(payload, { actor: "human", handle: h });
    打账(r, 名);
    const 实 = r.gateReport.items[0]?.failure?.code;
    const ok =
      r.counts.rejected === 1 && r.counts.accepted === 0 && 实 === code;
    say(
      `  判定：期望 ${code} / 实得 ${实 ?? "—"} → ${ok ? "如期" : "🔴 不如期"}`,
    );
    if (!ok) 不如期 += 1;
    say("");
  };

  // ── ⓪ 附加：kps=[] 走不到逐题闸，契约层**整批拒**（连隔离行都不该有）────────
  say(细);
  say("⓪ 附加实证 · 缺考点（kps=[]）：契约层整批拒，连批行都不落");
  say("   改造自：打卡册 day4 第1题（真题，未入库）—— 把 kps 清空");
  say(细);
  const 前批 = Number(
    (
      (await h.client.execute("SELECT COUNT(*) AS n FROM ingest_batch"))
        .rows[0] as unknown as {
        n: number;
      }
    ).n,
  );
  try {
    await runIngestBatch(
      {
        contract: "kb-ingest/v1",
        source: "drill-20260813@缺考点",
        items: [
          {
            seq: 1,
            stem: d4q1.q,
            answer: d4q1.a,
            qtype: "填空",
            kps: [],
            prov: { type: "manual", createdBy: 审图人 },
          },
        ],
      },
      { actor: "human", handle: h },
    );
    say("  🔴 不如期：契约层竟然放行了");
    不如期 += 1;
  } catch (e) {
    if (e instanceof IngestError) {
      say(`  [红] 闸① 契约  code=${e.code}`);
      say(`       ${e.message}`);
    } else {
      say(`  🔴 不如期：抛的不是 IngestError：${String(e)}`);
      不如期 += 1;
    }
  }
  const 后批 = Number(
    (
      (await h.client.execute("SELECT COUNT(*) AS n FROM ingest_batch"))
        .rows[0] as unknown as {
        n: number;
      }
    ).n,
  );
  say(`  ingest_batch 行数 ${前批} → ${后批}（应相等：契约错连批行都不开）`);
  if (前批 !== 后批) 不如期 += 1;
  say("");

  // ── ① 假考点名 → KP_NOT_FOUND ────────────────────────────────────────────
  await 期望(
    "① 坏料 · 考点名是编的（改造自：打卡册 day4 第1题「若 |x|=|-7|，则 x=________。」，真题未入库；只把考点名换成编的）",
    {
      contract: "kb-ingest/v1",
      source: "drill-20260813@假考点名",
      items: [
        {
          seq: 1,
          stem: d4q1.q,
          answer: d4q1.a,
          qtype: "填空",
          kps: [{ ref: "绝对值宇宙无敌考点" }],
          prov: { type: "manual", createdBy: 审图人 },
        },
      ],
    },
    "KP_NOT_FOUND",
  );

  // ── ② 题面带指令词/元词 → STEM_HAS_META_WORD ──────────────────────────────
  await 期望(
    "② 坏料 · 题面里塞了元词「变式」（改造自：种子集 seq=1「若 |x-3|=5，则 x=________。」，题面前面加「变式 1：」）",
    {
      contract: "kb-ingest/v1",
      source: "drill-20260813@指令词",
      items: [
        {
          seq: 1,
          stem: `变式 1：${String(s1.stem)}`,
          answer: String(s1.answer),
          qtype: "填空",
          kps: [{ ref: "已知绝对值求原数" }],
          prov: { type: "manual", createdBy: 审图人 },
        },
      ],
    },
    "STEM_HAS_META_WORD",
  );

  // ── ③ 原样重投已入库的题 → DUPLICATE（带已存在 id）────────────────────────
  await 期望(
    "③ 坏料 · 重复题（改造自：种子集 seq=1，一个字没改，原样再投一次）",
    {
      contract: "kb-ingest/v1",
      source: "drill-20260813@重复题",
      items: [
        {
          seq: 1,
          stem: String(s1.stem),
          answer: String(s1.answer),
          qtype: "填空",
          kps: [{ ref: "已知绝对值求原数" }],
          prov: { type: "manual", createdBy: 审图人 },
        },
      ],
    },
    "DUPLICATE",
  );

  // ── ④ 编造 kp_id → KP_ID_NOT_FOUND ──────────────────────────────────────
  await 期望(
    "④ 坏料 · kp_id 是编的（改造自：打卡册 day4 第3题「当 x=______ 时，|x+5|+4 有最小值…」，真题未入库）",
    {
      contract: "kb-ingest/v1",
      source: "drill-20260813@编造kpid",
      items: [
        {
          seq: 1,
          stem: d4q3.q,
          answer: d4q3.a,
          qtype: "填空",
          kps: [{ ref: "kp_01FAKEFAKEFAKEFAKEFAKEFAKE" }],
          prov: { type: "manual", createdBy: 审图人 },
        },
      ],
    },
    "KP_ID_NOT_FOUND",
  );

  const 后 = Number(
    (
      (await h.client.execute("SELECT COUNT(*) AS n FROM question"))
        .rows[0] as unknown as {
        n: number;
      }
    ).n,
  );
  say(细);
  say(
    `零落库核对：question 行数 ${前} → ${后}  ${前 === 后 ? "（相等 —— 四份坏料一道都没进库）" : "🔴 有题进库了！"}`,
  );
  if (前 !== 后) 不如期 += 1;

  say("");
  say("隔离区现状（open）：");
  for (const q of await listQuarantine({ handle: h, limit: 50 })) {
    say(`  ${q.id}  batch=${q.batchId}  ${q.why.split("\n")[0]?.slice(0, 96)}`);
  }
  return 不如期;
}

// ---------------------------------------------------------------------------
// 相二：配图审链
// ---------------------------------------------------------------------------

/**
 * 从**源文档**里抽出 seq=60 那张数轴图，落成一份独立 .svg。
 * 🔴 只补 xmlns，别的一个字符不动；落盘前拿备料里的同一段做逐字节比对。
 */
function 抽真图(): { path: string; bytes: number; 说明: string } {
  const 备 = 种子(60);
  const raw = typeof 备.stem_raw_html === "string" ? 备.stem_raw_html : "";
  const m = /<svg[\s\S]*?<\/svg>/.exec(raw);
  if (!m) throw new Error("备料 seq=60 的 stem_raw_html 里没有 <svg>");
  const svg = m[0];

  const 源 = readFileSync(化简题目HTML, "utf8");
  if (!源.includes(svg)) {
    throw new Error(
      "🔴 备料里的 <svg> 与源文档 _题目.html 对不上（逐字节比对失败）——" +
        "这时候绝不能拿备料的副本当真图用，先去查两边为什么不一致。",
    );
  }

  const 独立 = svg.startsWith("<svg xmlns=")
    ? svg
    : svg.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  mkdirSync(图落地目录, { recursive: true });
  const p = join(图落地目录, "seq60-数轴ABC.svg");
  writeFileSync(p, 独立, "utf8");
  return {
    path: p,
    bytes: Buffer.byteLength(独立, "utf8"),
    说明:
      `原样抽自 ${化简题目HTML} 的内联 <svg>（与备料 stem_raw_html 逐字节相同，已核）；` +
      `只补了 standalone SVG 必需的 xmlns 属性，图形未动。`,
  };
}

/** 找 seq=60 那条隔离行（按 payload 里的 seq 认，不靠人抄 id） */
async function 找隔离行(h: CoreDbHandle, seq: number) {
  for (const q of await listQuarantine({
    handle: h,
    state: "all",
    limit: 200,
  })) {
    try {
      const p = JSON.parse(q.payloadJson) as { seq?: number; stem?: string };
      if (p.seq === seq && String(p.stem ?? "").includes("如图")) return q;
    } catch {
      /* 脏行跳过 */
    }
  }
  return null;
}

async function 相_配图入库(h: CoreDbHandle): Promise<number> {
  say(杠);
  say("相二·A 配图审链 —— 从隔离区把 seq=60 捞出来，配上源文档里的真图重投");
  say(杠);

  const 图 = 抽真图();
  say(`  真图：${图.path}（${图.bytes} 字节）`);
  say(`  来历：${图.说明}`);

  const 行 = await 找隔离行(h, 60);
  if (!行) {
    say("  🔴 隔离区里找不到 seq=60 —— 先跑 ingest-seed-20260813.ts --commit");
    return 1;
  }
  if (行.resolvedAt) {
    say(`  🔴 ${行.id} 已经在 ${行.resolvedAt} 结过了，本相不重复跑`);
    return 1;
  }
  say(`  隔离行：${行.id}`);
  say(`  why：${行.why}`);

  const 原料 = JSON.parse(行.payloadJson) as Record<string, unknown>;
  const 新料 = { ...原料, figures: [{ role: "stem", path: 图.path }] };
  say("");
  say("  改判重投（🔴 只加 figures 一个字段，题面/答案/解析一字未改）：");

  const r = await resolveQuarantine(行.id, {
    action: "reingest",
    editedPayload: 新料,
    by: 审图人,
    note: "图是源文档 _题目.html 里的内联 SVG，已原样抽成独立文件补上",
    handle: h,
  });

  say(
    `  resolved=${r.resolved}  questionId=${r.questionId}  batchId=${r.batchId}`,
  );
  say(
    `  precheck: ok=${r.precheck?.ok} reviewRequired=${r.precheck?.reviewRequired} grade=${r.precheck?.solutionGrade}`,
  );
  if (!r.resolved || !r.questionId) {
    say("  🔴 重投没成 —— 新红灯：");
    for (const red of r.precheck?.reds ?? [])
      say(`     ${red.gate} ${red.code}: ${red.message}`);
    return 1;
  }

  const 结后 = await getQuarantineRow(行.id, { handle: h });
  say(`  隔离行已结：resolvedAt=${结后?.resolvedAt}`);
  say(`  处置痕迹：${结后?.why.split("【处置】")[1]?.trim()}`);

  const 工单 = (
    await h.client.execute({
      sql: `SELECT id, kind, ref_type, ref_id, state, reason FROM review_queue WHERE ref_id = ?`,
      args: [r.questionId],
    })
  ).rows as unknown as Record<string, string>[];
  say("");
  say("  图审工单：");
  for (const w of 工单) {
    say(
      `    ${w.id}  kind=${w.kind}  ref=${w.ref_type}/${w.ref_id}  state=${w.state}`,
    );
    say(`    reason：${w.reason}`);
  }

  const q = (
    await h.client.execute({
      sql: `SELECT review_required, status, solution_grade FROM question WHERE id = ?`,
      args: [r.questionId],
    })
  ).rows[0] as unknown as Record<string, string | number>;
  say(
    `  题：review_required=${q.review_required}  status=${q.status}  grade=${q.solution_grade}`,
  );

  const a = (
    await h.client.execute(
      `SELECT a.id, a.hash, a.path, a.kind, a.bytes, f.role, f.review_state
         FROM asset a JOIN question_figure f ON f.asset_id = a.id`,
    )
  ).rows as unknown as Record<string, string | number>[];
  say("  资产（内容寻址）：");
  for (const x of a) {
    say(
      `    ${x.id}  ${x.path}  kind=${x.kind} bytes=${x.bytes} role=${x.role} review_state=${x.review_state}`,
    );
    const 落地 = join(process.cwd(), "data", "assets", String(x.path));
    say(`    落地文件在不在：${existsSync(落地) ? "在" : "🔴 不在"}  ${落地}`);
  }

  const 待办 = (
    await h.client.execute(
      `SELECT kind, COUNT(*) AS n FROM review_queue WHERE state='open' GROUP BY kind`,
    )
  ).rows as unknown as Record<string, string | number>[];
  const 隔 = (
    await h.client.execute(
      `SELECT COUNT(*) AS n FROM quarantine WHERE resolved_at IS NULL`,
    )
  ).rows[0] as unknown as { n: number };
  say("");
  say(
    `  红旗条 amber 徽章此刻应显示：工单 open ${待办.reduce((s, x) => s + Number(x.n), 0) + Number(隔.n)}` +
      `：${待办.map((x) => `${x.kind}${x.n}`).join(" · ")}${Number(隔.n) > 0 ? ` · 隔离${隔.n}` : ""}`,
  );
  say(`  工单 id = ${工单[0]?.id}（下一相 --phase figure-pass 要用它）`);
  return 工单.length === 1 && Number(q.review_required) === 1 ? 0 : 1;
}

async function 相_配图过审(h: CoreDbHandle): Promise<number> {
  say(杠);
  say("相二·B 配图审链 —— 人审通过，摘掉必审");
  say(杠);

  const 工单 = (
    await h.client.execute(
      `SELECT id, ref_id FROM review_queue WHERE kind='图片' AND state='open' ORDER BY id LIMIT 1`,
    )
  ).rows[0] as unknown as { id: string; ref_id: string } | undefined;
  if (!工单) {
    say("  🔴 没有 open 的图审工单 —— 先跑 --phase figure-ingest");
    return 1;
  }

  const 卡 = await getFigureReviewCard(工单.id, { handle: h });
  say(`  工单 ${卡.item.id}  kind=${卡.item.kind}  state=${卡.item.state}`);
  say(
    `  题 ${卡.question?.id}  review_required=${卡.question?.reviewRequired}`,
  );
  say(`  题面：${卡.question?.stem.replace(/\n/g, " ⏎ ").slice(0, 120)}`);
  for (const f of 卡.figures) {
    say(`  图 ${f.id}  role=${f.role}  state=${f.reviewState}  hash=${f.hash}`);
    say(`     页面取图路径：/api/asset/${f.hash}`);
  }

  const r = await passFigureReview(工单.id, {
    by: 审图人,
    note: "数轴上 A、B、C 三点与题面 a、b、c 一一对得上，图就是这道题的图",
    handle: h,
  });
  say("");
  say(
    `  passFigureReview：verdict=${r.verdict} questionId=${r.questionId} 动了 ${r.figureIds.length} 张图 reviewRequired=${r.reviewRequired} 审计 seq=${r.seq}`,
  );

  const q = (
    await h.client.execute({
      sql: `SELECT review_required FROM question WHERE id = ?`,
      args: [r.questionId],
    })
  ).rows[0] as unknown as { review_required: number };
  const w = (
    await h.client.execute({
      sql: `SELECT state, verdict_by, verdict_note, verdict_at FROM review_queue WHERE id = ?`,
      args: [工单.id],
    })
  ).rows[0] as unknown as Record<string, string>;
  const f = (
    await h.client.execute({
      sql: `SELECT review_state FROM question_figure WHERE question_id = ?`,
      args: [r.questionId],
    })
  ).rows[0] as unknown as { review_state: string };

  say(`  题 review_required=${q.review_required}（应为 0）`);
  say(`  图 review_state=${f.review_state}（应为 passed）`);
  say(`  工单 state=${w.state} by=${w.verdict_by} at=${w.verdict_at}`);
  say(`  工单 note：${w.verdict_note}`);

  const 待办 = (
    await h.client.execute(
      `SELECT kind, COUNT(*) AS n FROM review_queue WHERE state='open' GROUP BY kind`,
    )
  ).rows as unknown as Record<string, string | number>[];
  const 隔 = (
    await h.client.execute(
      `SELECT COUNT(*) AS n FROM quarantine WHERE resolved_at IS NULL`,
    )
  ).rows[0] as unknown as { n: number };
  say("");
  say(
    `  红旗条 amber 徽章此刻应显示：${待办.length === 0 && Number(隔.n) === 0 ? "（整枚不出现）" : `工单 open ${待办.reduce((s, x) => s + Number(x.n), 0) + Number(隔.n)}：${[...待办.map((x) => `${x.kind}${x.n}`), Number(隔.n) > 0 ? `隔离${隔.n}` : ""].filter(Boolean).join(" · ")}`}`,
  );

  return Number(q.review_required) === 0 &&
    w.state === "passed" &&
    f.review_state === "passed"
    ? 0
    : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--phase");
  const phase = i >= 0 ? argv[i + 1] : "";
  const h = await getCoreDb();

  let bad = 1;
  if (phase === "redlight") bad = await 相_四红灯(h);
  else if (phase === "figure-ingest") bad = await 相_配图入库(h);
  else if (phase === "figure-pass") bad = await 相_配图过审(h);
  else {
    say("--phase 只认 redlight | figure-ingest | figure-pass");
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  await closeCoreDb();
  say("");
  say(
    bad === 0
      ? `结论：--phase ${phase} 全部如期。`
      : `结论：🔴 --phase ${phase} 有 ${bad} 处不如期。`,
  );
  process.exitCode = bad === 0 ? 0 : 1;
}

void main();
