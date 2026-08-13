/**
 * scripts/kb-submit.ts —— 🔴 **产线接线的唯一入口**（AI:PRD-005 · 005-B）
 *
 * 一条命令把产线出的料投进题库：
 *
 *   pnpm kb:submit <json路径> [选项]
 *
 * 干的事（一步都不省）：
 *   ① 读文件 → 认形态（对象根 / 数组根 / 群卷题单）
 *   ② 转成 kb-ingest/v1（`convertPunchIngest`，纯函数、不碰库）并**摊开报告**：
 *      认不出的字段、做过的归一、推出来的 pipelineRef、跳过的元素，全打在屏幕上
 *   ③ `--assert-dedup` 时先跑**出册前置闸**：撞了已售/库存的题当场打撞单，**不投**，退出码 1
 *   ④ 逐单元 runIngestBatch（`--dry-run` 只验不写），打 counts + 逐题红灯摘要 + batchId
 *
 * 选项：
 *   --dry-run              只验不写：跑完全套闸，库与磁盘零变化
 *   --assert-dedup         投之前先查「这批题是不是已经卖过了」，红了不投
 *   --source <s>           喂料方标识（落 ingest_batch.source）
 *   --pipeline-ref <s>     prov.pipelineRef（脚本名@版本）——不给就按形态推并在报告里说明
 *   --kp <名或id>          考点兜底（可重复给）：题级/册级都没考点时用它
 *   --kp-map <json路径>    群卷题单专用：anchor/kp_group 说法 → 词表 ref 的显式映射表
 *                          （见 ConvertOptions.kpMap；表里没有的照原样送闸③，不代替闸）
 *   --title <s>            覆盖 sourceDoc.title（群卷题单没有册头时用得上）
 *   --kind <k>             覆盖 sourceDoc.kind（册子|群卷|试卷|讲义|其他）
 *   --qtype <t>            群卷题单的默认题型（计算/填空/…）
 *   --day <n> [--section <s>]  群卷题单的位置补丁（落 punchPos → question_tag）
 *   --only <单元名片段>     只投单元名里含这段字的（数组根一次十几本时用）
 *   --no-backup            不出收批快照（批量灌库时省时间）
 *   --yes                  跳过「摊开报告等人看一眼」的确认停顿（本脚本非交互，等同于默认）
 *
 * 退出码：0=全绿；1=有单元没投/没过（哪一个见输出）；2=进料读不了/认不出形态。
 *
 * 🔴 为什么闸做进管道而不是写进 SOP：产线自己的教训（备料 R1）——
 *    `write_ingest()` 只写在两本册的生成器里、签名还不一样，于是新册照样漏料。
 *    接线点只有这一个入口，闸就只需要守这一处。
 */
import { readFileSync } from "node:fs";

import {
  ConvertError,
  IngestError,
  assertNoSoldDuplicates,
  closeCoreDb,
  convertPunchIngest,
  runIngestBatch,
  type ConvertOptions,
  type ConvertResult,
  type IngestResult,
  type SourceDocKind,
} from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");
const 杠 = "=".repeat(78);
const 细 = "-".repeat(78);

// ---------------------------------------------------------------------------
// 入参
// ---------------------------------------------------------------------------

