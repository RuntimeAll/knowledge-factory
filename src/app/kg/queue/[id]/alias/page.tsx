/**
 * KG 治理 · 低置信工单的快捷处置：补别名（AI:PRD-002 · 002-D）
 *
 * 工单里那句「问不出来的说法」是**现成的搜索词**：从它出发再搜一遍（这次由人看），
 * 认出目标考点后一键 = 补别名 + 工单判过（core 的 passQueueWithAlias 串完两笔写）。
 *
 * 🔴 这页的搜索同样 enqueue:false —— 处理低置信工单的过程里再开出新的低置信工单，
 *    是队列自我繁殖，很滑稽也很难清。
 * 🔴 别名默认就填工单里那句原话：agent 下次照原话问就能命中，这才是补别名的意义。
 *    （能改：人可能想补的是更规范的说法。）
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel, statusTone } from "~/components/kit";
import { getQueueItem, resolveKp, type KpCandidate } from "~/core";
import { quickAliasAction } from "../../../actions";
import { param } from "../../../shared";

export const dynamic = "force-dynamic";

/** 工单 payload 里那句 query */
function queryOf(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const p: unknown = JSON.parse(payloadJson);
    if (p && typeof p === "object" && "query" in p) {
      return typeof p.query === "string" ? p.query : null;
    }
  } catch {
    /* 不是 JSON 就当没有 */
  }
  return null;
}

export default async function QueueAliasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const sp = await searchParams;

  const item = await getQueueItem(id);
  if (!item) {
    return (
      <>
        <PageHead
          title="快捷加别名"
          sub={<span className="font-mono">{id}</span>}
        />
        <div className="text-pen text-[12.5px]">这条工单不在库里。</div>
        <div className="mt-4 text-[12.5px]">
          <Link className="text-acc-deep underline" href="/kg/queue">
            ← 回队列
          </Link>
        </div>
      </>
    );
  }

  const 原话 = queryOf(item.payloadJson) ?? "";
  // 搜索词：手输的优先，没输就用工单里那句原话
  const q = param(sp, "q") || 原话;

  let candidates: KpCandidate[] = [];
  let searchError: string | null = null;
  if (q) {
    try {
      const r = await resolveKp(q, { limit: 10, enqueue: false });
      candidates = r.candidates;
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }
  }

  const 已裁 = item.state !== "open";

  return (
    <>
      <PageHead
        title="把这句说法补进词表"
        sub={
          <>
            工单 <span className="font-mono">{item.id}</span> ·{" "}
            {item.kind ?? "（未分类）"}
          </>
        }
        right={
          <span className="flex items-baseline gap-2">
            <Chip tone={item.state === "open" ? "a" : "n"}>{item.state}</Chip>
            <Link
              className="text-acc-deep text-[12.5px] underline"
              href="/kg/queue"
            >
              ← 队列
            </Link>
          </span>
        }
      />

      {已裁 ? (
        <Notice tone="err">
          这条工单已经是 {item.state} 了（{item.verdictBy ?? "未记名"} 于{" "}
          {item.verdictAt ?? "时间未知"} 裁的）——
          终态不重裁。下面只能看，不能提交。
        </Notice>
      ) : null}
      {searchError ? <Notice tone="err">搜索出错：{searchError}</Notice> : null}

      <Panel title="工单说的是">
        <div className="text-[12.5px] leading-[1.8]">
          {item.reason ?? "（没写理由）"}
        </div>
        {原话 ? (
          <div className="mt-2 text-[13px]">
            agent 当时问的是：
            <b className="bg-amber-soft ml-1 px-1.5">{原话}</b>
          </div>
        ) : (
          <div className="text-mut mt-2 text-[12.5px]">
            payload 里没有 query 字段 —— 这条不是 resolve_kp 开的低置信工单，
            补别名得自己填说法。
          </div>
        )}
      </Panel>

      <div className="mt-3.5">
        <Panel
          title="① 找到它到底指哪个考点"
          right={
            <form method="GET" className="flex gap-2">
              <input
                name="q"
                defaultValue={q}
                placeholder="换个说法再搜"
                className="border-hair2 bg-sheet w-[220px] rounded-[2px] border px-2 py-[3px] text-[12.5px]"
              />
              <button
                type="submit"
                className="border-hair2 hover:bg-sel rounded-[2px] border px-3 py-[3px] text-[12.5px]"
              >
                搜
              </button>
            </form>
          }
        >
          {candidates.length === 0 ? (
            <div className="text-mut text-[12.5px]">
              {q
                ? `按「${q}」一条候选都没有 —— 换个说法，或者这个考点确实还没建（那就该驳回工单并去建考点）。`
                : "输入一个词开始找。"}
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-hair2 text-mut border-b text-left text-[11px] tracking-[1px]">
                  <th className="py-1 pr-3 font-semibold">考点</th>
                  <th className="py-1 pr-3 font-semibold">把握</th>
                  <th className="py-1 pr-3 font-semibold">怎么命中的</th>
                  <th className="py-1 font-semibold">② 一键：补别名 + 判过</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.kpId} className="border-hair border-b align-top">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`/kg/kp/${c.kpId}`}
                        className="hover:text-acc-deep underline decoration-dotted"
                      >
                        {c.name}
                      </Link>
                      <Chip tone={statusTone(c.status)}>{c.status}</Chip>
                    </td>
                    <td className="num py-1.5 pr-3">{c.confidence}</td>
                    <td className="text-mut py-1.5 pr-3 text-[11.5px]">
                      {c.matchedVia}
                      {c.aliasHit ? ` · 别名「${c.aliasHit}」` : ""}
                    </td>
                    <td className="py-1.5">
                      <form
                        action={quickAliasAction}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="queueId" value={item.id} />
                        <input type="hidden" name="kpId" value={c.kpId} />
                        <input type="hidden" name="kpName" value={c.name} />
                        <input
                          name="alias"
                          required
                          defaultValue={原话 || q}
                          className="border-hair2 bg-sheet w-[170px] rounded-[2px] border px-2 py-[2px] text-[12px]"
                        />
                        <button
                          type="submit"
                          disabled={已裁}
                          className="border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-2.5 py-[2px] text-[12px] disabled:opacity-40"
                        >
                          补进它
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="text-mut mt-4 text-[12px] leading-[1.9]">
        都不对？那这条说法可能对应一个<b>还没建的考点</b> —— 回队列
        <Link
          href={`/kg/queue/${item.id}/reject`}
          className="text-pen mx-1 underline"
        >
          驳回
        </Link>
        并写清楚，别硬塞给一个不相干的考点（词表脏了，之后每一次检索都在还这笔债）。
      </div>
    </>
  );
}
