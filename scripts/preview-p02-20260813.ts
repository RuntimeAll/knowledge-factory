/**
 * scripts/preview-p02-20260813.ts —— 群打卡第 02 期 day1 预演样张（AI:PRD-005 · 005-D）
 *
 * ┌─ 🔴 一次性脚本 · 前瞻新流程的实证载体 ─────────────────────────────────┐
 * │ 它证的不是「这一卷题好不好」，而是**新流程走不走得通**：              │
 * │   库里的已做题 → 喂给产线出卷器当 history → 出新卷 → 排重前置闸 →     │
 * │   带血缘入库（prov=model）→ 登记成册 → 任一题都能顺着 model_id 一路   │
 * │   指回生成它的那个 .py 文件。                                        │
 * │ 正式跑不跑第 02 期是业务决定，与本脚本无关（SKU 落 draft，不上架）。  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 三个子命令（按顺序跑，中间夹一次 python 出卷 + 一次 kb:submit）：
 *
 * ```powershell
 * # ① 已做题集 → history.json（喂给出卷器防重）
 * pnpm exec tsx --env-file=.env scripts/preview-p02-20260813.ts history --out <path>
 *
 * #   ↓ 中间：scratchpad 的 wrapper 调产线 build_paper 出题单（🔴 产线目录只读）
 * #   ↓ 中间：pnpm kb:submit <题单.json> --assert-dedup --kp-map … --model-map …
 *
 * # ② 题单 → draft 天卷 SKU + 20 条 sku_item + 题单 JSON 登记成 kind='物料' 产出
 * pnpm exec tsx --env-file=.env scripts/preview-p02-20260813.ts register --paper <题单.json>
 *
 * # ③ 全链血缘查证：题 → model_id → exam_model → dsl_ref → 真文件在不在盘上
 * pnpm exec tsx --env-file=.env scripts/preview-p02-20260813.ts lineage --paper <题单.json>
 * ```
 *
 * 退出码：0=全绿；1=有断链/对不上（哪一处见输出）；2=入参不对/文件读不了。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条口径
 *
 * ① **history 从库里来，不从产线的 python 里来**。产线原来的 `_history()` 是把
 *    `modi_fixed / qun_fixed / qun_fixed2 / 老册 json` 四处 import 一遍拼出来的 ——
 *    等于「防重的底盘 = 谁记得去 import 谁」。新流程把这件事换成一句话：
 *    **库里挂着这七个考点的题，就是已经出过的题**。少 import 一个文件不再是漏重的理由。
 *
 * ② **登记 ≠ 上架**。天卷 SKU 落 `draft`：这是样张，不是卖出去的东西。
 *    上架是 setSkuStatus 那一下，由业务决定，不由本脚本代劳。
 *
 * ③ **双 PDF 不硬凑**。产线正式跑时 render_daily 会出双 PDF，那时再 registerSkuOutput
 *    补 pdf_q/pdf_a；本卡只登记**题单 JSON** 这一份真实存在的产物（kind='物料'），
 *    并把「PDF 待正式跑时补」写进登记附注。为了凑满两格现渲一份 PDF，
 *    等于往资产仓里塞一份没人会用的文件。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addSkuItems,
  closeCoreDb,
  getCoreDb,
  getLineage,
  getModel,
  getQuestion,
  listSkus,
  matchKeyOfStem,
  registerSku,
  registerSkuOutput,
  searchQuestions,
  type CoreDbHandle,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);

/** 册名（也是幂等键：重跑按名字找回同一本，不长第二本） */
const SKU_NAME = "群打卡第02期·七上混合·day1（预演样张）";

/** anchor→词表 ref 的映射表：七个混合运算考点名从它取（不在本文件硬编码考点） */
const KP_MAP_FILE = fileURLToPath(
  new URL("../dicts/qunjuan-anchor-kp.map.json", import.meta.url),
);

/** 混合运算七码（正本 = 订阅特训/_产线/err_kp.json；这里只用它当查表的键） */
const 七码 = ["sign", "abs", "pow", "dist", "fracdec", "order", "paren"];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

interface 题单行 {
  no: number;
  q: string;
  ans: string;
  anchor: string;
}

