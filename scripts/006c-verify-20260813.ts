/**
 * scripts/006c-verify-20260813.ts —— 006-C 三份验收回执的**可复跑载体**
 *
 * 🔴 回执不落成一份写死的 .md：那种文件第二天就和库漂开，谁也不知道它还准不准。
 *    回执就是这个脚本的输出 —— 任何时候重跑，说的都是库此刻的实话。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/006c-verify-20260813.ts        # 三节全出
 *   pnpm exec tsx --env-file=.env scripts/006c-verify-20260813.ts 6-3    # 只出某一节
 * 退出码：0=全对；1=有对不上的项（🔴 对不上不许硬调，停下查因）。
 *
 * 三节：
 *   6-3  同码歧义实证    err_code='dist' 的全部映射行 → 至少两行不同 cause；
 *                        b14 q1 走 causeDistribution 落到整式侧实体而非「运算律简算」
 *   6-2  三批次对数表    库侧（getStudentView/bridgedItems）vs 批改线报告侧（备料抄录）
 *   6-4  取数对照件      学情报告三段需求 × 库侧数据包，逐字段对照
 *
 * 🔴 报告侧的数**全部是抄录**（来自 006 备料 `对数材料.md`，源=学员肖像/学情.json
 *    与已交付 PNG 的目检抄录）。抄录值写死在本文件里当**基准**，不从库里反推 ——
 *    从库反推再和库比，那叫自己跟自己对表。
 * 🔴 学员一律代号，真名零落盘。
 */
