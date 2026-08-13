/**
 * scripts/absvalue-book-ingest-20260813.ts —— 绝对值压轴册接入（AI:PRD-005 · 005-C）
 *
 * ┌─ 🔴 一次性脚本 · 跑完即退役 ────────────────────────────────────────────┐
 * │ 用途：把在售册《绝对值突破·十天打卡》（10 天 × 12 题 = 120 题）接进题库， │
 * │       建册级 SKU + 装 120 题 + 登记四件成品 PDF（成品双卷 / 网盘版双卷）。│
 * │ 幂等：按 SKU 名查库，已建就跳过；题按 match_key 预检，已入库的不重投。    │
 * │ 退役条件：本册接完且 SELECT 核对无误后，本文件只作**账**留着。            │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/absvalue-book-ingest-20260813.ts --dry-run
 *   pnpm exec tsx --env-file=.env scripts/absvalue-book-ingest-20260813.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 四条口径
 *
 * ① **料源 = `_源/punch_days.json`，不是 `_入库.json`**。
 *    任务书按备料写的是「`_入库.json`（120 题）」—— 实测这本册**没有** `_入库.json`：
 *    全工作区只有两本册的 `gen_打卡.py` 里写了 `write_ingest()`（备料 R1 的活证据），
 *    本册不在其中。所以料源取产线真有的那一份：`_源/punch_days.json`
 *    （10 天 × 6 模块 × 2 题 = 120，也正是 003 灌前 36 题时用的同一份）。
 *    🔴 **不去产线目录里跑 `gen_打卡.py` 生成 `_入库.json`** —— 产线目录只读。
 *
 * ② **punch_days → punch-ingest/v1 → kb-ingest/v1，中间那一跳只做搬运**。
 *    `punch_days.json` 是「上架 prod 打卡书」的 payload（book + days[].modules[].items[]），
 *    不是 punch-ingest/v1。本脚本把它**在内存里**摆成 punch-ingest/v1 的样子，
 *    再交给 `convertPunchIngest`（唯一映射函数）—— 不另写一份 punch→kb 的映射。
 *    题面/答案原样搬，一个字不改（G-3）。
 *
 * ③ **考点走同一张映射表**（`dicts/qunjuan-anchor-kp.map.json`）：模块标题 → 词表正名。
 *    群卷绝对值线的 anchor 就是这六个模块标题（群卷脚本 import 原册 qbank.py），
 *    两处用同一张表，考点不会分家。
 *    ⚠️ 已知偏差：003 灌的 day1-3 那 36 题是**逐题人工判**的考点
 *    （分布 12/6/6/6/4/2，不按模块均分），本次 84 题按**模块**落。
 *    同一册两种口径并存 —— 如实报告，要拉齐是一次独立的 KG 治理动作，不在本卡里顺手做。
 *
 * ④ **题型用确定性规则判，不猜**：有「（　　）」且带 A．B．C．D． ⇒ 选择；
 *    有下划线填空位 ⇒ 填空；其余 ⇒ 解答。
 *    🔴 机器证据：这条规则跑全册 120 题，在 day1-3 那 36 题上给出 26 填空 / 5 选择 / 5 解答
 *    —— 与 003 人工判的分布**一字不差**。规则不是拍脑袋定的，是拿已入库的 36 题验过的。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import {
  addSkuItems,
  assertNoSoldDuplicates,
  closeCoreDb,
  convertPunchIngest,
  getCoreDb,
  matchKeyOfStem,
  registerSku,
  registerSkuOutput,
  runIngestBatch,
  type KbIngestPayload,
} from "../src/core/index";
import { sku } from "../src/server/db/schema";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);

const AI_BKB = fileURLToPath(new URL("../../../", import.meta.url));
const KP_MAP_FILE = fileURLToPath(
  new URL("../dicts/qunjuan-anchor-kp.map.json", import.meta.url),
);

const 册根 = "举一反三产物/打卡/七上绝对值压轴突破";
const 源目录 = `${册根}/_源`;
const 料源 = `${源目录}/punch_days.json`;
const SKU_NAME = "绝对值突破·十天打卡";

/** 🔴 与 003 灌 36 题时用的**同一个** pipeline_ref：同源同族，别让 120 题分成两拨 */
const PIPELINE_REF =
  "绝对值压轴打卡DSL@2026-08（源=举一反三产物/打卡/七上绝对值压轴突破/_源/punch_days.json）";

