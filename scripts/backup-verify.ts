/**
 * 备份快照有效性校验（AI:PRD-001 · WP7，REG-A4 的载体）
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/backup-verify.ts [--reason daily] [--json]
 * 退出码：0=快照有效；1=快照有问题（逐条打印哪一断言挂了）。
 *
 * 两步：
 *   ① backupNow({reason:'daily'}) 出一份**新**快照（不复用旧文件——
 *      「上周那份还能开」证明不了「今天备份还在正常工作」）；
 *   ② 以 **只读** 方式独立打开该快照文件，自己数一遍再断言。
 *
 * 🔴 为什么不直接信 backupNow 的返回值：那是备份代码自报的数。本关要验的正是
 *    「备份出来的文件到底能不能打开、里面有没有东西」，自报家门不算证据，
 *    得由另一段代码把文件重新打开数一遍。（顺带也就验了 VACUUM INTO 的产物
 *    确实是个能 open 的完整 .db，不是半截文件。）
 * 🔴 只读用 node:sqlite 的 readOnly:true（SQLITE_OPEN_READONLY）：
 *    这里检查的是我们**自己的快照**，不是圣域 审核.db，不受 mode=ro 声明锁约束；
 *    但同样一个字节不写——校验动作不该改变被校验的对象。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 kp / question 的「空库期自动降级」（总指挥拍板，逻辑写死在下面 judge()，不靠人记）
 *
 *   本卡（AI:PRD-001）只是库底座，业务数据要等 AI:PRD-003 的录入链才进来。
 *   在那之前 kp=question=0 是**正常状态**，硬断言非零只会让本关天天假红、
 *   然后被人习惯性忽略——那才是真正危险的（红旗麻木）。
 *
 *   判据（三表全为 0 才算空库期，任一非 0 立刻升格）：
 *     kp=0 且 question=0 且 ingest_batch=0  → 空库期，kp/question 允许为 0，打 PASS(空库期)
 *     三者任一 > 0                          → 非空库期，kp>0 且 question>0 是**硬断言**，
 *                                             不满足即 FAIL
 *
 *   ingest_batch 是那个「有没有真的录过东西」的开关：只要录入链跑过一次批次，
 *   本关就自动升格成非零硬断言，不需要任何人回来改这个脚本。
 *   （反过来说：ingest_batch 有行而 kp/question 是空的 = 录进来的东西没落地，
 *     正是本关该抓的事故。）
 *
 *   audit_log > 0 与表数=TABLES_BASELINE **任何时候都是硬断言**：空库也必须有审计行
 *   （建库那几次 core 写就留了痕），表数少一张 = 快照不完整或 schema 被动过。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { statSync } from "node:fs";

import {
  BACKUP_REASONS,
  backupNow,
  closeCoreDb,
  type BackupReason,
} from "../src/core/index";

/**
 * 结构基线：32 普通 + 6 question_fts 家族 + 6 kp_fts 家族（002-C 加）+ 3 机制
 * （schema.test / backup-integrity.test / core.test 同一口径，改一处要一起改）
 */
const TABLES_BASELINE = 47;

interface SnapshotCounts {
  tables: number;
  audit_log: number;
  kp: number;
  question: number;
  ingest_batch: number;
}

interface Assertion {
  ok: boolean;
  /** 空库期降级后仍算通过时为 true（打 PASS(空库期)） */
  downgraded?: boolean;
  name: string;
  detail: string;
}

function parseReason(argv: string[]): BackupReason {
  const i = argv.findIndex(
    (a) => a === "--reason" || a.startsWith("--reason="),
  );
  if (i < 0) return "daily";
  const raw = argv[i]?.includes("=")
    ? (argv[i]?.split("=", 2)[1] ?? "")
    : (argv[i + 1] ?? "");
  if ((BACKUP_REASONS as readonly string[]).includes(raw)) {
    return raw as BackupReason;
  }
  throw new Error(
    `--reason 只认 ${BACKUP_REASONS.join(" / ")}，收到 ${JSON.stringify(raw)}`,
  );
}

