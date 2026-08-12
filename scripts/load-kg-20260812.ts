/**
 * scripts/load-kg-20260812.ts —— 🔴 **一次性导底脚本**（AI:PRD-002 · 002-B2 / M0·Q5）
 *
 * 2026-08-12 跑过**一次**就退役：它把 002-B 备料包（415 考点 + 127 别名 + 42 张卡片 +
 * 人教 6 树 / 浙教 1 树）一次性灌进空库。**它不是常驻同步通路**——
 * 日后 KG 的增删改一律走 core 写原语（治理页 / MCP 工具），不是再跑一遍本脚本。
 * 留在仓里只为两件事：① 导底那一刻做了什么，有据可查；② 万一要重来，有个可复现的起点。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/load-kg-20260812.ts
 *   pnpm exec tsx --env-file=.env scripts/load-kg-20260812.ts --src <备料目录>
 * 退出码：0=导底成功且验证全绿；1=闸没过 / 验证没过 / 库非空被拒（一行都没写）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条纪律
 *
 * ① **幂等闸**：开跑先数 kp/kp_alias/edition_tree/edition_node/node_kp_map 五张表，
 *    任一非空立刻拒绝——重复导底会造出两套 id 的同名考点，事后分不清谁是谁。
 *    真要在有数据的库上强跑，得显式带 `--force-empty-check-bypass`
 *    （旗子故意起得吓人：它没有任何合并语义，就是把闸掰开）。
 * ② **入库前四道机器闸，一票否决**（搬自备料报告 §6，见下面 跑闸()）。
 *    闸没过 = 一行都不写，不留半棵树。
 * ③ **一切经 core**：kps+aliases 一个 importKgBatch，7 棵树各一个 importKgBatch，
 *    全进或全不进。actor='human'（导底是人拍板的一次性动作，不是 agent 自主写），
 *    tool='load_kg_20260812'（日后 `SELECT tool,COUNT(*) FROM audit_log GROUP BY tool`
 *    一眼认得出哪几笔是导底）。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 数据保真：入库值以备料 json/csv/md 为准**一字不改**，唯一的变换是下面
 *    「去章号」那一处（总指挥 2026-08-12 拍板，理由写在常量旁）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  backupNow,
  closeCoreDb,
  closeGradingDb,
  getCoreDb,
  importKgBatch,
  integrityCheck,
  newId,
  resolveKp,
  type CoreDbHandle,
} from "../src/core/index";

// ---------------------------------------------------------------------------
// 口径常量（改这里之前先问：备料包是不是也换了）
// ---------------------------------------------------------------------------

/** 002-B 备料包（只读）。搬走了就用 --src 指过去。 */
const 备料目录默认 =
  "C:/Users/25606/AppData/Local/Temp/claude/d--workplace-ai-bkb/" +
  "10dedbaf-cfe0-4113-ae5f-e04875893b63/scratchpad/002-导底备料";

/**
 * 🔴 学科名：备料包里只有 edition（人教版/浙教版）与 gradeSem（七上…），没有 subject 字段。
 * 备料报告 §2 通篇按「初中数学·浙教 / 初中数学·人教」口径称呼，概念层清单也明写
 * 「本次只铺初中数学」，故 subject 一律 '初中数学'（小学数学/科学不在本批）。
 */
const SUBJECT = "初中数学";

/**
 * 🔴 去章号的四册（总指挥 2026-08-12 拍板）：人教 2024 新教材七上扩为六章后，
 * 八九年级是否重新编号**没核实过**——「第十一章 三角形」里**名可靠、序不可靠**。
 * 所以这四册的**章节点**只留名（`第十一章 三角形` → `三角形`），sort 保序即可。
 * 七上/七下按备料原样（章名章号已核，见备料报告 §5.A）。
 */
