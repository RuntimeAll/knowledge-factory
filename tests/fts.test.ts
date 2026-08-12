/**
 * question_fts 方案甲闸（AI:PRD-003 · 003-B）
 *
 * 沿用既有范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**
 * （audit_log 是 append-only，往真库插一行就再也拿不出来）。
 *
 * 只钉四件必须永远成立的事：
 *   ① 写侧预分词串 MATCH 得中 —— 而**同一段文本不分词直接塞进去就 MATCH 不中**。
 *      这条对照不是凑数：它就是方案甲存在的全部理由（unicode61 不切中文，
 *      「静默查不全」是最坏的一类故障）。
 *   ② writeQuestionFts 幂等：改题重写一次，索引里只剩新的那行；
 *   ③ 题删了 FTS 行跟着走（0004 保留的 DELETE 兜底触发器）；
 *   ④ ftsQuery 出的 MATCH 串是转义过的、语义只有一种读法的（MATCH 永不拼串）。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCoreDb,
  ftsQuery,
  ftsStringLiteral,
  newId,
  nowLocalISO,
  segmentTexts,
  withCoreWrite,
  writeQuestionFts,
  type CoreDbHandle,
} from "~/core";
import { question } from "~/server/db/schema";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-fts-${process.pid}-${tag}.db`);
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

/** 造一道最小合法题（prov_type=manual ⇒ created_by 必填，见建表 CHECK） */
function 题行(id: string, stem: string, stemPlain: string) {
  return {
    id,
    stem,
    stemPlain,
    status: "pending",
    solutionGrade: "analysis_only",
    provType: "manual",
    createdBy: "fts-test",
    createdAt: nowLocalISO(),
  };
}

/** 一次 core 写：插题 + 写它的 FTS 投影（这就是 003-C 管道里该有的样子） */
async function 落一道题(
  h: CoreDbHandle,
  row: ReturnType<typeof 题行>,
  fts: { stemPlain: string; answerSeg?: string },
): Promise<void> {
  await withCoreWrite(
    { actor: "system", tool: "fts.test.落一道题", args: { id: row.id } },
    async (tx) => {
      await tx.insert(question).values(row);
      await writeQuestionFts(tx, {
        questionId: row.id,
        stemPlain: fts.stemPlain,
        ...(fts.answerSeg !== undefined ? { answerSeg: fts.answerSeg } : {}),
      });
      return [{ table: "question", id: row.id, op: "insert" as const }];
    },
    h,
  );
}

async function 命中(h: CoreDbHandle, match: string): Promise<string[]> {
  const r = await h.client.execute({
    sql: "SELECT question_id AS qid FROM question_fts WHERE question_fts MATCH ? ORDER BY question_id",
    args: [match],
  });
  return (r.rows as unknown as { qid: string }[]).map((x) => x.qid);
}

const 题面 = "已知方程 $x^2-5x+6=0$，求它的两个根";

beforeAll(() => {
  expect(
    existsSync(真库路径),
    `真库不存在：${真库路径}（先跑 pnpm db:migrate）`,
  ).toBe(true);
});

afterAll(() => {
  for (const h of 句柄清单) h.close();
  for (const base of 副本清单) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = base + suffix;
      try {
        if (existsSync(p)) rmSync(p, { force: true });
      } catch {
        /* Windows 句柄释放晚于 close()，删不掉只是留个临时文件，不算失败 */
      }
    }
  }
});

