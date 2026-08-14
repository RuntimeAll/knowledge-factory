/**
 * KG 治理 · 合并向导 第二步：预览 + 确认（AI:PRD-002 · 002-D；AI:PRD-009 换壳）
 *
 * 🔴 合并不可逆（引用真的搬走、from 变成壳），所以必须先看见「要搬多少行」再按第二次。
 *    左边是 from 的引用面（KpRefCounts 口径，与 core 里 retire/merge 用的是同一份），
 *    右边是 to 的现状。数字对不上心理预期就该退回去 —— 那多半选错了考点。
 *
 * ── AI:PRD-009 打磨（只动版面与交互）────────────────────────────────────────
 *   ① 换 antd + console/ui（检查单 10）；
 *   ② 二次确认统一形态（检查单 7）：**确认页照旧留着**，但最后那一下再弹一层，
 *      弹层里写死这次会搬多少行、搬到谁身上、不可逆 —— 影响面写在按下去之前。
 *   ③ 拦不住的前置条件（from=to / 目标非 active / 读不出来）现在**直接禁掉按钮**
 *      并在悬停里说明为什么，而不是让人点了再吃 core 的报错。
 */
import { Alert, Card, Tag } from "antd";
import Link from "next/link";

import { DataSourceNote, StatusTag } from "~/components/console/ui";
import { KpNotFoundError, kpContext, kpRefCounts } from "~/core";
import { mergeKpAction } from "../../actions";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { KV, MONO, Num } from "~/components/console/table";
import { param } from "../../shared";

export const dynamic = "force-dynamic";

async function 读卡(id: string) {
  try {
    return { card: await kpContext(id), error: null as string | null };
  } catch (e) {
    return {
      card: null,
      error:
        e instanceof KpNotFoundError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
    };
  }
}