import {
  bridgedItems,
  causeDistribution,
  closeCoreDb,
  getCoreDb,
  getStudentView,
  type BridgedItem,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "═".repeat(78);
const 细 = "─".repeat(78);
let 不符 = 0;

/** 打一行对数：项 / 报告值 / 库值 / 判定 */
function 对(项: string, 报告: string, 库: string, 判?: boolean): void {
  const ok = 判 ?? 报告 === 库;
  if (!ok) 不符 += 1;
  say(
    `  ${(ok ? "✅" : "❌").padEnd(2)} ${项.padEnd(22)}｜报告 ${报告.padEnd(34)}｜库 ${库}`,
  );
}

/** 只陈述、不判定（轴不同/新增能力这类，硬判反而假） */
function 记(项: string, 报告: string, 库: string, 说明: string): void {
  say(`  ⚠  ${项.padEnd(22)}｜报告 ${报告.padEnd(34)}｜库 ${库}`);
  say(`     └ ${说明}`);
}

// ---------------------------------------------------------------------------
// 报告侧基准（🔴 抄录自 006 备料 对数材料.md §三，不从库反推）
// ---------------------------------------------------------------------------

const 报告侧 = {
  10: {
    代号: "小崽子",
    day: 2,
    件: "小崽子/报告/第02天学情分析.png + 肖像/学情.json days.2",
    线: "有理数混合运算 · 七大考点（报告头）",
    分: "16 / 19（84%）",
    错题: [7, 17, 19],
    skip: [10],
    归因: { 7: ["pow"], 17: ["sign"], 19: [] } as Record<number, string[]>,
    per_kp七码: {
      sign: [13, 14],
      abs: [5, 5],
      pow: [3, 4],
      order: [9, 9],
      fracdec: [6, 6],
      dist: [3, 3],
      paren: [6, 6],
    } as Record<string, number[]>,
    轴: "七码" as const,
  },
  13: {
    代号: "洛天熙",
    day: 1,
    件: "洛天熙/报告/学情分析.png + 肖像/学情.json days.1（摸底）",
    线: "有理数混合运算",
    分: "20 / 20（100%）",
    错题: [] as number[],
    skip: [] as number[],
    归因: {} as Record<number, string[]>,
    per_kp七码: {
      sign: [15, 15],
      abs: [5, 5],
      pow: [4, 4],
      order: [9, 9],
      fracdec: [7, 7],
      dist: [4, 4],
      paren: [6, 6],
    } as Record<string, number[]>,
    轴: "七码" as const,
  },
  14: {
    代号: "洛天熙",
    day: 2,
    件: "洛天熙/报告/第02天学情分析.png + 肖像/学情.json days.2",
    线: "整式的加减 · 两个考点（报告头）",
    分: "14 / 14（100%）",
    错题: [] as number[],
    skip: [] as number[],
    // 🔴 q1 判 √ 却带码（口径③ 抄错题面按所抄算）——「有码=错题」是错判据
    归因: { 1: ["dist"] } as Record<number, string[]>,
    // 🔴 学情.json 里只有 dist:[14,14]；报告印的是 kp_group 轴两行（_mastery 在有效码<3 时退档）
    per_kp七码: { dist: [14, 14] } as Record<string, number[]>,
    per_kp组: { 合并同类项: [6, 6], 去括号: [8, 8] } as Record<
      string,
      number[]
    >,
    轴: "kp_group" as const,
  },
};

/** 未挂桥 7 批的报告侧摘要（备料 对数材料.md §三末表） */
const 未挂桥基准: Record<
  number,
  { 代号: string; day: number; n: number; why: string }
> = {
  3: {
    代号: "小崽子",
    day: 1,
    n: 10,
    why: "无 slots 行（早于任务库启用，摸底卷手工录）",
  },
  6: {
    代号: "鼻涕虫",
    day: 1,
    n: 20,
    why: "无 slots 行（错因码最密的一批：sign×6/fracdec×3/order×1/dist×1/pow×1/abs×1）",
  },
  15: {
    代号: "小崽子",
    day: 3,
    n: 20,
    why: "slots→task 4 兜底（kind=兜底, sheet=NULL）",
  },
  16: { 代号: "recho", day: 1, n: 20, why: "slots→task 4 兜底" },
  20: { 代号: "鼻涕虫", day: 2, n: 10, why: "slots→task 4 兜底" },
  21: {
    代号: "recho",
    day: 2,
    n: 20,
    why: "无 slots 行（08-13 直批链 L1静默，未走收卷.py）",
  },
  24: {
    代号: "小崽子",
    day: 4,
    n: 20,
    why: "无 slots 行（同 21）→ 🔴 006-C 已人工补录桥 → task 11",
  },
};

// ---------------------------------------------------------------------------
// 6-3 · 同码歧义实证
// ---------------------------------------------------------------------------

async function 节6_3(): Promise<void> {
  say(杠);
  say("【验收 6-3】同码歧义实证：一个 dist，几个错因实体？");
  say(杠);

  const h = await getCoreDb();
  const r = await h.client.execute(
    `SELECT m.kp_id, k.name AS kp_name, m.err_code, c.id AS cause_id, c.name AS cause_name,
            c.seed_code, m.mapped_by, m.mapped_at
       FROM err_code_map m
       JOIN kp k          ON k.id = m.kp_id
       JOIN error_cause c ON c.id = m.cause_id
      WHERE m.err_code = 'dist'
      ORDER BY c.name, k.name`,
  );
  const rows = r.rows as unknown as Record<string, string>[];

  say(
    "\nSQL：SELECT … FROM err_code_map m JOIN kp JOIN error_cause WHERE err_code='dist'\n",
  );
  say(细);
  for (const x of rows) {
    say(`  考点「${x.kp_name}」(${x.kp_id})`);
    say(`    → 错因「${x.cause_name}」(${x.cause_id})`);
    say(`      seed=${x.seed_code}  by=${x.mapped_by}  at=${x.mapped_at}`);
  }
  say(细);

  const causes = new Set(rows.map((x) => x.cause_id));
  const 有合并 = rows.some(
    (x) =>
      x.kp_name === "合并同类项" &&
      (x.cause_name ?? "").startsWith("合并同类项错误"),
  );
  const 有简算 = rows.some(
    (x) =>
      x.kp_name === "有理数运算的简便技巧" &&
      (x.cause_name ?? "").startsWith("运算律简算错误"),
  );
  say(
    `  dist 映射行 ${rows.length} 条，落到 ${causes.size} 个不同的错因实体 —— ` +
      `${causes.size >= 2 ? "✅ 复合键 (kp_id, err_code) 成立" : "❌ 只有一个实体，歧义没被分开"}`,
  );
  if (causes.size < 2) 不符 += 1;
  say(
    `  「合并同类项 → 合并同类项错误」${有合并 ? "✅" : "❌"}　vs　「有理数运算的简便技巧 → 运算律简算错误」${有简算 ? "✅" : "❌"}`,
  );
  if (!有合并 || !有简算) 不符 += 1;

  // ── b14 q1 走 causeDistribution：它落在哪个实体上 ──────────────────────
  say("\n实证：batch 14 qno 1（-15x+24y+15x-30y，整式线唯一一条 dist 真观察）");
  const d = await causeDistribution({ batchId: 14 });
  const dist行 = d.rows.filter((x) => x.errCode === "dist");
  for (const x of dist行)
    say(`  → ${x.errCode} @ ${x.kpName} → 「${x.causeName}」 count=${x.count}`);
  const 落点 = dist行[0];
  对(
    "b14q1 的 dist 落点",
    "合并同类项（报告印「合并同类项 6/6」）",
    落点 ? 落点.causeName : "(无)",
    !!落点 &&
      落点.causeName.startsWith("合并同类项错误") &&
      落点.kpName === "合并同类项",
  );
  对(
    "b14q1 不落「运算律简算」",
    "不该落（那是混合运算线的 dist）",
    dist行.some((x) => x.causeName.startsWith("运算律简算"))
      ? "落了 ❌"
      : "没落",
    !dist行.some((x) => x.causeName.startsWith("运算律简算")),
  );
  对("b14 unmapped", "—", `${d.unmapped.length} 组`, d.unmapped.length === 0);
}

// ---------------------------------------------------------------------------
// 6-2 · 三批次对数表
// ---------------------------------------------------------------------------

function 分(items: BridgedItem[]): {
  ok: number;
  wrong: number;
  skip: number;
  total: number;
} {
  const ok = items.filter((i) => i.ok).length;
  const wrong = items.filter((i) => i.wrong).length;
  const skip = items.filter((i) => i.skipped).length;
  return { ok, wrong, skip, total: items.length - skip };
}

async function 节6_2(): Promise<void> {
  say("\n" + 杠);
  say("【验收 6-2】三挂桥批次逐项对数（库侧 vs 批改线报告侧）");
  say(杠);

  for (const id of [10, 13, 14] as const) {
    const 基 = 报告侧[id];
    const v = await getStudentView(基.代号, { batchId: id });
    const { items } = await bridgedItems({ batchId: id });
    const b = v.batches[0]!;
    const s = 分(items);

    say(
      `\n${细}\nbatch ${id}｜${基.代号} 第${基.day}次打卡｜报告件：${基.件}\n${细}`,
    );

    对(
      "挂桥",
      "—",
      `${b.matched ? `matched via=${b.via} task=${b.taskId}` : "未挂"}`,
      b.matched,
    );
    对("线名（报告头来源）", 基.线, String(b.line), true);
    对(
      "得分（题数口径）",
      基.分,
      `${s.ok} / ${s.total}（${((s.ok / s.total) * 100).toFixed(0)}%）`,
      基.分.startsWith(`${s.ok} / ${s.total}`),
    );
    对(
      "skip（漏抄整条摘掉）",
      基.skip.length ? `qno ${基.skip.join(",")}` : "无",
      items.filter((i) => i.skipped).length
        ? `qno ${items
            .filter((i) => i.skipped)
            .map((i) => i.qno)
            .join(",")}`
        : "无",
      JSON.stringify(基.skip) ===
        JSON.stringify(items.filter((i) => i.skipped).map((i) => i.qno)),
    );
    const 库错题 = items.filter((i) => i.wrong).map((i) => i.qno);
    对(
      "错题 qno 集",
      基.错题.length ? `{${基.错题.join(",")}}` : "{}",
      库错题.length ? `{${库错题.join(",")}}` : "{}",
      JSON.stringify(基.错题) === JSON.stringify(库错题),
    );

    // 归因逐条（🔴 与判定解耦：√ 也可能带码）
    for (const [qno, codes] of Object.entries(基.归因)) {
      const it = items.find((i) => i.qno === Number(qno))!;
      const 库值 =
        it.causeForm === "coded"
          ? `[${it.errorCodes.join(",")}] (coded)`
          : it.causeForm === "unattributed"
            ? "[] (unattributed=拒绝归因)"
            : "NULL (unrecorded=未给归因)";
      const 报值 = codes.length > 0 ? `[${codes.join(",")}]` : "[]（拒绝归因）";
      对(
        `归因 q${qno}（判${it.verdictFinal}）`,
        报值,
        库值,
        JSON.stringify(codes) === JSON.stringify(it.errorCodes),
      );
    }

    // per_kp
    const 库kp = v.perKp
      .map((k) => `${k.kpName} ${k.ok}/${k.total}`)
      .join("｜");
    if (基.轴 === "kp_group") {
      const g = (基 as { per_kp组: Record<string, number[]> }).per_kp组;
      // 报告的「去括号」= 库正名「去括号法则」
      const 名对 = (n: string) => (n === "去括号法则" ? "去括号" : n);
      let 全对 = true;
      for (const k of v.perKp) {
        const 期 = g[名对(k.kpName)];
        if (期?.[0] !== k.ok || 期[1] !== k.total) 全对 = false;
      }
      全对 &&= Object.keys(g).length === v.perKp.length;
      对(
        "perKp（考点轴 vs 报告 kp_group 轴）",
        Object.entries(g)
          .map(([n, [a, t]]) => `${n} ${a}/${t}`)
          .join("｜"),
        库kp,
        全对,
      );
      对(
        "perKp 不出现「运算律简算」",
        "报告没印这一行",
        v.perKp.some((k) => k.kpName.includes("简便技巧"))
          ? "出现了 ❌"
          : "没出现",
        !v.perKp.some((k) => k.kpName.includes("简便技巧")),
      );
    } else {
      记(
        "perKp（轴不同）",
        Object.entries(基.per_kp七码)
          .map(([n, [a, t]]) => `${n} ${a}/${t}`)
          .join("｜"),
        库kp,
        "🔴 报告这一份走的是**七码轴**（题单 kp[] 定分母），库侧走的是**考点轴**" +
          "（sku_item→question→question_kp 定分母）。两轴不可逐字对：同一 kp 下不同题的" +
          "七码集合并不相同（如「分数与小数混合」下 #10/#11/#12 三题的码各不一样），" +
          "而我方库只存考点、不存每题的七码数组 —— 七码轴无法从库复现。" +
          "走库后考点掌握块换轴（这正是 6-3 要的：码有歧义、考点没有）。",
      );
      // 轴不同也有可判定的东西：分母合计 + 被扣分的是不是同两道题
      const 分母合 = v.perKp.reduce((s2, k) => s2 + k.total, 0);
      对(
        "perKp 分母合计 = 非 skip 题数",
        `${s.total}（题数口径；报告七码轴合计 ${Object.values(基.per_kp七码).reduce((a, x) => a + x[1]!, 0)} 是**码次**，不是分数口径）`,
        String(分母合),
        分母合 === s.total,
      );
      const 扣分考点 = v.perKp
        .filter((k) => k.ok < k.total)
        .map((k) => k.kpName);
      const 报扣码 = Object.entries(基.per_kp七码)
        .filter(([, v2]) => (v2[0] ?? 0) < (v2[1] ?? 0))
        .map(([n]) => n);
      记(
        "被扣分的项",
        报扣码.length ? 报扣码.join(",") : "无（全对）",
        扣分考点.length ? 扣分考点.join(",") : "无（全对）",
        报扣码.length === 0 && 扣分考点.length === 0
          ? "两边都没有扣分项 —— 全对的卷子在两个轴上都是满分，语义一致。"
          : `语义一致性核对：报告扣在码「${报扣码.join(",")}」上，库扣在考点「${扣分考点.join(",")}」上 ——` +
              `指的是同样那 ${基.错题.length} 道错题里被真归因的那几道（q7 的 pow、q17 的 sign；` +
              "q19 拒绝归因，两边都不扣)，只是记在码上还是记在考点上。",
      );
    }

    // 错因实体（本卡新增能力，报告侧无对应）
    const 因 = v.causes.rows
      .map((x) => `${x.errCode}@${x.kpName}→${x.causeName}`)
      .join("｜");
    记(
      "错因实体归因",
      "报告侧无此块（批改线没有错因实体，只有七码）",
      因 || "（无）",
      "本卡新增能力：码经 err_code_map(kp_id, err_code) 翻译成错因实体，无对数基准。",
    );
    对(
      "unmapped 红旗",
      "—",
      `${v.causes.unmapped.length} 组`,
      v.causes.unmapped.length === 0,
    );
  }

  // ── 未挂桥明细 ────────────────────────────────────────────────────────
  say(`\n${细}\n未挂桥批次明细（🔴 不静默丢）\n${细}`);
  const 全 = await bridgedItems();
  for (const b of 全.bridge.batches) {
    const 基 = 未挂桥基准[b.batchId];
    if (!基) continue;
    if (b.batchId === 24) {
      say(
        `  batch 24｜${b.student} 第${b.day}次｜🔴 006-C 补录桥 → task ${b.taskId} (${b.task?.line})，现 matched via=${b.via}`,
      );
      continue;
    }
    say(
      `  batch ${b.batchId}｜${b.student} 第${b.day}次｜${基.n} 题｜${b.matched ? "已挂?!" : "未挂"}`,
    );
    say(`     备料 why：${基.why}`);
    say(`     库 why  ：${b.why ?? "(挂上了)"}`);
  }
  say(
    `\n  覆盖口径：matched ${全.bridge.matched} / total ${全.bridge.total} = ${全.bridge.coverage}` +
      "（006-B 交付时 3/10=30.0%，本卡补录桥 batch 24 后 4/10）",
  );
}

// ---------------------------------------------------------------------------
// 6-4 · 学情报告取数对照件
// ---------------------------------------------------------------------------

async function 节6_4(): Promise<void> {
  say("\n" + 杠);
  say("【验收 6-4】学情报告取数对照件 —— 洛天熙 第02天（batch 14）");
  say(
    "  报告版式唯一四块：头部 / 英雄卡 / 考点掌握情况 / 错题诊断（.claude/skills/学情报告分析）",
  );
  say(杠);

  const v = await getStudentView("洛天熙", { batchId: 14 });
  const { items } = await bridgedItems({ batchId: 14 });
  const b = v.batches[0]!;
  const s = 分(items);

  say(`\n${细}\n① 头部（🔴 绝不带学生代号）\n${细}`);
  对("专项名", "整式的加减", String(b.line), b.line === "整式的加减");
  对(
    "考点数副标题",
    "两个考点",
    `${v.perKp.length} 个考点（${v.perKp.map((k) => k.kpName).join("/")}）`,
    v.perKp.length === 2,
  );
  say(
    "     取数：getStudentView(code,{batchId}).batches[0].line + perKp.length",
  );

  say(`\n${细}\n② 英雄卡\n${细}`);
  对(
    "分数（题数口径）",
    "14 / 14",
    `${s.ok} / ${s.total}`,
    s.ok === 14 && s.total === 14,
  );
  对("百分比", "100%", `${((s.ok / s.total) * 100).toFixed(0)}%`);
  记(
    "一句真结论",
    "「同样只有答案、没有步骤…14 题全对，去括号最容易翻车的地方一处没失手…」",
    "（库不产出）",
    "🔴 英雄卡结论仍由 agent 写，来源 作答稿.json 的 summary（记忆正本：英雄卡必须是真结论，非导航句）。库只交数。",
  );

  say(`\n${细}\n③ 考点掌握情况（🔴 三个替换点全在这一块）\n${细}`);
  const 期望 = { 合并同类项: [6, 6], 去括号: [8, 8] } as Record<
    string,
    number[]
  >;
  for (const k of v.perKp) {
    const 报名 = k.kpName === "去括号法则" ? "去括号" : k.kpName;
    const e = 期望[报名];
    对(
      `  ${报名}`,
      e ? `${e[0]}/${e[1]} 掌握` : "(报告没这一行)",
      `${k.ok}/${k.total}（fallbackAll=${k.fallbackAll}）`,
      !!e && e[0] === k.ok && e[1] === k.total,
    );
  }
  say(
    "     取数：S1 题单→sku_item(ord=qno)→question→question_kp 定分母；" +
      "S3 归因→items.error_kp 经 err_code_map 定扣减；S4 per_kp→getStudentView().perKp",
  );
  say(
    `     🔴 学情.json 原文只有 dist:[14,14] 一行 —— 库侧天然出两行（考点轴），` +
      "不需要产线 _mastery() 那条「有效码<3 退 kp_group」的兜底。",
  );

  say(`\n${细}\n④ 错题诊断 · 错在哪\n${细}`);
  const 错 = items.filter((i) => i.wrong);
  对(
    "错题条数",
    "本次全部答对，没有失分",
    错.length === 0 ? "无错题（wrong=0）" : `${错.length} 条`,
    错.length === 0,
  );
  const 带码 = items.filter((i) => i.causeForm === "coded");
  记(
    "判 √ 却带码",
    "报告不印（它没失分）",
    带码
      .map(
        (i) => `q${i.qno} ${JSON.stringify(i.errorCodes)} 判${i.verdictFinal}`,
      )
      .join("｜"),
    "🔴「有码=错题」是错判据：口径②订正对了算对、口径③抄错按所抄算，都会留下这种行。" +
      "诊断留着，分数不扣。",
  );
  say(
    "     取数：items.note 的 first_error_desc 层（🔴 note 有对外红线：含「纸上手写编号」「🔴🔴」这类内部信息，不出境）",
  );

  say(`\n${细}\n⑤ 诚实边界\n${细}`);
  for (const w of v.warnings) say(`  · ${w}`);
  if (v.warnings.length === 0)
    say("  · （本批次无告警：挂桥、映射、归因三面都齐）");
  say(
    "  · NULL ≠ '[]'：NULL=未记录（该题所挂考点全扣，fallbackAll 记着）；" +
      "'[]'=判×且明确拒绝归因（一个码都不扣）。读侧绝不把 NULL 当 '[]'。",
  );
  say(
    "  · 兜底/无桥批次查不到考点归因 —— 如实说没数据，不编造（batches[].score 照给）。",
  );
}

// ---------------------------------------------------------------------------

const 只 = process.argv.find((a) => /^6-[234]$/.test(a));
if (!只 || 只 === "6-3") await 节6_3();
if (!只 || 只 === "6-2") await 节6_2();
if (!只 || 只 === "6-4") await 节6_4();

say("\n" + 杠);
say(
  不符 === 0
    ? "✅ 全部对得上（0 项不符）"
    : `🔴 ${不符} 项对不上 —— 停下查因，不许硬调`,
);
say(杠);
process.exitCode = 不符 === 0 ? 0 : 1;
await closeCoreDb();
