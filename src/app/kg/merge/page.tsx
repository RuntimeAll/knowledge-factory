/**
 * KG 治理 · 合并向导 第一步：挑 from / to（AI:PRD-002 · 002-D；AI:PRD-009 换壳）
 *
 * 两个搜索框 = 两次 resolve_kp（服务端跑，候选带 confidence）。
 * 🔴 enqueue:false —— 人在页面上搜东西**不是** agent 的低置信信号：
 *    往 review_queue 里塞工单的判据是「agent 问不出来」，不是「人手一直在打字」。
 *    这条不设防的话，队列会被每一次按键翻页塞满噪音。
 * 🔴 这页不动任何数据。真正的合并在第二步（预览页）确认后才发生。
 *
 * ── AI:PRD-009 打磨（只动版面）──────────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；候选列表改成表格（把握/命中路径成列，
 *   长名字不再把行挤散，检查单 3）；空态给口径（检查单 6）；
 *   「下一步」不满足条件时**明说缺什么**而不是只灰着（检查单 9）。
 */
import { Alert, Card, Input, Space, Tag } from "antd";
import Link from "next/link";

import { DataSourceNote, EmptyHint, StatusTag } from "~/components/console/ui";
import { resolveKp, type KpCandidate } from "~/core";
import { PlainSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { MONO, TableBox, Td, Th } from "~/components/console/table";
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
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
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
      <div style={{ marginTop: 8 }}>
        <EmptyHint>
          {q ? (
            <>
              按「{q}」一条候选都没有。🔴
              这不等于「库里没有这个考点」——resolve_kp
              走的是名字/别名的字面四路，
              说法不一样就落空：换个更贴近考点名的说法再搜一次。
            </>
          ) : (
            "上面输个词开始找（一句人话就行，如「绝对值」）。"
          )}
        </EmptyHint>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      <TableBox>
        <thead>
          <tr>
            <Th width={64}>选</Th>
            <Th>考点</Th>
            <Th width={64}>把握</Th>
            <Th>怎么命中的</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            // 选中一侧时另一侧保持不变，两个搜索词也带着走（刷新回来还在原处）
            const next = new URLSearchParams();
            next.set(side, c.kpId);
            next.set(
              side === "from" ? "to" : "from",
              side === "from" ? to : from,
            );
            next.set(side === "from" ? "qf" : "qt", q);
            return (
              <tr key={c.kpId}>
                <Td nowrap>
                  <Link href={`/kg/merge?${next.toString()}`}>选它</Link>
                </Td>
                <Td>
                  <Link href={`/kg/kp/${c.kpId}`}>{c.name}</Link>
                  <StatusTag value={c.status} />
                </Td>
                <Td num>{c.confidence}</Td>
                <Td>
                  <span style={{ color: "#909399", fontSize: 11.5 }}>
                    {c.matchedVia}
                    {c.aliasHit ? ` · 别名「${c.aliasHit}」` : ""}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableBox>
    </div>
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
    <form
      method="GET"
      action="/kg/merge"
      style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
    >
      {/* GET 表单：另一侧的选择与搜索词用 hidden 带着，不然一搜就丢 */}
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <input
        type="hidden"
        name={side === "from" ? "qt" : "qf"}
        value={side === "from" ? qt : qf}
      />
      <Input
        name={side === "from" ? "qf" : "qt"}
        defaultValue={value}
        size="small"
        style={{ width: 220 }}
        placeholder="一句人话，如「绝对值」"
      />
      <PlainSubmit label="搜" />
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
          <DataSourceNote>
            core.resolveKp（enqueue:false，页面搜索不入低置信队列）· 表 kp /
            kp_alias
          </DataSourceNote>
        }
      />

      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{err}</span>}
        />
      ) : null}
      {左.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="左侧搜索没跑成（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{左.error}</span>}
        />
      ) : null}
      {右.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="右侧搜索没跑成（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{右.error}</span>}
        />
      ) : null}

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <Card
          size="small"
          title="from · 被合并掉的那个"
          extra={from ? <Tag color="orange">已选</Tag> : <Tag>未选</Tag>}
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
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid #ebeef5",
                fontSize: 12.5,
              }}
            >
              已选：<b>{选中(from, 左.candidates)}</b>
              <span
                style={{
                  ...MONO,
                  color: "#909399",
                  fontSize: 10.5,
                  marginInlineStart: 8,
                }}
              >
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
        </Card>

        <Card
          size="small"
          title="to · 留下的那个（必须 active）"
          extra={to ? <Tag color="green">已选</Tag> : <Tag>未选</Tag>}
        >
          <SearchBox side="to" value={qt} from={from} to={to} qf={qf} qt={qt} />
          {to ? (
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid #ebeef5",
                fontSize: 12.5,
              }}
            >
              已选：<b>{选中(to, 右.candidates)}</b>
              <span
                style={{
                  ...MONO,
                  color: "#909399",
                  fontSize: 10.5,
                  marginInlineStart: 8,
                }}
              >
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
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Space size={14} wrap>
          {from && to ? (
            <Link
              href={`/kg/merge/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
            >
              下一步：看看会搬走什么 →
            </Link>
          ) : (
            <span style={{ color: "#909399", fontSize: 12.5 }}>
              还差
              {!from && !to
                ? "两侧都没选"
                : !from
                  ? "左边（from · 被合并掉的那个）"
                  : "右边（to · 留下的那个）"}
              —— 两边都选好才能看预览。
            </span>
          )}
          {from || to ? <Link href="/kg/merge">清空重选</Link> : null}
          <Link href="/kg">← 回总览</Link>
        </Space>
      </div>

      <div
        style={{
          marginTop: 18,
          paddingTop: 12,
          borderTop: "1px solid #ebeef5",
          color: "#909399",
          fontSize: 12,
          lineHeight: 1.9,
        }}
      >
        搜索走 resolve_kp（与 agent 同一口径、同一打分），
        <b>但页面搜索不入低置信队列</b> —— 队列记的是「agent
        问不出来」，不是人在打字。
      </div>
    </>
  );
}
