/**
 * scripts/recompute-matchkey-20260813.ts —— 🔴 **一次性全库重算 match_key**（AI:PRD-003 · 003-E5）
 *
 * 2026-08-13 跑过**一次**就退役。它了的是 003-E4 挂的那笔账：
 *
 *   `ingest-dedup.gate.ts` 的 `normalizeStem` 曾用**宽松**剥法 `<[^>]*>`，
 *   会把「一个数学 `<` 到下一个 `>` 之间的整段」当成 HTML 标签吃掉。真库 60 行里 2 行中招：
 *     · `q_01KZVF46KBKBTWEAYK207HGTZA`：`有理数 a < 0，b < 0，c > 0，且…` → `有理数a0且…`
 *     · `q_01KZVFBGNZZCZY86M9YXFRHHYS`：`（用 < 或 > 或 = 号填空）` → `(用或=号填空)`
 *   ⇒ 这两行的 `match_key` 算在**被吃过字的题面**上，查重键失真（假 DUPLICATE 风险）。
 *
 *   转换层已按总指挥裁决改成与 `fts.ts` `stripHtmlForSeg` 同款严格形状
 *   `</?[a-zA-Z][^<>]*>` + 「先剥后解码」；本脚本负责把**存量**用新口径重算一遍。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/recompute-matchkey-20260813.ts            # 只干跑（默认）
 *   pnpm exec tsx --env-file=.env scripts/recompute-matchkey-20260813.ts --commit   # 真跑
 * 退出码：0 = 预检与复核全绿；1 = 有一项没过（撞键预检红了也是 1，且**不会写库**）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 五条纪律
 *
 * ① **只动派生键**。`question.stem` / `answer` / `analysis` 三列正本**一个字都不碰** ——
 *    题面本来就没坏（E4 已查实），坏的只是算在它上面的 hash。UPDATE 里只有 `match_key`。
 *
 * ② **撞键预检前置，撞了就停手**。`idx_q_matchkey` 是部分唯一索引
 *    （WHERE status IN ('pending','active')）；新口径下若两行算出同一个键，
 *    那是**真有两道重复题**，属于要人看的数据问题 —— 报告出来交人裁，
 *    绝不硬写（硬写只会在事务里撞 UNIQUE，或者更糟：先删后插把重复题洗没了）。
 *    预检口径与索引一致：只在可检索态（pending/active）里查两两撞。
 *
 * ③ **只写有变化的行**，逐行把改前改后打出来。没变化的 58 行不进事务、不留审计。
 *
 * ④ **不碰 stem_plain / question_fts**。那是 003-E4 的活（分词喂料那一路），
 *    已经在用严格剥法了，本次改的是查重键这一路，两路各走各的。
 *
 * ⑤ **复核用同一把尺子**：写完重读全库，逐行验 `match_key === matchKeyOf(库内 stem)`。
 *    自洽 = 键与题面对得上；对不上说明还有别的路径在写旧口径的键。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { eq } from "drizzle-orm";

import { question } from "../src/server/db/schema";
import {
  closeCoreDb,
  getCoreDb,
  integrityCheck,
  matchKeyOf,
  normalizeStem,
  nowLocalISO,
  withCoreWrite,
  type CoreDbHandle,
  type GateItem,
  type GateReport,
  type RowRef,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量
// ---------------------------------------------------------------------------

const TOOL = "matchkey_recompute_20260813";

/** 与 `idx_q_matchkey` 的 WHERE 同口径：唯一性只在这两个状态里成立 */
const 可检索状态 = new Set(["pending", "active"]);

const 根因 =
  "ingest-dedup.gate.ts 的 normalizeStem 用宽松剥法 <[^>]*>，把「数学 < 到下一个 > 之间的整段」" +
  "当 HTML 标签吃掉（G-3 核查员方法论坑①）⇒ 这些行的 match_key 算在被吃过字的题面上，" +
  "查重键失真（两道只在被吃那段上有区别的题会撞成同一道，假 DUPLICATE 红灯）。" +
  "正本 question.stem 一个字没少，错的只是 hash。" +
  "已按 fts.ts stripHtmlForSeg 同款严格形状 </?[a-zA-Z][^<>]*> + 先剥后解码修好；本脚本重算存量。";
const 核查出处 =
  "AI:PRD-003 · 003-E4 在 rederive-stemplain-20260813 的复核里如实挂账（真库 2 行中招，" +
  "证据留在 ingest-dedup.gate.ts 注释），003-E5 奉总指挥裁决执行修复 + 全库重算。";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");
const 短 = (k: string | null): string => (k === null ? "—" : k.slice(0, 8));

// ---------------------------------------------------------------------------
// 取料
// ---------------------------------------------------------------------------

interface 题行 {
  id: string;
  stem: string;
  status: string;
  matchKey: string | null;
}

