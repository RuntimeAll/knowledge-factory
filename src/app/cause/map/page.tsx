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

import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { IdTail, StatusTag, TimeText } from "~/components/console/ui";
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
    <PageHead
      title={<>补错因映射</>}
      sub={<>登记一条 (考点, 码) → 错因 的翻译 · 🔴 页面写操作，按两次才生效</>}
      source={
        <>core.mapErrCode（写，落审计行）· 表 err_code_map(kp_id, err_code)</>
      }
    />
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
  // 🔴 AI:PRD-009 打磨（检查单 §三·2 错误态）：这三个 await 原来是**裸的** ——
  //    错因台账读不出来（库锁了 / 表没了）整页直接 500，人只看得见 Next 的白页，
  //    连「刚才要补哪一组映射」都没了。捞住、原文照登、并且**不给写按钮**：
  //    候选都没读出来时点确认只会撞一个更难懂的错。
  let kp: Awaited<ReturnType<typeof describeKp>>;
  let 现有: Awaited<ReturnType<typeof findErrCodeMap>>;
  let options: Awaited<ReturnType<typeof causeOptions>>;
  try {
    [kp, 现有, options] = await Promise.all([
      describeKp(kpId),
      findErrCodeMap(kpId, errCode),
      causeOptions(),
    ]);
  } catch (e) {
    return (
      <>
        <Head />
        <Alert
          type="error"
          showIcon
          message="错因台账读不出来（原文照登）—— 这一步不给写按钮"
          description={
            <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              <pre style={{ whiteSpace: "pre-wrap", margin: "0 0 6px" }}>
                {e instanceof Error ? `${e.name}: ${e.message}` : String(e)}
              </pre>
              要补的这一组：考点 <code>{kpId}</code> × 码 <code>{errCode}</code>
              （地址栏里还在，修好库刷新本页即可继续）。
              <br />
              <Link href="/cause">← 回错因管理</Link>
            </div>
          }
        />
      </>
    );
  }

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
              {/* 🔴 检查单 §三·3 时间统一：原来直接印整串 ISO */}由{" "}
              {现有.mappedBy ?? "（没记谁定的）"} 于{" "}
              {现有.mappedAt ? (
                <TimeText iso={现有.mappedAt} />
              ) : (
                "（没记时间）"
              )}{" "}
              定的。
              <br />
              🔴 这里<b>不覆盖</b>，页面上也<b>没有</b>
              改指/摘除的口子（写操作白名单 §六 D2
              只有「补错因映射」这一类，删映射行不在其内）： 要改判走 agent/MCP
              —— core 的 <code>unmapErrCode</code> 先摘、
              <code>mapErrCode</code>{" "}
              再挂，两条审计行，翻账看得见「什么时候改的、从谁改到谁」。
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

        {/* 🔴 检查单 §三·6 空态：一个错因实体都没有时，下面那个下拉是**空的** ——
            人对着一个选不出东西的表单，不知道是坏了还是没数据。说清楚 + 给下一步。 */}
        {options.length === 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 14 }}
            message="错因域一个实体都没有 —— 这条映射现在补不了"
            description={
              <span style={{ fontSize: 12.5 }}>
                映射是「(考点, 码) → <b>错因实体</b>
                」，没有实体就没有可指的对象。
                这是「种子还没灌」的诚实形态，不是故障：建错因实体走 agent /
                MCP（页面不做），灌完回本页刷新即可。
              </span>
            }
          />
        ) : null}

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
            disabled={options.length === 0}
            style={{
              // 🔴 检查单 §三·5：原来是 minWidth 460 —— 在 390px 的手机上顶宽整页
              width: "100%",
              maxWidth: 460,
              padding: "6px 8px",
              fontSize: 13,
              border: "1px solid #d9d9d9",
              borderRadius: 3,
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

          {/* 🔴🔴 2026-08-15 验收修复（检查单 §三·7 二次确认 / §三·10 一致性）：
              这里原来是一个**手搓的原生 `<button type="submit">`** + inline 配色 ——
              白名单六类写操作里唯一一个**没有确认层**的：没有 Popconfirm/Modal，
              也没有 useFormStatus，**连点两下就落两条审计行**
              （components/console/confirm.tsx 文件头点名的那桩真实事故）。
              上面那个 `<input type="checkbox" required>` 不是「列明影响面的二次确认」，
              它只是一道勾选，勾完照样能连点。
              现在收编到全站唯一那份 ConfirmSubmit：弹层列明影响面 + 提交中禁用转圈，
              与另外五类写操作同形。（checkbox 保留：它管的是「你读没读懂这条映射
              会改写历史统计」，与防连点是两件事，requestSubmit 会照常校验它。） */}
          <ConfirmSubmit
            label="确认写入这条映射"
            title="把这条 (考点, 码) → 错因 的映射写进库？"
            description={
              <>
                <div>
                  · 往 <b>err_code_map</b> 插<b>一行</b>：(考点「{kp.name}
                  」, 码 <code>{errCode}</code>) → 你在上面选的那个错因实体。
                </div>
                <div>
                  · 落<b>一条审计行</b>（actor=human · tool=mapErrCode ·
                  mapped_by=human），mapped_at 由 core 现取。
                </div>
                <div>
                  · 🔴 <b>改变历史统计的解释</b>
                  ：以前落进 unmapped 的这些码次，从此算到这个错因头上；
                  错因的名字会出现在学情报告里。
                </div>
                <div>
                  · 🔴 <b>撞键不覆盖</b>：这一组已经映射过的话 core 直接抛
                  MAP_TAKEN，本页会把原文端出来 —— 改判要走 agent/MCP
                  的「先摘后挂」。
                </div>
              </>
            }
            okText="确认写入"
            danger
            disabled={options.length === 0}
            disabledReason="错因域一个实体都没有，没有可指的对象 —— 先灌种子"
            cancelHref="/cause"
          />
        </form>

        <div style={{ marginTop: 14, fontSize: 12, ...灰, lineHeight: 1.9 }}>
          写完会落一条审计行（actor=human · tool=mapErrCode ·
          mapped_by=human），回执带 seq；mapped_at 由 core 现取，页面不编时间。
        </div>
      </Card>
    </>
  );
}
