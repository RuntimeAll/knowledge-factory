/**
 * core/integrity.ts —— 对账六项（AI:PRD-001 · WP4）
 *
 * 正本 = PRD-026/M1-数据模型.md §5「孤儿对账（integrity_check，审查后扩充版）」，
 * 逐条对照实现，不多不少：
 *
 *   C1 审计覆盖与登记对齐  (a)行↔审计覆盖 (b)question↔question_vec (c)asset↔文件系统
 *                          (d)review_queue.ref 存在性 (e)🆕 静息闸必须=0
 *   C2 悬挂引用            引用表不得指向 merged/retired 的 kp（merge 原语漏挂即红旗）
 *   C3 向量版本单一        embed_model_ver 全表 ≤1 种且=当前配置（混版=近邻数学上无意义）
 *   C4 圣域契约            (a)schema hash (b)task_id 存在 (c)tasks.nq = 题单数
 *   C5 挂桥覆盖率          挂不上桥的批次列明细（🔴 warn 不红拦，M1 原文如此）
 *   C6 活跃树唯一          每 (subject,edition,grade_sem) 的 active 树 ≤1
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 red vs warn 的界线（决定 ok，也决定脚本退出码）：
 *   - **red** = 数据已经不自洽，继续用会产出错结论（漏题、统计劈半、近邻乱套、
 *     题单与登记错位、有向量无题）。ok=false，REG-A1 的闸红。
 *   - **warn** = 事实上「还没补齐」，但没有任何结论会因此变错：
 *     有题无向量（语义轴少一条候选，FTS 照常）、批次挂不上桥（覆盖率口径里
 *     看得见，M1 明写「列明细提示补录（不红拦）」）。
 *   一个 check 里混着 red 与 warn 项时，level 取本次实际命中的**最高级**。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 对账全程只 SELECT（对本库、对圣域都是），唯一的写是收尾那条 logMetric。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import { dbUrlToPath } from "./backup";
import { getCoreDb, type CoreDbHandle } from "./db";
import {
  getGradingDb,
  gradingSchemaHash,
  normalizeDdl,
  type GradingTableDdl,
} from "./grading";
import { ID_PREFIX_TABLE, parseIdPrefix } from "./ids";
import { logMetric } from "./metrics";
import { nowLocalISO } from "./time";
import { readWriteGate } from "./write";

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6";
export type CheckLevel = "red" | "warn";

export interface CheckResult {
  id: CheckId;
  name: string;
  ok: boolean;
  /** 本次结论的严重级：ok 时=该项的名义级别；不 ok 时=实际命中的最高级 */
  level: CheckLevel;
  /** 人话明细（每条一行，脚本直接打） */
  details: string[];
  stats?: Record<string, number | string>;
}

export interface IntegrityReport {
  /** 🔴 = 没有 red（warn 不拦） */
  ok: boolean;
  generatedAt: string;
  checks: CheckResult[];
}

export interface IntegrityOptions {
  handle?: CoreDbHandle;
  /** 圣域只读连接串（默认惰性读 env GRADING_DB_URL） */
  gradingUrl?: string;
  /** 圣域 schema 快照契约附件（默认 <cwd>/contracts/审核db-schema.snapshot.json） */
  snapshotPath?: string;
  /** 资产文件仓（默认 <库文件同级>/assets） */
  assetsDir?: string;
  /** 当前向量模型版本（默认惰性读 env EMBED_MODEL_VER） */
  embedModelVer?: string | null;
  /** 收尾是否 logMetric（默认 true；🔴 关掉=这次对账在库里查不到，只给特殊场景用） */
  metric?: boolean;
}

/** 默认的圣域 schema 快照契约附件路径 */
export const GRADING_SNAPSHOT_FILE = "contracts/审核db-schema.snapshot.json";

// ---------------------------------------------------------------------------
// 行标识口径（C1a 的比对基准）
// ---------------------------------------------------------------------------

/**
 * 🔴 复合主键行的 rowRef.id 口径：主键各段按建表顺序用 `|` 连接。
 *    写侧（withCoreWrite 的 rowRefs）与读侧（本文件的 idExpr）必须用同一口径，
 *    所以写侧一律调这个函数，别在业务里手拼字符串。
 */
