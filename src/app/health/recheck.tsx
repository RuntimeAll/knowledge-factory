"use client";

/**
 * 备份与对账 · 「现跑一次对账」面板（AI:PRD-008 · P3）
 *
 * 🔴 这个按钮**不写库**：路由带 `metric:false`（见 api/health/integrity 文件头），
 *    所以这一跑不进库、不算数、不留痕，也顶不掉命令行跑出来的正式结论。
 *    按钮上的字就这么写 —— 让人一眼知道点了它等于什么。
 * 🔴 默认不自动跑：对账要连圣域、扫全表、遍历 assets 目录，那是「跑一次」的成本，
 *    不是「每次打开页面」的成本（core/status.ts 文件头的原话）。
 * 🔴 明细一个字不省：C5 的「挂不上桥的批次」逐条列出来才是这一项的价值所在。
 */
import { Alert, Button, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useState } from "react";

import { EmptyHint } from "~/components/console/ui";
import {
  CHECK_TITLE,
  type CheckView,
  type IntegrityRunResponse,
} from "./shared";

function levelTag(c: CheckView): React.ReactNode {
  if (c.ok) return <Tag color="green">PASS</Tag>;
  return c.level === "warn" ? (
    <Tag color="orange">WARN</Tag>
  ) : (
    <Tag color="red">RED</Tag>
  );
}

const columns: ColumnsType<CheckView> = [
  {
    title: "项",
    dataIndex: "id",
    width: 56,
    render: (_, c) => <b>{c.id}</b>,
  },
  {
    title: "说明",
    dataIndex: "name",
    render: (_, c) => (
      <Tooltip title={CHECK_TITLE[c.id] ?? ""}>
        <span style={{ fontSize: 12.5 }}>{c.name}</span>
      </Tooltip>
    ),
  },
  {
    title: "结果",
    dataIndex: "ok",
    width: 84,
    render: (_, c) => levelTag(c),
  },
  {
    title: "明细 / 统计",
    dataIndex: "details",
    render: (_, c) => (
      <div style={{ fontSize: 12, lineHeight: 1.9 }}>
        {c.details.length === 0 ? (
          <span style={{ color: "#909399" }}>（没有明细）</span>
        ) : (
          c.details.map((d, i) => <div key={i}>· {d}</div>)
        )}
        {Object.keys(c.stats).length > 0 ? (
          <div style={{ color: "#909399", marginTop: 2 }}>
            {Object.entries(c.stats)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(" · ")}
          </div>
        ) : null}
      </div>
    ),
  },
];

export function IntegrityRecheck() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IntegrityRunResponse | null>(null);

  function run(): void {
    setBusy(true);
    void (async () => {
      try {
        const r = await fetch("/api/health/integrity");
        setRes((await r.json()) as IntegrityRunResponse);
      } catch (e) {
        setRes({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          report: null,
          ms: 0,
        });
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <>
      <Space size={10} align="center" style={{ marginBottom: 10 }}>
        <Button size="small" loading={busy} onClick={run}>
          现跑一次对账（只读 · 不进库不留痕）
        </Button>
        <span style={{ fontSize: 11.5, color: "#909399" }}>
          metric:false —— 这一跑不写 metric_event、不产生审计行、顶不掉上面那条
          「最近一次」。要留痕的正式对账走下面的命令行。要连圣域扫全表，慢几秒是正常的。
        </span>
      </Space>

      {res?.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="对账没跑成（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{res.error}</span>}
        />
      ) : null}

      {res?.report ? (
        <>
          <Alert
            type={res.report.ok ? "success" : "error"}
            showIcon
            style={{ marginBottom: 10 }}
            message={
              <span style={{ fontSize: 12.5 }}>
                {res.report.ok
                  ? "本次现跑：没有 red（warn 不红拦）"
                  : "本次现跑：有 red —— 数据已经不自洽，先别继续灌东西"}
                <span style={{ color: "#909399" }}>
                  {" "}
                  · {res.report.generatedAt} · {res.ms}ms · 未入库
                </span>
              </span>
            }
          />
          <Table<CheckView>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={res.report.checks}
            pagination={false}
            // 检查单 ⑤：手机上让这张表自己横滚，别把整页拖成左右能划
            scroll={{ x: 640 }}
            locale={{
              emptyText: (
                <EmptyHint>对账返回了空的六项——这本身不正常。</EmptyHint>
              ),
            }}
          />
        </>
      ) : null}
    </>
  );
}

export default IntegrityRecheck;
