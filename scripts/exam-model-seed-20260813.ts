/**
 * scripts/exam-model-seed-20260813.ts —— exam_model 首铺（AI:PRD-005 · 005-C）
 *
 * ┌─ 🔴 一次性脚本 · 跑完即退役 ────────────────────────────────────────────┐
 * │ 用途：把「在售四子树」躺在各册 `_源/qbank.py` 里的 26 个考察模型候选     │
 * │       （备料 §2 的 `exam_model-首铺清单.json`）一次性登进 exam_model。   │
 * │ 幂等：按**模型名**查库，已登记的跳过 —— 重跑不会长出第二份。            │
 * │ 退役条件：首铺跑完且 SELECT 清单核对无误后，本文件只作**账**留着，       │
 * │           日后新增模型走 `proposeModel` + 治理页人工转正，别回来改它。   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/exam-model-seed-20260813.ts --probe   # 只解析考点，零写入
 *   pnpm exec tsx --env-file=.env scripts/exam-model-seed-20260813.ts --alias   # 只补别名（幂等）
 *   pnpm exec tsx --env-file=.env scripts/exam-model-seed-20260813.ts           # 补别名 + 提议 + 转正
 * 退出码：0=全成；1=有条目没登上（哪一条见输出）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条口径（这一铺定的是「模型挂在哪个考点下」，挂错的代价见 core/model.ts）
 *
 * ① **考点一律用 002 词表的正名**，不用备料的预估名。
 *    备料自己写明「kp_name 为【预估】，002 词表本次侦察红线禁碰」——预估名里
 *    有一半对不上正名（`非负数之和为零` vs `绝对值的性质与非负性`），
 *    还有一路是**歧义**的：err 码 `sign` 同时挂在「有理数的加减混合运算」与
 *    「有理数的加法法则」两个考点上，resolve 会红 `KP_AMBIGUOUS`（这正是它该做的）。
 *    正名是唯一的，写进表里一眼可核；预估名连同「为什么落到这个正名」记在
 *    `kpRefWhy` 里，不藏账。
 *
 * ② **预估名里那些「产线真在用、词表确实缺」的说法，补成别名**（见 ALIASES）。
 *    补别名不是为了本次能跑通（本次用正名就跑通了），是为了**下一次**：
 *    产线下回再说「非负数之和为零」，得能自己 resolve 得出来，而不是又来一轮人工映射。
 *    每条都带 audit note 写出处，谁补的、依据哪一行，查得到。
 *
 * ③ **归不了位的如实跳过，绝不硬挂**（见 SKIPPED）。
 *    三上混合运算那 4 个模型是**小学**内容，而 002 词表 415 条 `grade_band` 全是
 *    「初中」——一条小学考点都没有。把小学出题器挂到初中「有理数的混合运算」下，
 *    等于此后按这个考点召回模型时会召回一族小学表内乘除的生成器，
 *    正是 core/model.ts 文件头说的「挂错考点比挂错一道题影响面大得多」。
 *    所以：不挂、不编、如实记账，等 002 补小学学段再回来铺。
 * ════════════════════════════════════════════════════════════════════════════
 */
import {
  ModelError,
  activateModel,
  addKpAlias,
  closeCoreDb,
  getCoreDb,
  proposeModel,
  resolveKp,
  resolveKpRef,
} from "../src/core/index";
import { examModel } from "../src/server/db/schema";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);

/** 各册 `_源/` 的根（备料清单里写成 `…\` 的那一段，这里补全） */
const 打卡根 = String.raw`D:\workplace\ai-bkb\举一反三产物\打卡`;

interface 首铺条目 {
  /** 备料清单 `清单[]` 里的下标（对得回去，不然日后核不动） */
  序: number;
  /** 归属的 DSL 模块（= 清单里 层级='模块' 那一行） */
  模块: string;
  name: string;
  /** 🔴 002 词表的**正名**（唯一，resolve 必 1.0） */
  kpRef: string;
  /** 备料的预估名 → 正名，为什么这么落 */
  kpRefWhy: string;
  dslRef: string;
  difficulty?: number;
  varSpec: Record<string, unknown>;
  /** 提议人附言（进工单 reason） */
  note: string;
  /** 转正时的裁定附言（进 review_queue.verdict_note） */
  verdictNote: string;
}

// ---------------------------------------------------------------------------
// 别名补录（口径②）：产线真在用、002 词表确实缺的说法
// ---------------------------------------------------------------------------

