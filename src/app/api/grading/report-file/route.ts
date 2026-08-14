/**
 * `GET /api/grading/report-file?code=<代号>&file=<文件名>[&dl=1]`
 *   —— 报告 PNG 的字节服务（AI:PRD-008 · PRD-027 交互面）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **只读**：报告是产线出的件（`订阅特训/学员/<代号>/报告/`，跨线契约 §一
 *      归 PRD-027），本产品只把字节端出来给人预览/取件，一个字节都不写。
 *
 * 🔴 路径不是拼出来的：`code`/`file` 先经 report-scan 的 `resolveReportFile`
 *    在**扫描结果**里对上号才拿得到绝对路径 —— 扫不出来的文件对本页就是不存在。
 *    （拼路径 = 给 `..`、盘符、绝对路径留门；本地单人也不给自己留这种门。）
 *
 * 🔴 必须 readFileSync 直返 Buffer，不许「Node 流硬转 Web 流」——
 *    punch-console 流过血：`Readable.toWeb()` 的流被中断时错误抛在流回调里，
 *    不在任何 try/catch 作用域内，直接 uncaughtException 打死 dev server。
 *    （同 `/api/asset/[hash]` 的文件头，一份教训两处照做。）
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";

import { resolveReportFile } from "~/app/grading/report-scan";

export const runtime = "nodejs";
/** 报告是「此刻盘上那份」，构建期预取没有意义 */
export const dynamic = "force-dynamic";

function 说不清(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function GET(req: Request): Response {
  const sp = new URL(req.url).searchParams;
  const code = (sp.get("code") ?? "").trim();
  const file = (sp.get("file") ?? "").trim();
  const 下载 = sp.get("dl") === "1";

  if (!code || !file) {
    return 说不清("要 code 与 file 两个参数（都取自报告架列表那一行）。", 400);
  }

  let abs: string | null;
  try {
    abs = resolveReportFile(code, file);
  } catch (e) {
    return 说不清(
      `扫报告目录失败：${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
  if (!abs) {
    return 说不清(
      `扫不到这份报告：学员「${code}」下没有名为「${file}」的 png。\n` +
        "（本路由只认扫描结果里的文件名——路径不是拼出来的。刷新一下报告架看看它还在不在。）",
      404,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (e) {
    return 说不清(
      `文件读不动：${abs}（${e instanceof Error ? e.message : String(e)}）`,
      500,
    );
  }

  // 文件名里有中文 → Content-Disposition 用 RFC 5987 的 filename*
  const 编码名 = encodeURIComponent(file);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      // 🔴 不缓存：报告可能被产线重出（同名覆盖），缓存住会让人看着旧图当新的
      "Cache-Control": "no-store",
      "Content-Disposition": `${下载 ? "attachment" : "inline"}; filename*=UTF-8''${编码名}`,
    },
  });
}
