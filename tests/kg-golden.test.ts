/**
 * KG 金标（AI:PRD-002 · 002-E）—— 回归清单 **B 组**的正式载体，REG-B 这一关跑的就是本文件。
 *
 *   B1 resolve_kp 金标 10 条   真实出题场景的查询 → 期望考点全对、置信度非退化
 *   B2 双版本缩范围            同一概念层考点在人教/浙教各挂一处，候选里**只出现一次**
 *   B3 合并后无悬挂            造重复 → merge_kp → 检索/别名/错因候选全跟走，旧 id 可达
 *   B4 编造 id 引导            假 kp_id → KP_NOT_FOUND 且**带最近似候选**（或指得出下一步）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 三条本文件的纪律
 *
 * ① **B1/B2/B4 直接打真库，且只读**。金标就是「对真库的长期断言」——跑在副本上
 *    就只测了副本，KG 数据一漂（导底/重整/合并）金标该红而不红。所有 resolveKp
 *    一律带 `enqueue:false`（低置信也不许往真库写工单），末尾还有一道「只读自证」
 *    对四张表的行数前后比对，写了一行就红。行为测试（B3 要真合并）走 VACUUM INTO 副本。
 *
 * ② **不硬编码 ULID**。期望考点写**名字**，id 一律现查（`查考点`）——库重导一次
 *    ULID 全变，金标写死 id 等于每次重导都要重写一遍金标。
 *
 * ③ **查询词必须真实**：全部取自 `prd/PRD-002/导底备料存档/别名词表.csv` 里的别名、
 *    或考点名本身，是产线上「出题/录题前先查考点」真会打进去的说法，不是为凑测试编的词。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  KpNotFoundError,
  addKpAlias,
  createCoreDb,
  createKp,
  integrityCheck,
  kpContext,
  mergeKp,
  newId,
  nowLocalISO,
  readWriteGate,
  resolveKp,
  resolveMergedKp,
  rowRefId,
  verifyAuditChain,
  withCoreWrite,
  type CoreDbHandle,
  type MatchedVia,
  type RowRef,
} from "~/core";
import { errCodeMap, errorCause, kpError } from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
/**
 * 🔴 副本的资产仓指回**真库的** data/assets：VACUUM INTO 只搬库不搬图，
 *    不指过去的话 C1(c)「有登记行找不到文件」会当场假红（003-E 起真库有资产行了）。
 *    这里只读目录清单，不写一个字节。
 */
const 真资产目录 = join(process.cwd(), "data", "assets");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

/** 真库句柄（🔴 只读用：本文件对它只发 SELECT，写路径一律走副本） */
let 真库: CoreDbHandle;

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 一次性副本（B3 要真合并，只能在副本上做） */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-golden-${process.pid}-${tag}.db`);
  if (existsSync(p)) rmSync(p, { force: true });
  const 源 = createClient({ url: fileUrl(真库路径) });
  try {
    await 源.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    源.close();
  }
  副本清单.push(p);
  const h = await createCoreDb(fileUrl(p));
  句柄清单.push(h);
  return h;
}

async function 行<T>(
  h: CoreDbHandle,
  sql: string,
  args: Array<string | number> = [],
): Promise<T[]> {
  const r = await h.client.execute({ sql, args });
  return r.rows as unknown as T[];
}

async function 计数(
  h: CoreDbHandle,
  sql: string,
  args: Array<string | number> = [],
): Promise<number> {
  const rows = await 行<{ c: number | bigint }>(h, sql, args);
  return Number(rows[0]?.c ?? 0);
}

/** 按**名字**查活跃考点 id（🔴 金标不写死 ULID，见文件头纪律②） */
async function 查考点(h: CoreDbHandle, name: string): Promise<string> {
  const rows = await 行<{ id: string }>(
    h,
    "SELECT id FROM kp WHERE name = ? AND status IN ('draft','active')",
    [name],
  );
  expect(
    rows.length,
    `库里叫「${name}」的活跃考点有 ${rows.length} 个——金标按名字定位，重名/缺失都得先修数据`,
  ).toBe(1);
  return rows[0]!.id;
}

/** 词表里这个考点的词条（kind + term） */
async function 词条(h: CoreDbHandle, kpId: string) {
  return 行<{ kind: string; term: string }>(
    h,
    "SELECT kind, term FROM kp_fts WHERE kp_id = ? ORDER BY kind, term",
    [kpId],
  );
}

/** 真库四张「一写就看得见」的表，用来做只读自证 */
async function 真库指纹(h: CoreDbHandle) {
  return {
    审计行数: await 计数(h, "SELECT COUNT(*) AS c FROM audit_log"),
    工单行数: await 计数(h, "SELECT COUNT(*) AS c FROM review_queue"),
    打点行数: await 计数(h, "SELECT COUNT(*) AS c FROM metric_event"),
    考点行数: await 计数(h, "SELECT COUNT(*) AS c FROM kp"),
  };
}

let 开跑前指纹: Awaited<ReturnType<typeof 真库指纹>>;

beforeAll(async () => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate + scripts/load-kg-20260812.ts）`,
  ).toBe(true);
  真库 = await createCoreDb(fileUrl(真库路径));
  句柄清单.push(真库);
  开跑前指纹 = await 真库指纹(真库);
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  // Windows 句柄释放晚于 close()，删不掉不算失败（只是 %TEMP% 里的一次性副本）
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      try {
        if (existsSync(p)) rmSync(p, { force: true });
      } catch {
        /* 随它去 */
      }
    }
  }
});

