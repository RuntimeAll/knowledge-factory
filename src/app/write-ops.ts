/**
 * 🔴🔴 管理台**写操作白名单**——全站唯一一份台账（AI:PRD-009 验收修复 · 2026-08-15）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 *
 *   PRD-008 §六 D2 拍的是「写操作白名单就五类：收卷录入 / 上架下架 / 补错因映射 /
 *   队列处置 / 合并向导，**其余全只读**」，PRD-009 D-C 加「终审确认打回」= 六类。
 *   但验收实测：白名单之外还挂着 **4 个真实可点的写端点**（版本树 active/readonly
 *   切换、别名新增、别名删除、考点退役）—— 它们是 PRD-002 的遗留，改版时原样留下来了，
 *   六类的说法与代码对不上。而这件事**没有任何机器判据管着**：
 *   下一个人再加一个 `"use server"` 的 action，白名单照样是那句话，没人会发现。
 *
 *   所以这里把**每一个写入口逐条记在案**，并配一条反证闸
 *   （`tests/write-whitelist.test.ts`）：
 *     · 代码里存在、台账里没有 → 测试红（新加的写口子必须先登记）；
 *     · 台账里有、代码里没有   → 测试红（下线了要顺手销账）。
 *   「白名单」从此是一份**对得上代码**的东西，不是设计稿里的一句话。
 *
 * 🔴 本文件是**纯数据**：不 import 任何 core / 组件，页面也不读它 ——
 *    它的读者是人和那条闸。放在 src/app 下是因为它记的就是 app 层的写入口。
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * 白名单的「类」。前六类 = PRD-008 D2 五类 + PRD-009 D-C 加的终审。
 *
 * 🔴 `KG治理` 是第七类，状态 = **待拍板**（见下方 {@link KG_治理待拍板}）：
 *    本次验收把它**记录在案**（而不是悄悄下线），因为口径本身就是打架的 ——
 *    PRD-008 §二·5「考点管理」的操作列**点名保留了「退役（跳确认页）」**，
 *    同一份文档 §六 D2 又说「其余全只读」。这种冲突不该由执行侧单方面裁掉一边。
 */
export const WRITE_OP_CLASSES = [
  "收卷录入",
  "上架下架",
  "补错因映射",
  "队列处置",
  "合并向导",
  "终审确认打回",
  "KG治理",
] as const;
export type WriteOpClass = (typeof WRITE_OP_CLASSES)[number];

/** 前六类 = 已拍板的白名单；第七类待拍板（口径冲突，见 {@link KG_治理待拍板}） */
export const SETTLED_WRITE_OP_CLASSES: readonly WriteOpClass[] = [
  "收卷录入",
  "上架下架",
  "补错因映射",
  "队列处置",
  "合并向导",
  "终审确认打回",
];

/**
 * 🔴 二次确认的两种形态（检查单 §三·7「全部写操作统一形态（列明影响面）」）。
 *
 * ── 为什么是两种而不是一种 ──────────────────────────────────────────────────
 *   验收判红时代码里有**三种**形态，而且两处注释互相矛盾地各自宣称自己是「统一」的：
 *     · `app/grading/intake/form.tsx` 写「全站写操作一律 Modal + 列明影响面」；
 *     · `components/console/confirm.tsx` 写「现在统一成 ③（Popconfirm）」；
 *     · `app/cause/map/page.tsx` 则**一层确认都没有**（已修，收编进 ConfirmSubmit）。
 *   「没有确认层」那一处是**缺陷**，已经修掉。剩下两种是**按提交机制分的**，
 *   不是随手选的，所以口径就定成这两条（PRD §三·7 原文写的是 Modal，
 *   要不要收成一种 = 待用户拍板，见 {@link 形态待拍板}）：
 *
 *   | 形态 | 用在哪 | 为什么 |
 *   |---|---|---|
 *   | `Popconfirm` | `<form action={serverAction}>` 的 server action 表单 | 确认后走 `form.requestSubmit()`，与人手点 submit 完全同一条路径；`useFormStatus` 拿得到提交态（转圈 + 禁用 = 防连点）。套 Modal 反而要自己搬运表单状态 |
 *   | `Modal` | client 侧 `fetch` 提交、且影响面要**现算成一段话**的 | 收卷录入（要列将落盘的文件名）、终审三动作（要列翻了哪几道案、缺哪几题、会不会覆盖已出件）。这些影响面是几十行 JSX，Popconfirm 的小气泡放不下 |
 */
export const CONFIRM_FORMS = ["Popconfirm", "Modal"] as const;
export type ConfirmForm = (typeof CONFIRM_FORMS)[number];

