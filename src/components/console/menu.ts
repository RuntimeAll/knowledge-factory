/**
 * 管理台菜单树（AI:PRD-008 · 地基）—— 🔴 全站导航的唯一正本
 *
 * 正本 = prd/PRD-008/设计稿-管理台改版.md §一（若依风格：一级组 + 二级页）。
 *
 * ── 挂一个新页要改的就是这一处 ─────────────────────────────────────────────
 *   ① 找到它所属的组，把那一项的 `todo` 去掉（页建好了就不叫「待开发」）；
 *   ② 组里没有这一项就新加一条 `{ path, name }`；
 *   ③ 别名/旧地址（不进菜单但要有面包屑）加到 {@link HIDDEN_CRUMBS}。
 *   除此之外**不用动 shell.tsx** —— 壳只认这份数据。
 *
 * 🔴 `todo: true` = 页还没建：菜单项置灰不可点 + 标「待开发」。
 *    提前给一个 404 的链接比没有链接更贵（点进去以为坏了）。
 * 🔴 本文件是**纯数据**：不 import react、不 import core，所以 server / client 两边都能用
 *    （shell 是 client、面包屑在 client、将来若有 server 端用途也不必再抄一份）。
 */

export interface ConsoleMenuItem {
  /** 路由（唯一键） */
  path: string;
  name: string;
  /** 页还没建 ⇒ 置灰 + 「待开发」 */
  todo?: boolean;
  /** 鼠标悬停的一句话（这页管什么） */
  hint?: string;
}

export interface ConsoleMenuGroup {
  /** 组的伪路径（只作菜单键，不是可访问地址） */
  key: string;
  name: string;
  children: ConsoleMenuItem[];
}

/** 🔴 菜单正本（设计稿 §一 逐行落位） */
export const CONSOLE_MENU: ConsoleMenuGroup[] = [
  {
    key: "/g/home",
    name: "首页",
    children: [
      { path: "/", name: "工作台", hint: "库有多大 · 有没有红灯 · 今天该去哪" },
    ],
  },
  {
    key: "/g/qbank",
    name: "题库管理",
    children: [
      { path: "/question", name: "题目管理", hint: "找题、盘题（不改题）" },
      {
        path: "/ingest",
        name: "录入批次",
        hint: "每次投料的台账 + 闸报告",
      },
    ],
  },
  {
    key: "/g/kg",
    name: "知识图谱",
    children: [
      { path: "/kg", name: "考点管理", hint: "版本树 + 考点盘点" },
      {
        path: "/kg/merge",
        name: "合并向导",
        hint: "merge_kp 的人机流程（写）",
      },
    ],
  },
  {
    key: "/g/prod",
    name: "生产管理",
    children: [
      {
        path: "/sku",
        name: "SKU 台账",
        hint: "卖的/备着卖的册子总账",
      },
      {
        path: "/model",
        name: "考察模型",
        hint: "exam_model 台账 + 族谱",
      },
      {
        path: "/output",
        name: "产物仓",
        hint: "内容寻址仓里的实物件",
      },
    ],
  },
  {
    // 🔴 资料货架（AI:PRD-009 · D-B）：读的是**另一个库** ——
    //    punch 库 `举一反三产物/资料库.db`（同名异库，不是本库的 data/资料库.db），
    //    全程 mode=ro、两库绝不互写。所以它自成一组，不并进「生产管理」：
    //    并进去会让人以为货架上的册子和 SKU 台账是同一本账。
    key: "/g/shelf",
    name: "资料货架",
    children: [
      {
        path: "/shelf",
        name: "六类资料",
        hint: "打卡/专项/试卷/讲义/练习册/课本 的总账（只读挂载 punch 库）",
      },
      {
        // 🔴 与「题库管理 / 题目列表」是**两本账**：那边是本库的题（642），
        //    这边是 punch 库的题（3230），两边零交集。名字上就要分得开，
        //    所以叫「货架题目」而不是「题目」。
        path: "/shelf/questions",
        name: "货架题目",
        hint: "punch 库那 3230 道题（关键词 + 考点/题型/册 筛选）—— 与本库题库零交集",
      },
      {
        path: "/shelf/reconcile",
        name: "资料对账",
        hint: "货架成品 ↔ 本库 SKU / 网盘指针，差异只报不改",
      },
    ],
  },
  {
    key: "/g/student",
    name: "学情中心",
    children: [
      {
        path: "/student",
        name: "学员名册",
        hint: "代号名册（无真名字段）",
      },
      {
        path: "/cause",
        name: "错因管理",
        hint: "错因实体 + 映射 + unmapped 红旗",
      },
    ],
  },
  {
    key: "/g/queue",
    name: "审查队列",
    children: [
      { path: "/queue", name: "处置台", hint: "所有等人拍板的东西一个入口" },
    ],
  },
  {
    key: "/g/grading",
    name: "批改流水线",
    children: [
      {
        path: "/grading/intake",
        name: "收卷录入",
        hint: "选学员 → 传图 → 提交即入队",
      },
      {
        path: "/grading/board",
        name: "批改看板",
        hint: "审核.db（mode=ro）+ 编排台账",
      },
      {
        path: "/grading/review",
        name: "终审台",
        hint: "逐题 √/×/去掉 · 写全部 spawn 圣域的 审核库.py",
      },
      {
        path: "/grading/gate",
        name: "升档判据",
        hint: "翻案率/存疑率/风险台账",
      },
      {
        path: "/grading/reports",
        name: "报告架",
        hint: "已出件报告取件台",
      },
    ],
  },
  {
    key: "/g/sys",
    name: "系统监控",
    children: [
      {
        path: "/audit",
        name: "审计日志",
        hint: "谁在什么时候动了库",
      },
      {
        path: "/health",
        name: "备份与对账",
        hint: "快照 + 对账六项 + 回归",
      },
    ],
  },
];