const ALIASES: { kpRef: string; alias: string; 出处: string }[] = [
  {
    kpRef: "绝对值的性质与非负性",
    alias: "非负数之和为零",
    出处:
      "exam_model-首铺清单.json 清单[3].kp_name预估 + 举一反三产物/解题模型库/绝对值的非负性.md" +
      "（词表现有别名是「和为零则各项为零」，产线与教辅口头叫「非负数之和为零」）",
  },
  {
    kpRef: "绝对值的几何意义与数轴距离",
    alias: "数轴上两点间距离",
    出处:
      "exam_model-首铺清单.json 清单[4].kp_name预估" +
      "（词表现有别名是「数轴两点间距离」，少一个「上」字就 resolve 不到）",
  },
  {
    kpRef: "符号商 |a|/a 型的计算",
    alias: "多变量符号穷举",
    出处:
      "exam_model-首铺清单.json 清单[6].kp_name预估 + " +
      "七上绝对值压轴突破/_源/qbank.py#_enum_pat（验算法就叫这个）",
  },
  {
    kpRef: "合并同类项",
    alias: "合并同类项法则",
    出处: "exam_model-首铺清单.json 清单[8].kp_name预估（课本口径带「法则」二字）",
  },
];

// ---------------------------------------------------------------------------
// 归不了位的（口径③）：如实记账，不硬挂
// ---------------------------------------------------------------------------

export const SKIPPED: { 序: number; name: string; why: string }[] = [
  22, 23, 24, 25,
].map((序) => ({
  序,
  name: ["脱式·无括号（s1）", "脱式·含括号（s2）", "二合一（两算式并成综合算式）", "树状图（先填空再列综合算式）"][
    序 - 22
  ]!,
  why:
    "三上混合运算特训 = **小学三年级**内容（表内乘除四则），而 002 词表 415 条考点" +
    "`grade_band` 全是「初中」，一条小学考点都没有 —— 硬挂到初中「有理数的混合运算」下，" +
    "按考点召回模型时会召回一族小学生成器（core/model.ts 文件头明写的那种错）。" +
    "等 002 补小学学段再铺。DSL 在 " +
    `${打卡根}\\三上混合运算特训\\_源\\qbank.py#build_all`,
}));

// ---------------------------------------------------------------------------
// 26 个候选里能归位的 22 个
// ---------------------------------------------------------------------------

const 绝对值qbank = `${打卡根}\\七上绝对值压轴突破\\_源\\qbank.py`;
const 整式qbank = `${打卡根}\\七上整式的加减打卡\\_源\\qbank.py`;
const 混合qbank = `${打卡根}\\七上有理数混合运算打卡\\_源\\qbank.py`;
const 实数qbank = `${打卡根}\\七上实数计算打卡\\_源\\qbank.py`;

/** 五个 DSL 模块的共同底账（进每条模型的 var_spec_json.模块） */
const 模块账: Record<string, Record<string, unknown>> = {
  绝对值: {
    模块: "绝对值压轴突破 · 六类型模板库",
    dsl: 绝对值qbank,
    出题能力: "可参数化重出（30 个模板函数 = 函数 + 显式参数）",
    验算: "chk() sympy 独立第二路重算；verify(days) 三闸=题面零重复 + 同天同节答案不撞 + 配比 6×2",
    来源册: "举一反三产物/打卡/七上绝对值压轴突破（10 天 × 12 题 = 120 题，在售，网盘 4nmg）",
    复用方: "订阅特训/_产线/群卷_绝对值{,2,_批量}.py（只换参数不新造题型）",
    风险:
      "🔴 群卷_绝对值_批量.py docstring 明记「参数空间近枯竭，第 2 期前必须换策略」——" +
      "已占 20 天 240 题，第 02 期继续复用同 30 个模板会撞",
  },
  整式: {
    模块: "整式的加减 · 表达式树 DSL",
    dsl: 整式qbank,
    出题能力: "可参数化重出（class E 表达式树 + 5 个题目构造器 q/qv/qab/qbr/qm）",
    验算: "verify(days) = sp.expand(树) 与手写 expected 双录比对 + 题面零重复",
    来源册:
      "举一反三产物/打卡/七上整式的加减打卡（10 天 × 10~14 题 = 114 题，在售，网盘 asda，线上 book_id 2083233482101059585）",
    复用方: "订阅特训/_产线/群卷_整式{,2,_批量}.py（另加 4 组数值代入双录 448 次比对）",
  },
  混合七上: {
    模块: "七上有理数混合运算 · 考点配额出卷器",
    dsl: `${混合qbank}#build_paper`,
    出题能力:
      "🟢 可按 seed 重出：build_paper(seed, quota, lv=1, history=()) → [Q,…]；" +
      "quota={考点码:题数}，lv=难度档，history=跨天防重；卷内同骨架上限 cap ∈ (2,3,4,6)",
    验算:
      "verify(items) = 逐行恒等（sympy 双路）+ 题面不撞 + 值域闸 + 步数闸 + 考点配额断言；kp_report() 出考点分布",
    考点码正本:
      "🔴 订阅特训/_产线/err_kp.json（七码词表 v1.0.0，2026-08-11 收敛）—— " +
      "qbank.KP/KP_CN、批改链.KP_CN、审核台 KPCN、明日卷 BASE 配额键、render_feedback 全读它",
    来源册:
      "举一反三产物/打卡/七上有理数混合运算打卡（老册 10 天 × 20 题 = 200 题，在售，网盘 cm3f；本 DSL 是 2026-08-05 为订阅特训产线重建的单一事实源）",
    复用方: "订阅特训/_产线/群卷_混合_批量.py（seed 由「群打卡-第1期-第N天」CRC32 定）、明日卷.py",
  },
  实数: {
    模块: "实数计算 · 表达式 DSL",
    dsl: 实数qbank,
    出题能力:
      "🔴 **不可按 seed 重出**：四子树里唯一没有参数化生成器的一支 —— 每道题是人手写的 " +
      "E 表达式常量表（分天数据在 days1.py / days_2_4.py / days_5_7.py / days_8_10.py，由 days.py 汇总），" +
      "DSL 只保证「题面/答案同源 + 可验算」。要做成可再生须补生成器函数。",
    验算: "verify(days) 全量实算 + 题面零重复",
    来源册:
      "举一反三产物/打卡/七上实数计算打卡（10 天 × 20 题 = 200 题；姊妹册 七上实数的运算打卡，网盘 yiru，线上 book_id 2083268911093346305）",
  },
};

