/**
 * 十道录题闸 · 逐闸一红一绿（AI:PRD-003 · 003-C）
 *
 * 沿用既有范式：**真库只 SELECT，一切行为测试在 VACUUM INTO 出来的副本上跑**。
 *
 * 🔴 一红一绿是最低要求，不是形式：只测红灯会漏掉"闸太狠"（把好料也拦了），
 *    只测绿灯会漏掉"闸是死的"（常绿的闸等于没有闸）。
 *
 * 🔴 闸④（指令词）的绿例**必须**含 seq58-61 型反例 ——
 *    `…。化简：|a+c|−|b+c|+|a−b|。` 里的「化简：」是真题面，剥了这道题就没了。
 *    这是备料 §5② 点名的天然回归样本，掉了它这道闸迟早被改成一刀切。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCoreDb,
  ingestItemSchema,
  newId,
  nowLocalISO,
  withCoreWrite,
  writeQuestionFts,
  type CoreDbHandle,
  type IngestBatchCtx,
  type IngestItemCtx,
  type KbIngestItem,
  type KbIngestPayload,
} from "~/core";
import { emptyDerived } from "~/core/gates/ingest-context";
import {
  checkContract,
  INGEST_CONTRACT_CODE,
} from "~/core/gates/ingest-contract.gate";
import {
  CALC_CODES,
  ingestCalcGate,
  isCalcCandidate,
  looksLikePureExpression,
} from "~/core/gates/ingest-calc.gate";
import {
  DEDUP_CODES,
  ingestDedupGate,
  matchKeyOf,
  normalizeStem,
} from "~/core/gates/ingest-dedup.gate";
import {
  FIGURE_CODES,
  ingestFigureGate,
} from "~/core/gates/ingest-figure.gate";
import {
  INSTRUCTION_CODES,
  ingestInstructionGate,
  stripLeadInstruction,
} from "~/core/gates/ingest-instruction.gate";
import { KP_CODES, ingestKpGate } from "~/core/gates/ingest-kp.gate";
import {
  PLACEHOLDER_CODES,
  ingestPlaceholderGate,
} from "~/core/gates/ingest-placeholder.gate";
import {
  PREFIX_CODES,
  cleanStemPrefix,
  ingestPrefixGate,
  prefixResidue,
} from "~/core/gates/ingest-prefix.gate";
import {
  PROV_CODES,
  ingestProvenanceGate,
} from "~/core/gates/ingest-provenance.gate";
import {
  GRADE_CODES,
  decideSolutionGrade,
  ingestSolutionGradeGate,
} from "~/core/gates/ingest-solution-grade.gate";
import { type CalcVerifyResult } from "~/core";
import { question } from "~/server/db/schema";

// ---------------------------------------------------------------------------
// 副本库
// ---------------------------------------------------------------------------

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];
const 临时目录 = join(tmpdir(), `kf-gates-${process.pid}`);

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-gates-${process.pid}-${tag}.db`);
  if (existsSync(p)) rmSync(p, { force: true });
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  副本清单.push(p);
  const h = await createCoreDb(fileUrl(p));
  句柄清单.push(h);
  return h;
}

let H: CoreDbHandle;

beforeAll(async () => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
  H = await 造副本("main");
  mkdirSync(临时目录, { recursive: true });
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      try {
        if (existsSync(p)) rmSync(p, { force: true });
      } catch {
        /* Windows 句柄释放晚于 close()，删不掉只留个临时文件 */
      }
    }
  }
  try {
    rmSync(临时目录, { recursive: true, force: true });
  } catch {
    /* 同上 */
  }
});

// ---------------------------------------------------------------------------
// 造 ctx（管道相一的变换链，用的是各闸导出的纯函数）
// ---------------------------------------------------------------------------

function 造题(raw: Record<string, unknown>): KbIngestItem {
  return ingestItemSchema.parse({
    seq: 1,
    kps: [{ ref: "绝对值的概念" }],
    prov: { type: "manual", createdBy: "闸单测" },
    ...raw,
  });
}

