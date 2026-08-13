/**
 * scripts/model-origins-20260813.ts —— 给「已经在出题」的模型补血缘上游（AI:PRD-005 · 005-D）
 *
 * ┌─ 🔴 一次性脚本 · 幂等（重跑写同一组 id，结果一样）────────────────────────┐
 * │ 首铺（005-C）时 22 个 exam_model 的 origin_qids_json 全是空的 ——           │
 * │ 「这个模型是照着哪几道真题归纳出来的」当时答不上来，因为那些母题不在库里。  │
 * │ 本脚本把答得上来的那部分补齐，让 REG-E3 的红灯（有生成题却没有血缘上游）    │
 * │ 落到实处：它红，就是真的断链，不是「还没人填」。                            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/model-origins-20260813.ts --dry-run
 *   pnpm exec tsx --env-file=.env scripts/model-origins-20260813.ts
 * 退出码：0=全绿；1=有模型没补上（哪一个见输出）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 母题不是我挑的 —— 出处在生成器自己身上
 *
 * 混合运算七个模型的 dsl_ref 都指向 `七上有理数混合运算打卡/_源/qbank.py`，
 * 而该文件每个 `gen_*` 的 docstring 第一行都写着一个**范例题面**：
 *
 *     def gen_abs_chain(rng, lv):
 *         """加减链带绝对值：12+|-7|+18-15　[abs, sign]"""
 *
 * 逐条比对下来，其中 8 条与老册《七上计算合刊·有理数混合运算》的题面**逐字相同**
 * （qbank.py 头也自陈：「校准集 = 合刊 books/yls_hunhe.json（原册 200 题转录）」）。
 * 也就是说「这个生成器是照着哪道真题写出来的」是白纸黑字写在生成器里的，
 * 不需要谁凭手感指认。那 9 道老册题已由 005-D 投进库（kb:submit 走对象根形态，
 * 9/9 过闸⑧ 实算 + 逐行恒等 —— 顺带证了老册这 9 道的答案没错）。
 *
 * 绝对值模型「已知绝对值求数」的母题是库里 003 种子批就在的那道 `若 |x-3|=5`，
 * 它正是模板 `T1_shift(3,5)` 的形状；005-D 用同一个模板族出的 4 道变式挂在它下面。
 *
 * 🔴 **只补答得上来的**。整式/实数那几个模型的母题不在库里 —— 就空着。
 *    空着不是懒：它们眼下也没有生成题（origin 规矩只约束「已经在出题」的模型），
 *    等哪天要用它们出题，红灯会先把这件事顶出来。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";

import {
  ModelError,
  closeCoreDb,
  getCoreDb,
  getModel,
  matchKeyOfStem,
  setModelOrigins,
  type CoreDbHandle,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);

/** 老册（DSL 校准集）转录源：题面从这里逐字读，不在本文件里抄第二遍 */
const 老册 =
  "D:\\workplace\\ai-bkb\\举一反三产物\\打卡\\七上计算合刊\\_源\\books\\yls_hunhe.json";

/** 模型名 → 母题来路。老册题用 (day,no) 定位；库里已有的真题用题面全文定位。 */
const 血缘: {
  model: string;
  origins: (
    { 老册: [number, number]; why: string } | { stem: string; why: string }
  )[];
}[] = [
  {
    model: "符号处理（sign）",
    origins: [
      {
        老册: [3, 1],
        why: "gen_addsub_chain 的 docstring 范例「12+(-17)-(-3)」",
      },
    ],
  },
  {
    model: "绝对值脱号（abs）",
    origins: [
      { 老册: [1, 3], why: "gen_abs_chain 的 docstring 范例「12+|-7|+18-15」" },
    ],
  },
  {
    model: "乘方（pow）",
    origins: [
      { 老册: [1, 2], why: "gen_pow_mixed 的范例「(-1)^{2022}×2+(-2)^{3}÷4」" },
      {
        老册: [2, 1],
        why: "gen_bare_pow_chain 的范例「-1^{2022}-(-6)+2-3×(-1/3)」",
      },
    ],
  },
  {
    model: "运算律简算（dist）",
    origins: [
      { 老册: [1, 1], why: "gen_dist_forward 的范例「(1/9+1/6-1/4)×(-36)」" },
      {
        老册: [7, 1],
        why: "gen_div_by_unit_frac 的范例「(-1/4-2/5+1/10)÷(-1/20)」",
      },
    ],
  },
  {
    model: "分数小数（fracdec）",
    origins: [
      { 老册: [5, 1], why: "gen_dec_chain 的范例「7.4-8.2+6.6-10.8」" },
      {
        老册: [6, 1],
        why: "gen_frac_div 的范例（老册作 |2|，docstring 写成 |-2|，同题）",
      },
    ],
  },
  {
    model: "运算顺序（order）",
    origins: [
      {
        老册: [6, 1],
        why: "gen_frac_div 的范例（order 与 fracdec 共用这个生成器）",
      },
      { 老册: [10, 1], why: "gen_mixed_long 的范例「2^{3}×(1-1/4)×0.5」" },
    ],
  },
  {
    model: "括号嵌套（paren）",
    origins: [
      {
        老册: [10, 1],
        why: "gen_mixed_long 的范例（paren 的两个生成器里，只有它的范例在老册里找得到；gen_nested_paren 的范例老册没有）",
      },
    ],
  },
  {
    model: "已知绝对值求数",
    origins: [
      {
        stem: "若 |x-3|=5，则 x=________。",
        why: "模板 T1_shift(3,5) 的形状；005-D 的 4 道变式就是拿这一族模板换参出的",
      },
    ],
  },
];