// ---------------------------------------------------------------------------
// B1 · resolve_kp 金标 10 条
// ---------------------------------------------------------------------------

/**
 * 每一路**应有**的置信度区间（core/resolve.ts 文件头「打分口径」的机器复述）。
 * 金标只钉区间不钉小数：bm25 是批内相对量，库一长分数就会动，钉死小数=自造假红。
 */
const 路线口径: Record<MatchedVia, { 下限: number; 上限: number }> = {
  "exact-name": { 下限: 1, 上限: 1 },
  "exact-alias": { 下限: 1, 上限: 1 },
  prefix: { 下限: 0.85, 上限: 0.95 },
  trigram: { 下限: 0.3, 上限: 0.8 },
};

interface 金标条目 {
  编号: string;
  /** 🔴 真实查询：别名词表里的说法，或考点名本身 */
  query: string;
  /** 这条查询在产线上什么时候会被打进去 */
  场景: string;
  /** 期望走哪一路（决定置信度下限） */
  via: MatchedVia;
  /** 期望命中的考点**名字**（id 现查） */
  期望: string[];
  /** top1 必须是这几个之一（一对多时把并列的全列上） */
  top1: string[];
}

/**
 * 🔴 金标表——**往下追加**即可，别改已有行的期望值（改了就等于把红旗按灭）。
 * 覆盖面：exact-alias 一对多 / exact-name / 名与别名同分 / exact-alias 一对一 /
 *         精确压模糊 / prefix 一对多 / prefix / 别名前缀 / trigram 模糊 / 双字短查询。
 */
