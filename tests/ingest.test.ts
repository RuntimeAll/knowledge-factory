/**
 * 录题管道 runIngestBatch 端到端（AI:PRD-003 · 003-C）
 *
 * 沿用既有范式：真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑。
 * 🔴 每份副本各住一个**独立目录**（不是共用 tmpdir）：管道会往
 *    `<库文件同级>/assets/` 拷图、往 `backup/` 出快照 —— 共用目录会让
 *    对账 C1(c)「有文件查不到登记行」在别人的图上误红。
 *
 * 钉四件事：
 *   ① 三题小批：好题落库、坏题进隔离、账页页有（逐题逐闸可查）；
 *      落库后 FTS 投影对齐、对账无 red、审计覆盖闭合。
 *   ② dryRun：同一批跑一遍，**库与磁盘零变化**（COUNT 前后全等）。
 *   ③ 实算 mismatch：3+5×2 答案写 14 → CALC_MISMATCH 带 computed=13。
 *   ④ 题干图：入库即 review_required=1 + 开一张 kind='图片' 工单。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCoreDb,
  ftsQuery,
  integrityCheck,
  runIngestBatch,
  type CoreDbHandle,
  type IngestResult,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 目录清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

/** 一份副本 = 一个独立目录（库 + assets/ + backup/ 全在里面） */
async function 造副本(tag: string): Promise<CoreDbHandle> {
  const dir = join(tmpdir(), `kf-ingest-${process.pid}-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  目录清单.push(dir);

  const p = join(dir, "资料库.db");
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  const h = await createCoreDb(fileUrl(p));
  句柄清单.push(h);
  return h;
}

async function 数(h: CoreDbHandle, table: string): Promise<number> {
  const r = await h.client.execute(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number((r.rows[0] as unknown as { c: number }).c);
}

const 计数表 = [
  "question",
  "question_kp",
  "question_tag",
  "question_figure",
  "question_fts",
  "asset",
  "source_doc",
  "ingest_batch",
  "quarantine",
  "review_queue",
  "audit_log",
  "metric_event",
] as const;

async function 全表计数(h: CoreDbHandle): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of 计数表) out[t] = await 数(h, t);
  return out;
}

/** 三题小批：1 纯算式带答案 / 1 带解析无答案 / 1 假 kp 名 */
function 三题批() {
  return {
    contract: "kb-ingest/v1",
    source: "ingest.test@1",
    sourceDoc: { title: "管道单测·七上绝对值", kind: "册子" },
    items: [
      {
        seq: 1,
        stem: "1．计算：3+5×2",
        answer: "13",
        qtype: "计算",
        kps: [{ ref: "绝对值的概念" }],
        tags: ["单测"],
        prov: { type: "pipeline", pipelineRef: "ingest.test@1" },
        punchPos: { day: 1, section: "有理数混合运算", seq: 3 },
      },
      {
        seq: 2,
        stem: "有理数 a < 0，b < 0，c > 0，且 |a|<|c|<|b|。化简：|a+c|−|b+c|+|a−b|。",
        answer: null,
        analysis: "c>|a| ⟹ a+c>0；|b|>c ⟹ b+c<0；a>b ⟹ a−b>0。原式 = 2a+2c。",
        qtype: "解答",
        kps: [
          { ref: "绝对值的化简与去号", isPrimary: true },
          { ref: "绝对值的概念" },
        ],
        prov: { type: "manual", createdBy: "管道单测" },
      },
      {
        seq: 3,
        stem: "已知 |x-3|=5，则 x=________。",
        answer: "x=8 或 x=-2",
        qtype: "填空",
        kps: [{ ref: "绝对值宇宙无敌考点" }],
        prov: { type: "manual", createdBy: "管道单测" },
      },
    ],
  };
}

beforeAll(() => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  for (const dir of 目录清单) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄释放晚于 close()，删不掉只是留个临时目录 */
    }
  }
});

describe("① 三题小批：好题落库 / 坏题隔离 / 页页有账", () => {
  let h: CoreDbHandle;
  let r: IngestResult;

  beforeAll(async () => {
    h = await 造副本("main");
    r = await runIngestBatch(三题批(), { actor: "system", handle: h });
  }, 60_000);

  it("counts：accepted=2 / rejected=1，批落 committed 且带全套账", async () => {
    expect(r.counts).toEqual({
      total: 3,
      accepted: 2,
      queued: 0,
      rejected: 1,
    });
    expect(r.questionIds).toHaveLength(2);
    expect(r.quarantineIds).toHaveLength(1);

    const b = await h.client.execute({
      sql: "SELECT status, contract_ver, source, n_total, n_accepted, n_rejected, payload_hash, gate_report_json, committed_at FROM ingest_batch WHERE id = ?",
      args: [r.batchId!],
    });
    const row = b.rows[0] as unknown as Record<string, string | number | null>;
    expect(row.status).toBe("committed");
    expect(row.contract_ver).toBe("kb-ingest/v1");
    expect(row.source).toBe("ingest.test@1");
    expect(Number(row.n_total)).toBe(3);
    expect(Number(row.n_accepted)).toBe(2);
    expect(Number(row.n_rejected)).toBe(1);
    expect(String(row.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(row.committed_at).toBeTruthy();
    // 详账在这一列（逐题逐闸）
    const 账 = JSON.parse(String(row.gate_report_json)) as {
      items: { seq: number; gates: { items: { name: string }[] } }[];
    };
    expect(账.items).toHaveLength(3);
    expect(账.items[0]!.gates.items.map((g) => g.name)).toEqual([
      "②来源 provenance",
      "③考点标全",
      "④题面禁指令词",
      "⑤前缀清洗",
      "⑥占位红旗",
      "⑦查重 match_key",
      "⑧可实算即实算",
      "⑨判档 solution_grade",
      "⑩配图分级",
    ]);
  });

  it("逐题账：seq1 实算过档、剥了「1．计算：」；seq3 被考点闸拒且进隔离", async () => {
    const [一, 二, 三] = r.gateReport.items;

    expect(一!.verdict).toBe("accepted");
    expect(一!.calcVerdict).toBe("verified");
    expect(一!.solutionGrade).toBe("calc_verified");
    expect(一!.stripped.join()).toContain("计算：");

    expect(二!.verdict).toBe("accepted");
    expect(二!.solutionGrade).toBe("analysis_only");
    // 🔴 句中「化简：」一个字都没动（seq58-61 型反例）
    expect(二!.stripped).toHaveLength(0);
    expect(二!.kpIds).toHaveLength(2);
    expect(二!.primaryKpId).toBe(二!.kpIds[0]);

    expect(三!.verdict).toBe("rejected");
    expect(三!.failure?.code).toBe("KP_NOT_FOUND");
    expect(三!.questionId).toBe(null);

    const q = await h.client.execute({
      sql: "SELECT why, payload_json FROM quarantine WHERE batch_id = ?",
      args: [r.batchId!],
    });
    const 隔离 = q.rows[0] as unknown as { why: string; payload_json: string };
    expect(隔离.why).toContain("KP_NOT_FOUND");
    // 原样 payload 留着 —— 人改完直接重喂
    expect(JSON.parse(隔离.payload_json)).toMatchObject({ seq: 3 });
  });

  it("落库形态：题面已清洗、位置进 tag、考点挂上、批与源文档挂上", async () => {
    const 一 = r.questionIds[0]!;
    const row = (
      await h.client.execute({
        sql: "SELECT stem, stem_plain, answer, qtype, status, solution_grade, review_required, match_key, prov_type, pipeline_ref, ingest_batch_id, source_doc_id FROM question WHERE id = ?",
        args: [一],
      })
    ).rows[0] as unknown as Record<string, string | number | null>;

    expect(row.stem).toBe("3+5×2"); // 「1．计算：」已剥
    expect(String(row.stem_plain)).toContain("3"); // 侧车分词投影（search 模式）
    expect(row.status).toBe("pending");
    expect(row.solution_grade).toBe("calc_verified");
    expect(Number(row.review_required)).toBe(0);
    expect(row.prov_type).toBe("pipeline");
    expect(row.pipeline_ref).toBe("ingest.test@1");
    expect(row.ingest_batch_id).toBe(r.batchId);
    expect(row.source_doc_id).toBeTruthy();
    expect(String(row.match_key)).toMatch(/^[0-9a-f]{64}$/);

    const tags = (
      await h.client.execute({
        sql: "SELECT tag FROM question_tag WHERE question_id = ? ORDER BY tag",
        args: [一],
      })
    ).rows.map((x) => (x as unknown as { tag: string }).tag);
    expect(tags).toContain("单测");
    expect(tags).toContain("src:d1-s有理数混合运算-q3"); // punch 兼容位

    const kps = (
      await h.client.execute({
        sql: "SELECT kp_id, is_primary FROM question_kp WHERE question_id = ?",
        args: [一],
      })
    ).rows as unknown as { kp_id: string; is_primary: number }[];
    expect(kps).toHaveLength(1);
    expect(Number(kps[0]!.is_primary)).toBe(1);
  });

  it("FTS 投影：写侧真写了，查得到（方案甲 —— 触发器已经不管这事了）", async () => {
    const plan = await ftsQuery("化简");
    const hits = (
      await h.client.execute({
        sql: "SELECT question_id AS qid FROM question_fts WHERE question_fts MATCH ?",
        args: [plan.match!],
      })
    ).rows.map((x) => (x as unknown as { qid: string }).qid);
    expect(hits).toContain(r.questionIds[1]);
    expect(await 数(h, "question_fts")).toBe(2); // 只有落库的两题
  });

  it("对账：无 red；C1(f) FTS 投影对齐、C1(a) 审计覆盖闭合", async () => {
    const report = await integrityCheck({
      handle: h,
      assetsDir: join(
        join(tmpdir(), `kf-ingest-${process.pid}-main`),
        "assets",
      ),
    });
    const reds = report.checks.filter((c) => !c.ok && c.level === "red");
    expect(
      reds.map((c) => `${c.id}: ${c.details.join(" / ")}`),
      "对账不该有 red",
    ).toEqual([]);
    expect(report.ok).toBe(true);

    const c1 = report.checks.find((c) => c.id === "C1")!;
    expect(c1.stats?.f_有题无投影).toBe(0);
    expect(c1.stats?.f_有投影无题).toBe(0);
    expect(c1.stats?.a_无审计覆盖行).toBe(0);
    // 有题无向量是 warn（语义轴还没起来），不是 red
    expect(c1.level).toBe("warn");
  });

  it("审计：一次批 = 一条审计行，gate_results_json 是逐题小结", async () => {
    const a = (
      await h.client.execute({
        sql: "SELECT actor, tool, gate_results_json FROM audit_log WHERE tool = 'runIngestBatch' ORDER BY seq DESC LIMIT 1",
      })
    ).rows[0] as unknown as {
      actor: string;
      tool: string;
      gate_results_json: string;
    };
    expect(a.actor).toBe("system");
    const 小结 = JSON.parse(a.gate_results_json) as {
      total: number;
      failed: number;
      items: { name: string }[];
    };
    expect(小结.total).toBe(3);
    expect(小结.failed).toBe(1);
    expect(小结.items.map((i) => i.name)).toEqual(["seq=1", "seq=2", "seq=3"]);
  });

  it("收批后出了一份 batch 快照（备份也留痕）", () => {
    expect(r.backup?.path).toBeTruthy();
    expect(existsSync(r.backup!.path)).toBe(true);
    expect(r.backup!.path).toContain("-batch-");
  });
});

describe("② dryRun：库与磁盘零变化", () => {
  it("同一批 dryRun 跑完，十二张表计数前后全等，assets 目录不生成", async () => {
    const h = await 造副本("dry");
    const 前 = await 全表计数(h);

    const r = await runIngestBatch(三题批(), {
      actor: "system",
      handle: h,
      dryRun: true,
    });

    expect(r.dryRun).toBe(true);
    expect(r.batchId).toBe(null);
    expect(r.backup).toBe(null);
    // 🔴 账照出：dryRun 的价值就是「不写也能拿到完整 gate_report」（005 产线接入要用）
    expect(r.counts).toEqual({ total: 3, accepted: 2, queued: 0, rejected: 1 });
    expect(r.gateReport.items[2]!.failure?.code).toBe("KP_NOT_FOUND");

    expect(await 全表计数(h)).toEqual(前);
    const dir = join(tmpdir(), `kf-ingest-${process.pid}-dry`);
    expect(readdirSync(dir).filter((f) => f === "assets")).toEqual([]);
  }, 60_000);
});

describe("③ 实算 mismatch：答案错是红灯，不是降级", () => {
  it("3+5×2 答案写 14 → CALC_MISMATCH，账上带 computed=13", async () => {
    const h = await 造副本("calc");
    const r = await runIngestBatch(
      {
        contract: "kb-ingest/v1",
        source: "ingest.test@calc",
        items: [
          {
            seq: 1,
            stem: "3+5×2",
            answer: "14",
            qtype: "计算",
            kps: [{ ref: "绝对值的概念" }],
            prov: { type: "manual", createdBy: "管道单测" },
          },
        ],
      },
      { actor: "system", handle: h, dryRun: true },
    );

    expect(r.counts.rejected).toBe(1);
    const it0 = r.gateReport.items[0]!;
    expect(it0.calcVerdict).toBe("mismatch");
    expect(it0.failure?.code).toBe("CALC_MISMATCH");
    expect(it0.failure?.message).toContain("13"); // 实算值
    expect(it0.failure?.message).toContain("14"); // 卷面答案
    // 🔴 后面的闸照跑（默认不急停）：一次看全部问题
    expect(it0.gates.items).toHaveLength(9);
  }, 60_000);
});

describe("④ 题干图：入库即必审", () => {
  it("review_required=1 + 一张 kind='图片' 工单 + 图按 hash 落资产仓", async () => {
    const h = await 造副本("fig");
    const dir = join(tmpdir(), `kf-ingest-${process.pid}-fig`);
    const 图 = join(dir, "shuzhou.png");
    writeFileSync(图, "PNG-FAKE-数轴图");

    const r = await runIngestBatch(
      {
        contract: "kb-ingest/v1",
        source: "ingest.test@fig",
        items: [
          {
            seq: 1,
            stem: "如图，数轴上的三点 A、B、C 分别表示有理数 a，b，c。化简：|a−b|−|a−c|",
            analysis: "由数轴定号后逐项去壳。",
            qtype: "解答",
            kps: [{ ref: "绝对值的几何意义与数轴距离" }],
            figures: [{ role: "stem", path: 图 }],
            prov: { type: "manual", createdBy: "管道单测" },
          },
        ],
      },
      { actor: "system", handle: h, backup: false },
    );

    expect(r.counts).toEqual({ total: 1, accepted: 1, queued: 1, rejected: 0 });
    expect(r.queueIds).toHaveLength(1);

    const q = (
      await h.client.execute({
        sql: "SELECT review_required FROM question WHERE id = ?",
        args: [r.questionIds[0]!],
      })
    ).rows[0] as unknown as { review_required: number };
    expect(Number(q.review_required)).toBe(1);

    const wo = (
      await h.client.execute({
        sql: "SELECT kind, ref_type, ref_id, state FROM review_queue WHERE id = ?",
        args: [r.queueIds[0]!],
      })
    ).rows[0] as unknown as Record<string, string>;
    expect(wo.kind).toBe("图片");
    expect(wo.ref_type).toBe("question");
    expect(wo.ref_id).toBe(r.questionIds[0]);
    expect(wo.state).toBe("open");

    const a = (
      await h.client.execute("SELECT path, hash, kind, bytes FROM asset")
    ).rows[0] as unknown as {
      path: string;
      hash: string;
      kind: string;
      bytes: number;
    };
    expect(a.kind).toBe("png");
    expect(a.path).toBe(`${a.hash}.png`);
    expect(existsSync(join(dir, "assets", a.path))).toBe(true);

    const f = (
      await h.client.execute("SELECT role, review_state FROM question_figure")
    ).rows[0] as unknown as { role: string; review_state: string };
    expect(f.role).toBe("stem");
    expect(f.review_state).toBe("pending");

    // 对账：资产登记 ↔ 文件系统 双向核（C1c）不该红
    const report = await integrityCheck({
      handle: h,
      assetsDir: join(dir, "assets"),
    });
    expect(report.checks.filter((c) => !c.ok && c.level === "red")).toEqual([]);
  }, 60_000);
});