export default async function MergePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const from = param(sp, "from");
  const to = param(sp, "to");
  const err = param(sp, "err");

  const [f, t] = await Promise.all([读卡(from), 读卡(to)]);
  const refs = f.card ? await kpRefCounts(from) : null;
  const 目标非现役 = Boolean(t.card && t.card.kp.status !== "active");
  const 可执行 = Boolean(f.card && t.card && from !== to) && !目标非现役;

  const 拦住的原因 = !f.card
    ? "from 读不出来"
    : !t.card
      ? "to 读不出来"
      : from === to
        ? "from 和 to 是同一个考点"
        : 目标非现役
          ? `合并目标状态是 ${t.card?.kp.status}，core 只接受 active 的目标`
          : "";

  return (
    <>
      <PageHead
        title="确认合并"
        sub="确认后 from 的引用全部搬到 to，from 留成 merged 壳（旧 id 仍能追到落点）"
        right={
          <DataSourceNote>
            core.kpContext / core.kpRefCounts（与 core 内部 retire/merge
            同一份口径）
          </DataSourceNote>
        }
      />

      <div style={{ marginBottom: 12, fontSize: 12.5 }}>
        <Link
          href={`/kg/merge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
        >
          ← 改选
        </Link>
      </div>

      {err ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={<span style={{ whiteSpace: "pre-wrap" }}>{err}</span>}
        />
      ) : null}
      {f.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="from 读不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{f.error}</span>}
        />
      ) : null}
      {t.error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="to 读不出来（原文照登）"
          description={<span style={{ fontSize: 12.5 }}>{t.error}</span>}
        />
      ) : null}
      {from === to && from ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message="from 和 to 是同一个考点，合什么"
        />
      ) : null}
      {目标非现役 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 10 }}
          message={`合并目标状态是 ${t.card?.kp.status}，core 会拒`}
          description={
            <span style={{ fontSize: 12.5 }}>
              目标必须 active —— 合到 merged/retired 上 = 造环断链。
            </span>
          }
        />
      ) : null}

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        }}
      >
        <Card
          size="small"
          title="from · 会被合并掉"
          extra={
            f.card ? <StatusTag value={f.card.kp.status} /> : <Tag>没选</Tag>
          }
        >
          {f.card ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                {/* 检查单 4：两侧的考点都点得进详情，合之前该能去核对一眼 */}
                <Link href={`/kg/kp/${from}`}>{f.card.kp.name}</Link>
              </div>
              <div
                style={{
                  ...MONO,
                  color: "#909399",
                  fontSize: 10.5,
                  wordBreak: "break-all",
                  marginBottom: 8,
                }}
              >
                {from}
              </div>
              <div
                style={{
                  color: "#909399",
                  fontSize: 11.5,
                  letterSpacing: 1,
                  marginBottom: 2,
                }}
              >
                身上的引用（这些会整体搬到 to）
              </div>
              {refs
                ? // 🔴 同 retire 页：KpRefCounts 无索引签名，显式钉成 number
                  (Object.entries(refs) as [string, number][])
                    .filter(([k]) => k !== "合计")
                    .map(([table, n]) => (
                      <KV key={table} k={table} v={<Num n={n} />} />
                    ))
                : null}
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                合计 <Num n={refs?.合计 ?? 0} big /> 条
                {refs?.合计 === 0 ? (
                  <span style={{ color: "#909399" }}>
                    {" "}
                    —— 一条引用都没有，合并只是把它标成壳
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div style={{ color: "#909399", fontSize: 12.5 }}>
              没选或读不出来。
            </div>
          )}
        </Card>

        <Card
          size="small"
          title="to · 会留下"
          extra={
            t.card ? <StatusTag value={t.card.kp.status} /> : <Tag>没选</Tag>
          }
        >
          {t.card ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                <Link href={`/kg/kp/${to}`}>{t.card.kp.name}</Link>
              </div>
              <div
                style={{
                  ...MONO,
                  color: "#909399",
                  fontSize: 10.5,
                  wordBreak: "break-all",
                  marginBottom: 8,
                }}
              >
                {to}
              </div>
              <KV
                k="领域 / 主题"
                v={`${t.card.kp.domain ?? "—"} / ${t.card.kp.topic ?? "—"}`}
              />
              <KV k="别名" v={t.card.aliases.join("、") || "—"} />
              <KV
                k="教材挂位"
                v={
                  t.card.placements.length > 0
                    ? t.card.placements
                        .map(
                          (p) =>
                            `${p.edition}${p.gradeSem} ${p.path.at(-1) ?? ""}`,
                        )
                        .join("；")
                    : "—"
                }
              />
              <KV
                k="挂载"
                v={
                  <span style={{ fontSize: 12.5 }}>
                    题 <Num n={t.card.counts.questions} /> · 模型{" "}
                    <Num n={t.card.counts.examModels} /> · 错因{" "}
                    <Num n={t.card.counts.errorCauses} />
                  </span>
                }
              />
            </>
          ) : (
            <div style={{ color: "#909399", fontSize: 12.5 }}>
              没选或读不出来。
            </div>
          )}
        </Card>
      </div>

      <Card size="small" style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.9, marginBottom: 10 }}>
          按下去会发生：question_kp / node_kp_map / kp_error / kp_alias /
          err_code_map / kp_edge / exam_model 逐表重挂到 to；
          <b>主考点显式裁决</b>（to 侧那行被提为 primary，而不是让 from
          那行被静默吞掉）； from 标成 merged 并记下
          merged_into。全程一个事务、一条审计行。
          <br />
          完成后立刻跑一次对账，把 <b>C2 悬挂引用</b> 的结论贴给你看 ——
          绿了才算这次合并干净。
        </div>
        <form
          action={mergeKpAction}
          style={{ display: "flex", alignItems: "center", gap: 14 }}
        >
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <ConfirmSubmit
            label="确认合并（不可逆）"
            title="真的把这两个考点合成一个？"
            danger
            okText="合并"
            disabled={!可执行}
            disabledReason={拦住的原因 || undefined}
            description={
              <>
                把 <b>{f.card?.kp.name ?? from}</b> 身上的{" "}
                <b>{refs?.合计 ?? 0} 条引用</b>整体搬到{" "}
                <b>{t.card?.kp.name ?? to}</b>，然后把前者标成 merged 壳。
                <br />
                🔴 <b>不可逆</b>：引用真的改行，页面上没有「撤销合并」这个动作
                （要还原只能人手逐表搬回去）。
                <br />
                搬完立刻跑一次对账，C2（悬挂引用）的结论会贴在结果页上。
              </>
            }
          />
          <Link href="/kg/merge" style={{ fontSize: 12.5 }}>
            取消
          </Link>
          {!可执行 && 拦住的原因 ? (
            <span style={{ fontSize: 12, color: "#e6a23c" }}>
              点不了：{拦住的原因}
            </span>
          ) : null}
        </form>
      </Card>
    </>
  );
}
