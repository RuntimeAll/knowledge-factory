/**
 * 恢复演练（AI:PRD-001 · WP4，验收 1-2 的载体）
 *
 * 用法：
 *   pnpm exec tsx --env-file=.env scripts/restore-drill.ts            # 只打印将要做什么，不动库
 *   pnpm exec tsx --env-file=.env scripts/restore-drill.ts --yes      # 真跑（🔴 会删掉并重建库文件）
 *   pnpm exec tsx --env-file=.env scripts/restore-drill.ts --yes --db file:./data/副本.db
 *
 * 八步（每步带时间戳打印，整段可直接贴进演练留档）：
 *   ① 安全闸：没有 --yes 就只说不做
 *   ② pre-restore 保命快照（万一后面炸了，回到这一份）
 *   ③ 经 core 造 10 行演练数据（roster: drill_01..drill_10）
 *   ④ 出演练快照，记住它的行数
 *   ⑤ 关连接，删库文件（含 -wal/-shm）
 *   ⑥ 把演练快照复制回库文件位置
 *   ⑦ 重开连接验收：审计链 ok + 对账六项无 red + 10 行演练数据点数对得上
 *   ⑧ 经 core 删掉演练数据（留审计痕），报 PASS/FAIL
 *
 * 🔴 R-SYS-0 的验收口径 = 「恢复后 integrity_check 全绿才算数」，所以第 ⑦ 步
 *    不是走个过场：链断了、对账红了，这次演练就是 FAIL，别粉饰。
 * 🔴 本卡不在真库上跑 --yes（实现 + 副本自测为止），真库演练由总指挥亲自跑。
 *
 * ⚠️ 环境坑（2026-08-12 实测，给后来的 agent）：在 **Claude Code 的沙箱 bash** 里跑
 *    --yes 会**静默死在第 5 步**（无任何输出、退出码 127）——沙箱会拦/改写带中文的
 *    绝对路径 unlink：rmSync 不抛错但文件还在，existsSync 还会给出错误答案。
 *    这是沙箱的锅，不是脚本的锅：换 ASCII 文件名的副本（--db file:./data/_drill/kf-drill.db）
 *    立刻八步全过。真人在普通 PowerShell 里跑真库不受影响。
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { inArray } from "drizzle-orm";

import {
  backupNow,
  createCoreDb,
  dbUrlToPath,
  integrityCheck,
  nowLocalISO,
  verifyAuditChain,
  withCoreWrite,
  type CoreDbHandle,
} from "../src/core/index";
import { roster } from "../src/server/db/schema";

const DRILL_CODES = Array.from(
  { length: 10 },
  (_, i) => `drill_${String(i + 1).padStart(2, "0")}`,
);
const DRILL_NOTE = "恢复演练数据（scripts/restore-drill.ts），演练结束即删";

let step = 0;
function say(msg: string): void {
  process.stdout.write(`[${nowLocalISO()}] ${msg}\n`);
}
function stage(msg: string): void {
  step += 1;
  say(`—— 第 ${step} 步 · ${msg}`);
}

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}

/**
 * Windows 上 close() 之后句柄释放晚一拍，删不掉就等一下再试。
 * 🔴 rmSync 不抛 ≠ 删掉了（某些沙箱/同步盘会静默吞掉 unlink）——一律以 existsSync 复核为准。
 */
async function removeWithRetry(path: string): Promise<void> {
  let lastErr = "";
  for (let i = 0; i < 20; i++) {
    if (!existsSync(path)) {
      if (i > 0) say(`  ${path} 已删除（第 ${i + 1} 次尝试）`);
      return;
    }
    try {
      rmSync(path, { force: true });
    } catch (e) {
      lastErr = (e as NodeJS.ErrnoException).code ?? String(e);
    }
    await sleep(100);
  }
  throw new Error(
    `删不掉 ${path}（最后一次错误：${lastErr || "rmSync 没报错但文件还在"}）——` +
      "文件被占用？先关掉 Next dev / DB 客户端再来",
  );
}

async function countDrillRows(h: CoreDbHandle): Promise<number> {
  // 🔴 用 IN + 参数，不用 LIKE 'drill\_%'：`_` 是 LIKE 通配符，转义在模板串里极易被吃掉
  const r = await h.client.execute({
    sql: `SELECT COUNT(*) AS c FROM roster WHERE code IN (${DRILL_CODES.map(() => "?").join(",")})`,
    args: DRILL_CODES,
  });
  return Number((r.rows[0] as unknown as { c: number | bigint }).c);
}

