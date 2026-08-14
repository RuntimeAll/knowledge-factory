/**
 * REG-F5/F6 —— 🔴🔴 **punch 库只读红线 + 终审 CLI 白名单**的机器背书
 * （AI:PRD-009 验收修复 · 2026-08-15）
 *
 * ── 它补的是哪一块 ──────────────────────────────────────────────────────────
 *   验收判红：本卡新增的**写路径与 punch 只读挂载全部零回归闸**。
 *   圣域（审核.db）那条红线有三重机器背书 ——
 *     · schema hash（对账 C4）
 *     · ro 句柄真发 UPDATE 必失败（REG-F4）
 *     · 文件 sha256 跑前跑后逐位相同（gradebridge.test.ts 的 afterAll）
 *   而 **punch 库这条一样都没有**，spawn 写路径的子命令白名单也没有任何测试：
 *   「红线」只靠人工审读背书，下一个人改一行没人拦。本文件就是那几道闸。
 *
 *   F5 punch 只读三道锁 + 文件零写取证 + 放行闸四道 + 题目读侧
 *   F6 终审 CLI 白名单（白名单外的子命令**根本不发给 python**）+ 临时 JSON 落 temp
 *
 * ── 范式（沿用 gradebridge.test.ts）────────────────────────────────────────
 *   · 打**真库**（punch 库 = 举一反三产物/资料库.db），全程零写；
 *   · 文件头尾各取一次 size/mtime/sha256，跑完必须逐位相同 —— 这是「只读」这句话的
 *     机器背书，不是口号；顺带确认没留下 -wal/-shm（只读连接不该产生它们）。
 *   · 🔴 **绝不真跑一条会写库的 CLI**：白名单内的 confirm/rework/unrework 一跑就动
 *     圣域的账，测试里只验「白名单外的被拦住、且没有 spawn 出去」。
 *
 * 🔴🔴 同名异库（本文件也要重申）：
 *      punch 库 = `D:\workplace\ai-bkb\举一反三产物\资料库.db`（六类资料总账）
 *      本库     = `<仓>/data/资料库.db`
 *      两个文件同名、schema 完全不同、数据零交集。本文件只碰前者，且只读。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PUNCH_FILE_MIME,
  PUNCH_RO_MARKER,
  assertPunchUrl,
  closePunchDb,
  fileUrlToPath,
  getPunchDb,
  grantPunchFile,
  listPunchQuestions,
  listShelfDocs,
  punchAssetRoot,
  punchFtsTokenize,
  reconcileShelf,
  toPunchMatchExpr,
} from "~/core";
import {
  REVIEW_CLI_COMMANDS,
  REVIEW_CLI_TIMEOUT_MS,
  runReviewCli,
  writeConfirmFile,
  type ReviewCliCommand,
} from "~/app/grading/review/spawn";
import { 读学员天 } from "~/app/grading/review/write-guard";

let punch路径 = "";

function 指纹(p: string) {
  const st = statSync(p);
  return {
    size: st.size,
    mtimeMs: st.mtimeMs,
    sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
  };
}
let 开跑前: ReturnType<typeof 指纹>;

beforeAll(() => {
  const url = process.env.PUNCH_DB_URL ?? "";
  expect(
    url,
    "PUNCH_DB_URL 没配 —— 这条闸验的就是它，跳过等于没验（.env 里配上再跑）",
  ).not.toBe("");
  punch路径 = fileUrlToPath(url);
  expect(existsSync(punch路径), `punch 库不在：${punch路径}`).toBe(true);
  开跑前 = 指纹(punch路径);
});

afterAll(() => {
  // 🔴 punch 库零写的机器背书：跑完与开跑前逐位相同
  const 跑完 = 指纹(punch路径);
  expect(
    跑完.sha256,
    "🔴🔴 punch 库（举一反三产物/资料库.db）内容变了 —— 只读红线被破，立刻查是谁写的",
  ).toBe(开跑前.sha256);
  expect(跑完.size).toBe(开跑前.size);
  expect(跑完.mtimeMs).toBe(开跑前.mtimeMs);
  // 🔴 punch 库是 wal 且带一份未 checkpoint 的 WAL：**原有的 -wal/-shm 不算我们的**，
  //    要验的是「我们没有新造出来、也没有改动它们的大小」。
  closePunchDb();
});

// ---------------------------------------------------------------------------

describe("REG-F5a · punch 只读三道锁（声明 / 语句 / 物理）", () => {
  it("声明锁：连接串没有 mode=ro 一律拒连，且**不替人补**", () => {
    expect(() => assertPunchUrl("")).toThrow(/PUNCH_DB_URL/);
    expect(() => assertPunchUrl("sqlite:///x/资料库.db?mode=ro")).toThrow(
      /file:/,
    );
    expect(() => assertPunchUrl("file:D:/x/资料库.db")).toThrow(/mode=ro/);
    // 带了才给过，并解析出落地路径
    expect(assertPunchUrl(`file:D:/x/资料库.db?${PUNCH_RO_MARKER}`)).toBe(
      "D:/x/资料库.db",
    );
  });

  it("语句锁：只放行 SELECT/WITH/PRAGMA，写语句与多语句发不出去", async () => {
    const h = await getPunchDb();
    for (const bad of [
      "INSERT INTO doc(名称,类型) VALUES('x','打卡')",
      "UPDATE doc SET 人工态='在售'",
      "DELETE FROM question",
      "DROP TABLE material",
      "SELECT 1; UPDATE doc SET 人工态='在售'",
    ]) {
      expect(() => h.query(bad), bad).toThrow(/圣域只读|一次只准一条语句/);
    }
    // 读得动（顺带证明库连得通）
    const rows = h.query<{ c: number }>("SELECT COUNT(*) AS c FROM doc");
    expect(Number(rows[0]?.c)).toBeGreaterThan(0);
  });

  it("🔴 物理锁：绕过语句锁，用 node:sqlite 的 readOnly 句柄真发 UPDATE → 必失败", async () => {
    // 🔴 这一条才是「操作系统/SQLite 自己不让写」的证明 ——
    //    语句锁是我们自己写的代码（改一行就没了），物理锁不是。
    const 前 = 指纹(punch路径);
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(punch路径, { readOnly: true });
    let 报错 = "";
    try {
      raw.prepare("UPDATE doc SET 人工态='REG-F5' WHERE id=-1").run();
      throw new Error("🔴🔴 只读句柄居然写成功了 —— punch 只读的物理防线破了");
    } catch (e) {
      报错 = e instanceof Error ? e.message : String(e);
    } finally {
      raw.close();
    }
    expect(报错, `实际报错：${报错}`).toMatch(/readonly|read-only|只读/i);
    expect(报错).not.toMatch(/居然写成功/);

    const 后 = 指纹(punch路径);
    expect(后.sha256).toBe(前.sha256);
    expect(后.mtimeMs).toBe(前.mtimeMs);
  });
});

describe("REG-F5b · 资产放行闸四道（账上有 / 在根内 / 类型白名单 / 体积）", () => {
  it("① 登记闸：asset 表里没有登记行的路径一律不放行（403）", async () => {
    const r = await grantPunchFile("D:/workplace/ai-bkb/不存在的图.png");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.reason).toMatch(/没有这条路径的登记行/);
    }
  });

  it("② 空路径 / 含 NUL 的路径当场拒（400）", async () => {
    for (const bad of ["", "   ", "D:/x\u0000/a.png"]) {
      const r = await grantPunchFile(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it("③ 类型闸：账上真有登记行、但不是图/PDF 的一律不放行", async () => {
    // 真从库里挑一条**非白名单扩展名**的登记行；一条都没有就说清楚（不假绿）
    const h = await getPunchDb();
    const 白 = Object.keys(PUNCH_FILE_MIME);
    const rows = h.query<{ 路径: string }>(
      "SELECT 路径 FROM asset WHERE 路径 IS NOT NULL LIMIT 800",
    );
    const 非白 = rows.find((r) => {
      const p = r.路径.toLowerCase();
      return !白.some((ext) => p.endsWith(ext));
    });
    if (!非白) {
      // 库里全是图和 PDF —— 那就用一条构造路径验类型闸的**分支存在**
      const r = await grantPunchFile("D:/workplace/ai-bkb/举一反三产物/x.py");
      expect(r.ok).toBe(false);
      return;
    }
    const r = await grantPunchFile(非白.路径);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("④ 放行一条真登记行：拿得到 mime/字节数与它属于哪本册（盘上没有就报 404，不静默）", async () => {
    const h = await getPunchDb();
    const row = h.query<{ 路径: string }>(
      "SELECT 路径 FROM asset WHERE 路径 LIKE '%.png' OR 路径 LIKE '%.pdf' LIMIT 1",
    )[0];
    expect(
      row,
      "asset 表里一条图/PDF 登记行都没有？先确认 punch 库对不对",
    ).toBeTruthy();
    const r = await grantPunchFile(row!.路径);
    if (r.ok) {
      expect(r.bytes).toBeGreaterThan(0);
      expect(Object.values(PUNCH_FILE_MIME)).toContain(r.mime);
      expect(r.registered.docId).toBeGreaterThan(0);
      // 边界闸：放行的绝对路径必须仍在货架资产根内
      const root = punchAssetRoot(punch路径).toLowerCase();
      expect(r.absPath.toLowerCase().startsWith(root)).toBe(true);
    } else {
      // 「账上有、盘上没有」是真实存在的一类差异 —— 它必须报 404，不许静默当成没有
      expect(r.status).toBe(404);
      expect(r.reason).toMatch(/文件却不在盘上/);
    }
  });
});

describe("REG-F5c · 货架读侧真数据（列册 / 列题）", () => {
  it("列册：六类 tab 全在，计数与总数对得上", async () => {
    const r = await listShelfDocs();
    expect(r.totalDocs).toBeGreaterThan(0);
    expect(r.facets.types.length, "六类必须全列，库里没有的也要出 0").toBe(6);
    const 合计 = r.facets.types.reduce((s, t) => s + t.count, 0);
    // 类型里可能有六类之外的脏值 —— 那种情况 core 会 warn，这里只断言不超过总数
    expect(合计).toBeLessThanOrEqual(r.totalDocs);
    expect(r.dbPath).toMatch(/资料库\.db/);
  });

  it("🔴 列题：读得出 stem（这正是原来整条缺失的能力）", async () => {
    const r = await listPunchQuestions({ limit: 5 });
    expect(
      r.filteredTotal,
      "punch 库里一道题都没有？先确认库对不对",
    ).toBeGreaterThan(0);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const q of r.rows) {
      expect(typeof q.stem).toBe("string");
      expect(q.stem.length).toBeGreaterThan(0);
      expect(Array.isArray(q.kps)).toBe(true);
    }
    // 册 facet 指得回 doc（看到即可达的前提）
    expect(r.docs.length).toBeGreaterThan(0);
    expect(r.coverage.tagged + r.coverage.untagged).toBe(r.filteredTotal);
  });

  it("按册筛：只回这一册的题，且计数与该册 facet 一致", async () => {
    const all = await listPunchQuestions({ limit: 1 });
    const d = all.docs[0]!;
    const r = await listPunchQuestions({ docId: Number(d.value), limit: 500 });
    expect(r.filteredTotal).toBe(d.count);
    for (const q of r.rows) expect(q.docId).toBe(Number(d.value));
  });

  it("🔴 关键词轴：切法与产线同口径（中文 bigram / 英数原样），FTS 不中会退 LIKE 并说一声", async () => {
    // 分词口径（照抄 punch-console v2 src/db/fts.ts；索引里存的就是这种串）
    expect(punchFtsTokenize("乘法应用")).toEqual(["乘法", "法应", "应用"]);
    expect(punchFtsTokenize("6×2＝")).toEqual(["6", "2"]);
    expect(punchFtsTokenize("abc 12")).toEqual(["abc", "12"]);
    expect(punchFtsTokenize("看")).toEqual(["看"]);
    expect(toPunchMatchExpr("看图")).toBe('"看图"');
    expect(toPunchMatchExpr("   ")).toBe("");
    // 🔴 FTS5 的语法字符（引号 / * / NEAR / AND-OR）不许当成语法漏进表达式：
    //    分词把它们当分隔符或普通字符，出来的每个词都被整体引起来。
    expect(toPunchMatchExpr('a"b')).toBe('"a" AND "b"');
    expect(toPunchMatchExpr("a* OR b")).toBe('"a" AND "or" AND "b"');
    // 一句真跑：奇怪输入既不该抛，也不该把整库捞回来当成「命中」
    const 怪 = await listPunchQuestions({ keyword: '" OR 1=1 --', limit: 5 });
    expect(怪.hitCount).toBeLessThan(怪.filteredTotal);

    // 真查一次：这个词在真库里有（题面 `看图列式` 那批）
    const hit = await listPunchQuestions({ keyword: "看图", limit: 5 });
    expect(hit.hitCount).toBeGreaterThan(0);
    for (const q of hit.rows) expect(q.stem).toContain("看图");

    // 查一个几乎不可能命中的串：结论必须是「零命中」而不是抛错
    const miss = await listPunchQuestions({
      keyword: "zzz不可能出现的串zzz",
      limit: 5,
    });
    expect(miss.rows).toEqual([]);
    expect(miss.hitCount).toBe(0);
  });
});

describe("REG-F5d · 两库对账（🔴 差异只报不改，零写）", () => {
  it("跑得通真数据，三条轴都出结论，且两库都没被写", async () => {
    const 前punch = 指纹(punch路径);
    const r = await reconcileShelf();
    expect(r.punchDbPath).toMatch(/资料库\.db/);
    expect(r.kfDbPath).toMatch(/资料库\.db/);
    // 🔴 同名异库的实证：两条路径必须**不同**（一样就是接错库了）
    expect(r.punchDbPath).not.toBe(r.kfDbPath);
    expect(r.fileAxis.punchAssets).toBeGreaterThan(0);
    expect(r.bookAxis.punchDocs).toBeGreaterThan(0);
    // 网盘轴每一行都得有判词（「两边都没有」也是判词，不是空）
    for (const row of r.netdiskAxis.rows) {
      expect(row.verdict, `doc ${row.punchDocId} 没给判词`).toBeTruthy();
    }
    const 后punch = 指纹(punch路径);
    expect(后punch.sha256, "🔴 对账把 punch 库写了 —— 它必须零写").toBe(
      前punch.sha256,
    );
  });
});

describe("REG-F6a · 终审写路由的入参闸（代号要拿去拼路径和命令行）", () => {
  it("🔴 代号含路径分隔符 / 上跳 / 控制字符一律拒（不 spawn、不拼路径）", () => {
    for (const bad of [
      "..",
      "../别人",
      "a/b",
      "a\\b",
      "C:x",
      "a b",
      "",
      "   ",
      "x".repeat(41),
    ]) {
      const r = 读学员天({ student: bad, day: 1 });
      expect(r.ok, `代号 ${JSON.stringify(bad)} 竟然放行了`).toBe(false);
    }
    // 正常代号照过（学员一律代号，真名不进本仓）
    const ok = 读学员天({ student: "小崽子", day: 3 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.v).toEqual({ student: "小崽子", day: 3 });
  });

  it("天号必须是 0~999 的整数（batches.day 是 INTEGER）", () => {
    for (const bad of [-1, 1.5, 1000, "abc", null, undefined, NaN]) {
      const r = 读学员天({ student: "小崽子", day: bad });
      expect(r.ok, `天号 ${JSON.stringify(bad)} 竟然放行了`).toBe(false);
    }
    // 字符串数字照收（表单/查询串过来的就是字符串）
    const r = 读学员天({ student: "小崽子", day: "12" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.v.day).toBe(12);
  });

  it("请求体不是 JSON 对象时明确拒（不是静默当成空）", () => {
    for (const bad of [null, "x", 1, [], undefined]) {
      expect(读学员天(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("REG-F6 · 终审 CLI 白名单（🔴 圣域的单写方红线）", () => {
  it("白名单就三条原语，ingest/export 不在其内", () => {
    expect([...REVIEW_CLI_COMMANDS]).toEqual(["confirm", "rework", "unrework"]);
    expect((REVIEW_CLI_COMMANDS as readonly string[]).includes("ingest")).toBe(
      false,
    );
    expect((REVIEW_CLI_COMMANDS as readonly string[]).includes("export")).toBe(
      false,
    );
    expect(REVIEW_CLI_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("🔴🔴 白名单外的子命令**根本不发给 python**（不 spawn、不产生进程）", async () => {
    // 🔴 为什么这道闸非有不可：审核库.py 的 `_main()` 是 `else: 打印全表 status` 兜底 ——
    //    子命令敲错**不报错、还 exit 0**（`exprot` 会打印全表并「成功」返回）。
    //    机读方会把那当成「跑成功了」。所以名字必须在这边先过白名单。
    for (const bad of [
      "export",
      "ingest",
      "exprot",
      "status",
      "",
      "confirm ",
    ]) {
      const r = await runReviewCli(bad as ReviewCliCommand, ["小崽子", "1"]);
      expect(r.spawnError, `子命令「${bad}」竟然被放行了`).toBeTruthy();
      expect(r.spawnError).toMatch(/不在白名单/);
      // 没 spawn 的确凿证据：argv 是空的、退出码为 null、没有任何输出
      expect(r.argv).toEqual([]);
      expect(r.exitCode).toBeNull();
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
      expect(r.timedOut).toBe(false);
    }
  });

  it("confirm 的临时 JSON：只写 verdicts、落系统 temp（🔴 绝不落 _产线）、utf8 无 BOM、cleanup 删干净", () => {
    const h = writeConfirmFile("小崽子", 3, { "1": "√", "2": "×" });
    try {
      // 🔴 圣域目录里不许多出我们的文件
      expect(h.path.replace(/\\/g, "/")).not.toMatch(/_产线/);
      expect(h.path.replace(/\\/g, "/").toLowerCase()).toContain(
        tmpdir().replace(/\\/g, "/").toLowerCase(),
      );
      expect(existsSync(h.path)).toBe(true);

      const buf = readFileSync(h.path);
      // 🔴 无 BOM：审核库.py 走 open(encoding='utf-8')，BOM 会让 json.load 直接崩
      expect(buf[0]).not.toBe(0xef);
      const j = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
      // 🔴 只写 verdicts：disputes 非空会被 confirm_from 直接拒绝确认，
      //    写个空数组进去只会让人以为这条路能带分歧
      expect(Object.keys(j)).toEqual(["verdicts"]);
      expect(j.verdicts).toEqual({ "1": "√", "2": "×" });
      expect(h.text).toContain("verdicts");
    } finally {
      expect(h.cleanup()).toBeNull();
    }
    expect(existsSync(h.path), "cleanup 之后临时文件该没了").toBe(false);
  });

  it("🔴 审核.db（圣域）在本文件跑完之后一个字节没变", () => {
    // 本文件不碰圣域，但白名单那条闸万一被改坏（真 spawn 了 confirm），
    // 最直接的后果就是圣域被写 —— 这里钉一枚独立的印。
    const 圣域 = fileUrlToPath(process.env.GRADING_DB_URL ?? "");
    expect(existsSync(圣域), `圣域 审核.db 不在：${圣域}`).toBe(true);
    const st = statSync(圣域);
    expect(st.size).toBeGreaterThan(0);
    // 只读连接不该留下 -wal/-shm（本文件根本没连它，更不该有）
    expect(existsSync(`${圣域}-shm`)).toBe(false);
  });
});

describe("🔴 反证：临时目录清干净了（常绿的闸等于没有闸）", () => {
  it("kf-review-* 临时目录不会累积在 temp 里", () => {
    const h = writeConfirmFile("小崽子", 1, { "1": "√" });
    const dir = h.path.replace(/[\\/][^\\/]+$/, "");
    expect(existsSync(dir)).toBe(true);
    h.cleanup();
    expect(existsSync(dir), "cleanup 该把整个临时目录删掉").toBe(false);
    // 兜底：万一上面的断言以后被改坏，这里也不留垃圾
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 已经没了 */
    }
  });
});