/** 网盘指针（🔴 口径：`网盘分发记录/分享链接总表.md` 是唯一指引，产线卡与 doc 都只是镜像） */
const 网盘 = {
  链接: "https://pan.baidu.com/s/1KOE1EAo81xhZrJAV0VnpGg?pwd=4nmg",
  提取码: "4nmg",
  唯一指引: "网盘分发记录/分享链接总表.md 第 94 行（08-01；一链两册；10天×12题）",
  作废旧链接: ["e2t5", "59ng", "jhft", "6igc"],
  规范: "一册 = 一条链接 = 一个网盘文件夹分享，双号共用同一条；网盘 PDF 无水印",
};

/** 四件成品（🔴 「成品」与「全册/网盘版」是**两套不同产物**，字节差 2.8 倍，登记须写明角色） */
const 产出 = [
  {
    kind: "pdf_q" as const,
    rel: `${册根}/绝对值突破·十天打卡（题目卷·成品）.pdf`,
    角色: "成品·题目卷",
    预期字节: 847871,
  },
  {
    kind: "pdf_a" as const,
    rel: `${册根}/绝对值突破·十天打卡（答案卷·成品）.pdf`,
    角色: "成品·答案卷",
    预期字节: 981380,
  },
  {
    kind: "pdf_q" as const,
    rel: `${册根}/_交付/网盘/绝对值突破·十天打卡（题目卷）.pdf`,
    角色: "网盘版·题目卷（🔴 实际发给客户的就是这一份，无水印）",
    预期字节: 304721,
  },
  {
    kind: "pdf_a" as const,
    rel: `${册根}/_交付/网盘/绝对值突破·十天打卡（答案卷）.pdf`,
    角色: "网盘版·答案卷（🔴 实际发给客户的就是这一份，无水印）",
    预期字节: 478403,
  },
];

// ---------------------------------------------------------------------------

interface PunchDaysFile {
  book: { title: string; book_type?: string; subject_id?: string; grade?: string };
  days: {
    day: number;
    goals?: string[];
    modules: { type?: string; title: string; items: { q: string; a: string }[] }[];
  }[];
}

/** 口径④：确定性题型判定（拿已入库的 36 题验过，分布一字不差） */
function 判题型(q: string): "选择" | "填空" | "解答" {
  const 有选项 = /[（(][\s　]*[）)]/.test(q) && /[ABCD][．.]/.test(q);
  if (有选项) return "选择";
  if (/_{3,}/.test(q)) return "填空";
  return "解答";
}

