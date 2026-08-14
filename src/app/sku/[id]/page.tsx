/**
 * 生产管理 · SKU 详情（AI:PRD-008 · P2 · 设计稿 §二·8「操作列 → 详情」）
 *
 * 一本册子的全貌：基本信息 + 题单（ord 对位）+ 产物清单 + 配方 + 挂桥。
 * **不管**：建册/装题/登记产出（数据生产类，走 MCP）。
 *
 * 🔴 全 server component + 现算：`getSku` 一次把三张表读齐（sku / sku_item /
 *    sku_output + grading_task_map），页面不缓存任何一个数。
 * 🔴 页面上唯一的写是「上架/下架」，而且**只给一条通往确认页的链接** ——
 *    真正改库在 `../actions.ts` 的 server action 里（core 的 setSkuStatus + 审计行）。
 * 🔴 详情页不进菜单（若依习惯：要 id 才打得开），面包屑走 menu.ts 的 HIDDEN_CRUMBS。
 */
import { Alert, Card, Descriptions, Tag, Tooltip } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import {
  EmptyHint,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import { getSku } from "~/core";
import { parseNetdisk } from "../shared";
import { RecipeDrawer, SkuItemsTable, SkuOutputsTable } from "./panels";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function SkuDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const ok = one(sp, "ok");
  const err = one(sp, "err");

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
        message="这本册子读不出来（原文照登）"
        description={
          <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {loadError}
            {"\n"}
            id = {id}
          </div>
        }
      />
    );
  }

  if (!card) {
    return (
      <Card size="small">
        <EmptyHint>
          sku 表里没有 id = {id} 这一行。🔴 册子 id 是「register_sku
          的返回」，编不出来也猜不出来 —— 回 <Link href="/sku">SKU 台账</Link>{" "}
          从列表点进来。
        </EmptyHint>
      </Card>
    );
  }

  const { netdisk, broken } = parseNetdisk(card.recipeJson);
  const 下一态 = card.status === "active" ? "retired" : "active";
  const 动作名 = card.status === "active" ? "下架" : "上架";

  return (
    <>
      {/* 🔴 flexWrap：册名本来就长，窄屏上不换行会把标题挤成竖排（全站页头一律 wrap） */}
      <PageHead
        title={<>{card.name}</>}
        tags={
          <>
            <StatusTag value={card.status} />
            {card.type ? <Tag>{card.type}</Tag> : null}
          </>
        }
        source={
          <>core.getSku · 表 sku / sku_item / sku_output / grading_task_map</>
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
      {ok ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{ok}</span>}
        />
      ) : null}

      {/* 🔴 flexWrap + rowGap：手机上这一排链接必须能折行，否则「展开配方」被挤出屏幕 */}
      <div
        style={{
          display: "flex",
          gap: 14,
          rowGap: 8,
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <Link href="/sku">← 回台账</Link>
        {/* 🔴 文案说清点下去会发生什么：这一步只到确认页，不改库 */}
        <Link href={`/sku/${card.id}/status?to=${下一态}`}>
          {动作名}…（先看确认页）
        </Link>
        <Link href={`/sku/${card.id}/dedup`}>排重报告</Link>
        <Link href={`/output?sku=${card.id}`}>本册产物</Link>
        <span style={{ marginLeft: "auto" }}>
          <RecipeDrawer name={card.name} json={card.recipeJson} />
        </span>
      </div>

      <Card size="small" title="基本信息" style={{ marginBottom: 12 }}>
        <Descriptions
          size="small"
          // 🔴 响应式列数：手机一列、平板两列、桌面三列。
          //    写死 column={3} 在 390px 宽的屏上会把「版本语境」压成一列一个字。
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            {
              key: "type",
              label: "类型",
              children: card.type ?? "（未填）",
            },
            {
              key: "status",
              label: "状态",
              children: <StatusTag value={card.status} />,
            },
            {
              key: "layout",
              label: "版式",
              children: card.layout ?? "（未填）",
            },
            {
              key: "edition",
              label: "版本语境",
              children: card.editionCtx ?? "（未填）",
            },
            {
              key: "created",
              label: "建档时间",
              children: <TimeText iso={card.createdAt} />,
            },
            {
              key: "id",
              label: "id",
              children: <IdTail id={card.id} />,
            },
            {
              key: "counts",
              label: "题数 / 产物数",
              children: `${card.counts.items} 题 / ${card.counts.outputs} 件`,
            },
            {
              key: "netdisk",
              label: "网盘指针",
              children: netdisk ? (
                <Tooltip
                  title={netdisk.raw}
                  styles={{ root: { maxWidth: 520 } }}
                >
                  <span>
                    <Tag color="green">{netdisk.code ?? "有链接"}</Tag>
                    {netdisk.link ? (
                      <a href={netdisk.link} target="_blank" rel="noreferrer">
                        打开
                      </a>
                    ) : null}
                  </span>
                </Tooltip>
              ) : broken ? (
                <span style={{ color: "#c45656" }}>
                  recipe_json 解析不了（坏 JSON）
                </span>
              ) : (
                <Tooltip title="recipe_json 里没有 netdisk 段。它的意思是「这本册子的配方里没记网盘」，不是「没传过网盘」">
                  <span style={{ color: "#909399" }}>配方里没记</span>
                </Tooltip>
              ),
            },
            {
              key: "bridge",
              label: "挂桥（圣域任务）",
              children: card.taskMap ? (
                <Tooltip
                  title={`登记于 ${card.taskMap.createdAt ?? "（没记时间）"}${
                    card.taskMap.note ? `\n附注：${card.taskMap.note}` : ""
                  }`}
                >
                  <Tag color="blue">task {card.taskMap.taskId}</Tag>
                </Tooltip>
              ) : (
                <Tooltip title="grading_task_map 里没有这本册子 —— 学情回流找不到它的作答（打卡天卷才需要挂桥）">
                  <span style={{ color: "#909399" }}>没挂桥</span>
                </Tooltip>
              ),
            },
          ]}
        />
      </Card>

      <Card
        size="small"
        title={`题单（ord 对位 · ${card.counts.items} 题）`}
        style={{ marginBottom: 12 }}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            ord = 卷面题号，学情回流按它对位；排序永远按 ord
          </span>
        }
      >
        <SkuItemsTable items={card.items} />
      </Card>

      <Card
        size="small"
        title={`产物（${card.counts.outputs} 件）`}
        extra={
          <span style={{ fontSize: 12, color: "#909399" }}>
            字节按 sha256 存进内容仓，路径只是指针；下载走
            /api/asset/&lt;hash&gt;
          </span>
        }
      >
        <SkuOutputsTable outputs={card.outputs} skuName={card.name} />
      </Card>
    </>
  );
}
