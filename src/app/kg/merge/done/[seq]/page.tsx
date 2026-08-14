/**
 * KG 治理 · 合并结果（AI:PRD-002 · 002-D；AI:PRD-009 换壳）
 *
 * 把 MergeKpResult **原样**摆出来：逐表 moved/dropped、三种主考点裁决、
 * err_code_map 丢掉的码、kp_edge 自环，一个字段都不省 —— 合并唯一会「安静地丢东西」
 * 的地方就在这些数字里，藏一个就等于把风险藏起来。
 * 再贴上合并后那次对账的 C2（悬挂引用）结论：绿 = 这次合并没留悬挂，机器背书。
 *
 * 🔴 回执存在进程内存里（见 merge-store.ts）：服务重启就没了。取不到时如实说，
 *    并给出审计行 seq 与落点考点 —— 合并本身已经落库，找得回来。
 *
 * ── AI:PRD-009 打磨（只动版面）──────────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；回执取不到时的那页补上「下一步去哪」
 *   （审计日志页 / 落点考点，检查单 4+6）。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import { IdTail } from "~/components/console/ui";
import { readMergeReceipt } from "../../../merge-store";
import { PageHead } from "~/components/console/page-head";
import { KV, MONO, Num } from "~/components/console/table";
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
    <Card size="small" title={title}>
      {rows.length === 0 ? (
        <div style={{ color: "#909399", fontSize: 12.5 }}>（空）</div>
      ) : (
        rows.map(([t, n]) => <KV key={t} k={t} v={<Num n={n} />} />)
      )}
    </Card>
  );
}

function IdList({ title, ids }: { title: string; ids: string[] }) {
  return (
    <div
      style={{
        borderBottom: "1px solid #f0f2f5",
        padding: "5px 0",
      }}
    >
      <div style={{ color: "#909399", fontSize: 11.5 }}>
        {title} · <Num n={ids.length} />
      </div>
      {ids.length > 0 ? (
        <div
          style={{
            ...MONO,
            marginTop: 4,
            fontSize: 11,
            wordBreak: "break-all",
          }}
        >
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
        <Alert
          type="warning"
          showIcon
          message="合并已经做完并落库 —— 丢的只是这张明细回执"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              审计行 seq {raw} 就是它，但逐表搬迁明细只在进程内存里留了一份，
              服务重启后散了。
              <br />
              要复核这次合并：查 <code style={MONO}>audit_log</code> 的 seq{" "}
              {raw}
              （row_refs_json
              里是它动过的每一行），或直接打开落点考点看引用对不对。
            </div>
          }
        />
        <div
          style={{ marginTop: 14, display: "flex", gap: 16, fontSize: 12.5 }}
        >
          {/* 🔴 /audit 是 seq 倒序全表、没有按 seq 定位的入参：
              话就照实说「去翻」，别写成「查这一行」骗人点。 */}
          <Link href="/audit">去审计日志翻 seq {raw} →</Link>
          <Link href="/kg/merge">← 再合一个</Link>
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
        tags={<Tag color="green">已落库</Tag>}
        sub={
          <>
            审计行 seq <Num n={r.seq} /> · 搬 <Num n={总搬} /> 行 · 去重丢弃{" "}
            <Num n={总丢} /> 行
          </>
        }
        source={
          <>
            core.mergeKp 的返回（原样照登）+ 合并后即跑的 core.integrityCheck ·
            C2
          </>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 12,
          fontSize: 12.5,
        }}
      >
        <Link href={`/kg/kp/${r.to}`}>看落点考点 →</Link>
        <Link href="/kg/merge">再合一个</Link>
        <Link href="/kg">← 回总览</Link>
      </div>

      <Card size="small" title="from → to">
        <KV k="from（壳）" v={<IdTail id={r.from} />} />
        <KV
          k="to（落点）"
          v={
            <span>
              <Link href={`/kg/kp/${r.to}`}>看它 →</Link>
              <span style={{ marginInlineStart: 8 }}>
                <IdTail id={r.to} />
              </span>
            </span>
          }
        />
      </Card>

      <div
        style={{
          marginTop: 12,
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <CountTable title="moved · 整体改挂过去的行数" data={r.moved} />
        <CountTable
          title="dropped · to 侧已有同键、from 行被丢弃"
          data={r.dropped}
        />
      </div>

      <Card
        size="small"
        title="主考点裁决（🔴 静默吞掉主考点是本原语最要防的事）"
        style={{ marginTop: 12 }}
      >
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
      </Card>

      <Card
        size="small"
        title="合并后对账 · C2 悬挂引用"
        style={{ marginTop: 12 }}
        extra={
          receipt.c2 ? (
            receipt.c2.ok ? (
              <Tag color="green">C2 绿</Tag>
            ) : (
              <Tag color="red">C2 红</Tag>
            )
          ) : (
            <Tag color="orange">没跑成</Tag>
          )
        }
      >
        {receipt.c2 ? (
          <>
            <KV k="检查项" v={receipt.c2.name} />
            <KV
              k="结论"
              v={
                receipt.c2.ok
                  ? "没有任何引用指向 merged/retired 的考点 —— 这次合并没留悬挂"
                  : `🔴 有悬挂引用（level=${receipt.c2.level}）`
              }
            />
            {receipt.c2.details.length > 0 ? (
              <pre
                style={{
                  background: "#f4f4f5",
                  marginTop: 8,
                  padding: 8,
                  maxHeight: 220,
                  overflow: "auto",
                  fontSize: 11.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {receipt.c2.details.join("\n")}
              </pre>
            ) : null}
            <div style={{ marginTop: 8, fontSize: 12, color: "#909399" }}>
              本次对账整体：
              {receipt.integrityOk ? (
                "全绿（无红旗）"
              ) : (
                <>
                  有红旗（<Link href="/health">去对账页看 →</Link>）
                </>
              )}
            </div>
          </>
        ) : (
          <Alert
            type="error"
            showIcon
            message="对账没跑成 —— 合并本身已经落库"
            description={
              <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                {receipt.integrityError ?? "原因不明"}
                {"\n"}对账可以手工再跑：pnpm exec tsx --env-file=.env
                scripts/integrity-check.ts
              </div>
            }
          />
        )}
      </Card>
    </>
  );
}
