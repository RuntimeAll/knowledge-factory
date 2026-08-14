/**
 * 队列 · 低置信工单的快捷处置：补别名（AI:PRD-002 · 002-D 原件，003-D 搬到 /queue；
 * AI:PRD-009 打磨批换壳）
 *
 * 工单里那句「问不出来的说法」是**现成的搜索词**：从它出发再搜一遍（这次由人看），
 * 认出目标考点后一键 = 补别名 + 工单判过（core 的 passQueueWithAlias 串完两笔写）。
 *
 * 🔴 这页的搜索同样 enqueue:false —— 处理低置信工单的过程里再开出新的低置信工单，
 *    是队列自我繁殖，很滑稽也很难清。
 * 🔴 别名默认就填工单里那句原话：agent 下次照原话问就能命中，这才是补别名的意义。
 *    （能改：人可能想补的是更规范的说法。）
 *
 * ── AI:PRD-009 打磨（只动版面与交互）────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；「补进它」统一走 ConfirmSubmit 弹层、
 *   影响面写清（检查单 7）；工单已裁时按钮禁用并说明原因（检查单 9）；
 *   候选表进横向滚动容器，手机上不撑破页面（检查单 5）。
 *
 * 🔴 版面小件已走 d 组的共享件（`components/console/page-head` + `/table`）；
 *    确认按钮走已收编的共享件 `~/components/console/confirm`
 *    （既有先例：本文件原本就从 `../../../kg/shared` 拿 param）——
 *    已由集成收口②收编进 `components/console/confirm`。
 */
import { Alert, Card, Input, Tag } from "antd";
import Link from "next/link";

import { EmptyHint, IdTail, StatusTag } from "~/components/console/ui";
import { getQueueItem, resolveKp, type KpCandidate } from "~/core";
import { ConfirmSubmit, PlainSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { TableBox, Td, Th } from "~/components/console/table";
import { param } from "../../../kg/shared";
import { quickAliasAction } from "../../actions";

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
        <PageHead title="快捷加别名" sub="这条工单不在库里" />
        <Alert
          type="error"
          showIcon
          message={`review_queue 里没有 id = ${id} 这一行`}
          description={
            <span style={{ fontSize: 12.5 }}>
              🔴 工单 id 是开单时发的号，编不出来 —— 回{" "}
              <Link href="/queue?tab=kp">处置台</Link> 从列表点进来。
            </span>
          }
        />
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
      searchError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  const 已裁 = item.state !== "open";

  return (
    <>
      <PageHead
        title="把这句说法补进词表"
        tags={<StatusTag value={item.state} />}
        sub={<>{item.kind ?? "（未分类）"} · 一键 = 补别名 + 工单判过</>}
        source={
          <>
            core.getQueueItem / core.resolveKp（enqueue:false）· 写走
            core.passQueueWithAlias（一笔事务：kp_alias + review_queue）
          </>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
          fontSize: 12.5,
        }}
      >
        <Link href="/queue?tab=kp">← 回处置台</Link>
        <IdTail id={item.id} />
      </div>

      {已裁 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message={`这条工单已经是 ${item.state} 了 —— 终态不重裁，下面只能看`}
          description={
            <span style={{ fontSize: 12.5 }}>
              {item.verdictBy ?? "未记名"} 于 {item.verdictAt ?? "时间未知"}{" "}
              裁的
              {item.verdictNote ? `：${item.verdictNote}` : ""}
            </span>
          }
        />
      ) : null}
      {searchError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="搜索没跑成（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{searchError}</span>}
        />
      ) : null}

      <Card size="small" title="工单说的是">
        <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          {item.reason ?? "（没写理由）"}
        </div>
        {原话 ? (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            agent 当时问的是：
            <b
              style={{
                background: "#fdf6ec",
                padding: "1px 6px",
                marginInlineStart: 4,
              }}
            >
              {原话}
            </b>
          </div>
        ) : (
          <div style={{ marginTop: 8, fontSize: 12.5, color: "#909399" }}>
            payload 里没有 query 字段 —— 这条不是 resolve_kp 开的低置信工单，
            补别名得自己填说法。
          </div>
        )}
      </Card>

      <Card
        size="small"
        title="① 找到它到底指哪个考点"
        style={{ marginTop: 12 }}
        extra={
          <form
            method="GET"
            style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <Input
              name="q"
              defaultValue={q}
              size="small"
              style={{ width: 200 }}
              placeholder="换个说法再搜"
            />
            <PlainSubmit label="搜" />
          </form>
        }
      >
        {candidates.length === 0 ? (
          <EmptyHint>
            {q ? (
              <>
                按「{q}」一条候选都没有。🔴 这不等于「库里没有这个考点」——
                resolve_kp 走的是名字/别名的字面四路，说法不一样就落空。
                换个更贴近考点名的说法；确实还没建这个考点的话， 该做的是
                <b>驳回工单并去建考点</b>，不是硬塞给一个不相干的。
              </>
            ) : (
              "输入一个词开始找。"
            )}
          </EmptyHint>
        ) : (
          <TableBox>
            <thead>
              <tr>
                <Th>考点</Th>
                <Th width={64}>把握</Th>
                <Th width={150}>怎么命中的</Th>
                <Th width={320}>② 一键：补别名 + 判过</Th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.kpId}>
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
                  <Td>
                    <form
                      action={quickAliasAction}
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <input type="hidden" name="queueId" value={item.id} />
                      <input type="hidden" name="kpId" value={c.kpId} />
                      <input type="hidden" name="kpName" value={c.name} />
                      <Input
                        name="alias"
                        required
                        size="small"
                        style={{ width: 170 }}
                        defaultValue={原话 || q}
                      />
                      <ConfirmSubmit
                        label="补进它"
                        primary
                        disabled={已裁}
                        disabledReason={`工单已经是 ${item.state}，终态不重裁`}
                        title={`把这句说法补给「${c.name}」？`}
                        okText="补进去并判过"
                        description={
                          <>
                            一笔事务做两件事：往 <b>kp_alias</b> 加这条别名 +
                            把本工单判 <b>passed</b>。
                            <br />
                            后果：agent 下次照这句话问就<b>直接命中</b>
                            这个考点，同样的低置信工单不会再来。
                            <br />
                            🔴
                            别硬塞给不相干的考点：词表脏了，之后每一次检索都在还这笔债
                            —— 拿不准就走「驳回」。
                          </>
                        }
                      />
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        )}
      </Card>

      <div
        style={{
          marginTop: 16,
          fontSize: 12,
          color: "#909399",
          lineHeight: 1.9,
        }}
      >
        都不对？那这条说法可能对应一个<b>还没建的考点</b> —— 去
        <Link
          href={`/queue/${item.id}/reject`}
          style={{ marginInline: 4, color: "#c45656" }}
        >
          驳回
        </Link>
        并写清楚，别硬塞给一个不相干的考点。
        <Tag style={{ marginInlineStart: 8 }}>建考点是脚本口，页面上不做</Tag>
      </div>
    </>
  );
}
