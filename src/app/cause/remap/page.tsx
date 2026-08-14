/**
 * 错因管理 · 改指 / 摘除（AI:PRD-008 · P2 · 设计稿 §二·13 的映射维护）
 *
 * 破坏性动作走确认页 —— 这是 002-D 起就定下的规矩，改版换的是版式，不是规矩。
 *
 * 🔴 改指 = **先摘后挂两条审计行**（core 的 mapErrCode 撞键故意不覆盖）：
 *    悄悄改一条映射 = 把过去所有报表的口径也改了，而没有任何地方会提到这件事。
 *    两条审计行才翻得出「什么时候改的、从谁改到谁」。
 * 🔴 摘除 ≠ 删掉这些错：码会当场回到 unmapped 红旗队列，带着 batch/qno 样本
 *    继续指路。红旗本身就是「这里还没想清楚」的记账。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import { DataSourceNote, IdTail, StatusTag } from "~/components/console/ui";
import { param } from "../../kg/shared";
import { remapErrCodeAction, unmapErrCodeAction } from "../actions";
import { causeOptions, describeKp, findErrCodeMap } from "../lookup";

export const dynamic = "force-dynamic";

const 灰: React.CSSProperties = { color: "#909399" };
const MONO: React.CSSProperties = { fontFamily: "Consolas, Menlo, monospace" };
const 红按钮: React.CSSProperties = {
  border: "1px solid #c45656",
  color: "#c45656",
  background: "#fef0f0",
  borderRadius: 2,
  padding: "5px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
const 勾: React.CSSProperties = {
  display: "block",
  margin: "12px 0 10px",
  fontSize: 12.5,
  lineHeight: 1.8,
};

export default async function RemapErrCodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const kpId = param(sp, "kp");
  const errCode = param(sp, "code");

  const 头 = (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
        改指 / 摘除映射
      </h1>
      <span style={{ fontSize: 12.5, ...灰 }}>
        (考点, 码) → 错因 的改判 · 🔴 页面写操作，按两次才生效
      </span>
      <span style={{ marginLeft: "auto" }}>
        <DataSourceNote>
          core.unmapErrCode / mapErrCode（写，各落一条审计行）· 表
          err_code_map(kp_id, err_code)
        </DataSourceNote>
      </span>
    </div>
  );

  if (!kpId || !errCode) {
    return (
      <>
        {头}
        <Alert
          type="warning"
          showIcon
          message="地址上没带 (考点, 码)"
          description={
            <span style={{ fontSize: 12.5 }}>
              这一页要从<Link href="/cause">错因管理</Link>
              的映射表里点「改指 / 摘除…」进来 —— 那样才带得上复合键。
            </span>
          }
        />
      </>
    );
  }

  const [kp, 现有, options] = await Promise.all([
    describeKp(kpId),
    findErrCodeMap(kpId, errCode),
    causeOptions(),
  ]);

  if (!现有) {
    return (
      <>
        {头}
        <Alert
          type="warning"
          showIcon
          message={`(考点 ${kp.name}, 码 ${errCode}) 本来就没有映射 —— 没什么可摘的`}
          description={
            <span style={{ fontSize: 12.5 }}>
              要给它铺一条，走{" "}
              <Link
                href={`/cause/map?kp=${encodeURIComponent(kpId)}&code=${encodeURIComponent(errCode)}`}
              >
                补映射
              </Link>
              。{kp.error ? `（另：${kp.error}）` : ""}
            </span>
          }
        />
      </>
    );
  }

  const 其他错因 = options.filter((o) => o.value !== 现有.causeId);

  return (
    <>
      {头}

      <Card size="small" title="现在这条映射" style={{ marginBottom: 12 }}>
        <table style={{ borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ ...灰, padding: "4px 12px 4px 0", fontSize: 12.5 }}>
                考点
              </td>
              <td style={{ padding: "4px 0", fontSize: 13 }}>
                <b>{kp.name}</b> <StatusTag value={kp.status} />{" "}
                <IdTail id={kpId} />
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
                现指向
              </td>
              <td style={{ padding: "4px 0", fontSize: 13 }}>
                <b>{现有.causeName}</b> <StatusTag value={现有.causeStatus} />
                {现有.desc ? (
                  <div style={{ ...灰, fontSize: 12.5 }}>{现有.desc}</div>
                ) : null}
              </td>
            </tr>
            <tr>
              <td style={{ ...灰, padding: "4px 12px 4px 0", fontSize: 12.5 }}>
                据
              </td>
              <td style={{ padding: "4px 0", fontSize: 12.5 }}>
                {现有.mappedBy ?? "没记谁定的"} · {现有.mappedAt ?? "没记时间"}
                <div style={{ ...灰, ...MONO, fontSize: 11.5 }}>
                  {现有.seedCode ?? "错因没写 seed_code"}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* ── 改指 ─────────────────────────────────────────────────────── */}
      <Card
        size="small"
        title="改指到另一个错因（= 先摘后挂，两条审计行）"
        style={{ marginBottom: 12 }}
      >
        {其他错因.length === 0 ? (
          <div style={{ fontSize: 12.5, ...灰 }}>
            库里只有这一个错因实体，没有可改指的对象。
          </div>
        ) : (
          <form action={remapErrCodeAction}>
            <input type="hidden" name="kpId" value={kpId} />
            <input type="hidden" name="errCode" value={errCode} />
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
                改指到…
              </option>
              {其他错因.map((o) => (
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

            <label style={勾}>
              <input type="checkbox" required style={{ marginRight: 6 }} />
              我确认：这会<b>改变历史统计的解释</b>
              ——「{现有.causeName}」名下过去的码次，从现在起算到新错因头上。
              两条审计行会记下这一次改动。
            </label>

            <button type="submit" style={红按钮}>
              确认改指
            </button>
          </form>
        )}
        <div style={{ marginTop: 12, fontSize: 12, ...灰, lineHeight: 1.9 }}>
          🔴 半路失败会如实说：万一「摘」成了而「挂」没成，这条 (考点, 码)
          会处在<b>没有映射</b>的状态（回到 unmapped 红旗），
          回执里会写清楚，请立刻去补映射页重挂。
        </div>
      </Card>

      {/* ── 摘除 ─────────────────────────────────────────────────────── */}
      <Card size="small" title="摘除这条映射（不再翻译）">
        <form action={unmapErrCodeAction}>
          <input type="hidden" name="kpId" value={kpId} />
          <input type="hidden" name="errCode" value={errCode} />
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            摘除后：这个码在这个考点下<b>不再翻译成任何错因</b>， 它会当场回到
            unmapped 红旗队列（带 batch/qno 样本）。
            <br />
            🔴 摘除<b>不删任何一条错的记录</b> ——
            圣域里的判定与码一个字都不动，变的只是「我们怎么解释它」。
            <br />
            per_kp 也会跟着变：带这个码的错题从此在这个考点上「谁都不扣」
            （宁可退化得看得见，也不猜一个考点扣下去）。
          </div>
          <label style={勾}>
            <input type="checkbox" required style={{ marginRight: 6 }} />
            我确认摘除 (考点「{kp.name}」, 码 {errCode}) → 「{现有.causeName}
            」这条映射。
          </label>
          <button type="submit" style={红按钮}>
            确认摘除
          </button>
          <Link
            href="/cause"
            style={{ marginInlineStart: 14, fontSize: 12.5, ...灰 }}
          >
            取消，回错因管理
          </Link>
        </form>
      </Card>
    </>
  );
}