// ---------------------------------------------------------------------------

interface 老册题 {
  q: string;
  a: string;
}

function 读老册(): Map<string, 老册题> {
  const raw = JSON.parse(readFileSync(老册, "utf8")) as {
    days: { day: number; sections: { items: 老册题[] }[] }[];
  };
  const m = new Map<string, 老册题>();
  for (const d of raw.days) {
    // 一天可能分节；题号在**节内**从 1 起（与 mk_母题料.py 的口径一致）
    for (const sec of d.sections) {
      for (const [i, it] of sec.items.entries()) {
        m.set(`${d.day}/${i + 1}`, it);
      }
    }
  }
  return m;
}

async function 按题面查(h: CoreDbHandle, stem: string): Promise<string | null> {
  const r = await h.client.execute({
    sql: "SELECT id FROM question WHERE match_key = ? AND status IN ('pending','active')",
    args: [matchKeyOfStem(stem)],
  });
  const row = r.rows[0] as unknown as { id: string } | undefined;
  return row ? String(row.id) : null;
}

async function 按名查模型(
  h: CoreDbHandle,
  name: string,
): Promise<{ id: string; status: string } | null> {
  const r = await h.client.execute({
    sql: "SELECT id, status FROM exam_model WHERE name = ?",
    args: [name],
  });
  const row = r.rows[0] as unknown as
    { id: string; status: string } | undefined;
  return row ? { id: String(row.id), status: String(row.status) } : null;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const h = await getCoreDb();
  const 册 = 读老册();

  say(杠);
  say(`给已在出题的模型补血缘上游${dryRun ? "（dry-run，零写）" : ""}`);
  say(杠);

  let 坏 = 0;
  for (const 条 of 血缘) {
    const m = await 按名查模型(h, 条.model);
    if (!m) {
      say(`🔴 模型「${条.model}」查无此行`);
      坏 += 1;
      continue;
    }
    const qids: string[] = [];
    const 说明: string[] = [];
    for (const o of 条.origins) {
      const stem =
        "老册" in o ? (册.get(`${o.老册[0]}/${o.老册[1]}`)?.q ?? "") : o.stem;
      if (!stem) {
        say(`🔴 「${条.model}」的母题在老册里定位不到：${JSON.stringify(o)}`);
        坏 += 1;
        continue;
      }
      const qid = await 按题面查(h, stem);
      if (!qid) {
        say(`🔴 「${条.model}」的母题不在库里（先投料）：${stem.slice(0, 50)}`);
        坏 += 1;
        continue;
      }
      qids.push(qid);
      说明.push(`${qid}  ${o.why}`);
    }
    if (qids.length === 0) continue;

    const 前 = await getModel(m.id, { handle: h });
    say(`· ${条.model}（${m.id}，${m.status}）`);
    say(
      `    生成题 ${前?.questionCount ?? 0} 道；origin ${前?.originQids.length ?? 0} → ${qids.length}`,
    );
    for (const s of 说明) say(`    ${s}`);

    if (dryRun) continue;
    try {
      const r = await setModelOrigins(m.id, qids, {
        by: "AI:PRD-005 · 005-D",
        handle: h,
      });
      say(`    ✓ 写入（seq=${r.seq}）`);
    } catch (e) {
      say(
        `    🔴 写失败：${e instanceof ModelError ? `[${e.code}] ${e.message}` : String(e)}`,
      );
      坏 += 1;
    }
  }

  say(杠);
  say(坏 === 0 ? "结论：全绿" : `结论：🔴 ${坏} 处有问题`);
  return 坏 === 0 ? 0 : 1;
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