async function 读全库(h: CoreDbHandle): Promise<题行[]> {
  const r = await h.client.execute(
    `SELECT id, stem, status, match_key FROM question ORDER BY id`,
  );
  return (r.rows as unknown as Record<string, string | null>[]).map((row) => ({
    id: String(row.id),
    stem: String(row.stem ?? ""),
    status: String(row.status),
    matchKey: row.match_key === null ? null : String(row.match_key),
  }));
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
  新key: string;
}

async function main(): Promise<void> {
  const commit = process.argv.slice(2).includes("--commit");

  say(杠);
  say("AI:PRD-003 · 003-E5 全库 match_key 重算（真库）");
  say(
    "  口径：normalizeStem 换严格剥法 </?[a-zA-Z][^<>]*>（先剥标签后解实体），数学裸不等号不许被吃",
  );
  say("  🔴 正本 stem/answer/analysis 不动；stem_plain / question_fts 也不动");
  say(`  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}`);
  say(杠);

  const h = await getCoreDb();
  const rows = await 读全库(h);
  const 可检索 = rows.filter((r) => 可检索状态.has(r.status));
  say("");
  say(`全库 ${rows.length} 题（可检索态 ${可检索.length}）`);

  // ── 现状对账：库内键是不是「旧口径下自洽」──────────────────────────────
  const 新表 = new Map(rows.map((r) => [r.id, matchKeyOf(r.stem)]));
  const 变更表: 变更[] = rows
    .filter((r) => r.matchKey !== 新表.get(r.id))
    .map((r) => ({ row: r, 新key: 新表.get(r.id)! }));

  // ── 🔴 撞键预检（纪律②）——**先于任何写**────────────────────────────────
  say("");
  say(杠);
  say("🔴 撞键预检：新口径下可检索态两两不撞（撞 = 真重复题，停手交人裁）");
  say(杠);
  const 按键 = new Map<string, string[]>();
  for (const r of 可检索) {
    const k = 新表.get(r.id) ?? "";
    const 组 = 按键.get(k) ?? [];
    组.push(r.id);
    按键.set(k, 组);
  }
  const 撞组 = [...按键.entries()].filter(([, ids]) => ids.length > 1);
  say(`  可检索态 ${可检索.length} 行 → 相异键 ${按键.size} 个`);
  say(`  撞键组：${撞组.length}  ${撞组.length === 0 ? "[PASS]" : "[FAIL]"}`);
  for (const [k, ids] of 撞组) {
    say(`    🔴 ${短(k)}…  ${ids.join(" / ")}`);
    for (const id of ids) {
      const r = rows.find((x) => x.id === id)!;
      say(`        ${id}  ${r.stem.replace(/\n/g, "⏎").slice(0, 70)}`);
    }
  }
  if (撞组.length > 0) {
    say("");
    say(
      "  停手：新口径把上面这些行算成了同一道题。这不是脚本能定的事 —— " +
        "要么它们真是重复题（该走去重/改状态），要么归一口径还得收。先交人裁，不硬写。",
    );
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── 受影响行清单（纪律③）────────────────────────────────────────────────
  say("");
  say(杠);
  say(`受影响行：${变更表.length} / ${rows.length}`);
  say(杠);
  for (const c of 变更表) {
    say("");
    say(
      `${c.row.id}  status=${c.row.status}  ${短(c.row.matchKey)}… → ${短(c.新key)}…`,
    );
    say(
      `  正本 stem（不动）：${c.row.stem.replace(/\n/g, "⏎").slice(0, 120)}${c.row.stem.length > 120 ? "…" : ""}`,
    );
    say(`  旧归一（被吃过字）：${normalizeStem_旧(c.row.stem).slice(0, 110)}`);
    say(`  新归一（一个字不丢）：${normalizeStem(c.row.stem).slice(0, 110)}`);
  }
  if (变更表.length === 0) {
    say("");
    say("没有需要改的行 —— 已经是新口径了（本脚本可重复跑）。");
  }

  if (!commit) {
    say("");
    say("干跑完毕（库零变化）。确认上面的逐行 diff 没问题后再跑：--commit");
    await closeCoreDb();
    process.exitCode = 0;
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
        `受影响 ${变更表.length} / ${rows.length} 行，逐行新旧键见 args.受影响行`,
      ),
      账目("只动派生键 question.match_key；正本三列与 stem_plain/FTS 一律不动"),
      账目(
        "归一口径：normalizeStem 剥标签换严格形状 </?[a-zA-Z][^<>]*>，且先剥后解实体（与 fts.ts 同尺）",
      ),
      账目(
        `撞键预检已过：可检索态 ${可检索.length} 行 → 相异键 ${按键.size} 个，撞键组 0`,
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
          动作: "按修好的归一口径（严格剥 HTML）全库重算 match_key",
          全库行数: rows.length,
          可检索行数: 可检索.length,
          受影响行数: 变更表.length,
          根因,
          核查出处,
          受影响行: 变更表.map((c) => ({
            id: c.row.id,
            status: c.row.status,
            改前: {
              match_key: c.row.matchKey,
              归一题面: normalizeStem_旧(c.row.stem),
            },
            改后: {
              match_key: c.新key,
              归一题面: normalizeStem(c.row.stem),
            },
          })),
        },
        gateReport: 造账("003-E5 查重键·严格剥法重算", 理由),
      },
      async (tx) => {
        const rowRefs: RowRef[] = [];
        for (const c of 变更表) {
          await tx
            .update(question)
            .set({ matchKey: c.新key, updatedAt: now })
            .where(eq(question.id, c.row.id));
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
  let 坏 = 0;
  const 后 = await 读全库(h);

  say("");
  say("① 全库 match_key 自洽（≡ matchKeyOf(库内 stem)，严格口径）：");
  const 不洽 = 后.filter((r) => r.matchKey !== matchKeyOf(r.stem));
  if (不洽.length > 0) 坏 += 1;
  say(
    `  对不上 ${不洽.length} / ${后.length} 行  ${不洽.length === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  for (const r of 不洽)
    say(
      `    🔴 ${r.id}  库内 ${短(r.matchKey)}…  应为 ${短(matchKeyOf(r.stem))}…`,
    );

  say("");
  say("② 可检索态 match_key 唯一（部分唯一索引的语义）：");
  const 后可检索 = 后.filter((r) => 可检索状态.has(r.status));
  const 后按键 = new Map<string, number>();
  for (const r of 后可检索)
    后按键.set(r.matchKey ?? "", (后按键.get(r.matchKey ?? "") ?? 0) + 1);
  const 后撞 = [...后按键.entries()].filter(([, n]) => n > 1);
  if (后撞.length > 0) 坏 += 1;
  say(
    `  ${后可检索.length} 行 → 相异键 ${后按键.size} 个，撞 ${后撞.length} 组  ${后撞.length === 0 ? "[PASS]" : "[FAIL]"}`,
  );

  say("");
  say("③ 正本 stem 一个字未动（本次只该改派生键）：");
  const 动了 = 后.filter((r) => {
    const 原 = rows.find((x) => x.id === r.id);
    return 原 !== undefined && 原.stem !== r.stem;
  });
  if (动了.length > 0) 坏 += 1;
  say(
    `  被动过的正本行 ${动了.length}  ${动了.length === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  for (const r of 动了) say(`    🔴 ${r.id}`);

  say("");
  say("④ 裸不等号的行归一后一个字不丢：");
  const 裸 = 后.filter((r) => /<(?![a-zA-Z/])/.test(r.stem));
  let 吃字 = 0;
  for (const r of 裸) {
    const 有真标签 = /<\/?[a-zA-Z][^<>]*>/.test(r.stem);
    const n0 = (r.stem.match(/[<>]/g) ?? []).length;
    const n1 = (normalizeStem(r.stem).match(/[<>]/g) ?? []).length;
    const ok = 有真标签 || n0 === n1;
    if (!ok) 吃字 += 1;
    say(
      `  ${ok ? "[PASS]" : "[FAIL]"} ${r.id}  真标签=${有真标签 ? "有" : "无"}  ` +
        `不等号 ${n0}→${n1}   ${r.stem.replace(/\n/g, "⏎").slice(0, 62)}`,
    );
  }
  if (吃字 > 0) 坏 += 1;
  say(`  被吃掉不等号的行 ${吃字} —— 必须是 0`);

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
      ? `结论：${变更表.length} 行 match_key 重算完毕，全库键与题面自洽、可检索态不撞、对账无 red。`
      : `结论：🔴 还有 ${坏 + reds.length} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 + reds.length === 0 ? 0 : 1;
}

/**
 * 旧口径归一（只为在报告里把「被吃掉的那一段」摆出来看，**不参与任何写**）。
 * 与修复前的 `normalizeStem` 逐行等价：宽松剥法 + 先解码后剥标签。
 */
function normalizeStem_旧(stem: string): string {
  const 旧实体表: ReadonlyArray<[RegExp, string]> = [
    [/&nbsp;/gi, " "],
    [/&lt;/gi, "<"],
    [/&gt;/gi, ">"],
    [/&amp;/gi, "&"],
    [/&quot;/gi, '"'],
    [/&#39;/g, "'"],
  ];
  let s = stem ?? "";
  for (const [re, to] of 旧实体表) s = s.replace(re, to);
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/\\left|\\right|\\,|\\;|\\!|\\quad|\\qquad|\\displaystyle/g, " ")
    .replace(/\$\$|\$|\\\(|\\\)|\\\[|\\\]/g, " ");
  s = s.normalize("NFKC");
  return s.replace(/[\s　，。、；：！？,;:!?"'`“”‘’《》〈〉«»…—～~·・､｡]/g, "");
}

void main();