async function main(): Promise<void> {
  const yes = process.argv.includes("--yes");
  const url = argValue("--db") ?? process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL 没设，也没给 --db，不知道演练哪个库");
  const dbPath = dbUrlToPath(url);

  stage("安全闸");
  say(`目标库：${dbPath}`);
  if (!yes) {
    const plan = [
      "  未带 --yes，只说不做。带上 --yes 会依次：",
      "    ② 出 pre-restore 保命快照",
      "    ③ 经 core 造 10 行演练数据（roster drill_01..drill_10）",
      "    ④ 出演练快照",
      `    ⑤ 🔴 删掉库文件 ${dbPath}（含 -wal/-shm）`,
      "    ⑥ 用演练快照复原",
      "    ⑦ 验收：审计链 + 对账六项 + 演练数据点数",
      "    ⑧ 删掉演练数据（留审计痕）",
      "",
      "  真库演练前请确认：Next dev / DB 客户端都没连着这个库。",
    ];
    process.stdout.write(plan.join("\n") + "\n");
    return;
  }
  if (!existsSync(dbPath)) throw new Error(`库文件不在：${dbPath}`);

  let handle = await createCoreDb(url);
  let ok = true;
  const problems: string[] = [];

  try {
    if ((await countDrillRows(handle)) > 0) {
      throw new Error(
        "库里已经有 drill_* 演练数据（上一次演练没收尾？）——先清干净再跑，免得把脏数据当成演练结果",
      );
    }

    stage("pre-restore 保命快照");
    const safety = await backupNow({ reason: "pre-restore" }, handle);
    say(
      `保命快照：${safety.path}（${safety.bytes} 字节，audit_log=${safety.snapshotRowCounts.audit_log}）`,
    );

    stage("经 core 造 10 行演练数据");
    const receipt = await withCoreWrite(
      {
        actor: "system",
        tool: "restore_drill_seed",
        args: { codes: DRILL_CODES },
      },
      async (tx) => {
        for (const code of DRILL_CODES) {
          await tx.insert(roster).values({
            code,
            alias: code,
            status: "active",
            joinedAt: nowLocalISO(),
            note: DRILL_NOTE,
          });
        }
        return DRILL_CODES.map((code) => ({
          table: "roster",
          id: code,
          op: "insert" as const,
        }));
      },
      handle,
    );
    say(`写入 10 行，审计行 seq=${receipt.seq}`);

    stage("出演练快照");
    const snap = await backupNow({ reason: "manual" }, handle);
    say(
      `演练快照：${snap.path}（${snap.bytes} 字节，表 ${snap.tables} 张，audit_log=${snap.snapshotRowCounts.audit_log}）`,
    );

    stage("关连接 + 删库文件");
    handle.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await removeWithRetry(dbPath + suffix);
    }
    say(`已删除 ${dbPath}（含 -wal/-shm/-journal）；此刻库是真的没了`);

    stage("用演练快照复原");
    copyFileSync(snap.path, dbPath);
    say(`复原自 ${snap.path}`);

    stage("重开连接验收");
    handle = await createCoreDb(url);

    const chain = await verifyAuditChain(handle);
    say(
      `审计链：ok=${chain.ok} 校验 ${chain.checkedRows} 行，链尾 seq=${chain.headSeq ?? "(空链)"}`,
    );
    if (!chain.ok) {
      ok = false;
      problems.push(`审计链断了：${chain.reason ?? "(无因由)"}`);
    }

    const report = await integrityCheck({ handle });
    for (const c of report.checks) {
      const flag = c.ok ? "OK  " : c.level === "red" ? "RED " : "WARN";
      say(`对账 ${c.id} [${flag}] ${c.name}`);
      for (const d of c.details) say(`        ${d}`);
    }
    if (!report.ok) {
      ok = false;
      problems.push(
        `对账有 red：${report.checks
          .filter((c) => !c.ok && c.level === "red")
          .map((c) => c.id)
          .join("、")}`,
      );
    }

    const n = await countDrillRows(handle);
    say(`演练数据点数：${n}/10`);
    if (n !== 10) {
      ok = false;
      problems.push(`演练数据只剩 ${n} 行，快照没把它们带过来`);
    }

    stage("删掉演练数据（留审计痕）");
    const cleanup = await withCoreWrite(
      {
        actor: "system",
        tool: "restore_drill_cleanup",
        args: { codes: DRILL_CODES },
      },
      async (tx) => {
        await tx.delete(roster).where(inArray(roster.code, DRILL_CODES));
        return DRILL_CODES.map((code) => ({
          table: "roster",
          id: code,
          op: "delete" as const,
        }));
      },
      handle,
    );
    const left = await countDrillRows(handle);
    say(`清理完成（审计行 seq=${cleanup.seq}），剩余演练行 ${left}`);
    if (left !== 0) {
      ok = false;
      problems.push(`演练数据没删干净，还剩 ${left} 行`);
    }
  } catch (e) {
    ok = false;
    problems.push(String(e));
  } finally {
    handle.close();
  }

  say("=".repeat(60));
  if (ok) {
    say("恢复演练 PASS —— 快照能开、链没断、对账无 red、数据点数对得上");
  } else {
    say("恢复演练 FAIL：");
    for (const p of problems) say(`  · ${p}`);
    say(
      "🔴 保命快照在 data/backup/ 里（reason=pre-restore 的那份），必要时手工复原",
    );
    process.exitCode = 1;
  }
}

void main();
