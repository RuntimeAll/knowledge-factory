/**
 * REG-F 学情读侧（AI:PRD-006 · 006-B）—— 回归清单 F 组四关 + 一条红旗断言
 *
 *   F1 挂桥对数快照   三批次 matched/total 与基准快照一致；新批次只增不改旧
 *   F2 错因三形态     带码 / '[]' 未归因 / NULL 未记录，各归各位（🔴 绝不合并）
 *   F3 圣域 schema    = 对账 C4 单项（红了走**人工重新快照评估**，不是自动跟进）
 *   F4 只读物理验证   经 ro 连接尝试写 审核.db → 必失败（圣域红线的机器背书）
 *   🔴 unmapped 红旗  查不到 (考点,码) 映射的错**不静默丢**；铺上映射后它就该消失
 *
 * ── 范式（沿用 001~005） ───────────────────────────────────────────────────
 *   · 读侧断言全部打**真库 + 真圣域**且零写 —— 快照验的就是「库现在这个状态下
 *     桥搭成什么样」，拿造出来的假数据验等于验了个寂寞；
 *   · 要写的那几条（错因域原语）在 `VACUUM INTO` 出来的**副本**上跑，真库一个字节不动；
 *   · 🔴 圣域（审核.db）全程只读：文件头尾各取一次 mtime/size/sha256，
 *     整份测试跑完必须逐位相同 —— 这是「零写」这句话的机器背书，不是口号。
 *
 * 🔴 学员一律用**代号**（小崽子/洛天熙/…），真名一个字都不出现在断言里。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CauseError,
  bridgeBatches,
  bridgedItems,
  causeDistribution,
  createCoreDb,
  createErrorCause,
  fileUrlToPath,
  getCause,
  getCoreDb,
  getStudentView,
  integrityCheck,
  kpGroupErrorRate,
  listCauses,
  mapErrCode,
  mapKpError,
  studentDoneSet,
  unmapErrCode,
  upsertRoster,
  addCauseExample,
  type CoreDbHandle,
} from "~/core";

interface Fixture {
  baseline: { matched: number; total: number; coverage: string };
  matched: {
    batchId: number;
    student: string;
    day: number;
    via: string;
    taskId: number;
    line: string;
    sheet: string;
    items: number;
    score: { ok: number; wrong: number; skip: number; total: number };
  }[];
  unmatchedBatchIds: number[];
  perKp: Record<string, Record<string, number>>;
  分子: Record<string, Record<string, number[] | string>>;
  三形态: {
    coded: { batchId: number; qno: number; errorKp: string[] }[];
    unattributed: { batchId: number; qno: number }[];
    unrecordedInBridged: number;
  };
  错因映射: {
    errorCause: number;
    errCodeMap: number;
    kpError: number;
    causeExample: number;
    roster: number;
    unmappedInBridged: number;
    distMapRows: { kp: string; cause: string }[];
  };
}

const 基准: Fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "reg-f1-挂桥快照-20260813.json"),
    "utf8",
  ),
) as Fixture;

const 真库路径 = join(process.cwd(), "data", "资料库.db");
let 圣域路径 = "";
let h: CoreDbHandle; // 副本句柄（只给要写的那几条用）
let 沙盒 = "";

/** 圣域文件的指纹（零写取证） */
function 指纹(p: string) {
  const st = statSync(p);
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
  };
}
let 开跑前: ReturnType<typeof 指纹>;

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

