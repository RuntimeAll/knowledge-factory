/**
 * scripts/load-primary-kg-20260815.ts —— 🔴 **一次性导底脚本**（AI:PRD-010 · 小学数学 KG 入库段）
 *
 * 2026-08-15 跑过**一次**就退役：把 PRD-010 的 13 份载荷（930 个小学数学考点 +
 * 1312 条别名 + 人教版一上~六下 12 棵树 / 272 节点 / 1122 挂载）增量灌进**已有
 * 415 个初中考点的活库**。它不是常驻同步通路——日后 KG 增删改一律走 core 写原语。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/load-primary-kg-20260815.ts            # 默认 dry-run（零写）
 *   pnpm exec tsx --env-file=.env scripts/load-primary-kg-20260815.ts --dry-run  # 同上，显式
 *   pnpm exec tsx --env-file=.env scripts/load-primary-kg-20260815.ts --commit   # 真灌
 *   …… --src <载荷目录>                                                          # 载荷搬走了指过去
 * 退出码：0=全绿；1=有闸没过 / 灌后验证没过（dry-run 红了则一行都没写）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 四条纪律（与 002 的 load-kg-20260812.ts 一脉相承，差异写在旁边）
 *
 * ① **默认 dry-run**。002 是空库导底，有「五表全空」的幂等闸兜底；本次是**在活库上
 *    增量灌**，那道闸用不了（用了必红），所以改用「默认不写、要写得显式说」——
 *    危险动作必须打字才发生。
 * ② **载荷之外零自造数据**（G-3）。脚本只做「读 JSON → 校验 → 原样喂 importKgBatch」，
 *    不改一个字：不补名、不改域、不猜挂载。报表对不上就停下报告，不擅自补。
 *    002 里那处「去章号」变换在本脚本里**没有对应物**——本批不做任何值变换。
 * ③ **入库前跑满两组闸，一票否决**：P 组＝载荷内部自洽（8 道），G 组＝与活库交叉
 *    （5 道，含撞名复核必须 0 / C6 活跃树不撞 / id 不碰撞）。红了一行都不写。
 * ④ **一切经 core**：1 批概念层 + 12 批树 = 13 次 importKgBatch，一批一事务全进或全不进。
 *    actor='human'（导底是人拍板的一次性动作），tool='load_primary_kg_20260815'
 *    （日后 `SELECT tool,COUNT(*) FROM audit_log GROUP BY tool` 一眼认得出）。
 *    真灌**前后各一次 backupNow**：前者是退路（活库上加东西必须能退），后者是新基线。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 载荷里的 ULID 是校对层**一次性生成**的；importKgBatch 是 insert 不是 upsert，
 *    同 id 再灌一次 = 主键冲突整批回滚。所以本脚本只能跑一次 --commit。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  backupNow,
  closeCoreDb,
  closeGradingDb,
  getCoreDb,
  importKgBatch,
  integrityCheck,
  kpContext,
  resolveKp,
  type CoreDbHandle,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量（改这里之前先问：载荷是不是也换了）
// ---------------------------------------------------------------------------

/** PRD-010 导底载荷（只读）。搬走了就用 --src 指过去。 */
const 载荷目录默认 = "D:/workplace/ai-bkb/codeplace-AI/prd/PRD-010/导底载荷";

/** 🔴 本批学科：独立于库里现有的「初中数学」，两者并存互不干扰。 */
const SUBJECT = "小学数学";
const EDITION = "人教版";

/** 灌库顺序：概念层必须最先（12 棵树的 maps 全部引用它建的 kpId）。 */
const 概念层文件名 = "载荷-00-概念层.json";
const 册序 = [
  "一上",
  "一下",
  "二上",
  "二下",
  "三上",
  "三下",
  "四上",
  "四下",
  "五上",
  "五下",
  "六上",
  "六下",
] as const;
type 册 = (typeof 册序)[number];

const 审计工具名 = "load_primary_kg_20260815";
const COMMIT_FLAG = "--commit";

/**
 * 概念层名字里绝不许出现的内部词（闸 P2）。
 * 🔴 与 002 的差异：002 的名单含「层」，本批**去掉**它——载荷里
 * 「按多标准逐层分类」的「逐层」是数学构词（逐层分类），不是内部难度层。
 * 校对报告 §8 闸② 也是按 ★/素材/薄弱 三词跑绿的。名单缩小是显式裁决，
 * 不是漏写；「层」改成 WARN 逐条列出来，人看一眼再放行。
 */
const 内部词 = ["★", "素材", "薄弱"];
const 疑似内部词 = ["层"];
/** 教材节号形状（闸 P2）：`1.2 xxx` —— 概念层版本无关，节号是版本相关的 */
const 教材节号 = /\d+\.\d+/;
/** 学段前缀（闸 P2）：考点名不带学段，学段靠 gradeBand / 树的 gradeSem 表达 */
const 学段前缀 = /^[一二三四五六](上|下)/;

const kpId形状 = /^kp_[0-9A-HJKMNP-TV-Z]{26}$/;
const treeId形状 = /^tree_[0-9A-HJKMNP-TV-Z]{26}$/;
const nodeId形状 = /^node_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 🔴 校对报告 §2「统计报表」的机器复述 —— 载荷解析出来的数必须**逐树**对上它。
 * 对不上 = 载荷换了内容（或我解析错了），停下来报告，不猜不补（G-3）。
 * 列：章 / 节 / 该树挂到的不同考点数 / 挂载数 / 该树考点名下的别名数（重复计）。
 */
const 报表基线: Record<
  册,
  { 章: number; 节: number; 考点: number; 挂载: number; 别名: number }
> = {
  一上: { 章: 6, 节: 6, 考点: 39, 挂载: 39, 别名: 49 },
  一下: { 章: 7, 节: 7, 考点: 47, 挂载: 81, 别名: 44 },
  二上: { 章: 7, 节: 32, 考点: 43, 挂载: 44, 别名: 62 },
  二下: { 章: 5, 节: 10, 考点: 75, 挂载: 80, 别名: 114 },
  三上: { 章: 9, 节: 14, 考点: 116, 挂载: 126, 别名: 122 },
  三下: { 章: 7, 节: 11, 考点: 107, 挂载: 109, 别名: 82 },
  四上: { 章: 9, 节: 12, 考点: 98, 挂载: 103, 别名: 174 },
  四下: { 章: 10, 节: 18, 考点: 110, 挂载: 111, 别名: 161 },
  五上: { 章: 9, 节: 18, 考点: 128, 挂载: 135, 别名: 327 },
  五下: { 章: 8, 节: 17, 考点: 104, 挂载: 109, 别名: 208 },
  六上: { 章: 7, 节: 24, 考点: 110, 挂载: 110, 别名: 167 },
  六下: { 章: 5, 节: 14, 考点: 74, 挂载: 75, 别名: 65 },
};

