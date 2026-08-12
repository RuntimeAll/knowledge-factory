/**
 * KG 治理 · 合并向导 第一步：挑 from / to（AI:PRD-002 · 002-D）
 *
 * 两个搜索框 = 两次 resolve_kp（服务端跑，候选带 confidence）。
 * 🔴 enqueue:false —— 人在页面上搜东西**不是** agent 的低置信信号：
 *    往 review_queue 里塞工单的判据是「agent 问不出来」，不是「人手一直在打字」。
 *    这条不设防的话，队列会被每一次按键翻页塞满噪音。
 * 🔴 这页不动任何数据。真正的合并在第二步（预览页）确认后才发生。
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel, statusTone } from "~/components/kit";
import { resolveKp, type KpCandidate } from "~/core";
import { param } from "../shared";

export const dynamic = "force-dynamic";

/** 服务端搜一把（不入队列）；查询为空就不查 */
async function 搜(query: string): Promise<{
  candidates: KpCandidate[];
  error: string | null;
}> {
  if (!query) return { candidates: [], error: null };
  try {
    const r = await resolveKp(query, { limit: 8, enqueue: false });
    return { candidates: r.candidates, error: null };
  } catch (e) {
    return {
      candidates: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function CandidateList({
  items,
  side,
  from,
  to,
  q,
}: {
  items: KpCandidate[];
  side: "from" | "to";
  from: string;
  to: string;
  q: string;
}) {
  if (items.length === 0) {
    return (
      <div className="text-mut mt-2 text-[12.5px]">
        {q ? "一条候选都没有 —— 换个说法试试。" : "上面输个词开始找。"}
      </div>
    );
  }
  return (
    <ul className="mt-2 space-y-1 text-[12.5px]">
      {items.map((c) => {
        // 选中一侧时另一侧保持不变，两个搜索词也带着走（刷新回来还在原处）
        const next = new URLSearchParams();
        next.set(side, c.kpId);
        next.set(side === "from" ? "to" : "from", side === "from" ? to : from);
        next.set(side === "from" ? "qf" : "qt", q);
        return (
          <li key={c.kpId} className="flex flex-wrap items-baseline gap-2">
            <Link
              href={`/kg/merge?${next.toString()}`}
              className="text-acc-deep underline"
            >
              选它
            </Link>
            <span>{c.name}</span>
            <Chip tone={statusTone(c.status)}>{c.status}</Chip>
            <span className="num text-mut">{c.confidence}</span>
            <span className="text-mut text-[11px]">
              {c.matchedVia}
              {c.aliasHit ? ` · 别名「${c.aliasHit}」` : ""}
            </span>
            <Link
              href={`/kg/kp/${c.kpId}`}
              className="text-mut ml-auto text-[11px] underline"
            >
              详情
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SearchBox({
  side,
  value,
  from,
  to,
  qf,
  qt,
}: {
  side: "from" | "to";
  value: string;
  from: string;
  to: string;
  qf: string;
  qt: string;
}) {
  return (
    <form method="GET" action="/kg/merge" className="flex flex-wrap gap-2">
      {/* GET 表单：另一侧的选择与搜索词用 hidden 带着，不然一搜就丢 */}
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <input
        type="hidden"
        name={side === "from" ? "qt" : "qf"}
        value={side === "from" ? qt : qf}
      />
      <input
        name={side === "from" ? "qf" : "qt"}
        defaultValue={value}
        placeholder="一句人话，如「绝对值」"
        className="border-hair2 bg-sheet w-[240px] rounded-[2px] border px-2 py-[3px] text-[12.5px]"
      />
      <button
        type="submit"
        className="border-hair2 hover:bg-sel rounded-[2px] border px-3 py-[3px] text-[12.5px]"
      >
        搜
      </button>
    </form>
  );
}

export default async function MergePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = param(sp, "from");
  const to = param(sp, "to");
  const qf = param(sp, "qf");
  const qt = param(sp, "qt");
  const err = param(sp, "err");

  const [左, 右] = await Promise.all([搜(qf), 搜(qt)]);

  const 选中 = (id: string, 候选: KpCandidate[]) =>
    候选.find((c) => c.kpId === id)?.name ?? id;

  return (
    <>
      <PageHead
        title="合并考点"
        sub="重复考点合成一个：引用整体搬家，被合并的那个留成壳（旧 id 仍查得到落点）"
        right={
          <Link className="text-acc-deep text-[12.5px] underline" href="/kg">
            ← 总览
          </Link>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {左.error ? <Notice tone="err">左侧搜索：{左.error}</Notice> : null}
      {右.error ? <Notice tone="err">右侧搜索：{右.error}</Notice> : null}

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel
          title="from · 被合并掉的那个"
          right={from ? <Chip tone="a">已选</Chip> : <Chip tone="n">未选</Chip>}
        >
          <SearchBox
            side="from"
            value={qf}
            from={from}
            to={to}
            qf={qf}
            qt={qt}
          />
          {from ? (
            <div className="border-hair mt-2 border-t pt-2 text-[12.5px]">
              已选：<b>{选中(from, 左.candidates)}</b>
              <span className="text-mut ml-2 font-mono text-[10.5px]">
                {from}
              </span>
            </div>
          ) : null}
          <CandidateList
            items={左.candidates}
            side="from"
            from={from}
            to={to}
            q={qf}
          />
        </Panel>

        <Panel
          title="to · 留下的那个（必须 active）"
          right={to ? <Chip tone="g">已选</Chip> : <Chip tone="n">未选</Chip>}
        >
          <SearchBox side="to" value={qt} from={from} to={to} qf={qf} qt={qt} />
          {to ? (
            <div className="border-hair mt-2 border-t pt-2 text-[12.5px]">
              已选：<b>{选中(to, 右.candidates)}</b>
              <span className="text-mut ml-2 font-mono text-[10.5px]">
                {to}
              </span>
            </div>
          ) : null}
          <CandidateList
            items={右.candidates}
            side="to"
            from={from}
            to={to}
            q={qt}
          />
        </Panel>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {from && to ? (
          <Link
            href={`/kg/merge/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
            className="border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
          >
            下一步：看看会搬走什么 →
          </Link>
        ) : (
          <span className="text-mut text-[12.5px]">
            两边都选好才能进下一步。
          </span>
        )}
        {from || to ? (
          <Link href="/kg/merge" className="text-mut text-[12.5px] underline">
            清空重选
          </Link>
        ) : null}
      </div>

      <hr className="rule-double my-5 border-0" />
      <div className="text-mut text-[12px] leading-[1.9]">
        搜索走 resolve_kp（与 agent 同一口径、同一打分），
        <b>但页面搜索不入低置信队列</b> —— 队列记的是「agent
        问不出来」，不是人在打字。
      </div>
    </>
  );
}
