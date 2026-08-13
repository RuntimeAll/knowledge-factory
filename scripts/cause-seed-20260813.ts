/**
 * scripts/cause-seed-20260813.ts —— 错因域首铺（AI:PRD-006 · 006-C）
 *
 * ┌─ 🔴 一次性脚本 · 跑完即退役 ────────────────────────────────────────────┐
 * │ 用途：把产线错因词表（`订阅特训/_产线/err_kp.json` v1.0.0 七码）+ 群卷    │
 * │       题单的 diag 真句，人工整理成 error_cause 实体，并铺 err_code_map    │
 * │       复合键映射、kp_error 候选集、cause_example 诊断例题、roster 名册。 │
 * │ 幂等：错因按**名字**查库、映射按 (kp_id, err_code) 查库、例题按          │
 * │       (cause, question) 查库、roster 本就是 upsert —— 重跑不会长出第二份。│
 * │ 退役条件：首铺跑完且 `--verify` 全绿后，本文件只作**账**留着；日后新增   │
 * │       错因走 core 原语（createErrorCause / mapErrCode），别回来改它。    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/cause-seed-20260813.ts --probe   # 零写：只解析考点/例题并打表
 *   pnpm exec tsx --env-file=.env scripts/cause-seed-20260813.ts           # 首铺（错因+映射+候选集+例题+名册）
 *   pnpm exec tsx --env-file=.env scripts/cause-seed-20260813.ts --link    # 附带：人工补录桥 batch 24 → task 11
 * 退出码：0=全成；1=有条目没登上（哪一条见输出）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 四条口径（这一铺定的是「产线的码在哪个考点下是哪个错因」，铺错的代价见
 *    core/cause.ts 文件头：错因挂错考点 = 群错误率把两种能力并成一个数）
 *
 * ① **MaE55 不编**。需求卡写「error_cause（MaE55 + err_kp 七码人工整理为种子）」，
 *    但 006 备料六个搜索面全域零命中 MaE55 的实体定义（只有 PRD 文档里的名字引用）。
 *    所以种子只用**真数据**：err_kp v1.0.0 七码 + 群卷题单的 21 条 diag 真句。
 *    `seed_code` 一律写成指得回去的 `err_kp:v1.0.0/<code>`，🔴 绝不凭 "MaE55"
 *    这个名字编 55 个码。
 *
 * ② **dist 分居三个实体**（总指挥 2026-08-13 拍板）。产线词表 `scope` 自述只到
 *    「七上 有理数混合运算」，但把 dist 借给了整式线：
 *      混合运算线 dist = 运算律简算（分配律正逆用/提公因数/凑整）
 *      整式线     dist = 去括号（每项变号）／合并同类项
 *    已交付报告（洛天熙 第02天）印的是「合并同类项 6/6 ／ 去括号 8/8」，
 *    **不是**「运算律简算 14/14」—— 渲染层早就把它当两个实体在用了。
 *    err_code_map 是复合键 (kp_id, err_code)，这三居正是它存在的理由。
 *
 * ③ **映射只铺「有观察或有判例」的组合，没有的不预铺**。本铺的判据面有两层：
 *      判例层（出题侧）：群卷题单 `kp[]` 在**这道题**上声明了这个码，而这道题
 *                        在我方库里挂着**这个主考点** —— 一条一条指得回 t{task}#{no}；
 *      观察层（批改侧）：items.error_kp 真的出现过这个码（备料 error_kp实况统计.json）。
 *    只有判例层覆盖到的 (考点, 码) 才铺。**没观察没判例的组合一律不铺** ——
 *    等真数据来了，causeDistribution 的 unmapped 红旗会指路，那比预先猜一个准。
 *
 * ④ 🔴 **绝对值压轴线整条不铺**（6 个组合，全部 abs 码）。那条线的 abs 已经漂到
 *    「已知绝对值求数 / 求最值 / 非负性 / 几何意义 / 分类讨论 / |a|/a 型」六个语义，
 *    与词表自述的「脱号前先判正负」不是一回事；而且**批改侧从来没有一条 abs
 *    落在这条线上**（唯一的 abs 观察在混合运算摸底卷 batch 6）。
 *    没有语义正本就铺，等于把六种不同的不会并成一个数。留给 unmapped 红旗指路。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 学员一律**代号**（roster 那一节），真名零落盘。
 */
import {
  CauseError,
  SkuError,
  addCauseExample,
  closeCoreDb,
  createErrorCause,
  getCoreDb,
  getGradingDb,
  linkGradingBatch,
  mapErrCode,
  mapKpError,
  upsertRoster,
  type CoreDbHandle,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);

const 探 = process.argv.includes("--probe");
const 补桥 = process.argv.includes("--link") || !探;

// ---------------------------------------------------------------------------
// 一、错因实体（9 条 = 七码 6 单义 + dist 三居）
// ---------------------------------------------------------------------------