export interface WriteOp {
  /** server action 的导出名，或写路由的 `METHOD 路径` */
  id: string;
  /** 属于白名单哪一类 */
  cls: WriteOpClass;
  /** 定义它的文件（仓相对路径） */
  file: string;
  /** 人点得到它的页面 */
  page: string;
  /** 二次确认长什么样 */
  confirm: ConfirmForm;
  /** 它最终调的 core 原语 / 圣域 CLI（写落在哪儿） */
  writes: string;
  /** 立它的卡 */
  prd: string;
}

/**
 * 🔴 逐条台账。**改代码时必须同步改这里**，否则 `tests/write-whitelist.test.ts` 判红。
 */
export const WRITE_OPS: readonly WriteOp[] = [
  // ── ① 收卷录入 ────────────────────────────────────────────────────────────
  {
    id: "POST /api/grading/intake",
    cls: "收卷录入",
    file: "src/app/api/grading/intake/route.ts",
    page: "/grading/intake",
    confirm: "Modal",
    writes: "只写收件箱（学员目录下的照片 + 队列 JSONL）——不碰审核.db",
    prd: "AI:PRD-008",
  },

  // ── ② 上架下架 ────────────────────────────────────────────────────────────
  {
    id: "setSkuStatusAction",
    cls: "上架下架",
    file: "src/app/sku/actions.ts",
    page: "/sku/[id]/status",
    confirm: "Popconfirm",
    writes: "core.setSkuStatus（sku.status + 审计行）",
    prd: "AI:PRD-008",
  },

  // ── ③ 补错因映射 ──────────────────────────────────────────────────────────
  {
    id: "mapErrCodeAction",
    cls: "补错因映射",
    file: "src/app/cause/actions.ts",
    page: "/cause/map",
    confirm: "Popconfirm",
    writes: "core.mapErrCode（err_code_map 插一行 + 审计行）",
    prd: "AI:PRD-008",
  },

  // ── ④ 队列处置（八动作）───────────────────────────────────────────────────
  {
    id: "verdictQueueAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue（行内） · /queue/[id]/reject",
    confirm: "Popconfirm",
    writes: "core.verdictQueue（review_queue.state + 审计行）",
    prd: "AI:PRD-003",
  },
  {
    id: "batchPassAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue（勾选后批量通过）",
    confirm: "Popconfirm",
    writes: "逐条 core.verdictQueue（各自独立事务、各自审计行）",
    prd: "AI:PRD-003",
  },
  {
    id: "quickAliasAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue/[id]/alias",
    confirm: "Popconfirm",
    writes: "core.addKpAlias + core.verdictQueue（别名 + 结单，两条审计行）",
    prd: "AI:PRD-003",
  },
  {
    id: "passFigureAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue（图审 tab 行内）",
    confirm: "Popconfirm",
    writes: "core.passFigure（摘必审位 + 结单 + 审计行）",
    prd: "AI:PRD-003",
  },
  {
    id: "rejectFigureAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue/[id]/reject（图审）",
    confirm: "Popconfirm",
    writes: "core.rejectFigure（结单 + 审计行）",
    prd: "AI:PRD-003",
  },
  {
    id: "promoteDraftAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue（草稿转正 tab 行内）",
    confirm: "Popconfirm",
    writes: "core.promoteDraft / core.activateModel（转正 + 审计行）",
    prd: "AI:PRD-005",
  },
  {
    id: "reingestQuarantineAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue/quarantine/[id]",
    confirm: "Popconfirm",
    writes: "core.reingestQuarantined（改判重投，全套闸重跑）",
    prd: "AI:PRD-003",
  },
  {
    id: "discardQuarantineAction",
    cls: "队列处置",
    file: "src/app/queue/actions.ts",
    page: "/queue/quarantine/[id]",
    confirm: "Popconfirm",
    writes: "core.discardQuarantined（废弃结案 + 审计行）",
    prd: "AI:PRD-003",
  },

  // ── ⑤ 合并向导 ────────────────────────────────────────────────────────────
  {
    id: "mergeKpAction",
    cls: "合并向导",
    file: "src/app/kg/actions.ts",
    page: "/kg/merge/preview",
    confirm: "Popconfirm",
    writes: "core.mergeKp（引用整体搬家 + 审计行）+ 跟一次 integrityCheck",
    prd: "AI:PRD-002",
  },

  // ── ⑥ 终审确认打回（PRD-009 D-C 新增）─────────────────────────────────────
  //    🔴 这三条**本产品对审核.db 没有写句柄**：spawn 圣域自己的 审核库.py 原语。
  {
    id: "POST /api/grading/review/confirm",
    cls: "终审确认打回",
    file: "src/app/api/grading/review/confirm/route.ts",
    page: "/grading/review/[code]/[day]",
    confirm: "Modal",
    writes: "spawn `python 审核库.py confirm <代号> <天> --from <临时JSON>`",
    prd: "AI:PRD-009",
  },
  {
    id: "POST /api/grading/review/rework",
    cls: "终审确认打回",
    file: "src/app/api/grading/review/rework/route.ts",
    page: "/grading/review/[code]/[day]",
    confirm: "Modal",
    writes: "spawn `python 审核库.py rework <代号> <天> <理由>`",
    prd: "AI:PRD-009",
  },
  {
    id: "POST /api/grading/review/unrework",
    cls: "终审确认打回",
    file: "src/app/api/grading/review/unrework/route.ts",
    page: "/grading/review/[code]/[day]",
    confirm: "Modal",
    writes: "spawn `python 审核库.py unrework <代号> <天>`",
    prd: "AI:PRD-009",
  },

  // ── ⑦ KG 治理（PRD-002 遗留 · 🔴 待拍板，见 KG_治理待拍板）────────────────
  {
    id: "setTreeStatusAction",
    cls: "KG治理",
    file: "src/app/kg/actions.ts",
    page: "/kg",
    confirm: "Popconfirm",
    writes: "core.setTreeStatus（edition_tree.status + 审计行）",
    prd: "AI:PRD-002",
  },
  {
    id: "addAliasAction",
    cls: "KG治理",
    file: "src/app/kg/actions.ts",
    page: "/kg/kp/[id]",
    confirm: "Popconfirm",
    writes: "core.addKpAlias（kp_alias 插一行 + 审计行，幂等）",
    prd: "AI:PRD-002",
  },
  {
    id: "removeAliasAction",
    cls: "KG治理",
    file: "src/app/kg/actions.ts",
    page: "/kg/kp/[id]",
    confirm: "Popconfirm",
    writes: "core.removeKpAlias（kp_alias 删一行 + 审计行）",
    prd: "AI:PRD-002",
  },
  {
    id: "retireKpAction",
    cls: "KG治理",
    file: "src/app/kg/actions.ts",
    page: "/kg/kp/[id]/retire",
    confirm: "Popconfirm",
    writes: "core.retireKp（kp.status→retired + 审计行；有引用会被 core 拦）",
    prd: "AI:PRD-002",
  },
];