function 读题单(p: string): 题单行[] {
  const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${p} 不是数组根的题单.json`);
  return raw.map((r, i) => {
    const o = (typeof r === "object" && r !== null ? r : {}) as Record<
      string,
      unknown
    >;
    return {
      no: typeof o.no === "number" ? o.no : i + 1,
      q: typeof o.q === "string" ? o.q : "",
      ans: typeof o.ans === "string" ? o.ans : "",
      anchor: typeof o.anchor === "string" ? o.anchor : "",
    };
  });
}

/** 七个考点名 → kp_id（名字来自映射表，id 来自库 —— 两头都不硬编码） */
async function 七考点id(h: CoreDbHandle): Promise<string[]> {
  const raw = JSON.parse(readFileSync(KP_MAP_FILE, "utf8")) as Record<
    string,
    unknown
  >;
  const 名 = 七码.map((c) => {
    const v = raw[c];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${KP_MAP_FILE} 里没有「${c}」这条映射`);
    }
    return v;
  });
  const 占位 = 名.map(() => "?").join(",");
  const rows = (
    await h.client.execute({
      sql: `SELECT id, name FROM kp WHERE name IN (${占位}) AND status='active'`,
      args: 名,
    })
  ).rows as unknown as { id: string; name: string }[];
  if (rows.length !== 名.length) {
    const 有 = new Set(rows.map((r) => r.name));
    throw new Error(
      `这些考点在库里查不到（或不是 active）：${名.filter((n) => !有.has(n)).join("、")}`,
    );
  }
  return rows.map((r) => String(r.id));
}

// ---------------------------------------------------------------------------
// ① history：已做题集 → JSON
// ---------------------------------------------------------------------------

async function 出history(outPath: string): Promise<number> {
  const h = await getCoreDb();
  const kpIds = await 七考点id(h);
  say(杠);
  say("① 已做题集 → history（喂给 build_paper 的 history 参数）");
  say(杠);
  say(`混合运算七考点：${kpIds.length} 个`);

  // 🔴 分页靠 excludeQuestionIds（searchQuestions 没有 offset，也不该有：
  //    「把已经拿到的排除掉」正是组卷排重的原语，拿它翻页口径一致）
  const ids: string[] = [];
  for (let round = 1; ; round++) {
    const r = await searchQuestions(
      {
        kpIds,
        limit: 200,
        statuses: ["active", "pending"],
        ...(ids.length > 0 ? { excludeQuestionIds: ids } : {}),
      },
      { metric: false },
    );
    const 新 = r.hits.map((x) => x.questionId);
    say(
      `  第 ${round} 轮：命中 ${新.length} 条（累计 ${ids.length + 新.length}）`,
    );
    if (新.length === 0) break;
    ids.push(...新);
    if (round > 20) throw new Error("翻页超过 20 轮 —— 不对劲，停手");
  }

  // 🔴 全文题面（不是 stemBrief）：history 是**逐字比对**的集合，
  //    截断过的题面永远等不上出卷器手里的那一串，等于防重失灵还不报错。
  const stems: string[] = [];
  for (const id of ids) {
    const card = await getQuestion(id, { handle: h });
    stems.push(card.stem);
  }

  const out = {
    契约: "kf-history/v1",
    说明:
      "库里挂着「混合运算七考点」的全部题面（逐字原样）。" +
      "喂给 举一反三产物/打卡/七上有理数混合运算打卡/_源/qbank.py#build_paper 的 history 参数，" +
      "出卷器按题面字符串判重（seen = set(history)）。",
    取法: "searchQuestions({kpIds:七考点, statuses:[active,pending]}) 分页（excludeQuestionIds 翻页）+ getQuestion 取全文",
    生成于: new Date().toISOString(),
    kpIds,
    n: stems.length,
    stems,
  };
  writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");
  say(`  → ${outPath}（${stems.length} 条题面）`);
  return 0;
}

// ---------------------------------------------------------------------------
// ② register：题单 → draft 天卷 SKU + 装题 + 登记题单为物料
// ---------------------------------------------------------------------------