interface 错因条目 {
  /** 脚本内的引用键（不入库） */
  key: string;
  name: string;
  desc: string;
  seedCode: string;
}

/** 🔴 desc 全部从群卷题单的 diag 真句浓缩（备料 §三 21 条），不自造话术 */
const 错因: 错因条目[] = [
  {
    key: "sign",
    name: "符号处理错误（变号/漏负号）",
    desc:
      "加减乘除中的正负号判定：去括号变号、连减化加、乘除号数奇偶。" +
      "题单 diag 真句：「减负变加」没形成条件反射；多项连算时符号跟丢；连续两个减负号时丢负。" +
      "批改观察：全库 11 个 sign 码次（batch 3/6/10/20），是最密的一个码。",
    seedCode: "err_kp:v1.0.0/sign",
  },
  {
    key: "order",
    name: "运算顺序错误（先乘方、再乘除、后加减）",
    desc:
      "同级从左到右，有括号先算括号。" +
      "题单 diag 真句：先乘除后加减的顺序乱；中括号与乘法的先后顺序乱；" +
      "嵌套综合：先小括号、再中括号、最后乘。",
    seedCode: "err_kp:v1.0.0/order",
  },
  {
    key: "pow",
    name: "乘方符号判定错误（(-a)ⁿ 与 -aⁿ 分不清）",
    desc:
      "底数带不带括号、指数奇偶，决定结果的正负。" +
      "题单 diag 真句：🔴 -1ⁿ 与 (-1)ⁿ 分不清（对照第7题）；负底数偶次幂的符号判断；负底数奇次幂的符号判断。" +
      '批改判例：batch 10 qno 7 —— 第1行把 (-1)^2026 化成 -1（error_kp=["pow"]，判 ×）。',
    seedCode: "err_kp:v1.0.0/pow",
  },
  {
    key: "abs",
    name: "绝对值脱号错误（脱号前没判正负）",
    desc:
      "先判断绝对值内部的正负再脱号，脱号后的连减/连加处理。" +
      "题单 diag 真句：绝对值脱号后的连减出错；脱号时把里面的负号一起带出来了；绝对值与减负号叠加时崩。" +
      "🔴 适用面 = **七上混合运算线**（词表自述 scope）。绝对值压轴线的 abs 是另一回事" +
      "（几何意义/最值/非负性/分类讨论），本铺不给它映射，见文件头口径④。",
    seedCode: "err_kp:v1.0.0/abs",
  },
  {
    key: "fracdec",
    name: "分数小数运算错误（通分约分/化倒数/带分数）",
    desc:
      "分数与小数互化、通分约分、带分数化假分数后再运算。" +
      "题单 diag 真句：异分母分数加减：通分或约分出错；除以分数没转成乘倒数；乘方×括号×小数的长链衔接。",
    seedCode: "err_kp:v1.0.0/fracdec",
  },
  {
    key: "paren",
    name: "括号嵌套拆解错误（层层变号漏一层）",
    desc:
      "小括号→中括号→大括号逐层拆解，层层变号一个不漏。" +
      "题单 diag 真句：中括号与乘法的先后顺序乱；嵌套 + 首项是负数时崩；嵌套综合：先小括号、再中括号、最后乘。",
    seedCode: "err_kp:v1.0.0/paren",
  },
  {
    key: "dist_mix",
    name: "运算律简算错误（分配律正逆用/提公因数/凑整）",
    desc:
      "该简算的不硬算：分配律正用逆用、提公因数、凑整交换结合。" +
      "题单 diag 真句：提公因数的逆用意识缺；分配律正用不熟，先通分硬算；没有凑整意识，小数一路硬算；" +
      "除以 -1/20 没看出等于乘 -20。" +
      "批改判例：batch 6 qno 17（-99又35/36×18）带分数拆错，把整数部分与分数部分变成相乘。" +
      "🔴 这是 dist 在**混合运算线**的语义，与词表 desc 一致。",
    seedCode: "err_kp:v1.0.0/dist",
  },
  {
    key: "dist_paren",
    name: "去括号漏变号（括号前是负号时每一项都要变号）",
    desc:
      "🔴 借码史：产线 err_kp v1.0.0 的 scope 自述只到「七上 有理数混合运算」，" +
      "整式的加减线把 dist 借去表示「去括号」。整式线题单 140 题次 dist 的 diag **全是空串**，" +
      "语义据题单 kp_group/anchor=「去括号」(80 题次) + 产线 render_feedback._mastery() " +
      "在有效码<3 时退到 kp_group 重算的实现反推。" +
      "已交付报告（洛天熙 第02天学情分析.png）印的是「去括号 8/8 掌握」，不是「运算律简算」。",
    seedCode: "err_kp:v1.0.0/dist#整式-去括号",
  },
  {
    key: "dist_merge",
    name: "合并同类项错误（只并同字母同指数项，系数带符号相加）",
    desc:
      "🔴 借码史：同上，整式线借 dist 表示「合并同类项」（题单 kp_group/anchor，60 题次，diag 全空）。" +
      '批改判例：batch 14 qno 1（-15x+24y+15x-30y）error_kp=["dist"]，' +
      "note「抄题行末项抄成 -36y（题面为 -30y）；但末答 -6y 与按 -30y 计算一致」。" +
      "已交付报告（洛天熙 第02天）印的是「合并同类项 6/6 掌握」。",
    seedCode: "err_kp:v1.0.0/dist#整式-合并同类项",
  },
];