function 造ctx(
  item: KbIngestItem,
  opts: {
    payload?: Partial<KbIngestPayload>;
    keyOwner?: Map<string, number>;
    calc?: CalcVerifyResult | null;
  } = {},
): IngestItemCtx {
  const d = emptyDerived();
  const ins = stripLeadInstruction(item.stem);
  d.stemStripped = ins.text.trim();
  d.stripped.push(...ins.stripped);
  const cl = cleanStemPrefix(d.stemStripped);
  d.stemClean = cl.text;
  d.stripped.push(...cl.stripped);
  d.matchKey = matchKeyOf(d.stemClean);
  d.calc = opts.calc ?? null;

  const payload: KbIngestPayload = {
    contract: "kb-ingest/v1",
    source: "闸单测@1",
    items: [item],
    ...opts.payload,
  };

  const batch: IngestBatchCtx = {
    handle: H,
    payload,
    keyOwner: opts.keyOwner ?? new Map([[d.matchKey, item.seq]]),
    assetsDir: join(临时目录, "assets"),
  };
  return { seq: item.seq, item, derived: d, batch };
}

/** 跑一道闸，回结果（闸可能是同步的） */
async function 跑(
  gate: { run: (c: IngestItemCtx) => unknown },
  ctx: IngestItemCtx,
) {
  return (await gate.run(ctx)) as
    | { ok: true }
    | { ok: false; code: string; message: string; candidates?: unknown[] };
}

// ---------------------------------------------------------------------------
// 闸① 契约
// ---------------------------------------------------------------------------

describe("闸① 契约 kb-ingest/v1", () => {
  const 好料 = {
    contract: "kb-ingest/v1",
    source: "每日打卡@2026-08-12",
    items: [
      {
        seq: 1,
        stem: "3+5×2",
        answer: "13",
        qtype: "计算",
        kps: [{ ref: "绝对值的概念", isPrimary: true }],
        prov: { type: "pipeline", pipelineRef: "gen_打卡.py@2026-08-10" },
      },
    ],
  };

  it("绿：完整 payload 过；answer=null + analysis 也过（R3 三路源的合法形态）", () => {
    expect(checkContract(好料).ok).toBe(true);

    const 只有解析 = {
      ...好料,
      items: [{ ...好料.items[0]!, answer: null, analysis: "先定号再去壳。" }],
    };
    const r = checkContract(只有解析);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.items[0]!.answer).toBe(null);
      expect(r.payload.items[0]!.analysis).toBe("先定号再去壳。");
    }
  });

  it("红：契约串不对 / 答案解析都没有 / 批内 seq 撞车 —— 一律整批拒", () => {
    const 错契约 = checkContract({ ...好料, contract: "punch-ingest/v1" });
    expect(错契约.ok).toBe(false);
    if (!错契约.ok) expect(错契约.result.code).toBe(INGEST_CONTRACT_CODE);

    const 无解答 = checkContract({
      ...好料,
      items: [{ ...好料.items[0]!, answer: null }],
    });
    expect(无解答.ok).toBe(false);
    if (!无解答.ok)
      expect(无解答.result.message).toContain(
        "answer 与 analysis 至少要有一个",
      );

    const 撞seq = checkContract({
      ...好料,
      items: [好料.items[0]!, { ...好料.items[0]! }],
    });
    expect(撞seq.ok).toBe(false);
    if (!撞seq.ok) expect(撞seq.result.message).toContain("在批内重复");
  });
});

// ---------------------------------------------------------------------------
// 闸② provenance
// ---------------------------------------------------------------------------

