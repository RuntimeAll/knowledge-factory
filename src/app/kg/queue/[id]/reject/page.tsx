/**
 * KG 治理 · 驳回确认（AI:PRD-002 · 002-D）
 *
 * 🔴 驳回是终态、不可再裁，所以单独一页：把工单正文完整摊开，逼你写一句理由再按。
 *    理由落 review_queue.verdict_note（正文入库）—— 没有理由的驳回，
 *    下次同样的提议还会再来一遍，而没人记得上次为什么否了它。
 */
import Link from "next/link";

import { Chip, PageHead, Panel, Row } from "~/components/kit";
import { getQueueItem } from "~/core";
import { verdictQueueAction } from "../../../actions";

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
          <Link className="text-acc-deep underline" href="/kg/queue">
            ← 回队列
          </Link>
        </div>
      </>
    );
  }

  const 已裁 = item.state !== "open";

  return (
    <>
      <PageHead
        title="驳回这条工单？"
        sub={<span className="font-mono">{item.id}</span>}
        right={
          <Chip tone={item.state === "open" ? "a" : "n"}>{item.state}</Chip>
        }
      />

      <Panel title={item.kind ?? "（未分类）"}>
        <Row k="开单时间" v={item.createdAt ?? "—"} />
        <Row k="理由" v={item.reason ?? "（没写）"} />
        {item.refType || item.refId ? (
          <Row k="指向" v={`${item.refType ?? "?"} · ${item.refId ?? "?"}`} />
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
          action={verdictQueueAction}
          className="border-hair bg-sheet mt-4 rounded-[3px] border px-[18px] py-[15px]"
        >
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="verdict" value="rejected" />
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
            placeholder="例：这个说法指的是「有理数的混合运算」，不是新考点，别名已另行补。"
            className="border-hair2 bg-paper w-full rounded-[2px] border px-2 py-1.5 text-[12.5px]"
          />
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="submit"
              className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
            >
              确认驳回
            </button>
            <Link href="/kg/queue" className="text-mut text-[12.5px] underline">
              取消，回队列
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
