"use client";

/**
 * 收卷录入 · 表单 + 最近录入表（AI:PRD-008 · 设计稿 §二 批改流水线组第 1 页）
 *
 * 🔴 页面上唯一的写：提交 → POST `/api/grading/intake`。
 *    白名单写操作**必须二次确认**（设计稿 §六 D2）：确认 Modal 里把「写到哪个目录、
 *    追加进哪个文件」原文摆出来再点头 —— 收件箱是别人（PRD-027）的地盘，
 *    我们只有「新增」这一种权限，点之前要看得见自己在动什么。
 *    🔴 形态统一（AI:PRD-009 打磨 · 检查单 §三·7）：原来这里是 Popconfirm 小气泡，
 *    与终审台三个写动作的 Modal 不是一套；全站写操作一律 Modal + 列明影响面。
 * 🔴 回执原文照登：写成了报绝对路径 + 那一行 JSON；写砸了报原始错误，
 *    绝不缩成一句「提交失败」。
 * 🔴 提交前不做任何"聪明"处理：不压缩、不改名（只补两位序号锁拍摄顺序）、不去重 ——
 *    照片是判定的证据，动过就不是证据了。
 */
import {
  ProTable,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { InboxOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Upload,
  type UploadFile,
} from "antd";
import Link from "next/link";
import { useRef, useState } from "react";

import { DataSourceNote, EmptyHint, TimeText } from "~/components/console/ui";
import {
  MAX_PHOTOS,
  PAPER_KINDS,
  PAPER_KIND_LABEL,
  PHOTO_EXTS,
  type IntakeRecentResponse,
  type IntakeRecentRow,
  type IntakeSubmitResponse,
  type PaperKind,
} from "../shared";

export interface IntakeFormProps {
  roster: {
    code: string;
    grade: string | null;
    editionCtx: string | null;
    status: string | null;
  }[];
  /** 🔴 圣域里交过卷、但名册没登记的代号（他们照样能收卷，见 page.tsx 文件头） */
  strays: string[];
  rosterError?: string;
  inboxDir: string;
  queuePath: string;
  rootVia: string;
}

export function IntakeForm(props: IntakeFormProps) {
  const [code, setCode] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<PaperKind>("auto");
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * 🔴 AI:PRD-009 打磨（检查单 §三·7 二次确认统一形态）：这里原来是 Popconfirm
   *    （一个小气泡），而终审台的三个写动作是 Modal（列明影响面）。同一个台子上
   *    两种「按第二次」的形态，人会把气泡当成提示随手点掉。统一成 Modal。
   */
  const [确认中, set确认中] = useState(false);
  const [res, setRes] = useState<IntakeSubmitResponse | null>(null);
  const [recentErr, setRecentErr] = useState<string | undefined>(undefined);
  const actionRef = useRef<ActionType>(null);

  const 超量 = files.length > MAX_PHOTOS;
  const 能提交 = !!code && files.length > 0 && !超量 && !busy;

  async function submit(): Promise<void> {
    if (!code || files.length === 0) return;
    setBusy(true);
    setRes(null);
    try {
      const fd = new FormData();
      fd.set("code", code);
      fd.set("paperKind", kind);
      for (const f of files) {
        const raw = (f.originFileObj ?? null) as File | null;
        if (raw) fd.append("files", raw, f.name);
      }
      const r = await fetch("/api/grading/intake", {
        method: "POST",
        body: fd,
      });
      const j = (await r.json()) as IntakeSubmitResponse;
      setRes(j);
      if (j.ok) {
        setFiles([]);
        void actionRef.current?.reload();
      }
    } catch (e) {
      setRes({
        ok: false,
        error: `请求没发出去（或没回来）：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      });
    } finally {
      setBusy(false);
      // 🔴 成败都关弹窗：回执（成功的绝对路径 / 失败的原文）在弹窗**背后**那条
      //    Alert 上，弹窗不关人就看不见自己刚写成了什么、或为什么没写成。
      set确认中(false);
    }
  }

  const columns: ProColumns<IntakeRecentRow>[] = [
    {
      title: "时间",
      dataIndex: "ts",
      width: 108,
      render: (_, r) => <TimeText iso={r.ts} />,
    },
    {
      title: "学员",
      dataIndex: "code",
      width: 120,
      // 🔴 检查单 §三·4 看到即可达：代号原来是死字，点不进学情页
      render: (_, r) =>
        r.code ? (
          <Link href={`/student/${encodeURIComponent(r.code)}`}>
            <b>{r.code}</b>
          </Link>
        ) : (
          <span style={{ color: "#909399" }}>—</span>
        ),
    },
    {
      title: "张数",
      key: "count",
      dataIndex: "files",
      width: 70,
      render: (_, r) => (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {r.files.length}
        </span>
      ),
    },
    {
      title: "卷型",
      dataIndex: "paperKind",
      width: 90,
      render: (_, r) =>
        r.paperKind ? (
          <Tag>{r.paperKind}</Tag>
        ) : (
          <Tooltip title="没写卷型 = 交给认卷模块自动识别（契约四键里本来就没有这一项）">
            <span style={{ color: "#909399" }}>自动识别</span>
          </Tooltip>
        ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (_, r) =>
        r.badLine ? (
          <Tag color="red">坏行</Tag>
        ) : (
          <Tooltip title="🔴 收件事件流只记「收件中」这一态：照片一进 收卷.py，后面的状态一律以 审核.db 为准（唯一事实源纪律），去批改看板看">
            <Tag color="blue">{r.status ?? "（没写 status）"}</Tag>
          </Tooltip>
        ),
    },
    {
      title: "落盘路径（相对收件箱）",
      key: "paths",
      dataIndex: "files",
      render: (_, r) =>
        r.badLine ? (
          <div style={{ color: "#c45656", fontSize: 12 }}>
            这一行解析不了（原文照登）：
            <div style={{ fontFamily: "Consolas, Menlo, monospace" }}>
              {r.badLine}
            </div>
            {r.parseError ? <div>{r.parseError}</div> : null}
          </div>
        ) : (
          <div
            style={{
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 11.5,
              lineHeight: 1.7,
            }}
          >
            {r.files.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        ),
    },
    {
      title: "入口",
      valueType: "option",
      width: 100,
      fixed: "right",
      render: (_, r) => [
        <Link
          key="board"
          href={
            r.code
              ? `/grading/board?code=${encodeURIComponent(r.code)}`
              : "/grading/board"
          }
        >
          去看板
        </Link>,
      ],
    },
  ];

  return (
    <>
      {props.rosterError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="名册读不出来（原文照登）"
          description={
            <span style={{ fontSize: 12.5 }}>{props.rosterError}</span>
          }
        />
      ) : null}
      {props.rootVia === "兜底常量" ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="收件箱路径是兜底常量推出来的"
          description={
            <span style={{ fontSize: 12.5 }}>
              环境里既没有 AI_BKB_ROOT，也没能从 GRADING_DB_URL 倒推出 ai-bkb 根
              —— 现在按 {props.inboxDir} 写。写之前请确认这就是你要的收件箱。
            </span>
          }
        />
      ) : null}

      {res ? (
        <Alert
          type={res.ok ? "success" : "error"}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            res.ok
              ? `收下了：${res.saved?.length ?? 0} 张照片已写进收件箱`
              : "没收成（原文照登）"
          }
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              {res.error ? (
                <div style={{ whiteSpace: "pre-wrap", color: "#c45656" }}>
                  {res.error}
                </div>
              ) : null}
              {res.dir ? (
                <div>
                  目录：
                  <code style={{ fontSize: 11.5 }}>{res.dir}</code>
                </div>
              ) : null}
              {res.saved && res.saved.length > 0 ? (
                <div>文件：{res.saved.join("、")}</div>
              ) : null}
              {res.line ? (
                <div>
                  队列追加：
                  <code style={{ fontSize: 11.5 }}>{res.line}</code>
                </div>
              ) : null}
              {(res.notes ?? []).map((n, i) => (
                <div key={i} style={{ color: "#e6a23c" }}>
                  ⚠ {n}
                </div>
              ))}
              {res.ok ? (
                <div>
                  下一步不用你管：watcher 判稳后自动认卷开批，存疑才推送你。
                  <Link href="/grading/board"> 去批改看板 →</Link>
                </div>
              ) : null}
            </div>
          }
        />
      ) : null}

      <Card
        size="small"
        title="录入"
        extra={
          <span style={{ fontSize: 11.5, color: "#909399" }}>
            提交 = 写盘（白名单写操作·二次确认）；本页不动审核.db 一个字
          </span>
        }
      >
        <Space size={16} wrap style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13 }}>
            学员{" "}
            <Select
              style={{ minWidth: 240 }}
              placeholder="选代号（名册 ∪ 圣域交过卷的）"
              value={code}
              onChange={setCode}
              showSearch
              optionFilterProp="label"
              // 🔴 两组分开摆：没登记名册的人照样能收卷（学情事实全在圣域），
              //    但得让人看见"这个人名册里没有"，而不是静默混在一起。
              options={[
                {
                  label: "名册（roster）",
                  options: props.roster.map((r) => ({
                    value: r.code,
                    label: `${r.code}${r.grade ? ` · ${r.grade}` : ""}${
                      r.editionCtx ? ` · ${r.editionCtx}` : ""
                    }${
                      r.status && r.status !== "active" ? ` · ${r.status}` : ""
                    }`,
                  })),
                },
                ...(props.strays.length > 0
                  ? [
                      {
                        label: "圣域交过卷 · 名册没登记",
                        options: props.strays.map((c) => ({
                          value: c,
                          label: `${c} · 未登记名册`,
                        })),
                      },
                    ]
                  : []),
              ]}
              notFoundContent="名册与圣域都没有这个代号 —— 真是新学员就先 upsertRoster 登记（只落代号）"
            />
          </span>
          <span style={{ fontSize: 13 }}>
            卷型{" "}
            <Tooltip title="判型只切锚定闸（手抄必开 stem_seen），不改判定口径。默认交给认卷模块自己认，认不出才问你（PRD-027 设计稿 §二）">
              <Select<PaperKind>
                style={{ minWidth: 170 }}
                value={kind}
                onChange={setKind}
                options={PAPER_KINDS.map((k) => ({
                  value: k,
                  label: PAPER_KIND_LABEL[k],
                }))}
              />
            </Tooltip>
          </span>
        </Space>

        <Upload.Dragger
          multiple
          accept={PHOTO_EXTS.join(",")}
          fileList={files}
          beforeUpload={() => false}
          onChange={(info) => setFiles(info.fileList)}
          onRemove={(f) => {
            setFiles((list) => list.filter((x) => x.uid !== f.uid));
            return true;
          }}
          listType="text"
        >
          <p style={{ fontSize: 28, margin: 0, color: "#409eff" }}>
            <InboxOutlined />
          </p>
          <p style={{ fontSize: 13.5, margin: "6px 0 2px" }}>
            点击或拖拽照片到这里（可多张，按拍摄顺序）
          </p>
          <p style={{ fontSize: 12, color: "#909399", margin: 0 }}>
            {PHOTO_EXTS.join(" / ")}；一次最多 {MAX_PHOTOS} 张。
            拍完最后一张再提交最稳 —— 提交即触发判稳窗。
          </p>
        </Upload.Dragger>

        {超量 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 10 }}
            message={`选了 ${files.length} 张，超过一次 ${MAX_PHOTOS} 张的上限 —— 先删掉几张再提交（不替你截断：截了你不知道少传了哪几页）`}
          />
        ) : null}

        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Button
            type="primary"
            disabled={!能提交}
            loading={busy}
            onClick={() => set确认中(true)}
          >
            提交录入…
          </Button>
          <span style={{ fontSize: 12, color: "#909399" }}>
            提交后：判稳 → 认卷 → 自动开批 → 存疑才推送你，其余不打扰。
          </span>
        </div>
      </Card>

      {/* ── 二次确认（全站统一 Modal 形态：先摆影响面，再点头）───────────────── */}
      <Modal
        open={确认中}
        title="确认把这些照片写进收件箱？"
        okText="确认写入"
        cancelText="再想想"
        confirmLoading={busy}
        okButtonProps={{ disabled: !能提交 }}
        onCancel={() => set确认中(false)}
        onOk={() => void submit()}
        width={620}
        style={{ maxWidth: "calc(100vw - 24px)" }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <p style={{ marginBottom: 8 }}>
            <b>影响面</b>：学员 <b>{code ?? "（还没选）"}</b> · 卷型{" "}
            {PAPER_KIND_LABEL[kind]} · <b>{files.length}</b> 张照片。
          </p>
          <p style={{ marginBottom: 8 }}>
            <b>会发生什么</b>：照片按拍摄顺序（补两位序号）写进
            <br />
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {props.inboxDir}/{code ?? "<代号>"}/&lt;时间戳&gt;/
            </code>
            <br />
            并向{" "}
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>
              {props.queuePath}
            </code>{" "}
            追加一行{" "}
            <code style={{ fontSize: 11.5 }}>{'{…,"status":"收件中"}'}</code>。
          </p>
          <p style={{ marginBottom: 8 }}>
            🔴 <b>收件箱只准新增</b>
            ：写进去的照片本页删不了、改不了（要撤只能人工去目录里处理）。
            照片是判定的证据 —— 不压缩、不改名、不去重，原样落盘。
          </p>
          <p style={{ marginBottom: 0, color: "#606266" }}>
            <b>接下来不用你管</b>：watcher 判稳 → 认卷 → 自动开批 →
            存疑才推给你。 本页只交料，一个字都不写 审核.db。
          </p>
        </div>
      </Modal>

      <div style={{ marginTop: 14 }}>
        {/* 🔴 2026-08-14 修：GET 的 ok=false 以前被整段吞掉，页面照样渲染空态
            「还没有收件记录……这不是故障」——读不出来被谎报成没数据。
            与 /grading/board、/grading/reports 两页同一个做法：错误上墙、原文照登。 */}
        {recentErr ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="最近录入读不出来（原文照登）——下面那张表是空的，不代表没收过件"
            description={
              <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                {recentErr}
              </span>
            }
          />
        ) : null}
        <ProTable<IntakeRecentRow>
          actionRef={actionRef}
          rowKey="lineNo"
          size="small"
          cardBordered
          search={false}
          // 🔴 检查单 §三·10 一致性：工具栏四件套与看板/终审台/报告架同一套
          options={{
            reload: true,
            density: true,
            setting: true,
            fullScreen: false,
          }}
          columns={columns}
          scroll={{ x: 900 }}
          pagination={false}
          headerTitle={
            <span style={{ fontSize: 13 }}>
              最近录入
              <span
                style={{ color: "#909399", marginInlineStart: 8, fontSize: 12 }}
              >
                _队列.jsonl 尾 20 行（append-only 事件流，不是批次状态）
              </span>
            </span>
          }
          toolBarRender={() => [
            <DataSourceNote key="src">{props.queuePath}</DataSourceNote>,
          ]}
          locale={{
            emptyText: recentErr ? (
              // 🔴 检查单 §三·9 文案：原来是 Markdown 的 `**读不出来**`，星号被原样印出来
              <EmptyHint>
                🔴 这张表空着是因为<b>读不出来</b>（原文见上面那条红条），
                不是「还没有收件记录」。
              </EmptyHint>
            ) : (
              <EmptyHint>
                还没有收件记录 ——
                收件箱队列文件不存在或还没有行。第一次提交时自动建，这不是故障。
              </EmptyHint>
            ),
          }}
          request={async () => {
            try {
              const r = await fetch("/api/grading/intake");
              const j = (await r.json()) as IntakeRecentResponse;
              setRecentErr(j.ok ? undefined : j.error);
              return { data: j.data, total: j.total, success: true };
            } catch (e) {
              // 请求本身没发出去/没回来：同样上墙，不静默变空表
              setRecentErr(
                `请求没发出去（或没回来）：${
                  e instanceof Error ? `${e.name}: ${e.message}` : String(e)
                }`,
              );
              return { data: [], total: 0, success: true };
            }
          }}
        />
      </div>
    </>
  );
}

export default IntakeForm;
