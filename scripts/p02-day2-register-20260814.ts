/**
 * scripts/p02-day2-register-20260814.ts —— 群打卡第 02 期 day2 样张登记（一次性）
 *
 * 验收后「持续产题」动线实跑（2026-08-14）：day2 题已经 kb:submit 入库
 * （batch_01KZZ2JC6XG7BWAMSS9C2B6SHV，20/20 prov=model），本脚本只做登记：
 *   draft 天卷 SKU + 20 条 sku_item（ord=卷面题号）+ 题单 JSON 登记为 kind='物料'。
 *
 * 与 005-D 的 preview-p02-20260813.ts register 子命令同一姿势，仅册名/来源不同
 * （那份把 day1 册名写死在文件头，是一次性回执脚本，不去改它）。
 * 血缘核查不在本文件：复用 `preview-p02-20260813.ts lineage --paper <题单>`（册名无关）。
 *
 * 用法：pnpm exec tsx --env-file=.env scripts/p02-day2-register-20260814.ts --paper <题单.json> [--dry-run]
 * 退出码：0=绿；1=有题不在库/血缘断；2=入参不对。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  addSkuItems,
  closeCoreDb,
  getCoreDb,
  listSkus,
  matchKeyOfStem,
  registerSku,
  registerSkuOutput,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");

/** 册名（幂等键：重跑按名字找回同一本，不长第二本） */
const SKU_NAME = "群打卡第02期·七上混合·day2（预演样张）";

interface 题单行 {
  no: number;
  q: string;
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
    };
  });
}

/** 出卷元数据（题单旁的 样张元数据.json）—— 没有就如实标注 */
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--paper");
  const p = i >= 0 ? argv[i + 1] : undefined;
  if (!p) {
    say(
      "用法：… p02-day2-register-20260814.ts --paper <题单.json> [--dry-run]",
    );
    return 2;
  }
  const paperPath = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!existsSync(paperPath)) {
    say(`🔴 题单不在：${paperPath}`);
    return 2;
  }

  const h = await getCoreDb();
  const rows = 读题单(paperPath);
  say(`登记天卷 SKU：${SKU_NAME}`);
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

  const 缺 = rows.filter((_, k) => !byKey.has(键[k]!));
  if (缺.length > 0) {
    say(`🔴 有 ${缺.length} 题在库里查不到（先 kb:submit）`);
    return 1;
  }
  const 无血缘 = rows.filter((_, k) => !byKey.get(键[k]!)?.mid);
  if (无血缘.length > 0) {
    say(`🔴 有 ${无血缘.length} 题没有 model_id（投的时候漏了 --model-map）`);
    return 1;
  }
  say(`  ${rows.length} 题全部在库、且全部带 model_id ✓`);

  if (argv.includes("--dry-run")) {
    say("  [dry-run] 到此为止，不建册不装题。");
    return 0;
  }

  // 幂等：同名册子已建过就复用
  const 已有 = (await listSkus({ limit: 500, handle: h })).find(
    (s) => s.name === SKU_NAME,
  );
  let skuId: string;
  if (已有) {
    skuId = 已有.id;
    say(`  册子已存在，复用：${skuId}（${已有.status}）`);
  } else {
    const r = await registerSku({
      type: "卷",
      name: SKU_NAME,
      status: "draft", // 🔴 样张不是商品；上架是业务决定
      layout: "daily_v1",
      editionCtx: "人教七上",
      recipeJson: {
        来源: "验收后「持续产题」动线实跑（2026-08-14）—— 第 02 期 day2",
        出卷API:
          "举一反三产物/打卡/七上有理数混合运算打卡/_源/qbank.py#build_paper(seed, quota, lv, history)",
        ...读元数据(paperPath),
        history来源:
          "题库（挂混合运算七考点的全部在库题，229 条，含 day1 新 20）—— 库里有的就是出过的",
      },
    });
    skuId = r.skuId;
    say(`  建册：${skuId}（${r.status}，seq=${r.seq}）`);
  }

  const 卡 = await listSkus({ limit: 500, handle: h });
  const 现有题数 = 卡.find((s) => s.id === skuId)?.items ?? 0;
  if (现有题数 === 0) {
    const items = rows.map((r, k) => ({
      questionId: String(byKey.get(键[k]!)!.id),
      ord: r.no, // 🔴 ord = 卷面题号（学情回流按它对位）
    }));
    const a = await addSkuItems(skuId, items, { handle: h });
    say(`  装题：${a.added.length} 条，册内共 ${a.total} 题（seq=${a.seq}）`);
  } else {
    say(`  册内已有 ${现有题数} 题，跳过装题（幂等）`);
  }

  const o = await registerSkuOutput(skuId, {
    kind: "物料",
    filePath: paperPath,
    note:
      "day2 样张的机读题单（题号/题面/答案/主锚）。" +
      "🔴 双 PDF 不硬凑：渲染件等产线正式跑第 02 期时由 render_daily 出，那时再补两格。",
    handle: h,
  });
  say(
    `  登记产出：${o.outputId} kind=${o.kind} ${o.bytes}B hash=${o.hash.slice(0, 16)}…` +
      (o.reused ? "（内容仓里本来就有，复用）" : ""),
  );
  say(`  册子 id：${skuId}`);
  return 0;
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