beforeAll(async () => {
  圣域路径 = fileUrlToPath(process.env.GRADING_DB_URL ?? "");
  expect(existsSync(圣域路径), `圣域 审核.db 不在：${圣域路径}`).toBe(true);
  开跑前 = 指纹(圣域路径);

  沙盒 = join(tmpdir(), `kf-gradebridge-${process.pid}`);
  rmSync(沙盒, { recursive: true, force: true });
  mkdirSync(沙盒, { recursive: true });
  const p = join(沙盒, "资料库.db");
  const 真库 = createClient({ url: fileUrl(真库路径) });
  try {
    await 真库.execute(`VACUUM INTO '${p.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  h = await createCoreDb(fileUrl(p));
});

afterAll(() => {
  // 🔴 圣域零写的机器背书：跑完与开跑前逐位相同（含 -wal/-shm 不存在）
  const 跑完 = 指纹(圣域路径);
  expect(
    跑完.sha256,
    "🔴🔴 审核.db 内容变了 —— 圣域红线被破，立刻查是谁写的",
  ).toBe(开跑前.sha256);
  expect(跑完.size).toBe(开跑前.size);
  expect(跑完.mtimeMs).toBe(开跑前.mtimeMs);
  expect(existsSync(`${圣域路径}-wal`), "只读连接不该留下 -wal").toBe(false);
  expect(existsSync(`${圣域路径}-shm`), "只读连接不该留下 -shm").toBe(false);

  try {
    h?.close();
    if (沙盒) rmSync(沙盒, { recursive: true, force: true });
  } catch {
    /* Windows 句柄释放晚于 close()，删不掉不算失败 */
  }
});

// ---------------------------------------------------------------------------

describe("REG-F1 · 挂桥对数快照（挂上桥的批次与基准一致，新批次只增不改旧）", () => {
  it("已挂桥的批次逐项对得上基准", async () => {
    const r = await bridgeBatches();

    // 🔴 total 不钉死：批改线每天都在产生新批次。钉的是「旧的这几条结果不变」。
    expect(r.total).toBeGreaterThanOrEqual(基准.baseline.total);
    expect(r.matched).toBeGreaterThanOrEqual(基准.baseline.matched);

    for (const 期望 of 基准.matched) {
      const got = r.batches.find((b) => b.batchId === 期望.batchId);
      expect(
        got,
        `基准里的 batch ${期望.batchId} 在实况里找不到了`,
      ).toBeTruthy();
      if (!got) continue;
      expect(got.matched, `batch ${期望.batchId} 应该挂得上桥`).toBe(true);
      expect(got.student).toBe(期望.student);
      expect(got.day).toBe(期望.day);
      // 🔴 桥键 = slots(student, day) 是主路；batch 24 走的是第二条路 via='link'
      //    （006-C 人工补录，证据=题面逐位 20/20 全等）。两路都得如实标出来。
      expect(got.via).toBe(期望.via);
      expect(got.taskId).toBe(期望.taskId);
      expect(got.task?.line).toBe(期望.line);
      // 🔴 取题单认 tasks.sheet，别拿 day 拼路径（slots.day ≠ tasks.day）
      expect(got.task?.sheet).toBe(期望.sheet);
      expect(got.skuId, "挂上桥 = 一定有天卷 SKU").toBeTruthy();
    }

    // 基准里那几条未挂桥的，仍然未挂桥（补录桥补上了要主动改基准，不许悄悄绿）
    const 未挂 = new Set(r.unmatched.map((b) => b.batchId));
    for (const id of 基准.unmatchedBatchIds) {
      expect(
        未挂.has(id),
        `batch ${id} 现在挂上桥了 —— 好事，但基准快照要跟着改（说明补录了什么）`,
      ).toBe(true);
    }
    // 未挂桥的每一条都得说得出为什么（🔴 不静默丢）
    for (const b of r.unmatched) expect(b.why ?? "").not.toBe("");
  });

  it("覆盖口径 = matched/total，且与基准的 30% 对得上", async () => {
    const r = await bridgeBatches();
    // 只在「批次总数还是 10」时钉死百分比：涨了新批次这个数本来就该变
    if (r.total === 基准.baseline.total) {
      expect(r.matched).toBe(基准.baseline.matched);
      expect(r.coverage).toBe(基准.baseline.coverage);
    }
    expect(r.unmatched.length).toBe(r.total - r.matched);
  });

  it("逐题分数与已交付报告的题数口径一致（16/19 而不是 16/20）", async () => {
    const { items } = await bridgedItems();
    for (const 期望 of 基准.matched) {
      const arr = items.filter((i) => i.batchId === 期望.batchId);
      expect(arr.length, `batch ${期望.batchId} 的题数`).toBe(期望.items);
      const ok = arr.filter((i) => i.ok).length;
      const wrong = arr.filter((i) => i.wrong).length;
      const skip = arr.filter((i) => i.skipped).length;
      expect({ ok, wrong, skip, total: arr.length - skip }).toEqual(期望.score);
      // 每一题都对位到了库里的真题（ord = qno）
      for (const i of arr) expect(i.questionId).toBeTruthy();
    }
  });

  it("🔴 6-3：整式线的 perKp 落成「合并同类项 / 去括号法则」两行，不是一行 dist", async () => {
    const v = await getStudentView("洛天熙");
    const got = Object.fromEntries(v.perKp.map((r) => [r.kpName, r.total]));
    // 与已交付报告（洛天熙/报告/第02天学情分析.png）印的「合并同类项 6/6 ｜ 去括号 8/8」对上
    expect(got["合并同类项"]).toBe(基准.perKp["洛天熙"]!["合并同类项"]);
    expect(got["去括号法则"]).toBe(基准.perKp["洛天熙"]!["去括号法则"]);
    // 🔴 库侧根本不存在「运算律简算 14/14」这一行 —— 同一个 dist 码在这条线上是别的错因
    expect(got["运算律简算"]).toBeUndefined();
  });

  it("🔴 6-2 分子：种子灌入后逐批 perKp 与已交付报告一致（batchId 筛的是那一天）", async () => {
    // 🔴 学情报告一天一份。不传 batchId，小崽子的 d2 与 d4 会被并成一行 ——
    //    那不是任何一天的报告。走库出某天的报告必须按批次筛。
    const b10 = await getStudentView("小崽子", { batchId: 10 });
    const 期10 = 基准.分子["batch10_小崽子"]!;
    for (const r of b10.perKp) {
      const e = 期10[r.kpName];
      if (!Array.isArray(e)) continue;
      expect([r.ok, r.total], `batch10 ${r.kpName}`).toEqual(e);
    }
    // 分母合计 = 非 skip 题数（题数口径 16/19 的 19，不是七码轴的码次 47）
    expect(b10.perKp.reduce((s, r) => s + r.total, 0)).toBe(19);
    // 🔴 扣分只扣被真归因的那两道；q19 判×但 error_kp='[]'（拒绝归因）一个考点都不扣
    expect(
      b10.perKp
        .filter((r) => r.ok < r.total)
        .map((r) => r.kpName)
        .sort(),
    ).toEqual(["多重括号的有理数运算", "有理数乘方的运算与符号判定"].sort());

    const b14 = await getStudentView("洛天熙", { batchId: 14 });
    const 期14 = 基准.分子["batch14_洛天熙"]!;
    expect(b14.perKp.length).toBe(2);
    for (const r of b14.perKp) {
      expect([r.ok, r.total], `batch14 ${r.kpName}`).toEqual(期14[r.kpName]);
    }
    // 🔴 q1 判 √ 却带 dist 码：算对就是对，码只作诊断 —— 6/6 一分不扣
    expect(b14.perKp.every((r) => r.ok === r.total)).toBe(true);

    // 单批口径要说清楚，别被当成覆盖率
    expect(b14.coverage.total).toBe(1);
    expect(b14.warnings.join("\n")).toMatch(/单批口径/);
  });
});

describe("REG-F2 · 错因三形态各归各位（🔴 '[]' 与 NULL 绝不合并）", () => {
  it("带码 / '[]' / NULL 三形态在真库样例上分得清", async () => {
    const { items } = await bridgedItems();
    const 取 = (b: number, q: number) =>
      items.find((i) => i.batchId === b && i.qno === q);

    for (const c of 基准.三形态.coded) {
      const it = 取(c.batchId, c.qno);
      expect(it, `batch ${c.batchId} qno ${c.qno} 找不到`).toBeTruthy();
      expect(it!.causeForm).toBe("coded");
      expect(it!.errorCodes).toEqual(c.errorKp);
    }

    for (const c of 基准.三形态.unattributed) {
      const it = 取(c.batchId, c.qno);
      expect(it!.causeForm).toBe("unattributed");
      expect(it!.errorCodes).toEqual([]);
      // 🔴 它是「判×且明确拒绝归因」，不是「没归因」
      expect(it!.wrong).toBe(true);
    }

    // 三形态互斥：任何一条 item 只能是其中之一
    for (const i of items) {
      expect(["coded", "unattributed", "unrecorded"]).toContain(i.causeForm);
      if (i.causeForm === "coded")
        expect(i.errorCodes.length).toBeGreaterThan(0);
      else expect(i.errorCodes).toEqual([]);
    }
  });

  it("🔴「有码 = 错题」是错判据：判 √ 也可能带码（口径②③）", async () => {
    const { items } = await bridgedItems();
    const 抄错 = items.find((i) => i.batchId === 14 && i.qno === 1);
    expect(抄错!.ok, "batch14 q1 判的是 √（抄错题面按所抄算）").toBe(true);
    expect(抄错!.errorCodes).toEqual(["dist"]);
  });

  it("错因分布把三形态分列（不并成一个「没归因」）", async () => {
    const d = await causeDistribution();
    // 🔴🔴 只增不改旧（照本文件头 F1 的范式，2026-08-14 改）：这两个数是**活圣域**
    //    上现算的 —— 批改线随时会写进一个新批次（实测 08-14 20:40 就多了一批
    //    小崽子 day5，20 行 error_kp 全是 '[]'），拿 `toBe(基准长度)` 钉死它，
    //    等于"每批一次卷子就红一次"，红的还不是代码。
    //    「旧的没变」由上一条逐行断言把关（基准里每条的 causeForm/errorCodes/wrong
    //    都逐个对过），这里只管「没少、没被并进别的桶」。
    expect(d.unattributed.count).toBeGreaterThanOrEqual(
      基准.三形态.unattributed.length,
    );
    expect(d.unrecorded.count).toBeGreaterThanOrEqual(
      基准.三形态.unrecordedInBridged,
    );
    // 分列 = 两个独立的桶，各自带样本指得回去
    expect(d.unattributed.sample[0]).toMatchObject({ batchId: 10, qno: 19 });
    expect(d.rubric.length).toBeGreaterThan(0);
  });

  it("skip（漏抄）整条摘掉：不进分子也不进分母", async () => {
    const r = await kpGroupErrorRate();
    const { items } = await bridgedItems();
    const 非skip = items.filter((i) => !i.skipped).length;
    expect(r.sampleItems).toBe(非skip);
    // batch10 q10 是漏抄，它的 '[]' 不该被算进「拒绝归因」
    const d = await causeDistribution();
    expect(
      d.unattributed.sample.some((s) => s.batchId === 10 && s.qno === 10),
    ).toBe(false);
  });

  it("🔴 按考点过滤时三个桶一视同仁（不许「本考点归因 0、未归因 1」自相矛盾）", async () => {
    // batch10 q19 那条 '[]' 挂在混合运算线的考点上，跟整式线的「合并同类项」无关。
    // 只筛 rows 而让 unattributed 保持全局，考点页上就会印出一个别人家的数。
    const 整式 = await causeDistribution({
      kpId: "kp_01KZV2HDVDJY3KCMKTYYX43BAN", // 合并同类项
    });
    expect(整式.unattributed.count).toBe(0);
    // 🔴 006-C 灌种子后这一格已铺上映射：不再进 unmapped，而是翻译成整式侧的错因实体
    expect(整式.unmapped).toEqual([]);
    expect(整式.rows.map((r) => r.errCode)).toEqual(["dist"]);
    expect(整式.rows[0]!.causeName).toMatch(/^合并同类项错误/);

    const 混合 = await causeDistribution({
      kpId: "kp_01KZV2HDVEMPJE1PP7WBGTJWBJ", // 有理数的混合运算
    });
    expect(混合.unattributed.count).toBe(1);
    expect(混合.unattributed.sample[0]).toMatchObject({ batchId: 10, qno: 19 });
  });
});

describe("REG-F3 · 圣域 schema hash（= 对账 C4 单项）", () => {
  it("现场 schema 与契约附件快照一致；红了走人工重新快照评估", async () => {
    // 🔴 跑的是对账里的 C4 那一项本身（不另起一套判据）；metric:false = 这次对账不落打点。
    const r = await integrityCheck({ handle: h, metric: false });
    expect(r.checks.map((c) => c.id)).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6",
    ]);
    const c4 = r.checks.find((c) => c.id === "C4");
    expect(c4, "对账里没有 C4 了？").toBeTruthy();
    // 🔴 闸不许空跑：C4(a) 必须真读到了契约附件快照并算了 hash（缺文件也会红，
    //    但那时 stats 里就没有这两个键 —— 常绿的闸等于没有闸）
    expect(String(c4!.stats?.["a_快照hash"] ?? "")).not.toBe("");
    expect(Number(c4!.stats?.["a_圣域表数"] ?? 0)).toBeGreaterThan(0);
    // 独立第二证人：现场重算的 hash 与契约附件里写的那串逐字相同
    const { gradingSchemaSnapshot } = await import("~/core");
    const live = await gradingSchemaSnapshot();
    const 附件 = JSON.parse(
      readFileSync(
        join(process.cwd(), "contracts", "审核db-schema.snapshot.json"),
        "utf8",
      ),
    ) as { schemaHash: string };
    expect(live.schemaHash).toBe(附件.schemaHash);
    expect(
      c4!.ok,
      "🔴 C4 红了。若是 (a) schema hash 变了 = 批改线改了表：\n" +
        "   处置是**人工重新快照并评估**（先确认读侧 join 路径与列语义仍成立），\n" +
        "   **不是**直接重跑快照脚本把红旗按灭。明细：\n" +
        c4!.details.join("\n"),
    ).toBe(true);
  });
});

describe("REG-F4 · 只读物理验证（圣域红线的机器背书）", () => {
  it("经 ro 连接尝试 UPDATE 审核.db → 必失败，且文件一个字节不变", async () => {
    const 前 = 指纹(圣域路径);

    // ① 语句锁：core 的 GradingDbHandle 只吃 SELECT/WITH/PRAGMA，
    //    非只读语句在发到库之前就被拦下（连试都不试）。
    const { getGradingDb } = await import("~/core");
    const g = await getGradingDb();
    expect(() => g.query("UPDATE items SET note='x' WHERE 1=0")).toThrow(
      /圣域只读/,
    );
    expect(() => g.query("SELECT 1; UPDATE items SET note='x'")).toThrow(
      /一次只准一条语句/,
    );

    // ② 🔴 物理锁：绕过语句锁，直接用 node:sqlite 的 readOnly 句柄真发一条 UPDATE。
    //    这一条才是「操作系统/SQLite 自己不让写」的证明 ——
    //    语句锁是我们自己写的代码（改一行就没了），物理锁不是。
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(圣域路径, { readOnly: true });
    let 报错 = "";
    try {
      raw.prepare("UPDATE items SET note='REG-F4' WHERE batch_id=-1").run();
      throw new Error("🔴🔴 只读句柄居然写成功了 —— 圣域红线的物理防线破了");
    } catch (e) {
      报错 = e instanceof Error ? e.message : String(e);
    } finally {
      raw.close();
    }
    // 错误信息留档（SQLite 原话，换驱动/换版本时一眼看得出变没变）
    expect(报错, `实际报错：${报错}`).toMatch(/readonly|read-only|只读/i);
    expect(报错).not.toMatch(/居然写成功/);

    const 后 = 指纹(圣域路径);
    expect(后.sha256).toBe(前.sha256);
    expect(后.mtimeMs).toBe(前.mtimeMs);
  });
});

describe("🔴 unmapped 红旗 · 查不到映射的错不静默丢", () => {
  it("🔴 006-C 灌种子后：挂桥面上的码全部翻译得出，unmapped 清零", async () => {
    const d = await causeDistribution();
    expect(d.rows.length, "种子灌完了，翻译结果不该是空的").toBeGreaterThan(0);
    expect(
      d.unmapped,
      "🔴 unmapped 非空 = 有 (考点,码) 没铺映射，去看它是谁（带样本 batch/qno）",
    ).toEqual([]);
    expect(d.unmapped.length).toBe(基准.错因映射.unmappedInBridged);
    // 展开的码次 = 已翻译 + 未翻译，一个都没丢（这条恒等式与铺没铺映射无关）
    expect(d.sampleCodes).toBe(
      d.rows.reduce((s, r) => s + r.count, 0) +
        d.unmapped.reduce((s, r) => s + r.count, 0),
    );
    // 每一行都指得回 (考点, 码, 错因)
    for (const r of d.rows) {
      expect(r.kpName).not.toBe("");
      expect(r.causeName).not.toBe("");
      expect(r.count).toBeGreaterThan(0);
    }
  });

  it("🔴 红旗活性探针：摘掉一条映射，那个码当场回到 unmapped（副本上做）", async () => {
    // 🔴 「清零」本身证明不了红旗还活着 —— 一个永远返回空数组的实现也能通过上一条。
    //    所以这里主动摘掉一条真映射，看红旗亮不亮，再挂回去。
    const 前 = await causeDistribution({ handle: h });
    expect(前.unmapped).toEqual([]);
    const 目标 = 前.rows.find((r) => r.errCode === "dist")!;
    expect(目标.kpName).toBe("合并同类项");

    const 摘 = await unmapErrCode(目标.kpId, "dist", {
      handle: h,
      actor: "system",
    });
    expect(摘.errCode).toBe("dist");

    const 中 = await causeDistribution({ handle: h });
    expect(中.rows.some((r) => r.errCode === "dist")).toBe(false);
    const u = 中.unmapped.find((x) => x.errCode === "dist");
    expect(u, "🔴 摘掉映射后这个码必须进 unmapped，不许静默丢").toBeTruthy();
    expect(u!.kpName).toBe("合并同类项");
    expect(u!.sample.length).toBeGreaterThan(0); // 指得回 batch/qno
    expect(u!.sample[0]).toMatchObject({ batchId: 14, qno: 1 });
    expect(中.warnings.join("\n")).toMatch(/查不到 err_code_map 映射/);

    // 挂回去（副本用完即弃，但别给后面的用例留半截状态）
    await mapErrCode(目标.kpId, "dist", 目标.causeId, {
      by: "REG-F 探针复原",
      handle: h,
      actor: "system",
    });
    const 后 = await causeDistribution({ handle: h });
    expect(后.unmapped).toEqual([]);
  });

  it("🔴 6-3 复合键实证：同一个 dist 码落成三个错因实体（读库里的真种子）", async () => {
    // 🔴 读**真库**：这条验的是 006-C 灌进去的种子本身（含 mapped_by='human' 的落款），
    //    不是副本上被前一条探针动过的状态。
    const 真 = await getCoreDb();
    const r = await 真.client.execute(
      `SELECT k.name AS kp_name, c.id AS cause_id, c.name AS cause_name, c.seed_code, m.mapped_by
         FROM err_code_map m
         JOIN kp k ON k.id = m.kp_id
         JOIN error_cause c ON c.id = m.cause_id
        WHERE m.err_code = 'dist'
        ORDER BY k.name`,
    );
    const rows = r.rows as unknown as Record<string, string>[];
    // 基准里逐条列了哪个考点落哪个错因
    expect(rows.length).toBe(基准.错因映射.distMapRows.length);
    for (const e of 基准.错因映射.distMapRows) {
      const got = rows.find((x) => x.kp_name === e.kp);
      expect(got, `dist @ ${e.kp} 的映射不见了`).toBeTruthy();
      expect(got!.cause_name).toBe(e.cause);
      expect(got!.mapped_by).toBe("human"); // 🔴 人工整理的种子，落款是人
      expect(got!.seed_code).toMatch(/^err_kp:v1\.0\.0\/dist/);
    }
    // 🔴 复合键的全部意义：同一个码，不同考点 → 不同实体（≥2 个）
    expect(new Set(rows.map((x) => x.cause_id)).size).toBeGreaterThanOrEqual(2);
    // 整式侧与混合侧确实是两个不同的实体
    const 整 = rows.find((x) => x.kp_name === "合并同类项")!;
    const 混 = rows.find((x) => x.kp_name === "有理数运算的简便技巧")!;
    expect(整.cause_id).not.toBe(混.cause_id);

    // 落到真数据上：batch14 q1 的 dist 走的是整式侧那个实体
    const d = await causeDistribution({ batchId: 14 });
    const row = d.rows.find((x) => x.errCode === "dist");
    expect(row?.causeId).toBe(整.cause_id);
    expect(row?.kpName).toBe("合并同类项");
    expect(row?.count).toBe(1);
    // 🔴 绝不是「运算律简算」
    expect(row?.causeName).not.toMatch(/运算律简算/);
  });

  it("同键重复映射 → 显式报错带现值，改判走先 unmap", async () => {
    const 别的 = await createErrorCause({
      name: "去括号：括号前是负号时每一项都要变号（REG-F 夹具）",
      handle: h,
      actor: "system",
    });
    await expect(
      mapErrCode("合并同类项", "dist", 别的.causeId, { handle: h }),
    ).rejects.toThrow(/已经映射到错因/);
    try {
      await mapErrCode("合并同类项", "dist", 别的.causeId, { handle: h });
    } catch (e) {
      expect(e).toBeInstanceOf(CauseError);
      expect((e as CauseError).code).toBe("MAP_TAKEN");
      // 现值写在 message 里：谁定的、映射到了谁
      expect((e as CauseError).message).toMatch(/合并同类项错误/);
    }
    // 先摘后挂才是改判的路
    const 摘 = await unmapErrCode("合并同类项", "dist", { handle: h });
    expect(摘.errCode).toBe("dist");
    const 重挂 = await mapErrCode("合并同类项", "dist", 别的.causeId, {
      handle: h,
    });
    expect(重挂.causeId).toBe(别的.causeId);
  });
});

describe("错因域原语（写侧，跑在副本上）", () => {
  it("kp_error 挂载 + cause_example 软闸（提示不硬拦）", async () => {
    const c = await createErrorCause({
      name: "乘方符号：(-a)^n 与 -a^n 分不清",
      desc: "底数带不带括号、指数奇偶，决定结果的正负",
      seedCode: "err_kp:v1.0.0/pow",
      handle: h,
      actor: "system",
    });
    const m = await mapKpError("有理数乘方的运算与符号判定", c.causeId, {
      handle: h,
      actor: "system",
    });
    expect(m.causeId).toBe(c.causeId);

    // 拿库里真的题当例题（🔴 不编 id）
    const 题 = await h.client.execute(
      "SELECT question_id FROM sku_item WHERE sku_id=(SELECT sku_id FROM grading_task_map WHERE task_id=1) ORDER BY ord LIMIT 2",
    );
    const qids = (题.rows as unknown as { question_id: string }[]).map(
      (r) => r.question_id,
    );
    expect(qids.length).toBe(2);

    const e1 = await addCauseExample(c.causeId, qids[0]!, { handle: h });
    // 🔴 软闸：只有一道例题时给提示，但**没有拦**（挂成功了）
    expect(e1.exampleCount).toBe(1);
    expect(e1.warnings.join()).toMatch(/只有 1 道例题/);

    const e2 = await addCauseExample(c.causeId, qids[1]!, { handle: h });
    expect(e2.exampleCount).toBe(2);
    expect(e2.warnings).toEqual([]); // 够两道了，闸不响

    const card = await getCause(c.causeId, { handle: h });
    expect(card.examples.length).toBe(2);
    expect(card.kps.map((x) => x.name)).toContain("有理数乘方的运算与符号判定");
    expect(card.warnings).toEqual([]);

    const list = await listCauses({ handle: h, status: "active" });
    expect(list.find((x) => x.causeId === c.causeId)?.counts.examples).toBe(2);
  });

  it("编造的考点 / 编造的题 一律拒（带候选自愈）", async () => {
    const c = await createErrorCause({
      name: "测试用错因",
      handle: h,
      actor: "system",
    });
    await expect(
      mapKpError("这个考点根本不存在啊啊啊", c.causeId, { handle: h }),
    ).rejects.toThrow(CauseError);
    await expect(
      addCauseExample(c.causeId, "q_01BOGUSBOGUSBOGUSBOGUSBOGU", { handle: h }),
    ).rejects.toThrow(/查无此行/);
  });

  it("🔴 roster 只落代号：与圣域 batches.student 同口径，桥才对得上", async () => {
    // 🔴 006-C 已把四个真代号灌进 roster，所以「小崽子」这条是**更新**不是新建。
    //    新建路径拿一个不存在的代号验（别为了让 created=true 去改种子）。
    const 新 = await upsertRoster({
      code: "REG-F 夹具代号",
      grade: "七年级",
      handle: h,
      actor: "system",
    });
    expect(新.created).toBe(true);
    expect(新.status).toBe("active");

    const r = await upsertRoster({
      code: "小崽子",
      grade: "七年级",
      editionCtx: "人教七上",
      note: "REG-F 夹具",
      handle: h,
      actor: "system",
    });
    expect(r.created, "种子已灌，这里必须走更新分支").toBe(false);
    expect(r.status).toBe("active");

    // 幂等：再来一次是更新，不是重建
    const r2 = await upsertRoster({
      code: "小崽子",
      status: "paused",
      handle: h,
      actor: "system",
    });
    expect(r2.created).toBe(false);
    expect(r2.status).toBe("paused");
    expect(r2.grade, "没传的字段保留原值").toBe("七年级");

    const v = await getStudentView("小崽子", { handle: h });
    expect(v.roster?.code).toBe("小崽子");
    expect(v.roster?.editionCtx).toBe("人教七上");
    // 数据包里出现的一律是代号
    expect(JSON.stringify(v.batches)).not.toMatch(/真名/);
  });

  it("🔴 006-C 种子：四个学员代号都在名册上，且一个真名都没有", async () => {
    const rows = await h.client.execute(
      "SELECT code, grade, edition_ctx, status, note FROM roster ORDER BY code",
    );
    const 名册 = rows.rows as unknown as Record<string, string>[];
    const codes = 名册.map((r) => r.code);
    for (const c of ["recho", "小崽子", "洛天熙", "鼻涕虫"])
      expect(codes, `名册里缺 ${c}`).toContain(c);
    const 种子 = 名册.filter((r) => r.code !== "REG-F 夹具代号");
    expect(种子.length).toBeGreaterThanOrEqual(基准.错因映射.roster);
    // 🔴 代号必须与圣域 batches.student 完全一致，写成真名桥当场断
    const 桥 = await bridgeBatches();
    const 圣域代号 = new Set(桥.batches.map((b) => b.student));
    for (const c of ["小崽子", "洛天熙", "鼻涕虫", "recho"])
      expect(圣域代号.has(c), `圣域里没有代号 ${c}`).toBe(true);
  });
});

describe("读侧视图的诚实形态", () => {
  it("学生已做题集可直接喂 excludeQuestionIds，且覆盖不全时明说", async () => {
    const s = await studentDoneSet("小崽子");
    expect(s.questionIds.length).toBeGreaterThan(0);
    expect(new Set(s.questionIds).size).toBe(s.questionIds.length); // 去重过
    // 🔴 三个批次没挂上桥 = 这个集合是偏小的，必须说出来
    expect(s.coverage.matched).toBeLessThan(s.coverage.total);
    expect(s.warnings.join("\n")).toMatch(/没挂上桥/);
  });

  it("群错误率必带覆盖口径 + 未挂桥明细", async () => {
    const r = await kpGroupErrorRate();
    expect(r.coverage.total).toBeGreaterThan(0);
    expect(r.coverage.unmatched.length).toBe(
      r.coverage.total - r.coverage.matched,
    );
    for (const u of r.coverage.unmatched) expect(u.why ?? "").not.toBe("");
    // 口径注释跟着数走（页面/工具原样显示）
    expect(r.rubric.join("\n")).toMatch(/空题算失分/);
    expect(r.rubric.join("\n")).toMatch(/订正对了算对/);
    for (const row of r.rows) {
      expect(row.total).toBeGreaterThan(0);
      expect(row.wrong).toBeLessThanOrEqual(row.total);
      expect(row.students).toBeGreaterThan(0);
    }
  });

  it("未挂桥的批次在 student_view 里如实列出（分数照给，只是算不到考点上）", async () => {
    const v = await getStudentView("小崽子");
    const 未挂 = v.batches.filter((b) => !b.matched);
    expect(未挂.length).toBeGreaterThan(0);
    for (const b of 未挂) {
      expect(b.why ?? "").not.toBe("");
      expect(b.score, "没挂桥不等于没分数").toBeTruthy();
      expect(b.taskId).toBeNull();
    }
    // L1 静默放行的批次带 auto 标记（08-13 新列，读侧认它）
    expect(v.batches.some((b) => b.auto === "L1静默")).toBe(true);
  });

  it("按线过滤会滤掉未挂桥批次 —— 覆盖口径会失真，必须警告", async () => {
    const r = await kpGroupErrorRate({ line: "整式的加减" });
    expect(r.coverage.total).toBe(1); // 只剩 batch 14
    expect(r.warnings.join("\n")).toMatch(/未挂桥/);
  });
});