const 去章号册 = new Set(["八上", "八下", "九上", "九下"]);
const 去章号版本 = "人教版";
const 章号前缀 = /^第[一二三四五六七八九十百零〇0-9]+章\s*/;

/**
 * 🔴 孤儿豁免名单（闸①用）：没被任何版本树挂到的考点，**只有名单里的**放行。
 * 名单必须写死在脚本里并带理由——「反正就一个，跳过算了」是怎么把脏数据合法化的。
 */
const 孤儿豁免: Record<string, string> = {
  梯形:
    "人教版初中数学无梯形独立章节（浙教八下第 5 章有）——这是真的版本差异不是漏挂，" +
    "保留该 kp 但人教侧不硬塞挂位（总指挥 2026-08-12 拍板；备料报告 §5.B.2）",
};

/** 概念层名字里绝不许出现的内部词（闸②；纪律正本=记忆 no-internal-terms-on-student-paper） */
const 内部词 = ["层", "★", "素材", "薄弱"];
/** 教材节号形状（闸②）：`1.2 xxx` / `3.2.1 xxx` —— 概念层版本无关，节号是版本相关的 */
const 教材节号 = /\d+\.\d+/;

/**
 * 备料包清点基线（备料报告 §1 的表）。解析出来的数对不上它 = 备料包换了内容，
 * 停下来别导——一次性脚本对着一份确定的备料跑，不做「随便给我什么我都灌」。
 */
const 备料基线 = {
  kp: 415,
  alias: 127,
  card: 42,
  tree: 7,
  node: 108, // 人教 31 章 + 51 节 = 82；浙教 5 章 + 21 节 = 26
  map: 490, // 人教 415 + 浙教 75
} as const;

const BYPASS_FLAG = "--force-empty-check-bypass";
const 审计工具名 = "load_kg_20260812";

// ---------------------------------------------------------------------------
// 备料包的形状（zod 兜一道：备料换了形状要当场炸，不要写进库才发现）
// ---------------------------------------------------------------------------

const 备料考点 = z.object({
  name: z.string().trim().min(1),
  grade_band: z.string().nullish(),
  domain: z.string().nullish(),
  topic: z.string().nullish(),
  four_tree: z.string().nullish(),
  kp_no: z.number().int().positive(),
});
const 概念层文件 = z.object({ kp: z.array(备料考点).min(1) });

const 备料节 = z.object({
  name: z.string().trim().min(1),
  sort: z.number().int(),
  kpNames: z.array(z.string().trim().min(1)),
});
const 备料章 = z.object({
  name: z.string().trim().min(1),
  sort: z.number().int(),
  sections: z.array(备料节).min(1),
});
const 备料册 = z.object({
  gradeSem: z.string().trim().min(1),
  edition: z.string().trim().min(1),
  chapters: z.array(备料章).min(1),
});
const 树文件 = z.object({ editions: z.array(备料册).min(1) });

// ---------------------------------------------------------------------------
// 内存模型
// ---------------------------------------------------------------------------

interface 待建考点 {
  id: string;
  name: string;
  gradeBand: string | null;
  domain: string | null;
  topic: string | null;
  cardMd: string | null;
  fourTree: string | null;
}

interface 待建节点 {
  id: string;
  treeId: string;
  parentId: string | null;
  /** 1=章 2=节 */
  level: number;
  name: string;
  sort: number;
}

interface 待建树 {
  id: string;
  subject: string;
  edition: string;
  gradeSem: string;
  nodes: 待建节点[];
  maps: { nodeId: string; kpId: string; kpName: string; nodeName: string }[];
  章数: number;
  节数: number;
  /** 去章号变换明细：`第十一章 三角形 → 三角形` */
  改名: string[];
}