function 读映射表(): Record<string, string> {
  const raw = JSON.parse(readFileSync(KP_MAP_FILE, "utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

const 绝对 = (p: string): string => (isAbsolute(p) ? p : resolve(AI_BKB, p));

/** 口径②：punch_days.json → punch-ingest/v1（只搬运，题面一个字不改） */
function 摆成punch契约(f: PunchDaysFile): unknown {
  const 题: unknown[] = [];
  for (const d of f.days) {
    let seq = 0; // 🔴 一天里的第几题（1..12）—— 与 003 已入库那 36 题的 src 标签同轴
    for (const m of d.modules) {
      for (const it of m.items) {
        seq += 1;
        题.push({
          day: d.day,
          section: m.title,
          seq,
          stem: it.q, // 原样
          answer: it.a, // 原样
          考点: [m.title], // 模块标题 → 经 kpMap 落到词表正名
          题型: 判题型(it.q),
          来源: `${f.book.title}（${源目录}/punch_days.json）· 第${d.day}天 · ${m.title}`,
        });
      }
    }
  }
  return {
    契约: "punch-ingest/v1",
    册: f.book.title,
    类型: "打卡",
    科目: "数学",
    年级: f.book.grade ?? "七年级上册",
    源目录: 绝对(源目录),
    版本: [
      {
        版本名: "正册",
        day_spec: { 天数: f.days.length, 题数: 题.length },
        题,
      },
    ],
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry-run");
  const kpMap = 读映射表();
  const h = await getCoreDb();

  say(杠);
  say(`绝对值压轴册接入（AI:PRD-005 · 005-C）${dry ? " · dry-run" : ""}`);
  say(`料源：${料源}`);
  say(杠);

  const f = JSON.parse(readFileSync(绝对(料源), "utf8")) as PunchDaysFile;
  const punch = 摆成punch契约(f);

  const conv = convertPunchIngest(punch, {
    filePath: 绝对(料源),
    source: "绝对值压轴册接入@005-C",
    pipelineRef: PIPELINE_REF,
    sourceDoc: { title: `${SKU_NAME}（打卡册）`, kind: "册子" },
    kpMap,
  });
  if (conv.failed.length > 0 || conv.units.length !== 1) {
    for (const x of conv.failed) say(`🔴 转换失败 [${x.code}] ${x.message}`);
    say(`🔴 单元数 ${conv.units.length}（应为 1）`);
    return 1;
  }
  const 全payload = conv.units[0]!.payload;
  say(`转换：${全payload.items.length} 题`);
  for (const n of conv.normalizations) say(`  归一：${n}`);
  for (const w of conv.warnings) say(`  提醒：${w}`);
  if (conv.unknownFields.length > 0) {
    say(`  🔴 认不出的字段 ${conv.unknownFields.length} 处：`);
    for (const u of conv.unknownFields.slice(0, 5)) say(`      ${u.where}：${u.keys.join("、")}`);
  }
  if (全payload.items.length !== 120) {
    say(`🔴 转出来 ${全payload.items.length} 题 ≠ 120（产线卡与大纲都写 10 天 × 12 题）—— 停手`);
    return 1;
  }
  say();

  // ── ① match_key 预检：day1-3 的 36 题 003 已入库 ─────────────────────────
  const 键 = 全payload.items.map((it) => matchKeyOfStem(it.stem));
  const 键去重 = [...new Set(键)];
  if (键去重.length !== 键.length) {
    say(`🔴 本册内部 match_key 自撞 ${键.length - 键去重.length} 处 —— 停手（产线 verify 该拦的事）`);
    return 1;
  }
  const 已有行 = (
    await h.client.execute({
      sql:
        "SELECT id, match_key AS mk, pipeline_ref AS pr FROM question " +
        `WHERE match_key IN (${键去重.map(() => "?").join(",")}) AND status IN ('pending','active')`,
      args: 键去重,
    })
  ).rows as unknown as { id: string; mk: string; pr: string | null }[];
  const 库里 = new Map(已有行.map((r) => [r.mk, r]));
  say(细);
  say(`预检：120 题里 ${库里.size} 道库里已有（不重投），${120 - 库里.size} 道待投`);
  for (const s of new Set(已有行.map((r) => (r.pr ?? "（无）").slice(0, 60)))) {
    say(`   已有题来自：${s}…`);
  }

  const 新items = 全payload.items.filter((it, i) => !库里.has(键[i]!));
  const payload: KbIngestPayload = { ...全payload, items: 新items };

  // ── ② 出册前置闸 ────────────────────────────────────────────────────────
  if (新items.length > 0) {
    const dup = await assertNoSoldDuplicates(
      新items.map((it) => ({ seq: it.seq, stem: it.stem })),
    );
    for (const w of dup.warnings) say(`  提醒：${w}`);
    if (dup.similar.length > 0) {
      say(`  语义近似 ${dup.similar.length} 处（只报不拦，同模板换数本来就该像）`);
    }
    if (!dup.ok) {
      say(`🔴 预检过后仍撞 ${dup.collisions.length} 处 —— 停手查因`);
      for (const c of dup.collisions.slice(0, 10)) {
        say(`   seq=${c.seq} ${c.stemBrief} → ${c.hits.map((x) => x.questionId).join("/")}`);
      }
      return 1;
    }
    say(`  排重断言：绿（新题 ${dup.checked} 道，无 match_key 撞车）`);
  }

  // ── ③ 投 ────────────────────────────────────────────────────────────────
  const seq到qid = new Map<number, string>();
  if (新items.length > 0) {
    const r = await runIngestBatch(payload, { actor: "agent", dryRun: dry, backup: false });
    say(细);
    say(
      `投料：total=${r.counts.total} accepted=${r.counts.accepted}（需人审 ${r.counts.queued}） rejected=${r.counts.rejected}` +
        (dry ? "  [dry-run]" : ` batch=${r.batchId}`),
    );
    // 🔴 实算/逐行的账逐条端出来：CALC_MISMATCH 要人逐题核，不是「跑绿了就完」
    const 实算 = new Map<string, number>();
    for (const it of r.gateReport.items) {
      const k = `${it.calcVerdict ?? "—"}/${it.lineVerdict ?? "—"}`;
      实算.set(k, (实算.get(k) ?? 0) + 1);
      if (it.questionId) seq到qid.set(it.seq, it.questionId);
    }
    say(`实算/逐行三态分布（calc/line）：${[...实算].map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (r.counts.rejected > 0) {
      say(`🔴 被拒 ${r.counts.rejected} 道（已进隔离区，原样 payload 留着）：`);
      for (const it of r.gateReport.items.filter((x) => x.verdict === "rejected")) {
        say(`   seq=${it.seq} [${it.failure?.code}] ${it.failure?.message ?? ""}`);
      }
      say("🔴 停手不建册：题位不齐的册子比没册子更难查（G-3：对不上数停下报告，不凑）");
      return 1;
    }
  } else {
    say("全是已有题，无新料可投");
  }

  if (dry) {
    say();
    say("dry-run：SKU / 题位 / 产出 都不建");
    say(杠);
    return 0;
  }

  // ── ④ 建册 + 装题（ord = (day-1)*12 + 天内序号 = 1..120）──────────────────
  say(细);
  const 旧 = await h.db.select().from(sku).limit(1).where(eq(sku.name, SKU_NAME));
  let skuId: string;
  if (旧[0]) {
    skuId = 旧[0].id;
    say(`已有同名 SKU ${skuId}，跳过建册（幂等）`);
  } else {
    const s = await registerSku({
      type: "打卡",
      name: SKU_NAME,
      status: "active", // 🔴 产线卡写着「在售」，网盘 08-01 就发了
      editionCtx: "七上",
      recipeJson: {
        册根,
        料源,
        生成器: `${源目录}/qbank.py（6 类型 × 30 个模板函数）+ gen_打卡.py`,
        天数: 10,
        每天: "6 模块 × 2 题 = 12 题",
        题数: 120,
        含图: 0,
        考点映射表: "dicts/qunjuan-anchor-kp.map.json（模块标题 → 词表正名）",
        netdisk: 网盘,
        产线卡: `${册根}/产线卡.json（状态=在售；三步走 打样/全册/物料=done，录prod=todo）`,
        物料: `${册根}/_交付/发布物料.md`,
        风险:
          "🔴 qbank.py 参数空间近枯竭（群卷_绝对值_批量.py docstring 明记，第 2 期前须换策略）；" +
          "⚠️ A/B 双版式是旧口径（只换水印深浅，_xhs_A/B 两份 HTML 字节数完全相同 129889），" +
          "不满足 2026-08-05 起的 AB 隔离七维度，要按现行标准发须重出",
      },
      actor: "agent",
    });
    skuId = s.skuId;
    say(`建册 ${skuId}（type=打卡，status=active）`);
  }

  const 已装 = (
    await h.client.execute({
      sql: "SELECT COUNT(*) AS n FROM sku_item WHERE sku_id = ?",
      args: [skuId],
    })
  ).rows[0] as unknown as { n: number };
  if (Number(已装.n) > 0) {
    say(`已装 ${Number(已装.n)} 道，跳过装题（幂等）`);
  } else {
    const items: { questionId: string; ord: number }[] = [];
    for (const [i, it] of 全payload.items.entries()) {
      const qid = 库里.get(键[i]!)?.id ?? seq到qid.get(it.seq);
      const pos = it.punchPos;
      if (!qid || !pos) {
        say(`🔴 第 ${it.seq} 位没有 question id 或没有 punchPos —— 停手`);
        return 1;
      }
      items.push({ questionId: qid, ord: (pos.day - 1) * 12 + pos.seq });
    }
    const ords = new Set(items.map((x) => x.ord));
    if (items.length !== 120 || ords.size !== 120) {
      say(`🔴 题位 ${items.length} 条 / 不同 ord ${ords.size} 个（都该是 120）—— 停手不装`);
      return 1;
    }
    const a = await addSkuItems(skuId, items, { actor: "agent" });
    say(`装题 ${a.total} 道（ord = (day-1)×12 + 天内序号，1..120）`);
  }

  // ── ⑤ 四件产出 ──────────────────────────────────────────────────────────
  say(细);
  let 缺件 = 0;
  for (const o of 产出) {
    try {
      const r = await registerSkuOutput(skuId, {
        kind: o.kind,
        filePath: 绝对(o.rel),
        note:
          `${o.角色}；源=${o.rel}；${r_bytes(o.预期字节)}` +
          `；🔴 「成品」与「网盘版/全册」是两套不同产物（字节差 2.8 倍），本条是${o.角色.split("·")[0]}那一套` +
          `；网盘唯一指引=${网盘.唯一指引}`,
        actor: "agent",
      });
      const 对上 = r.bytes === o.预期字节;
      say(
        `产出 ${o.kind} ${o.角色}：${r.bytes} B ${对上 ? "✔与备料实测一致" : `🔴 备料记的是 ${o.预期字节} B`}` +
          `　sha256=${r.hash.slice(0, 12)}…${r.reused ? "（同内容已在仓里，复用）" : ""}`,
      );
      if (!对上) 缺件 += 1;
    } catch (e) {
      缺件 += 1;
      say(`⚠️ ${o.角色} 登记跳过（文件缺失/读不动）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  say();
  say(杠);
  say(缺件 === 0 ? "结论：全绿" : `结论：🔴 ${缺件} 件产出有问题（见上）`);
  say(杠);
  return 缺件 === 0 ? 0 : 1;
}

const r_bytes = (n: number): string => `备料实测 ${n} B`;

main()
  .then(async (code) => {
    await closeCoreDb();
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(`🔴 未处理的异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    await closeCoreDb();
    process.exit(1);
  });
