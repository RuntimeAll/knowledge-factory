/**
 * KG 治理 · 提议审批（AI:PRD-002 · 002-D）
 *
 * review_queue 的处置台：**KG 提议**（agent 想改 KG）与 **kp低置信**
 * （agent 按某句话问不出考点）两类都在这儿裁。默认只看 open。
 *
 * 🔴 通过是一步（不改数据、只表态），驳回走确认页（要写理由，落 verdict_note）。
 * 🔴 低置信工单多一条快捷路：把那句问不出来的说法补成某个考点的别名，工单同时判过 ——
 *    队列的价值就在这里：它是**词表的缺口清单**，处理一条就补上一个入口。
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel } from "~/components/kit";
import { QUEUE_KINDS, listQueueItems, type QueueItem } from "~/core";
import { verdictQueueAction } from "../actions";
import { param } from "../shared";

export const dynamic = "force-dynamic";

const STATES = ["open", "passed", "rejected"] as const;

/** 低置信工单的 payload 里那句 query（取不到就 null，绝不猜） */
function queryOf(item: QueueItem): string | null {
  if (!item.payloadJson) return null;
  try {
    const p: unknown = JSON.parse(item.payloadJson);
    if (p && typeof p === "object" && "query" in p) {
      return typeof p.query === "string" ? p.query : null;
    }
  } catch {
    // payload 不是合法 JSON 也不是灾难：下面 details 里还会原样展示它
  }
  return null;
}

function pretty(json: string | null): string {
  if (!json) return "（空）";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function 状态色(state: string): "a" | "g" | "r" {
  return state === "open" ? "a" : state === "passed" ? "g" : "r";
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const kind = param(sp, "kind");
  const stateRaw = param(sp, "state");
  const state = (STATES as readonly string[]).includes(stateRaw)
    ? (stateRaw as (typeof STATES)[number])
    : "open";
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  const items = await listQueueItems({
    kind: kind || undefined,
    state,
    limit: 200,
  });

  const 链接 = (k: string, s: string) => {
    const p = new URLSearchParams();
    if (k) p.set("kind", k);
    p.set("state", s);
    return `/kg/queue?${p.toString()}`;
  };

  return (
    <>
      <PageHead
        title="提议审批"
        sub="agent 把拿不准的事排进队列，人来裁：过 / 不过，都留名留理由"
        right={
          <Link className="text-acc-deep text-[12.5px] underline" href="/kg">
            ← 总览
          </Link>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      {/* ── 过滤条（纯链接，无 JS）─────────────────────────────────────── */}
      <div className="border-hair bg-sheet mb-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 rounded-[3px] border px-3 py-2 text-[12px]">
        <span className="text-mut tracking-[1px]">状态</span>
        {STATES.map((s) => (
          <Link
            key={s}
            href={链接(kind, s)}
            className={
              s === state ? "text-acc-deep font-bold" : "text-mut underline"
            }
          >
            {s}
          </Link>
        ))}
        <span className="border-hair ml-3 border-l pl-3" />
        <span className="text-mut tracking-[1px]">类别</span>
        <Link
          href={链接("", state)}
          className={!kind ? "text-acc-deep font-bold" : "text-mut underline"}
        >
          全部
        </Link>
        {QUEUE_KINDS.map((k) => (
          <Link
            key={k}
            href={链接(k, state)}
            className={
              k === kind ? "text-acc-deep font-bold" : "text-mut underline"
            }
          >
            {k}
          </Link>
        ))}
        <span className="text-mut ml-auto">
          共 <span className="num">{items.length}</span> 条
        </span>
      </div>

      {items.length === 0 ? (
        <Panel title="队列">
          <div className="text-mut text-[12.5px]">
            没有符合条件的工单。
            {state === "open" ? (
              <>
                {" "}
                —— 队列空 = agent 最近没撞上拿不准的事（低置信工单由 resolve_kp
                自动开，KG 提议由录入/打标链路开）。
              </>
            ) : null}
          </div>
        </Panel>
      ) : (
        <div className="space-y-3">
          {items.map((it) => {
            const q = queryOf(it);
            const 低置信 = it.kind === "kp低置信";
            return (
              <Panel
                key={it.id}
                title={it.kind ?? "（未分类）"}
                right={
                  <span className="flex items-baseline gap-2">
                    <Chip tone={状态色(it.state)}>{it.state}</Chip>
                    <span className="text-mut num text-[11px]">
                      {it.createdAt ?? "时间未知"}
                    </span>
                  </span>
                }
              >
                <div className="text-[12.5px] leading-[1.8] break-words">
                  {it.reason ?? "（没写理由）"}
                </div>

                {it.refType || it.refId ? (
                  <div className="text-mut mt-1 text-[11.5px]">
                    指向 {it.refType ?? "?"} ·{" "}
                    <span className="font-mono">{it.refId ?? "?"}</span>
                  </div>
                ) : null}

                <details className="mt-2">
                  <summary className="text-mut cursor-pointer text-[12px]">
                    payload_json / signals_json（原样）
                  </summary>
                  <pre className="bg-code mt-1 max-h-[280px] overflow-auto rounded-[2px] p-2 text-[11.5px] whitespace-pre-wrap">
                    {pretty(it.payloadJson)}
                    {it.signalsJson
                      ? `\n--- signals ---\n${pretty(it.signalsJson)}`
                      : ""}
                  </pre>
                </details>

                {it.state === "open" ? (
                  <div className="border-hair mt-2.5 flex flex-wrap items-center gap-3 border-t pt-2.5">
                    <form action={verdictQueueAction}>
                      <input type="hidden" name="id" value={it.id} />
                      <input type="hidden" name="verdict" value="passed" />
                      <button
                        type="submit"
                        className="border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3 py-[3px] text-[12.5px]"
                      >
                        通过
                      </button>
                    </form>
                    <Link
                      href={`/kg/queue/${it.id}/reject`}
                      className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[3px] text-[12.5px]"
                    >
                      驳回…
                    </Link>
                    {低置信 && q ? (
                      <Link
                        href={`/kg/queue/${it.id}/alias`}
                        className="border-hair2 hover:bg-sel rounded-[2px] border px-3 py-[3px] text-[12.5px]"
                      >
                        快捷加别名（把「{q}」补进词表）
                      </Link>
                    ) : null}
                    <span className="text-mut ml-auto font-mono text-[10.5px]">
                      {it.id}
                    </span>
                  </div>
                ) : (
                  <div className="border-hair text-mut mt-2.5 border-t pt-2 text-[12px]">
                    {it.verdictBy ?? "未记名"} 于 {it.verdictAt ?? "时间未知"}{" "}
                    裁 ：{it.state}
                    {it.verdictNote ? (
                      <div className="text-ink mt-1 break-words">
                        理由：{it.verdictNote}
                      </div>
                    ) : null}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