const 金标: 金标条目[] = [
  {
    编号: "B1-01",
    query: "绝对值压轴",
    场景: "打卡册「绝对值压轴」专项出题：一句话查考点，四个考点并列是**对的**",
    via: "exact-alias",
    期望: [
      "绝对值的化简与去号",
      "绝对值表距离求最值",
      "绝对值中的分类讨论",
      "数轴动点与定值距离",
    ],
    top1: [
      "绝对值的化简与去号",
      "绝对值表距离求最值",
      "绝对值中的分类讨论",
      "数轴动点与定值距离",
    ],
  },
  {
    编号: "B1-02",
    query: "合并同类项",
    场景: "录题挂考点：直接打考点全名，必须 1.0 命中它本人",
    via: "exact-name",
    期望: ["合并同类项"],
    top1: ["合并同类项"],
  },
  {
    编号: "B1-03",
    query: "去括号",
    场景: "整式/解方程两处都说「去括号」：名与别名同为 1.0，**名**排前",
    via: "exact-name",
    期望: ["去括号"],
    top1: ["去括号"],
  },
  {
    编号: "B1-04",
    query: "去绝对值",
    场景: "口语说法（别名词表·绝对值线）：老师嘴里的「去绝对值」= 绝对值的化简与去号",
    via: "exact-alias",
    期望: ["绝对值的化简与去号"],
    top1: ["绝对值的化简与去号"],
  },
  {
    编号: "B1-05",
    query: "化简求值",
    场景: "备课查专项：别名精确命中整式那条，分式那条只能当模糊次选",
    via: "exact-alias",
    期望: ["整式的化简求值"],
    top1: ["整式的化简求值"],
  },
  {
    编号: "B1-06",
    query: "科学记数法",
    场景: "出题查大类：库里没有叫「科学记数法」的考点，只有两条以它开头的",
    via: "prefix",
    期望: ["科学记数法表示较大的数", "科学记数法的还原与计算"],
    top1: ["科学记数法表示较大的数", "科学记数法的还原与计算"],
  },
  {
    编号: "B1-07",
    query: "实数的混合",
    场景: "实数计算类打卡册出题：打半截考点名，前缀路要接得住",
    via: "prefix",
    期望: ["实数的混合运算"],
    top1: ["实数的混合运算"],
  },
  {
    编号: "B1-08",
    query: "分类讨论",
    场景: "查思想方法：库里没有同名考点，靠别名「分类讨论思想」的前缀接住",
    via: "prefix",
    期望: ["绝对值中的分类讨论"],
    top1: ["绝对值中的分类讨论"],
  },
  {
    编号: "B1-09",
    query: "混合运算",
    场景: "跨章节找同类题：中段命中（trigram），有理数/实数/整式三条都该在候选里",
    via: "trigram",
    期望: ["有理数的混合运算", "实数的混合运算", "整式的混合运算"],
    top1: ["有理数的混合运算"],
  },
  {
    编号: "B1-10",
    query: "实数",
    场景: "🔴 双字短查询：trigram 切不出 token，MATCH 恒空，靠 LIKE 退路照样给候选",
    via: "prefix",
    期望: ["实数的混合运算"],
    top1: ["实数的混合运算"],
  },
];