interface 断言 {
  ok: boolean;
  name: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// 输出（全程落 stdout，导底记录要留档）
// ---------------------------------------------------------------------------

const 行: string[] = [];
function 说(s = ""): void {
  行.push(s);
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

// ---------------------------------------------------------------------------
// 读备料
// ---------------------------------------------------------------------------

function 读json<S extends z.ZodType>(path: string, schema: S): z.output<S> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new Error(`备料文件形状不对：${path}\n${z.prettifyError(r.error)}`);
  }
  return r.data;
}

/** 别名词表：4 列无引号 CSV（备料包实测），列数对不上当场停 */
function 读别名(path: string): { kpName: string; alias: string }[] {
  const txt = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines.shift();
  if (head !== "kp_name,alias,four_tree,来源") {
    throw new Error(`别名词表表头不对：${JSON.stringify(head)}`);
  }
  return lines.map((l, i) => {
    const cols = l.split(",");
    if (cols.length !== 4) {
      throw new Error(
        `别名词表第 ${i + 2} 行不是 4 列（${cols.length} 列）：${l}` +
          "——本脚本按「无引号无转义」的实测形状解析，形状变了就别猜",
      );
    }
    const [kpName, alias] = cols;
    if (!kpName?.trim() || !alias?.trim()) {
      throw new Error(`别名词表第 ${i + 2} 行有空字段：${l}`);
    }
    return { kpName: kpName.trim(), alias: alias.trim() };
  });
}

/**
 * 考点卡片：文件名被文件系统洗过（`|`→`｜`、`/`→`／`），**认首行标题不认文件名**。
 * 首行形如 `# 考点卡片 · 绝对值的概念`。
 */