export const ROW_KEY_SEP = "|";

export function rowRefId(...parts: Array<string | number>): string {
  return parts.map(String).join(ROW_KEY_SEP);
}

/**
 * 参与 C1a 的表 = 六域 32 表**除去** audit_log / metric_event。
 *   - audit_log 是覆盖判据本身（自己证明自己没意义）；
 *   - metric_event 是流水，每条都由 logMetric 写、天然带审计行，但它的 id 是自增整数，
 *     且量级远大于业务行，不进逐行比对（M1 §5① 的口径就是「核心业务表」）。
 * idExpr 里的表别名固定为 `t`。
 */
export const AUDITED_TABLES: ReadonlyArray<{ table: string; idExpr: string }> =
  [
    // A 域
    { table: "kp", idExpr: "t.id" },
    { table: "kp_alias", idExpr: "t.kp_id || '|' || t.alias" },
    {
      table: "kp_edge",
      idExpr: "t.from_kp || '|' || t.to_kp || '|' || t.type",
    },
    { table: "edition_tree", idExpr: "t.id" },
    { table: "edition_node", idExpr: "t.id" },
    { table: "node_kp_map", idExpr: "t.node_id || '|' || t.kp_id" },
    // B 域
    { table: "question", idExpr: "t.id" },
    { table: "question_kp", idExpr: "t.question_id || '|' || t.kp_id" },
    { table: "question_tag", idExpr: "t.question_id || '|' || t.tag" },
    { table: "question_figure", idExpr: "t.id" },
    { table: "question_vec", idExpr: "t.question_id" },
    { table: "asset", idExpr: "t.id" },
    { table: "source_doc", idExpr: "t.id" },
    { table: "source_page", idExpr: "t.id" },
    // C 域
    { table: "exam_model", idExpr: "t.id" },
    // D 域
    { table: "error_cause", idExpr: "t.id" },
    { table: "kp_error", idExpr: "t.kp_id || '|' || t.cause_id" },
    { table: "cause_example", idExpr: "t.cause_id || '|' || t.question_id" },
    { table: "err_code_map", idExpr: "t.kp_id || '|' || t.err_code" },
    // E 域
    { table: "ingest_batch", idExpr: "t.id" },
    { table: "quarantine", idExpr: "t.id" },
    { table: "sku", idExpr: "t.id" },
    { table: "sku_item", idExpr: "t.sku_id || '|' || t.ord" },
    { table: "sku_output", idExpr: "t.id" },
    { table: "grading_task_map", idExpr: "CAST(t.task_id AS TEXT)" },
    { table: "grading_batch_link", idExpr: "CAST(t.batch_id AS TEXT)" },
    // F 域
    { table: "roster", idExpr: "t.code" },
    // G 域（audit_log / metric_event 不在内）
    { table: "review_queue", idExpr: "t.id" },
    { table: "ledger", idExpr: "t.id" },
    {
      table: "ledger_ref",
      idExpr: "t.ledger_id || '|' || t.ref_type || '|' || t.ref_id",
    },
  ];

/** C2 要查的引用表（🔴 cause_example 没有 kp_id 列，见 C2 实现处的诚实标注） */
const KP_REF_TABLES = [
  "question_kp",
  "node_kp_map",
  "kp_error",
  "kp_alias",
] as const;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type Args = Array<string | number | null>;

async function q<T>(
  h: CoreDbHandle,
  sql: string,
  args: Args = [],
): Promise<T[]> {
  const r = await h.client.execute({ sql, args });
  return r.rows as unknown as T[];
}

async function count(h: CoreDbHandle, sql: string, args: Args = []) {
  const rows = await q<{ c: number | bigint }>(h, sql, args);
  return Number(rows[0]?.c ?? 0);
}

const SAMPLE = 6;

function sampleLine(prefix: string, ids: string[], total: number): string {
  const shown = ids.slice(0, SAMPLE).join("、");
  const more = total > ids.length || ids.length > SAMPLE ? " …" : "";
  return `${prefix}（${total} 条）：${shown}${more}`;
}