interface Cli {
  file: string;
  dryRun: boolean;
  assertDedup: boolean;
  only: string | null;
  backup: boolean;
  opts: ConvertOptions;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = {
    file: "",
    dryRun: false,
    assertDedup: false,
    only: null,
    backup: true,
    opts: {},
  };
  const kps: string[] = [];
  let section: string | undefined;
  let day: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 后面缺一个值`);
      return v;
    };
    switch (a) {
      case "--dry-run":
        cli.dryRun = true;
        break;
      case "--assert-dedup":
        cli.assertDedup = true;
        break;
      case "--no-backup":
        cli.backup = false;
        break;
      case "--yes":
        break;
      case "--source":
        cli.opts.source = next();
        break;
      case "--pipeline-ref":
        cli.opts.pipelineRef = next();
        break;
      case "--kp":
        kps.push(next());
        break;
      case "--kp-map": {
        const p = next();
        const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          throw new Error(
            `--kp-map 要一个 {"产线说法":"词表 ref"} 的 JSON 对象：${p}`,
          );
        }
        const map: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (k.startsWith("_")) continue; // `_说明` 这类注释键
          if (typeof v !== "string" || v.trim() === "") {
            throw new Error(`--kp-map 的「${k}」不是非空字符串（${p}）`);
          }
          map[k] = v;
        }
        cli.opts.kpMap = map;
        break;
      }
      case "--title":
        cli.opts.sourceDoc = { ...cli.opts.sourceDoc, title: next() };
        break;
      case "--kind":
        cli.opts.sourceDoc = {
          ...cli.opts.sourceDoc,
          kind: next() as SourceDocKind,
        };
        break;
      case "--qtype":
        cli.opts.qtype = next() as ConvertOptions["qtype"];
        break;
      case "--day":
        day = Number(next());
        break;
      case "--section":
        section = next();
        break;
      case "--only":
        cli.only = next();
        break;
      default:
        if (a.startsWith("--")) throw new Error(`认不出的选项：${a}`);
        if (cli.file)
          throw new Error(`只吃一个文件路径（已经有 ${cli.file} 了）`);
        cli.file = a;
    }
  }
  if (kps.length > 0) cli.opts.kps = kps;
  if (day !== undefined) {
    if (!Number.isInteger(day) || day <= 0)
      throw new Error("--day 要一个正整数");
    cli.opts.punch = { day, ...(section ? { section } : {}) };
  } else if (section) {
    throw new Error("--section 要和 --day 一起给（位置三元组缺一不可）");
  }
  if (!cli.file)
    throw new Error("要一个 json 路径：pnpm kb:submit <json路径> [选项]");
  cli.opts.filePath = cli.file;
  cli.opts.source ??= `kb-submit@v1·${cli.file.split(/[\\/]/).pop() ?? cli.file}`;
  return cli;
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

function 打转换报告(r: ConvertResult): void {
  say(杠);
  say(`转换报告 · 形态 = ${r.form}`);
  say(杠);
  say(
    `可投单元 ${r.counts.units} 个 / 共 ${r.counts.items} 题；` +
      `跳过 ${r.counts.skipped} 个；转不出来 ${r.counts.failed} 个`,
  );

  if (r.units.length > 0) {
    say(细);
    for (const u of r.units) say(`  · ${u.unit}  ${u.n} 题`);
  }
  if (r.skipped.length > 0) {
    say(细);
    say("跳过：");
    for (const s of r.skipped) say(`  · ${s.unit} —— ${s.why}`);
  }
  if (r.normalizations.length > 0) {
    say(细);
    say("做过的归一（🔴 每一条都是「搬运时折算过」，不是原样）：");
    for (const n of r.normalizations) say(`  · ${n}`);
  }
  if (r.unknownFields.length > 0) {
    say(细);
    say(
      `🔴 认不出的字段 ${r.unknownFields.length} 处（**没搬过来**，如实列出）：`,
    );
    for (const u of r.unknownFields.slice(0, 20)) {
      say(`  · ${u.where}：${u.keys.join("、")}`);
      say(`      ${u.sample}`);
    }
    if (r.unknownFields.length > 20)
      say(`  · …还有 ${r.unknownFields.length - 20} 处`);
  }
  if (r.warnings.length > 0) {
    say(细);
    say("提醒：");
    for (const w of r.warnings) say(`  · ${w}`);
  }
  if (r.failed.length > 0) {
    say(细);
    say(`🔴 转不出来的单元 ${r.failed.length} 个（**不会投**）：`);
    for (const f of r.failed) {
      say(`  · ${f.unit} [${f.code}]`);
      for (const line of f.message.split("\n")) say(`      ${line}`);
      if (f.seqs?.length) say(`      涉及 seq：${f.seqs.join("、")}`);
    }
  }
  say();
}

function 打入库结果(unit: string, r: IngestResult): void {
  const c = r.counts;
  say(
    `  结果：total=${c.total} accepted=${c.accepted}（其中需人审 ${c.queued}） rejected=${c.rejected}` +
      (r.dryRun ? "  [dry-run，库与磁盘零变化]" : ""),
  );
  if (r.batchId) say(`  批次：${r.batchId}（全账：get_ingest_batch）`);
  const 红 = r.gateReport.items.filter((i) => i.verdict === "rejected");
  if (红.length > 0) {
    say(`  🔴 被拒 ${红.length} 道（已进隔离区，原样 payload 留着）：`);
    for (const it of 红.slice(0, 15)) {
      say(
        `    · seq=${it.seq} [${it.failure?.code}] ${it.failure?.message ?? ""}`,
      );
    }
    if (红.length > 15) say(`    · …还有 ${红.length - 15} 道`);
  }
  if (r.quarantineIds.length > 0)
    say(
      `  隔离行：${r.quarantineIds.slice(0, 5).join("、")}${r.quarantineIds.length > 5 ? " …" : ""}`,
    );
  if (r.queueIds.length > 0)
    say(
      `  人审工单：${r.queueIds.slice(0, 5).join("、")}${r.queueIds.length > 5 ? " …" : ""}`,
    );
  void unit;
}

// ---------------------------------------------------------------------------
// 主
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    say(`🔴 ${e instanceof Error ? e.message : String(e)}`);
    say(
      "用法：pnpm kb:submit <json路径> [--dry-run] [--assert-dedup] [--kp 考点名] …",
    );
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cli.file, "utf8"));
  } catch (e) {
    say(`🔴 读不动/不是合法 JSON：${cli.file}`);
    say(`   ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let conv: ConvertResult;
  try {
    conv = convertPunchIngest(raw, cli.opts);
  } catch (e) {
    if (e instanceof ConvertError) {
      say(`🔴 认不出这份料 [${e.code}]：${e.message}`);
      return 2;
    }
    throw e;
  }
  打转换报告(conv);

