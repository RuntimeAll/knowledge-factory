/**
 * scripts/kb-ingest.mts —— **标准 kb-ingest/v1 载荷的直投口**
 *
 *   pnpm kb:ingest <载荷.json> [--real]
 *
 * 与 `kb:submit` 的分工（🔴 别混）：
 *   · `kb:submit`  吃**产线出料**（punch-ingest/v1 对象根/数组根、群卷题单），
 *                  先 convertPunchIngest 搬成 kb-ingest/v1 再投；认不出的形态整批拒。
 *   · `kb:ingest`（本文件）吃**已经是 kb-ingest/v1 的载荷**（contract/source/sourceDoc/items），
 *                  直接喂契约正本钦定的唯一入口 `runIngestBatch`。
 *
 * 为什么要有它（2026-08-15 录奥数角度题 12 题时暴露）：教辅/试卷/手工转录这类料
 * 天生就写成 kb-ingest/v1（要带 analysis、figures、prov.page，punch 三形态都表达不了），
 * 却没有命令行入口 —— 当时只能临时写脚本，属于「闸都在、门没开」。
 *
 * 默认 **dry-run**（跑完全套闸、库与磁盘零变化），`--real` 才真写。
 * 退出码：0=没有红灯；1=有题被拒/被隔离（看输出）；2=载荷读不了。
 */
import { readFileSync } from "node:fs";

import { closeCoreDb, runIngestBatch } from "../src/core/index";

const say = (s = ""): void => void process.stdout.write(s + "\n");

const file = process.argv[2];
const real = process.argv.includes("--real");

if (!file || file.startsWith("--")) {
  say("用法：pnpm kb:ingest <载荷.json> [--real]");
  process.exit(2);
}

let payload: unknown;
try {
  payload = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  say(
    `🔴 载荷读不了：${file}\n   ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(2);
}

const r = await runIngestBatch(payload, { actor: "human", dryRun: !real });

say("=".repeat(70));
say(
  `模式 ${real ? "🔴 真投" : "dry-run（库零变化）"}   批次 ${r.batchId ?? "（未写库）"}`,
);
say(
  `总 ${r.counts.total} · 收 ${r.counts.accepted} · 排队人审 ${r.counts.queued} · 拒 ${r.counts.rejected}`,
);
say("-".repeat(70));

for (const it of r.gateReport.items) {
  const red = it.gates.items.filter((g) => g.status === "red");
  const yellow = it.gates.items.filter((g) => g.status === "yellow");
  const tag = red.length > 0 ? "🔴" : yellow.length > 0 ? "🟡" : "🟢";
  const notes = [...red, ...yellow]
    .map((g) => `${g.gate}: ${g.message ?? g.status}`)
    .join("\n     ");
  say(`${tag} seq=${it.seq}${notes ? "\n     " + notes : ""}`);
}

if (!real) {
  say("-".repeat(70));
  say("零红灯就加 --real 真投（真投会写库 + 出收批快照）。");
}

await closeCoreDb();
process.exit(r.counts.rejected > 0 ? 1 : 0);
