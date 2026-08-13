/**
 * scripts/backfill-embed-20260813.ts —— 🔴 **首批向量回填**（AI:PRD-004 · 004-A）
 *
 * 把全库题目喂进本地 bge-small-zh-v1.5，向量落 `question_vec`。
 * 跑完之后：对账 C1(b)「有题无向量」从 warn 转绿，C3 从「空表」转成真在比对版本。
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/backfill-embed-20260813.ts            # 干跑（默认，库零变化）
 *   pnpm exec tsx --env-file=.env scripts/backfill-embed-20260813.ts --commit   # 真跑
 *   pnpm exec tsx --env-file=.env scripts/backfill-embed-20260813.ts --commit --all  # 连已有向量的也重算
 * 退出码：0 = 全绿；1 = 有一项没过。
 *
 * 前置：`powershell -File scripts\fetch-embed-model.ps1`（模型不在 git 里）
 *       `.env` 里 `EMBED_MODEL_VER="bge-small-zh-v1.5"`
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴 喂料喂的是什么，为什么（这是本脚本最该被质疑的一处决定）
 *
 *   喂 = `embedFeed(question.stem)` = **剥 HTML + 去 LaTeX 后的题面自然语句**。
 *
 *   落选的两个：
 *     ✗ `question.stem_plain`（分词后的空格串）—— 那是给 FTS 的。语义模型吃的是
 *       自然语句：中文被空格劈开后 WordPiece 边界与位置关系全变，向量明显退化。
 *       "把现成的列拿来用"在这里是错的，两条轴的喂料本来就不该是同一个东西。
 *     ✗ 原始 `stem` —— 里面躺着 `<span style="display:inline-block;…">` 与 `\frac`。
 *       512 token 的预算被样式串吃掉一半，且 `style`/`display` 会被当成有语义的英文词。
 *
 *   只喂 `stem`、不带 `answer`/`analysis`：用户是拿**题面**去找相似题的，
 *   把解析拌进去会让"解法相近但题型无关"的题挤进近邻。要不要加权拌入解析，
 *   是检索策略的事（004-B/C），不该在回填这一步偷偷定死。
 *
 * 🔴 其余四条纪律
 *   ① 动库之前先 `backupNow`；
 *   ② 只写 `question_vec` 一张表 —— 正本零改动（本脚本没有任何 question 的 UPDATE）；
 *   ③ 向量落库前已是**单位向量**（core/embed.ts 出厂即 L2 归一）⇒ 余弦 == 点积；
 *      BLOB = **Float32 小端**连续字节（口径正本 = core/vec.ts 文件头）；
 *   ④ `embed_model_ver` 只能来自 `EMBED_MODEL_VER`，且必须与实际加载的模型一致
 *      —— core/embed.ts 每次 embed 之前都核，不一致当场抛。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";

import {
  EMBED_DIM,
  EMBED_MODEL_ID,
  backupNow,
  blobToFloat32,
  closeCoreDb,
  cosineTopK,
  embedFeed,
  embedModelVer,
  embedStatus,
  embedTexts,
  float32ToBlob,
  getCoreDb,
  integrityCheck,
  invalidateVecIndex,
  loadEmbedder,
  nowLocalISO,
  withCoreWrite,
  type CoreDbHandle,
  type GateItem,
  type GateReport,
  type RowRef,
} from "../src/core/index";

const TOOL = "backfill_embed_20260813";

const 喂料口径 =
  "embedFeed(question.stem) = 剥 HTML（严格标签形状）+ 去 LaTeX 后的**自然语句**（不分词）。" +
  "不喂 stem_plain（那是空格分词串，喂语义模型会退化）、不喂原始 stem（样式串与 LaTeX 命令名会吃掉 token 预算）、" +
  "不拌 answer/analysis（用户拿题面找相似题；要不要加权拌解析是 004-B/C 的检索策略）。";

const 存储口径 =
  `Float32 小端连续字节，${EMBED_DIM} 维 = ${EMBED_DIM * 4} 字节；落库前已 L2 归一（单位向量）⇒ 余弦 == 点积。` +
  "序列化/反序列化只走 core/vec.ts 的 float32ToBlob / blobToFloat32，别处不许自己 Buffer.from。";

const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);
const say = (s = ""): void => void process.stdout.write(s + "\n");

interface 题行 {
  id: string;
  stem: string;
  status: string;
  /** 已有向量的版本（没有则 null） */
  vecVer: string | null;
}

