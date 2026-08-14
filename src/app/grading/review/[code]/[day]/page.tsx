/**
 * 逐题终审（AI:PRD-009 · 设计稿 §二「/grading/review/[code]/[day]」）
 *
 * 职责：左原卷照片、右题单判定，每题 √ / × / 去掉，底部「确认这批」。
 * **不管**：出件（确认 ≠ 出件，2026-08-12 用户拍板 —— 报告要等 agent 写完
 *          英雄卡总结 + 错题诊断再跑 `python 审核库.py export`）。
 *
 * 🔴 读：审核.db 走 core 的 mode=ro 句柄；照片走只读字节路由。
 * 🔴 写：确认 / 打回 / 撤回三个动作**全部 spawn 圣域自己的 `审核库.py`**，
 *      本产品对审核.db 没有写句柄（设计稿 §一 D-A / §四 红线）。
 * 🔴 学员只代号。
 *
 * 本页是 server component 但**不取数**：批次内容随人点判定不断变，
 * 由 client 组件走 `/api/grading/review/batch` 取（与 /grading/board 同一套骨架）。
 */
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import { safeCode } from "~/app/grading/paths";
import { JudgeBoard } from "./judge";

export const dynamic = "force-dynamic";

export default async function ReviewBatchPage({
  params,
}: {
  params: Promise<{ code: string; day: string }>;
}) {
  const p = await params;
  const codeRaw = decodeURIComponent(p.code ?? "").trim();
  const code = safeCode(codeRaw);
  const day = Number(decodeURIComponent(p.day ?? "").trim());

  if (!code || !Number.isInteger(day) || day < 0 || day > 999) {
    return (
      <div style={{ fontSize: 13, lineHeight: 2 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>这个地址打不开</h1>
        <p>
          代号 {JSON.stringify(codeRaw)} / 天号 {JSON.stringify(p.day)} 不合法：
          代号要能当目录名（不含分隔符 / 上跳 / 控制字符），天号要是 0~999
          的整数。
        </p>
        <p>
          地址形如 <code>/grading/review/&lt;代号&gt;/&lt;第几次打卡&gt;</code>
          ，从 <Link href="/grading/review">终审台</Link> 或{" "}
          <Link href="/grading/board">批改看板</Link> 点进来最稳。
        </p>
      </div>
    );
  }

  return (
    <>
      <PageHead
        title={
          <>
            逐题终审 · {code} 第 {day} 次打卡
          </>
        }
        sub={<>黄底 = agent 存疑，必须人工定；全部定完才能确认保存</>}
        source={
          <>
            审核.db（mode=ro：batches / items / feedback）+ 原卷照片（学员/
            目录只读）；写 = spawn 订阅特训/_产线/审核库.py
          </>
        }
      />

      <JudgeBoard code={code} day={day} />
    </>
  );
}
