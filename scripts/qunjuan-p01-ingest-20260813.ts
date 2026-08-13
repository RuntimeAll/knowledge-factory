/**
 * scripts/qunjuan-p01-ingest-20260813.ts —— 群卷第 01 期全量接入（AI:PRD-005 · 005-C）
 *
 * ┌─ 🔴 一次性脚本 · 跑完即退役 ────────────────────────────────────────────┐
 * │ 用途：把订阅特训「群打卡第 01 期」三线 × 10 天（460 题）接进题库，       │
 * │       并建 30 本天卷 SKU + 双 PDF 产出登记 + 30 条 grading_task_map。    │
 * │ 幂等：按 SKU 名查库，已建的天卷整条跳过 —— 重跑不会长出第二本册子。      │
 * │ 退役条件：第 01 期接完且对账 C4/C5 核对无误后，本文件只作**账**留着；    │
 * │           第 02 期请走产线接线（gen 出料 → kb:submit），别回来改它。      │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/qunjuan-p01-ingest-20260813.ts --dry-run
 *   pnpm exec tsx --env-file=.env scripts/qunjuan-p01-ingest-20260813.ts
 * 退出码：0=全绿；1=有天卷没接上（哪一天见输出）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 四条口径
 *
 * ① **圣域只读**。`审核.db` 里的 tasks/slots/batches 一个字节都不写：任务不是我们建的
 *    （收卷.py 建的），本脚本只做两件事 —— 读它的三件套（paper/answer/sheet/nq）、
 *    往**我们这边**的 grading_task_map 里登记「哪本册子对应它」。
 *
 * ② **投料前按 match_key 预检，只投新题**。第 01 期第二天的 15 道样本题（三线各 5）
 *    003 就已经入库了，直接整卷投会在闸⑦撞 `DUPLICATE`，一撞就是整卷不投。
 *    正确姿势不是关闸，是**投之前先认出来**：已存在的题 sku_item 直接引用它的 qid
 *    （不重投、不改题、不建第二行），新题才走 runIngestBatch。
 *    🔴 跨来源也一样：群卷的绝对值线与打卡册同源（同一套 qbank 模板），
 *    撞上打卡册已入库的题就引用打卡册那一行 —— 一道题全库一行，这是 match_key 的本意。
 *
 * ③ **COUNT 必须精确等于 tasks.nq**。天卷装完题要 `sku_item 条数 == tasks.nq`
 *    （混合 20 / 整式 14 / 绝对值 12），对不上**当场停手报告**，不许凑数：
 *    学情回流按 `ord = 卷面题号` 对位，少一道就整体错行，而且错得悄无声息。
 *
 * ④ **兜底任务（id=4「其他」）不建桥**。它 `paper/answer/sheet/nq` 全 null ——
 *    「接住不在今天清单上的卷：学校卷/自己的作业本/别处买的册子」，本来就没有参照卷。
 *    给它编一本册子挂上去，对账 C4(c) 会拿 `nq=NULL` 去比题单数，红旗指向错误的地方。
 *    M1 的诚实边界：**没有题单的任务就是没有题单**，让 C5 明细如实列着它。
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
  closeGradingDb,
  convertPunchIngest,
  getCoreDb,
  getGradingDb,
  mapGradingTask,
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

/** ai-bkb 仓根（圣域 tasks 里的 paper/answer/sheet 都是**相对它**的正斜杠路径） */
const AI_BKB = fileURLToPath(new URL("../../../", import.meta.url));

/** anchor/kp_group → 词表 ref 的显式映射表（正本，CLI `--kp-map` 读的也是它） */
const KP_MAP_FILE = fileURLToPath(
  new URL("../dicts/qunjuan-anchor-kp.map.json", import.meta.url),
);

const 期 = "第01期";
const PIPELINE_REF = "订阅特训/_产线/出群卷-批量.py@第01期";

interface Task {
  id: number;
  date: string | null;
  line: string;
  book: string | null;
  day: number;
  nq: number;
  paper: string;
  answer: string;
  sheet: string;
}

interface 题单行 {
  no?: unknown;
  q?: unknown;
}

function 读映射表(): Record<string, string> {
  const raw = JSON.parse(readFileSync(KP_MAP_FILE, "utf8")) as Record<
    string,
    unknown
  >;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue; // `_说明` / `_版本` 这类注释键
    if (typeof v === "string" && v.trim() !== "") out[k] = v;
  }
  return out;
}

