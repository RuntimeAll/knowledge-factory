/**
 * KG 治理 · 退役确认（AI:PRD-002 · 002-D）
 *
 * 🔴 退役是破坏性动作，所以有这一页：先把「它身上还挂着什么」摆出来，再让人按第二次。
 *    页面上的计数只是**预判**，真正的判据在 retireKp 的事务里现算（引用非 0 会被拒）。
 * 🔴 页面不给 force 开关：强退会留下对账 C2 红旗，那种事得有人在命令行里
 *    显式写 force:true 才配发生，不该是一个按钮。
 */
import Link from "next/link";

import { Chip, PageHead, Panel, Row, statusTone } from "~/components/kit";
import { KpNotFoundError, kpContext, kpRefCounts } from "~/core";
import { retireKpAction } from "../../../actions";

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
          <div className="text-pen text-[12.5px] whitespace-pre-wrap">
            {e.message}
          </div>
        </>
      );
    }
    throw e;
  }

  const refs = await kpRefCounts(id);
  const 明细 = Object.entries(refs).filter(([k]) => k !== "合计");

  return (
    <>
      <PageHead
        title={`退役「${name}」？`}
        sub={<span className="font-mono">{id}</span>}
        right={<Chip tone={statusTone(status)}>{status}</Chip>}
      />

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel title="它身上还挂着什么（退役的判据）">
          {明细.map(([table, n]) => (
            <Row
              key={table}
              k={table}
              v={
                <span className={n > 0 ? "text-pen num" : "text-mut num"}>
                  {n}
                </span>
              }
            />
          ))}
          <div className="mt-2 text-[12.5px]">
            合计 <span className="num text-[16px]">{refs.合计}</span> 条
            {refs.合计 > 0 ? (
              <span className="text-pen">
                {" "}
                —— 有引用的考点退役会被 core 拒（KP_HAS_REFS）
              </span>
            ) : (
              <span className="text-acc-deep"> —— 干净，可以退役</span>
            )}
          </div>
        </Panel>

        <Panel title="退役会发生什么">
          <ul className="list-disc space-y-1.5 pl-4 text-[12.5px]">
            <li>
              kp.status 改成 <code className="bg-code px-1">retired</code>
              ，从此<b>不能再挂</b>任何东西（挂了就是对账 C2 的悬挂引用）。
            </li>
            <li>
              它<b>不会</b>从检索里消失得干干净净：已经指向它的行还在， 所以
              core 默认拒绝带引用的退役。
            </li>
            <li>
              🔴 如果它其实是<b>重复考点</b>，别退役，走{" "}
              <Link
                href={`/kg/merge?from=${id}`}
                className="text-acc-deep underline"
              >
                合并
              </Link>
              ：合并会把引用整体搬到留下的那个考点上，旧 id 还查得到落点。
            </li>
          </ul>

          <form
            action={retireKpAction}
            className="mt-4 flex items-center gap-3"
          >
            <input type="hidden" name="kpId" value={id} />
            <button
              type="submit"
              className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
            >
              确认退役
            </button>
            <Link
              href={`/kg/kp/${id}`}
              className="text-mut text-[12.5px] underline"
            >
              取消，回考点详情
            </Link>
          </form>
        </Panel>
      </div>
    </>
  );
}
