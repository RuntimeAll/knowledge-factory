"use client";

/**
 * 报告架 · 列表 + 预览弹层（AI:PRD-008 · 设计稿 §二 批改流水线组第 4 页）
 *
 * 🔴 只读页：没有一个按钮能改盘上的东西。预览与下载都走
 *    `/api/grading/report-file`（同一个只读路由，`dl=1` 换成附件下载）。
 * 🔴 「对应批次 / 出件时间」如实标来源：撞上批次才是真出件时间，撞不上退文件
 *    修改时间并写明 —— 两种时间不混着讲（风险台账 #7 的命名串义就在这一列上现形）。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { Alert, Button, Modal, Tag, Tooltip } from "antd";
import { useRef, useState } from "react";

import { EmptyHint, TimeText } from "~/components/console/ui";
import type { ReportRow, ReportsResponse } from "../shared";

interface QueryForm {
  code?: string;
}

export interface ReportShelfProps {
  codes: string[];
  defaultCode?: string;
}

function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileUrl(r: ReportRow, dl: boolean): string {
  const q = new URLSearchParams({ code: r.code, file: r.file });
  if (dl) q.set("dl", "1");
  return `/api/grading/report-file?${q.toString()}`;
}

export function ReportShelf(props: ReportShelfProps) {
  const actionRef = useRef<ActionType>(null);
  const [err, setErr] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [root, setRoot] = useState<string>("");
  const [preview, setPreview] = useState<ReportRow | null>(null);

  const columns: ProColumns<ReportRow, "text">[] = [
    {
      title: "学员",
      dataIndex: "code",
      width: 120,
      valueType: "select",
      fieldProps: {
        placeholder: "不选=全部",
        allowClear: true,
        showSearch: true,
        options: props.codes.map((c) => ({ value: c, label: c })),
      },
      render: (_, r) => <b>{r.code}</b>,
    },
    {
      title: "报告文件名",
      dataIndex: "file",
      search: false,
      render: (_, r) => (
        <span
          style={{ fontFamily: "Consolas, Menlo, monospace", fontSize: 12.5 }}
        >
          {r.file}
        </span>
      ),
    },
    {
      title: "对应批次",
      dataIndex: "batchId",
      search: false,
      width: 210,
      render: (_, r) => (
        <div style={{ fontSize: 12.5 }}>
          {r.batchId === null ? (
            <Tag>对不上批次</Tag>
          ) : (
            <Tag color="blue">b{r.batchId}</Tag>
          )}
          <div style={{ color: "#909399", marginTop: 2 }}>{r.batchNote}</div>
        </div>
      ),
    },
    {
      title: "出件时间",
      dataIndex: "exportedAt",
      search: false,
      width: 150,
      render: (_, r) => (
        <Tooltip
          title={
            r.timeSource === "批次 exported_at"
              ? "审核.db batches.exported_at —— 真出件那一刻"
              : "文件修改时间（对不上批次时的退路，不是出件时间）"
          }
        >
          <span>
            <TimeText iso={r.exportedAt ?? r.mtime} />
            <div style={{ color: "#909399", fontSize: 11.5 }}>
              {r.timeSource}
            </div>
          </span>
        </Tooltip>
      ),
    },
    {
      title: "大小",
      dataIndex: "bytes",
      search: false,
      width: 84,
      render: (_, r) => bytesText(r.bytes),
    },
    {
      title: "取件",
      valueType: "option",
      key: "option",
      width: 130,
      fixed: "right",
      render: (_, r) => [
        <Button key="pv" size="small" onClick={() => setPreview(r)}>
          预览
        </Button>,
        <a key="dl" href={fileUrl(r, true)} download={r.file}>
          下载
        </a>,
      ],
    },
  ];

  return (
    <>
      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="报告架取数没跑成（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{err}</span>}
        />
      ) : null}
      {warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message="扫描时遇到的事（一条不吞）"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {warnings.map((w, i) => (
                <div key={i}>· {w}</div>
              ))}
            </div>
          }
        />
      ) : null}

      <ProTable<ReportRow, QueryForm>
        actionRef={actionRef}
        rowKey="key"
        size="small"
        cardBordered
        columns={columns}
        scroll={{ x: 1000 }}
        search={{ labelWidth: "auto", defaultCollapsed: false }}
        form={{
          initialValues: props.defaultCode ? { code: props.defaultCode } : {},
        }}
        options={{
          reload: true,
          density: false,
          setting: true,
          fullScreen: false,
        }}
        headerTitle={
          <span style={{ fontSize: 13 }}>
            已出件报告
            <span
              style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
            >
              扫的是 {root || "（还没取数）"}
            </span>
          </span>
        }
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: [10, 20, 50, 100],
          showSizeChanger: true,
          showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
        }}
        locale={{
          emptyText: (
            <EmptyHint>
              没有报告文件 —— 「没有报告」不是「没批过」：未 confirmed
              的批次绝不出件，出件了才会有 PNG 落到 学员/&lt;代号&gt;/报告/ 下。
            </EmptyHint>
          ),
        }}
        request={async (params) => {
          const q = new URLSearchParams();
          if (params.code) q.set("code", params.code);
          const res = await fetch(`/api/grading/reports?${q.toString()}`);
          const j = (await res.json()) as ReportsResponse;
          setErr(j.ok ? undefined : j.error);
          setWarnings(j.warnings);
          setRoot(j.root);
          return { data: j.data, total: j.total, success: true };
        }}
      />

      <Modal
        open={preview !== null}
        onCancel={() => setPreview(null)}
        title={preview ? `${preview.code} · ${preview.file}` : ""}
        width={880}
        footer={
          preview ? (
            <a href={fileUrl(preview, true)} download={preview.file}>
              下载这份
            </a>
          ) : null
        }
      >
        {preview ? (
          <div
            style={{
              maxHeight: "72vh",
              overflow: "auto",
              background: "#f5f7fa",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- 本地文件走 /api/grading/report-file 直返字节，不进 next/image 优化管线 */}
            <img
              src={fileUrl(preview, false)}
              alt={`${preview.code} 的报告 ${preview.file}`}
              style={{ width: "100%", display: "block" }}
            />
          </div>
        ) : null}
      </Modal>
    </>
  );
}

export default ReportShelf;