/** 圣域相对路径 → 绝对路径 */
function 绝对(p: string): string {
  return isAbsolute(p) ? p : resolve(AI_BKB, p);
}

/** `订阅特训/群打卡/第01期/<线目录>/第N天/题单.json` → `<线目录>` */
function 线目录(sheet: string): string {
  const seg = sheet.split(/[\\/]/);
  const i = seg.indexOf(期);
  return i >= 0 && seg[i + 1] ? seg[i + 1]! : "未知线";
}

// ---------------------------------------------------------------------------
// 一天一线 = 一本天卷
// ---------------------------------------------------------------------------

interface 天卷结果 {
  task: Task;
  skuId: string | null;
  已有: number;
  新投: number;
  总题: number;
  outputs: { kind: string; bytes: number; hash: string; reused: boolean }[];
  问题: string[];
}

async function 接一天(
  t: Task,
  kpMap: Record<string, string>,
  dry: boolean,
): Promise<天卷结果> {
  const out: 天卷结果 = {
    task: t,
    skuId: null,
    已有: 0,
    新投: 0,
    总题: 0,
    outputs: [],
    问题: [],
  };
  const h = await getCoreDb();
  const 目录 = 线目录(t.sheet);
  const skuName = `群打卡${期}·${t.line}·day${t.day}`;

  say(细);
  say(
    `【task ${t.id}】${t.date} ${t.line} 第 ${t.day} 天　nq=${t.nq}　→《${skuName}》`,
  );

  // 幂等：已经建过这本天卷就整条跳过
  const 旧 = await h.db.select().from(sku).limit(1).where(eq(sku.name, skuName));
  if (旧[0]) {
    say(`  · 已有同名 SKU ${旧[0].id}，整条跳过（幂等）`);
    out.skuId = 旧[0].id;
    return out;
  }

  // ── ① 读题单 ────────────────────────────────────────────────────────────
  const sheetAbs = 绝对(t.sheet);
  const rows = JSON.parse(readFileSync(sheetAbs, "utf8")) as 题单行[];
  out.总题 = rows.length;
  if (rows.length !== t.nq) {
    out.问题.push(
      `🔴 题单 ${rows.length} 条 ≠ tasks.nq=${t.nq} —— 停手（口径③：对不上不凑数）`,
    );
    say(`  ${out.问题[0]}`);
    return out;
  }

  // ── ② match_key 预检：哪些题库里已经有了 ────────────────────────────────
  const 键 = rows.map((r) => matchKeyOfStem(String(r.q ?? "")));
  const 键去重 = [...new Set(键)];
  if (键去重.length !== 键.length) {
    out.问题.push(
      `🔴 本天题单内部有 ${键.length - 键去重.length} 处 match_key 自撞 —— 停手（产线的 verify 该拦住的事，不在这儿掩盖）`,
    );
    say(`  ${out.问题[0]}`);
    return out;
  }
  const 占位 = 键去重.map(() => "?").join(",");
  const 已有行 = (
    await h.client.execute({
      sql:
        `SELECT id, match_key AS mk, status, pipeline_ref AS pr FROM question ` +
        `WHERE match_key IN (${占位}) AND status IN ('pending','active')`,
      args: 键去重,
    })
  ).rows as unknown as {
    id: string;
    mk: string;
    status: string;
    pr: string | null;
  }[];
  const 库里 = new Map(已有行.map((r) => [r.mk, r]));
  out.已有 = 库里.size;
  if (库里.size > 0) {
    const 来源 = new Set(已有行.map((r) => (r.pr ?? "（无 pipeline_ref）").slice(0, 46)));
    say(`  · 预检：${库里.size}/${rows.length} 题库里已有 —— **不重投**，sku_item 直接引用`);
    for (const s of 来源) say(`      已有题来自：${s}…`);
  }

  // ── ③ 转换（唯一映射函数）→ 只留新题 ────────────────────────────────────
  const conv = convertPunchIngest(rows, {
    filePath: sheetAbs,
    source: `群卷接入@005-C·${期}·第${t.day}天·${目录}`,
    pipelineRef: PIPELINE_REF,
    sourceDoc: { title: `群打卡${期}·${t.line}·day${t.day}`, kind: "群卷" },
    qtype: "计算",
    punch: { day: t.day, section: `${期}·${目录}` },
    kpMap,
  });
  if (conv.failed.length > 0 || conv.units.length !== 1) {
    for (const f of conv.failed) out.问题.push(`🔴 转换失败 [${f.code}] ${f.message}`);
    if (conv.units.length !== 1)
      out.问题.push(`🔴 转出来 ${conv.units.length} 个单元（应为 1）`);
    for (const p of out.问题) say(`  ${p}`);
    return out;
  }
  const 全payload = conv.units[0]!.payload;
  const seq到键 = new Map<number, string>();
  for (const [i, r] of rows.entries()) {
    const seq = 全payload.items[i]?.seq ?? Number(r.no ?? i + 1);
    seq到键.set(seq, 键[i]!);
  }

  const 新items = 全payload.items.filter(
    (it) => !库里.has(seq到键.get(it.seq) ?? ""),
  );
  const payload: KbIngestPayload = { ...全payload, items: 新items };

  // ── ④ 出册前置闸：新题这一批必须干净（撞了就是真撞，停手）─────────────────
  if (新items.length > 0) {
    const dup = await assertNoSoldDuplicates(
      新items.map((it) => ({ seq: it.seq, stem: it.stem })),
    );
    if (!dup.ok) {
      out.问题.push(
        `🔴 预检过后仍撞 ${dup.collisions.length} 处（预检口径与闸⑦不一致？停手查因）：` +
          dup.collisions
            .slice(0, 5)
            .map((c) => `seq=${c.seq}→${c.hits.map((x) => x.questionId).join("/")}`)
            .join("；"),
      );
      say(`  ${out.问题[0]}`);
      return out;
    }
    say(`  · 排重断言：绿（新题 ${dup.checked} 道，无 match_key 撞车）`);
  }

  // ── ⑤ 投新题 ────────────────────────────────────────────────────────────
  const seq到qid = new Map<number, string>();
  if (新items.length > 0) {
    const r = await runIngestBatch(payload, {
      actor: "agent",
      dryRun: dry,
      backup: false,
    });
    out.新投 = r.counts.accepted;
    say(
      `  · 投料：total=${r.counts.total} accepted=${r.counts.accepted} rejected=${r.counts.rejected}` +
        (dry ? "  [dry-run]" : ` batch=${r.batchId}`),
    );
    if (r.counts.rejected > 0) {
      for (const it of r.gateReport.items.filter((x) => x.verdict === "rejected")) {
        out.问题.push(`🔴 seq=${it.seq} [${it.failure?.code}] ${it.failure?.message ?? ""}`);
      }
      for (const p of out.问题.slice(0, 8)) say(`      ${p}`);
      return out;
    }
    for (const it of r.gateReport.items) {
      if (it.questionId) seq到qid.set(it.seq, it.questionId);
    }
  } else {
    say("  · 全是已有题，无新料可投");
  }

  if (dry) {
    say("  · dry-run：SKU / 产出 / 桥 都不建");
    return out;
  }

  // ── ⑥ 组装题位：ord = 卷面题号，每一位都得有真 qid ────────────────────────
  const items: { questionId: string; ord: number }[] = [];
  for (const [i, it] of 全payload.items.entries()) {
    const mk = seq到键.get(it.seq)!;
    const qid = 库里.get(mk)?.id ?? seq到qid.get(it.seq);
    if (!qid) {
      out.问题.push(`🔴 第 ${it.seq} 位没有 question id（既不在库也没投进去）—— 停手`);
      continue;
    }
    items.push({ questionId: qid, ord: Number(rows[i]?.no ?? it.seq) });
  }
  if (out.问题.length > 0 || items.length !== t.nq) {
    out.问题.push(
      `🔴 题位 ${items.length} ≠ tasks.nq=${t.nq} —— 停手不建册（口径③）`,
    );
    for (const p of out.问题) say(`  ${p}`);
    return out;
  }

  // ── ⑦ 建册 + 装题 ───────────────────────────────────────────────────────
  const s = await registerSku({
    type: "卷",
    name: skuName,
    status: "active", // 🔴 已经发过群、学员做过了，是在售/已交付态，不是 draft
    editionCtx: "七上",
    recipeJson: {
      期,
      天: t.day,
      线: t.line,
      线目录: 目录,
      日期: t.date,
      生成器: PIPELINE_REF,
      题单: t.sheet,
      圣域task_id: t.id,
      nq: t.nq,
      教材版本: "🔴 产线未声明，不编（edition_ctx 只写学段学期「七上」）",
      考点映射表: "dicts/qunjuan-anchor-kp.map.json",
    },
    actor: "agent",
  });
  out.skuId = s.skuId;
  const a = await addSkuItems(s.skuId, items, { actor: "agent" });
  say(`  · 建册 ${s.skuId}，装题 ${a.total} 道（ord=卷面题号）`);
  if (a.total !== t.nq) {
    out.问题.push(`🔴 装完 ${a.total} ≠ nq=${t.nq}`);
    say(`  ${out.问题.at(-1)}`);
    return out;
  }

  // ── ⑧ 双 PDF 产出登记 ───────────────────────────────────────────────────
  for (const [kind, rel, 角色] of [
    ["pdf_q", t.paper, "题目卷（发群的那份）"],
    ["pdf_a", t.answer, "答案卷（🔴 内部，别发群）"],
  ] as const) {
    try {
      const o = await registerSkuOutput(s.skuId, {
        kind,
        filePath: 绝对(rel),
        note: `群打卡${期}·第${t.day}天·${t.line}·${角色}；源=${rel}（圣域 tasks.${kind === "pdf_q" ? "paper" : "answer"}）`,
        actor: "agent",
      });
      out.outputs.push({
        kind,
        bytes: o.bytes,
        hash: o.hash.slice(0, 12),
        reused: o.reused,
      });
      say(
        `  · 产出 ${kind}：${o.bytes} B　sha256=${o.hash.slice(0, 12)}…　${o.reused ? "（同内容已在仓里，复用）" : "已入资产仓"}`,
      );
    } catch (e) {
      // 文件缺失如实报告并跳过这一件（口径：不编、不静默）
      const m = e instanceof Error ? e.message : String(e);
      out.问题.push(`⚠️ ${kind} 登记跳过：${m}`);
      say(`  ⚠️ ${kind} 登记跳过：${m}`);
    }
  }

  // ── ⑨ 挂桥 ──────────────────────────────────────────────────────────────
  const b = await mapGradingTask(t.id, s.skuId, {
    note: `群打卡${期} 第${t.day}天 ${t.line}（005-C 全量接入）`,
    actor: "agent",
  });
  say(
    `  · 挂桥 task ${b.taskId} ↔ ${b.skuId}：nq=${b.nqCheck.nq} items=${b.nqCheck.items} ${b.nqCheck.ok ? "✔" : "🔴"} ${b.nqCheck.note}`,
  );
  if (!b.nqCheck.ok) out.问题.push(`🔴 挂桥 nq 对不上：${b.nqCheck.note}`);

  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry-run");
  const kpMap = 读映射表();

  say(杠);
  say(`群卷${期}全量接入（AI:PRD-005 · 005-C）${dry ? " · dry-run" : ""}`);
  say(`ai-bkb 根：${AI_BKB}`);
  say(`考点映射表：${KP_MAP_FILE}（${Object.keys(kpMap).length} 条）`);
  say(杠);

  const g = await getGradingDb();
  const tasks = g.query<Task>(
    `SELECT id, date, line, book, day, nq, paper, answer, sheet
       FROM tasks WHERE kind = 'normal' ORDER BY day, id`,
  );
  const 兜底 = g.query<{ id: number; line: string; note: string | null }>(
    `SELECT id, line, note FROM tasks WHERE kind <> 'normal' ORDER BY id`,
  );
  say(`圣域 tasks：${tasks.length} 条天卷任务 + ${兜底.length} 条非天卷任务`);
  for (const b of 兜底) {
    say(
      `  🔴 task ${b.id}「${b.line}」**不建桥**（口径④）：${(b.note ?? "").slice(0, 60)}`,
    );
  }
  say();

  const 结果: 天卷结果[] = [];
  for (const t of tasks) 结果.push(await 接一天(t, kpMap, dry));

  // ── 对数表 ──────────────────────────────────────────────────────────────
  say();
  say(杠);
  say("逐线逐天对数表（🔴 items 必须精确 = tasks.nq）");
  say(杠);
  say("task | 日期 | 线 | day | nq | 题单 | 已有 | 新投 | items | 产出 | 桥");
  let 坏 = 0;
  for (const r of 结果) {
    const items = r.skuId && !dry ? await 装了几道(r.skuId) : r.总题;
    const ok = r.问题.length === 0 && (dry || items === r.task.nq);
    if (!ok) 坏 += 1;
    say(
      `${String(r.task.id).padStart(4)} | ${r.task.date} | ${r.task.line} | ${String(r.task.day).padStart(2)} | ` +
        `${String(r.task.nq).padStart(2)} | ${String(r.总题).padStart(2)} | ${String(r.已有).padStart(2)} | ` +
        `${String(r.新投).padStart(2)} | ${String(items).padStart(3)} | ${r.outputs.length} 件 | ${r.skuId ?? "—"} ${ok ? "" : "🔴"}`,
    );
    for (const p of r.问题) say(`        ${p}`);
  }

  const 合计 = {
    题单: 结果.reduce((s, r) => s + r.总题, 0),
    nq: 结果.reduce((s, r) => s + r.task.nq, 0),
    已有: 结果.reduce((s, r) => s + r.已有, 0),
    新投: 结果.reduce((s, r) => s + r.新投, 0),
    产出: 结果.reduce((s, r) => s + r.outputs.length, 0),
  };
  say(细);
  say(
    `合计：题单 ${合计.题单} 条 / tasks.nq 合计 ${合计.nq} / 已有 ${合计.已有} / 新投 ${合计.新投} / 产出登记 ${合计.产出} 件`,
  );

  // ── 期级 SKU ────────────────────────────────────────────────────────────
  if (!dry && 坏 === 0) 坏 += await 建期级(结果);

  say(杠);
  say(坏 === 0 ? "结论：全绿" : `结论：🔴 ${坏} 处有问题（见上）`);
  say(杠);
  return 坏 === 0 ? 0 : 1;
}

