/**
 * 审计链校验（AI:PRD-001 · WP7，REG-A2 的载体）——薄脚本，逻辑全在 core/audit.ts。
 *
 * 用法：  pnpm exec tsx --env-file=.env scripts/audit-verify.ts [--json]
 * 退出码：0=链完好；1=断链（打印第一处断点的 seq 与因由）。
 *
 * 🔴 「从头重算」不是修辞：verifyAuditChain 从 seq 最小的一行开始，
 *    逐行用规范化串重算 prev_hash 与库里存的比对——不是抽查链尾。
 *    所以本关跑绿 = 全历史每一行都还是当初写下的样子。
 * 🔴 纯只读：本脚本一个字节都不往库里写（连 logMetric 都不打——
 *    校验动作若自己也往库里追行，下一次校验的对象就被这次校验改变了）。
 */
import { closeCoreDb, verifyAuditChain } from "../src/core/index";

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const r = await verifyAuditChain();

  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else if (r.ok) {
    const L = [
      "审计链完好（从创世行起逐行重算）",
      `  校验行数  ：${r.checkedRows}`,
      `  链尾 seq  ：${r.headSeq ?? "(空链)"}`,
      `  链尾 hash ：${r.nextPrevHash}`,
      "             ↑ 即下一行应携带的 prev_hash",
    ];
    process.stdout.write(L.join("\n") + "\n");
  } else {
    const L = [
      "🔴 审计链断了",
      `  断在 seq  ：${r.brokenAtSeq ?? "(未知)"}`,
      `  校验行数  ：${r.checkedRows}（断点之前完好的行数）`,
      `  因由      ：${r.reason ?? "(无因由)"}`,
      "",
      "audit_log 有 append-only 触发器守着，正常路径改不动它——" +
        "链断了要么是库文件被外部工具改过，要么是恢复用错了快照。",
    ];
    process.stdout.write(L.join("\n") + "\n");
  }

  await closeCoreDb();
  process.exitCode = r.ok ? 0 : 1;
}

void main();
