/**
 * app/api/asset/[hash] —— 资产字节服务（AI:PRD-003 · 003-D）
 *
 * 图审要看图，页面就得有个 `<img src>` 指得到的地方。入口是**内容 hash**，
 * 不是路径：落地路径一律从 `asset` 表读（core/assets.ts），外面拼不出别的路径来。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 必须 readFileSync 直返 Buffer，不许「Node 流硬转 Web 流」
 *
 *   punch-console 上流过血：`Readable.toWeb()` 包出来的流一旦被中断（用户划走、
 *   浏览器取消请求），错误抛在流的回调里 —— 那不在任何 try/catch 的作用域内，
 *   直接变成 **uncaughtException 把整个 dev server 打死**。
 *   本地资产就是几十 KB 的题图，同步读一次的代价远小于「服务偶尔猝死」。
 *
 * 🔴 「库里查不到登记行的文件，视同不存在」——404。
 *    assets/ 里有一个没有登记行的文件，本身就是对账 C1(c) 要抓的事故；
 *    给它开一条读得出去的路，等于把红旗按灭（理由详见 core/assets.ts 文件头）。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from "node:fs";

import { getAssetByHash } from "~/core";

/** core 要 node:fs / @libsql/client，edge runtime 跑不了。 */
export const runtime = "nodejs";
/** 资产是「此刻盘上那份」，构建期预取没有意义。 */
export const dynamic = "force-dynamic";

function 说不清(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const { hash: raw } = await ctx.params;
  const hash = decodeURIComponent(raw ?? "").trim();

  let rec;
  try {
    rec = await getAssetByHash(hash);
  } catch (e) {
    // 🔴 库读不动是环境问题，不是「这张图不存在」——别把 500 伪装成 404
    return 说不清(
      `读资产登记行失败：${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  if (!rec) {
    return 说不清(
      `asset 表里没有 hash=${hash} 的登记行 —— 库里查不到登记行的文件视同不存在。`,
      404,
    );
  }
  if (!rec.exists) {
    return 说不清(
      `登记行在（${rec.id}），文件却不在盘上：${rec.absPath}\n` +
        "这正是对账 C1(c)「有登记行找不到文件」要抓的红旗，去跑一次 integrity_check。",
      404,
    );
  }

  // 🔴 同步读、直接把 Buffer 交给 Response（见文件头：绝不 Node 流转 Web 流）
  let bytes: Buffer;
  try {
    bytes = readFileSync(rec.absPath);
  } catch (e) {
    return 说不清(
      `文件读不动：${rec.absPath}（${e instanceof Error ? e.message : String(e)}）`,
      500,
    );
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": rec.contentType,
      "Content-Length": String(bytes.byteLength),
      // 内容寻址 ⇒ 同一个 hash 永远是同一份字节，缓存住没有风险
      "Cache-Control": "public, max-age=31536000, immutable",
      // 图审页面直接 <img>，不当附件下载
      "Content-Disposition": `inline; filename="${rec.path}"`,
    },
  });
}
