/**
 * KG 治理 · 合并结果（AI:PRD-002 · 002-D）
 *
 * 把 MergeKpResult **原样**摆出来：逐表 moved/dropped、三种主考点裁决、
 * err_code_map 丢掉的码、kp_edge 自环，一个字段都不省 —— 合并唯一会「安静地丢东西」
 * 的地方就在这些数字里，藏一个就等于把风险藏起来。
 * 再贴上合并后那次对账的 C2（悬挂引用）结论：绿 = 这次合并没留悬挂，机器背书。
 *
 * 🔴 回执存在进程内存里（见 merge-store.ts）：服务重启就没了。取不到时如实说，
 *    并给出审计行 seq 与落点考点 —— 合并本身已经落库，找得回来。
 */
import Link from "next/link";

import { Chip, PageHead, Panel, Row } from "~/components/kit";
import { readMergeReceipt } from "../../../merge-store";

export const dynamic = "force-dynamic";

function CountTable({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const rows = Object.entries(data);
  return (
    <Panel title={title}>
      {rows.length === 0 ? (
        <div className="text-mut text-[12.5px]">（空）</div>
      ) : (
        rows.map(([t, n]) => (
          <Row
            key={t}
            k={t}
            v={<span className={n > 0 ? "num" : "num text-mut"}>{n}</span>}
          />
        ))
      )}
    </Panel>
  );
}

function IdList({ title, ids }: { title: string; ids: string[] }) {
  return (
    <div className="border-hair border-b py-[5px] last:border-b-0">
      <div className="text-mut text-[11.5px] tracking-[0.5px]">
        {title} · <span className="num">{ids.length}</span>
      </div>
      {ids.length > 0 ? (
        <div className="mt-1 font-mono text-[11px] break-all">
          {ids.join("、")}
        </div>
      ) : null}
    </div>
  );
}

export default async function MergeDonePage({
  params,
}: {
  params: Promise<{ seq: string }>;
}) {
  const { seq: raw } = await params;
  const seq = Number(raw);
  const receipt = Number.isFinite(seq) ? readMergeReceipt(seq) : null;

  if (!receipt) {
    return (
      <>
        <PageHead title="合并回执取不到了" sub={`审计行 seq ${raw}`} />
        <Panel title="发生了什么">
          <div className="text-[12.5px] leading-[1.9]">
            合并<b>已经做完并落库</b>（审计行 seq {raw} 就是它），
            但逐表搬迁明细只在进程内存里留了一份，服务重启后散了。
            <br />
            要复核这次合并：查 <code className="bg-code px-1">
              audit_log
            </code>{" "}
            的 seq {raw}（row_refs_json
            里是它动过的每一行），或直接打开落点考点看引用对不对。
          </div>
        </Panel>
        <div className="mt-4 text-[12.5px]">
          <Link className="text-acc-deep underline" href="/kg/merge">
            ← 再合一个
          </Link>
        </div>
      </>
    );
  }

  const r = receipt.result;
  const 总搬 = Object.values(r.moved).reduce((a, b) => a + b, 0);
  const 总丢 = Object.values(r.dropped).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHead
        title="合并完成"
        sub={
          <>
            审计行 seq <span className="num">{r.seq}</span> · 搬{" "}
            <span className="num">{总搬}</span> 行 · 去重丢弃{" "}
            <span className="num">{总丢}</span> 行
          </>
        }
        right={
          <Link
            className="text-acc-deep text-[12.5px] underline"
            href="/kg/merge"
          >
            再合一个
          </Link>
        }
      />

      <Panel title="from → to">
        <Row
          k="from（壳）"
          v={<span className="font-mono text-[11.5px]">{r.from}</span>}
        />
        <Row
          k="to（落点）"
          v={
            <Link
              href={`/kg/kp/${r.to}`}
              className="text-acc-deep font-mono text-[11.5px] underline"
            >
              {r.to}
            </Link>
          }
        />
      </Panel>

      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <CountTable title="moved · 整体改挂过去的行数" data={r.moved} />
        <CountTable
          title="dropped · to 侧已有同键、from 行被丢弃"
          data={r.dropped}
        />
      </div>

      <div className="mt-3.5">
        <Panel title="主考点裁决（🔴 静默吞掉主考点是本原语最要防的事）">
          <IdList title="primaryKept · 主考点跟着搬过去" ids={r.primaryKept} />
          <IdList
            title="primaryPromoted · to 侧原有次行被显式提为主"
            ids={r.primaryPromoted}
          />
          <IdList
            title="primaryDemoted · to 侧已是主，from 行降为次（防御分支）"
            ids={r.primaryDemoted}
          />
          <IdList
            title="errCodeDropped · to 侧已占同一 err_code，from 的映射被丢"
            ids={r.errCodeDropped}
          />
          <IdList
            title="edgeSelfLoops · 重挂后成自环被删的边"
            ids={r.edgeSelfLoops}
          />
        </Panel>
      </div>

      <div className="mt-3.5">
        <Panel
          title="合并后对账 · C2 悬挂引用"
          right={
            receipt.c2 ? (
              receipt.c2.ok ? (
                <Chip tone="g">C2 绿</Chip>
              ) : (
                <Chip tone="r">C2 红</Chip>
              )
            ) : (
              <Chip tone="a">没跑成</Chip>
            )
          }
        >
          {receipt.c2 ? (
            <>
              <Row k="检查项" v={receipt.c2.name} />
              <Row
                k="结论"
                v={
                  receipt.c2.ok
                    ? "没有任何引用指向 merged/retired 的考点 —— 这次合并没留悬挂"
                    : `🔴 有悬挂引用（level=${receipt.c2.level}）`
                }
              />
              {receipt.c2.details.length > 0 ? (
                <pre className="bg-code mt-2 max-h-[220px] overflow-auto rounded-[2px] p-2 text-[11.5px] whitespace-pre-wrap">
                  {receipt.c2.details.join("\n")}
                </pre>
              ) : null}
              <div className="text-mut mt-2 text-[12px]">
                本次对账整体：
                {receipt.integrityOk
                  ? "全绿（无红旗）"
                  : "有红旗（见首页对账卡）"}
              </div>
            </>
          ) : (
            <div className="text-pen text-[12.5px] whitespace-pre-wrap">
              对账没跑成：{receipt.integrityError ?? "原因不明"}
              <div className="text-mut mt-1">
                合并本身已经落库；对账可以手工再跑：pnpm exec tsx
                --env-file=.env scripts/integrity-check.ts
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
