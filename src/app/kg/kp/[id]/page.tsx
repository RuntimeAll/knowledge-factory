/**
 * KG 治理 · 考点详情（AI:PRD-002 · 002-D）
 *
 * kp_context 卡片包的可视化：口径（card_md）/ 别名词表 / **双版本挂位** / 挂载计数 /
 * 合并来源。别名可就地增删，退役走确认页。
 *
 * 🔴 这页就是验收 2-1 的页面证据：同一个考点（概念层一个）在人教树与浙教树上
 *    各有一条挂位路径，并排列出来。看得见「概念层版本无关」不是口号。
 * 🔴 编造的 id 不给白板：kpContext 抛的 KpNotFoundError 自带最近似候选，
 *    这里原样列出来（验收 2-2 在页面侧的样子）。
 */
import Link from "next/link";

import {
  Chip,
  Notice,
  PageHead,
  Panel,
  Row,
  statusTone,
} from "~/components/kit";
import { KpNotFoundError, kpContext, type KpContextCard } from "~/core";
import { addAliasAction, removeAliasAction } from "../../actions";
import { param } from "../../shared";

export const dynamic = "force-dynamic";

/** 查无此考点：把错误里的候选摆出来，让人一步走对（而不是回去重查） */
function NotFound({ id, e }: { id: string; e: KpNotFoundError }) {
  return (
    <>
      <PageHead
        title="查无此考点"
        sub={<span className="font-mono">{id}</span>}
      />
      <Notice tone="err">{e.message}</Notice>
      {e.candidates.length > 0 ? (
        <Panel title="最近似的候选">
          <ul className="space-y-1 text-[13px]">
            {e.candidates.map((c) => (
              <li key={c.kpId}>
                <Link
                  href={`/kg/kp/${c.kpId}`}
                  className="text-acc-deep underline"
                >
                  {c.name}
                </Link>
                <span className="num text-mut ml-2">{c.confidence}</span>
                <span className="text-mut ml-2 text-[11.5px]">
                  {c.matchedVia}
                  {c.aliasHit ? ` · 命中别名「${c.aliasHit}」` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <div className="mt-4 text-[12.5px]">
        <Link className="text-acc-deep underline" href="/kg">
          ← 回知识图谱总览
        </Link>
      </div>
    </>
  );
}

/** 双版本挂位表（验收 2-1 的正主） */
function Placements({ card }: { card: KpContextCard }) {
  if (card.placements.length === 0) {
    return (
      <div className="text-amber text-[12.5px]">
        一棵版本树都没挂上 —— 概念层有它，教材里找不到它，出题时按章节召回不到。
      </div>
    );
  }
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="border-hair2 text-mut border-b text-left text-[11px] tracking-[1px]">
          <th className="py-1 pr-3 font-semibold">教材</th>
          <th className="py-1 pr-3 font-semibold">章 / 节</th>
          <th className="py-1 font-semibold">树</th>
        </tr>
      </thead>
      <tbody>
        {card.placements.map((p) => (
          <tr key={`${p.treeId}|${p.nodeId}`} className="border-hair border-b">
            <td className="py-1.5 pr-3 whitespace-nowrap">
              <b>{p.edition}</b>
              <span className="text-mut"> · </span>
              {p.gradeSem}
            </td>
            <td className="py-1.5 pr-3">
              {p.path.length > 0 ? p.path.join(" / ") : "（路径读不出来）"}
            </td>
            <td className="py-1.5 whitespace-nowrap">
              <Link
                href={`/kg/tree/${p.treeId}`}
                className="text-acc-deep underline"
              >
                {p.subject}
              </Link>
              {p.treeStatus === "active" ? null : (
                <span className="text-mut">（{p.treeStatus ?? "NULL"}）</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function KpPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const sp = await searchParams;
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  let card: KpContextCard;
  try {
    card = await kpContext(id);
  } catch (e) {
    if (e instanceof KpNotFoundError) return <NotFound id={id} e={e} />;
    throw e;
  }

  const k = card.kp;
  const 版本数 = new Set(card.placements.map((p) => p.edition)).size;

  return (
    <>
      <PageHead
        title={k.name}
        sub={
          <>
            <span className="font-mono">{k.id}</span>
            {card.resolvedThrough ? (
              <span className="text-pen">
                {" "}
                ← 你给的 {card.resolvedThrough.originalId} 是合并壳，已追{" "}
                {card.resolvedThrough.hops} 跳到这里
              </span>
            ) : null}
          </>
        }
        right={
          <div className="flex items-baseline gap-2">
            <Chip tone={statusTone(k.status)}>{k.status}</Chip>
            <Link className="text-acc-deep text-[12.5px] underline" href="/kg">
              ← 总览
            </Link>
          </div>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel title="是什么">
          <Row k="名称" v={k.name} />
          <Row
            k="状态"
            v={<Chip tone={statusTone(k.status)}>{k.status}</Chip>}
          />
          <Row k="学段" v={k.gradeBand ?? "—"} />
          <Row k="领域 domain" v={k.domain ?? "—"} />
          <Row k="主题 topic" v={k.topic ?? "—"} />
          <Row
            k="挂载"
            v={
              <span className="text-[12.5px]">
                题 <span className="num">{card.counts.questions}</span> ·
                解题模型 <span className="num">{card.counts.examModels}</span> ·
                错因 <span className="num">{card.counts.errorCauses}</span>
              </span>
            }
          />
        </Panel>

        <Panel
          title={`教材挂位（${card.placements.length} 处 · ${版本数} 个教材版本）`}
          right={
            版本数 > 1 ? (
              <Chip tone="g">同一考点 · 多版本各挂各的</Chip>
            ) : undefined
          }
        >
          <Placements card={card} />
        </Panel>
      </div>

      {/* ── 别名词表：resolve_kp 的料 ─────────────────────────────────── */}
      <div className="mt-3.5">
        <Panel title={`别名词表（${card.aliases.length} 条）`}>
          <div className="text-mut mb-2 text-[12px]">
            别名是
            agent「问得出来」的入口：它按哪句话查得到这个考点，取决于这张表。
          </div>
          {card.aliases.length > 0 ? (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {card.aliases.map((a) => (
                <span
                  key={a}
                  className="border-hair bg-code inline-flex items-baseline gap-1.5 rounded-[2px] border px-2 py-[2px] text-[12.5px]"
                >
                  {a}
                  <form action={removeAliasAction} className="inline">
                    <input type="hidden" name="kpId" value={k.id} />
                    <input type="hidden" name="alias" value={a} />
                    <button
                      type="submit"
                      title={`删掉别名「${a}」`}
                      className="text-mut hover:text-pen cursor-pointer text-[11px]"
                    >
                      ×
                    </button>
                  </form>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-mut mb-2.5 text-[12.5px]">
              一条别名都没有 —— 只有名字全等/前缀/子串能查到它。
            </div>
          )}
          <form action={addAliasAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="kpId" value={k.id} />
            <input
              name="alias"
              required
              maxLength={80}
              placeholder="补一个说法，如「实数计算」"
              className="border-hair2 bg-sheet w-[280px] rounded-[2px] border px-2 py-[3px] text-[12.5px]"
            />
            <button
              type="submit"
              className="border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3 py-[3px] text-[12.5px]"
            >
              加别名
            </button>
          </form>
        </Panel>
      </div>

      {/* ── 考点卡片正文 ───────────────────────────────────────────────── */}
      <div className="mt-3.5">
        <Panel title="考点卡（口径 / 易错 / 教学建议）">
          {k.cardMd ? (
            // 朴素为先：原样等宽展示，不引 markdown 渲染器（这页的读者是人，不是排版）
            <pre className="bg-code max-h-[420px] overflow-auto rounded-[2px] p-3 text-[12px] leading-[1.8] whitespace-pre-wrap">
              {k.cardMd}
            </pre>
          ) : (
            <div className="text-mut text-[12.5px]">
              还没写卡片。没有口径的考点，出题时全靠出题人临场发挥。
            </div>
          )}
        </Panel>
      </div>

      {card.mergedFrom && card.mergedFrom.length > 0 ? (
        <div className="mt-3.5">
          <Panel title={`合并来源（${card.mergedFrom.length} 个旧考点指向它）`}>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
              {card.mergedFrom.map((m) => (
                <span key={m.id}>
                  {m.name}
                  <span className="text-mut ml-1 font-mono text-[10.5px]">
                    {m.id}
                  </span>
                </span>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      <hr className="rule-double my-5 border-0" />
      <div className="flex flex-wrap items-baseline gap-4 text-[12.5px]">
        <Link
          className="text-acc-deep underline"
          href={`/kg/merge?from=${k.id}`}
        >
          把它合并到别的考点 →
        </Link>
        <Link className="text-pen underline" href={`/kg/kp/${k.id}/retire`}>
          退役这个考点 →
        </Link>
        <span className="text-mut">
          重复考点走合并（引用整体搬家），别走退役（引用会成悬挂）。
        </span>
      </div>
    </>
  );
}
