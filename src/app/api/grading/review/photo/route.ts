/**
 * `GET /api/grading/review/photo?code=<代号>&day=<天>&page=<页>` —— 原卷照片字节
 * （AI:PRD-009 · 设计稿 §一 D-A；等价于审核台的 `/photo?s=&d=&p=`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 **只读**：照片是产线运行态（`订阅特训/学员/<代号>/批改拍照/第NN天/照片-pN.jpg`），
 *      本产品一个字节都不写。它也是判定的**证据**——不缩放、不转码、原样端出去。
 *
 * 🔴 路径三道校验，缺一不可：
 *   ① 代号过 `safeCode()`（分隔符 / `..` / 控制字符 / 盘符冒号一律拒）；
 *   ② 天与页必须是小整数（页号来自库里的 `items.page`，不是人手敲的）；
 *   ③ 拼出来的绝对路径 `realpath` 之后**必须落在 `订阅特训/学员/` 之下**
 *      —— 与审核台 `_file()` 同一道闸。本地单人也不给自己留穿越的门。
 *
 * 🔴 必须 `readFileSync` 直返 Buffer，不许「Node 流硬转 Web 流」：
 *    punch-console 流过血（`Readable.toWeb()` 的流被中断时错误抛在流回调里，
 *    不在任何 try/catch 作用域内 → uncaughtException 打死 dev server）。
 *    同 `/api/asset/[hash]`、`/api/grading/report-file`，一份教训三处照做。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";

import { photoFileOf, safeCode, studentsRoot } from "~/app/grading/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function 说不清(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** realpath 归一（Windows 上盘符大小写 + 短名 8.3 都可能不一致） */
function 归一(p: string): string {
  try {
    return realpathSync(p).replace(/\\/g, "/").replace(/\/+$/, "");
  } catch {
    return p.replace(/\\/g, "/").replace(/\/+$/, "");
  }
}

export function GET(req: Request): Response {
  const sp = new URL(req.url).searchParams;
  const codeRaw = (sp.get("code") ?? "").trim();
  const dayRaw = (sp.get("day") ?? "").trim();
  const pageRaw = (sp.get("page") ?? "").trim();

  // 🔴 审核台的 do_GET 没有 try：缺参数直接 KeyError/ValueError 断连，客户端拿不到错误体。
  //    这里参数不全一律给 400 + 人话（前端 <img> 拿到的也是可读文本，不是空白）。
  if (!codeRaw || !dayRaw || !pageRaw) {
    return 说不清(
      "要 code、day、page 三个参数（页号取自库里的 items.page）。",
      400,
    );
  }
  const code = safeCode(codeRaw);
  if (!code) {
    return 说不清(
      `代号 ${JSON.stringify(codeRaw)} 不能当目录名（含路径分隔符 / 上跳 / 控制字符，或太长）。`,
      400,
    );
  }
  const day = Number(dayRaw);
  const page = Number(pageRaw);
  if (!Number.isInteger(day) || day < 0 || day > 999) {
    return 说不清(`天号 ${JSON.stringify(dayRaw)} 不是 0~999 的整数。`, 400);
  }
  if (!Number.isInteger(page) || page < 1 || page > 99) {
    return 说不清(`页号 ${JSON.stringify(pageRaw)} 不是 1~99 的整数。`, 400);
  }

  const abs = photoFileOf(code, day, page);
  if (!existsSync(abs)) {
    return 说不清(
      `这一页原图不在盘上：${abs}\n` +
        "（页号来自库里的 items.page —— 库说有这一页、盘上没有，那就是照片缺了，" +
        "不是本路由的故障。去看一眼收卷那一段。）",
      404,
    );
  }

  // ③ 穿越闸：realpath 必须落在 学员/ 之下（与审核台 _file() 同一道）
  const 根 = 归一(studentsRoot());
  const 实 = 归一(abs);
  if (实 !== 根 && !实.startsWith(`${根}/`)) {
    return 说不清(`拒绝：解析出来的真实路径不在 ${根} 之下（${实}）。`, 403);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(实);
  } catch (e) {
    return 说不清(
      `文件读不动：${实}（${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}）`,
      500,
    );
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      // 🔴 不缓存：同一天的照片可能被重拍覆盖，缓存住会让人对着旧图下终审
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(
        `${code}-第${day}天-p${page}.jpg`,
      )}`,
    },
  });
}
