/**
 * 错因管理 · 补映射（AI:PRD-008 · P2 · 设计稿 §二·13 的「补映射」写操作）
 *
 * 白名单五类之一。两步走，第二步才写：
 *   第一步：挑 (考点, 码)（client 组件 `form.tsx`，只改地址栏，零写）
 *   第二步：本页把「即将写入什么」摆出来 → 勾确认框 → 按红按钮 → server action
 *
 * 🔴 为什么要勾一个框：这条映射**改变历史统计的解释** ——
 *    以前落进 unmapped 的那些码次，从此算到这个错因头上。这不是「加一行数据」，
 *    是「改了过去所有报表的读数」，所以要按第二次。
 * 🔴 撞键不覆盖：core 的 mapErrCode 遇到已有映射直接抛 MAP_TAKEN。本页提前查一遍，
 *    撞了就把人送去「改指 / 摘除」页（先摘后挂 = 两条审计行，翻账看得见改动）。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import { DataSourceNote, IdTail, StatusTag } from "~/components/console/ui";
import { param } from "../../kg/shared";
import { mapErrCodeAction } from "../actions";
import { causeOptions, describeKp, findErrCodeMap } from "../lookup";
import { MapPicker } from "./form";

export const dynamic = "force-dynamic";

const 灰: React.CSSProperties = { color: "#909399" };
const MONO: React.CSSProperties = {
  fontFamily: "Consolas, Menlo, monospace",
};

function Head() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>补错因映射</h1>
      <span style={{ fontSize: 12.5, ...灰 }}>
        登记一条 (考点, 码) → 错因 的翻译 · 🔴 页面写操作，按两次才生效
      </span>
      <span style={{ marginLeft: "auto" }}>
        <DataSourceNote>
          core.mapErrCode（写，落审计行）· 表 err_code_map(kp_id, err_code)
        </DataSourceNote>
      </span>
    </div>
  );
}

export default async function MapErrCodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const kpId = param(sp, "kp");
  const errCode = param(sp, "code");

  // ── 第一步：还没挑 ────────────────────────────────────────────────────
  if (!kpId || !errCode) {
    return (
      <>
        <Head />
        <Card size="small" title="第一步：挑 (考点, 码)">
          <MapPicker kpId={kpId || undefined} errCode={errCode || undefined} />
          <div style={{ marginTop: 12, fontSize: 12.5, ...灰, lineHeight: 2 }}>
            🔴 键是<b>复合的</b>：同一个 <code>dist</code>，挂在「有理数运算的
            简便技巧」下是「运算律简算错误」，挂在「去括号法则」下是「去括号漏
            变号」—— 两回事，各登记各的。
            <br />
            码从哪儿来：<Link href="/cause">错因管理页</Link>底下那张 unmapped
            红旗队列，每一行都带 batch/qno 样本，点「去补映射」就把 (考点, 码)
            带过来了。凭空想一个码填进来没有意义 —— 映射表是给真出现过的码用的。
          </div>
        </Card>
      </>
    );
  }

  // ── 第二步：预览 + 确认 ───────────────────────────────────────────────
  const [kp, 现有, options] = await Promise.all([
    describeKp(kpId),
    findErrCodeMap(kpId, errCode),
    causeOptions(),
  ]);

  return (
    <>
      <Head />

      {kp.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="这个 kp_id 在库里查无此考点（原文照登）"
          description={
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, margin: 0 }}>
              {kp.error}
            </pre>
          }
        />
      ) : null}

      {现有 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <span style={{ fontSize: 12.5 }}>
              这一组已经映射过了：(考点「{kp.name}」, 码 {errCode}) → 错因「
              {现有.causeName}」
            </span>
          }
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              由 {现有.mappedBy ?? "（没记谁定的）"} 于{" "}
              {现有.mappedAt ?? "（没记时间）"} 定的。
              <br />
              🔴 这里<b>不覆盖</b>，页面上也<b>没有</b>改指/摘除的口子（写操作白名单
              §六 D2 只有「补错因映射」这一类，删映射行不在其内）：
              要改判走 agent/MCP —— core 的 <code>unmapErrCode</code> 先摘、
              <code>mapErrCode</code> 再挂，两条审计行，翻账看得见「什么时候改的、从谁改到谁」。
            </div>
          }
        />
      ) : null}

      <Card size="small" title="第二步：确认写入什么">
        <table style={{ borderCollapse: "collapse", marginBottom: 14 }}>
          <tbody>
            <tr>
              <td style={{ ...灰, padding: "4px 12px 4px 0", fontSize: 12.5 }}>
                考点
              </td>
              <td style={{ padding: "4px 0", fontSize: 13 }}>
                <b>{kp.name}</b> <StatusTag value={kp.status} />{" "}
                <IdTail id={kp.kpId} />
              </td>
            </tr>
            <tr>
              <td style={{ ...灰, padding: "4px 12px 4px 0", fontSize: 12.5 }}>
                产线码
              </td>
              <td style={{ padding: "4px 0", fontSize: 13 }}>
                <Tag style={MONO}>{errCode}</Tag>
              </td>
            </tr>
            <tr>
              <td style={{ ...灰, padding: "4px 12px 4px 0", fontSize: 12.5 }}>
                改地址栏
              </td>
              <td style={{ padding: "4px 0", fontSize: 12.5 }}>
                <Link href="/cause/map">重挑一组 (考点, 码)</Link>
              </td>
            </tr>
          </tbody>
        </table>

        <form action={mapErrCodeAction}>
          <input type="hidden" name="kpId" value={kp.kpId} />
          <input type="hidden" name="errCode" value={errCode} />

          <div style={{ fontSize: 12.5, marginBottom: 6 }}>
            翻译成哪个错因：
          </div>
          <select
            name="causeId"
            required
            defaultValue=""
            style={{
              minWidth: 460,
              maxWidth: "100%",
              padding: "5px 8px",
              fontSize: 13,
              border: "1px solid #dcdfe6",
              borderRadius: 2,
            }}
          >
            <option value="" disabled>
              选一个错因实体…
            </option>
            {options.map((o) => (
              <option
                key={o.value}
                value={o.value}
                disabled={o.status === "retired"}
              >
                {o.label}
                {o.status === "retired" ? "（已退役，不接新挂载）" : ""}
                {o.seedCode ? ` · ${o.seedCode}` : ""}
              </option>
            ))}
          </select>

          <label
            style={{
              display: "block",
              margin: "14px 0 10px",
              fontSize: 12.5,
              lineHeight: 1.8,
            }}
          >
            <input type="checkbox" required style={{ marginRight: 6 }} />
            我确认：这条映射<b>改变历史统计的解释</b> —— 以前落进 unmapped
            的这些码次，从现在起会算到这个错因头上；错因的名字将出现在学情
            报告里。
          </label>

          <button
            type="submit"
            style={{
              border: "1px solid #c45656",
              color: "#c45656",
              background: "#fef0f0",
              borderRadius: 2,
              padding: "5px 14px",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            确认补映射
          </button>
          <Link
            href="/cause"
            style={{ marginInlineStart: 14, fontSize: 12.5, ...灰 }}
          >
            取消，回错因管理
          </Link>
        </form>

        <div style={{ marginTop: 14, fontSize: 12, ...灰, lineHeight: 1.9 }}>
          写完会落一条审计行（actor=human · tool=mapErrCode ·
          mapped_by=human），回执带 seq；mapped_at 由 core 现取，页面不编时间。
        </div>
      </Card>
    </>
  );
}