const 首铺表: 首铺条目[] = [
  // ── 绝对值线（清单 1~6）───────────────────────────────────────────────────
  {
    序: 1,
    模块: "绝对值",
    name: "已知绝对值求数",
    kpRef: "已知绝对值求原数",
    kpRefWhy:
      "预估「绝对值的意义 / 已知绝对值求原数」；后者即正名（其别名恰好就是本模型名「已知绝对值求数」）",
    dslRef: `${绝对值qbank}#T1_absx,T1_absabs,T1_kabs,T1_shift,T1_revabs,T1_twoabs,T1_pair,T1_count,T1_diff`,
    difficulty: 2,
    varSpec: {
      模板函数: 9,
      参数:
        "T1_absx(a) / T1_absabs(a) / T1_kabs(k,c) / T1_shift(m,k) / T1_revabs(m,k) / " +
        "T1_twoabs(p,q) / T1_pair(p,q) / T1_count(r) / T1_diff(p,q,op)",
      参数域: "整数或 Rational，|数| ≤ 12",
      题型: "填空",
      节: "七上绝对值压轴突破 · 节①",
    },
    note: "绝对值线节①，9 个模板函数一族。",
    verdictNote: "首铺批量转正（人主导）：DSL 在盘可跑、参数域明确、chk() 有独立验算路。",
  },
  {
    序: 2,
    模块: "绝对值",
    name: "利用绝对值求最值",
    kpRef: "绝对值表距离求最值",
    kpRefWhy:
      "预估「绝对值的非负性 / 最值」；正名 = 绝对值表距离求最值（其别名含「利用绝对值求最值」「绝对值最值」「距离和最值」）",
    dslRef: `${绝对值qbank}#T2_min,T2_max,T2_revmin,T2_revmax`,
    difficulty: 3,
    varSpec: {
      模板函数: 4,
      参数:
        "T2_min(m,c,k,front,var) / T2_max(m,c,k,var) / T2_revmin(m,c,var) / T2_revmax(m,c,var)",
      跨期去重键: "key=(x0,c) 或 (m,c)",
      题型: "填空",
      节: "七上绝对值压轴突破 · 节②",
      模型卡: "举一反三产物/解题模型库/绝对值表距离求最值.md（已入库 TY27）",
    },
    note: "绝对值线节②。已有模型卡 TY27，本条是它的出题侧登记。",
    verdictNote: "首铺批量转正（人主导）：与已有模型卡 TY27 同源，跨期去重键明确。",
  },
  {
    序: 3,
    模块: "绝对值",
    name: "绝对值的非负性（和为零则各项为零）",
    kpRef: "绝对值的性质与非负性",
    kpRefWhy:
      "预估「非负数之和为零」→ 正名 绝对值的性质与非负性（本次已把预估名补成它的别名，见 ALIASES）",
    dslRef: `${绝对值qbank}#T3_choice,T3_opposite,T3_power,T3_three,T3_sum`,
    difficulty: 3,
    varSpec: {
      模板函数: 5,
      参数:
        "T3_choice(m,n,p,q,opts) / T3_opposite(p,q,opts) / T3_power(p,q,e)（e 须偶数）/ " +
        "T3_three(a,b,c) / T3_sum(m,n,ask)",
      纪律: "选择题正确项位置须跨期轮换",
      题型: "选择 / 解答",
      节: "七上绝对值压轴突破 · 节③",
      模型卡: "举一反三产物/解题模型库/绝对值的非负性.md",
    },
    note: "绝对值线节③。教辅口径叫「非负数之和为零」，本次已补成别名。",
    verdictNote: "首铺批量转正（人主导）：模型卡在盘，e 须偶数这条参数约束已进 var_spec。",
  },
  {
    序: 4,
    模块: "绝对值",
    name: "绝对值的几何意义（数轴距离）",
    kpRef: "绝对值的几何意义与数轴距离",
    kpRefWhy:
      "预估「数轴上两点间距离 / 距离和最值」→ 正名 绝对值的几何意义与数轴距离（预估名已补成别名，见 ALIASES）",
    dslRef: `${绝对值qbank}#T4_dist,T4_ints,T4_three_min,T4_eq,T4_diff_max,T4_two_min`,
    difficulty: 3,
    varSpec: {
      模板函数: 6,
      参数:
        "T4_dist(a,b,k) / T4_ints(a,b) / T4_three_min(a,b,c) / T4_eq(a,b,k) / " +
        "T4_diff_max(a,b) / T4_two_min(a,b)",
      独立验算: "_abs_pairs / _piece_min / _piece_max 分段断点求极值",
      题型: "填空 / 解答",
      节: "七上绝对值压轴突破 · 节④",
    },
    note: "绝对值线节④，几何意义一族（距离、整点计数、距离和最值）。",
    verdictNote: "首铺批量转正（人主导）：独立验算走分段断点求极值，第二条路是真的另一条路。",
  },
  {
    序: 5,
    模块: "绝对值",
    name: "分类讨论思想",
    kpRef: "绝对值中的分类讨论",
    kpRefWhy: "预估「绝对值的分类讨论 / 不重不漏」→ 正名 绝对值中的分类讨论（其别名含「分类讨论思想」）",
    dslRef: `${绝对值qbank}#T5_choice,T5_range,T5_two,T5_sum`,
    difficulty: 4,
    varSpec: {
      模板函数: 4,
      参数: "T5_choice(p,q,cm,cn,rel,opts) / T5_range(a,mode) / T5_two(p,q) / T5_sum(p,q,rel)",
      题型: "选择 / 填空 / 解答",
      节: "七上绝对值压轴突破 · 节⑤",
    },
    note: "绝对值线节⑤。「不重不漏」是这一族的判分点。",
    verdictNote: "首铺批量转正（人主导）。",
  },
  {
    序: 6,
    模块: "绝对值",
    name: "符号商定号（|a|/a + |b|/b + |c|/c 型）",
    kpRef: "符号商 |a|/a 型的计算",
    kpRefWhy: "预估「符号商 / 多变量符号穷举」→ 正名 符号商 |a|/a 型的计算（后半句已补成别名，见 ALIASES）",
    dslRef: `${绝对值qbank}#T6_sum,T6_single`,
    difficulty: 4,
    varSpec: {
      模板函数: 2,
      参数: "T6_sum(terms,nvars,cond_tex,cond,kind,lead,lines) / T6_single(cases)",
      同源: "题面 LaTeX 与求值函数同源自项字典 _TERMS；_AMPS=(1,2,3,5)",
      独立验算: "_enum_pat() 符号组合穷举（同时抓漏解与多写解）",
      题型: "填空 / 解答",
      节: "七上绝对值压轴突破 · 节⑥",
      模型卡: "举一反三产物/解题模型库/符号商定号.md",
    },
    note: "绝对值线节⑥。验算是符号组合穷举，漏解/多写解都抓得住。",
    verdictNote: "首铺批量转正（人主导）：题面与求值同源自 _TERMS，题面改了答案跟着改，不会脱节。",
  },

  // ── 整式线（清单 8~12）──────────────────────────────────────────────────
  {
    序: 8,
    模块: "整式",
    name: "合并同类项",
    kpRef: "合并同类项",
    kpRefWhy: "预估「合并同类项法则」→ 正名 合并同类项（预估名已补成别名，见 ALIASES）",
    dslRef: `${整式qbank}#q`,
    difficulty: 1,
    varSpec: {
      构造器: "q(stem, expected) 纯化简",
      梯度:
        "两组同类项(一组全抵消) → 三项+两项 → 带常数项 → 三字母(一组抵消) → a²/ab/b² 二次型 → 二次三项式",
      配额: "6 题/天",
      题型: "化简",
      节: "七上整式的加减打卡 · 节①",
    },
    note: "整式线节①，梯度六级已定。",
    verdictNote: "首铺批量转正（人主导）：expected 与表达式树双录比对，出题即验算。",
  },
  {
    序: 9,
    模块: "整式",
    name: "去括号并合并",
    kpRef: "去括号法则",
    kpRefWhy:
      "预估「去括号法则 / 添括号法则」；取前者为主考点（本族主动作是去括号）。" +
      "🔴 不能用裸「去括号」——它同时是一元一次方程下另一个考点的**正名**，会红 KP_AMBIGUOUS",
    dslRef: `${整式qbank}#K,B,q`,
    difficulty: 2,
    varSpec: {
      构件: "K(coef,inner,big) 系数乘括号 / B(coef,inner,big) 括号",
      梯度:
        "正/负系数乘进去 → 两括号相减带常数 → 负系数乘负项 → 括号前是负号(逐项变号) → " +
        "全抵消得 0 → 抵消得纯常数 → 中括号嵌套 ×2",
      配额: "8 题/天；每天各留一道「答案是 0」与一道「答案是纯常数」",
      题型: "化简",
      节: "七上整式的加减打卡 · 节②",
      副考点: "添括号法则（qbr 构造器那一路）",
    },
    note: "整式线节②。副考点「添括号法则」暂不并挂（M1 一模型一考点）。",
    verdictNote: "首铺批量转正（人主导）：「答案是 0」「答案是纯常数」两道保留题是这一族的错因靶子。",
  },
  {
    序: 10,
    模块: "整式",
    name: "化简求值",
    kpRef: "整式的化简求值",
    kpRefWhy: "预估「整式化简求值 / 整体代入」→ 正名 整式的化简求值（其别名含「化简求值」「整式化简求值」）",
    dslRef: `${整式qbank}#qv`,
    difficulty: 2,
    varSpec: {
      构造器: "qv(stem, subs, expected)：subs = {符号: Rational}",
      铁律: "先化简再代入",
      题型: "解答",
      来源册: "七上整式的加减打卡 / 七上整式化简求值打卡",
      模型卡: "举一反三产物/解题模型库/整式化简求值十模型.md（一族十子 = 十天）",
    },
    note: "整式线型②。模型卡「十模型」一族十子，正好铺十天。",
    verdictNote: "首铺批量转正（人主导）：subs 用 Rational 不用 float，代入值不会有浮点毛刺。",
  },
  {
    序: 11,
    模块: "整式",
    name: "和与差（A±B 整体加括号）",
    kpRef: "整式的和差与整体加括号",
    kpRefWhy: "预估「整式的加减运算」偏泛；正名取 整式的和差与整体加括号（其别名含「A±B 型」「和与差」）",
    dslRef: `${整式qbank}#qab`,
    difficulty: 3,
    varSpec: {
      构造器: "qab(defs, ask, expected)：defs = {'A': 树, 'B': 树}，ask ∈ {'A+B','A-B','2A-B',…}",
      题型: "解答",
      节: "七上整式的加减打卡 · 型③",
    },
    note: "整式线型③。这一族的错因靶子是「代进去不加括号」。",
    verdictNote: "首铺批量转正（人主导）。",
  },
  {
    序: 12,
    模块: "整式",
    name: "待定系数（不含某项 / 与字母无关）",
    kpRef: "整式中的待定系数（不含某项/与字母无关）",
    kpRefWhy:
      "预估「多项式的项与系数」偏泛（那是概念考点）；词表另有专门一条 " +
      "整式中的待定系数（不含某项/与字母无关），别名含「不含某项」「与字母取值无关」——正是本族",
    dslRef: `${整式qbank}#qm`,
    difficulty: 3,
    varSpec: {
      构造器: "qm(stem, var, deg, expected, param='m')",
      算法: "取 var 的 deg 次项系数令其为 0 解方程",
      题型: "解答",
      节: "七上整式的加减打卡 · 型④",
    },
    note: "整式线型④。备料预估的「多项式的项与次数」是概念考点，本族的正主是待定系数那一条。",
    verdictNote: "首铺批量转正（人主导）：考点从预估的概念条改挂到专门条，理由已进 kpRefWhy。",
  },

  // ── 七上混合运算线（清单 14~20，err_kp 七码）────────────────────────────
  {
    序: 14,
    模块: "混合七上",
    name: "符号处理（sign）",
    kpRef: "有理数的加减混合运算",
    kpRefWhy:
      "err 码 sign。🔴 裸「sign」在词表里**同时**是「有理数的加减混合运算」与" +
      "「有理数的加法法则」的别名 ⇒ resolve 必红 KP_AMBIGUOUS。" +
      "本族生成器 gen_addsub_chain 出的是**加减混合链**（去括号变号 / 连减化加），" +
      "故取前者正名；后者是单步法则，不是本族。",
    dslRef: `${混合qbank}#gen_addsub_chain`,
    difficulty: 2,
    varSpec: {
      err码: "sign",
      err释义: "加减乘除中的正负号判定：去括号变号、连减化加、乘除号数奇偶",
      生成器: "gen_addsub_chain(rng, lv)",
      配额: "默认 3/卷（MODI_QUOTA）",
      题型: "计算",
    },
    note: "混合运算七码之 sign。err_kp.json v1.0.0 是考点码正本。",
    verdictNote:
      "首铺批量转正（人主导）：歧义别名 sign 已按生成器实际形态定到「加减混合运算」，不由机器猜。",
  },
  {
    序: 15,
    模块: "混合七上",
    name: "绝对值脱号（abs）",
    kpRef: "绝对值的化简与去号",
    kpRefWhy: "err 码 abs → 正名 绝对值的化简与去号（其别名含 abs / 绝对值脱号 / 去绝对值）",
    dslRef: `${混合qbank}#gen_abs_chain`,
    difficulty: 2,
    varSpec: {
      err码: "abs",
      err释义: "先判断绝对值内部的正负再脱号，脱号后的连减/连加处理",
      生成器: "gen_abs_chain(rng, lv)",
      配额: "默认 3/卷",
      题型: "计算",
    },
    note: "混合运算七码之 abs。",
    verdictNote: "首铺批量转正（人主导）。",
  },
  {
    序: 16,
    模块: "混合七上",
    name: "乘方（pow）",
    kpRef: "有理数乘方的运算与符号判定",
    kpRefWhy: "err 码 pow → 正名 有理数乘方的运算与符号判定（其别名含 pow / 乘方定号 / 幂的符号）",
    dslRef: `${混合qbank}#gen_pow_mixed,gen_bare_pow_chain`,
    difficulty: 3,
    varSpec: {
      err码: "pow",
      err释义: "幂的计算与符号：(-a)^n 与 -a^n 的区别、奇偶次幂定号",
      生成器: "gen_pow_mixed / gen_bare_pow_chain（2 个）",
      配额: "默认 3/卷",
      题型: "计算",
      缺口:
        "🔴 「(-1)^{2k}×a+(-b)²÷c」vs「-1^{2k}×a+(-b)²÷c」的**对照对**生成器出不来，" +
        "群卷线是手工注入的（指数必须偶数）—— 整条线最值钱的诊断题。" +
        "备料建议把它提升为独立 exam_model；本次**不提**（那是新料，越界），先如实挂账。" +
        "手工注入处：订阅特训/_产线/群卷_混合_批量.py#_mkpair",
    },
    note: "混合运算七码之 pow。对照对缺口已记在 var_spec.缺口 里，别让它烂在 docstring 里。",
    verdictNote: "首铺批量转正（人主导）：对照对生成器的缺口如实挂账，不因为「有缺口」就不登记现有能力。",
  },
  {
    序: 17,
    模块: "混合七上",
    name: "运算律简算（dist）",
    kpRef: "有理数运算的简便技巧",
    kpRefWhy: "err 码 dist → 正名 有理数运算的简便技巧（其别名含 dist / 分配律逆用 / 提公因数 / 运算律简算）",
    dslRef: `${混合qbank}#gen_dist_forward,gen_dist_reverse,gen_div_by_unit_frac`,
    difficulty: 3,
    varSpec: {
      err码: "dist",
      err释义: "分配律正用逆用、提公因数、凑整交换结合，该简算的不硬算",
      生成器: "gen_dist_forward / gen_dist_reverse / gen_div_by_unit_frac（3 个）",
      配额: "默认 3/卷",
      题型: "计算",
    },
    note: "混合运算七码之 dist。这一族的判分点是「该简算的不硬算」。",
    verdictNote: "首铺批量转正（人主导）。",
  },
  {
    序: 18,
    模块: "混合七上",
    name: "分数小数（fracdec）",
    kpRef: "分数与小数混合的有理数运算",
    kpRefWhy: "err 码 fracdec → 正名 分数与小数混合的有理数运算（其别名含 fracdec / 分小互化 / 分数小数）",
    dslRef: `${混合qbank}#gen_dec_chain,gen_frac_div,gen_frac_addsub,gen_dec_frac_mix`,
    difficulty: 2,
    varSpec: {
      err码: "fracdec",
      err释义: "分数与小数互化、通分约分、带分数化假分数后再运算",
      生成器: "4 个（本线容量最大）",
      配额: "默认 3/卷",
      题型: "计算",
    },
    note: "混合运算七码之 fracdec，四个生成器，容量最大。",
    verdictNote: "首铺批量转正（人主导）。",
  },
  {
    序: 19,
    模块: "混合七上",
    name: "运算顺序（order）",
    kpRef: "有理数的混合运算",
    kpRefWhy: "err 码 order → 正名 有理数的混合运算（其别名含 order / 四则混合运算 / 脱式计算）",
    dslRef: `${混合qbank}#gen_frac_div,gen_mixed_long`,
    difficulty: 2,
    varSpec: {
      err码: "order",
      err释义: "先乘方、再乘除、后加减，同级从左到右，有括号先算括号",
      生成器: "gen_frac_div / gen_mixed_long（仅 2 个 = 2 种骨架）",
      配额: "默认 2/卷",
      题型: "计算",
      硬顶:
        "🔴 已知硬顶：配额要 5（弱项+2）或 8（攻坚）时会**断供**，靠卷内同骨架上限 cap 逐级放宽兜底。" +
        "要按学情加大 order 配额，得先补生成器。",
    },
    note: "混合运算七码之 order。断供硬顶已挂账（明日卷按学情加配额时会撞上）。",
    verdictNote: "首铺批量转正（人主导）：硬顶如实进 var_spec，将来断供时查得到原因。",
  },
  {
    序: 20,
    模块: "混合七上",
    name: "括号嵌套（paren）",
    kpRef: "多重括号的有理数运算",
    kpRefWhy: "err 码 paren → 正名 多重括号的有理数运算（其别名含 paren / 多重括号 / 括号嵌套）",
    dslRef: `${混合qbank}#gen_nested_paren,gen_mixed_long`,
    difficulty: 3,
    varSpec: {
      err码: "paren",
      err释义: "小括号→中括号→大括号逐层拆解，层层变号一个不漏",
      生成器: "gen_nested_paren / gen_mixed_long（2 个）",
      配额: "默认 3/卷",
      题型: "计算",
    },
    note: "混合运算七码之 paren。",
    verdictNote: "首铺批量转正（人主导）。",
  },

  // ── 实数线（清单 27~30）🔴 无参数化生成器 ───────────────────────────────
  {
    序: 27,
    模块: "实数",
    name: "开方直取",
    kpRef: "开方直取与根式化简",
    kpRefWhy: "预估「平方根 / 立方根 / 算术平方根」是三个概念条；本族是**动作**，正名 = 开方直取与根式化简（别名含「开方直取」）",
    dslRef: `${实数qbank}#rt,cb + SECTIONS[0]`,
    difficulty: 1,
    varSpec: {
      构件: "rt(e) 平方根 / cb(e) 立方根",
      配额: "6 题/天（QUOTA[0]）",
      提示语: "直接写出结果",
      题型: "填空",
      节: "七上实数计算打卡 · 节①",
      出题能力:
        "🔴 参数化缺失，**不能按 seed 重出**：题是人手写的 E 表达式常量表，dsl_ref 指的是常量表脚本。",
    },
    note: "实数线节①。🔴 无参数化生成器，只登「考察模型 + 验算能力」，登不了「出题能力」。",
    verdictNote:
      "首铺批量转正（人主导）：🔴 参数化缺失，不能按 seed 重出新题 —— 本条登记的是「这一族题长什么样 + 怎么验算」，" +
      "不是「按需出题的能力」。要做成可再生须给 qbank.py 补生成器函数。",
  },
  {
    序: 28,
    模块: "实数",
    name: "乘方与绝对值",
    kpRef: "开方直取与根式化简",
    kpRefWhy:
      "预估「乘方 / 绝对值化简」两条都在**有理数**域下；002 词表已把「乘方与绝对值（实数）」" +
      "作为别名挂在实数域的 开方直取与根式化简 上，本条照词表落（与序 27 同考点、不同模型，M1 允许一考点多模型）",
    dslRef: `${实数qbank}#pw,ab + SECTIONS[1]`,
    difficulty: 2,
    varSpec: {
      构件: "pw(e,k,bare) 乘方 / ab(e) 绝对值",
      配额: "4 题/天（QUOTA[1]）",
      提示语: "先定号，再化简",
      题型: "计算",
      节: "七上实数计算打卡 · 节②",
      出题能力: "🔴 参数化缺失，不能按 seed 重出（同序 27）。",
    },
    note: "实数线节②。考点与序 27 同条，是 002 词表的既定归位（别名「乘方与绝对值（实数）」）。",
    verdictNote:
      "首铺批量转正（人主导）：🔴 参数化缺失，不能按 seed 重出。考点与序 27 共用一条，属词表既定归位，非误挂。",
  },
  {
    序: 29,
    模块: "实数",
    name: "实数混合运算",
    kpRef: "实数的混合运算",
    kpRefWhy: "预估「实数的混合运算」即正名（别名含「实数的运算」「实数计算」）",
    dslRef: `${实数qbank}#chain,mul,dv + SECTIONS[2]`,
    difficulty: 3,
    varSpec: {
      构件: "chain(*parts) / mul / mulj / dv",
      配额: "7 题/天（QUOTA[2]，本册最大节）",
      题型: "计算",
      节: "七上实数计算打卡 · 节③",
      出题能力: "🔴 参数化缺失，不能按 seed 重出（同序 27）。",
    },
    note: "实数线节③，本册最大一节。",
    verdictNote: "首铺批量转正（人主导）：🔴 参数化缺失，不能按 seed 重出。",
  },
  {
    序: 30,
    模块: "实数",
    name: "开方解方程",
    kpRef: "用平方根立方根的意义解方程",
    kpRefWhy: "预估「用平方根/立方根的意义解方程」即正名（别名含「开方解方程」「x²=a 型」）",
    dslRef: `${实数qbank}#qe + SECTIONS[3]`,
    difficulty: 3,
    varSpec: {
      构造器: "qe(lhs, rhs, roots)",
      配额: "3 题/天（QUOTA[3]）",
      题型: "解答",
      节: "七上实数计算打卡 · 节④",
      出题能力: "🔴 参数化缺失，不能按 seed 重出（同序 27）。",
      判分点: "x²=a 型两个根别漏，x³=a 型一个根别多写",
    },
    note: "实数线节④。判分点是「双值 vs 单值」。",
    verdictNote: "首铺批量转正（人主导）：🔴 参数化缺失，不能按 seed 重出。",
  },
];

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