async function 装了几道(skuId: string): Promise<number> {
  const h = await getCoreDb();
  const r = await h.client.execute({
    sql: "SELECT COUNT(*) AS n FROM sku_item WHERE sku_id = ?",
    args: [skuId],
  });
  return Number((r.rows[0] as unknown as { n: number }).n);
}

async function 建期级(结果: 天卷结果[]): Promise<number> {
  const h = await getCoreDb();
  const name = `群打卡${期}`;
  const 旧 = await h.db.select().from(sku).limit(1).where(eq(sku.name, name));
  say();
  say(杠);
  say(`期级 SKU《${name}》`);
  say(杠);
  if (旧[0]) {
    say(`  · 已有 ${旧[0].id}，跳过（幂等）`);
    return 0;
  }
  const 按线 = new Map<string, 天卷结果[]>();
  for (const r of 结果) {
    const k = r.task.line;
    按线.set(k, [...(按线.get(k) ?? []), r]);
  }
  const s = await registerSku({
    type: "打卡",
    name,
    status: "active",
    editionCtx: "七上",
    recipeJson: {
      期,
      期间: `${结果[0]?.task.date} ~ ${结果.at(-1)?.task.date}`,
      天数: 10,
      三线构成: [...按线].map(([线, rs]) => ({
        线,
        线目录: 线目录(rs[0]!.task.sheet),
        每天题量: rs[0]!.task.nq,
        天数: rs.length,
        本线题数: rs.reduce((n, r) => n + r.task.nq, 0),
        册: rs[0]!.task.book,
      })),
      每天合计: [...按线].reduce((n, [, rs]) => n + rs[0]!.task.nq, 0),
      本期题数: 结果.reduce((n, r) => n + r.task.nq, 0),
      生成器: PIPELINE_REF,
      // 🔴 M1 的 sku 没有层级列，天卷的从属关系只能记在配方里（不加列）
      天卷: 结果.map((r) => ({
        skuId: r.skuId,
        name: `群打卡${期}·${r.task.line}·day${r.task.day}`,
        圣域task_id: r.task.id,
        日期: r.task.date,
        nq: r.task.nq,
      })),
      合卷:
        `订阅特训/群打卡/${期}/群打卡${期}第N天·三线合卷（题目|答案）.pdf` +
        "（发群发的是合卷；本期级 SKU 只记指针，产出登记在天卷上，别一份 PDF 登两处）",
      兜底任务:
        "圣域 task id=4「其他」（接住不在清单上的卷）paper/answer/sheet/nq 全 null，" +
        "**不建 grading_task_map**（口径④：没有题单的任务就是没有题单）",
    },
    actor: "agent",
  });
  say(`  · 建册 ${s.skuId}（type=打卡，status=active，天卷从属关系记在 recipe_json.天卷）`);
  return 0;
}

main()
  .then(async (code) => {
    closeGradingDb();
    await closeCoreDb();
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(`🔴 未处理的异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    closeGradingDb();
    await closeCoreDb();
    process.exit(1);
  });