describe("闸② provenance 四型", () => {
  it("绿：pipeline 带 pipelineRef / scan 带 sourceDoc+page / manual 带 createdBy", async () => {
    const p = await 跑(
      ingestProvenanceGate,
      造ctx(
        造题({
          stem: "3+5×2",
          answer: "13",
          prov: { type: "pipeline", pipelineRef: "gen_打卡.py@2026-08-10" },
        }),
      ),
    );
    expect(p.ok).toBe(true);

    const s = await 跑(
      ingestProvenanceGate,
      造ctx(
        造题({
          stem: "3+5×2",
          answer: "13",
          prov: { type: "scan", page: 37 },
        }),
        { payload: { sourceDoc: { title: "七上必刷题", kind: "册子" } } },
      ),
    );
    expect(s.ok).toBe(true);

    const m = await 跑(
      ingestProvenanceGate,
      造ctx(造题({ stem: "x", answer: "1" })),
    );
    expect(m.ok).toBe(true);
  });

  it("红：scan 缺 page / model 的 modelId 库里查无此行", async () => {
    const 缺页 = await 跑(
      ingestProvenanceGate,
      造ctx(造题({ stem: "3+5×2", answer: "13", prov: { type: "scan" } }), {
        payload: { sourceDoc: { title: "七上必刷题", kind: "册子" } },
      }),
    );
    expect(缺页.ok).toBe(false);
    if (!缺页.ok) expect(缺页.code).toBe(PROV_CODES.scanNoPage);

    const 编的模型 = await 跑(
      ingestProvenanceGate,
      造ctx(
        造题({
          stem: "3+5×2",
          answer: "13",
          prov: { type: "model", modelId: "em_01KZZZZZZZZZZZZZZZZZZZZZZZ" },
        }),
      ),
    );
    expect(编的模型.ok).toBe(false);
    if (!编的模型.ok) expect(编的模型.code).toBe(PROV_CODES.modelNotFound);
  });
});

// ---------------------------------------------------------------------------
// 闸③ 考点
// ---------------------------------------------------------------------------