// ---------------------------------------------------------------------------
// 二、err_code_map 映射（28 条，复合键 (kp_id, err_code)）
// ---------------------------------------------------------------------------

interface 映射条目 {
  /** 🔴 用 kp_id 落，name 只作**自检**：跑的时候比对，对不上当场红 */
  kpId: string;
  kpName: string;
  code: string;
  /** 错因条目的 key */
  cause: string;
  /** 🔴 依据：判例（题单声明）+ 观察（批改侧真码），一条一条指得回去 */
  据: string;
}

const 映射: 映射条目[] = [
  // ── 七上混合运算线（词表自述 scope 之内，26 条） ────────────────────────
  {
    kpId: "kp_01KZV2HDVEVZVKT3R83JZCSQWJ",
    kpName: "有理数的加减混合运算",
    code: "sign",
    cause: "sign",
    据: '判例 t1#1/#2/#3（kp=["sign"], kp_group=有理数加减, diag「减负变加没形成条件反射」/「多项连算时符号跟丢」/「连续两个减负号时丢负」），全线 30 题次 days1-10',
  },
  {
    kpId: "kp_01KZV2HDVE28P0JJA3JE41WDCY",
    kpName: "含绝对值的有理数混合运算",
    code: "abs",
    cause: "abs",
    据: '判例 t1#4/#5/#6（kp=["abs","sign"], kp_group=绝对值, diag「绝对值脱号后的连减出错」等），全线 30 题次 days1-10',
  },
  {
    kpId: "kp_01KZV2HDVE28P0JJA3JE41WDCY",
    kpName: "含绝对值的有理数混合运算",
    code: "sign",
    cause: "sign",
    据: "判例 t1#4/#5/#6 同题并挂 sign（diag「脱号时把里面的负号一起带出来了」= 符号处理），全线 30 题次",
  },
  {
    kpId: "kp_01KZV2HDVE3M2NXG06H81MN2E4",
    kpName: "有理数乘方的运算与符号判定",
    code: "pow",
    cause: "pow",
    据: '🔴 观察：batch 10 qno 7 error_kp=["pow"] 判 ×（备料三条 unmapped 之一）＋判例 t1#7/#8/#9（kp含pow, kp_group=乘方, diag「-1ⁿ与(-1)ⁿ分不清」），全线 30 题次',
  },
  {
    kpId: "kp_01KZV2HDVE3M2NXG06H81MN2E4",
    kpName: "有理数乘方的运算与符号判定",
    code: "order",
    cause: "order",
    据: "判例 t1#7/#8/#9 同题并挂 order（乘方后接 ×/÷ 的先后顺序），全线 30 题次",
  },
  {
    kpId: "kp_01KZV2HDVE3M2NXG06H81MN2E4",
    kpName: "有理数乘方的运算与符号判定",
    code: "sign",
    cause: "sign",
    据: "判例 t1#7/#8/#9 同题并挂 sign（负底数定号），全线 30 题次",
  },
  {
    kpId: "kp_01KZV2HDVEV9RE149MEKGHX8ZD",
    kpName: "分数与小数混合的有理数运算",
    code: "fracdec",
    cause: "fracdec",
    据: "判例 t1#10/#11/#12（kp含fracdec, kp_group=小数运算与简算/分数运算, diag「异分母分数加减：通分或约分出错」），全线 30 题次；🔴 观察：batch 6×3 / 16×1 / 20×2 共 6 个 fracdec 码次",
  },
  {
    kpId: "kp_01KZV2HDVEV9RE149MEKGHX8ZD",
    kpName: "分数与小数混合的有理数运算",
    code: "sign",
    cause: "sign",
    据: "判例 t1#10/#12 同题并挂 sign，全线 20 题次",
  },
  {
    kpId: "kp_01KZV2HDVEV9RE149MEKGHX8ZD",
    kpName: "分数与小数混合的有理数运算",
    code: "dist",
    cause: "dist_mix",
    据: "🔴 dist 三居之一（混合运算侧）：判例 t1#10（4.6-3.4+12.4-6.6, kp_group=小数运算与简算, diag「没有凑整意识，小数一路硬算」），全线 10 题次",
  },
  {
    kpId: "kp_01KZV2HDVEV9RE149MEKGHX8ZD",
    kpName: "分数与小数混合的有理数运算",
    code: "order",
    cause: "order",
    据: '判例 t1#11（8×(-4)+|-6|÷(3/7), kp=["order","abs","fracdec"], diag「除以分数没转成乘倒数」），全线 10 题次',
  },
  {
    kpId: "kp_01KZV2HDVEV9RE149MEKGHX8ZD",
    kpName: "分数与小数混合的有理数运算",
    code: "abs",
    cause: "abs",
    据: "判例 t1#11 同题并挂 abs（题面含 |-6|），全线 10 题次",
  },
  {
    kpId: "kp_01KZV2HDVEVDK9E0WWDVPEHQRF",
    kpName: "有理数运算的简便技巧",
    code: "dist",
    cause: "dist_mix",
    据: "🔴🔴 dist 三居之主（6-3 双行回执的混合运算侧）：判例 t1#13/#14/#15（kp_group=运算律简算, diag「提公因数的逆用意识缺」「分配律正用不熟，先通分硬算」），全线 30 题次；产线固化卷 qun_fixed.py:148 亦写 kp=('dist',) diag=提公因数的逆用意识缺",
  },
  {
    kpId: "kp_01KZV2HDVEVDK9E0WWDVPEHQRF",
    kpName: "有理数运算的简便技巧",
    code: "fracdec",
    cause: "fracdec",
    据: "判例 t1#13/#15 同题并挂 fracdec（(1/2+1/3)×(-36) 需通分或分配），全线 20 题次",
  },
  {
    kpId: "kp_01KZV2HDVEVDK9E0WWDVPEHQRF",
    kpName: "有理数运算的简便技巧",
    code: "paren",
    cause: "paren",
    据: "判例 t1#13/#15 同题并挂 paren（括号内先通分再分配），全线 20 题次",
  },
  {
    kpId: "kp_01KZV2HDVEVDK9E0WWDVPEHQRF",
    kpName: "有理数运算的简便技巧",
    code: "sign",
    cause: "sign",
    据: "判例 t1#15（(1/4+1/10)÷(-1/20), diag「除以 -1/20 没看出等于乘 -20」并挂 sign），全线 10 题次",
  },
  {
    kpId: "kp_01KZV2HDVEM4C37Q3WBA0KA3QC",
    kpName: "多重括号的有理数运算",
    code: "paren",
    cause: "paren",
    据: '判例 t1#16/#17（kp=["paren","order","sign"], kp_group=括号嵌套, diag「中括号与乘法的先后顺序乱」「嵌套+首项是负数时崩」），全线 28 题次',
  },
  {
    kpId: "kp_01KZV2HDVEM4C37Q3WBA0KA3QC",
    kpName: "多重括号的有理数运算",
    code: "order",
    cause: "order",
    据: "判例 t1#16/#17 同题并挂 order，全线 28 题次",
  },
  {
    kpId: "kp_01KZV2HDVEM4C37Q3WBA0KA3QC",
    kpName: "多重括号的有理数运算",
    code: "sign",
    cause: "sign",
    据: '🔴 观察：batch 10 qno 17 error_kp=["sign"] 判 ×（备料三条 unmapped 之一，报告诊断「-14-17×3 应得 -65，学生写成 65，漏负号」）＋判例 t1#16/#17 同题并挂 sign，全线 21 题次',
  },
  {
    kpId: "kp_01KZV2HDVEM4C37Q3WBA0KA3QC",
    kpName: "多重括号的有理数运算",
    code: "fracdec",
    cause: "fracdec",
    据: "判例 t11#10 等（days 3-9 的嵌套题并挂 fracdec），全线 7 题次",
  },
  {
    kpId: "kp_01KZV2HDVEM4C37Q3WBA0KA3QC",
    kpName: "多重括号的有理数运算",
    code: "pow",
    cause: "pow",
    据: "判例 t11#10 等（days 3-9 的嵌套题并挂 pow），全线 7 题次",
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "order",
    cause: "order",
    据: "判例 t1#18/#19/#20（kp_group=综合混合, diag「先乘除后加减的顺序乱」「嵌套综合：先小括号、再中括号、最后乘」），全线 22 题次",
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "paren",
    cause: "paren",
    据: "判例 t1#18/#20 同题并挂 paren，全线 12 题次",
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "sign",
    cause: "sign",
    据: '判例 t1#20（17-[8-(8-4)]×4, kp=["paren","order","sign"]），days1-2 共 2 题次',
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "pow",
    cause: "pow",
    据: "判例 t1#18（4²×(1-1/2)×0.75, kp含pow, diag「乘方×括号×小数的长链衔接」），全线 10 题次",
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "fracdec",
    cause: "fracdec",
    据: "判例 t1#18/#19 同题并挂 fracdec，全线 20 题次",
  },
  {
    kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ",
    kpName: "有理数的混合运算",
    code: "abs",
    cause: "abs",
    据: '判例 t1#19（2×(-9)+|-6|÷(6/5), kp=["order","abs","fracdec"]），全线 10 题次',
  },

  // ── 整式的加减线（🔴 借码，dist 二居） ──────────────────────────────────
  {
    kpId: "kp_01KZV2HDVDJY3KCMKTYYX43BAN",
    kpName: "合并同类项",
    code: "dist",
    cause: "dist_merge",
    据: '🔴🔴 观察：batch 14 qno 1 error_kp=["dist"]（备料三条 unmapped 之一，6-3 正主）＋判例 t2#1~#6（kp=["dist"], kp_group=anchor=合并同类项），全线 60 题次 days1-10',
  },
  {
    kpId: "kp_01KZV2HDVDN8VZMBVAB0K55MY5",
    kpName: "去括号法则",
    code: "dist",
    cause: "dist_paren",
    据: '🔴 判例 t2#7~#14（kp=["dist"], kp_group=anchor=去括号），全线 80 题次 days1-10；已交付报告（洛天熙 第02天）印「去括号 8/8」。🔴 遗留 C6：库里另有一条「去括号」(kp_01KZV2HDVFGEGRKNRYQ03SW6CP) 疑似重复，但**没有任何题挂它**，故本铺只落「去括号法则」',
  },
];