/** 递归列目录下所有文件，返回相对 root 的 posix 路径 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile())
        out.push(relative(root, full).split("\\").join(posix.sep));
    }
  };
  walk(root);
  return out;
}

/** asset.path 归一：反斜杠→斜杠、去 './'、去掉可能带上的 'data/assets/' 前缀 */
export function normalizeAssetPath(p: string): string {
  let s = p.split("\\").join("/").replace(/^\.\//, "");
  s = s.replace(/^data\/assets\//i, "");
  return s;
}

// ---------------------------------------------------------------------------
// C1 · 审计覆盖与登记对齐
// ---------------------------------------------------------------------------

async function checkC1(
  h: CoreDbHandle,
  assetsDir: string,
): Promise<CheckResult> {
  const details: string[] = [];
  const stats: Record<string, number | string> = {};
  let red = false;
  let warn = false;

  // --- (a) 每张核心业务表的每行都得在某条 audit_log.row_refs_json 里 -----------
  let uncoveredTotal = 0;
  let scannedTables = 0;
  for (const { table, idExpr } of AUDITED_TABLES) {
    const n = await count(h, `SELECT COUNT(*) AS c FROM ${table}`);
    if (n === 0) continue; // 空表跳过
    scannedTables += 1;
    const missWhere =
      `FROM ${table} t WHERE NOT EXISTS (` +
      `SELECT 1 FROM audit_log a, json_each(COALESCE(a.row_refs_json,'[]')) j ` +
      `WHERE json_extract(j.value,'$.table') = ? AND json_extract(j.value,'$.id') = ${idExpr})`;
    const miss = await count(h, `SELECT COUNT(*) AS c ${missWhere}`, [table]);
    if (miss > 0) {
      red = true;
      uncoveredTotal += miss;
      const ids = (
        await q<{ rid: string }>(
          h,
          `SELECT ${idExpr} AS rid ${missWhere} LIMIT ${SAMPLE}`,
          [table],
        )
      ).map((r) => String(r.rid));
      details.push(
        sampleLine(`(a) ${table} 有行查不到审计覆盖`, ids, miss) +
          "（有人绕过 core 写了库，或写侧漏报 rowRefs）",
      );
    }
  }
  stats["a_扫描非空表"] = scannedTables;
  stats["a_无审计覆盖行"] = uncoveredTotal;

  // --- (b) question ↔ question_vec 一一对应 -----------------------------------
  const noVec = await count(
    h,
    "SELECT COUNT(*) AS c FROM question q LEFT JOIN question_vec v ON v.question_id=q.id WHERE v.question_id IS NULL",
  );
  const orphanVec = await count(
    h,
    "SELECT COUNT(*) AS c FROM question_vec v LEFT JOIN question q ON q.id=v.question_id WHERE q.id IS NULL",
  );
  stats["b_有题无向量"] = noVec;
  stats["b_有向量无题"] = orphanVec;
  if (noVec > 0) {
    warn = true;
    const ids = (
      await q<{ id: string }>(
        h,
        `SELECT q.id AS id FROM question q LEFT JOIN question_vec v ON v.question_id=q.id WHERE v.question_id IS NULL LIMIT ${SAMPLE}`,
      )
    ).map((r) => r.id);
    details.push(
      sampleLine("(b) 有题无向量【warn·缺量待补】", ids, noVec) +
        "（语义轴少这些候选，FTS/SQL 两路不受影响）",
    );
  }
  if (orphanVec > 0) {
    red = true;
    const ids = (
      await q<{ id: string }>(
        h,
        `SELECT v.question_id AS id FROM question_vec v LEFT JOIN question q ON q.id=v.question_id WHERE q.id IS NULL LIMIT ${SAMPLE}`,
      )
    ).map((r) => r.id);
    details.push(
      sampleLine("(b) 有向量无题【red】", ids, orphanVec) +
        "（题没了向量还在，近邻会命中不存在的题）",
    );
  }

  // --- (c) asset 登记 ↔ data/assets 文件系统 双向核 ---------------------------
  const assets = await q<{ id: string; path: string }>(
    h,
    "SELECT id, path FROM asset",
  );
  const dirExists = existsSync(assetsDir);
  const files = dirExists ? listFiles(assetsDir) : [];
  const fileSet = new Set(files);
  const registered = new Map<string, string>(); // 归一路径 → asset id
  for (const a of assets) registered.set(normalizeAssetPath(a.path), a.id);

  const rowNoFile = assets.filter(
    (a) => !fileSet.has(normalizeAssetPath(a.path)),
  );
  const fileNoRow = files.filter((f) => !registered.has(f));
  stats["c_登记行"] = assets.length;
  stats["c_文件"] = files.length;
  stats["c_目录"] = dirExists ? assetsDir : `${assetsDir}（不存在，视为空）`;
  if (rowNoFile.length > 0) {
    red = true;
    details.push(
      sampleLine(
        "(c) 有登记行找不到文件【red】",
        rowNoFile.map((a) => `${a.id}→${a.path}`),
        rowNoFile.length,
      ),
    );
  }
  if (fileNoRow.length > 0) {
    red = true;
    details.push(
      sampleLine(
        "(c) 有文件查不到登记行【red·视同不存在】",
        fileNoRow,
        fileNoRow.length,
      ) + "（M1 §1：库里查不到登记行的文件视同不存在）",
    );
  }

  // --- (d) review_queue.ref_type/ref_id 指向的行必须存在 ------------------------
  const refs = await q<{ id: string; ref_type: string | null; ref_id: string }>(
    h,
    "SELECT id, ref_type, ref_id FROM review_queue WHERE ref_id IS NOT NULL",
  );
  const badRefs: string[] = [];
  for (const r of refs) {
    const prefix = parseIdPrefix(r.ref_id);
    if (prefix === null) {
      badRefs.push(`${r.id}→${r.ref_id}（id 前缀不在册，路由不到表）`);
      continue;
    }
    const table = ID_PREFIX_TABLE[prefix];
    const exists = await count(
      h,
      `SELECT COUNT(*) AS c FROM ${table} WHERE id = ?`,
      [r.ref_id],
    );
    if (exists === 0) {
      badRefs.push(`${r.id}→${r.ref_id}（${table} 里没有这行）`);
    } else if (r.ref_type && r.ref_type !== table && r.ref_type !== prefix) {
      badRefs.push(
        `${r.id}→${r.ref_id}（ref_type='${r.ref_type}' 与 id 前缀路由到的 ${table} 对不上）`,
      );
    }
  }
  stats["d_队列带ref行"] = refs.length;
  stats["d_悬挂ref"] = badRefs.length;
  if (badRefs.length > 0) {
    red = true;
    details.push(
      sampleLine(
        "(d) review_queue 多态 ref 悬挂【red】",
        badRefs,
        badRefs.length,
      ),
    );
  }

  // --- (e) 🆕 静息态写闸必须 = 0 ---------------------------------------------
  const gate = await readWriteGate(h);
  stats.e_write_gate = gate;
  if (gate !== 0) {
    red = true;
    details.push(
      `(e) _write_gate.allowed=${gate}【red】——静息态必须是 0。` +
        "闸被裸 SQL 掰开后没关（或 core 的开关闸被拆出了事务），此刻整库对裸连接是敞开的。" +
        "处置：查清是谁开的，再 UPDATE _write_gate SET allowed=0 WHERE id=1。",
    );
  }

  return {
    id: "C1",
    name: "审计覆盖与登记对齐（行↔审计 / 题↔向量 / 资产↔文件 / 队列ref / 静息闸）",
    ok: !red && !warn,
    level: red ? "red" : "warn",
    details,
    stats,
  };
}

// ---------------------------------------------------------------------------
// C2 · 悬挂引用（不得指向 merged/retired 的 kp）
// ---------------------------------------------------------------------------

async function checkC2(h: CoreDbHandle): Promise<CheckResult> {
  const details: string[] = [];
  const stats: Record<string, number | string> = {};
  let total = 0;

  for (const table of KP_REF_TABLES) {
    const n = await count(
      h,
      `SELECT COUNT(*) AS c FROM ${table} x JOIN kp k ON k.id = x.kp_id WHERE k.status IN ('merged','retired')`,
    );
    stats[table] = n;
    if (n > 0) {
      total += n;
      const rows = await q<{ kp_id: string; status: string }>(
        h,
        `SELECT DISTINCT x.kp_id AS kp_id, k.status AS status FROM ${table} x JOIN kp k ON k.id = x.kp_id WHERE k.status IN ('merged','retired') LIMIT ${SAMPLE}`,
      );
      details.push(
        sampleLine(
          `${table} 指向 merged/retired 考点【red】`,
          rows.map((r) => `${r.kp_id}(${r.status})`),
          n,
        ) + "（merge_kp 原语漏挂：合并后新考点会漏题、统计劈半、错因候选走空）",
      );
    }
  }

  // 🔴 诚实标注：M1 §5② 把 cause_example 也列进了这组，但 §3.D 的 DDL 里
  //    cause_example(cause_id, question_id) 根本没有 kp_id 列——它对考点是间接引用
  //    （经 question 的主考点）。这里不编一条查不出东西的假 SQL 冒充查过，
  //    如实标注，等正本澄清（挂 WP4 报告的偏差清单）。
  details.push(
    "说明：cause_example 没有 kp_id 列（§3.D DDL），对 kp 是经 question 的间接引用，本项不查——" +
      "正本 §5② 把它列进悬挂引用组，与 §3.D 表结构不一致，待澄清。",
  );

  return {
    id: "C2",
    name: "悬挂引用（question_kp/node_kp_map/kp_error/kp_alias 不得指向 merged/retired 考点）",
    ok: total === 0,
    level: "red",
    details,
    stats: { ...stats, 合计: total },
  };
}

// ---------------------------------------------------------------------------
// C3 · 向量版本单一
// ---------------------------------------------------------------------------

async function checkC3(
  h: CoreDbHandle,
  configured: string | null,
): Promise<CheckResult> {
  const details: string[] = [];
  const vers = (
    await q<{ v: string }>(
      h,
      "SELECT DISTINCT embed_model_ver AS v FROM question_vec ORDER BY v",
    )
  ).map((r) => r.v);
  const stats: Record<string, number | string> = {
    版本数: vers.length,
    库内版本: vers.join("、") || "(空表)",
    配置版本: configured ?? "(EMBED_MODEL_VER 未设)",
  };
  let ok = true;

  if (vers.length > 1) {
    ok = false;
    details.push(
      `question_vec 混着 ${vers.length} 个 embed_model_ver：${vers.join("、")}【red】——` +
        "🔴 两个向量空间混排，近邻在数学上无意义（表面还很正常）。" +
        "处置：语义轴应降级为纯 FTS，直到全量重算完。",
    );
  } else if (vers.length === 1) {
    if (configured === null) {
      ok = false;
      details.push(
        `库里已有向量（${vers[0]}）但 EMBED_MODEL_VER 未配置【red】——` +
          "判不了「当前模型是不是这个」，等于没有版本闸。",
      );
    } else if (vers[0] !== configured) {
      ok = false;
      details.push(
        `库内向量版本 ${vers[0]} ≠ 当前配置 ${configured}【red】——` +
          "要么配置改了没重算，要么重算跑了一半。处置同上：先降级纯 FTS。",
      );
    }
  } else {
    details.push(
      configured === null
        ? "question_vec 空表且 EMBED_MODEL_VER 未设 —— 绿（还没进向量阶段）"
        : `question_vec 空表；当前配置 ${configured} —— 绿（等首批向量落库后开始比对）`,
    );
  }

  return {
    id: "C3",
    name: "向量版本单一（question_vec.embed_model_ver）",
    ok,
    level: "red",
    details,
    stats,
  };
}

// ---------------------------------------------------------------------------
// C4 · 圣域契约
// ---------------------------------------------------------------------------

interface SnapshotFile {
  takenAt?: string;
  dbPath?: string;
  schemaHash?: string;
  tables?: GradingTableDdl[];
}

async function checkC4(
  h: CoreDbHandle,
  gradingUrl: string | undefined,
  snapshotPath: string,
): Promise<CheckResult> {
  const details: string[] = [];
  const stats: Record<string, number | string> = {};
  let ok = true;

  let grading;
  try {
    grading = await getGradingDb(gradingUrl);
  } catch (e) {
    return {
      id: "C4",
      name: "圣域契约（schema hash / task 存在 / nq=题单数）",
      ok: false,
      level: "red",
      details: [`圣域只读连接开不了：${String(e)}`],
      stats,
    };
  }

  // --- (a) 现场重算 schema hash vs 契约附件 ------------------------------------
  //     入参给原样 DDL，规范化在 gradingSchemaHash 里做（与生成脚本同一个函数）
  const live = grading
    .query<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .map((r) => ({ name: r.name, sql: r.sql ?? "" }));
  const liveHash = gradingSchemaHash(live);
  stats["a_现场hash"] = liveHash.slice(0, 16) + "…";
  stats["a_圣域表数"] = live.length;

  if (!existsSync(snapshotPath)) {
    ok = false;
    details.push(
      `(a) 找不到圣域 schema 快照契约附件 ${snapshotPath}【red】——` +
        "先跑 `pnpm exec tsx --env-file=.env scripts/snapshot-grading-schema.ts` 出首版。",
    );
  } else {
    let snap: SnapshotFile | null = null;
    try {
      snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as SnapshotFile;
    } catch (e) {
      ok = false;
      details.push(`(a) 快照文件读不动/不是合法 JSON【red】：${String(e)}`);
    }
    if (snap) {
      stats["a_快照hash"] = (snap.schemaHash ?? "(缺)").slice(0, 16) + "…";
      stats["a_快照时间"] = snap.takenAt ?? "(缺)";
      if (snap.schemaHash !== liveHash) {
        ok = false;
        const snapNames = new Set((snap.tables ?? []).map((t) => t.name));
        const liveNames = new Set(live.map((t) => t.name));
        const added = [...liveNames].filter((n) => !snapNames.has(n));
        const removed = [...snapNames].filter((n) => !liveNames.has(n));
        const changed = live
          .filter((t) => {
            if (!snapNames.has(t.name)) return false;
            const s = (snap.tables ?? []).find((x) => x.name === t.name);
            return normalizeDdl(s?.sql ?? null) !== normalizeDdl(t.sql);
          })
          .map((t) => t.name);
        details.push(
          `(a) 圣域 schema 变了【red】：快照 ${snap.schemaHash ?? "(缺)"} ≠ 现场 ${liveHash}` +
            (added.length ? `；新增表 ${added.join("、")}` : "") +
            (removed.length ? `；少了表 ${removed.join("、")}` : "") +
            (changed.length ? `；DDL 变了 ${changed.join("、")}` : ""),
        );
        details.push(
          "🔴 处置 = **人工重新快照并评估**（批改线改了表，我们的读侧口径可能已经错了），" +
            "不是自动跟进：重跑快照脚本前先确认读侧 join 路径与列语义仍成立。",
        );
      }
    }
  }

  // --- (b) grading_task_map.task_id 必须存在于只读侧 tasks.id -------------------
  const maps = await q<{ task_id: number; sku_id: string }>(
    h,
    "SELECT task_id, sku_id FROM grading_task_map ORDER BY task_id",
  );
  stats["b_登记桥"] = maps.length;
  const taskIds = new Set(
    grading
      .query<{ id: number }>("SELECT id FROM tasks")
      .map((r) => Number(r.id)),
  );
  const missingTasks = maps.filter((m) => !taskIds.has(Number(m.task_id)));
  if (missingTasks.length > 0) {
    ok = false;
    details.push(
      sampleLine(
        "(b) 登记的 task_id 在圣域 tasks 里不存在【red】",
        missingTasks.map((m) => `task_id=${m.task_id}→${m.sku_id}`),
        missingTasks.length,
      ),
    );
  }

  // --- (c) 已映射 task 的 tasks.nq = COUNT(sku_item WHERE sku_id) ---------------
  let nqBad = 0;
  for (const m of maps) {
    if (!taskIds.has(Number(m.task_id))) continue; // (b) 已经红过，不重复算
    const nqRow = grading.query<{ nq: number | null; kind: string | null }>(
      "SELECT nq, kind FROM tasks WHERE id = ?",
      [Number(m.task_id)],
    )[0];
    const items = await count(
      h,
      "SELECT COUNT(*) AS c FROM sku_item WHERE sku_id = ?",
      [m.sku_id],
    );
    const nq = nqRow?.nq ?? null;
    if (nq === null) {
      nqBad += 1;
      ok = false;
      details.push(
        `(c) task_id=${m.task_id}（kind=${nqRow?.kind ?? "?"}）的 tasks.nq 是 NULL，` +
          `但已登记到 ${m.sku_id}（题单 ${items} 题）【red】——无题单的任务不该登记上桥。`,
      );
    } else if (Number(nq) !== items) {
      nqBad += 1;
      ok = false;
      details.push(
        `(c) task_id=${m.task_id}: tasks.nq=${nq} ≠ sku_item(${m.sku_id})=${items}【red】——题单与登记错位，` +
          "按 ord=qno 对位的学情回流会整体错行。",
      );
    }
  }
  stats["c_对不上"] = nqBad;

  return {
    id: "C4",
    name: "圣域契约（schema hash / task 存在 / nq=题单数）",
    ok,
    level: "red",
    details,
    stats,
  };
}

// ---------------------------------------------------------------------------
// C5 · 挂桥覆盖率反向明细（warn，不红拦）
// ---------------------------------------------------------------------------

async function checkC5(
  h: CoreDbHandle,
  gradingUrl: string | undefined,
): Promise<CheckResult> {
  const details: string[] = [];
  let grading;
  try {
    grading = await getGradingDb(gradingUrl);
  } catch (e) {
    return {
      id: "C5",
      name: "挂桥覆盖率反向明细（批次→slots/补录桥→grading_task_map）",
      ok: false,
      level: "warn",
      details: [`圣域只读连接开不了，覆盖率算不了：${String(e)}`],
    };
  }

  const batches = grading.query<{
    id: number;
    student: string | null;
    day: number | null;
  }>("SELECT id, student, day FROM batches ORDER BY id");
  const slots = grading.query<{
    task_id: number | null;
    student: string | null;
    day: number | null;
  }>("SELECT task_id, student, day FROM slots");

  const mapped = new Set(
    (
      await q<{ task_id: number }>(h, "SELECT task_id FROM grading_task_map")
    ).map((r) => Number(r.task_id)),
  );
  const linked = new Map(
    (
      await q<{ batch_id: number; task_id: number }>(
        h,
        "SELECT batch_id, task_id FROM grading_batch_link",
      )
    ).map((r) => [Number(r.batch_id), Number(r.task_id)]),
  );
  // 桥键 = (student, day)：slots.day 是该生自己的打卡序号（收卷.py 与任务解耦的设计）
  const slotKey = new Map<string, number>();
  for (const s of slots) {
    if (s.task_id === null) continue;
    slotKey.set(`${s.student ?? ""}\u0000${s.day ?? ""}`, Number(s.task_id));
  }

  const unmatched: string[] = [];
  let matched = 0;
  for (const b of batches) {
    const viaSlot = slotKey.get(`${b.student ?? ""}\u0000${b.day ?? ""}`);
    const viaLink = linked.get(Number(b.id));
    const taskId =
      viaSlot !== undefined && mapped.has(viaSlot)
        ? viaSlot
        : viaLink !== undefined && mapped.has(viaLink)
          ? viaLink
          : null;
    if (taskId === null) {
      unmatched.push(
        `batch_id=${b.id} student=${b.student ?? "?"} day=${b.day ?? "?"}` +
          (viaSlot !== undefined
            ? `（slots→task_id=${viaSlot}，但该 task 未登记 grading_task_map）`
            : viaLink !== undefined
              ? `（补录桥→task_id=${viaLink}，但该 task 未登记 grading_task_map）`
              : "（slots 与补录桥两路都查不到）"),
      );
    } else matched += 1;
  }

  if (unmatched.length > 0) {
    details.push(
      `挂不上桥的批次 ${unmatched.length}/${batches.length}【warn·不红拦】——` +
        "这些批次的学情算不到考点上（M1：不登记的任务=学情算不到考点，但明细里看得见，不神隐）。" +
        "处置：给对应任务登记 grading_task_map，或用 grading_batch_link 人工补录。",
    );
    for (const line of unmatched.slice(0, 20)) details.push(`  · ${line}`);
    if (unmatched.length > 20)
      details.push(`  · …还有 ${unmatched.length - 20} 条`);
  } else if (batches.length === 0) {
    details.push("圣域侧还没有批次 —— 覆盖率无从谈起（绿）");
  }

  return {
    id: "C5",
    name: "挂桥覆盖率反向明细（批次→slots/补录桥→grading_task_map）",
    ok: unmatched.length === 0,
    level: "warn",
    details,
    stats: {
      matched,
      total: batches.length,
      覆盖率:
        batches.length === 0
          ? "n/a"
          : `${((matched / batches.length) * 100).toFixed(1)}%`,
    },
  };
}

// ---------------------------------------------------------------------------
// C6 · 活跃树唯一
// ---------------------------------------------------------------------------

async function checkC6(h: CoreDbHandle): Promise<CheckResult> {
  const dup = await q<{
    subject: string;
    edition: string;
    grade_sem: string;
    c: number;
  }>(
    h,
    "SELECT subject, edition, grade_sem, COUNT(*) AS c FROM edition_tree WHERE status='active' " +
      "GROUP BY subject, edition, grade_sem HAVING COUNT(*) > 1",
  );
  const total = await count(
    h,
    "SELECT COUNT(*) AS c FROM edition_tree WHERE status='active'",
  );
  const details = dup.map(
    (d) =>
      `(${d.subject}, ${d.edition}, ${d.grade_sem}) 有 ${d.c} 棵 active 树【red】——` +
      "检索会拿到双份考点候选。（唯一索引 idx_edtree_active 本该拦住，红了说明索引被绕过或导底脚本重跑过）",
  );
  return {
    id: "C6",
    name: "活跃树唯一（每 subject×edition×grade_sem 至多一棵 active）",
    ok: dup.length === 0,
    level: "red",
    details,
    stats: { active树: total, 冲突组: dup.length },
  };
}

// ---------------------------------------------------------------------------
// 总入口
// ---------------------------------------------------------------------------

export async function integrityCheck(
  options: IntegrityOptions = {},
): Promise<IntegrityReport> {
  const h = options.handle ?? (await getCoreDb());
  const dbPath = dbUrlToPath(h.url);
  const assetsDir = options.assetsDir ?? assetsDirFor(dbPath);
  const snapshotPath =
    options.snapshotPath ?? resolve(process.cwd(), GRADING_SNAPSHOT_FILE);
  const embedVer =
    options.embedModelVer !== undefined
      ? options.embedModelVer
      : (process.env.EMBED_MODEL_VER?.trim() ?? null);

  const checks: CheckResult[] = [
    await checkC1(h, resolve(assetsDir)),
    await checkC2(h),
    await checkC3(h, embedVer === "" ? null : embedVer),
    await checkC4(h, options.gradingUrl, snapshotPath),
    await checkC5(h, options.gradingUrl),
    await checkC6(h),
  ];

  const reds = checks.filter((c) => !c.ok && c.level === "red");
  const warns = checks.filter((c) => !c.ok && c.level === "warn");
  const report: IntegrityReport = {
    ok: reds.length === 0,
    generatedAt: nowLocalISO(),
    checks,
  };

  if (options.metric !== false) {
    await logMetric(
      "integrity_check",
      null,
      {
        ok: report.ok,
        red: reds.map((c) => c.id),
        warn: warns.map((c) => c.id),
        checks: Object.fromEntries(
          checks.map((c) => [c.id, c.ok ? "ok" : c.level]),
        ),
        // 🔴 WP6 加的（只加不减，老行照样读得动）：摘要里带上每项的**名字**。
        //    页面全局红旗条不现跑对账（那要连圣域、扫全表，扛不起每次页面加载），
        //    它只读这条摘要 —— 而「红旗 3 项」不说是哪三项等于没说，
        //    光有 id（C1/C4）也还得回代码里查是什么。名字放这儿，读侧零依赖。
        items: checks.map((c) => ({
          id: c.id,
          name: c.name,
          ok: c.ok,
          level: c.level,
        })),
      },
      h,
    );
  }

  return report;
}

/** 资产文件仓 = 库文件同级的 `assets/`（跟着库走，和 backup/ 同一套口径） */
export function assetsDirFor(dbPath: string): string {
  return resolve(join(dirname(dbPath), "assets"));
}
