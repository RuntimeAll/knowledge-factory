/**
 * 报告架的盘上扫描（AI:PRD-008 · PRD-027 交互面）—— 🔒 只读，server only
 *
 * 🔴 单独一个文件的理由：Next 的 route.ts **只准导出 GET/POST/runtime/dynamic 这几样**，
 *    多导出一个函数就是构建期类型错误。列表路由与取件路由都要用这两个函数，
 *    所以它们住在这儿，不住在任何一个 route.ts 里。
 * 🔴 全程只读：readdir / stat / readFile —— 学员运行态目录归产线（跨线契约 §一），
 *    本产品一个字节都不写、不改名、不删。
 */
import { existsSync, readdirSync } from "node:fs";

import { reportDirOf, studentsRoot, underRoot } from "./paths";

export interface ScannedReport {
  /** 学员代号（= 目录名） */
  code: string;
  file: string;
  abs: string;
}

export interface ScanResult {
  files: ScannedReport[];
  warnings: string[];
}

function 原文(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** `第02天学情分析.png` → 2；文件名里没有天号就返回 null（**不猜**） */
export function dayOfReportName(name: string): number | null {
  const m = /第\s*0*(\d+)\s*天/.exec(name);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 扫 `订阅特训/学员/<代号>/报告/*.png`。
 * 目录不存在 = 还没出过件（或路径没配对），如实进 warnings，不当故障抛。
 */
export function scanReports(root: string = studentsRoot()): ScanResult {
  const warnings: string[] = [];
  const files: ScannedReport[] = [];

  if (!existsSync(root)) {
    warnings.push(
      `学员运行态目录不存在：${root} —— 报告架是空的。「没有报告」不等于「没出过件」：` +
        "先确认这就是你要扫的目录（AI_BKB_ROOT / GRADING_STUDENTS_ROOT）。",
    );
    return { files, warnings };
  }

  let 学员目录: string[];
  try {
    学员目录 = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    warnings.push(`列学员目录失败：${root}（${原文(e)}）`);
    return { files, warnings };
  }

  for (const code of 学员目录) {
    const dir = reportDirOf(code);
    if (!existsSync(dir)) continue; // 没出过件的学员没有 报告/ 目录，正常
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        if (!f.name.toLowerCase().endsWith(".png")) continue;
        files.push({ code, file: f.name, abs: underRoot(dir, f.name) });
      }
    } catch (e) {
      warnings.push(`列报告目录失败：${dir}（${原文(e)}）`);
    }
  }
  return { files, warnings };
}

/**
 * 取件时的**唯一**路径解析：重新扫一遍目录，只认扫得出来的那个文件名。
 *
 * 🔴 不拿用户传来的字符串去拼路径 —— 拼出来的路径可能指到目录外面去
 *    （`..`、绝对路径、Windows 盘符…）。「必须在扫描结果里」是最硬的一道闸：
 *    扫不出来的文件，对本页而言就不存在。
 */
export function resolveReportFile(code: string, file: string): string | null {
  const hit = scanReports().files.find(
    (f) => f.code === code && f.file === file,
  );
  return hit ? hit.abs : null;
}