// ---------------------------------------------------------------------------
// 三、cause_example 诊断例题（按 t{task}#{no} 定位，运行时解析成 question_id）
// ---------------------------------------------------------------------------

interface 例题条目 {
  cause: string;
  task: number;
  no: number;
  据: string;
}

const 例题: 例题条目[] = [
  { cause: "sign", task: 1, no: 1, 据: "diag「减负变加」没形成条件反射" },
  { cause: "sign", task: 1, no: 2, 据: "diag 多项连算时符号跟丢" },
  { cause: "sign", task: 1, no: 3, 据: "diag 连续两个减负号时丢负" },

  { cause: "order", task: 1, no: 19, 据: "diag 先乘除后加减的顺序乱" },
  { cause: "order", task: 1, no: 16, 据: "diag 中括号与乘法的先后顺序乱" },

  {
    cause: "pow",
    task: 1,
    no: 7,
    据: "diag 负底数偶次幂的符号判断（对照第9题）；🔴 batch 10 qno 7 真错题",
  },
  {
    cause: "pow",
    task: 1,
    no: 9,
    据: "diag 🔴 -1ⁿ 与 (-1)ⁿ 分不清（对照第7题）",
  },
  { cause: "pow", task: 1, no: 8, 据: "diag 负底数奇次幂的符号判断" },

  { cause: "abs", task: 1, no: 4, 据: "diag 绝对值脱号后的连减出错" },
  { cause: "abs", task: 1, no: 5, 据: "diag 脱号时把里面的负号一起带出来了" },
  { cause: "abs", task: 1, no: 6, 据: "diag 绝对值与减负号叠加时崩" },

  {
    cause: "fracdec",
    task: 1,
    no: 12,
    据: "diag 异分母分数加减：通分或约分出错",
  },
  { cause: "fracdec", task: 1, no: 11, 据: "diag 除以分数没转成乘倒数" },

  { cause: "paren", task: 1, no: 17, 据: "diag 嵌套 + 首项是负数时崩" },
  {
    cause: "paren",
    task: 1,
    no: 20,
    据: "diag 嵌套综合：先小括号、再中括号、最后乘",
  },

  { cause: "dist_mix", task: 1, no: 14, 据: "diag 提公因数的逆用意识缺" },
  { cause: "dist_mix", task: 1, no: 13, 据: "diag 分配律正用不熟，先通分硬算" },
  { cause: "dist_mix", task: 1, no: 10, 据: "diag 没有凑整意识，小数一路硬算" },

  {
    cause: "dist_paren",
    task: 2,
    no: 10,
    据: "3(a²-3a)-(3a²-5a)+2 —— 括号前是「-」，最典型的漏变号靶子（kp_group=去括号）",
  },
  {
    cause: "dist_paren",
    task: 2,
    no: 14,
    据: "3(m-5n)-[2(m+n-2)-5(n+3)] —— 中括号套小括号两层变号（kp_group=去括号）",
  },
  {
    cause: "dist_paren",
    task: 2,
    no: 7,
    据: "-4(2y²+3x²)+3(3y²+4x²) —— 负系数分配到每一项（kp_group=去括号）",
  },

  {
    cause: "dist_merge",
    task: 2,
    no: 1,
    据: '🔴 batch 14 qno 1 真判例（-15x+24y+15x-30y，error_kp=["dist"]，kp_group=合并同类项）',
  },
  {
    cause: "dist_merge",
    task: 2,
    no: 5,
    据: "3a²-4ab-6b²-10a²+7ab+15b² —— 同字母同指数才算同类项（kp_group=合并同类项）",
  },
  {
    cause: "dist_merge",
    task: 2,
    no: 3,
    据: "8a-5b+2-17a+21b-6 —— 常数项也要合并、系数带符号相加（kp_group=合并同类项）",
  },
];

