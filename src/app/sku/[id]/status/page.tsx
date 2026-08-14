/**
 * SKU 上架 / 下架 · 二次确认页（AI:PRD-008 · P2 · 白名单第二类）
 *
 * 🔴 为什么是一张页而不是一个 Popconfirm：003-D 定下的规矩 ——
 *    **会改库的动作走确认页**，页面上摆清楚「这本册子叫什么、现在什么态、
 *    要改成什么、这一改到底影响谁」，人看完再按。改版换的是版式，不是这条规矩。
 * 🔴 口径不许含糊（写在页面上给人看，不只写在注释里）：
 *    ① core 的 setSkuStatus **不校验流转方向**（下架的册子重新上架是真事）；
 *    ② 这一改**只动 `sku.status` 一列**，不动题、不动产物、不动挂桥；
 *    ③ 查重（assertNoSoldDuplicates）撞不撞车看的是**题的 match_key 与题的状态**，
 *       不看册子在不在售 —— 所以「下架」不会让这本册子的题从查重里消失，
 *       它只是在排重报告里显示成 retired。
 */
import { Alert, Card, Descriptions } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import { EmptyHint, StatusTag, TimeText } from "~/components/console/ui";
import { SKU_STATUSES, getSku } from "~/core";
import { ConfirmSubmit } from "~/components/console/confirm";
import { setSkuStatusAction } from "../../actions";

export const dynamic = "force-dynamic";