describe("B1 · resolve_kp 金标 10 条（真库只读）", () => {
  it("金标表本身：10 条、编号不重、五类场景都覆盖到", () => {
    expect(金标.length).toBe(10);
    expect(new Set(金标.map((g) => g.编号)).size).toBe(10);
    expect(new Set(金标.map((g) => g.query)).size).toBe(10);
    const 路线 = new Set(金标.map((g) => g.via));
    for (const v of ["exact-name", "exact-alias", "prefix", "trigram"]) {
      expect(路线.has(v as MatchedVia), `金标没覆盖 ${v} 这一路`).toBe(true);
    }
  });

  for (const g of 金标) {
    it(`${g.编号} 「${g.query}」→ ${g.期望.join("／")}（${g.via}）`, async () => {
      const r = await resolveKp(g.query, {
        handle: 真库,
        limit: 20,
        enqueue: false, // 🔴 真库只读：低置信也不许开工单
      });
      const 说明 = `query=${g.query}｜候选=${r.candidates
        .map((c) => `${c.name}(${c.confidence}/${c.matchedVia})`)
        .join("、")}`;

      // ① 候选非空、置信度不退化（top1 ≥ 0.6 ⇒ 不该进低置信队列）
      expect(r.candidates.length, 说明).toBeGreaterThan(0);
      expect(r.lowConfidence, 说明).toBe(false);
      expect(r.warnings, 说明).toEqual([]);

      // ② 分数降序（精确压前缀、前缀压模糊，全靠这个序）
      const 分数 = r.candidates.map((c) => c.confidence);
      expect(
        [...分数].sort((a, b) => b - a),
        说明,
      ).toEqual(分数);

      // ③ top1 落在期望集合里
      expect(g.top1, 说明).toContain(r.candidates[0]!.name);

      // ④ 每个期望考点：在候选里 + via 对 + 置信度落在该路应有区间
      const { 下限, 上限 } = 路线口径[g.via];
      for (const name of g.期望) {
        const id = await 查考点(真库, name);
        const hit = r.candidates.find((c) => c.kpId === id);
        expect(hit, `${说明}｜期望考点「${name}」不在候选里`).toBeDefined();
        expect(hit!.name, 说明).toBe(name);
        expect(hit!.matchedVia, `${说明}｜「${name}」走的不是 ${g.via}`).toBe(
          g.via,
        );
        expect(
          hit!.confidence,
          `${说明}｜「${name}」置信度低于 ${g.via} 的下限 ${下限}`,
        ).toBeGreaterThanOrEqual(下限);
        expect(hit!.confidence, 说明).toBeLessThanOrEqual(上限);
        // 别名命中必须说得出命中的是哪条别名（人一眼看懂「为什么它算候选」）
        if (g.via === "exact-alias") expect(hit!.aliasHit, 说明).toBeTruthy();
      }
    });
  }

  it("B1-03 附证：同为 1.0 时 exact-name 排在 exact-alias 前面", async () => {
    const r = await resolveKp("去括号", { handle: 真库, enqueue: false });
    const 名 = await 查考点(真库, "去括号");
    const 别名侧 = await 查考点(真库, "去括号法则");
    expect(r.candidates[0]!.kpId).toBe(名);
    const 次 = r.candidates.find((c) => c.kpId === 别名侧);
    expect(次, "「去括号法则」挂着别名『去括号』，该在候选里").toBeDefined();
    expect(次!.matchedVia).toBe("exact-alias");
    expect(次!.confidence).toBe(1);
  });

  it("B1-05 附证：精确压模糊——「分式化简求值」只能当低分次选", async () => {
    const r = await resolveKp("化简求值", { handle: 真库, enqueue: false });
    const 分式 = await 查考点(真库, "分式化简求值");
    const 次 = r.candidates.find((c) => c.kpId === 分式)!;
    expect(次.matchedVia).toBe("trigram");
    expect(次.confidence).toBeLessThan(r.candidates[0]!.confidence);
  });

  it("B1-10 附证：<3 字走的是 LIKE 退路（中段命中的别名也召得回）", async () => {
    const r = await resolveKp("实数", {
      handle: 真库,
      limit: 20,
      enqueue: false,
    });
    // 「乘方与绝对值（实数）」这类**中段**命中，trigram MATCH 给不出（2 字切不出 token），
    // 只可能来自 LIKE '%实数%' 那条退路——它在候选里 = 退路真的跑了。
    const 中段 = r.candidates.filter(
      (c) => c.matchedVia === "trigram" && !!c.aliasHit,
    );
    expect(中段.length, "短查询退路没召回任何中段命中").toBeGreaterThan(0);
    for (const c of 中段) {
      expect(c.aliasHit!.startsWith("实数")).toBe(false); // 前缀路的活不算它头上
      expect(c.confidence).toBeGreaterThanOrEqual(路线口径.trigram.下限);
      expect(c.confidence).toBeLessThanOrEqual(路线口径.trigram.上限);
    }
  });
});

// ---------------------------------------------------------------------------
// B2 · 双版本缩范围
// ---------------------------------------------------------------------------