  const 待投 = cli.only
    ? conv.units.filter((u) => u.unit.includes(cli.only!))
    : conv.units;
  if (cli.only) {
    say(
      `--only「${cli.only}」筛出 ${待投.length}/${conv.units.length} 个单元。`,
    );
    say();
  }
  if (待投.length === 0) {
    say("没有可投的单元 —— 到此为止（转换报告在上面）。");
    return conv.failed.length > 0 ? 1 : 0;
  }

  let 坏 = conv.failed.length;

  for (const u of 待投) {
    say(杠);
    say(`投料：${u.unit}（${u.n} 题）${cli.dryRun ? " · dry-run" : ""}`);
    say(杠);

    // ── ③ 出册前置闸（可选）─────────────────────────────────────────────
    if (cli.assertDedup) {
      const items = u.payload.items.map((it) => ({
        seq: it.seq,
        stem: it.stem,
      }));
      const dup = await assertNoSoldDuplicates(items);
      for (const w of dup.warnings) say(`  提醒：${w}`);
      if (dup.similar.length > 0) {
        say(`  语义近似 ${dup.similar.length} 处（只报不拦）：`);
        for (const s of dup.similar.slice(0, 8)) {
          const 归属 =
            s.skus.length > 0
              ? s.skus
                  .map(
                    (x) => `《${x.name}》(${x.type ?? "?"}/${x.status ?? "?"})`,
                  )
                  .join("、")
              : "（库存题，没进过册子）";
          say(`    · seq=${s.seq} ~ ${s.questionId} 相似度 ${s.score} ${归属}`);
        }
      }
      if (!dup.ok) {
        say(`  🔴 撞单 ${dup.collisions.length} 处 —— **本单元不投**：`);
        for (const c of dup.collisions.slice(0, 20)) {
          say(`    · seq=${c.seq}  ${c.stemBrief}`);
          for (const hit of c.hits) {
            const 归属 =
              hit.skus.length > 0
                ? hit.skus
                    .map(
                      (x) =>
                        `《${x.name}》第 ${x.ord ?? "?"} 题（${x.type ?? "?"}/${x.status ?? "?"}）`,
                    )
                    .join("、")
                : "（撞的是库存题，还没进过任何册子）";
            say(`        撞 ${hit.questionId}（${hit.status}）：${归属}`);
          }
        }
        坏 += 1;
        continue;
      }
      say(`  排重断言：绿（${dup.checked} 题，无 match_key 撞车）`);
    }

    // ── ④ 投 ───────────────────────────────────────────────────────────
    try {
      const r = await runIngestBatch(u.payload, {
        actor: "agent",
        dryRun: cli.dryRun,
        ...(cli.backup ? {} : { backup: false }),
      });
      打入库结果(u.unit, r);
      if (r.counts.rejected > 0) 坏 += 1;
    } catch (e) {
      if (e instanceof IngestError) {
        say(`  🔴 整批拒 [${e.code}]：${e.message}`);
      } else {
        say(`  🔴 投料炸了：${e instanceof Error ? e.message : String(e)}`);
      }
      坏 += 1;
    }
    say();
  }

  say(杠);
  say(
    坏 === 0
      ? `结论：全绿（${待投.length} 个单元投完，没有被拒的题）`
      : `结论：🔴 ${坏} 处有问题（哪一处见上面输出）`,
  );
  say(杠);
  return 坏 === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeCoreDb();
    process.exit(code);
  })
  .catch(async (e: unknown) => {
    say(
      `🔴 未处理的异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    await closeCoreDb();
    process.exit(1);
  });