/** 独立打开快照文件（只读）自己数一遍 */
async function countInSnapshot(path: string): Promise<SnapshotCounts> {
  // 动态 import：Node < 22.5 没有 node:sqlite，让报错发生在有上下文的地方
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const one = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number | bigint } | undefined;
      return Number(row?.c ?? -1);
    };
    return {
      tables: one("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'"),
      audit_log: one("SELECT COUNT(*) AS c FROM audit_log"),
      kp: one("SELECT COUNT(*) AS c FROM kp"),
      question: one("SELECT COUNT(*) AS c FROM question"),
      ingest_batch: one("SELECT COUNT(*) AS c FROM ingest_batch"),
    };
  } finally {
    db.close();
  }
}

/** 🔴 判据写死在这里：空库期口径见文件头 */
function judge(c: SnapshotCounts, bytes: number): Assertion[] {
  const emptyPhase = c.kp === 0 && c.question === 0 && c.ingest_batch === 0;
  const out: Assertion[] = [];

  out.push({
    ok: bytes > 0,
    name: "快照文件非空",
    detail: `${bytes} 字节`,
  });
  out.push({
    ok: c.tables === TABLES_BASELINE,
    name: `表数 = ${TABLES_BASELINE}`,
    detail: `实为 ${c.tables}${
      c.tables === TABLES_BASELINE
        ? ""
        : "（少了=快照不完整或 schema 被动过，两种都得停下查）"
    }`,
  });
  out.push({
    ok: c.audit_log > 0,
    name: "audit_log 有行",
    detail: `COUNT=${c.audit_log}${c.audit_log > 0 ? "" : "（空库也该有建库那几笔的审计痕，一行没有=链丢了）"}`,
  });

  if (emptyPhase) {
    out.push({
      ok: true,
      downgraded: true,
      name: "kp / question 有行",
      detail:
        `kp=0 question=0 ingest_batch=0 → 判「空库期」，本关自动降级放行。` +
        `　🔴 库里一有业务数据（kp / question / ingest_batch 任一非 0），` +
        `本关自动升格为「kp>0 且 question>0」的非零硬断言，无需改脚本。`,
    });
  } else {
    out.push({
      ok: c.kp > 0,
      name: "kp 有行（非空库期硬断言）",
      detail: `kp=${c.kp}（ingest_batch=${c.ingest_batch} question=${c.question} → 已过空库期）`,
    });
    out.push({
      ok: c.question > 0,
      name: "question 有行（非空库期硬断言）",
      detail: `question=${c.question}（ingest_batch=${c.ingest_batch} kp=${c.kp} → 已过空库期）`,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const reason = parseReason(argv);

  const r = await backupNow({ reason });
  const bytes = statSync(r.path).size;
  const counts = await countInSnapshot(r.path);
  const assertions = judge(counts, bytes);
  const failed = assertions.filter((a) => !a.ok);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { backup: r, recounted: counts, assertions, ok: failed.length === 0 },
        null,
        2,
      ) + "\n",
    );
  } else {
    const L: string[] = [];
    L.push(`新快照已出（reason=${r.reason}，耗时 ${r.ms}ms）`);
    L.push(`  文件：${r.path}`);
    L.push(`  异地：${r.remote}`);
    L.push("独立只读复算（node:sqlite readOnly，不信备份自报的数）：");
    L.push(
      `  tables=${counts.tables}  audit_log=${counts.audit_log}  ` +
        `kp=${counts.kp}  question=${counts.question}  ingest_batch=${counts.ingest_batch}`,
    );
    for (const a of assertions) {
      const tag = a.ok
        ? a.downgraded
          ? "[PASS(空库期)]"
          : "[PASS]"
        : "[FAIL]";
      L.push(`  ${tag} ${a.name}`);
      L.push(`         ${a.detail}`);
    }
    L.push(
      failed.length === 0
        ? "结论：快照有效"
        : `结论：🔴 快照有问题（${failed.length} 条断言未过）`,
    );
    process.stdout.write(L.join("\n") + "\n");
  }

  await closeCoreDb();
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main();
