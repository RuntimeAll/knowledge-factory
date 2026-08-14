/**
 * 队列 · 驳回确认（AI:PRD-003 · 003-D；定式沿用 002-D；AI:PRD-009 打磨批换壳）
 *
 * 🔴 驳回是终态、不可再裁，所以单独一页：把工单正文完整摊开，逼你写一句理由再按。
 *    理由落 review_queue.verdict_note —— 没有理由的驳回，下次同样的东西还会再来一遍，
 *    而没人记得上次为什么否了它。
 *
 * 🔴 一页分派两条链：kind='图片' 的驳回要顺手把题干图判 rejected（core 的
 *    rejectFigureReview），其余类别只是表个态（verdictQueueItem）。
 *    分派放在页面而不是 action 里，是因为**按钮上的话不一样**：
 *    图审驳回要告诉人「题会继续挂着必审」，泛泛的驳回没有这回事。
 *
 * ── AI:PRD-009 打磨（只动版面与交互）────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；确认按钮统一 ConfirmSubmit 弹层（检查单 7）；
 *   图审这条链把「看这道题」的链接补上（检查单 4 看到即可达）；
 *   配图给 max-width:100% —— 手机上不再横向撑破（检查单 5）。
 */
import { Alert, Card, Input, Tag } from "antd";
import Link from "next/link";

import {
  DataSourceNote,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import { getFigureReviewCard, getQueueItem, type FigureView } from "~/core";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { KV } from "~/components/console/table";
import { rejectFigureAction, verdictQueueAction } from "../../actions";

export const dynamic = "force-dynamic";

function pretty(json: string | null): string {
  if (!json) return "（空）";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default async function RejectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);

  let item = null;
  let error: string | null = null;
  try {
    item = await getQueueItem(id);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (!item) {
    return (
      <>
        <PageHead title="驳回工单" sub="这条工单打不开" />
        <Alert
          type="error"
          showIcon
          message={error ? "工单读不出来（原文照登）" : "这条工单不在库里"}
          description={
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {error ?? `review_queue 里没有 id = ${id} 这一行。`}
            </div>
          }
        />
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          <Link href="/queue">← 回处置台</Link>
        </div>
      </>
    );
  }

  const 图审 = item.kind === "图片";
  let 图: FigureView[] = [];
  let 题面: string | null = null;
  let 题id: string | null = null;
  if (图审) {
    try {
      const card = await getFigureReviewCard(item.id);
      图 = card.figures;
      题面 = card.question?.stem ?? null;
      题id = card.question?.id ?? null;
    } catch {
      /* 读不出来不挡驳回：下面 payload 原样还在 */
    }
  }
  const 已裁 = item.state !== "open";

  return (
    <>
      <PageHead
        title={图审 ? "驳回这张图？" : "驳回这条工单？"}
        tags={<StatusTag value={item.state} />}
        sub="驳回是终态：落 verdict_note，之后不可再裁"
        right={
          <DataSourceNote>
            core.getQueueItem{图审 ? " / core.getFigureReviewCard" : ""} · 写走{" "}
            {图审 ? "core.rejectFigureReview" : "core.verdictQueueItem"}
            （含审计行）
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
        <Link href="/queue">← 回处置台</Link>
        <IdTail id={item.id} />
        {题id ? <Link href={`/question/${题id}`}>看这道题 →</Link> : null}
      </div>

      <Card size="small" title={item.kind ?? "（未分类）"}>
        <KV k="开单时间" v={<TimeText iso={item.createdAt} />} />
        <KV k="理由" v={item.reason ?? "（没写）"} />
        {item.refType || item.refId ? (
          <KV k="指向" v={`${item.refType ?? "?"} · ${item.refId ?? "?"}`} />
        ) : null}
        {题面 ? <KV k="题面" v={题面} /> : null}

        {图.length > 0 ? (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            {图.map((f) =>
              f.hash ? (
                // eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节
                <img
                  key={f.id}
                  src={`/api/asset/${f.hash}`}
                  alt={`配图 ${f.role ?? ""}`}
                  style={{
                    maxHeight: 220,
                    maxWidth: "100%",
                    border: "1px solid #ebeef5",
                    background: "#fff",
                  }}
                />
              ) : null,
            )}
          </div>
        ) : null}

        <pre
          style={{
            background: "#f4f4f5",
            marginTop: 10,
            marginBottom: 0,
            padding: 8,
            maxHeight: 320,
            overflow: "auto",
            fontSize: 11.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {pretty(item.payloadJson)}
        </pre>
      </Card>

      {已裁 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message={`这条已经是 ${item.state} 了 —— 终态不重裁`}
          description={
            <span style={{ fontSize: 12.5 }}>
              {item.verdictBy ?? "未记名"} 于 {item.verdictAt ?? "时间未知"}{" "}
              裁的
              {item.verdictNote ? `：${item.verdictNote}` : ""}
            </span>
          }
        />
      ) : (
        <Card size="small" style={{ marginTop: 12 }}>
          <form action={图审 ? rejectFigureAction : verdictQueueAction}>
            <input type="hidden" name="id" value={item.id} />
            {图审 ? null : (
              <input type="hidden" name="verdict" value="rejected" />
            )}
            <label
              htmlFor="note"
              style={{
                display: "block",
                marginBottom: 4,
                fontSize: 11.5,
                letterSpacing: 1,
                color: "#909399",
              }}
            >
              驳回理由（落 verdict_note，别人日后看得见 · 必填）
            </label>
            <Input.TextArea
              id="note"
              name="note"
              rows={3}
              required
              placeholder={
                图审
                  ? "例：这张数轴图上的点位与题面 a<b<0<c 对不上，像是隔壁那题的图。"
                  : "例：这个说法指的是「有理数的混合运算」，不是新考点，别名已另行补。"
              }
            />
            {图审 ? (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11.5,
                  color: "#909399",
                  lineHeight: 1.8,
                }}
              >
                🔴 驳回后：题干图判 <b>rejected</b>，题<b>继续挂着必审</b>
                （review_required=1）， 系统<b>不会</b>自动把它隔离或退役 ——
                换图、改题还是退役，是你的决定。
              </div>
            ) : null}
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
              <ConfirmSubmit
                label="确认驳回"
                danger
                okText="驳回"
                title={图审 ? "驳回这张题干图？" : "驳回这条工单？"}
                description={
                  图审 ? (
                    <>
                      figure.review_state → <b>rejected</b>，本工单 →{" "}
                      <b>rejected</b>（理由落 verdict_note）。
                      <br />题<b>继续挂着必审</b>，不会被自动隔离或退役。
                      <br />
                      🔴 终态：驳回之后这条工单<b>不能再裁</b>。
                    </>
                  ) : (
                    <>
                      本工单 → <b>rejected</b>，理由落
                      verdict_note，另记一条审计行。
                      <br />
                      🔴 终态：驳回之后这条工单<b>不能再裁</b>
                      （要放行只能重新开一条新工单）。
                    </>
                  )
                }
              />
              <Link href="/queue" style={{ fontSize: 12.5 }}>
                取消，回处置台
              </Link>
              <Tag>理由没填会被浏览器拦下</Tag>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