export interface HiddenCrumb {
  prefix: string;
  /**
   * 末段匹配（集成收口②补）：`/sku/<id>/status`、`/sku/<id>/dedup`、
   * `/kg/kp/<id>/retire` 这类**中缀带 id** 的确认页，靠前缀表达不出来 ——
   * `/sku/` 必然先命中，于是三张确认页的面包屑都显示成上一层的「详情」，
   * 人站在一个会改库的确认页上，面包屑却说这是详情页。
   * 🔴 有 suffix 的条目要求 **prefix 与 suffix 同时命中**，
   *    且在 {@link crumbsFor} 里**先于**纯前缀条目匹配（否则照样被泛前缀吃掉）。
   */
  suffix?: string;
  group: string;
  name: string;
  /**
   * 上一级列表页的路由（面包屑里画成可点的一层）。
   * 🔴 AI:PRD-009 · 检查单 ④⑧：详情页原先的面包屑是「知识工厂 / 题库管理 / 题目详情」——
   *    中间那层是组名（伪路径，点不动），于是从详情页回列表页**没有一条路**，
   *    只能靠浏览器后退。补一层可点的父页，闭环才叫闭环。
   *    旧地址/无列表页的（如 /kg/queue）不填，宁可少一层也不给一个跳错的链接。
   */
  parent?: string;
}

/**
 * 不进菜单、但要有面包屑的地址（详情页 / 旧路由）。
 * 🔴 详情页不进菜单是若依的习惯：它们要 id 才打得开，菜单上放一个打不开的入口没有意义。
 */
export const HIDDEN_CRUMBS: HiddenCrumb[] = [
  // 🔴 /q/ 与 /search 已下线（2026-08-14，设计稿 §一 的两处路由改造）：
  //    题目详情迁到 /question/[id]（四 tab），检索并进 /question。
  //    这里不留它们的面包屑 —— 留着等于告诉人那两个地址还在。
  {
    prefix: "/question/",
    group: "题库管理",
    name: "题目详情",
    parent: "/question",
  },
  // 🔴 末段匹配的三条（集成收口②）：确认页 ≠ 详情页，面包屑必须分得开。
  //    它们靠 suffix 命中，与在表里的先后无关（crumbsFor 先扫一遍带 suffix 的）。
  {
    prefix: "/kg/kp/",
    suffix: "/retire",
    group: "知识图谱",
    name: "考点退役确认",
    parent: "/kg",
  },
  {
    prefix: "/sku/",
    suffix: "/status",
    group: "生产管理",
    name: "上下架确认",
    parent: "/sku",
  },
  {
    prefix: "/sku/",
    suffix: "/dedup",
    group: "生产管理",
    name: "排重报告",
    parent: "/sku",
  },
  { prefix: "/kg/kp/", group: "知识图谱", name: "考点详情", parent: "/kg" },
  { prefix: "/kg/tree/", group: "知识图谱", name: "版本树", parent: "/kg" },
  // 🔴 合并向导的两步（AI:PRD-009 补）：原先这两个地址一条前缀都不中，
  //    面包屑只剩「知识工厂」一层 —— 人在确认页上看不出自己站在哪儿。
  //    必须排在任何 `/kg/` 泛前缀之前（本表当下没有泛 `/kg/`，先占好位）。
  {
    prefix: "/kg/merge/preview",
    group: "知识图谱",
    name: "合并预览",
    parent: "/kg/merge",
  },
  {
    prefix: "/kg/merge/done/",
    group: "知识图谱",
    name: "合并结果",
    parent: "/kg/merge",
  },
  { prefix: "/kg/queue", group: "审查队列", name: "处置台（旧地址）" },
  {
    prefix: "/queue/quarantine/",
    group: "审查队列",
    name: "隔离行处置",
    parent: "/queue",
  },
  { prefix: "/queue/", group: "审查队列", name: "工单处置", parent: "/queue" },
  // 生产管理（详情 / 确认页）
  { prefix: "/sku/", group: "生产管理", name: "SKU 详情", parent: "/sku" },
  { prefix: "/model/", group: "生产管理", name: "模型族谱", parent: "/model" },
  // 学情中心（详情 / 确认页）
  // 🔴 /cause/map 必须排在这里、且排在任何 `/cause` 泛前缀之前，
  //    否则确认页会被认成错因管理列表页。
  // 🔴 /cause/remap 已下线（2026-08-14：删映射行超出写操作白名单五类），
  //    这里也不留它的面包屑 —— 留着等于告诉人那儿还有一页。
  {
    prefix: "/cause/map",
    group: "学情中心",
    name: "补错因映射",
    parent: "/cause",
  },
  {
    prefix: "/student/",
    group: "学情中心",
    name: "学员学情",
    parent: "/student",
  },
  // 批改流水线（详情页）
  // 🔴 必须排在任何 `/grading/re…` 泛前缀之前不成问题：`/grading/review` 本身
  //    在菜单里有精确项，crumbsFor 先走精确匹配，只有 `/grading/review/<代号>/<天>`
  //    才落到这条上。
  {
    prefix: "/grading/review/",
    group: "批改流水线",
    name: "逐题终审",
    parent: "/grading/review",
  },
  // 资料货架（详情页）
  // 🔴 `/shelf/reconcile` 在菜单里有精确项，crumbsFor 先走精确匹配，
  //    所以只有 `/shelf/doc/<id>` 会落到这条上。
  {
    prefix: "/shelf/doc/",
    group: "资料货架",
    name: "册子详情",
    parent: "/shelf",
  },
];

