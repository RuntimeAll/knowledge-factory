/**
 * 审查队列闸（AI:PRD-002 · 002-D）
 *
 * 沿用既有范式：**真库只 SELECT，行为测试全在 VACUUM INTO 出来的副本上跑**
 * （audit_log 是 append-only，往真库插一行就再也拿不出来）。
 *
 * 测试在精不在多，只钉三件必须永远成立的事：
 *   ① 裁决绿路：open → passed，谁裁的/什么时候/为什么全落库，审计行一条不落、闸自动关；
 *   ② 裁决红路：终态再判一次报 QUEUE_ALREADY_DECIDED，且**整笔回滚**
 *      —— 库里那行一个字不动，也不留审计行（失败的写不该在链上留脚印）；
 *   ③ 快捷加别名（治理页那颗按钮背后的核心函数）：别名补进去 + 工单判过 +
 *      **原来那句问不出来的话，现在 1.00 命中** —— 这才叫「处理掉了一条工单」。
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LOCAL_ISO_RE,
  QueueError,
  createCoreDb,
  createKp,
  getQueueItem,
  listQueueItems,
  passQueueWithAlias,
  readWriteGate,
  resolveKp,
  verdictQueueItem,
  verifyAuditChain,
  type CoreDbHandle,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本清单: string[] = [];
const 句柄清单: CoreDbHandle[] = [];

function fileUrl(p: string): string {
  return `file:${p.replace(/\\/g, "/")}`;
}

async function 造副本(tag: string): Promise<CoreDbHandle> {
  const p = join(tmpdir(), `kf-queue-${process.pid}-${tag}.db`);
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
        /* Windows 句柄释放晚于 close()，删不掉不算失败 */
      }
    }
  }
});

async function 行<T>(h: CoreDbHandle, sql: string): Promise<T[]> {
  const r = await h.client.execute(sql);
  return r.rows as unknown as T[];
}