// ---------------------------------------------------------------------------
// 四、roster 学员名册（🔴 只落代号）
// ---------------------------------------------------------------------------

const 名册 = [
  { code: "recho", joinedAt: "2026-08-12T19:02:55", 首卷: "其他 第1天" },
  {
    code: "小崽子",
    joinedAt: "2026-08-11T00:46:45",
    首卷: "有理数混合运算打卡·第一天",
  },
  {
    code: "洛天熙",
    joinedAt: "2026-08-11T22:18:07",
    首卷: "七上混合运算 第1天",
  },
  {
    code: "鼻涕虫",
    joinedAt: "2026-08-11T00:46:45",
    首卷: "有理数混合运算打卡·第二天",
  },
];

// ---------------------------------------------------------------------------
// 五、人工补录桥（batch 24 → task 11）—— 证据链在 note 里，跑之前机器复验
// ---------------------------------------------------------------------------

const 补录 = {
  batchId: 24,
  taskId: 11,
  note:
    "AI:PRD-006 006-C 人工补录：batch 24（小崽子 第4次打卡, auto=L1静默, 20 题）无 slots 行" +
    "（直批链不写 slots，是结构性断链），但 items.qtext 与 task 11 = 群打卡第01期·七上混合运算·day3 的题单" +
    "**逐位 20/20 全等**（经 \\frac 归一后同位比对，脚本 cause-seed-20260813.ts 落库前现算复验）。" +
    "题数、题序、题面三重吻合，故补桥。",
};

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