export interface Crumbs {
  group: string;
  name: string;
  /** 命中的菜单项（旧地址/详情页为 null） */
  item: ConsoleMenuItem | null;
  /**
   * 可点的上一级列表页（详情页才有；列表页自己没有上一级）。
   * 🔴 只在菜单正本里真有这一项时才给 —— 父路由写错了的面包屑
   *    比没有面包屑更糟（点过去 404）。
   */
  parent: { path: string; name: string } | null;
}

/** 按路由取菜单项（找不到返回 null —— 不猜名字） */
export function menuItemByPath(path: string): ConsoleMenuItem | null {
  for (const g of CONSOLE_MENU) {
    for (const it of g.children) if (it.path === path) return it;
  }
  return null;
}

/**
 * 当前路径 → 面包屑（组 / 页）。
 * 🔴 先精确匹配菜单项，再看隐藏表，都不中就只给「知识工厂」一层 ——
 *    宁可少一层，也不猜一个可能错的名字。
 */
export function crumbsFor(pathname: string): Crumbs | null {
  for (const g of CONSOLE_MENU) {
    for (const it of g.children) {
      if (it.path === pathname)
        return { group: g.name, name: it.name, item: it, parent: null };
    }
  }
  // 🔴 带 suffix 的先扫（集成收口②）：`/sku/<id>/status` 这种中缀带 id 的确认页，
  //    若让纯前缀条目先跑，`/sku/` 一定先中，确认页会被叫成「SKU 详情」。
  for (const h of HIDDEN_CRUMBS) {
    if (!h.suffix) continue;
    if (pathname.startsWith(h.prefix) && pathname.endsWith(h.suffix)) {
      return crumbOf(h);
    }
  }
  for (const h of HIDDEN_CRUMBS) {
    if (h.suffix) continue;
    if (pathname.startsWith(h.prefix)) return crumbOf(h);
  }
  return null;
}

function crumbOf(h: HiddenCrumb): Crumbs {
  const p = h.parent ? menuItemByPath(h.parent) : null;
  return {
    group: h.group,
    name: h.name,
    item: null,
    parent: p ? { path: p.path, name: p.name } : null,
  };
}

/**
 * 当前路径在菜单里应该高亮哪一项（详情页高亮它所属的列表页）。
 * 例：/question/xxx → /question；/kg/kp/xxx → /kg；/queue/xxx/reject → /queue。
 */
export function selectedPathFor(pathname: string): string {
  if (pathname === "/") return "/";
  if (pathname.startsWith("/question")) return "/question";
  if (pathname.startsWith("/queue") || pathname.startsWith("/kg/queue")) {
    return "/queue";
  }
  if (pathname.startsWith("/kg/merge")) return "/kg/merge";
  if (pathname.startsWith("/kg")) return "/kg";
  // 其余：拿最长的可点菜单项前缀
  let best = "";
  for (const g of CONSOLE_MENU) {
    for (const it of g.children) {
      if (
        it.path !== "/" &&
        pathname.startsWith(it.path) &&
        it.path.length > best.length
      ) {
        best = it.path;
      }
    }
  }
  return best;
}
