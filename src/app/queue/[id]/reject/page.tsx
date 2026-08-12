/**
 * 队列 · 驳回确认（AI:PRD-003 · 003-D；定式沿用 002-D）
 *
 * 🔴 驳回是终态、不可再裁，所以单独一页：把工单正文完整摊开，逼你写一句理由再按。
 *    理由落 review_queue.verdict_note —— 没有理由的驳回，下次同样的东西还会再来一遍，
 *    而没人记得上次为什么否了它。
 *
 * 🔴 一页分派两条链：kind='图片' 的驳回要顺手把题干图判 rejected（core 的
 *    rejectFigureReview），其余类别只是表个态（verdictQueueItem）。
 *    分派放在页面而不是 action 里，是因为**按钮上的话不一样**：
 *    图审驳回要告诉人「题会继续挂着必审」，泛泛的驳回没有这回事。
 */
import Link from "next/link";

import { Chip, PageHead, Panel, Row } from "~/components/kit";
import { getFigureReviewCard, getQueueItem, type FigureView } from "~/core";
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
    error = e instanceof Error ? e.message : String(e);
  }

  if (!item) {
    return (
      <>
        <PageHead
          title="驳回工单"
          sub={<span className="font-mono">{id}</span>}
        />
        <div className="text-pen text-[12.5px] whitespace-pre-wrap">
          {error ?? "这条工单不在库里。"}
        </div>
        <div className="mt-4 text-[12.5px]">
          <Link className="text-acc-deep underline" href="/queue">
            ← 回队列
          </Link>
        </div>
      </>
    );
  }

  const 图审 = item.kind === "图片";
  let 图: FigureView[] = [];
  let 题面: string | null = null;
  if (图审) {
    try {
      const card = await getFigureReviewCard(item.id);
      图 = card.figures;
      题面 = card.question?.stem ?? null;
    } catch {
      /* 读不出来不挡驳回：下面 payload 原样还在 */
    }
  }
  const 已裁 = item.state !== "open";

  return (
    <>
      <PageHead
        title={图审 ? "驳回这张图？" : "驳回这条工单？"}
        sub={<span className="font-mono">{item.id}</span>}
        right={
          <span className="flex items-baseline gap-2">
            <Chip tone={item.state === "open" ? "a" : "n"}>{item.state}</Chip>
            <Link
              className="text-acc-deep text-[12.5px] underline"
              href="/queue"
            >
              ← 队列
            </Link>
          </span>
        }
      />

      <Panel title={item.kind ?? "（未分类）"}>
        <Row k="开单时间" v={item.createdAt ?? "—"} />
        <Row k="理由" v={item.reason ?? "（没写）"} />
        {item.refType || item.refId ? (
          <Row k="指向" v={`${item.refType ?? "?"} · ${item.refId ?? "?"}`} />
        ) : null}
        {题面 ? <Row k="题面" v={题面} /> : null}

        {图.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-3">
            {图.map((f) =>
              f.hash ? (
                // eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节
                <img
                  key={f.id}
                  src={`/api/asset/${f.hash}`}
                  alt={`配图 ${f.role ?? ""}`}
                  className="border-hair2 max-h-[220px] rounded-[2px] border bg-white"
                />
              ) : null,
            )}
          </div>
        ) : null}

        <pre className="bg-code mt-2 max-h-[320px] overflow-auto rounded-[2px] p-2 text-[11.5px] whitespace-pre-wrap">
          {pretty(item.payloadJson)}
        </pre>
      </Panel>

      {已裁 ? (
        <div className="text-pen mt-4 text-[12.5px]">
          这条已经是 {item.state} 了（{item.verdictBy ?? "未记名"} 于{" "}
          {item.verdictAt ?? "时间未知"} 裁的）—— 终态不重裁。
        </div>
      ) : (
        <form
          action={图审 ? rejectFigureAction : verdictQueueAction}
          className="border-hair bg-sheet mt-4 rounded-[3px] border px-[18px] py-[15px]"
        >
          <input type="hidden" name="id" value={item.id} />
          {图审 ? null : (
            <input type="hidden" name="verdict" value="rejected" />
          )}
          <label
            htmlFor="note"
            className="text-mut mb-1 block text-[11.5px] tracking-[1px]"
          >
            驳回理由（落 verdict_note，别人日后看得见）
          </label>
          <textarea
            id="note"
            name="note"
            rows={3}
            required
            placeholder={
              图审
                ? "例：这张数轴图上的点位与题面 a<b<0<c 对不上，像是隔壁那题的图。"
                : "例：这个说法指的是「有理数的混合运算」，不是新考点，别名已另行补。"
            }
            className="border-hair2 bg-paper w-full rounded-[2px] border px-2 py-1.5 text-[12.5px]"
          />
          {图审 ? (
            <div className="text-mut mt-1.5 text-[11.5px] leading-[1.8]">
              🔴 驳回后：题干图判 <b>rejected</b>，题<b>继续挂着必审</b>
              （review_required=1）， 系统<b>不会</b>自动把它隔离或退役 ——
              换图、改题还是退役，是你的决定。
            </div>
          ) : null}
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="submit"
              className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
            >
              确认驳回
            </button>
            <Link href="/queue" className="text-mut text-[12.5px] underline">
              取消，回队列
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