/** \frac{a}{b} → (a/b)，题面比对前的归一（备料实证：不做这步会报 9 处假红） */
function defrac(s: string): string {
  let t = s;
  const re = /\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/;
  for (let i = 0; i < 12; i++) {
    const m = re.exec(t);
    if (!m) break;
    t =
      t.slice(0, m.index) +
      `(${m[1]}/${m[2]})` +
      t.slice(m.index + m[0].length);
  }
  return t;
}

function 归一(s: string): string {
  let t = defrac(s ?? "");
  for (const w of ["\\left", "\\right", "\\displaystyle"])
    t = t.split(w).join("");
  t = t.split("\\times").join("*");
  t = t.split("\\div").join("/");
  t = t.split("\\cdot").join("*");
  t = t.split("×").join("*");
  t = t.split("÷").join("/");
  t = t.split("−").join("-");
  t = t.split("－").join("-");
  return t.replace(/[{}()[\]\s^_$\\]/g, "").trim();
}

async function 行(h: CoreDbHandle, sql: string, args: unknown[] = []) {
  const r = await h.client.execute({ sql, args: args as never[] });
  return r.rows as unknown as Record<string, unknown>[];
}

let 失败 = 0;

async function main(): Promise<void> {
  const h = await getCoreDb();
  say(杠);
  say(
    `AI:PRD-006 · 006-C 错因域首铺${探 ? "（--probe 零写）" : ""}  ${new Date().toISOString()}`,
  );
  say(杠);

  // ── 0. 前置自检：考点 id ↔ 名字必须对得上（防 id 抄错/库漂移） ──────────
  say("\n【0】考点自检（kp_id ↔ 名字）");
  const 涉及 = [...new Set(映射.map((m) => m.kpId))];
  for (const id of 涉及) {
    const r = await 行(h, "SELECT name, status FROM kp WHERE id = ?", [id]);
    const 期望 = 映射.find((m) => m.kpId === id)!.kpName;
    if (!r[0]) {
      say(`  ✗ ${id} 查无此考点（期望「${期望}」）`);
      失败 += 1;
      continue;
    }
    const got = String(r[0].name);
    const st = String(r[0].status);
    if (got !== 期望 || st !== "active") {
      say(`  ✗ ${id} 实况「${got}」/${st}，期望「${期望}」/active`);
      失败 += 1;
    } else {
      say(`  ✓ ${期望}`);
    }
  }
  if (失败 > 0) {
    say("\n🔴 考点自检没过，拒绝往下写（挂错考点比挂错一道题影响面大）。");
    process.exitCode = 1;
    await closeCoreDb();
    return;
  }

  // ── 1. 例题定位：t{task}#{no} → question_id ────────────────────────────
  say("\n【1】例题定位（task#no → sku_item.ord → question_id）");
  const tm = await 行(h, "SELECT task_id, sku_id FROM grading_task_map");
  const taskToSku = new Map(
    tm.map((r) => [Number(r.task_id), String(r.sku_id)]),
  );
  const 例题id = new Map<string, string>();
  for (const e of 例题) {
    const sid = taskToSku.get(e.task);
    if (!sid) {
      say(`  ✗ task ${e.task} 没登记 sku（grading_task_map 里查无）`);
      失败 += 1;
      continue;
    }
    const r = await 行(
      h,
      "SELECT question_id FROM sku_item WHERE sku_id=? AND ord=?",
      [sid, e.no],
    );
    const qid = r[0]?.question_id;
    if (typeof qid !== "string" || qid === "") {
      say(`  ✗ t${e.task}#${e.no} 在册子里没有对位的题`);
      失败 += 1;
      continue;
    }
    例题id.set(`${e.cause}|${e.task}|${e.no}`, qid);
  }
  say(`  定位到 ${例题id.size}/${例题.length} 道例题`);

  // ── 2. 补录桥的证据复验（落库前现算，不信备料信机器） ──────────────────
  let 桥可补 = false;
  if (补桥) {
    say("\n【2】补录桥证据复验（batch 24 ⟷ task 11 题面逐位比对）");
    const g = await getGradingDb();
    const sid = taskToSku.get(补录.taskId);
    const 题 = await 行(
      h,
      "SELECT si.ord ord, q.stem stem FROM sku_item si JOIN question q ON q.id=si.question_id WHERE si.sku_id=?",
      [sid ?? ""],
    );
    const 位 = new Map(题.map((r) => [Number(r.ord), 归一(String(r.stem))]));
    const its = g.query<{ qno: number; qtext: string | null }>(
      "SELECT qno, qtext FROM items WHERE batch_id=? ORDER BY qno",
      [补录.batchId],
    );
    let 同 = 0;
    for (const it of its)
      if (位.get(Number(it.qno)) === 归一(String(it.qtext ?? ""))) 同 += 1;
    桥可补 = its.length > 0 && 同 === its.length;
    say(
      `  题面同位一致 ${同}/${its.length} → ${桥可补 ? "✓ 证据成立，可补" : "✗ 证据不足，不补（如实报）"}`,
    );
  }

  if (探) {
    say("\n【--probe】零写模式：解析全通过，未写一行。");
    say(细);
    say(
      `错因 ${错因.length} 条 / 映射 ${映射.length} 条 / 例题 ${例题.length} 条 / 名册 ${名册.length} 条 / 补桥 ${桥可补 ? "1" : "0"} 条`,
    );
    await closeCoreDb();
    return;
  }

  // ── 3. 错因实体 ────────────────────────────────────────────────────────
  say("\n【3】error_cause 建实体（按名字幂等）");
  const causeId = new Map<string, string>();
  for (const c of 错因) {
    const 旧 = await 行(h, "SELECT id FROM error_cause WHERE name = ?", [
      c.name,
    ]);
    if (旧[0]) {
      causeId.set(c.key, String(旧[0].id));
      say(`  = 已存在 ${c.name}  (${String(旧[0].id)})`);
      continue;
    }
    const r = await createErrorCause({
      name: c.name,
      desc: c.desc,
      seedCode: c.seedCode,
      actor: "human",
    });
    causeId.set(c.key, r.causeId);
    say(`  + ${c.name}  (${r.causeId})  seed=${c.seedCode}`);
  }

  // ── 4. err_code_map（复合键，MAP_TAKEN 不覆写） ─────────────────────────
  say("\n【4】err_code_map 铺映射（mapped_by='human'）");
  let 新映射 = 0;
  for (const m of 映射) {
    const cid = causeId.get(m.cause);
    if (!cid) {
      say(`  ✗ 错因 key「${m.cause}」没建出来`);
      失败 += 1;
      continue;
    }
    const 旧 = await 行(
      h,
      "SELECT cause_id FROM err_code_map WHERE kp_id=? AND err_code=?",
      [m.kpId, m.code],
    );
    if (旧[0]) {
      const 同 = String(旧[0].cause_id) === cid;
      say(
        `  ${同 ? "=" : "✗"} 已映射 (${m.kpName}, ${m.code}) → ${同 ? "同一错因，跳过" : "🔴 别的错因！改判走 unmapErrCode"}`,
      );
      if (!同) 失败 += 1;
      continue;
    }
    try {
      await mapErrCode(m.kpId, m.code, cid, { by: "human", actor: "human" });
      新映射 += 1;
      say(
        `  + (${m.kpName}, ${m.code}) → ${错因.find((c) => c.key === m.cause)!.name}`,
      );
    } catch (e) {
      失败 += 1;
      say(
        `  ✗ (${m.kpName}, ${m.code}) 失败：${e instanceof CauseError ? `${e.code} ${e.message}` : String(e)}`,
      );
    }
  }

  // ── 5. kp_error 候选集（= 映射去重后的 (考点, 错因) 对） ────────────────
  say("\n【5】kp_error 候选集（判错因候选 = 主考点挂载集）");
  const 对 = new Map<string, { kpId: string; kpName: string; cause: string }>();
  for (const m of 映射) 对.set(`${m.kpId}|${m.cause}`, m);
  let 新候选 = 0;
  for (const p of 对.values()) {
    const cid = causeId.get(p.cause)!;
    const 旧 = await 行(
      h,
      "SELECT 1 AS x FROM kp_error WHERE kp_id=? AND cause_id=?",
      [p.kpId, cid],
    );
    if (旧[0]) continue;
    try {
      await mapKpError(p.kpId, cid, { actor: "human" });
      新候选 += 1;
    } catch (e) {
      失败 += 1;
      say(`  ✗ (${p.kpName} ← ${p.cause}) 失败：${String(e)}`);
    }
  }
  say(`  候选集 ${对.size} 对，本次新挂 ${新候选} 条`);

  // ── 6. cause_example 诊断例题（软闸：不足 2 道只提示） ──────────────────
  say("\n【6】cause_example 诊断例题");
  let 新例 = 0;
  for (const e of 例题) {
    const cid = causeId.get(e.cause);
    const qid = 例题id.get(`${e.cause}|${e.task}|${e.no}`);
    if (!cid || !qid) continue;
    const 旧 = await 行(
      h,
      "SELECT 1 AS x FROM cause_example WHERE cause_id=? AND question_id=?",
      [cid, qid],
    );
    if (旧[0]) continue;
    try {
      const r = await addCauseExample(cid, qid, { actor: "human" });
      新例 += 1;
      for (const w of r.warnings) say(`     ⚠ ${w}`);
    } catch (err) {
      失败 += 1;
      say(`  ✗ ${e.cause} ← t${e.task}#${e.no}：${String(err)}`);
    }
  }
  for (const c of 错因) {
    const n = await 行(
      h,
      "SELECT COUNT(*) AS c FROM cause_example WHERE cause_id=?",
      [causeId.get(c.key)!],
    );
    const cnt = Number(n[0]!.c);
    say(`  ${cnt >= 2 ? "✓" : "⚠"} ${c.name}：${cnt} 道例题`);
  }
  say(`  本次新挂 ${新例} 条`);

  // ── 7. roster ──────────────────────────────────────────────────────────
  say("\n【7】roster 学员名册（🔴 只落代号）");
  for (const s of 名册) {
    const r = await upsertRoster({
      code: s.code,
      grade: "初一",
      editionCtx: "七上",
      status: "active",
      joinedAt: s.joinedAt,
      note:
        `订阅特训群打卡学员；grade 抄 订阅特训/学员/<代号>/肖像/状态.json(grade=初一, source=群打卡, 首卷「${s.首卷}」)；` +
        "edition_ctx 抄 sku「群打卡第01期」的 edition_ctx=七上（🔴 产线未声明教材版本，人教/浙教不编）。",
      actor: "human",
    });
    say(
      `  ${r.created ? "+" : "="} ${r.code}  grade=${r.grade} edition=${r.editionCtx} joined=${r.joinedAt}`,
    );
  }

  // ── 8. 补录桥 ──────────────────────────────────────────────────────────
  if (补桥) {
    say("\n【8】人工补录桥");
    if (!桥可补) {
      say("  ✗ 证据不足，不补（见【2】）");
    } else {
      try {
        const r = await linkGradingBatch(补录.batchId, 补录.taskId, {
          note: 补录.note,
          actor: "human",
        });
        say(
          `  + batch ${r.batchId} → task ${r.taskId}（${r.batch.student ?? "?"} 第${r.batch.day ?? "?"}次打卡）`,
        );
      } catch (e) {
        if (e instanceof SkuError && e.code === "BATCH_TAKEN") {
          say(`  = batch ${补录.batchId} 已补录过，跳过`);
        } else {
          失败 += 1;
          say(`  ✗ 补录失败：${String(e)}`);
        }
      }
    }
  }

  // ── 9. 收尾统计 ────────────────────────────────────────────────────────
  say("\n" + 细);
  for (const t of [
    "error_cause",
    "kp_error",
    "cause_example",
    "err_code_map",
    "roster",
    "grading_batch_link",
  ]) {
    const r = await 行(h, `SELECT COUNT(*) AS c FROM ${t}`);
    say(`  ${t.padEnd(20)} ${String(r[0]!.c).padStart(4)} 行`);
  }
  say(细);
  say(
    失败 === 0
      ? `✅ 首铺完成：新映射 ${新映射} / 新候选 ${新候选} / 新例题 ${新例}`
      : `🔴 有 ${失败} 条没登上，见上文 ✗`,
  );
  process.exitCode = 失败 === 0 ? 0 : 1;
  await closeCoreDb();
}

await main();