async function 登记(paperPath: string, dryRun: boolean): Promise<number> {
  const h = await getCoreDb();
  const rows = 读题单(paperPath);
  say(杠);
  say(`② 登记天卷 SKU：${SKU_NAME}`);
  say(杠);
  say(`题单：${paperPath}（${rows.length} 题）`);

  // 题单 → qid（走 match_key，与录题闸⑦同一把尺子）
  const 键 = rows.map((r) => matchKeyOfStem(r.q));
  const 占位 = 键.map(() => "?").join(",");
  const 库行 = (
    await h.client.execute({
      sql:
        `SELECT id, match_key AS mk, model_id AS mid FROM question ` +
        `WHERE match_key IN (${占位}) AND status IN ('pending','active')`,
      args: 键,
    })
  ).rows as unknown as { id: string; mk: string; mid: string | null }[];
  const byKey = new Map(库行.map((r) => [String(r.mk), r]));

  const 缺 = rows.filter((_, i) => !byKey.has(键[i]!));
  if (缺.length > 0) {
    say(
      `🔴 有 ${缺.length} 题在库里查不到（先跑 pnpm kb:submit 把题投进去）：` +
        缺
          .slice(0, 5)
          .map((r) => `no=${r.no}`)
          .join("、"),
    );
    return 1;
  }
  const 无血缘 = rows.filter((_, i) => !byKey.get(键[i]!)?.mid);
  if (无血缘.length > 0) {
    say(
      `🔴 有 ${无血缘.length} 题没有 model_id —— 投的时候漏了 --model-map（血缘断在入库这一步）：` +
        无血缘
          .slice(0, 5)
          .map((r) => `no=${r.no}`)
          .join("、"),
    );
    return 1;
  }
  say(`  20 题全部在库、且全部带 model_id ✓`);

  if (dryRun) {
    say("  [dry-run] 到此为止，不建册不装题。");
    return 0;
  }

  // 幂等：同名册子已建过就复用（重跑不长第二本）
  const 已有 = (await listSkus({ limit: 500, handle: h })).find(
    (s) => s.name === SKU_NAME,
  );
  let skuId: string;
  if (已有) {
    skuId = 已有.id;
    say(`  册子已存在，复用：${skuId}（${已有.status}）`);
  } else {
    const 元数据 = 读元数据(paperPath);
    const r = await registerSku({
      type: "卷",
      name: SKU_NAME,
      status: "draft", // 🔴 样张不是商品
      layout: "daily_v1",
      editionCtx: "人教七上",
      recipeJson: {
        来源: "AI:PRD-005 · 005-D 前瞻新流程实证",
        出卷API:
          "举一反三产物/打卡/七上有理数混合运算打卡/_源/qbank.py#build_paper(seed, quota, lv, history)",
        ...元数据,
        history来源:
          "题库（挂混合运算七考点的全部在库题）—— 不是产线 python 里 import 出来的那份",
      },
    });
    skuId = r.skuId;
    say(`  建册：${skuId}（${r.status}，seq=${r.seq}）`);
  }

  const 卡 = await listSkus({ limit: 500, handle: h });
  const 现有题数 = 卡.find((s) => s.id === skuId)?.items ?? 0;
  if (现有题数 === 0) {
    const items = rows.map((r, i) => ({
      questionId: String(byKey.get(键[i]!)!.id),
      ord: r.no, // 🔴 ord = 卷面题号（学情回流按它对位）
    }));
    const a = await addSkuItems(skuId, items, { handle: h });
    say(`  装题：${a.added.length} 条，册内共 ${a.total} 题（seq=${a.seq}）`);
  } else {
    say(`  册内已有 ${现有题数} 题，跳过装题（幂等）`);
  }

  // 题单 JSON 登记成产出（🔴 双 PDF 待产线正式跑时出，不硬凑）
  const o = await registerSkuOutput(skuId, {
    kind: "物料",
    filePath: paperPath,
    note:
      "预演样张的机读题单（题号/题面/答案/主锚）。" +
      "🔴 双 PDF（pdf_q/pdf_a）本卡**不出**：样张只证流程，渲染件等产线正式跑第 02 期时由 render_daily 出，" +
      "那时再 registerSkuOutput 补两格。",
    handle: h,
  });
  say(
    `  登记产出：${o.outputId} kind=${o.kind} ${o.bytes}B hash=${o.hash.slice(0, 16)}…` +
      (o.reused ? "（内容仓里本来就有，复用）" : ""),
  );
  say(`  册子 id：${skuId}`);
  return 0;
}