describe("① 预分词才查得动（方案甲的全部理由）", () => {
  it("分词串 MATCH 得中；同一段文本不分词就 MATCH 不中", async () => {
    const h = await 造副本("hit");
    const 好 = newId("q");
    const 坏 = newId("q");

    const [seg] = await segmentTexts([{ id: "s", text: 题面 }]);
    const 分词串 = seg?.segmented ?? "";
    expect(分词串.split(" ")).toContain("方程"); // 前提：jieba 真切开了

    // 正路：core 写侧灌预分词串
    await 落一道题(h, 题行(好, 题面, 分词串), { stemPlain: 分词串 });
    // 对照：同一道题，塞未分词的整段中文（= 0001 那三只触发器干的事）
    await 落一道题(h, 题行(坏, 题面, 题面), {
      stemPlain: "已知方程x2-5x+6=0，求它的两个根",
    });

    const plan = await ftsQuery("方程");
    expect(plan.match).toBe('"方程"');

    const hits = await 命中(h, plan.match!);
    expect(hits).toContain(好);
    // 🔴 反证：unicode61 把整段中文当一个 token，「方程」这个词根本切不出来 ⇒ 查不全
    expect(hits).not.toContain(坏);

    // 两行都在索引里（对照行不是没写进去，是写进去了查不着——这才叫静默失效）
    const 全 = await h.client.execute("SELECT COUNT(*) AS c FROM question_fts");
    expect(Number((全.rows[0] as unknown as { c: number }).c)).toBe(2);
  });

  it("answer 的分词串也进索引（不回写正本列）", async () => {
    const h = await 造副本("answer");
    const id = newId("q");
    const [seg, ans] = await segmentTexts([
      { id: "a", text: 题面 },
      { id: "b", text: "因式分解得两个根" },
    ]);
    await 落一道题(h, 题行(id, 题面, seg?.segmented ?? ""), {
      stemPlain: seg?.segmented ?? "",
      answerSeg: ans?.segmented ?? "",
    });

    // 🔴 查侧用整词「因式分解」而不是「因式」：jieba 的切法**看上下文**——
    //    「因式分解得两个根」切出 因式分解，而单独一个「因式」会被切成 因/式，
    //    于是 MATCH '"因"' AND '"式"' 命中不了。这是 exact 模式的固有口径
    //    （与长词那条同源），004 定检索召回策略时要一起处理。
    const plan = await ftsQuery("因式分解");
    expect(await 命中(h, plan.match!)).toEqual([id]);

    // 正本列没被污染：answer 该是 NULL（我们压根没写它）
    const r = await h.client.execute({
      sql: "SELECT answer FROM question WHERE id = ?",
      args: [id],
    });
    expect((r.rows[0] as unknown as { answer: string | null }).answer).toBe(
      null,
    );
  });
});

describe("② 幂等与兜底", () => {
  it("重写一次只剩新行；题删了索引行跟着走", async () => {
    const h = await 造副本("life");
    const id = newId("q");
    await 落一道题(h, 题行(id, 题面, "旧 词 串"), { stemPlain: "旧 词 串" });

    // 改题重写（003-C 的「改了题面重建索引」走的就是同一个调用）
    await withCoreWrite(
      { actor: "system", tool: "fts.test.重写", args: { id } },
      async (tx) => {
        await writeQuestionFts(tx, { questionId: id, stemPlain: "新 词 串" });
        return [];
      },
      h,
    );

    const n = await h.client.execute({
      sql: "SELECT COUNT(*) AS c FROM question_fts WHERE question_id = ?",
      args: [id],
    });
    expect(Number((n.rows[0] as unknown as { c: number }).c)).toBe(1); // 不是 2
    expect(await 命中(h, '"新"')).toEqual([id]);
    expect(await 命中(h, '"旧"')).toEqual([]);

    // 删题 → 0004 保留的 DELETE 兜底触发器清索引行（不靠调用方自觉）
    await withCoreWrite(
      { actor: "system", tool: "fts.test.删题", args: { id } },
      async (tx) => {
        await tx.delete(question).where(eq(question.id, id));
        return [{ table: "question", id, op: "delete" as const }];
      },
      h,
    );
    const after = await h.client.execute({
      sql: "SELECT COUNT(*) AS c FROM question_fts WHERE question_id = ?",
      args: [id],
    });
    expect(Number((after.rows[0] as unknown as { c: number }).c)).toBe(0);
  });
});

describe("③ ftsQuery：MATCH 永不拼串", () => {
  it("多词=显式 AND；语法字符被转义成普通字符；切不出词返回 null", async () => {
    const 多词 = await ftsQuery("一元一次方程 解法");
    expect(多词.tokens.length).toBeGreaterThan(1);
    expect(多词.match).toBe(多词.tokens.map((t) => `"${t}"`).join(" AND "));

    // 注入形状的输入：两道防线
    //   一道在分词——纯标点 token 分词阶段就丢了，`"` `:` `*` 根本到不了 MATCH；
    //   一道在转义——万一 token 里真带引号，ftsStringLiteral 把它翻倍。
    const 恶意 = await ftsQuery('方程" OR question_id:*');
    expect(恶意.match).not.toBeNull();
    for (const ch of ['"方程"', "AND"]) expect(恶意.match).toContain(ch);
    for (const ch of ["*", ":"]) expect(恶意.match).not.toContain(ch);
    expect(ftsStringLiteral('带"引号')).toBe('"带""引号"');
    // 真喂给 SQLite 也不该炸（语法合法、结果为空即可）
    const h = await 造副本("query");
    await expect(命中(h, 恶意.match!)).resolves.toEqual([]);

    expect((await ftsQuery("   ")).match).toBe(null);
    expect((await ftsQuery("，。！")).match).toBe(null); // 纯标点切不出 token
  });
});