async function 审计行数(h: CoreDbHandle): Promise<number> {
  const rows = await 行<{ c: number }>(
    h,
    "SELECT COUNT(*) AS c FROM audit_log",
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * 开一条真的低置信工单：拿一句词表里绝不会有的话去 resolve_kp。
 * 🔴 不手工 INSERT —— 工单要长得跟真的一模一样（payload 里有 query，这是快捷加别名的料）。
 */
async function 开一条工单(h: CoreDbHandle, query: string): Promise<string> {
  const r = await resolveKp(query, { handle: h });
  expect(r.lowConfidence, `「${query}」居然不是低置信，换一句更离谱的`).toBe(
    true,
  );
  const id = r.queued?.id;
  expect(id, "低置信却没入队列").toBeTruthy();
  return id!;
}

// ---------------------------------------------------------------------------
// ① 裁决绿路
// ---------------------------------------------------------------------------

describe("verdictQueueItem · open → passed", () => {
  it("落库四件套（态/人/时间/理由）+ 审计行 + 闸自动关", async () => {
    const h = await 造副本("verdict-ok");
    const id = await 开一条工单(h, "锟斤拷烫烫烫的考点甲");

    const before = await 审计行数(h);
    const r = await verdictQueueItem(id, "passed", {
      by: "human",
      note: "确实该建这个考点，已另行处理",
      handle: h,
    });

    expect(r.verdict).toBe("passed");
    expect(r.seq).toBeGreaterThan(0);
    expect(r.verdictAt).toMatch(LOCAL_ISO_RE);

    const item = await getQueueItem(id, { handle: h });
    expect(item?.state).toBe("passed");
    expect(item?.verdictBy).toBe("human");
    expect(item?.verdictNote).toBe("确实该建这个考点，已另行处理");
    expect(item?.verdictAt).toBe(r.verdictAt);

    // 审计：恰好多一行，且指名道姓记着动的是哪一行
    expect(await 审计行数(h)).toBe(before + 1);
    const [audit] = await 行<{ tool: string; refs: string; actor: string }>(
      h,
      `SELECT tool, actor, row_refs_json AS refs FROM audit_log
        ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit?.tool).toBe("verdictQueueItem");
    expect(audit?.actor).toBe("human");
    expect(audit?.refs).toContain(id);
    expect(audit?.refs).toContain("review_queue");

    // 闸静息 + 链没断
    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);

    // 列表默认只看 open，裁过的就不该再挡在人眼前
    const open = await listQueueItems({ state: "open", handle: h });
    expect(open.some((x) => x.id === id)).toBe(false);
    const passed = await listQueueItems({ state: "passed", handle: h });
    expect(passed.some((x) => x.id === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ② 裁决红路
// ---------------------------------------------------------------------------

describe("verdictQueueItem · 终态不重裁", () => {
  it("已 passed 的再判一次：报错 + 整笔回滚（行不动、链上不留脚印）", async () => {
    const h = await 造副本("verdict-dup");
    const id = await 开一条工单(h, "锟斤拷烫烫烫的考点乙");

    await verdictQueueItem(id, "passed", { by: "human", handle: h });
    const 裁后 = await getQueueItem(id, { handle: h });
    const before = await 审计行数(h);

    // 🔴 第二次裁：不是「覆盖上一次」，是直接拒
    await expect(
      verdictQueueItem(id, "rejected", {
        by: "另一个人",
        note: "我不同意",
        handle: h,
      }),
    ).rejects.toMatchObject({
      name: "QueueError",
      code: "QUEUE_ALREADY_DECIDED",
    });

    // 报错文案要说清「上次是谁裁的」——撞上这个错的人多半开着两个标签页
    await expect(
      verdictQueueItem(id, "rejected", { by: "另一个人", handle: h }),
    ).rejects.toThrow(/passed/);

    const 现在 = await getQueueItem(id, { handle: h });
    expect(现在?.state).toBe("passed");
    expect(现在?.verdictBy).toBe(裁后?.verdictBy);
    expect(现在?.verdictAt).toBe(裁后?.verdictAt);
    expect(现在?.verdictNote).toBe(裁后?.verdictNote);

    // 失败的写不留审计行（withCoreWrite 里业务写与审计同生共死）
    expect(await 审计行数(h)).toBe(before);
    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);

    // 报错也认得出「不存在」这一路
    await expect(
      verdictQueueItem("rq_01JZZZZZZZZZZZZZZZZZZZZZZZ", "passed", {
        by: "human",
        handle: h,
      }),
    ).rejects.toMatchObject({ code: "QUEUE_NOT_FOUND" });
    await expect(
      verdictQueueItem(id, "passed", { by: "  ", handle: h }),
    ).rejects.toBeInstanceOf(QueueError);
  });
});

// ---------------------------------------------------------------------------
// ③ 快捷加别名（治理页那颗按钮背后的核心函数）
// ---------------------------------------------------------------------------

describe("passQueueWithAlias · 补别名结案", () => {
  it("别名补进去 + 工单判过 + 原来那句话从此 1.00 命中", async () => {
    const h = await 造副本("quick-alias");

    // 造一个干净的目标考点（不碰存量数据，断言才不会被别的行干扰）
    const 目标 = await createKp(
      { name: "测试考点·分式的混合运算", domain: "式", topic: "分式" },
      { handle: h },
    );
    const 说法 = "分式四则连算怎么摆顺序";

    const id = await 开一条工单(h, 说法);
    const before = await 审计行数(h);

    const r = await passQueueWithAlias(
      id,
      { kpId: 目标.id, alias: 说法, by: "human" },
      { handle: h },
    );

    expect(r.alias.inserted).toBe(true);
    expect(r.verdict.verdict).toBe("passed");

    const item = await getQueueItem(id, { handle: h });
    expect(item?.state).toBe("passed");
    expect(item?.verdictBy).toBe("human");
    // 没传 note 时自动写清「补了什么进哪儿」，日后翻账看得懂
    expect(item?.verdictNote).toContain(说法);
    expect(item?.verdictNote).toContain(目标.id);

    // 🔴 两笔 core 写 = 两条审计行（别名一条、裁决一条），一条都不许省
    expect(await 审计行数(h)).toBe(before + 2);

    // 🔴 正主断言：原来问不出来的那句话，现在精确命中目标考点
    const 再查 = await resolveKp(说法, { handle: h, enqueue: false });
    expect(再查.lowConfidence).toBe(false);
    expect(再查.candidates[0]?.kpId).toBe(目标.id);
    expect(再查.candidates[0]?.confidence).toBe(1);
    expect(再查.candidates[0]?.matchedVia).toBe("exact-alias");
    expect(再查.candidates[0]?.aliasHit).toBe(说法);

    expect(await readWriteGate(h)).toBe(0);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  });
});