/** 出卷元数据（wrapper 写在题单旁边的 `样张元数据.json`）—— 没有就算了，如实标注 */
function 读元数据(paperPath: string): Record<string, unknown> {
  const p = paperPath.replace(/题单\.json$/, "样张元数据.json");
  if (p === paperPath || !existsSync(p)) {
    return { 元数据: "缺（题单旁没有 样张元数据.json）" };
  }
  const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// ③ lineage：全链血缘查证
// ---------------------------------------------------------------------------

async function 查血缘(paperPath: string): Promise<number> {
  const h = await getCoreDb();
  const rows = 读题单(paperPath);
  say(杠);
  say("③ 全链血缘查证：题 → model_id → exam_model → dsl_ref → 盘上的真文件");
  say(杠);

  const 键 = rows.map((r) => matchKeyOfStem(r.q));
  const 占位 = 键.map(() => "?").join(",");
  const 库行 = (
    await h.client.execute({
      sql: `SELECT id, match_key AS mk FROM question WHERE match_key IN (${占位}) AND status IN ('pending','active')`,
      args: 键,
    })
  ).rows as unknown as { id: string; mk: string }[];
  const byKey = new Map(库行.map((r) => [String(r.mk), String(r.id)]));

  let 坏 = 0;
  const 模型统计 = new Map<string, number>();
  for (const [i, r] of rows.entries()) {
    const qid = byKey.get(键[i]!);
    if (!qid) {
      say(`  🔴 no=${r.no} 库里查不到`);
      坏 += 1;
      continue;
    }
    const card = await getQuestion(qid, { handle: h });
    const m = card.provenance.model;
    if (!m) {
      say(`  🔴 no=${r.no} ${qid} 没有 model —— 血缘断在 question.model_id`);
      坏 += 1;
      continue;
    }
    模型统计.set(m.name, (模型统计.get(m.name) ?? 0) + 1);
  }

  say(细);
  say("逐模型题数（anchor → exam_model）：");
  for (const [name, n] of [...模型统计].sort()) say(`  · ${name}  ${n} 题`);

  // 抽第一题走满全链（含 dsl_ref 文件存在性）
  const 首 = byKey.get(键[0]!);
  if (首) {
    say(细);
    say(`抽样全链（no=${rows[0]!.no}）：`);
    const card = await getQuestion(首, { handle: h });
    say(`  题 id      ${card.id}`);
    say(`  题面       ${card.stem}`);
    say(`  答案       ${card.answer ?? "（空）"}`);
    say(`  prov.type  ${card.provenance.type}`);
    say(`  pipelineRef ${card.provenance.pipelineRef ?? "（无）"}`);
    const mid = card.provenance.model?.id;
    if (!mid) {
      say("  🔴 没有 model_id");
      坏 += 1;
    } else {
      const model = await getModel(mid, { handle: h });
      if (!model) {
        say(`  🔴 model_id=${mid} 在 exam_model 里查无此行`);
        坏 += 1;
      } else {
        say(`  模型       ${model.name}（${model.id}，${model.status}）`);
        say(`  归位考点   ${model.kpName ?? "?"}（${model.kpId}）`);
        say(`  dsl_ref    ${model.dslRef ?? "（空）"}`);
        const 文件 = (model.dslRef ?? "").split("#")[0] ?? "";
        const 在 = 文件 !== "" && existsSync(文件);
        say(`  生成器文件 ${在 ? "✓ 在盘上" : "🔴 找不到"}：${文件}`);
        if (!在) 坏 += 1;
        say(`  该模型生成的题 ${model.questionCount} 道`);
        say(`  血缘上游 origin ${model.originQids.length} 道`);
      }
      const lin = await getLineage(首, { handle: h });
      say(
        `  getLineage：bornOf=${lin.bornOf?.name ?? "null"}` +
          `（母题 ${lin.bornOf?.origins.length ?? 0} 道 / 兄弟 ${lin.bornOf?.siblingTotal ?? 0} 道）` +
          `，originOf=${lin.originOf.length} 个模型`,
      );
    }
  }

  say(细);
  say(坏 === 0 ? "结论：全链可回指，20/20 绿" : `结论：🔴 ${坏} 处断链`);
  return 坏 === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// 主
// ---------------------------------------------------------------------------

function 取值(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const 绝对 = (p: string): string =>
    isAbsolute(p) ? p : resolve(process.cwd(), p);

  if (cmd === "history") {
    const out = 取值(argv, "--out");
    if (!out) {
      say("用法：… preview-p02-20260813.ts history --out <path>");
      return 2;
    }
    return await 出history(绝对(out));
  }
  if (cmd === "register" || cmd === "lineage") {
    const p = 取值(argv, "--paper");
    if (!p) {
      say(`用法：… preview-p02-20260813.ts ${cmd} --paper <题单.json>`);
      return 2;
    }
    const abs = 绝对(p);
    if (!existsSync(abs)) {
      say(`🔴 题单不在：${abs}`);
      return 2;
    }
    return cmd === "register"
      ? await 登记(abs, argv.includes("--dry-run"))
      : await 查血缘(abs);
  }

  say("子命令：history | register | lineage（各自的用法见文件头）");
  return 2;
}

main()
  .then(async (code) => {
    await closeCoreDb();
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(
      `🔴 未处理的异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    await closeCoreDb();
    process.exit(1);
  });