const 说明: Record<string, string> = {
  active: "在售：这本册子是「卖的/发出去的」那一档。",
  retired: "下架：不再卖了。册子、题单、产物、审计痕迹一样不删。",
  draft: "草稿：登记了但还没开卖（register_sku 的默认落点）。",
};

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function SkuStatusConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const to = one(sp, "to");

  // 🔴 读不出来也要原文照登：确认页读不到卡就直接 500 白屏，
  //    人只会看到「这页坏了」，看不到「库连不上」这条真消息。
  let card: Awaited<ReturnType<typeof getSku>> = null;
  let loadError = "";
  try {
    card = await getSku(id);
  } catch (e) {
    loadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="这本册子读不出来，确认页不能给你按（原文照登）"
        description={
          <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {loadError}
            {"\n"}id = {id}
            {"\n\n"}
            <Link href={`/sku/${id}`}>回册子详情</Link> 再试一次。
          </div>
        }
      />
    );
  }

  if (!card) {
    return (
      <Card size="small">
        <EmptyHint>
          sku 表里没有 id = {id} 这一行 —— 回 <Link href="/sku">SKU 台账</Link>{" "}
          从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  if (!(SKU_STATUSES as readonly string[]).includes(to)) {
    return (
      <Alert
        type="error"
        showIcon
        message={`目标状态「${to || "（没给）"}」不在 sku 的三态里`}
        description={
          <span style={{ fontSize: 12.5 }}>
            合法的是 {SKU_STATUSES.join(" / ")}。回{" "}
            <Link href={`/sku/${id}`}>册子详情</Link> 从按钮进来，别手改地址栏。
          </span>
        }
      />
    );
  }

  const 同态 = card.status === to;

  return (
    <>
      {/* 🔴 flexWrap：窄屏上不换行会把标题挤成竖排（全站页头一律 wrap） */}
      <PageHead
        title={
          <>
            {to === "active" ? "上架" : to === "retired" ? "下架" : "改回草稿"}·
            确认
          </>
        }
        sub={<>确认之后才改库 —— 这一步只改 sku.status 一列，并留一条审计行</>}
        source={<>core.setSkuStatus · 表 sku（单列 update）</>}
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <Descriptions
          size="small"
          // 🔴 响应式：手机一列。确认页尤其不能挤 ——「从什么改成什么」看不清就等于没确认
          column={{ xs: 1, sm: 2 }}
          items={[
            { key: "name", label: "册子", children: card.name },
            {
              key: "type",
              label: "类型",
              children: card.type ?? "（未填）",
            },
            {
              key: "from",
              label: "现在的状态",
              children: <StatusTag value={card.status} />,
            },
            {
              key: "to",
              label: "要改成",
              children: <StatusTag value={to} />,
            },
            {
              key: "counts",
              label: "题数 / 产物数",
              children: `${card.counts.items} 题 / ${card.counts.outputs} 件（这一改一样不动）`,
            },
            {
              key: "created",
              label: "建档时间",
              children: <TimeText iso={card.createdAt} />,
            },
          ]}
        />
      </Card>

      <Alert
        type={同态 ? "warning" : "info"}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          同态
            ? `这本册子现在就是 ${to} —— 再按一次不会报错（core 不校验流转方向），只会多一条什么都没改的审计行。`
            : `${说明[to] ?? ""}`
        }
        description={
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            <div>
              · 这一步<b>只改 sku.status 一列</b>
              ：题单、产物、挂桥、审计痕迹一样不动。
            </div>
            <div>
              · 查重看的是<b>题的 match_key 与题的状态</b>，不看册子在不在售
              ——「下架」 不会让这本册子的题从 assertNoSoldDuplicates
              里消失，只是排重报告里那本册子显示成 retired。
            </div>
            <div>
              · core 的 setSkuStatus
              不校验流转方向（下架的册子重新上架是真事），
              但每一跳都留一条审计行。
            </div>
          </div>
        }
      />

      <Card size="small" title="确认">
        <form action={setSkuStatusAction}>
          <input type="hidden" name="id" value={card.id} />
          <input type="hidden" name="to" value={to} />
          <input type="hidden" name="back" value={`/sku/${card.id}`} />
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12.5, color: "#606266" }}>
              备注（可空，会记进这条审计行的参数里）
              <br />
              <textarea
                name="note"
                rows={2}
                style={{
                  width: "100%",
                  maxWidth: 620,
                  marginTop: 4,
                  fontSize: 12.5,
                  padding: 6,
                  border: "1px solid #dcdfe6",
                  borderRadius: 3,
                }}
                placeholder="例：第 01 期打完收工，天卷统一下架"
              />
            </label>
          </div>
          {/* 🔴 提交按钮是唯一的 client 组件（确认页整体仍是 server component）：
              它要的是**提交态** —— 原来那个原生 button 点两下就落两条审计行。
              文案写「从什么改成什么」，不写「确定」。
              🔴 集成收口②：本页原来内联的 `./submit.tsx`（只有防连点、没有弹层）
              已被删掉，统一走 `~/components/console/confirm` 那份 ——
              检查单 §三·7 要的是「统一形态 + 列明影响面」，所以最后这一下
              也和全站其余五类写操作一样再弹一层（确认页照旧留着，规矩不改）。 */}
          <ConfirmSubmit
            label={
              to === "active"
                ? `确认上架（状态 ${card.status ?? "空"} → active）`
                : to === "retired"
                  ? `确认下架（状态 ${card.status ?? "空"} → retired）`
                  : `确认改回草稿（状态 ${card.status ?? "空"} → draft）`
            }
            title={
              to === "retired"
                ? "确认把这本册子下架？"
                : to === "active"
                  ? "确认把这本册子上架？"
                  : "确认把这本册子改回草稿？"
            }
            description={
              <>
                <div>
                  · 册子：<b>{card.name ?? card.id}</b>
                </div>
                <div>
                  · 状态：<b>{card.status ?? "空"}</b> → <b>{to}</b>
                  （只改 sku.status 一列）
                </div>
                <div>· 题单 / 产物 / 挂桥 / 审计痕迹：一样不动。</div>
                <div>· 会落一条审计行；改错了原路再改回来即可（可逆）。</div>
              </>
            }
            okText={to === "retired" ? "确认下架" : "确认"}
            danger={to === "retired"}
            cancelHref={`/sku/${card.id}`}
            block
          />
        </form>
      </Card>
    </>
  );
}