async function 补别名(dry: boolean): Promise<number> {
  say(杠);
  say(`别名补录（口径②）·${dry ? "probe，零写入" : "写"}`);
  say(杠);
  let 坏 = 0;
  const h = await getCoreDb();
  for (const a of ALIASES) {
    try {
      const kp = await resolveKpRef(h, a.kpRef);
      const 现 = await resolveKp(a.alias, {
        handle: h,
        enqueue: false,
        knn: false,
      });
      const 已通 = 现.candidates.some(
        (c) => c.confidence >= 1 && c.kpId === kp.kpId,
      );
      if (已通) {
        say(`  · 「${a.alias}」→ ${kp.name}：已经 resolve 得到，跳过（幂等）`);
        continue;
      }
      if (dry) {
        say(`  · 「${a.alias}」→ ${kp.name}（${kp.kpId}）：待补`);
        continue;
      }
      const r = await addKpAlias(kp.kpId, a.alias, {
        actor: "human",
        note: `AI:PRD-005 005-C exam_model 首铺 · 产线真叫法补录。出处：${a.出处}`,
      });
      say(
        `  · 「${a.alias}」→ ${kp.name}（${kp.kpId}）：${r.inserted ? "已补" : "本来就有"}`,
      );
    } catch (e) {
      坏 += 1;
      say(
        `  🔴 「${a.alias}」→ ${a.kpRef} 失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  say();
  return 坏;
}

async function probe(): Promise<number> {
  const h = await getCoreDb();
  say(杠);
  say(`考点解析 probe（${首铺表.length} 条，零写入）`);
  say(杠);
  let 坏 = 0;
  for (const e of 首铺表) {
    try {
      const kp = await resolveKpRef(h, e.kpRef);
      say(`  ✔ [${String(e.序).padStart(2)}] ${e.name}`);
      say(`        kpRef「${e.kpRef}」→ ${kp.name}（${kp.kpId}）`);
    } catch (err) {
      坏 += 1;
      const m = err instanceof ModelError ? `[${err.code}] ${err.message}` : String(err);
      say(`  🔴 [${String(e.序).padStart(2)}] ${e.name}：${m}`);
    }
  }
  say();
  return 坏;
}

async function 铺(): Promise<number> {
  const h = await getCoreDb();
  const 已有 = new Set(
    (await h.db.select({ name: examModel.name }).from(examModel)).map(
      (r) => r.name,
    ),
  );

  say(杠);
  say(`首铺 exam_model（${首铺表.length} 条可归位 / 备料候选 26 条）`);
  say(杠);

  let 坏 = 0;
  let 新 = 0;
  let 跳 = 0;
  for (const e of 首铺表) {
    if (已有.has(e.name)) {
      跳 += 1;
      say(`  · [${String(e.序).padStart(2)}] ${e.name}：库里已有同名模型，跳过（幂等）`);
      continue;
    }
    try {
      const p = await proposeModel({
        kpRef: e.kpRef,
        name: e.name,
        dslRef: e.dslRef,
        ...(e.difficulty === undefined ? {} : { difficulty: e.difficulty }),
        varSpecJson: { ...e.varSpec, 模块: 模块账[e.模块] },
        note:
          `${e.note}\n考点归位：${e.kpRefWhy}\n` +
          `出处：AI:PRD-005 备料 exam_model-首铺清单.json 清单[${e.序}]（首铺，2026-08-13）`,
        actor: "agent",
      });
      const a = await activateModel(p.queueId, {
        by: "human",
        note: e.verdictNote,
        actor: "human",
      });
      新 += 1;
      say(
        `  ✔ [${String(e.序).padStart(2)}] ${e.name} → ${a.modelId}` +
          `（${p.kp.name} / ${a.from}→${a.to}）`,
      );
    } catch (err) {
      坏 += 1;
      const m =
        err instanceof ModelError ? `[${err.code}] ${err.message}` : String(err);
      say(`  🔴 [${String(e.序).padStart(2)}] ${e.name}：${m}`);
    }
  }

  say(细);
  say(`新登 ${新} 条 / 幂等跳过 ${跳} 条 / 失败 ${坏} 条`);
  say();
  say(细);
  say(`🔴 归不了位、如实跳过的 ${SKIPPED.length} 条（备料候选 26 − 可归位 ${首铺表.length}）：`);
  for (const s of SKIPPED) say(`  · [${s.序}] ${s.name}`);
  say(`  原因：${SKIPPED[0]?.why ?? ""}`);
  say();
  return 坏;
}

async function main(): Promise<number> {
  const dry = process.argv.includes("--probe");
  const 只别名 = process.argv.includes("--alias");

  let 坏 = await 补别名(dry);
  if (只别名) return 坏;
  坏 += dry ? await probe() : await 铺();

  say(杠);
  say(坏 === 0 ? "结论：全绿" : `结论：🔴 ${坏} 处有问题（见上）`);
  say(杠);
  return 坏 === 0 ? 0 : 1;
}

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
