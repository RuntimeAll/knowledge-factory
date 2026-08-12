/**
 * 对账六项 C1~C6（AI:PRD-001 · WP4，REG-A1 的载体）——薄脚本，逻辑全在 core/integrity.ts。
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/integrity-check.ts [--json]
 * 退出码 = **red 项数**（0=可以放行；warn 不计入，M1 明写 warn 不红拦）。
 *
 * 🔴 只读 + 一条 logMetric('integrity_check')：跑一次就在库里留一条账。
 */
import { closeCoreDb, closeGradingDb, integrityCheck } from "../src/core/index";

function mark(ok: boolean, level: string): string {
  if (ok) return "[✔ OK  ]";
  return level === "red" ? "[✘ RED ]" : "[⚠ WARN]";
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const report = await integrityCheck();

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const L: string[] = [];
    L.push("=".repeat(78));
    L.push(`对账六项 · ${report.generatedAt}`);
    L.push("=".repeat(78));
    for (const c of report.checks) {
      L.push(`${mark(c.ok, c.level)} ${c.id} ${c.name}`);
      if (c.stats) {
        L.push(
          "         " +
            Object.entries(c.stats)
              .map(([k, v]) => `${k}=${v}`)
              .join("  "),
        );
      }
      for (const d of c.details) L.push(`         ${d}`);
    }
    L.push("-".repeat(78));
    const reds = report.checks.filter((c) => !c.ok && c.level === "red");
    const warns = report.checks.filter((c) => !c.ok && c.level === "warn");
    L.push(
      `结论：${report.ok ? "绿（无 red）" : "红"}` +
        `　red=${reds.length}${reds.length ? `（${reds.map((c) => c.id).join("、")}）` : ""}` +
        `　warn=${warns.length}${warns.length ? `（${warns.map((c) => c.id).join("、")}）` : ""}`,
    );
    process.stdout.write(L.join("\n") + "\n");
  }

  const redCount = report.checks.filter(
    (c) => !c.ok && c.level === "red",
  ).length;
  closeGradingDb();
  await closeCoreDb();
  process.exitCode = redCount;
}

void main();
