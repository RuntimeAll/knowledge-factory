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
 * 🔴 「逐表分相升格」（总指挥 2026-08-12 拍板修正，逻辑写死在下面 judge()，不靠人记）
 *
 *   本关要证的是**这份快照忠实地装下了源库现在有的东西**，所以判据必须逐表比源库：
 *
 *     源库该表 > 0  → 快照该表**必须 > 0**（硬断言。源库有、快照没有 = 备份丢数据，
 *                     正是本关存在的唯一理由）
 *     源库该表 = 0  → 该表「空库期」，快照为 0 是正常，打 PASS(空库期)
 *
 *   ── 为什么改掉旧口径 ────────────────────────────────────────────────────
 *   旧口径把三张表捆成一个开关：`kp/question/ingest_batch 任一非 0` 就同时对
 *   **kp 与 question 两张表**下非零硬断言。于是 002 导底后（kp=415、question=0）
 *   本关会因为「question 还是 0」当场假红 —— 而 question 要等 003 录题链才有行。
 *   一个天天假红的闸，两周内就会被人习惯性忽略，那才是真正危险的（红旗麻木）。
 *   逐表分相之后，每张表按**自己**的相位走，不再互相牵连。
 *
 *   ── 相位表（跟着卡走，不需要任何人回来改这个脚本）──────────────────────
 *     kp            AI:PRD-002 导底（2026-08-12，415 行）之后 → 已升格为硬断言
 *     question      AI:PRD-003 首批录题之后               → 届时自动升格
 *     ingest_batch  同上（录入链跑过第一个批次就升格）
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
  dbUrlToPath,
  getCoreDb,
  type BackupReason,
} from "../src/core/index";

/**
 * 结构基线：32 普通 + 6 question_fts 家族 + 6 kp_fts 家族（002-C 加）+ 3 机制
 * （schema.test / backup-integrity.test / core.test 同一口径，改一处要一起改）
 */
const TABLES_BASELINE = 47;

/** 🔴 逐表分相的三张业务表（相位表见文件头）；audit_log/tables 是恒定硬断言，不在此列 */
const PHASED_TABLES = ["kp", "question", "ingest_batch"] as const;
type PhasedTable = (typeof PHASED_TABLES)[number];

interface SnapshotCounts {
  tables: number;
  audit_log: number;
  kp: number;
  question: number;
  ingest_batch: number;
}

/** 源库侧的同名计数（判据的另一半：快照要跟源库比，不是跟自己比） */
type SourceCounts = Record<PhasedTable, number>;

interface Assertion {
  ok: boolean;
  /** 该表处于空库期（源库也是 0），降级放行时为 true（打 PASS(空库期)） */
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

/**
 * 源库侧逐表计数（同样用 node:sqlite **只读**打开，一个字节不写）。
 * 🔴 为什么另开一条只读连接而不问 core 要数：本关的判据是「源库有的，快照里也得有」，
 *    两边都由本脚本自己数才谈得上是**校验**；拿备份代码自报的数当基准就成了自证。
 */
async function countInSource(path: string): Promise<SourceCounts> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out = {} as SourceCounts;
    for (const t of PHASED_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as
        { c: number | bigint } | undefined;
      out[t] = Number(row?.c ?? -1);
    }
    return out;
  } finally {
    db.close();
  }
}

/** 🔴 判据写死在这里：逐表分相升格，口径见文件头 */
function judge(
  c: SnapshotCounts,
  src: SourceCounts,
  bytes: number,
): Assertion[] {
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

  // 🔴 逐表分相：每张表只跟**它自己在源库里的行数**比，互不牵连
  for (const t of PHASED_TABLES) {
    const 源 = src[t];
    const 快 = c[t];
    if (源 > 0) {
      out.push({
        ok: 快 > 0,
        name: `${t} 有行（该表已升格为硬断言）`,
        detail:
          `源库 ${源} → 快照 ${快}` +
          (快 > 0
            ? ""
            : "（🔴 源库有行而快照是空的 = 备份把这张表丢了，本关就是为抓这个而存在）"),
      });
    } else {
      out.push({
        ok: true,
        downgraded: true,
        name: `${t} 有行`,
        detail:
          `源库 ${源} → 该表处于「空库期」，快照为 ${快} 属正常，降级放行。` +
          `　🔴 源库这张表一有行，本关对它自动升格为非零硬断言，无需改脚本。`,
      });
    }
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const reason = parseReason(argv);

  // 🔴 源库计数要在出快照**之前**数：先数快照后数源库的话，
  //    中间被写进来一行就会得出「源库有、快照没有」的假红。
  const srcPath = dbUrlToPath((await getCoreDb()).url);
  const source = await countInSource(srcPath);

  const r = await backupNow({ reason });
  const bytes = statSync(r.path).size;
  const counts = await countInSnapshot(r.path);
  const assertions = judge(counts, source, bytes);
  const failed = assertions.filter((a) => !a.ok);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          backup: r,
          source,
          recounted: counts,
          assertions,
          ok: failed.length === 0,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const L: string[] = [];
    L.push(`新快照已出（reason=${r.reason}，耗时 ${r.ms}ms）`);
    L.push(`  文件：${r.path}`);
    L.push(`  异地：${r.remote}`);
    L.push(
      `源库逐表基线（${srcPath}）：` +
        PHASED_TABLES.map((t) => `${t}=${source[t]}`).join("  "),
    );
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