function 读卡片(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const md = readFileSync(join(dir, f), "utf8");
    const first = md.split(/\r?\n/, 1)[0] ?? "";
    const m = /^#\s*考点卡片\s*·\s*(.+?)\s*$/.exec(first);
    if (!m?.[1]) {
      throw new Error(`卡片首行认不出考点名：${f}\n  首行：${first}`);
    }
    const name = m[1];
    if (out.has(name)) {
      throw new Error(`两张卡片指向同一个考点「${name}」（${f}）`);
    }
    out.set(name, md);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 建模型
// ---------------------------------------------------------------------------

function 建树(
  文件: z.output<typeof 树文件>,
  名到id: Map<string, string>,
): 待建树[] {
  const out: 待建树[] = [];
  for (const e of 文件.editions) {
    const treeId = newId("tree");
    const nodes: 待建节点[] = [];
    const maps: 待建树["maps"] = [];
    const 改名: string[] = [];
    let 节数 = 0;

    for (const c of e.chapters) {
      let 章名 = c.name;
      if (去章号册.has(e.gradeSem) && e.edition === 去章号版本) {
        const 剥 = 章名.replace(章号前缀, "").trim();
        if (剥 !== 章名 && 剥 !== "") {
          改名.push(`${章名} → ${剥}`);
          章名 = 剥;
        }
      }
      const 章id = newId("node");
      nodes.push({
        id: 章id,
        treeId,
        parentId: null,
        level: 1,
        name: 章名,
        sort: c.sort,
      });

      for (const s of c.sections) {
        const 节id = newId("node");
        nodes.push({
          id: 节id,
          treeId,
          parentId: 章id,
          level: 2,
          name: s.name,
          sort: s.sort,
        });
        节数 += 1;
        for (const kpName of s.kpNames) {
          const kpId = 名到id.get(kpName);
          if (!kpId) {
            // 闸③会逐条列全，这里只是防御：没有 id 就没法建 map
            maps.push({ nodeId: 节id, kpId: "", kpName, nodeName: s.name });
            continue;
          }
          maps.push({ nodeId: 节id, kpId, kpName, nodeName: s.name });
        }
      }
    }

    out.push({
      id: treeId,
      subject: SUBJECT,
      edition: e.edition,
      gradeSem: e.gradeSem,
      nodes,
      maps,
      章数: e.chapters.length,
      节数,
      改名,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入库前四道闸（一票否决；搬自备料报告 §6 的闸①②③ + 别名引用闸）
// ---------------------------------------------------------------------------

function 跑闸(
  考点: 待建考点[],
  别名: { kpName: string; alias: string }[],
  卡片: Map<string, string>,
  树: 待建树[],
): 断言[] {
  const 名集 = new Set(考点.map((k) => k.name));
  const out: 断言[] = [];

  // ── 闸① 双版本挂位（备料闸②③）+ 孤儿豁免名单 ────────────────────────────
  // kpName → 它被哪些版本树挂到（{人教版, 浙教版}）
  const 挂位 = new Map<string, Set<string>>();
  for (const t of 树) {
    for (const m of t.maps) {
      const s = 挂位.get(m.kpName) ?? new Set<string>();
      s.add(t.edition);
      挂位.set(m.kpName, s);
    }
  }
  const 四子树 = 考点.filter((k) => k.fourTree);
  const 缺挂 = 四子树.filter((k) => {
    const s = 挂位.get(k.name);
    return !s || !s.has("人教版") || !s.has("浙教版");
  });
  const 孤儿 = 考点.filter((k) => !挂位.has(k.name));
  const 违规孤儿 = 孤儿.filter((k) => !(k.name in 孤儿豁免));
  out.push({
    ok: 缺挂.length === 0 && 违规孤儿.length === 0,
    name: "闸① 四子树双版本挂位 + 孤儿只认豁免名单",
    detail:
      `四子树 ${四子树.length} 个考点：人教+浙教两侧都挂到 ${四子树.length - 缺挂.length} 个` +
      `${缺挂.length ? `，🔴 缺挂 ${缺挂.map((k) => k.name).join("、")}` : ""}；` +
      `孤儿（无任何树引用）${孤儿.length} 个` +
      `${孤儿.length ? `＝${孤儿.map((k) => k.name).join("、")}` : ""}` +
      `${违规孤儿.length ? `，🔴 不在豁免名单：${违规孤儿.map((k) => k.name).join("、")}` : "（全在豁免名单）"}`,
  });
  for (const k of 孤儿.filter((k) => k.name in 孤儿豁免)) {
    说(`         └ 豁免「${k.name}」：${孤儿豁免[k.name]}`);
  }

  // ── 闸② 概念层名字干净（无内部词、无教材节号、不撞名）────────────────────
  const 带内部词 = 考点.filter((k) => 内部词.some((w) => k.name.includes(w)));
  const 带节号 = 考点.filter((k) => 教材节号.test(k.name));
  const 撞名 = [...new Set(考点.map((k) => k.name))].length !== 考点.length;
  out.push({
    ok: 带内部词.length === 0 && 带节号.length === 0 && !撞名,
    name: "闸② 考点名干净（无内部词 / 无教材节号 / 不撞名）",
    detail:
      `内部词(${内部词.join("")}) 命中 ${带内部词.length}` +
      `${带内部词.length ? `：${带内部词.map((k) => k.name).join("、")}` : ""}；` +
      `教材节号(1.2 式) 命中 ${带节号.length}` +
      `${带节号.length ? `：${带节号.map((k) => k.name).join("、")}` : ""}；` +
      `${撞名 ? "🔴 有撞名" : `${名集.size} 个名字两两不同`}`,
  });

  // ── 闸③ 每条 map 的 kp 名 / 节点都对得上 ─────────────────────────────────
  const 坏kp: string[] = [];
  const 坏节点: string[] = [];
  const 重复对: string[] = [];
  for (const t of 树) {
    const 本树节点 = new Set(t.nodes.map((n) => n.id));
    const 见过 = new Set<string>();
    for (const m of t.maps) {
      if (!名集.has(m.kpName) || m.kpId === "") {
        坏kp.push(`${t.edition}${t.gradeSem}/${m.nodeName}→${m.kpName}`);
      }
      if (!本树节点.has(m.nodeId)) {
        坏节点.push(`${t.edition}${t.gradeSem}/${m.nodeName}`);
      }
      const key = `${m.nodeId}|${m.kpId}`;
      if (见过.has(key)) {
        重复对.push(`${t.edition}${t.gradeSem}/${m.nodeName}→${m.kpName}`);
      }
      见过.add(key);
    }
  }
  const map总数 = 树.reduce((a, t) => a + t.maps.length, 0);
  out.push({
    ok: 坏kp.length === 0 && 坏节点.length === 0 && 重复对.length === 0,
    name: "闸③ 每条映射的考点名与章节节点都对得上",
    detail:
      `映射 ${map总数} 条：认不出的考点名 ${坏kp.length}` +
      `${坏kp.length ? `（${坏kp.slice(0, 6).join("、")}…）` : ""}；` +
      `不属于本树的节点 ${坏节点.length}；重复 (节点,考点) 对 ${重复对.length}` +
      `${重复对.length ? `（${重复对.slice(0, 6).join("、")}…）` : ""}`,
  });

  // ── 闸④ 别名表 / 卡片引用的考点名都存在 ──────────────────────────────────
  const 坏别名 = 别名.filter((a) => !名集.has(a.kpName));
  const 坏卡片 = [...卡片.keys()].filter((n) => !名集.has(n));
  out.push({
    ok: 坏别名.length === 0 && 坏卡片.length === 0,
    name: "闸④ 别名表与卡片引用的考点名都在概念层里",
    detail:
      `别名 ${别名.length} 条：引用不到的 ${坏别名.length}` +
      `${坏别名.length ? `（${坏别名.map((a) => a.kpName).join("、")}）` : ""}；` +
      `卡片 ${卡片.size} 张：引用不到的 ${坏卡片.length}` +
      `${坏卡片.length ? `（${坏卡片.join("、")}）` : ""}`,
  });

  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function 数(h: CoreDbHandle, table: string): Promise<number> {
  const r = await h.client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  const row = r.rows[0] as unknown as { c: number | bigint } | undefined;
  return Number(row?.c ?? -1);
}

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
  const bypass = argv.includes(BYPASS_FLAG);
  const src = 取参(argv, "--src") ?? 备料目录默认;

  标题("AI:PRD-002 · 002-B2 导底（一次性脚本 load_kg_20260812）");
  说(`备料包：${src}`);
  说(`学科口径：${SUBJECT}　actor=human　tool=${审计工具名}`);
  说(`时间：${new Date().toLocaleString("zh-CN")}`);

  const h = await getCoreDb();
  说(`目标库：${h.url}`);

  // ── ① 幂等闸 ─────────────────────────────────────────────────────────────
  标题("① 幂等闸（导底只能在空库上跑）");
  const 存量: Record<string, number> = {};
  for (const t of [
    "kp",
    "kp_alias",
    "edition_tree",
    "edition_node",
    "node_kp_map",
  ]) {
    存量[t] = await 数(h, t);
  }
  说(
    "  存量：" +
      Object.entries(存量)
        .map(([k, v]) => `${k}=${v}`)
        .join("  "),
  );
  const 非空 = Object.entries(存量).filter(([, v]) => v > 0);
  if (非空.length > 0 && !bypass) {
    说(
      `  [FAIL] 库不是空的（${非空.map(([k, v]) => `${k}=${v}`).join("、")}）——拒绝导底。`,
    );
    说(
      `         重复导底会造出两套 id 的同名考点，事后分不清谁是谁。` +
        `真要强跑请显式带 ${BYPASS_FLAG}（它没有任何合并语义，就是把闸掰开）。`,
    );
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  if (非空.length > 0) {
    说(`  [WARN] 🔴 ${BYPASS_FLAG} 已生效：在非空库上强行导底，后果自负。`);
  } else {
    说("  [PASS] 五张 KG 表全空，可以导底");
  }

  // ── ② 读备料 ─────────────────────────────────────────────────────────────
  标题("② 读备料包");
  const 概念层 = 读json(join(src, "概念层重整清单.json"), 概念层文件);
  const 别名 = 读别名(join(src, "别名词表.csv"));
  const 卡片 = 读卡片(join(src, "考点卡片"));
  const 人教 = 读json(join(src, "人教树.json"), 树文件);
  const 浙教 = 读json(join(src, "浙教四子树.json"), 树文件);

  const 考点: 待建考点[] = 概念层.kp.map((k) => ({
    id: newId("kp"),
    name: k.name,
    gradeBand: k.grade_band ?? null,
    domain: k.domain ?? null,
    topic: k.topic ?? null,
    cardMd: 卡片.get(k.name) ?? null,
    fourTree: k.four_tree ?? null,
  }));
  const 名到id = new Map(考点.map((k) => [k.name, k.id]));
  const 树 = [...建树(人教, 名到id), ...建树(浙教, 名到id)];
  const 节点总数 = 树.reduce((a, t) => a + t.nodes.length, 0);
  const 映射总数 = 树.reduce((a, t) => a + t.maps.length, 0);
  const 带卡片 = 考点.filter((k) => k.cardMd !== null).length;

  说(
    `  概念层 ${考点.length} 考点（带卡片 ${带卡片}）｜别名 ${别名.length} 条｜` +
      `树 ${树.length} 棵｜节点 ${节点总数}｜映射 ${映射总数}`,
  );
  for (const t of 树) {
    说(
      `    · ${t.subject}/${t.edition}/${t.gradeSem}：${t.章数} 章 ${t.节数} 节，` +
        `节点 ${t.nodes.length}，映射 ${t.maps.length}` +
        `${t.改名.length ? `，去章号 ${t.改名.length} 处` : ""}`,
    );
    for (const r of t.改名) 说(`        去章号：${r}`);
  }

  const 清点: 断言[] = [
    {
      ok: 考点.length === 备料基线.kp,
      name: `备料清点 kp = ${备料基线.kp}`,
      detail: `实为 ${考点.length}`,
    },
    {
      ok: 别名.length === 备料基线.alias,
      name: `备料清点 alias = ${备料基线.alias}`,
      detail: `实为 ${别名.length}`,
    },
    {
      ok: 卡片.size === 备料基线.card,
      name: `备料清点 卡片 = ${备料基线.card}`,
      detail: `实为 ${卡片.size}（入库为 kp.card_md，命中 ${带卡片} 个考点）`,
    },
    {
      ok: 树.length === 备料基线.tree,
      name: `备料清点 树 = ${备料基线.tree}`,
      detail: `实为 ${树.length}`,
    },
    {
      ok: 节点总数 === 备料基线.node,
      name: `备料清点 节点 = ${备料基线.node}`,
      detail: `实为 ${节点总数}`,
    },
    {
      ok: 映射总数 === 备料基线.map,
      name: `备料清点 映射 = ${备料基线.map}`,
      detail: `实为 ${映射总数}`,
    },
  ];
  for (const a of 清点) 判(a);
  if (清点.some((a) => !a.ok)) {
    说("  🔴 备料包与基线对不上（备料换了内容？），停手不导。");
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── ③ 入库前机器闸 ────────────────────────────────────────────────────────
  标题("③ 入库前机器闸（一票否决，红了一行都不写）");
  const 闸 = 跑闸(考点, 别名, 卡片, 树);
  for (const a of 闸) 判(a);
  if (闸.some((a) => !a.ok)) {
    说("  🔴 有闸没过——一行都没写，先修备料再来。");
    closeGradingDb();
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }

  // ── ④ 写库 ───────────────────────────────────────────────────────────────
  标题("④ 写库（core 单事务，全进或全不进）");
  const 概念层回执 = await importKgBatch(
    {
      kps: 考点.map((k) => ({
        id: k.id,
        name: k.name,
        gradeBand: k.gradeBand,
        domain: k.domain,
        topic: k.topic,
        cardMd: k.cardMd,
        status: "active" as const,
      })),
      aliases: 别名.map((a) => ({
        kpId: 名到id.get(a.kpName) ?? "",
        alias: a.alias,
      })),
    },
    {
      actor: "human",
      tool: 审计工具名,
      note: `002-B2 导底 · 概念层 ${考点.length} 考点 + 别名 ${别名.length} 条`,
    },
  );
  说(
    `  [OK] 概念层批：kp=${概念层回执.counts.kps} alias=${概念层回执.counts.aliases}` +
      `　审计 seq=${概念层回执.seq}　rowRefs=${概念层回执.rowRefs.length}`,
  );

  for (const t of 树) {
    const r = await importKgBatch(
      {
        tree: {
          id: t.id,
          subject: t.subject,
          edition: t.edition,
          gradeSem: t.gradeSem,
          version: 1,
          status: "active" as const,
        },
        nodes: t.nodes.map((n) => ({
          id: n.id,
          treeId: n.treeId,
          parentId: n.parentId,
          level: n.level,
          name: n.name,
          sort: n.sort,
        })),
        maps: t.maps.map((m) => ({ nodeId: m.nodeId, kpId: m.kpId })),
      },
      {
        actor: "human",
        tool: 审计工具名,
        note: `002-B2 导底 · ${t.subject}/${t.edition}/${t.gradeSem}`,
      },
    );
    说(
      `  [OK] ${t.edition}${t.gradeSem}：tree=1 node=${r.counts.nodes} map=${r.counts.maps}` +
        `　审计 seq=${r.seq}　rowRefs=${r.rowRefs.length}`,
    );
  }

  // ── ⑤ 入库后清点 ─────────────────────────────────────────────────────────
  标题("⑤ 入库后逐表清点（对备料）");
  const 实际 = {
    kp: await 数(h, "kp"),
    kp_alias: await 数(h, "kp_alias"),
    edition_tree: await 数(h, "edition_tree"),
    edition_node: await 数(h, "edition_node"),
    node_kp_map: await 数(h, "node_kp_map"),
    kp_fts: await 数(h, "kp_fts"),
  };
  const 词条应有 = 考点.length + 别名.length;
  const 清点2: 断言[] = [
    {
      ok: 实际.kp === 考点.length,
      name: "kp",
      detail: `备料 ${考点.length} → 库 ${实际.kp}`,
    },
    {
      ok: 实际.kp_alias === 别名.length,
      name: "kp_alias",
      detail: `备料 ${别名.length} → 库 ${实际.kp_alias}`,
    },
    {
      ok: 实际.edition_tree === 树.length,
      name: "edition_tree",
      detail: `备料 ${树.length} → 库 ${实际.edition_tree}`,
    },
    {
      ok: 实际.edition_node === 节点总数,
      name: "edition_node",
      detail: `备料 ${节点总数} → 库 ${实际.edition_node}`,
    },
    {
      ok: 实际.node_kp_map === 映射总数,
      name: "node_kp_map",
      detail: `备料 ${映射总数} → 库 ${实际.node_kp_map}`,
    },
    {
      ok: 实际.kp_fts === 词条应有,
      name: "kp_fts 词条",
      detail:
        `活跃名 ${考点.length} + 别名 ${别名.length} = ${词条应有} → 库 ${实际.kp_fts}` +
        "（触发器投影，对不上=词表漏同步）",
    },
  ];
  for (const a of 清点2) 判(a);

  // ── ⑥ 对账 ───────────────────────────────────────────────────────────────
  标题("⑥ 对账六项 C1~C6（red=0 才算导底成功）");
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

  // ── ⑦ resolve_kp 冒烟三查 ────────────────────────────────────────────────
  标题("⑦ resolve_kp 冒烟三查（读侧真的能用了没）");
  const 压轴族 = new Set(
    别名.filter((a) => a.alias === "绝对值压轴").map((a) => a.kpName),
  );
  const 冒烟 = [
    {
      q: "绝对值压轴",
      说明: `册名别名（一对多，指向 ${压轴族.size} 个考点）`,
      合理: (n: string) => 压轴族.has(n),
      期望: `top1 ∈ {${[...压轴族].join("、")}}`,
    },
    {
      q: "合并同类项",
      说明: "活跃名全等",
      合理: (n: string) => n === "合并同类项",
      期望: "top1 = 合并同类项",
    },
    {
      q: "实数",
      说明: "前缀/模糊命中实数族",
      合理: (n: string) => n.includes("实数"),
      期望: "top1 名字里带「实数」",
    },
  ];
  const 冒烟断言: 断言[] = [];
  for (const s of 冒烟) {
    // 🔴 enqueue:false：验证动作不许往 review_queue 里塞工单（验证不该改库）
    const r = await resolveKp(s.q, { enqueue: false });
    const top = r.candidates[0];
    说(`  查「${s.q}」（${s.说明}）：候选 ${r.candidates.length} 条`);
    for (const c of r.candidates.slice(0, 3)) {
      说(
        `      ${c.name}　conf=${c.confidence.toFixed(2)}　via=${c.matchedVia}` +
          `${c.aliasHit ? `　命中别名「${c.aliasHit}」` : ""}`,
      );
    }
    冒烟断言.push({
      ok: r.candidates.length > 0 && !!top && s.合理(top.name),
      name: `冒烟「${s.q}」`,
      detail: top
        ? `top1=${top.name}（conf=${top.confidence.toFixed(2)}，${s.期望}）` +
          `${r.lowConfidence ? "　⚠ 整体低置信" : ""}`
        : "🔴 零候选",
    });
  }
  for (const a of 冒烟断言) 判(a);

  // ── ⑧ 快照留档 ───────────────────────────────────────────────────────────
  标题("⑧ 快照留档（导底=大批次，backupNow reason=batch）");
  const 快照 = await backupNow({ reason: "batch" });
  说(`  文件：${快照.path}`);
  说(`  大小：${快照.bytes} 字节　表数=${快照.tables}　耗时 ${快照.ms}ms`);
  说(
    `  快照内计数：kp=${快照.snapshotRowCounts.kp}` +
      `　question=${快照.snapshotRowCounts.question}` +
      `　audit_log=${快照.snapshotRowCounts.audit_log}`,
  );
  说(`  异地：${快照.remote}`);
  const 快照断言: 断言 = {
    ok: 快照.snapshotRowCounts.kp === 考点.length,
    name: "快照里的 kp 数 = 本次导底数",
    detail: `${快照.snapshotRowCounts.kp} / ${考点.length}`,
  };
  判(快照断言);

  // ── 结论 ─────────────────────────────────────────────────────────────────
  const 全部 = [...清点2, 对账断言, ...冒烟断言, 快照断言];
  const 挂 = 全部.filter((a) => !a.ok);
  标题("结论");
  说(
    挂.length === 0
      ? `导底成功：${考点.length} 考点 / ${别名.length} 别名 / ${树.length} 棵树 / ` +
          `${节点总数} 节点 / ${映射总数} 映射，全部验证通过（耗时 ${Math.round((Date.now() - t0) / 100) / 10}s）`
      : `🔴 导底已写入，但 ${挂.length} 条验证没过：${挂.map((a) => a.name).join("、")}`,
  );
  说(
    "🔴 本脚本到此退役——KG 后续增删改一律走 core 写原语（治理页 / MCP 工具），别再跑它。",
  );

  closeGradingDb();
  await closeCoreDb();
  process.exitCode = 挂.length === 0 ? 0 : 1;
}

void main();