describe("闸③ 考点标全（只认 1.0 精确命中）", () => {
  it("绿：名全等命中真叶子，主考点默认取第一个", async () => {
    const ctx = 造ctx(
      造题({
        stem: "3+5×2",
        answer: "13",
        kps: [{ ref: "绝对值的概念" }, { ref: "绝对值的化简与去号" }],
      }),
    );
    const r = await 跑(ingestKpGate, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.derived.kps).toHaveLength(2);
    expect(ctx.derived.kps[0]!.isPrimary).toBe(true);
    expect(ctx.derived.kps[1]!.isPrimary).toBe(false);
    expect(ctx.derived.kps[0]!.kpId).toMatch(/^kp_/);
    expect(ctx.derived.notes.join()).toContain("默认取第一个");
  });

  it("红：编的考点名 → KP_NOT_FOUND；一名多考点（别名「绝对值压轴」）→ AMBIGUOUS_KP 带候选", async () => {
    const 没有 = await 跑(
      ingestKpGate,
      造ctx(
        造题({
          stem: "3+5×2",
          answer: "13",
          kps: [{ ref: "绝对值宇宙无敌考点" }],
        }),
      ),
    );
    expect(没有.ok).toBe(false);
    if (!没有.ok) expect(没有.code).toBe(KP_CODES.notFound);

    const 多义 = await 跑(
      ingestKpGate,
      造ctx(
        造题({ stem: "3+5×2", answer: "13", kps: [{ ref: "绝对值压轴" }] }),
      ),
    );
    expect(多义.ok).toBe(false);
    if (!多义.ok) {
      expect(多义.code).toBe(KP_CODES.ambiguous);
      // 🔴 候选是这个错误的主体：不给候选就是把 agent 晾在那儿
      expect((多义.candidates ?? []).length).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 闸④ 指令词
// ---------------------------------------------------------------------------

describe("闸④ 题面禁指令词（只剥句首，句中不动）", () => {
  it("绿：句首裸指令词剥掉并留痕；🔴 seq58-61 型『句中化简：』一个字不动", async () => {
    const 句首 = 造ctx(造题({ stem: "1．计算：3+5×2", answer: "13" }));
    expect((await 跑(ingestInstructionGate, 句首)).ok).toBe(true);
    expect(句首.derived.stemStripped).toBe("3+5×2");
    expect(句首.derived.stripped.join()).toContain("计算：");

    // 🔴 备料 §5② 的天然反例（种子集 seq 58-61）
    const 反例 =
      "有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|。化简：|a+c|−|b+c|+|a−b|。";
    const 句中 = 造ctx(造题({ stem: 反例, analysis: "先定号再去壳。" }));
    expect((await 跑(ingestInstructionGate, 句中)).ok).toBe(true);
    expect(句中.derived.stemStripped).toBe(反例);
    expect(句中.derived.stripped).toHaveLength(0);

    // 「计算下面各题，能简算的要简算」——剩余以中文开头 ⇒ 是真题面，不剥
    const 多小问 = stripLeadInstruction("计算：下面各题，能简算的要简算");
    expect(多小问.stripped).toHaveLength(0);
  });

  it("红：题面里带元词「变式」——属性混进题面，回产线改", async () => {
    const r = await 跑(
      ingestInstructionGate,
      造ctx(造题({ stem: "变式 1：已知 |x-3|=5，求 x", answer: "x=8 或 -2" })),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(INSTRUCTION_CODES.metaWord);
      expect(r.message).toContain("变式");
    }
  });
});

// ---------------------------------------------------------------------------
// 闸⑤ 前缀清洗
// ---------------------------------------------------------------------------

describe("闸⑤ 前缀清洗（照抄 clean_stems v1/v2 + preflight 题号）", () => {
  it("绿：来源/栏目/题号多层叠加逐层剥净，且 1.5 米不会被咬", async () => {
    const ctx = 造ctx(
      造题({
        stem: "【易错点】[2025浙江杭州期末，较难]12．已知 |x-3|=5，求 x",
        answer: "x=8 或 -2",
      }),
    );
    const r = await 跑(ingestPrefixGate, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.derived.stemClean).toBe("已知 |x-3|=5，求 x");
    expect(ctx.derived.stripped.length).toBeGreaterThanOrEqual(2);
    expect(prefixResidue(ctx.derived.stemClean)).toBe(null);

    // 🔴 有意偏离 preflight 原正则的那一处：小数不能被当题号剥
    expect(cleanStemPrefix("1.5 米的绳子剪去 0.6 米").text).toBe(
      "1.5 米的绳子剪去 0.6 米",
    );
    // 但真题号照剥
    expect(cleanStemPrefix("12. 已知 x=1").text).toBe("已知 x=1");
  });

  it("红：剥完还剩残留 → 机器复核（等价于老口径那句 REGEXP=0）", async () => {
    const ctx = 造ctx(造题({ stem: "占位", answer: "1" }));
    // 直接把一个「剥离规则覆盖不到、但残留判据认得出」的形态塞进 stemClean
    ctx.derived.stemClean = "★★★ 已知 |x-3|=5";
    const r = await 跑(ingestPrefixGate, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(PREFIX_CODES.residue);
      expect(r.message).toContain("REGEXP");
    }
  });
});

// ---------------------------------------------------------------------------
// 闸⑥ 占位红旗
// ---------------------------------------------------------------------------

describe("闸⑥ 占位红旗", () => {
  it("绿：正常题面过；answer 是占位只记 note 不拦", async () => {
    const ctx = 造ctx(
      造题({
        stem: "已知 |x-3|=5，求 x",
        answer: "略",
        analysis: "分类讨论。",
      }),
    );
    expect((await 跑(ingestPlaceholderGate, ctx)).ok).toBe(true);
    expect(ctx.derived.notes.join()).toContain("占位符");
  });

  it("红：题面纯占位 / 说了「如图」却没给题干图", async () => {
    const 占位 = await 跑(
      ingestPlaceholderGate,
      造ctx(造题({ stem: "待补", answer: "1" })),
    );
    expect(占位.ok).toBe(false);
    if (!占位.ok) expect(占位.code).toBe(PLACEHOLDER_CODES.placeholder);

    const 缺图 = await 跑(
      ingestPlaceholderGate,
      造ctx(
        造题({
          stem: "如图，数轴上的三点 A、B、C 分别表示有理数 a，b，c。化简 |a−b|",
          analysis: "由数轴定号。",
        }),
      ),
    );
    expect(缺图.ok).toBe(false);
    if (!缺图.ok) expect(缺图.code).toBe(PLACEHOLDER_CODES.figureMissing);
  });

  // ── 内部占位串（003-E4 补的盲点，G-3 专项路 P1）──────────────────────────
  it("红：题面带『［图·内联SVG］』——🔴 figures 给了照样红（图已挂 ≠ 占位串可以留）", async () => {
    const 题面 =
      "如图，数轴上的三点 A、B、C 分别表示有理数 a，b，c。\n" +
      "［图·内联SVG］(1) 填空：a−b ______ 0。";

    // ① 没给图：本来就该红（但要红在**更准的那个码**上，不是 FIGURE_DECLARED_BUT_MISSING）
    const 没图 = await 跑(
      ingestPlaceholderGate,
      造ctx(造题({ stem: 题面, analysis: "由数轴定号。" })),
    );
    expect(没图.ok).toBe(false);
    if (!没图.ok) {
      expect(没图.code).toBe(PLACEHOLDER_CODES.internalMarker);
      expect(没图.message).toContain("喂料侧");
    }

    // ② 🔴 给了图 —— 这正是原来放行、把占位串放进库的那条路
    const 图 = join(临时目录, "fig-marker.svg");
    writeFileSync(图, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    const 有图 = await 跑(
      ingestPlaceholderGate,
      造ctx(
        造题({
          stem: 题面,
          analysis: "由数轴定号。",
          figures: [{ role: "stem", path: 图 }],
        }),
      ),
    );
    expect(有图.ok).toBe(false);
    if (!有图.ok) {
      expect(有图.code).toBe(PLACEHOLDER_CODES.internalMarker);
      expect(有图.message).toContain("给没给都一样红");
    }

    // ③ 解析里带也拦（解析一样要印给人看）
    const 解析带 = await 跑(
      ingestPlaceholderGate,
      造ctx(
        造题({
          stem: "化简 |a−b|+|b−c|。",
          analysis: "先看图定号：[图·内联SVG] 再去壳。",
        }),
      ),
    );
    expect(解析带.ok).toBe(false);
    if (!解析带.ok) expect(解析带.code).toBe(PLACEHOLDER_CODES.internalMarker);
  });

  it("绿：正常中文里的「（图1）」不是内部记号，配了图就该放行", async () => {
    const 图 = join(临时目录, "fig-ok.svg");
    writeFileSync(图, '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    const ctx = 造ctx(
      造题({
        stem: "如图（图1）所示，数轴上 A 表示 a。化简 |a−1|。",
        analysis: "由数轴定号。",
        figures: [{ role: "stem", path: 图 }],
      }),
    );
    // 🔴 收得太宽（把「（图1）」也当内部记号）会把一大票正常题打成红灯 —— 这条就是防它
    expect((await 跑(ingestPlaceholderGate, ctx)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 闸⑦ 查重
// ---------------------------------------------------------------------------

describe("闸⑦ 查重 match_key", () => {
  it("绿：新题过；归一口径把 HTML/LaTeX/全半角折平，但不动运算符", () => {
    expect(normalizeStem("<span style='x'>3+5×2</span>")).toBe(
      normalizeStem("3+5×2"),
    );
    expect(normalizeStem("$x^2$")).toBe(normalizeStem("\\(x^2\\)"));
    expect(normalizeStem("（1）3＋5")).toBe(normalizeStem("(1)3+5"));
    // 🔴 减号不能被当标点删掉，否则 3-5 与 35 撞成同一题
    expect(matchKeyOf("3-5")).not.toBe(matchKeyOf("35"));
  });

  // ── 003-E5：严格剥法 —— 数学裸不等号不许被当标签吃 ────────────────────────
  it("绿：裸不等号一个字不丢（旧宽松 `<[^>]*>` 会整段吞掉）", () => {
    // 一句里有 `<` 也有 `>`：宽松剥法会把 `< 50 653 < 1 000 000` 当一个标签吃掉
    expect(normalizeStem("1 000 < 50 653 < 1 000 000 > 999")).toBe(
      "1000<50653<1000000>999",
    );
    // E4 在真库抓到的两条原样
    expect(normalizeStem("有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|。")).toBe(
      "有理数a<0b<0c>0且|a|<|c|<|b|",
    );
    expect(normalizeStem("（用 < 或 > 或 = 号填空）")).toBe(
      "(用<或>或=号填空)",
    );
    // 🔴 归一后必须还能区分：只在被吃那段上不同的两道题，键不能撞
    expect(matchKeyOf("已知 a < 0，b > 0，求值")).not.toBe(
      matchKeyOf("已知 a > 0，b < 0，求值"),
    );
  });

  it("绿：真 HTML 标签照剥净（填空线 span / 选项栅格 div）", () => {
    const 带标签 =
      '甲数是 <span style="display:inline-block;border-bottom:1px solid #000;min-width:3.4em"></span>，' +
      '乙数是 <div style="display:grid;grid-template-columns:repeat(2,1fr)">6</div>。';
    expect(normalizeStem(带标签)).toBe("甲数是乙数是6");
    // 同一道题换个行内样式不该变成"新题"
    expect(normalizeStem('<span style="a">3+5</span>')).toBe(
      normalizeStem("<span>3+5</span>"),
    );
    // 🔴 先剥后解码：被转义的 `&lt;span&gt;` 是正文，不能还原后再被剥掉
    expect(normalizeStem("比较 &lt;span&gt; 的大小")).toBe("比较<span>的大小");
  });

  it("红：撞库里的老题带出它是哪一行；同批互撞也拦", async () => {
    const 题面 = "闸单测·查重专用题 |x-3|=5";
    const 老题 = newId("q");
    await withCoreWrite(
      { actor: "system", tool: "ingest-gates.test.造老题", args: { 老题 } },
      async (tx) => {
        await tx.insert(question).values({
          id: 老题,
          stem: 题面,
          stemPlain: 题面,
          status: "pending",
          solutionGrade: "analysis_only",
          provType: "manual",
          createdBy: "闸单测",
          matchKey: matchKeyOf(题面),
          createdAt: nowLocalISO(),
        });
        await writeQuestionFts(tx, { questionId: 老题, stemPlain: 题面 });
        return [{ table: "question", id: 老题, op: "insert" as const }];
      },
      H,
    );

    const 撞库 = await 跑(
      ingestDedupGate,
      造ctx(造题({ stem: 题面, answer: "x=8 或 -2" })),
    );
    expect(撞库.ok).toBe(false);
    if (!撞库.ok) {
      expect(撞库.code).toBe(DEDUP_CODES.inDb);
      expect((撞库.candidates as { id: string }[])[0]!.id).toBe(老题);
    }

    // 同批互撞：keyOwner 说这个键归 seq=1，而当前这条是 seq=2
    const 新题面 = "闸单测·同批互撞 3+5×2";
    const ctx = 造ctx(造题({ seq: 2, stem: 新题面, answer: "13" }), {
      keyOwner: new Map([[matchKeyOf(新题面), 1]]),
    });
    const 批内 = await 跑(ingestDedupGate, ctx);
    expect(批内.ok).toBe(false);
    if (!批内.ok) expect(批内.code).toBe(DEDUP_CODES.inBatch);

    // 绿：库里没有的新题
    const 新 = await 跑(
      ingestDedupGate,
      造ctx(造题({ stem: `闸单测·全新题 ${newId("q")}`, answer: "1" })),
    );
    expect(新.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 闸⑧ 实算
// ---------------------------------------------------------------------------

function 造实算(
  verdict: CalcVerifyResult["verdict"],
  computed: string,
  expected: string | null,
): CalcVerifyResult {
  return {
    id: "1",
    verdict,
    detail: { reason: "单测造的", expr: "3+5*2", computed, expected },
  };
}

describe("闸⑧ 可实算即实算", () => {
  it("绿：verified 记判档候选；cannot_verify 如实降级不拦路；非计算题跳过", async () => {
    const 好 = 造ctx(造题({ stem: "3+5×2", answer: "13", qtype: "计算" }), {
      calc: 造实算("verified", "13", "13"),
    });
    expect((await 跑(ingestCalcGate, 好)).ok).toBe(true);
    expect(好.derived.notes.join()).toContain("calc_verified");

    const 算不动 = 造ctx(
      造题({ stem: "小明买了 3 支笔…", answer: "6 元", qtype: "计算" }),
      { calc: 造实算("cannot_verify", "", null) },
    );
    expect((await 跑(ingestCalcGate, 算不动)).ok).toBe(true);
    expect(算不动.derived.notes.join()).toContain("如实报");

    const 非计算 = 造ctx(造题({ stem: "说明理由", analysis: "略述。" }));
    expect((await 跑(ingestCalcGate, 非计算)).ok).toBe(true);

    // 送不送去算的判据
    expect(looksLikePureExpression("3+5×2")).toBe(true);
    expect(looksLikePureExpression("小明有 3 个苹果")).toBe(false);
    expect(
      isCalcCandidate(造题({ stem: "3+5×2", answer: "13" }), "3+5×2"),
    ).toBe(true);
  });

  it("红：mismatch —— 答案错比缺答案严重，所以是红灯不是降级", async () => {
    const r = await 跑(
      ingestCalcGate,
      造ctx(造题({ stem: "3+5×2", answer: "14", qtype: "计算" }), {
        calc: 造实算("mismatch", "13", "14"),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(CALC_CODES.mismatch);
      expect(r.message).toContain("13");
      expect(r.message).toContain("14");
    }
  });
});

// ---------------------------------------------------------------------------
// 闸⑨ 判档
// ---------------------------------------------------------------------------

describe("闸⑨ 判档 solution_grade", () => {
  it("绿：三档判定（实算过=calc_verified；有答案或解析=analysis_only）", async () => {
    const 实算过 = 造ctx(造题({ stem: "3+5×2", answer: "13", qtype: "计算" }), {
      calc: 造实算("verified", "13", "13"),
    });
    expect((await 跑(ingestSolutionGradeGate, 实算过)).ok).toBe(true);
    expect(实算过.derived.solutionGrade).toBe("calc_verified");

    const 只有解析 = 造ctx(造题({ stem: "说明理由", analysis: "因为…" }));
    expect((await 跑(ingestSolutionGradeGate, 只有解析)).ok).toBe(true);
    expect(只有解析.derived.solutionGrade).toBe("analysis_only");

    // 🔴 计算题验不动又没解析 ⇒ 如实降级 + 账上留 warn（不拦路）
    const 弱 = 造ctx(
      造题({ stem: "小明买笔…", answer: "6 元", qtype: "计算" }),
      {
        calc: 造实算("cannot_verify", "", null),
      },
    );
    expect((await 跑(ingestSolutionGradeGate, 弱)).ok).toBe(true);
    expect(弱.derived.solutionGrade).toBe("analysis_only");
    expect(弱.derived.notes.join()).toContain("warn");

    expect(
      decideSolutionGrade({ answer: null, analysis: null, calc: null }),
    ).toBe("no_solution");
  });

  it("红：两样都没有 = no_solution（防御闸：契约层被绕过时才会走到）", async () => {
    const ctx = 造ctx(造题({ stem: "已知 |x-3|=5，求 x", answer: "8" }));
    // 模拟「有人绕过 runIngestBatch 直接调闸」：答案被抹掉
    (ctx.item as { answer: string | null }).answer = null;
    const r = await 跑(ingestSolutionGradeGate, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(GRADE_CODES.noSolution);
  });
});

// ---------------------------------------------------------------------------
// 闸⑩ 配图
// ---------------------------------------------------------------------------

describe("闸⑩ 配图分级", () => {
  it("绿：题干图算出 hash 并标必审；解析图只进抽检不建工单", async () => {
    const 题干图 = join(临时目录, "stem.png");
    const 解析图 = join(临时目录, "ana.png");
    writeFileSync(题干图, "PNG-FAKE-STEM");
    writeFileSync(解析图, "PNG-FAKE-ANALYSIS");

    const ctx = 造ctx(
      造题({
        stem: "如图，数轴上的三点 A、B、C。化简 |a−b|",
        analysis: "由数轴定号。",
        figures: [
          { role: "stem", path: 题干图 },
          { role: "analysis", path: 解析图 },
        ],
      }),
    );
    const r = await 跑(ingestFigureGate, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.derived.figures).toHaveLength(2);
    expect(ctx.derived.figures[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.derived.figures[0]!.fileName).toBe(
      `${ctx.derived.figures[0]!.hash}.png`,
    );
    expect(ctx.derived.reviewRequired).toBe(true); // 题干图 ⇒ 必审
    expect(ctx.derived.sampled.join()).toContain("analysis:"); // 解析图 ⇒ 抽检
  });

  it("红：图文件不存在（路径写错 / 图还没生成就先来录题）", async () => {
    const r = await 跑(
      ingestFigureGate,
      造ctx(
        造题({
          stem: "如图所示，求面积",
          answer: "12",
          figures: [
            { role: "stem", path: join(临时目录, "根本没有这张图.png") },
          ],
        }),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(FIGURE_CODES.fileMissing);
  });
});
