/**
 * GET /api/shelf/file?p=<绝对路径>[&download=1] —— 货架产物件的字节服务
 * （AI:PRD-009 · D-B「图片预览走新只读静态 route，路径白名单限 punch 资产目录」）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本路由服务的是 **punch 库（`举一反三产物/资料库.db`）账上登记的产物件**，
 *      与本库内容寻址仓 `/api/asset/<hash>` 是**两条不同的路**：
 *        · 本库那条以内容 hash 入口，文件在 `data/assets/<sha256>.<ext>`；
 *        · 这条以**本机绝对路径**入口，文件散在 `举一反三产物/` 的册目录里
 *          （punch 的 asset.路径 存的就是绝对路径，这是那条产线的路径哲学）。
 *      两条路都遵守同一条铁律：**库里查不到登记行的文件视同不存在**。
 * 🔴🔴 punch 库 mode=ro，本路由只读文件、零写。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 为什么必须有它：`asset.路径` 是 `D:\workplace\…` 这样的**本机绝对路径**，
 *    在电脑上还能复制去资源管理器，**在手机上完全没用**（手机没有 D 盘）。
 *    要「打开就能看、长按就能存」，只能由服务端把字节吐出来。
 *
 * 🔴🔴 必须 readFileSync 一次读完直返，**绝不 Node 流硬转 Web ReadableStream**：
 *    punch-console 上流过血 —— `createReadStream() as unknown as ReadableStream`
 *    骗过了 TS 骗不过运行时，客户端一中断（PDF 预览器发 Range、或点开就关），
 *    错误抛在流的回调里、没有任何 try/catch 接得住 → uncaughtException →
 *    整个 dev server 处理链受损，表现是「页面一片灰」，极难往这儿想。
 *    这里的文件是图和 PDF（几百 KB ~ 几 MB），整读进内存毫无压力。
 *
 * 四道闸（登记 / 边界 / 类型 / 体积）全在 core 的 grantPunchFile 里，
 * 本文件只负责把放行结果变成 HTTP —— 闸不许在这儿再写一套。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { grantPunchFile } from "~/core";

export const runtime = "nodejs";
/** 产物会被覆盖重出（改一版重跑一次脚本），不能构建期预取 */
export const dynamic = "force-dynamic";

function 说不清(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams.get("p") ?? "";
  const download = url.searchParams.get("download") === "1";

  let grant;
  try {
    grant = await grantPunchFile(p);
  } catch (e) {
    // 库读不动是环境问题（多半是 PUNCH_DB_URL 没配），不是「这张图不存在」——
    // 别把 500 伪装成 404。
    return 说不清(
      `货架库读不动，放行闸没法判：${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }
  if (!grant.ok) return 说不清(grant.reason, grant.status);

  let bytes: Buffer;
  try {
    bytes = readFileSync(grant.absPath);
  } catch (e) {
    return 说不清(
      `文件读不动：${grant.absPath}（${e instanceof Error ? e.message : String(e)}）`,
      500,
    );
  }

  // 文件名含中文，必须走 filename*=UTF-8''，否则手机上存下来是乱码
  const 文件名 = encodeURIComponent(basename(grant.absPath));
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": grant.mime,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${文件名}`,
      // 🔴 产物会被覆盖重出（同一路径换内容），绝不能让浏览器把旧图缓存住 ——
      //    这一点与内容寻址的 /api/asset/<hash>（可 immutable 永久缓存）正相反。
      "Cache-Control": "no-cache",
    },
  });
}