describe("B2 · 双版本缩范围：概念层唯一，教材层各挂各的（真库只读）", () => {
  /** 概念层考点：人教七下 8.3 / 浙教七上 3.4 各挂一处 */
  const 考点名 = "实数的混合运算";

  it("placements 恰是人教 + 浙教各一条，且路径各自对得上自家教材", async () => {
    const id = await 查考点(真库, 考点名);
    const card = await kpContext(id, { handle: 真库 });

    expect(card.kp.name).toBe(考点名);
    expect(
      card.placements.length,
      `落点：${card.placements
        .map((p) => `${p.edition}/${p.gradeSem}:${p.path.join(">")}`)
        .join("｜")}`,
    ).toBe(2);

    const 人教 = card.placements.find((p) => p.edition === "人教版")!;
    const 浙教 = card.placements.find((p) => p.edition === "浙教版")!;
    expect(人教, "人教侧落点丢了").toBeDefined();
    expect(浙教, "浙教侧落点丢了").toBeDefined();

    expect(人教.subject).toBe("初中数学");
    expect(人教.gradeSem).toBe("七下");
    expect(人教.treeStatus).toBe("active");
    expect(人教.path).toEqual(["第八章 实数", "8.3 实数及其简单运算"]);

    expect(浙教.subject).toBe("初中数学");
    expect(浙教.gradeSem).toBe("七上");
    expect(浙教.treeStatus).toBe("active");
    expect(浙教.path).toEqual(["第3章 实数", "3.4 实数的运算"]);

    // 两条落点分属两棵树（同一棵树挂两次 ≠ 双版本）
    expect(new Set(card.placements.map((p) => p.treeId)).size).toBe(2);
  });

  it("🔴 概念层唯一：resolve_kp 只给一条，不因双树出双份候选（MINOR-2）", async () => {
    const id = await 查考点(真库, 考点名);
    // 「实数的运算」= 浙教节名，也是该考点的别名——最容易露出「双树双份」的问法
    const r = await resolveKp("实数的运算", {
      handle: 真库,
      limit: 20,
      enqueue: false,
    });
    const 同一考点 = r.candidates.filter((c) => c.kpId === id);
    expect(
      同一考点.length,
      `候选：${r.candidates.map((c) => `${c.name}(${c.confidence})`).join("、")}`,
    ).toBe(1);
    expect(同一考点[0]!.confidence).toBe(1);
    expect(同一考点[0]!.matchedVia).toBe("exact-alias");
    // 候选里也不许出现「同名不同 id」的双胞胎
    expect(new Set(r.candidates.map((c) => c.kpId)).size).toBe(
      r.candidates.length,
    );
  });

  it("C6 口径复述：每 (subject, edition, gradeSem) 至多一棵 active 树", async () => {
    const 冲突 = await 行<{ subject: string; edition: string; c: number }>(
      真库,
      `SELECT subject, edition, grade_sem, COUNT(*) AS c FROM edition_tree
        WHERE status='active' GROUP BY subject, edition, grade_sem HAVING COUNT(*) > 1`,
    );
    expect(
      冲突.map((x) => `${x.subject}/${x.edition}×${x.c}`),
      "同一册有两棵 active 树 = 检索必出双份候选",
    ).toEqual([]);

    // B2 这两棵树本身也各只有一棵（本例的结论就建立在它们唯一之上）
    for (const [edition, gradeSem] of [
      ["人教版", "七下"],
      ["浙教版", "七上"],
    ]) {
      const c = await 计数(
        真库,
        `SELECT COUNT(*) AS c FROM edition_tree
          WHERE status='active' AND subject='初中数学' AND edition=? AND grade_sem=?`,
        [edition!, gradeSem!],
      );
      expect(c, `${edition} ${gradeSem} 的 active 树`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// B3 · 合并后无悬挂（🔴 真合并，只能在副本上做）
// ---------------------------------------------------------------------------

describe("B3 · 造重复 → merge_kp → 检索/别名/错因候选全跟走，旧 id 可达（副本）", () => {
  let h: CoreDbHandle;
  /** 重复录进来的壳 / 库里真正的那个考点 */
  let 重复 = "";
  let 正主 = "";
  let cause = "";
  const 重复名 = "合并同类项（重复录入）";
  const 新别名 = "同类项归并";
  /** 正主身上本来就有的别名——合并时该**去重**而不是插重复行 */
  const 撞车别名 = "同类项合并";
  const 七码 = "ZSX-TLX-01";

  beforeAll(async () => {
    h = await 造副本("b3-merge");
    正主 = await 查考点(h, "合并同类项");
    重复 = (await createKp({ name: 重复名 }, { handle: h })).id;

    await addKpAlias(重复, 新别名, { handle: h });
    await addKpAlias(重复, 撞车别名, { handle: h });

    cause = newId("ec");
    await withCoreWrite(
      { actor: "system", tool: "golden_b3_seed" },
      async (tx) => {
        const refs: RowRef[] = [];
        await tx.insert(errorCause).values({
          id: cause,
          name: "同类项判错（字母指数不同也合）",
          status: "active",
        });
        refs.push({ table: "error_cause", id: cause, op: "insert" });

        await tx.insert(kpError).values({ kpId: 重复, causeId: cause });
        refs.push({
          table: "kp_error",
          id: rowRefId(重复, cause),
          op: "insert",
        });

        await tx.insert(errCodeMap).values({
          kpId: 重复,
          errCode: 七码,
          causeId: cause,
          mappedBy: "golden-b3",
          mappedAt: nowLocalISO(),
        });
        refs.push({
          table: "err_code_map",
          id: rowRefId(重复, 七码),
          op: "insert",
        });
        return refs;
      },
      h,
    );
  });

  it("合并前：重复考点自己进得了词表、查得到（不然后面的『消失』说明不了问题）", async () => {
    expect((await 词条(h, 重复)).map((x) => x.term).sort()).toEqual(
      [新别名, 撞车别名, 重复名].sort(),
    );
    const r = await resolveKp(新别名, { handle: h, enqueue: false });
    expect(r.candidates[0]!.kpId).toBe(重复);
  });

  it("merge_kp：别名/错因候选/七码映射全量搬到正主，壳侧一行不剩", async () => {
    const r = await mergeKp(重复, 正主, {
      actor: "human",
      note: "金标 B3：重复录入的考点合并回正主",
      handle: h,
    });
    expect(r.from).toBe(重复);
    expect(r.to).toBe(正主);

    // 壳侧清空
    for (const t of ["kp_alias", "kp_error", "err_code_map"]) {
      expect(
        await 计数(h, `SELECT COUNT(*) AS c FROM ${t} WHERE kp_id = ?`, [重复]),
        `${t} 还留在壳上`,
      ).toBe(0);
    }
    // 正主收齐：新别名搬过来，撞车的那条去重（不是插成两行）
    expect(
      await 计数(
        h,
        "SELECT COUNT(*) AS c FROM kp_alias WHERE kp_id=? AND alias=?",
        [正主, 新别名],
      ),
    ).toBe(1);
    expect(
      await 计数(
        h,
        "SELECT COUNT(*) AS c FROM kp_alias WHERE kp_id=? AND alias=?",
        [正主, 撞车别名],
      ),
    ).toBe(1);
    expect(
      await 计数(
        h,
        "SELECT COUNT(*) AS c FROM kp_error WHERE kp_id=? AND cause_id=?",
        [正主, cause],
      ),
    ).toBe(1);
    expect(
      await 计数(
        h,
        "SELECT COUNT(*) AS c FROM err_code_map WHERE kp_id=? AND err_code=?",
        [正主, 七码],
      ),
    ).toBe(1);
    expect(r.moved.kp_alias).toBe(1);
    expect(r.dropped.kp_alias).toBe(1);
    expect(r.moved.kp_error).toBe(1);
    expect(r.moved.err_code_map).toBe(1);
  });

  it("🔴 检索跟走：壳的词条全消失，新别名查得到正主", async () => {
    expect(await 词条(h, 重复)).toEqual([]);
    expect((await 词条(h, 正主)).some((x) => x.term === 新别名)).toBe(true);

    const r = await resolveKp(新别名, { handle: h, enqueue: false });
    expect(r.candidates[0]!.kpId).toBe(正主);
    expect(r.candidates[0]!.confidence).toBe(1);
    expect(r.candidates.map((c) => c.kpId)).not.toContain(重复);
  });

  it("🔴 旧 id / 旧名字照样可达：resolveMergedKp 追得到，kp_context 自报追链", async () => {
    const 落点 = await resolveMergedKp(h, 重复);
    expect(落点.id).toBe(正主);
    expect(落点.hops).toBe(1);
    expect(落点.status).toBe("active");

    const card = await kpContext(重复, { handle: h });
    expect(card.kp.id).toBe(正主);
    expect(card.resolvedThrough?.originalId).toBe(重复);
    expect(card.mergedFrom?.map((m) => m.id)).toContain(重复);
    expect(card.aliases).toContain(新别名);

    // 用**旧名字**查：候选落到正主，并标明是从哪个壳追过来的
    const r = await resolveKp(重复名, { handle: h, enqueue: false });
    expect(r.candidates[0]!.kpId).toBe(正主);
    expect(r.candidates[0]!.resolvedFrom?.id).toBe(重复);
    expect(r.warnings).toEqual([]);
  });

  it("对账：C2 悬挂引用绿、C1a 审计覆盖不漏、无红旗、闸静息、链接得上", async () => {
    const report = await integrityCheck({
      handle: h,
      metric: false,
      assetsDir: 真资产目录,
    });
    const c2 = report.checks.find((c) => c.id === "C2")!;
    expect(c2.ok, c2.details.join("\n")).toBe(true);
    expect(c2.stats?.合计).toBe(0);

    const c1 = report.checks.find((c) => c.id === "C1")!;
    expect(c1.stats?.a_无审计覆盖行, c1.details.join("\n")).toBe(0);

    const 红 = report.checks
      .filter((c) => !c.ok && c.level === "red")
      .map((c) => c.id);
    expect(红).toEqual([]);

    expect(await readWriteGate(h)).toBe(0);
    const chain = await verifyAuditChain(h);
    expect(chain.ok, chain.reason).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B4 · 编造 id 引导
// ---------------------------------------------------------------------------

describe("B4 · 编造 kp_id：查不到也要把路指出来（真库只读）", () => {
  it("🔴 可读文本形态 kp_绝对值压轴 → KP_NOT_FOUND 且候选非空、候选都是真 id", async () => {
    const e = await kpContext("kp_绝对值压轴", { handle: 真库 }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(KpNotFoundError);
    const err = e as KpNotFoundError;
    expect(err.code).toBe("KP_NOT_FOUND");
    expect(err.candidates.length).toBeGreaterThan(0);
    expect(err.message).toContain("绝对值压轴");
    expect(err.message).toContain(err.candidates[0]!.kpId);

    // 候选必须是库里真在的行（给一串假 id 当"引导"比不给还坏）
    for (const c of err.candidates) {
      const n = await 计数(真库, "SELECT COUNT(*) AS c FROM kp WHERE id = ?", [
        c.kpId,
      ]);
      expect(n, `候选 ${c.kpId} 在库里查无此行`).toBe(1);
    }
    // 拿它给的 kpId 再调一次 —— agent 照着自愈这条路必须真的走得通
    const card = await kpContext(err.candidates[0]!.kpId, { handle: 真库 });
    expect(card.kp.id).toBe(err.candidates[0]!.kpId);
  });

  it("🔴 ULID 形状（库里没有这行）→ 候选空，但 message 指得出下一步调 resolve_kp", async () => {
    const 假 = "kp_01ZZZZZZZZZZZZZZZZZZZZZZZZ"; // 合法 Crockford 形状，只是没这行
    const e = await kpContext(假, { handle: 真库 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KpNotFoundError);
    const err = e as KpNotFoundError;
    expect(err.kpId).toBe(假);
    expect(err.candidates).toEqual([]);
    expect(err.message).toContain("resolve_kp");
  });

  it("可读但词表外（kp_洛必达法则）→ 候选空，也要说清是「换说法」还是「还没建」", async () => {
    const e = await kpContext("kp_洛必达法则", { handle: 真库 }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(KpNotFoundError);
    const err = e as KpNotFoundError;
    expect(err.candidates).toEqual([]);
    expect(err.message).toContain("洛必达法则");
    expect(err.message).toContain("resolve_kp");
  });
});

// ---------------------------------------------------------------------------
// 只读自证（🔴 金标打的是真库，必须证明它一个字都没写）
// ---------------------------------------------------------------------------

describe("🔴 只读自证：B1/B2/B4 跑完，真库四表行数一行不动", () => {
  it("审计 / 工单 / 打点 / 考点 行数与开跑前一致", async () => {
    expect(await 真库指纹(真库)).toEqual(开跑前指纹);
  });
});
