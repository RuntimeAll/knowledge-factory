"use client";

/**
 * 册子详情的四个 tab（AI:PRD-009 · D-B `/shelf/doc/[id]`）
 *
 * 🔴🔴 同名异库：这里显示的全是 **punch 库（`举一反三产物/资料库.db`）** 的东西 ——
 *      物料/配图/成品卷/题目分组都属于那条资料产线，**不是**本库的题与产物。
 *      本组件一行库都不读（数据由 server 现算好传进来），也**没有任何写控件**。
 *
 * 🔴 A/B 号开关**同时管物料与配图**：配图必须跟文案同号（A 号的文案配 A 号的图），
 *    这是发布纪律（双号防判重靠整条线隔离，不是换个水印）。所以状态在这一处持有。
 * 🔴 `页图` 不分号：它是逐页成品图，两个号都用得上，切号时照常显示并标明。
 * 🔴 「卷 vs 图」用 `类型.includes("卷")` 判 —— **不能用 endsWith**，
 *    否则 `题目卷A` / `答案卷B` 会被当成图片渲染成一片碎图（punch-console 点名的坑）。
 */
import {
  Alert,
  Card,
  Empty,
  Image,
  Segmented,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";

import { EmptyHint, TimeText } from "~/components/console/ui";
import {
  assetAccount,
  assetIsPaper,
  parseTopics,
  shelfFileUrl,
  type ShelfAssetView,
  type ShelfDocDetailView,
  type ShelfMaterialView,
  type ShelfPublishLogView,
} from "../../shared";

// ---------------------------------------------------------------------------
// ① 物料（A/B 切换，不平铺）
// ---------------------------------------------------------------------------

function MaterialCard({ m }: { m: ShelfMaterialView }) {
  const topics = parseTopics(m.topicsRaw);
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
      <div style={{ marginBottom: 8 }}>
        <b>标题</b>
        {m.title ? (
          <Typography.Paragraph
            copyable={{ text: m.title, tooltips: ["复制标题", "已复制"] }}
            style={{ margin: "2px 0 0", fontSize: 13 }}
          >
            {m.title}
          </Typography.Paragraph>
        ) : (
          <div style={{ color: "#909399" }}>
            这份物料没写标题（material.标题 为空）——
            不是没物料，是标题这一栏空着
          </div>
        )}
      </div>

      <div style={{ marginBottom: 8 }}>
        <b>正文</b>
        {m.body ? (
          <Typography.Paragraph
            copyable={{ text: m.body, tooltips: ["复制全文", "已复制"] }}
            style={{
              margin: "2px 0 0",
              whiteSpace: "pre-wrap",
              background: "#fafafa",
              border: "1px solid #ebeef5",
              padding: 10,
            }}
          >
            {m.body}
          </Typography.Paragraph>
        ) : (
          <div style={{ color: "#909399" }}>正文为空</div>
        )}
      </div>

      <div style={{ marginBottom: 8 }}>
        <b>话题词</b>{" "}
        <Tooltip title="🔴 标签不进正文（粘进正文不会变成话题）">
          <span style={{ color: "#909399", fontSize: 11.5 }}>
            （{topics.length} 个）
          </span>
        </Tooltip>
        <div style={{ marginTop: 2 }}>
          {topics.length === 0 ? (
            <span style={{ color: "#909399" }}>没记话题词</span>
          ) : (
            topics.map((t) => (
              <Tag key={t} style={{ marginBottom: 4 }}>
                #{t}
              </Tag>
            ))
          )}
        </div>
      </div>

      {m.goodsDesc ? (
        <div style={{ marginBottom: 8 }}>
          <b>商品上架描述</b>
          <Typography.Paragraph
            copyable={{ text: m.goodsDesc, tooltips: ["复制", "已复制"] }}
            style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}
          >
            {m.goodsDesc}
          </Typography.Paragraph>
        </div>
      ) : null}

      {m.netdiskWords ? (
        <div style={{ marginBottom: 4 }}>
          <b>网盘分享语</b>
          <Typography.Paragraph
            copyable={{
              text: m.netdiskWords,
              tooltips: ["复制三行", "已复制"],
            }}
            style={{ margin: "2px 0 0", whiteSpace: "pre-wrap" }}
          >
            {m.netdiskWords}
          </Typography.Paragraph>
        </div>
      ) : null}

      <div style={{ fontSize: 11.5, color: "#909399" }}>
        {m.isActive ? "在用" : "已停用（is_active=0）"} ·{" "}
        {m.burned ? "已烧（发过）" : "未烧"} · 建档{" "}
        <TimeText iso={m.createdAt} />
        <span style={{ marginLeft: 8 }}>
          🔴 物料正本是册目录里的 <code>_交付/发布物料*.md</code>
          ，库里这份是它的投影
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ② 产物（成品卷 + 图墙，图按当前号过滤）
// ---------------------------------------------------------------------------

function PaperList({ papers }: { papers: ShelfAssetView[] }) {
  if (papers.length === 0) {
    return (
      <EmptyHint>
        这一册没登记成品卷（题目卷/答案卷/合订卷）。有的册子只出图不出卷 ——
        「没有卷」不等于「没有交付」。
      </EmptyHint>
    );
  }
  const columns: ColumnsType<ShelfAssetView> = [
    {
      title: "角色",
      dataIndex: "type",
      width: 96,
      render: (_, r) => <Tag>{r.type}</Tag>,
    },
    {
      title: "文件",
      dataIndex: "path",
      ellipsis: true,
      render: (_, r) => (
        <Tooltip title={r.path}>
          <span
            style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 11.5 }}
          >
            {r.path.split(/[\\/]/).pop()}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "操作",
      key: "op",
      width: 210,
      render: (_, r) => (
        <span style={{ fontSize: 12.5 }}>
          <a href={shelfFileUrl(r.path)} target="_blank" rel="noreferrer">
            在线看
          </a>
          <span style={{ color: "#dcdfe6" }}> · </span>
          <a href={shelfFileUrl(r.path, true)}>下载</a>
          <span style={{ color: "#dcdfe6" }}> · </span>
          <Typography.Text
            copyable={{ text: r.path, tooltips: ["复制本机路径", "已复制"] }}
            style={{ fontSize: 12.5 }}
          >
            路径
          </Typography.Text>
        </span>
      ),
    },
  ];
  return (
    <Table<ShelfAssetView>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={papers}
      pagination={false}
      scroll={{ x: 620 }}
    />
  );
}