/**
 * 🔴 待用户拍板 · 之一：第七类「KG 治理」到底算不算白名单。
 *
 *   冲突的两处白纸黑字：
 *     · PRD-008 §六 D2：「写操作白名单就五类：…，**其余全只读**」；
 *     · PRD-008 §二·5（考点管理页职责）：「操作列：详情｜发起合并（跳向导带入）｜
 *       **退役（跳确认页）**」—— 退役被点名保留了。
 *   另三个（版本树 active/readonly 切换、别名新增、别名删除）在 PRD-008 里**连提都没提**，
 *   是 PRD-002 页面原样留下来的。
 *
 *   本次验收修复的处置 = **补进台账、记录在案，不擅自下线**：
 *     ① 下线是不可逆的功能删除，而 §二·5 明确要保留其中一个；
 *     ② 四个动作都已经有二次确认 + 审计行，不存在「悄悄改库」的安全问题；
 *     ③ 口径打架该由拍板的人裁，不该由执行侧单方面砍掉一边。
 *   拍板之后照裁决改这里：要么把它并进正式白名单（改 SETTLED_WRITE_OP_CLASSES），
 *   要么把这四条连同页面上的挂载点一起摘掉（台账与代码一起改，闸会盯着）。
 */
export const KG_治理待拍板 =
  "KG 治理四写（版本树状态切换 / 别名增删 / 考点退役）是 PRD-002 遗留：" +
  "PRD-008 §二·5 点名保留了「退役」，同文 §六 D2 又说「其余全只读」——" +
  "口径冲突，本卡只记录在案，等用户拍板：并进白名单，还是连页面挂载点一起下线。";

/**
 * 🔴 待用户拍板 · 之二：二次确认要不要收成**一种**形态。
 *
 *   PRD §三·7 原文写的是 Modal；现在是 Popconfirm（server action 表单，14 处）
 *   + Modal（client fetch 提交，4 处）两种，分界线是**提交机制**（见 CONFIRM_FORMS）。
 *   两种都「列明了影响面」，检查单那一条的实质要求是满足的。
 *   要真收成一种，得把 14 处 server action 表单改成 Modal 托管提交 ——
 *   那会把 `useFormStatus` 那条防连点的路径也一并换掉，属于有风险的重构，
 *   不在验收修复的范围里。
 */
export const 形态待拍板 =
  "二次确认现有两种形态（server action 表单走 Popconfirm、client fetch 提交走 Modal），" +
  "分界线是提交机制、两种都列明影响面；PRD §三·7 字面写的是 Modal。" +
  "要不要收成一种由用户拍板 —— 收的话是 14 处表单的提交路径重构，不是改个组件名。";
