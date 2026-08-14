/**
 * 队列 · 隔离行改判（AI:PRD-003 · 003-D；AI:PRD-009 打磨批换壳）
 *
 * 隔离区 = 红灯题的收容所（管道拒了它，但**原样 payload 留着**）。这页给两条出路：
 *
 *   改判重投 —— 把 payload 在文本框里改对（多半是考点名写错、答案抄错、缺来源），
 *               重走一遍同一条管道。🔴 还红就零写返回，把新红灯贴在这页上：
 *               隔离区不会因为你重试了五次就多出五行。
 *   废弃    —— 这题不要了。只标 resolved_at，并把理由记进 why 的【处置】行。
 *
 * 🔴 两个都是「结案」动作，所以都在这页两步提交（002-D 的破坏性动作定式）。
 * 🔴 文本框里给的是**原样 JSON**，不做任何表单化：坏料千奇百怪，能改的形状只有 JSON 本身。
 *
 * ── AI:PRD-009 打磨（只动版面与交互）────────────────────────────────────────
 *   换 antd + console/ui（检查单 10）；两个动作各自统一 ConfirmSubmit 弹层、
 *   影响面分别写清（检查单 7）；「来自批」现在能点进
 *   `/ingest?batch=<id>` 看那一批的闸报告（检查单 4 看到即可达）。
 */
import { Alert, Card, Input } from "antd";
import Link from "next/link";

import {
  DataSourceNote,
  IdTail,
  StatusTag,
  TimeText,
} from "~/components/console/ui";
import { getQuarantineRow } from "~/core";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { KV } from "~/components/console/table";
import { param } from "../../../kg/shared";
import {
  discardQuarantineAction,
  reingestQuarantineAction,
} from "../../actions";

export const dynamic = "force-dynamic";

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default async function QuarantinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const sp = await searchParams;
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  let row = null;
  let error: string | null = null;
  try {
    row = await getQuarantineRow(id);
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (!row) {
    return (
      <>
        <PageHead title="隔离行" sub="这条隔离料打不开" />
        <Alert
          type="error"
          showIcon
          message={error ? "隔离行读不出来（原文照登）" : "这条隔离行不在库里"}
          description={
            <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
              {error ?? `quarantine 里没有 id = ${id} 这一行。`}
            </div>
          }
        />
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          <Link href="/queue?tab=quarantine">← 回处置台 · 隔离区</Link>
        </div>
      </>
    );
  }

  const 已结 = Boolean(row.resolvedAt);

  return (
    <>
      <PageHead
        title="改判这条隔离料"
        tags={<StatusTag value={已结 ? "resolved" : "open"} />}
        sub="管道拒了它，但原样 payload 留着 —— 改对了重投，或者废弃"
        right={
          <DataSourceNote>
            core.getQuarantineRow · 表 quarantine；写走 core 的
            reingestQuarantine / resolveQuarantine（含审计行）
          </DataSourceNote>
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
        <Link href="/queue?tab=quarantine">← 回处置台 · 隔离区</Link>
        <IdTail id={row.id} />
      </div>

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

      <Card size="small" title="管道为什么拒了它">
        <div
          style={{
            color: "#c45656",
            fontSize: 12.5,
            lineHeight: 1.9,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {row.why}
        </div>
        <div style={{ marginTop: 10 }}>
          <KV k="进隔离时间" v={<TimeText iso={row.createdAt} />} />
          <KV
            k="来自批"
            v={
              row.batchId ? (
                // 🔴 检查单 4：批次 id 看得见就该点得进去（那一批的闸报告在录入批次页）
                <Link href={`/ingest?batch=${encodeURIComponent(row.batchId)}`}>
                  看这一批的闸报告 → <IdTail id={row.batchId} />
                </Link>
              ) : (
                "—"
              )
            }
          />
          {已结 ? (
            <KV k="结案时间" v={<TimeText iso={row.resolvedAt} />} />
          ) : null}
        </div>
      </Card>

      {已结 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message={`这条已经在 ${row.resolvedAt} 结过了 —— 不重复处置`}
          description={
            <span style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              处置痕迹见上面 why 的【处置】行。
              <br />
              还想录这道题就直接走录题管线（MCP 的 kb_ingest /
              propose_question）。
            </span>
          }
        />
      ) : (
        <>
          <Card
            size="small"
            title="① 改判重投（改完再走一遍全套闸）"
            style={{ marginTop: 12 }}
          >
            <form action={reingestQuarantineAction}>
              <input type="hidden" name="id" value={row.id} />
              <label
                htmlFor="payload"
                style={{
                  display: "block",
                  marginBottom: 4,
                  fontSize: 11.5,
                  letterSpacing: 1,
                  color: "#909399",
                }}
              >
                单题 payload（原样 JSON；不动它 = 拿原样重投）
              </label>
              <Input.TextArea
                id="payload"
                name="payload"
                rows={16}
                defaultValue={pretty(row.payloadJson)}
                spellCheck={false}
                style={{
                  fontFamily: "Consolas, Menlo, monospace",
                  fontSize: 11.5,
                  lineHeight: 1.7,
                }}
              />
              <label
                htmlFor="note"
                style={{
                  display: "block",
                  margin: "10px 0 4px",
                  fontSize: 11.5,
                  letterSpacing: 1,
                  color: "#909399",
                }}
              >
                改了什么（记进 quarantine.why 的处置行）
              </label>
              <Input
                id="note"
                name="note"
                placeholder="例：考点名写错了，改成「有理数的混合运算」"
              />
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <ConfirmSubmit
                  label="重投这一题"
                  primary
                  okText="重投"
                  title="把改过的 payload 重走一遍管道？"
                  description={
                    <>
                      拿文本框里的 JSON 重跑<b>全套十道闸</b>： 过了就落
                      question + 本隔离行标结案；
                      <br />
                      🔴 还红就<b>零写返回</b> —— 这条隔离行原地不动、
                      <b>不会多长一行</b>，新的红灯原文贴回页顶。
                    </>
                  }
                />
                <span style={{ fontSize: 11.5, color: "#909399" }}>
                  🔴 还红就零写返回（这条隔离行原地不动），红灯原文贴在页顶
                </span>
              </div>
            </form>
          </Card>

          <Card
            size="small"
            title="② 废弃（这题不要了）"
            style={{ marginTop: 12 }}
          >
            <form action={discardQuarantineAction}>
              <input type="hidden" name="id" value={row.id} />
              <label
                htmlFor="dnote"
                style={{
                  display: "block",
                  marginBottom: 4,
                  fontSize: 11.5,
                  letterSpacing: 1,
                  color: "#909399",
                }}
              >
                废弃理由（必填 ——
                日后翻账时，「为什么不要它」比「不要它」有用得多）
              </label>
              <Input.TextArea
                id="dnote"
                name="note"
                rows={2}
                required
                placeholder="例：题源本身抄错了，卷子已作废，不必再录。"
              />
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <ConfirmSubmit
                  label="确认废弃"
                  danger
                  okText="废弃"
                  title="把这条隔离料废弃？"
                  description={
                    <>
                      只标 <b>quarantine.resolved_at</b> 并把理由写进 why 的
                      【处置】行 —— <b>payload 不删</b>，日后翻得到。
                      <br />
                      这道题<b>不会</b>落进题库。
                      <br />
                      🔴 结案后本页转只读，同一条不再重复处置。
                    </>
                  }
                />
                <Link href="/queue?tab=quarantine" style={{ fontSize: 12.5 }}>
                  取消，回隔离区
                </Link>
              </div>
            </form>
          </Card>
        </>
      )}
    </>
  );
}