function Gallery({
  images,
  account,
}: {
  images: ShelfAssetView[];
  account: "A" | "B";
}) {
  const 本号 = images.filter((a) => assetAccount(a.type) === account);
  const 不分号 = images.filter((a) => assetAccount(a.type) === null);
  const 显示 = [...本号, ...不分号];

  if (images.length === 0) {
    return (
      <EmptyHint>这一册没登记配图（asset 里没有图A/图B/页图）。</EmptyHint>
    );
  }
  if (显示.length === 0) {
    return (
      <EmptyHint>
        {account} 号没有配图（另一个号有 {images.length} 张）。🔴
        双号必须整条线隔离：数据源同一份，换骨架各出一次 ——
        缺一号就是这一步没跑。
      </EmptyHint>
    );
  }

  return (
    <>
      <div style={{ fontSize: 12, color: "#909399", marginBottom: 8 }}>
        {account} 号 {本号.length} 张
        {不分号.length > 0
          ? ` · 页图 ${不分号.length} 张（不分号，两个号都用）`
          : ""}
        {" · "}点开看大图，手机长按存图
      </div>
      <Image.PreviewGroup>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 10,
          }}
        >
          {显示.map((a) => (
            <div key={a.id}>
              <Image
                src={shelfFileUrl(a.path)}
                alt={a.path.split(/[\\/]/).pop() ?? ""}
                style={{
                  width: "100%",
                  aspectRatio: "3 / 4",
                  objectFit: "cover",
                  border: "1px solid #ebeef5",
                }}
              />
              <div
                style={{
                  fontSize: 11,
                  color: "#909399",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={a.path}
              >
                {assetAccount(a.type) === null ? `${a.type}·不分号 ` : ""}
                {a.path.split(/[\\/]/).pop()}
              </div>
            </div>
          ))}
        </div>
      </Image.PreviewGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// ③ 题目分组 / ④ 发布台账
// ---------------------------------------------------------------------------

function QuestionGroups({
  groups,
  total,
}: {
  groups: { section: string | null; qtype: string | null; n: number }[];
  total: number;
}) {
  if (total === 0) {
    return (
      <EmptyHint>
        这一册<b>一道题都没入库</b>（punch 的 question 表里没有它的行）。🔴
        这不等于「这本册子没做完」：专项 39
        本全都没拆到题级，在售的册子里也有大半是 0 题 ——
        题级回收是随使用的事，别拿它当上架判据。
      </EmptyHint>
    );
  }
  const columns: ColumnsType<{
    section: string | null;
    qtype: string | null;
    n: number;
  }> = [
    {
      title: "小节 section",
      dataIndex: "section",
      render: (_, r) =>
        r.section ?? <span style={{ color: "#909399" }}>（空）</span>,
    },
    {
      title: "题型",
      dataIndex: "qtype",
      render: (_, r) =>
        r.qtype ?? <span style={{ color: "#909399" }}>（空）</span>,
    },
    {
      title: "题数",
      dataIndex: "n",
      width: 90,
      align: "right",
      render: (_, r) => (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.n}</span>
      ),
    },
  ];
  return (
    <>
      <Alert
        type="warning"
        style={{ marginBottom: 10 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            🔴 这里的题是 <b>punch 库的题</b>，与本库题库（/question）
            <b>零交集</b>：实测两边按同一口径算 hash，3230 题 × 642 题 交集为
            0。所以这一栏<b>不给跳本库题详情的链接</b> —— 那会指到另一本账上去。
          </span>
        }
        description={
          <span style={{ fontSize: 12, color: "#606266" }}>
            另：section 与 题型 两栏在 punch 侧口径混乱（英文四值
            oral/vert/step/app 与中文小节名并存，题型里还混进了小节名）——
            如实照列，归一化要改它的库，本产品只读。
          </span>
        }
      />
      <Table
        rowKey={(r) => `${r.section ?? ""}|${r.qtype ?? ""}`}
        size="small"
        columns={columns}
        dataSource={groups}
        pagination={false}
        // 🔴 手机上让表格自己横向滚（页面本身不许横向滚）
        scroll={{ x: 460 }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
            <Table.Summary.Cell index={1} />
            <Table.Summary.Cell index={2} align="right">
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{total}</b>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
    </>
  );
}

function PublishLedger({ logs }: { logs: ShelfPublishLogView[] }) {
  if (logs.length === 0) {
    return (
      <EmptyHint>
        发布台账<b>一行都没有</b>。🔴 它的意思是「<b>没人往 publish_log 写过</b>
        」，<b>不是</b>「这本册子没发布过」—— 发布动作是用户在手机 App
        上人工发的，没有任何回写通路，所以这张表从建起来到现在一直是 0 行。
      </EmptyHint>
    );
  }
  const columns: ColumnsType<ShelfPublishLogView> = [
    { title: "日期", dataIndex: "date", width: 120 },
    { title: "号", dataIndex: "account", width: 60 },
    {
      title: "结果",
      dataIndex: "result",
      width: 90,
      render: (_, r) => (
        <Tag
          color={
            r.result === "正常"
              ? "green"
              : r.result === "限流"
                ? "orange"
                : "red"
          }
        >
          {r.result ?? "—"}
        </Tag>
      ),
    },
    { title: "备注", dataIndex: "note" },
  ];
  return (
    <Table<ShelfPublishLogView>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={logs}
      pagination={false}
      // 🔴 手机上让表格自己横向滚（页面本身不许横向滚）
      scroll={{ x: 480 }}
    />
  );
}

// ---------------------------------------------------------------------------
// 壳：A/B 开关 + 四个 tab
// ---------------------------------------------------------------------------

export function DocPanels({ detail }: { detail: ShelfDocDetailView }) {
  const 有的号 = [
    ...new Set([
      ...detail.materials.filter((m) => m.isActive).map((m) => m.account),
      ...detail.assets
        .map((a) => assetAccount(a.type))
        .filter((x): x is "A" | "B" => x !== null),
    ]),
  ].sort();
  const [account, setAccount] = useState<"A" | "B">(
    有的号.includes("B") && !有的号.includes("A") ? "B" : "A",
  );

  const papers = detail.assets.filter((a) => assetIsPaper(a.type));
  const images = detail.assets.filter((a) => !assetIsPaper(a.type));
  const 本号物料 = detail.materials.filter(
    (m) => m.account === account && m.isActive,
  );
  const 停用物料 = detail.materials.filter((m) => !m.isActive);
  const 本号成品卷 = papers.filter(
    (p) => assetAccount(p.type) === null || assetAccount(p.type) === account,
  );

  const AB = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Tooltip title="🔴 A/B 是两个小红书号：文案与配图必须同号（双号防判重靠整条线隔离，不是换水印）。这个开关同时管物料与配图两块。">
        <span style={{ fontSize: 12, color: "#606266" }}>号</span>
      </Tooltip>
      <Segmented<"A" | "B">
        size="small"
        value={account}
        onChange={setAccount}
        options={[
          { label: "A 号", value: "A" },
          { label: "B 号", value: "B" },
        ]}
      />
      {有的号.length === 0 ? (
        <span style={{ fontSize: 11.5, color: "#909399" }}>
          这一册两个号都没有物料/配图
        </span>
      ) : 有的号.length === 1 ? (
        <span style={{ fontSize: 11.5, color: "#e6a23c" }}>
          只有 {有的号[0]} 号（另一号缺）
        </span>
      ) : null}
    </span>
  );

  return (
    <Card size="small">
      <Tabs
        size="small"
        tabBarExtraContent={AB}
        items={[
          {
            key: "material",
            label: `物料（${detail.materials.filter((m) => m.isActive).length}）`,
            children:
              本号物料.length > 0 ? (
                <>
                  {本号物料.map((m) => (
                    <MaterialCard key={m.id} m={m} />
                  ))}
                  {停用物料.length > 0 ? (
                    <div
                      style={{
                        marginTop: 10,
                        fontSize: 11.5,
                        color: "#909399",
                      }}
                    >
                      另有 {停用物料.length}{" "}
                      份已停用的物料（is_active=0），本页不展开。
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyHint>
                  {account} 号没有在用物料。🔴 物料正本是册目录里的{" "}
                  <code>_交付/发布物料*.md</code>，库里这份是它的投影 ——
                  改文案要改 md 再重跑产线的 import，本页改不了。
                </EmptyHint>
              ),
          },
          {
            key: "output",
            label: `产物（${detail.assets.length}）`,
            children: (
              <>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    margin: "2px 0 8px",
                  }}
                >
                  成品卷（{本号成品卷.length}）
                </div>
                <PaperList papers={本号成品卷} />
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    margin: "16px 0 8px",
                  }}
                >
                  配图（{images.length}）
                </div>
                <Gallery images={images} account={account} />
                <div
                  style={{ marginTop: 10, fontSize: 11.5, color: "#909399" }}
                >
                  🔴 预览走 <code>/api/shelf/file</code>
                  （只读，四道闸：账上有登记行 / 在货架资产根内 / 图与 PDF
                  白名单 / ≤64MB）——
                  绝对路径在手机上等于没给，这是唯一能在手机上看图翻卷的路。
                  <br />
                  发布只从 <code>_交付/发布包-&lt;A|B&gt;号/</code>{" "}
                  拿（书+图+文案一个目录装齐）， 🔴 别照版名去 A版/B版
                  目录拿：号与版是<b>交叉</b>的。
                </div>
              </>
            ),
          },
          {
            key: "question",
            label: `题目（${detail.doc.counts.questions}）`,
            children: (
              <QuestionGroups
                groups={detail.questionGroups}
                total={detail.doc.counts.questions}
              />
            ),
          },
          {
            key: "publish",
            label: `发布台账（${detail.publishLogs.length}）`,
            children: <PublishLedger logs={detail.publishLogs} />,
          },
        ]}
      />
      {detail.assets.length === 0 && detail.materials.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ fontSize: 12.5 }}>
              这一册在库里只有一行 doc：没有物料、没有产物、没有题。
              多半是登记了还没跑产线的 import。
            </span>
          }
        />
      ) : null}
    </Card>
  );
}

export default DocPanels;