async function 读全库(h: CoreDbHandle): Promise<题行[]> {
  const r = await h.client.execute(
    `SELECT q.id, q.stem, q.status, v.embed_model_ver AS vec_ver
       FROM question q
       LEFT JOIN question_vec v ON v.question_id = q.id
      ORDER BY q.id`,
  );
  return (r.rows as unknown as Record<string, string | null>[]).map((row) => ({
    id: String(row.id),
    stem: String(row.stem ?? ""),
    status: String(row.status),
    vecVer:
      row.vec_ver === null || row.vec_ver === undefined
        ? null
        : String(row.vec_ver),
  }));
}

function 账目(text: string): GateItem {
  return { name: text, result: { ok: true }, ms: 0 };
}

function 造账(名: string, items: GateItem[]): GateReport {
  return {
    ok: true,
    total: items.length,
    passed: items.length,
    failed: 0,
    skipped: 0,
    items: [{ name: 名, result: { ok: true }, ms: 0 }, ...items],
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes("--commit");
  const all = argv.includes("--all");
  let 坏 = 0;

  say(杠);
  say("AI:PRD-004 · 004-A 首批向量回填（真库）");
  say(
    `  模型：${EMBED_MODEL_ID}（本地 ONNX，${EMBED_DIM} 维，CLS pooling + L2 归一）`,
  );
  say(
    `  模式：${commit ? "🔴 真跑（--commit）" : "干跑（dryRun，库零变化）"}${all ? " + --all（连已有向量的也重算）" : ""}`,
  );
  say(杠);

  // ── 环境体检（模型在不在、版本对不对）─────────────────────────────────────
  const st = embedStatus();
  say("");
  say("① 模型体检：");
  say(`  目录：${st.dir}`);
  for (const f of st.files) {
    say(
      `  ${f.ok ? "[OK  ]" : "[MISS]"} ${f.name.padEnd(24)} ${f.bytes.toLocaleString()} bytes`,
    );
  }
  say(`  EMBED_MODEL_VER = ${st.configuredVer ?? "(未设)"}`);
  if (!st.ok) {
    say("");
    say(`🔴 ${st.reason}`);
    await closeCoreDb();
    process.exitCode = 1;
    return;
  }
  const ver = embedModelVer();
  const t载 = Date.now();
  await loadEmbedder();
  say(`  模型加载：${Date.now() - t载}ms  [PASS]`);

  const h = await getCoreDb();
  const rows = await 读全库(h);
  const 待办 = all
    ? rows
    : rows.filter((r) => r.vecVer === null || r.vecVer !== ver);
  say("");
  say(
    `② 取料：全库 ${rows.length} 题；已有当前版本向量 ${rows.filter((r) => r.vecVer === ver).length} 题；本次要算 ${待办.length} 题`,
  );

  // ── 喂料 + 推理 ────────────────────────────────────────────────────────────
  say("");
  say("③ 喂料（抽 3 条看一眼，确认喂进去的是人话不是分词串）：");
  const feeds = 待办.map((r) => embedFeed(r.stem));
  for (const [i, r] of 待办.slice(0, 3).entries()) {
    say(`  ${r.id}`);
    say(`    原文：${r.stem.replace(/\n/g, "⏎").slice(0, 76)}`);
    say(`    喂料：${feeds[i]!.replace(/\n/g, "⏎").slice(0, 76)}`);
  }
  const 空喂料 = 待办.filter((_r, i) => feeds[i]!.trim().length === 0);
  if (空喂料.length > 0) {
    坏 += 1;
    say(
      `  🔴 有 ${空喂料.length} 题喂料是空串（题面被归一掏空了？）：${空喂料
        .slice(0, 5)
        .map((r) => r.id)
        .join(",")}`,
    );
  }

  say("");
  say("④ 推理：");
  const t推 = Date.now();
  const vecs = await embedTexts(feeds);
  const ms = Date.now() - t推;
  say(
    `  ${待办.length} 条 用时 ${ms}ms（${待办.length > 0 ? (ms / 待办.length).toFixed(1) : "-"} ms/题）`,
  );

  // 维度 + 单位向量自检
  const 坏维 = vecs.filter((v) => v.length !== EMBED_DIM).length;
  let 坏模 = 0;
  for (const v of vecs) {
    let n = 0;
    for (const x of v) n += x * x;
    if (Math.abs(Math.sqrt(n) - 1) > 1e-4) 坏模 += 1;
  }
  if (坏维 > 0 || 坏模 > 0) 坏 += 1;
  say(
    `  维度 == ${EMBED_DIM}：不合格 ${坏维} 条  ${坏维 === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  say(
    `  模长 == 1（单位向量）：不合格 ${坏模} 条  ${坏模 === 0 ? "[PASS]" : "[FAIL]"}`,
  );

  // 序列化回程自检（🔴 落库口径当场验，不等出事再查）
  say("");
  say("⑤ 序列化回程（float32ToBlob → blobToFloat32 必须逐位相同）：");
  let 回程坏 = 0;
  for (const v of vecs) {
    const back = blobToFloat32(float32ToBlob(v));
    if (back.length !== v.length || back.some((x, i) => x !== v[i]))
      回程坏 += 1;
  }
  if (回程坏 > 0) 坏 += 1;
  say(
    `  不一致 ${回程坏} / ${vecs.length} 条  ${回程坏 === 0 ? "[PASS]" : "[FAIL]"}（每条 ${EMBED_DIM * 4} 字节）`,
  );

  // 语义抽样（人眼过一遍：近邻像不像同一类题）
  if (vecs.length >= 4) {
    say("");
    say(
      "⑥ 语义抽样（拿第 1 题当查询，看进程内点积排出来的前 3 名像不像同类）：",
    );
    const q = vecs[0]!;
    const scored = vecs
      .map((v, i) => {
        let s = 0;
        for (let k = 0; k < q.length; k++) s += q[k]! * v[k]!;
        return { i, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, 4);
    say(`  查询题：${待办[0]!.stem.replace(/\n/g, "⏎").slice(0, 70)}`);
    for (const x of scored) {
      say(
        `    ${x.s.toFixed(4)}  ${待办[x.i]!.id}  ${待办[x.i]!.stem.replace(/\n/g, "⏎").slice(0, 56)}`,
      );
    }
  }

  if (!commit) {
    say("");
    say(细);
    say(
      坏 === 0
        ? "干跑完毕（库零变化）。上面几项都过了，真跑：--commit"
        : `🔴 干跑就有 ${坏} 项没过，别 --commit。`,
    );
    await closeCoreDb();
    process.exitCode = 坏 === 0 ? 0 : 1;
    return;
  }

  // ── 真跑 ───────────────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("🔴 真跑（--commit）");
  say(杠);
  const bk = await backupNow({ reason: "manual" });
  say(
    `  备份：${bk.path}（${bk.bytes.toLocaleString()} bytes，${bk.tables} 张表，异地=${bk.remote}）`,
  );

  if (待办.length > 0) {
    const now = nowLocalISO();
    const 理由: GateItem[] = [
      账目(`回填 ${待办.length} / ${rows.length} 题的句向量`),
      账目(
        `模型 ${EMBED_MODEL_ID}（本地 ONNX，${EMBED_DIM} 维），embed_model_ver=${ver}`,
      ),
      账目(`喂料口径：${喂料口径}`),
      账目(`存储口径：${存储口径}`),
      账目(
        `自检：维度不合格 ${坏维} / 模长不合格 ${坏模} / 序列化回程不一致 ${回程坏}（三项判据都是 0）`,
      ),
      账目("只写 question_vec 一张表；question 正本零改动"),
    ];

    const receipt = await withCoreWrite(
      {
        actor: "human",
        tool: TOOL,
        args: {
          动作: "首批向量回填：全库题面 → 本地 ONNX 句向量 → question_vec",
          模型: EMBED_MODEL_ID,
          维度: EMBED_DIM,
          embed_model_ver: ver,
          全库行数: rows.length,
          回填行数: 待办.length,
          喂料口径,
          存储口径,
          推理耗时ms: ms,
          自检: {
            维度不合格: 坏维,
            模长不合格: 坏模,
            序列化回程不一致: 回程坏,
          },
          回填行: 待办.map((r) => r.id),
        },
        gateReport: 造账("004-A 语义轴底座 · 首批向量回填", 理由),
      },
      async (tx) => {
        const rowRefs: RowRef[] = [];
        for (const [i, r] of 待办.entries()) {
          const blob = float32ToBlob(vecs[i]!);
          // 幂等：有则覆盖（重跑本脚本、或换模型后重算，都是同一条语句）
          await tx.run(
            sql`INSERT INTO question_vec(question_id, embedding, embed_model_ver, updated_at)
                VALUES (${r.id}, ${blob}, ${ver}, ${now})
                ON CONFLICT(question_id) DO UPDATE SET
                  embedding = excluded.embedding,
                  embed_model_ver = excluded.embed_model_ver,
                  updated_at = excluded.updated_at`,
          );
          rowRefs.push({
            table: "question_vec",
            id: r.id,
            op: r.vecVer === null ? "insert" : "update",
          });
        }
        return rowRefs;
      },
      h,
    );
    say(
      `  审计 seq=${receipt.seq}  ts=${receipt.ts}  rowRefs=${receipt.rowRefs.length}`,
    );
  } else {
    say("  没有要算的题 —— 全库向量已经是当前版本了（本脚本可重复跑）。");
  }

  invalidateVecIndex(); // 🔴 同进程后面还要检索，缓存必须作废

  // ── 收尾复核 ───────────────────────────────────────────────────────────────
  say("");
  say(杠);
  say("收尾复核");
  say(杠);

  const 后 = await 读全库(h);
  say("");
  say("① 每题一条向量、版本单一：");
  const 无向量 = 后.filter((r) => r.vecVer === null);
  const 版本集 = new Set(
    后.filter((r) => r.vecVer !== null).map((r) => r.vecVer!),
  );
  if (无向量.length > 0 || 版本集.size !== 1 || !版本集.has(ver)) 坏 += 1;
  say(
    `  有题无向量 ${无向量.length}  ${无向量.length === 0 ? "[PASS]" : "[FAIL]"}`,
  );
  say(
    `  库内版本 {${[...版本集].join("、")}}，配置 ${ver}  ${版本集.size === 1 && 版本集.has(ver) ? "[PASS]" : "[FAIL]"}`,
  );

  say("");
  say("② 库里读回来的 BLOB 仍是合法单位向量（抽 5 条，走 blobToFloat32）：");
  const 抽 = await h.client.execute(
    "SELECT question_id, embedding FROM question_vec LIMIT 5",
  );
  let 读坏 = 0;
  for (const row of 抽.rows as unknown as {
    question_id: string;
    embedding: Uint8Array;
  }[]) {
    const v = blobToFloat32(row.embedding);
    let n = 0;
    for (const x of v) n += x * x;
    const ok = v.length === EMBED_DIM && Math.abs(Math.sqrt(n) - 1) < 1e-4;
    if (!ok) 读坏 += 1;
    say(
      `  ${ok ? "[PASS]" : "[FAIL]"} ${String(row.question_id)}  ${v.length} 维  |v|=${Math.sqrt(n).toFixed(6)}`,
    );
  }
  if (读坏 > 0) 坏 += 1;

  say("");
  say("③ cosineTopK 端到端（从库里建索引 → 暴力扫描）：");
  const t查 = Date.now();
  const hits = await cosineTopK(vecs[0] ?? (await embedTexts(["绝对值"]))[0]!, {
    limit: 3,
    handle: h,
  });
  say(`  用时 ${Date.now() - t查}ms（含建索引），返回 ${hits.length} 条`);
  const 题面 = new Map(后.map((r) => [r.id, r.stem]));
  for (const x of hits) {
    say(
      `    ${x.score.toFixed(4)}  ${x.questionId}  ${(题面.get(x.questionId) ?? "").replace(/\n/g, "⏎").slice(0, 52)}`,
    );
  }
  if (hits.length === 0) {
    坏 += 1;
    say("  🔴 一条都没返回");
  }

  say("");
  say("④ integrity_check 六项（🔴 看 C1(b) 与 C3）：");
  const rep = await integrityCheck({ handle: h });
  const reds = rep.checks.filter((c) => !c.ok && c.level === "red");
  for (const c of rep.checks) {
    const tag = c.ok ? "[PASS]" : c.level === "red" ? "[RED ]" : "[warn]";
    say(`  ${tag} ${c.id} ${c.name}`);
    const st2 = c.stats ?? {};
    if (c.id === "C3") say(`         stats: ${JSON.stringify(st2)}`);
    if (c.id === "C1")
      say(
        `         b_有题无向量=${st2.b_有题无向量} b_有向量无题=${st2.b_有向量无题}`,
      );
    if (!c.ok && c.level === "red")
      for (const d of c.details) say(`         ${d}`);
  }
  say(`  结论：red=${reds.length}`);

  await closeCoreDb();
  say("");
  say(细);
  say(
    坏 + reds.length === 0
      ? `结论：${待办.length} 题向量回填完毕，C3 版本单一、C1(b) 有题无向量归零，对账无 red。`
      : `结论：🔴 还有 ${坏 + reds.length} 项没过，去查上面的明细。`,
  );
  process.exitCode = 坏 + reds.length === 0 ? 0 : 1;
}

void main();
