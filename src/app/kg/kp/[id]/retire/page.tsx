/**
 * KG 治理 · 退役确认（AI:PRD-002 · 002-D；AI:PRD-009 换壳）
 *
 * 🔴 退役是破坏性动作，所以有这一页：先把「它身上还挂着什么」摆出来，再让人按第二次。
 *    页面上的计数只是**预判**，真正的判据在 retireKp 的事务里现算（引用非 0 会被拒）。
 * 🔴 页面不给 force 开关：强退会留下对账 C2 红旗，那种事得有人在命令行里
 *    显式写 force:true 才配发生，不该是一个按钮。
 *
 * ── AI:PRD-009 打磨（只动版面与交互）────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；确认按钮统一走 ConfirmSubmit 弹层、
 *   影响面写在弹层里（检查单 7）；**有引用时按钮直接禁用**并说明为什么
 *   ——core 反正会拒，让人点一下再吃一个红条不算「如实」，那叫白走一趟（检查单 9）。
 */
import { Alert, Card } from "antd";
import Link from "next/link";

import { DataSourceNote, IdTail, StatusTag } from "~/components/console/ui";
import { KpNotFoundError, kpContext, kpRefCounts } from "~/core";
import { retireKpAction } from "../../../actions";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { KV, Num } from "~/components/console/table";
export const dynamic = "force-dynamic";

export default async function RetirePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  let name = id;
  let status = "?";
  try {
    const card = await kpContext(id);
    name = card.kp.name;
    status = card.kp.status;
  } catch (e) {
    if (e instanceof KpNotFoundError) {
      return (
        <>
          <PageHead title="退役考点" sub="这个考点不在库里" />
          <Alert
            type="error"
            showIcon
            message="查无此考点（原文照登）"
            description={
              <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                {e.message}
              </span>
            }
          />
          <div style={{ marginTop: 14, fontSize: 12.5 }}>
            <Link href="/kg">← 回知识图谱总览</Link>
          </div>
        </>
      );
    }
    throw e;
  }

  const refs = await kpRefCounts(id);
  // 🔴 KpRefCounts 没有索引签名，Object.entries 会退化成 [string, any][]
  //    （值一进 JSX 就是 any）—— 显式钉成 number，别让 any 漏进渲染层。
  const 明细 = (Object.entries(refs) as [string, number][]).filter(
    ([k]) => k !== "合计",
  );
  const 有引用 = refs.合计 > 0;

  return (
    <>
      <PageHead
        title={`退役「${name}」？`}
        tags={<StatusTag value={status} />}
        sub="退役 = 这个考点从此不可挂载（不是删除，行还在）"
        right={
          <DataSourceNote>
            core.kpContext / core.kpRefCounts（与 retireKp
            事务内现算的是同一份口径）
          </DataSourceNote>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          fontSize: 12.5,
        }}
      >
        <Link href={`/kg/kp/${id}`}>← 回考点详情</Link>
        <IdTail id={id} />
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <Card size="small" title="它身上还挂着什么（退役的判据）">
          {明细.map(([table, n]) => (
            <KV
              key={table}
              k={table}
              v={<Num n={n} tone={n > 0 ? "bad" : undefined} />}
            />
          ))}
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            合计 <Num n={refs.合计} big tone={有引用 ? "bad" : undefined} /> 条
            {有引用 ? (
              <span style={{ color: "#c45656" }}>
                {" "}
                —— 有引用的考点退役会被 core 拒（KP_HAS_REFS）
              </span>
            ) : (
              <span style={{ color: "#67c23a" }}> —— 干净，可以退役</span>
            )}
          </div>
        </Card>

        <Card size="small" title="退役会发生什么">
          <ul
            style={{
              margin: 0,
              paddingInlineStart: 18,
              fontSize: 12.5,
              lineHeight: 1.9,
            }}
          >
            <li>
              kp.status 改成 <code>retired</code>，从此<b>不能再挂</b>
              任何东西（挂了就是对账 C2 的悬挂引用）。
            </li>
            <li>
              它<b>不会</b>从检索里消失得干干净净：已经指向它的行还在， 所以
              core 默认拒绝带引用的退役。
            </li>
            <li>
              🔴 如果它其实是<b>重复考点</b>，别退役，走{" "}
              <Link href={`/kg/merge?from=${id}`}>合并</Link>
              ：合并会把引用整体搬到留下的那个考点上，旧 id 还查得到落点。
            </li>
          </ul>

          <form
            action={retireKpAction}
            style={{
              marginTop: 16,
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <input type="hidden" name="kpId" value={id} />
            <ConfirmSubmit
              label="确认退役"
              title={`把「${name}」退役？`}
              danger
              okText="退役"
              disabled={有引用}
              disabledReason={`身上还有 ${refs.合计} 条引用，core 会拒（KP_HAS_REFS）——重复考点请走合并`}
              description={
                <>
                  只改 <b>kp.status → retired</b> 这一格；行不删、id 仍查得到。
                  <br />
                  后果：它<b>不能再被挂</b>（新题挂上去就是对账 C2
                  的悬挂引用）， 按考点检索也不该再出现它。
                  <br />
                  想反悔：目前页面上<b>没有「取消退役」</b>这个动作， 要回来得走
                  core 的脚本口。
                </>
              }
            />
            <Link href={`/kg/kp/${id}`} style={{ fontSize: 12.5 }}>
              取消，回考点详情
            </Link>
            {有引用 ? (
              <span style={{ fontSize: 12, color: "#e6a23c" }}>
                点不了：身上还有 {refs.合计} 条引用 —— 先合并或先摘干净
              </span>
            ) : null}
          </form>
        </Card>
      </div>
    </>
  );
}
