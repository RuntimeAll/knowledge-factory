/**
 * 页面读侧（AI:PRD-001 · WP6）
 *
 * 少而精，只钉三件页面壳真正依赖的事：
 *   ① redFlagView 三态（纯函数，红旗条的全部判断逻辑都在这儿）；
 *   ② getLatestIntegritySummary 取的是**最近一条**，且带得出逐项名字；
 *   ③ listBackups 按新→旧排、认得出 reason、limit 生效。
 *
 * 沿用 core.test.ts 的范式：写行为一律在 VACUUM INTO 出来的副本上跑，真库只读。
 */
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCoreDb,
  getLatestIntegritySummary,
  listBackups,
  logMetric,
  redFlagView,
  type CoreDbHandle,
  type IntegritySummary,
} from "~/core";

const 真库路径 = join(process.cwd(), "data", "资料库.db");
const 副本 = join(tmpdir(), `kf-status-test-${process.pid}.db`);
let 句柄: CoreDbHandle;
let 备份目录: string;

beforeAll(async () => {
  expect(existsSync(真库路径), `真库不存在：${真库路径}`).toBe(true);
  if (existsSync(副本)) rmSync(副本, { force: true });
  const 真库 = createClient({ url: `file:${真库路径.replace(/\\/g, "/")}` });
  try {
    await 真库.execute(`VACUUM INTO '${副本.replace(/'/g, "''")}'`);
  } finally {
    真库.close();
  }
  句柄 = await createCoreDb(`file:${副本.replace(/\\/g, "/")}`);

  备份目录 = mkdtempSync(join(tmpdir(), "kf-backup-list-"));
});

afterAll(() => {
  句柄?.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = 副本 + suffix;
    for (let i = 0; i < 5 && existsSync(p); i++) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* %TEMP% 里的一次性副本，删不掉就算了 */
      }
    }
  }
  if (备份目录) rmSync(备份目录, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

function 摘要(over: Partial<IntegritySummary> = {}): IntegritySummary {
  return {
    metricId: 1,
    ts: "2026-08-12T18:00:00+08:00",
    ok: true,
    red: [],
    warn: [],
    items: [],
    ...over,
  };
}

describe("① redFlagView 三态", () => {
  it("无记录 → 灰条，告诉你怎么跑对账", () => {
    const v = redFlagView(null);
    expect(v.state).toBe("none");
    expect(v.headline).toContain("尚未对账");
    expect(v.headline).toContain("integrity_check");
    expect(v.items).toEqual([]);
    expect(v.checkedAt).toBeNull();
  });

  it("有 red → 红条，逐项带 id 与名字（不是只报个数）", () => {
    const v = redFlagView(
      摘要({
        ok: false,
        red: ["C1", "C4"],
        warn: ["C5"],
        items: [
          { id: "C1", name: "审计覆盖与登记对齐", ok: false, level: "red" },
          { id: "C4", name: "圣域契约", ok: false, level: "red" },
          { id: "C5", name: "挂桥覆盖率", ok: false, level: "warn" },
        ],
      }),
    );
    expect(v.state).toBe("red");
    expect(v.redCount).toBe(2);
    expect(v.warnCount).toBe(1);
    expect(v.headline).toContain("红旗 2 项");
    expect(v.items.map((i) => i.id)).toEqual(["C1", "C4"]);
    expect(v.items.map((i) => i.name)).toEqual([
      "审计覆盖与登记对齐",
      "圣域契约",
    ]);
  });

  it("全绿带 warn → 绿条，warn 数进标题", () => {
    const v = redFlagView(
      摘要({
        ok: true,
        warn: ["C5"],
        items: [{ id: "C5", name: "挂桥覆盖率", ok: false, level: "warn" }],
      }),
    );
    expect(v.state).toBe("green");
    expect(v.redCount).toBe(0);
    expect(v.headline).toContain("对账绿 · 1 warn");
    expect(v.items).toHaveLength(1);
    expect(v.checkedAt).toBe("2026-08-12T18:00:00+08:00");
  });
});

describe("② getLatestIntegritySummary", () => {
  it("取最近一条 integrity_check，逐项名字读得出来", async () => {
    // 先落一条旧的，再落一条新的：拿到的必须是新的
    await logMetric(
      "integrity_check",
      null,
      { ok: false, red: ["C1"], warn: [], items: [] },
      句柄,
    );
    await logMetric(
      "integrity_check",
      null,
      {
        ok: true,
        red: [],
        warn: ["C5"],
        checks: { C5: "warn" },
        items: [
          { id: "C5", name: "挂桥覆盖率反向明细", ok: false, level: "warn" },
        ],
      },
      句柄,
    );
    // 干扰项：别的 kind 不能被当成对账摘要
    await logMetric("backup", null, { ok: true }, 句柄);

    const s = await getLatestIntegritySummary(句柄);
    expect(s).not.toBeNull();
    expect(s!.ok).toBe(true);
    expect(s!.warn).toEqual(["C5"]);
    expect(s!.items[0]?.name).toBe("挂桥覆盖率反向明细");
    expect(redFlagView(s).state).toBe("green");
  });
});

describe("③ listBackups", () => {
  it("按新→旧排、认得出 reason、limit 生效", async () => {
    const 造 = (name: string, 秒: number) => {
      const p = join(备份目录, name);
      writeFileSync(p, "x".repeat(秒)); // 内容无所谓，只要是个文件
      const t = new Date(2026, 7, 12, 12, 0, 秒);
      utimesSync(p, t, t);
      return p;
    };
    造("资料库-daily-20260812-120001.db", 1);
    造("资料库-manual-20260812-120002.db", 2);
    造("资料库-batch-20260812-120003.db", 3);
    writeFileSync(join(备份目录, "说明.txt"), "非 .db 不该被列进来");

    const all = await listBackups({ dir: 备份目录 });
    expect(all.map((b) => b.reason)).toEqual(["batch", "manual", "daily"]);
    expect(all[0]!.file).toBe("资料库-batch-20260812-120003.db");
    expect(all[0]!.bytes).toBe(3);
    expect(all[0]!.mtime).toMatch(/^2026-08-12T12:00:03[+-]\d{2}:\d{2}$/);

    const 前两个 = await listBackups({ dir: 备份目录, limit: 2 });
    expect(前两个).toHaveLength(2);

    expect(await listBackups({ dir: join(备份目录, "不存在") })).toEqual([]);
  });
});