/** 校对报告 §0 的总量基线（去重后真实规模） */
const 总量基线 = {
  kp: 930,
  alias: 1312,
  tree: 12,
  node: 272, // 89 章 + 183 节
  map: 1122,
  跨树复用kp: 87,
} as const;

/**
 * 🔴 改名消歧核查（校对报告 §5.1 的 5 条，抽 3 条做灌后自检）：
 * 新名（小学，本批建）与旧名（初中，库里已有）必须**并存、各归各树**。
 */
const 消歧对: { 新: string; 旧: string; 说明: string }[] = [
  {
    新: "平行四边形的特征",
    旧: "平行四边形的性质",
    说明: "小学只到「对边平行且相等」直观特征；初中八下要证三条性质",
  },
  {
    新: "角的分类（按度数）",
    旧: "角的分类",
    说明: "小学四上＝量角器度量后辨认锐/直/钝/平/周角；初中七上＝角的比较与运算",
  },
  {
    新: "比例中项的求法",
    旧: "比例中项",
    说明: "小学六下只求数值比例中项；初中＝比例线段中项",
  },
];

/** 🔴 灌后 resolve_kp 实测：5 个小学考点名 + 2 个别名（校对报告 §3 的跨树复用户口） */
const 冒烟考点名: { q: string; 期望树数?: number; 场景: string }[] = [
  {
    q: "归一问题",
    期望树数: 5,
    场景: "典型应用题查考点：跨 5 册复用，只能出 1 条候选",
  },
  { q: "归总问题", 期望树数: 5, 场景: "同上，与归一问题成对" },
  {
    q: "平行四边形的特征",
    期望树数: 1,
    场景: "🔴 改名消歧后的新名，必须查得到它本人",
  },
  { q: "认识轴对称图形", 期望树数: 3, 场景: "图形与几何跨三册复用" },
  {
    q: "倒数的意义与求法",
    期望树数: 1,
    场景: "别名「倒数」已按 §5.2 删掉，正名仍要命中",
  },
];
const 冒烟别名: { q: string; 期望考点: string; 场景: string }[] = [
  {
    q: "两次归一",
    期望考点: "归一问题",
    场景: "老师嘴里的说法（源书目录用词）",
  },
  {
    q: "轴对称图形的判断",
    期望考点: "认识轴对称图形",
    场景: "出题查专项：别名精确命中",
  },
];

// ---------------------------------------------------------------------------
// 载荷形状（zod 兜一道：载荷换了形状要当场炸，不要写进库才发现）
// ---------------------------------------------------------------------------

const 载荷考点 = z.object({
  id: z.string(),
  name: z.string(),
  gradeBand: z.string().nullable(),
  domain: z.string().nullable(),
  topic: z.string().nullable(),
  cardMd: z.string().nullable(),
  /**
   * 🔴 只认可创建状态：importKgBatch 的 kps 段就只收 draft|active
   * （merged/retired 是合并/退役后的落点，不可能是「刚建出来」的状态）。
   * 这里收窄到与 core 契约一致，形状不对当场炸在读载荷那一步，而不是灌到一半才炸。
   */
  status: z.enum(["draft", "active"]),
});
const 载荷别名 = z.object({ kpId: z.string(), alias: z.string() });
const 载荷树 = z.object({
  id: z.string(),
  subject: z.string(),
  edition: z.string(),
  gradeSem: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["active", "readonly"]),
});
const 载荷节点 = z.object({
  id: z.string(),
  treeId: z.string(),
  parentId: z.string().nullable(),
  level: z.number().int(),
  name: z.string(),
  sort: z.number().int(),
});
const 载荷映射 = z.object({ nodeId: z.string(), kpId: z.string() });

const 载荷文件 = z.object({
  kps: z.array(载荷考点),
  aliases: z.array(载荷别名),
  /** 概念层那批显式写着 `"tree": null`（它不带树），树批才是对象 */
  tree: 载荷树.nullish(),
  nodes: z.array(载荷节点),
  maps: z.array(载荷映射),
});
type 载荷 = z.output<typeof 载荷文件>;

