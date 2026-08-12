/**
 * KG 治理 · 合并向导 第二步：预览 + 确认（AI:PRD-002 · 002-D）
 *
 * 🔴 合并不可逆（引用真的搬走、from 变成壳），所以必须先看见「要搬多少行」再按第二次。
 *    左边是 from 的引用面（KpRefCounts 口径，与 core 里 retire/merge 用的是同一份），
 *    右边是 to 的现状。数字对不上心理预期就该退回去 —— 那多半选错了考点。
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
import { KpNotFoundError, kpContext, kpRefCounts } from "~/core";
import { mergeKpAction } from "../../actions";
import { param } from "../../shared";

export const dynamic = "force-dynamic";

async function 读卡(id: string) {
  try {
    return { card: await kpContext(id), error: null as string | null };
  } catch (e) {
    return {
      card: null,
      error:
        e instanceof KpNotFoundError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
    };
  }
}

export default async function MergePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = param(sp, "from");
  const to = param(sp, "to");
  const err = param(sp, "err");

  const [f, t] = await Promise.all([读卡(from), 读卡(to)]);
  const refs = f.card ? await kpRefCounts(from) : null;
  const 可执行 = Boolean(f.card && t.card && from !== to);

  return (
    <>
      <PageHead
        title="确认合并"
        sub="确认后 from 的引用全部搬到 to，from 留成 merged 壳（旧 id 仍能追到落点）"
        right={
          <Link
            className="text-acc-deep text-[12.5px] underline"
            href={`/kg/merge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
          >
            ← 改选
          </Link>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {f.error ? <Notice tone="err">from 读不出来：{f.error}</Notice> : null}
      {t.error ? <Notice tone="err">to 读不出来：{t.error}</Notice> : null}
      {from === to && from ? (
        <Notice tone="err">from 和 to 是同一个考点，合什么。</Notice>
      ) : null}
      {t.card && t.card.kp.status !== "active" ? (
        <Notice tone="err">
          合并目标状态是 {t.card.kp.status}，core 会拒（目标必须 active， 合到
          merged/retired 上 = 造环断链）。
        </Notice>
      ) : null}

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Panel
          title="from · 会被合并掉"
          right={
            f.card ? (
              <Chip tone={statusTone(f.card.kp.status)}>
                {f.card.kp.status}
              </Chip>
            ) : undefined
          }
        >
          {f.card ? (
            <>
              <div className="mb-2 text-[15px] font-bold">{f.card.kp.name}</div>
              <div className="text-mut mb-2 font-mono text-[10.5px] break-all">
                {from}
              </div>
              <div className="text-mut mb-1 text-[11.5px] tracking-[1px]">
                身上的引用（这些会整体搬到 to）
              </div>
              {refs
                ? Object.entries(refs)
                    .filter(([k]) => k !== "合计")
                    .map(([table, n]) => (
                      <Row
                        key={table}
                        k={table}
                        v={
                          <span
                            className={n > 0 ? "num text-ink" : "num text-mut"}
                          >
                            {n}
                          </span>
                        }
                      />
                    ))
                : null}
              <div className="mt-2 text-[12.5px]">
                合计 <span className="num text-[16px]">{refs?.合计 ?? 0}</span>{" "}
                条
                {refs?.合计 === 0 ? (
                  <span className="text-mut">
                    {" "}
                    —— 一条引用都没有，合并只是把它标成壳
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="text-mut text-[12.5px]">没选或读不出来。</div>
          )}
        </Panel>

        <Panel
          title="to · 会留下"
          right={
            t.card ? (
              <Chip tone={statusTone(t.card.kp.status)}>
                {t.card.kp.status}
              </Chip>
            ) : undefined
          }
        >
          {t.card ? (
            <>
              <div className="mb-2 text-[15px] font-bold">{t.card.kp.name}</div>
              <div className="text-mut mb-2 font-mono text-[10.5px] break-all">
                {to}
              </div>
              <Row
                k="领域 / 主题"
                v={`${t.card.kp.domain ?? "—"} / ${t.card.kp.topic ?? "—"}`}
              />
              <Row k="别名" v={t.card.aliases.join("、") || "—"} />
              <Row
                k="教材挂位"
                v={
                  t.card.placements.length > 0
                    ? t.card.placements
                        .map(
                          (p) =>
                            `${p.edition}${p.gradeSem} ${p.path.at(-1) ?? ""}`,
                        )
                        .join("；")
                    : "—"
                }
              />
              <Row
                k="挂载"
                v={
                  <span className="text-[12.5px]">
                    题 <span className="num">{t.card.counts.questions}</span> ·
                    模型 <span className="num">{t.card.counts.examModels}</span>{" "}
                    · 错因{" "}
                    <span className="num">{t.card.counts.errorCauses}</span>
                  </span>
                }
              />
            </>
          ) : (
            <div className="text-mut text-[12.5px]">没选或读不出来。</div>
          )}
        </Panel>
      </div>

      <div className="border-hair bg-sheet mt-4 rounded-[3px] border px-[18px] py-[15px]">
        <div className="mb-2 text-[12.5px] leading-[1.9]">
          按下去会发生：question_kp / node_kp_map / kp_error / kp_alias /
          err_code_map / kp_edge / exam_model 逐表重挂到 to；
          <b>主考点显式裁决</b>（to 侧那行被提为 primary，而不是让 from
          那行被静默吞掉）； from 标成 merged 并记下
          merged_into。全程一个事务、一条审计行。
          <br />
          完成后立刻跑一次对账，把 <b>C2 悬挂引用</b> 的结论贴给你看 ——
          绿了才算这次合并干净。
        </div>
        <form action={mergeKpAction} className="flex items-center gap-3">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <button
            type="submit"
            disabled={!可执行}
            className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold disabled:opacity-40"
          >
            确认合并（不可逆）
          </button>
          <Link href="/kg/merge" className="text-mut text-[12.5px] underline">
            取消
          </Link>
        </form>
      </div>
    </>
  );
}