interface 断言 {
  ok: boolean;
  name: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// 输出（全程落 stdout，导底记录要留档）
// ---------------------------------------------------------------------------

function 说(s = ""): void {
  process.stdout.write(s + "\n");
}
function 标题(s: string): void {
  说();
  说("=".repeat(78));
  说(s);
  说("=".repeat(78));
}
function 判(a: 断言): void {
  说(`  ${a.ok ? "[PASS]" : "[FAIL]"} ${a.name}`);
  说(`         ${a.detail}`);
}
/** 长清单只打前 N 条，剩下报个数——报告要能一眼看完 */
function 列(xs: string[], n = 8): string {
  return xs.length <= n
    ? xs.join("、")
    : `${xs.slice(0, n).join("、")}…（共 ${xs.length} 条）`;
}

// ---------------------------------------------------------------------------
// 读载荷
// ---------------------------------------------------------------------------

function 读载荷(path: string): 载荷 {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const r = 载荷文件.safeParse(raw);
  if (!r.success) {
    throw new Error(`载荷形状不对：${path}\n${z.prettifyError(r.error)}`);
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// P 组闸：载荷内部自洽（不碰库）
// ---------------------------------------------------------------------------

function 跑P闸(概念层: 载荷, 树们: { 册: 册; 载荷: 载荷 }[]): 断言[] {
  const out: 断言[] = [];
  const kps = 概念层.kps;
  const 名集 = new Set(kps.map((k) => k.name));
  const idToName = new Map(kps.map((k) => [k.id, k.name]));

  // ── P1 考点自身：id 唯一/形状、名唯一、gradeBand、status ──────────────────
  const idDup = kps.length - new Set(kps.map((k) => k.id)).size;
  const 形状坏 = kps.filter((k) => !kpId形状.test(k.id)).map((k) => k.id);
  const 名重 = kps.length - 名集.size;
  const 学段坏 = [...new Set(kps.map((k) => k.gradeBand))].filter(
    (g) => g !== "小学",
  );
  const 状态坏 = [...new Set(kps.map((k) => k.status))].filter(
    (s) => s !== "active",
  );
  out.push({
    ok:
      idDup === 0 &&
      形状坏.length === 0 &&
      名重 === 0 &&
      学段坏.length === 0 &&
      状态坏.length === 0,
    name: "P1 考点：id 唯一且形状对 / 名全局唯一 / gradeBand 全「小学」/ status 全 active",
    detail:
      `kp ${kps.length} 个：重复 id ${idDup}、形状不合 ${形状坏.length}、` +
      `重名 ${名重}、gradeBand 异值 ${学段坏.length ? 学段坏.join("／") : 0}、` +
      `status 异值 ${状态坏.length ? 状态坏.join("／") : 0}`,
  });

  // ── P2 名干净 ────────────────────────────────────────────────────────────
  const 带内部词 = kps.filter((k) => 内部词.some((w) => k.name.includes(w)));
  const 带节号 = kps.filter((k) => 教材节号.test(k.name));
  const 带学段 = kps.filter((k) => 学段前缀.test(k.name));
  const 带空白 = kps.filter((k) => k.name !== k.name.trim() || k.name === "");
  const 疑似 = kps.filter((k) => 疑似内部词.some((w) => k.name.includes(w)));
  out.push({
    ok:
      带内部词.length === 0 &&
      带节号.length === 0 &&
      带学段.length === 0 &&
      带空白.length === 0,
    name: "P2 考点名干净（无内部词 / 无教材节号 / 无学段前缀 / 无空白异常）",
    detail:
      `内部词(${内部词.join("")}) ${带内部词.length}` +
      `${带内部词.length ? `：${列(带内部词.map((k) => k.name))}` : ""}；` +
      `教材节号 ${带节号.length}；学段前缀 ${带学段.length}；空白异常 ${带空白.length}`,
  });
  if (疑似.length > 0) {
    说(
      `         [WARN] 疑似内部词(${疑似内部词.join("")}) 命中 ${疑似.length} 条：` +
        `${列(疑似.map((k) => k.name))}` +
        " —— 人看过：是数学构词（逐层分类）不是难度层，故放行（见文件头常量注释）",
    );
  }

  // ── P3 别名 ──────────────────────────────────────────────────────────────
  const 别名坏引用 = 概念层.aliases.filter((a) => !idToName.has(a.kpId));
  const 对子 = new Set<string>();
  const 别名重: string[] = [];
  for (const a of 概念层.aliases) {
    const key = `${a.kpId}|${a.alias}`;
    if (对子.has(key)) 别名重.push(a.alias);
    对子.add(key);
  }
  const 别名带逗号 = 概念层.aliases.filter((a) => a.alias.includes(","));
  const 别名撞正名 = 概念层.aliases.filter((a) => 名集.has(a.alias));
  const 别名归属 = new Map<string, Set<string>>();
  for (const a of 概念层.aliases) {
    const s = 别名归属.get(a.alias) ?? new Set<string>();
    s.add(a.kpId);
    别名归属.set(a.alias, s);
  }
  const 歧义别名 = [...别名归属.entries()].filter(([, s]) => s.size > 1);
  out.push({
    ok:
      别名坏引用.length === 0 &&
      别名重.length === 0 &&
      别名带逗号.length === 0 &&
      别名撞正名.length === 0 &&
      歧义别名.length === 0,
    name: "P3 别名：kpId 全在本批 / (kpId,alias) 无重复 / 无英文逗号 / 不撞新正名 / 无歧义别名",
    detail:
      `别名 ${概念层.aliases.length} 条：坏引用 ${别名坏引用.length}、重复对 ${别名重.length}、` +
      `含英文逗号 ${别名带逗号.length}、撞新正名 ${别名撞正名.length}` +
      `${别名撞正名.length ? `（${列(别名撞正名.map((a) => a.alias))}）` : ""}、` +
      `一名对多考点 ${歧义别名.length}` +
      `${歧义别名.length ? `（${列(歧义别名.map(([n]) => n))}）` : ""}`,
  });

  // ── P4/P5/P6 逐树：形状 / 映射 / 空节 ─────────────────────────────────────
  const 全node = new Map<string, { 册: 册; level: number; treeId: string }>();
  const 树形坏: string[] = [];
  const 映射坏: string[] = [];
  const 空节: string[] = [];
  const 非空kps: string[] = [];
  for (const { 册: g, 载荷: p } of 树们) {
    if (!p.tree) {
      树形坏.push(`${g}：没有 tree 段`);
      continue;
    }
    if (p.kps.length > 0 || p.aliases.length > 0) {
      非空kps.push(`${g}(kps=${p.kps.length},aliases=${p.aliases.length})`);
    }
    if (!treeId形状.test(p.tree.id)) 树形坏.push(`${g}：treeId 形状不合`);
    if (p.tree.subject !== SUBJECT)
      树形坏.push(`${g}：subject=${p.tree.subject}`);
    if (p.tree.edition !== EDITION)
      树形坏.push(`${g}：edition=${p.tree.edition}`);
    if (p.tree.gradeSem !== g) 树形坏.push(`${g}：gradeSem=${p.tree.gradeSem}`);
    if (p.tree.status !== "active")
      树形坏.push(`${g}：树 status=${p.tree.status}`);

    const 本树节点 = new Map(p.nodes.map((n) => [n.id, n]));
    for (const n of p.nodes) {
      if (!nodeId形状.test(n.id))
        树形坏.push(`${g}/${n.name}：nodeId 形状不合`);
      if (n.treeId !== p.tree.id)
        树形坏.push(`${g}/${n.name}：treeId 不是本树`);
      if (n.level !== 1 && n.level !== 2)
        树形坏.push(`${g}/${n.name}：level=${n.level}`);
      if (n.level === 1 && n.parentId !== null)
        树形坏.push(`${g}/${n.name}：章有 parentId`);
      if (n.level === 2) {
        const 父 = n.parentId ? 本树节点.get(n.parentId) : undefined;
        if (!父) 树形坏.push(`${g}/${n.name}：节的 parentId 在本树找不到`);
        else if (父.level !== 1) 树形坏.push(`${g}/${n.name}：节的父不是章`);
      }
      if (全node.has(n.id)) 树形坏.push(`${g}/${n.name}：nodeId 与别的树碰撞`);
      全node.set(n.id, { 册: g, level: n.level, treeId: n.treeId });
    }

    const 见过 = new Set<string>();
    const 挂到 = new Set<string>();
    for (const m of p.maps) {
      const n = 本树节点.get(m.nodeId);
      if (!n) 映射坏.push(`${g}：nodeId ${m.nodeId} 不属本树`);
      else if (n.level !== 2)
        映射坏.push(`${g}/${n.name}：挂到了 level=${n.level} 上`);
      if (!idToName.has(m.kpId)) 映射坏.push(`${g}：kpId ${m.kpId} 不在概念层`);
      const key = `${m.nodeId}|${m.kpId}`;
      if (见过.has(key)) {
        映射坏.push(
          `${g}：重复 (节点,考点) 对 ${n?.name ?? m.nodeId}→${idToName.get(m.kpId) ?? m.kpId}`,
        );
      }
      见过.add(key);
      挂到.add(m.nodeId);
    }
    for (const n of p.nodes) {
      if (n.level === 2 && !挂到.has(n.id)) 空节.push(`${g}/${n.name}`);
    }
  }
  out.push({
    ok: 树形坏.length === 0 && 非空kps.length === 0,
    name: "P4 树形状：treeId/学科/版本/册一致，level∈{1,2}，章无父·节父是同树的章，node id 不碰撞",
    detail:
      `12 棵树 ${全node.size} 个节点：形状问题 ${树形坏.length}` +
      `${树形坏.length ? `（${列(树形坏)}）` : ""}；` +
      `树文件里 kps/aliases 非空 ${非空kps.length}` +
      `${非空kps.length ? `（${非空kps.join("、")}）🔴 跨册复用的考点只能建一次` : "（全空，符合口径）"}`,
  });
  out.push({
    ok: 映射坏.length === 0,
    name: "P5 映射：nodeId 属本树且是节 / kpId 在概念层 / (节点,考点) 对不重复",
    detail:
      `映射 ${树们.reduce((a, t) => a + t.载荷.maps.length, 0)} 条：问题 ${映射坏.length}` +
      `${映射坏.length ? `（${列(映射坏)}）` : ""}`,
  });
  out.push({
    ok: 空节.length === 0,
    name: "P6 无空节（每个 level=2 的节至少挂一个考点）",
    detail: `空节 ${空节.length}${空节.length ? `（${列(空节)}）` : ""}`,
  });

  // ── P7 孤儿考点 ──────────────────────────────────────────────────────────
  const 被挂 = new Set<string>();
  for (const { 载荷: p } of 树们) for (const m of p.maps) 被挂.add(m.kpId);
  const 孤儿 = kps.filter((k) => !被挂.has(k.id));
  out.push({
    ok: 孤儿.length === 0,
    name: "P7 孤儿考点（无任何挂载）= 0",
    detail:
      `${孤儿.length} 个${孤儿.length ? `：${列(孤儿.map((k) => k.name))}` : ""}` +
      "（002 那道「孤儿豁免名单」在本批不适用：本批不许有孤儿）",
  });

  // ── P8 全局 id 不碰撞（kp / tree / node 三类混着看）──────────────────────
  const 全id = new Set<string>();
  const 碰撞: string[] = [];
  for (const k of kps) {
    if (全id.has(k.id)) 碰撞.push(k.id);
    全id.add(k.id);
  }
  for (const { 载荷: p } of 树们) {
    if (p.tree) {
      if (全id.has(p.tree.id)) 碰撞.push(p.tree.id);
      全id.add(p.tree.id);
    }
    for (const n of p.nodes) {
      if (全id.has(n.id)) 碰撞.push(n.id);
      全id.add(n.id);
    }
  }
  out.push({
    ok: 碰撞.length === 0,
    name: "P8 全批 id（930 kp + 12 tree + 272 node）两两不碰撞",
    detail: `共 ${全id.size} 个 id，碰撞 ${碰撞.length}${碰撞.length ? `（${列(碰撞)}）` : ""}`,
  });

  return out;
}

// ---------------------------------------------------------------------------
// G 组闸：与活库交叉（只读）
// ---------------------------------------------------------------------------

interface 库现状 {
  活跃名: Map<string, string>; // name → id
  别名: Map<string, string[]>; // alias → kpId[]
  id集: Set<string>;
  活跃树: Set<string>; // `${subject}|${edition}|${gradeSem}`
  计数: Record<string, number>;
}

async function 数(h: CoreDbHandle, table: string): Promise<number> {
  const r = await h.client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  const row = r.rows[0] as unknown as { c: number | bigint } | undefined;
  return Number(row?.c ?? -1);
}

async function 读库现状(h: CoreDbHandle): Promise<库现状> {
  const 活跃名 = new Map<string, string>();
  const id集 = new Set<string>();
  const r1 = await h.client.execute("SELECT id, name, status FROM kp");
  for (const row of r1.rows as unknown as {
    id: string;
    name: string;
    status: string;
  }[]) {
    id集.add(row.id);
    if (row.status === "draft" || row.status === "active") {
      活跃名.set(row.name, row.id);
    }
  }
  const 别名 = new Map<string, string[]>();
  const r2 = await h.client.execute("SELECT kp_id, alias FROM kp_alias");
  for (const row of r2.rows as unknown as { kp_id: string; alias: string }[]) {
    别名.set(row.alias, [...(别名.get(row.alias) ?? []), row.kp_id]);
  }
  const 活跃树 = new Set<string>();
  const r3 = await h.client.execute(
    "SELECT id, subject, edition, grade_sem, status FROM edition_tree",
  );
  for (const row of r3.rows as unknown as {
    id: string;
    subject: string;
    edition: string;
    grade_sem: string;
    status: string;
  }[]) {
    id集.add(row.id);
    if (row.status === "active") {
      活跃树.add(`${row.subject}|${row.edition}|${row.grade_sem}`);
    }
  }
  const r4 = await h.client.execute("SELECT id FROM edition_node");
  for (const row of r4.rows as unknown as { id: string }[]) id集.add(row.id);

  const 计数: Record<string, number> = {};
  for (const t of [
    "kp",
    "kp_alias",
    "edition_tree",
    "edition_node",
    "node_kp_map",
    "kp_fts",
  ]) {
    计数[t] = await 数(h, t);
  }
  return { 活跃名, 别名, id集, 活跃树, 计数 };
}

function 跑G闸(
  概念层: 载荷,
  树们: { 册: 册; 载荷: 载荷 }[],
  现状: 库现状,
): 断言[] {
  const out: 断言[] = [];
  const 新名 = 概念层.kps.map((k) => k.name);
  const 新名集 = new Set(新名);

  // ── G1 🔴 撞名复核：新考点名 vs 库里 415 个活跃名 —— 必须 0 ────────────────
  const 撞活跃名 = 新名.filter((n) => 现状.活跃名.has(n));
  out.push({
    ok: 撞活跃名.length === 0,
    name: "G1 🔴 新考点名 × 库内活跃考点名：撞名 = 0",
    detail:
      `库内活跃名 ${现状.活跃名.size} 个 × 新名 ${新名.length} 个 → 撞 ${撞活跃名.length}` +
      `${撞活跃名.length ? `：${列(撞活跃名)}（kp.name 全局唯一是硬约束，撞了插不进去）` : "（校对报告 §5.1 的 5 条已改名消歧）"}`,
  });

  // ── G2 新考点名 vs 库内已有别名；新别名 vs 库内活跃名 ──────────────────────
  const 新名撞旧别名 = 新名.filter((n) => 现状.别名.has(n));
  const 新别名撞旧活跃名 = [
    ...new Set(概念层.aliases.map((a) => a.alias)),
  ].filter((a) => 现状.活跃名.has(a));
  const 新别名撞旧别名 = [
    ...new Set(概念层.aliases.map((a) => a.alias)),
  ].filter((a) => 现状.别名.has(a));
  out.push({
    ok: 新名撞旧别名.length === 0 && 新别名撞旧活跃名.length === 0,
    name: "G2 新名不撞库内别名 / 新别名不撞库内活跃考点名（撞了=污染初中面的 resolve）",
    detail:
      `新名撞库内别名 ${新名撞旧别名.length}` +
      `${新名撞旧别名.length ? `（${列(新名撞旧别名)}）` : ""}；` +
      `新别名撞库内活跃名 ${新别名撞旧活跃名.length}` +
      `${新别名撞旧活跃名.length ? `（${列(新别名撞旧活跃名)}）` : "（§5.2 的 3 条已删）"}`,
  });
  if (新别名撞旧别名.length > 0) {
    说(
      `         [WARN] 新别名与库内已有别名同名 ${新别名撞旧别名.length} 条：` +
        `${列(新别名撞旧别名)} —— 不违约（(kp_id,alias) 才是主键），但一查会出跨学段双候选`,
    );
  }

  // ── G3 id 不与库里已有行碰撞 ────────────────────────────────────────────
  const 新id: string[] = 概念层.kps.map((k) => k.id);
  for (const { 载荷: p } of 树们) {
    if (p.tree) 新id.push(p.tree.id);
    for (const n of p.nodes) 新id.push(n.id);
  }
  const id碰撞 = 新id.filter((i) => 现状.id集.has(i));
  out.push({
    ok: id碰撞.length === 0,
    name: "G3 全批 id 与库内已有 id 不碰撞（importKgBatch 是 insert，撞了整批回滚）",
    detail: `新 id ${新id.length} 个 × 库内 ${现状.id集.size} 个 → 碰撞 ${id碰撞.length}${id碰撞.length ? `（${列(id碰撞)}）` : ""}`,
  });

  // ── G4 C6 活跃树唯一：12 棵新树 vs 库内 7 棵，且 12 棵互不重复 ──────────────
  const 键 = 树们
    .filter((t) => t.载荷.tree)
    .map(
      (t) =>
        `${t.载荷.tree!.subject}|${t.载荷.tree!.edition}|${t.载荷.tree!.gradeSem}`,
    );
  const 撞库 = 键.filter((k) => 现状.活跃树.has(k));
  const 自撞 = 键.length - new Set(键).size;
  out.push({
    ok: 撞库.length === 0 && 自撞 === 0 && 键.length === 12,
    name: "G4 C6 活跃树唯一：12 棵新树与库内 7 棵不撞、彼此不重复",
    detail:
      `新树 ${键.length} 棵：撞库内活跃树 ${撞库.length}${撞库.length ? `（${列(撞库)}）` : ""}、` +
      `自身重复 ${自撞}；库内活跃树 ${现状.活跃树.size} 棵`,
  });

  // ── G5 学科隔离：库里当前没有「小学数学」，本批全部落在它名下 ───────────────
  const 库内小学 = [...现状.活跃树].filter((k) => k.startsWith(`${SUBJECT}|`));
  const 学科异值 = [...new Set(树们.map((t) => t.载荷.tree?.subject))].filter(
    (s) => s !== SUBJECT,
  );
  out.push({
    ok: 库内小学.length === 0 && 学科异值.length === 0,
    name: `G5 学科隔离：库内现有「${SUBJECT}」树 0 棵，本批 subject 全是「${SUBJECT}」`,
    detail:
      `库内 ${SUBJECT} 树 ${库内小学.length} 棵、` +
      `本批 subject 异值 ${学科异值.length}${学科异值.length ? `（${学科异值.join("／")}）` : ""}；` +
      `与现有「初中数学」并存互不干扰`,
  });

  void 新名集;
  return out;
}

// ---------------------------------------------------------------------------
// 报表复核（逐树对校对报告 §2）
// ---------------------------------------------------------------------------

function 跑报表(概念层: 载荷, 树们: { 册: 册; 载荷: 载荷 }[]): 断言[] {
  const out: 断言[] = [];
  const 别名计 = new Map<string, number>();
  for (const a of 概念层.aliases) {
    别名计.set(a.kpId, (别名计.get(a.kpId) ?? 0) + 1);
  }
  说();
  说("  册     章   节   考点  挂载  别名  ｜ 基线（校对报告 §2）        判");
  说("  " + "-".repeat(74));
  let 全绿 = true;
  for (const { 册: g, 载荷: p } of 树们) {
    const 章 = p.nodes.filter((n) => n.level === 1).length;
    const 节 = p.nodes.filter((n) => n.level === 2).length;
    const 考点 = new Set(p.maps.map((m) => m.kpId));
    const 别名 = [...考点].reduce((a, id) => a + (别名计.get(id) ?? 0), 0);
    const b = 报表基线[g];
    const ok =
      章 === b.章 &&
      节 === b.节 &&
      考点.size === b.考点 &&
      p.maps.length === b.挂载 &&
      别名 === b.别名;
    if (!ok) 全绿 = false;
    说(
      `  ${g}   ${String(章).padStart(3)} ${String(节).padStart(4)} ` +
        `${String(考点.size).padStart(5)} ${String(p.maps.length).padStart(5)} ` +
        `${String(别名).padStart(5)}  ｜ ${b.章}/${b.节}/${b.考点}/${b.挂载}/${b.别名}` +
        `${" ".repeat(Math.max(1, 22 - `${b.章}/${b.节}/${b.考点}/${b.挂载}/${b.别名}`.length))}` +
        `${ok ? "✔" : "🔴"}`,
    );
  }
  out.push({
    ok: 全绿,
    name: "报表 R1 逐树（章/节/考点/挂载/别名）对上校对报告 §2",
    detail: 全绿
      ? "12 棵树五列全对"
      : "🔴 有列对不上 —— 载荷换了内容？G-3 红线：停下报告，不擅自补",
  });

  // 总量
  const node总 = 树们.reduce((a, t) => a + t.载荷.nodes.length, 0);
  const map总 = 树们.reduce((a, t) => a + t.载荷.maps.length, 0);
  const 挂载次数 = new Map<string, Set<string>>();
  for (const { 载荷: p } of 树们) {
    for (const m of p.maps) {
      const s = 挂载次数.get(m.kpId) ?? new Set<string>();
      s.add(p.tree!.id);
      挂载次数.set(m.kpId, s);
    }
  }
  const 跨树复用 = [...挂载次数.values()].filter((s) => s.size > 1).length;
  const 总量: [string, number, number][] = [
    ["kp", 概念层.kps.length, 总量基线.kp],
    ["alias", 概念层.aliases.length, 总量基线.alias],
    ["tree", 树们.length, 总量基线.tree],
    ["node", node总, 总量基线.node],
    ["map", map总, 总量基线.map],
    ["跨树复用 kp", 跨树复用, 总量基线.跨树复用kp],
  ];
  const 总量坏 = 总量.filter(([, a, b]) => a !== b);
  out.push({
    ok: 总量坏.length === 0,
    name: "报表 R2 总量对上校对报告 §0",
    detail: 总量
      .map(([n, a, b]) => `${n}=${a}${a === b ? "" : `🔴(基线${b})`}`)
      .join("  "),
  });
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function 取参(argv: string[], key: string): string | null {
  const i = argv.findIndex((a) => a === key || a.startsWith(`${key}=`));
  if (i < 0) return null;
  const a = argv[i] ?? "";
  const v = a.includes("=")
    ? a.split("=").slice(1).join("=")
    : (argv[i + 1] ?? "");
  return v.trim() === "" ? null : v.trim();
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  const argv = process.argv.slice(2);
  const commit = argv.includes(COMMIT_FLAG);
  const src = 取参(argv, "--src") ?? 载荷目录默认;

  标题(
    `AI:PRD-010 · 小学数学 KG 入库段（一次性脚本 ${审计工具名}）` +
      `　模式=${commit ? "🔴 COMMIT（真写库）" : "DRY-RUN（零写）"}`,
  );
  说(`载荷目录：${src}`);
  说(`学科口径：${SUBJECT}／${EDITION}　actor=human　tool=${审计工具名}`);
  说(`时间：${new Date().toLocaleString("zh-CN")}`);
  if (!commit) {
    说(`🔴 dry-run：一行都不写。确认零红后加 ${COMMIT_FLAG} 真灌。`);
  }

  const h = await getCoreDb();
  说(`目标库：${h.url}`);

  // ── ① 读载荷 ─────────────────────────────────────────────────────────────
  标题("① 读载荷（13 份）");
  const 概念层 = 读载荷(join(src, 概念层文件名));
  const 树们 = 册序.map((g) => ({
    册: g,
    载荷: 读载荷(join(src, `载荷-${g}.json`)),
  }));
  说(
    `  概念层：kps=${概念层.kps.length}　aliases=${概念层.aliases.length}` +
      `　tree=${概念层.tree ? 1 : 0}　nodes=${概念层.nodes.length}　maps=${概念层.maps.length}`,
  );
  if (概念层.tree || 概念层.nodes.length > 0 || 概念层.maps.length > 0) {
    说("  🔴 概念层载荷不该带树/节点/映射 —— 停手");
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  for (const { 册: g, 载荷: p } of 树们) {
    说(
      `    · ${p.tree?.subject}/${p.tree?.edition}/${g}：` +
        `节点 ${p.nodes.length}（章 ${p.nodes.filter((n) => n.level === 1).length}／` +
        `节 ${p.nodes.filter((n) => n.level === 2).length}）　映射 ${p.maps.length}`,
    );
  }

  // ── ② 报表复核 ───────────────────────────────────────────────────────────
  标题("② 报表复核（逐树对校对报告 §2 / 总量对 §0）");
  const 报表 = 跑报表(概念层, 树们);
  说();
  for (const a of 报表) 判(a);

  // ── ③ P 组闸（载荷内部自洽）──────────────────────────────────────────────
  标题("③ P 组闸 · 载荷内部自洽（不碰库）");
  const P = 跑P闸(概念层, 树们);
  for (const a of P) 判(a);

  // ── ④ G 组闸（与活库交叉，只读）──────────────────────────────────────────
  标题("④ G 组闸 · 与活库交叉（只读）");
  const 现状 = await 读库现状(h);
  说(
    "  库现状：" +
      Object.entries(现状.计数)
        .map(([k, v]) => `${k}=${v}`)
        .join("  "),
  );
  const G = 跑G闸(概念层, 树们, 现状);
  for (const a of G) 判(a);

  // ── ⑤ 将建对象数 / 预期终值 ──────────────────────────────────────────────
  标题("⑤ 将建对象数与预期终值");
  const node总 = 树们.reduce((a, t) => a + t.载荷.nodes.length, 0);
  const map总 = 树们.reduce((a, t) => a + t.载荷.maps.length, 0);
  const 预期: [string, number, number, number][] = [
    ["kp", 现状.计数.kp!, 概念层.kps.length, 现状.计数.kp! + 概念层.kps.length],
    [
      "kp_alias",
      现状.计数.kp_alias!,
      概念层.aliases.length,
      现状.计数.kp_alias! + 概念层.aliases.length,
    ],
    ["edition_tree", 现状.计数.edition_tree!, 12, 现状.计数.edition_tree! + 12],
    [
      "edition_node",
      现状.计数.edition_node!,
      node总,
      现状.计数.edition_node! + node总,
    ],
    [
      "node_kp_map",
      现状.计数.node_kp_map!,
      map总,
      现状.计数.node_kp_map! + map总,
    ],
    [
      "kp_fts",
      现状.计数.kp_fts!,
      概念层.kps.length + 概念层.aliases.length,
      现状.计数.kp_fts! + 概念层.kps.length + 概念层.aliases.length,
    ],
  ];
  说("  表              现有 ＋ 将建 ＝ 预期");
  for (const [t, a, b, c] of 预期) {
    说(
      `  ${t.padEnd(15)} ${String(a).padStart(4)} ＋${String(b).padStart(5)} ＝${String(c).padStart(5)}`,
    );
  }
  说(`  批次：1 批概念层 + 12 批树 = 13 次 importKgBatch（一批一事务）`);

  // ── ⑥ 结论闸 ─────────────────────────────────────────────────────────────
  const 前置 = [...报表, ...P, ...G];
  const 红 = 前置.filter((a) => !a.ok);
  标题("⑥ 入库前结论");
  说(
    红.length === 0
      ? `  [PASS] 报表 ${报表.length} + P 组 ${P.length} + G 组 ${G.length} = ${前置.length} 项全绿`
      : `  🔴 [FAIL] ${红.length} 项没过：${红.map((a) => a.name).join("、")}`,
  );
  if (红.length > 0) {
    说("  一行都没写，先修载荷再来。");
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  if (!commit) {
    说();
    说(`  DRY-RUN 到此结束（零写）。零红，可以真灌：`);
    说(
      `    pnpm exec tsx --env-file=.env scripts/load-primary-kg-20260815.ts ${COMMIT_FLAG}`,
    );
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 0;
    return;
  }

  // ── ⑦ 灌前快照（退路）────────────────────────────────────────────────────
  标题("⑦ 灌前快照（🔴 活库上加东西必须能退）");
  const 退路 = await backupNow({ reason: "batch" });
  说(`  文件：${退路.path}`);
  说(
    `  大小：${退路.bytes} 字节　表数=${退路.tables}　耗时 ${退路.ms}ms　` +
      `快照内 kp=${退路.snapshotRowCounts.kp}`,
  );
  说(`  异地：${退路.remote}`);

  // ── ⑧ 写库 ───────────────────────────────────────────────────────────────
  标题("⑧ 写库（13 批，一批一事务，全进或全不进）");
  const 回执: {
    批: string;
    seq: number;
    counts: Record<string, number>;
    rowRefs: number;
  }[] = [];
  const r0 = await importKgBatch(
    {
      kps: 概念层.kps,
      aliases: 概念层.aliases,
    },
    {
      actor: "human",
      tool: 审计工具名,
      note: `PRD-010 导底 · 概念层 ${概念层.kps.length} 考点 + 别名 ${概念层.aliases.length} 条`,
    },
  );
  说(
    `  [OK] 第 1 批 概念层：kp=${r0.counts.kps} alias=${r0.counts.aliases}` +
      `　审计 seq=${r0.seq}　rowRefs=${r0.rowRefs.length}`,
  );
  回执.push({
    批: "00-概念层",
    seq: r0.seq,
    counts: { kp: r0.counts.kps, alias: r0.counts.aliases },
    rowRefs: r0.rowRefs.length,
  });

  let i = 1;
  for (const { 册: g, 载荷: p } of 树们) {
    i += 1;
    const r = await importKgBatch(
      { tree: p.tree ?? undefined, nodes: p.nodes, maps: p.maps },
      {
        actor: "human",
        tool: 审计工具名,
        note: `PRD-010 导底 · ${SUBJECT}/${EDITION}/${g}`,
      },
    );
    说(
      `  [OK] 第 ${String(i).padStart(2)} 批 ${g}：tree=${r.counts.trees} ` +
        `node=${r.counts.nodes} map=${r.counts.maps}` +
        `　审计 seq=${r.seq}　rowRefs=${r.rowRefs.length}`,
    );
    回执.push({
      批: g,
      seq: r.seq,
      counts: {
        tree: r.counts.trees,
        node: r.counts.nodes,
        map: r.counts.maps,
      },
      rowRefs: r.rowRefs.length,
    });
  }

  // ── ⑨ 灌后逐表清点 ───────────────────────────────────────────────────────
  标题("⑨ 灌后逐表清点（对预期终值）");
  const 清点: 断言[] = [];
  for (const [t, , , 期] of 预期) {
    const 实 = await 数(h, t);
    清点.push({ ok: 实 === 期, name: t, detail: `预期 ${期} → 库 ${实}` });
  }
  for (const a of 清点) 判(a);

  // 逐树复核（挂载数与报表对上）
  标题("⑨b 灌后逐树复核（章/节/挂载数 从库里现算，对校对报告 §2）");
  const 逐树: 断言[] = [];
  for (const { 册: g } of 树们) {
    const r = await h.client.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM edition_node n WHERE n.tree_id=t.id AND n.level=1) AS ch,
              (SELECT COUNT(*) FROM edition_node n WHERE n.tree_id=t.id AND n.level=2) AS se,
              (SELECT COUNT(*) FROM node_kp_map m JOIN edition_node n ON n.id=m.node_id
                WHERE n.tree_id=t.id) AS mp,
              (SELECT COUNT(DISTINCT m.kp_id) FROM node_kp_map m JOIN edition_node n ON n.id=m.node_id
                WHERE n.tree_id=t.id) AS kpn
            FROM edition_tree t
            WHERE t.subject=? AND t.edition=? AND t.grade_sem=? AND t.status='active'`,
      args: [SUBJECT, EDITION, g],
    });
    const row = r.rows[0] as unknown as
      | {
          ch: number | bigint;
          se: number | bigint;
          mp: number | bigint;
          kpn: number | bigint;
        }
      | undefined;
    const b = 报表基线[g];
    const got = {
      章: Number(row?.ch ?? -1),
      节: Number(row?.se ?? -1),
      挂载: Number(row?.mp ?? -1),
      考点: Number(row?.kpn ?? -1),
    };
    逐树.push({
      ok:
        got.章 === b.章 &&
        got.节 === b.节 &&
        got.挂载 === b.挂载 &&
        got.考点 === b.考点,
      name: `${SUBJECT}/${EDITION}/${g}`,
      detail: `章 ${got.章}/${b.章}　节 ${got.节}/${b.节}　考点 ${got.考点}/${b.考点}　挂载 ${got.挂载}/${b.挂载}`,
    });
  }
  for (const a of 逐树) 判(a);

  // ── ⑩ 对账 C1~C6 ─────────────────────────────────────────────────────────
  标题("⑩ 对账六项 C1~C6（🔴 red=0 才算导底成功；C6=活跃树唯一闸）");
  const 报告 = await integrityCheck();
  for (const c of 报告.checks) {
    const tag = c.ok ? "[✔ OK  ]" : c.level === "red" ? "[✘ RED ]" : "[⚠ WARN]";
    说(`  ${tag} ${c.id} ${c.name}`);
    if (c.stats) {
      说(
        "          " +
          Object.entries(c.stats)
            .map(([k, v]) => `${k}=${v}`)
            .join("  "),
      );
    }
    for (const d of c.details) 说(`          ${d}`);
  }
  const reds = 报告.checks.filter((c) => !c.ok && c.level === "red");
  const 对账断言: 断言 = {
    ok: reds.length === 0,
    name: "对账无 red",
    detail:
      reds.length === 0
        ? "red=0"
        : `🔴 red=${reds.map((c) => c.id).join("、")}`,
  };
  判(对账断言);

  // ── ⑪ 学科并存 ───────────────────────────────────────────────────────────
  标题("⑪ 学科并存：「小学数学」× 「初中数学」互不干扰");
  const 并存: 断言[] = [];
  const 学科表 = await h.client.execute(
    `SELECT t.subject,
            COUNT(DISTINCT t.id) AS trees,
            COUNT(DISTINCT n.id) AS nodes,
            COUNT(DISTINCT m.kp_id) AS kps
       FROM edition_tree t
       LEFT JOIN edition_node n ON n.tree_id=t.id
       LEFT JOIN node_kp_map m ON m.node_id=n.id
      WHERE t.status='active'
      GROUP BY t.subject ORDER BY t.subject`,
  );
  for (const row of 学科表.rows as unknown as {
    subject: string;
    trees: number | bigint;
    nodes: number | bigint;
    kps: number | bigint;
  }[]) {
    说(
      `  ${row.subject}：活跃树 ${Number(row.trees)}　节点 ${Number(row.nodes)}　挂到的考点 ${Number(row.kps)}`,
    );
  }
  const 初中树 = await h.client.execute(
    "SELECT COUNT(*) AS c FROM edition_tree WHERE subject='初中数学' AND status='active'",
  );
  const 小学树 = await h.client.execute({
    sql: "SELECT COUNT(*) AS c FROM edition_tree WHERE subject=? AND status='active'",
    args: [SUBJECT],
  });
  const 初中数 = Number(
    (初中树.rows[0] as unknown as { c: number | bigint }).c,
  );
  const 小学数 = Number(
    (小学树.rows[0] as unknown as { c: number | bigint }).c,
  );
  并存.push({
    ok: 初中数 === 7 && 小学数 === 12,
    name: "两学科各自的活跃树数（初中 7 不动 / 小学 12 新建）",
    detail: `初中数学 ${初中数} 棵　${SUBJECT} ${小学数} 棵`,
  });
  // 初中侧的检索没被搅：拿 002 金标里的说法查一条
  const 初中查 = await resolveKp("合并同类项", { enqueue: false });
  并存.push({
    ok:
      初中查.candidates[0]?.name === "合并同类项" &&
      初中查.candidates[0]?.confidence === 1,
    name: "初中面检索不受干扰（resolve「合并同类项」仍 1.0 命中它本人）",
    detail: `top1=${初中查.candidates[0]?.name}（conf=${初中查.candidates[0]?.confidence}，via=${初中查.candidates[0]?.matchedVia}）`,
  });
  for (const a of 并存) 判(a);

  // ── ⑫ resolve_kp 实测（5 考点名 + 2 别名）─────────────────────────────────
  标题("⑫ resolve_kp 实测：5 个小学考点名 + 2 个别名");
  const 冒烟: 断言[] = [];
  for (const s of 冒烟考点名) {
    const r = await resolveKp(s.q, { enqueue: false });
    const top = r.candidates[0];
    说(`  查「${s.q}」（${s.场景}）：候选 ${r.candidates.length} 条`);
    for (const c of r.candidates.slice(0, 3)) {
      说(
        `      ${c.name}　conf=${c.confidence.toFixed(2)}　via=${c.matchedVia}` +
          `${c.aliasHit ? `　命中别名「${c.aliasHit}」` : ""}`,
      );
    }
    let 树数 = -1;
    if (top) {
      const card = await kpContext(top.kpId);
      树数 = new Set(card.placements.map((p) => p.treeId)).size;
      说(
        `      落点 ${card.placements.length} 处 / ${树数} 棵树：` +
          `${列(
            card.placements.map((p) => `${p.subject}·${p.gradeSem}`),
            6,
          )}`,
      );
    }
    const 同名候选 = r.candidates.filter((c) => c.name === s.q).length;
    冒烟.push({
      ok:
        !!top &&
        top.name === s.q &&
        top.confidence === 1 &&
        top.matchedVia === "exact-name" &&
        同名候选 === 1 &&
        (s.期望树数 === undefined || 树数 === s.期望树数),
      name: `考点名「${s.q}」`,
      detail: top
        ? `top1=${top.name}（conf=${top.confidence}，via=${top.matchedVia}）` +
          `　挂 ${树数} 棵树${s.期望树数 !== undefined ? `／期望 ${s.期望树数}` : ""}` +
          `${r.lowConfidence ? "　⚠ 整体低置信" : ""}`
        : "🔴 零候选",
    });
  }
  for (const s of 冒烟别名) {
    const r = await resolveKp(s.q, { enqueue: false });
    const top = r.candidates[0];
    说(`  查「${s.q}」（${s.场景}）：候选 ${r.candidates.length} 条`);
    for (const c of r.candidates.slice(0, 3)) {
      说(
        `      ${c.name}　conf=${c.confidence.toFixed(2)}　via=${c.matchedVia}` +
          `${c.aliasHit ? `　命中别名「${c.aliasHit}」` : ""}`,
      );
    }
    冒烟.push({
      ok:
        !!top &&
        top.name === s.期望考点 &&
        top.confidence === 1 &&
        top.matchedVia === "exact-alias" &&
        top.aliasHit === s.q,
      name: `别名「${s.q}」→ ${s.期望考点}`,
      detail: top
        ? `top1=${top.name}（conf=${top.confidence}，via=${top.matchedVia}，命中别名「${top.aliasHit ?? ""}」）`
        : "🔴 零候选",
    });
  }
  for (const a of 冒烟) 判(a);

  // ── ⑬ 改名消歧并存核查 ───────────────────────────────────────────────────
  标题("⑬ 改名消歧核查：新旧两条并存，各归各树（校对报告 §5.1 抽 3 条）");
  const 消歧: 断言[] = [];
  for (const d of 消歧对) {
    const q = await h.client.execute({
      sql: `SELECT k.id, k.name, k.grade_band, k.status,
                   (SELECT GROUP_CONCAT(DISTINCT t.subject || '·' || t.grade_sem)
                      FROM node_kp_map m JOIN edition_node n ON n.id=m.node_id
                      JOIN edition_tree t ON t.id=n.tree_id WHERE m.kp_id=k.id) AS 落点
              FROM kp k WHERE k.name IN (?, ?)`,
      args: [d.新, d.旧],
    });
    const rows = q.rows as unknown as {
      id: string;
      name: string;
      grade_band: string | null;
      status: string;
      落点: string | null;
    }[];
    const 新 = rows.find((r) => r.name === d.新);
    const 旧 = rows.find((r) => r.name === d.旧);
    说(`  「${d.新}」× 「${d.旧}」——${d.说明}`);
    for (const r of rows) {
      说(
        `      ${r.name}　id=${r.id}　gradeBand=${r.grade_band}　status=${r.status}　落点=${r.落点 ?? "(无)"}`,
      );
    }
    消歧.push({
      ok:
        !!新 &&
        !!旧 &&
        新.id !== 旧.id &&
        新.grade_band === "小学" &&
        旧.grade_band !== "小学" &&
        (新.落点 ?? "").includes(SUBJECT) &&
        !(新.落点 ?? "").includes("初中数学") &&
        (旧.落点 ?? "").includes("初中数学") &&
        !(旧.落点 ?? "").includes(SUBJECT),
      name: `${d.新} ／ ${d.旧}`,
      detail:
        新 && 旧
          ? `两条并存（id 不同=${新.id !== 旧.id}）；新→${新.落点 ?? "(无)"}；旧→${旧.落点 ?? "(无)"}`
          : `🔴 缺行：新=${新 ? "有" : "无"}　旧=${旧 ? "有" : "无"}`,
    });
  }
  for (const a of 消歧) 判(a);

  // ── ⑭ 灌后快照（新基线）──────────────────────────────────────────────────
  标题("⑭ 灌后快照（新基线）");
  const 快照 = await backupNow({ reason: "batch" });
  说(`  文件：${快照.path}`);
  说(
    `  大小：${快照.bytes} 字节　表数=${快照.tables}　耗时 ${快照.ms}ms　` +
      `快照内 kp=${快照.snapshotRowCounts.kp}　audit_log=${快照.snapshotRowCounts.audit_log}`,
  );
  const 快照断言: 断言 = {
    ok: 快照.snapshotRowCounts.kp === 现状.计数.kp! + 概念层.kps.length,
    name: "快照里的 kp 数 = 灌前 + 本批",
    detail: `${快照.snapshotRowCounts.kp} / ${现状.计数.kp! + 概念层.kps.length}`,
  };
  判(快照断言);

  // ── 结论 ─────────────────────────────────────────────────────────────────
  const 全部 = [
    ...清点,
    ...逐树,
    对账断言,
    ...并存,
    ...冒烟,
    ...消歧,
    快照断言,
  ];
  const 挂 = 全部.filter((a) => !a.ok);
  标题("结论");
  说(
    挂.length === 0
      ? `导底成功：${概念层.kps.length} 考点 / ${概念层.aliases.length} 别名 / ` +
          `12 棵树 / ${node总} 节点 / ${map总} 挂载，${全部.length} 项验证全绿` +
          `（耗时 ${Math.round((Date.now() - t0) / 100) / 10}s）`
      : `🔴 导底已写入，但 ${挂.length} 条验证没过：${挂.map((a) => a.name).join("、")}`,
  );
  说("  逐批审计 seq：" + 回执.map((r) => `${r.批}=${r.seq}`).join("  "));
  说(
    "🔴 本脚本到此退役 —— KG 后续增删改一律走 core 写原语（治理页 / MCP 工具），别再跑它。",
  );

  closeGradingDb();
  await closeCoreDb();
  process.exitCode = 挂.length === 0 ? 0 : 1;
}

void main();
