/**
 * KG 治理 · 考点详情（AI:PRD-002 · 002-D；AI:PRD-009 打磨批换壳）
 *
 * kp_context 卡片包的可视化：口径（card_md）/ 别名词表 / **双版本挂位** / 挂载计数 /
 * 合并来源。别名可就地增删，退役走确认页。
 *
 * 🔴 这页就是验收 2-1 的页面证据：同一个考点（概念层一个）在人教树与浙教树上
 *    各有一条挂位路径，并排列出来。看得见「概念层版本无关」不是口号。
 * 🔴 编造的 id 不给白板：kpContext 抛的 KpNotFoundError 自带最近似候选，
 *    这里原样列出来（验收 2-2 在页面侧的样子）。
 *
 * 🆕 AI:PRD-006 · 006-B：加「群错误率」小节 —— 批改线的产出经挂桥链落到这个考点上。
 * 🔴 这一节是验收 6-1 的页面证据。三条纪律写在小节里，别改：
 *    ① 数字必须**带覆盖口径**（matched/total + 未挂桥明细）——群错误率是纯新增能力，
 *       批改线没有对应实现、没有对数基准，唯一能自证的就是「样本面说得清楚」；
 *    ② 错因**三形态分列**（归因 / '[]' 拒绝归因 / NULL 未记录），绝不并成「没归因」；
 *    ③ **unmapped 红字**：查不到 (考点,码) 映射的错不许静默丢 —— 丢了等于说它没发生过。
 *
 * ── AI:PRD-009 打磨（只动版面与交互，一条业务语义都没改）───────────────────
 *   ① 一致性（检查单 10）：换 antd + console/ui，与全站同一套 tag 色/间距/标题层级；
 *   ② 二次确认（检查单 7）：加别名 / 删别名原来是**裸 submit**，现在统一弹层，
 *      影响面（动哪张表、对 resolve_kp 有什么后果）写在弹层里；
 *   ③ 跳转贯通（检查单 4）：「挂载」那行的题数现在能点进
 *      `/question?kp=<id>` 看到这些题本身 —— 页面上出现的实体，看到即可达；
 *   ④ 移动端（检查单 5）：两张表进横向滚动容器，卡片栅格改自适应列宽。
 */
import { Alert, Card, Input, Space, Tag } from "antd";
import Link from "next/link";

import { EmptyHint, IdTail, StatusTag } from "~/components/console/ui";
import {
  KpNotFoundError,
  causeDistribution,
  kpContext,
  kpGroupErrorRate,
  type CauseDistributionResult,
  type KpContextCard,
  type KpGroupErrorRateResult,
} from "~/core";
import { addAliasAction, removeAliasAction } from "../../actions";
import { ConfirmSubmit } from "~/components/console/confirm";
import { PageHead } from "~/components/console/page-head";
import { KV, MONO, Num, TableBox, Td, Th } from "~/components/console/table";
import { param } from "../../shared";

export const dynamic = "force-dynamic";

const 灰: React.CSSProperties = { color: "#909399" };

/** 卡片栅格：手机一列、宽屏两列（不写死 lg，按容器宽度自适应） */
const 双栏: React.CSSProperties = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
};

/** 查无此考点：把错误里的候选摆出来，让人一步走对（而不是回去重查） */
function NotFound({ id, e }: { id: string; e: KpNotFoundError }) {
  return (
    <>
      <PageHead title="查无此考点" sub={<span style={MONO}>{id}</span>} />
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message="这个考点 id 在库里查不到（原文照登）"
        description={
          <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
            {e.message}
          </span>
        }
      />
      {e.candidates.length > 0 ? (
        <Card size="small" title="最近似的候选">
          <TableBox>
            <thead>
              <tr>
                <Th>考点</Th>
                <Th width={70}>把握</Th>
                <Th>怎么命中的</Th>
              </tr>
            </thead>
            <tbody>
              {e.candidates.map((c) => (
                <tr key={c.kpId}>
                  <Td>
                    <Link href={`/kg/kp/${c.kpId}`}>{c.name}</Link>
                  </Td>
                  <Td num>{c.confidence}</Td>
                  <Td>
                    <span style={{ ...灰, fontSize: 11.5 }}>
                      {c.matchedVia}
                      {c.aliasHit ? ` · 命中别名「${c.aliasHit}」` : ""}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        </Card>
      ) : (
        <Card size="small">
          <EmptyHint>
            一条近似候选都没有。🔴 这不是「库里没有相关考点」，是 **这串 id
            连字面都不像任何一个考点** —— 多半是手敲错了或用了别处的 id。 回{" "}
            <Link href="/kg">知识图谱总览</Link> 从树里点进来最稳。
          </EmptyHint>
        </Card>
      )}
      <div style={{ marginTop: 14, fontSize: 12.5 }}>
        <Link href="/kg">← 回知识图谱总览</Link>
      </div>
    </>
  );
}

/** 双版本挂位表（验收 2-1 的正主） */
function Placements({ card }: { card: KpContextCard }) {
  if (card.placements.length === 0) {
    return (
      <EmptyHint>
        一棵版本树都没挂上 ——
        概念层有它，教材里找不到它，出题时按章节召回不到。🔴
        「没挂位」不是「这个考点不重要」：多半是这一节的树还没铺到。
      </EmptyHint>
    );
  }
  return (
    <TableBox>
      <thead>
        <tr>
          <Th width={130}>教材</Th>
          <Th>章 / 节</Th>
          <Th width={110}>树</Th>
        </tr>
      </thead>
      <tbody>
        {card.placements.map((p) => (
          <tr key={`${p.treeId}|${p.nodeId}`}>
            <Td nowrap>
              <b>{p.edition}</b>
              <span style={灰}> · </span>
              {p.gradeSem}
            </Td>
            <Td>
              {p.path.length > 0 ? p.path.join(" / ") : "（路径读不出来）"}
            </Td>
            <Td nowrap>
              <Link href={`/kg/tree/${p.treeId}`}>{p.subject}</Link>
              {p.treeStatus === "active" ? null : (
                <span style={灰}>（{p.treeStatus ?? "NULL"}）</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableBox>
  );
}

/**
 * 群错误率（验收 6-1 的页面证据）。
 * 🔴 三样东西缺一不可：数、覆盖口径、错因三形态。少任何一样这个数就会被读错。
 */
function GroupStats({
  kpId,
  rate,
  dist,
}: {
  kpId: string;
  rate: KpGroupErrorRateResult;
  dist: CauseDistributionResult;
}) {
  const row = rate.rows.find((r) => r.kpId === kpId) ?? null;
  const cov = rate.coverage;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* ── 覆盖口径：先说样本面，再说数（顺序不能反） ───────────────── */}
      <div style={{ fontSize: 12.5 }}>
        <b>覆盖口径</b>：挂上桥的批次 <Num n={cov.matched} /> /{" "}
        <Num n={cov.total} />（{cov.rate}）
        {row ? (
          <>
            ，本考点参与统计 <Num n={row.total} /> 题次 ·{" "}
            <Num n={row.students} /> 名学员 · <Num n={row.batches} /> 个批次
          </>
        ) : null}
      </div>

      {row === null ? (
        <Alert
          type="warning"
          showIcon
          message={
            <span style={{ fontSize: 12.5 }}>
              覆盖 0 —— 该考点的题没进过任何<b>已挂桥</b>
              的批次，所以群错误率算不出来。这是「没有数据」，不是「没有错误」。
              {cov.unmatched.length > 0
                ? `（圣域侧有 ${cov.unmatched.length} 个批次没挂上桥，明细见下方）`
                : null}
            </span>
          }
        />
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: "4px 24px",
          }}
        >
          <span style={{ fontSize: 12.5 }}>
            错题次 / 总题次 <Num n={row.wrong} big /> /{" "}
            <Num n={row.total} big />
          </span>
          <span style={{ fontSize: 12.5 }}>
            群错误率{" "}
            <b style={{ fontSize: 15, fontVariantNumeric: "tabular-nums" }}>
              {row.rate === null ? "—" : `${(row.rate * 100).toFixed(1)}%`}
            </b>
          </span>
          <span style={{ ...灰, fontSize: 12 }}>
            口径：× 含空题（口径①）／ √ 含订正对了（口径②）／ skip 漏抄整条摘掉
          </span>
        </div>
      )}

      {/* ── 错因分布：三形态分列 ───────────────────────────────────────── */}
      <div>
        <div style={{ ...灰, fontSize: 11, letterSpacing: 1, marginBottom: 4 }}>
          错因分布
        </div>
        {dist.rows.length > 0 ? (
          <TableBox>
            <thead>
              <tr>
                <Th>错因</Th>
                <Th width={110}>产线码</Th>
                <Th width={70}>码次</Th>
                <Th width={70}>学员</Th>
              </tr>
            </thead>
            <tbody>
              {dist.rows.map((r) => (
                <tr key={`${r.causeId}|${r.errCode}`}>
                  <Td>{r.causeName}</Td>
                  <Td>
                    <span style={{ ...MONO, fontSize: 11.5 }}>{r.errCode}</span>
                  </Td>
                  <Td num>{r.count}</Td>
                  <Td num>{r.students}</Td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        ) : (
          <EmptyHint>
            没有已翻译的归因 —— 要么这个考点的错题都没带码，要么 err_code_map
            还没铺映射（种子灌入是 006-C 的活）。
          </EmptyHint>
        )}

        {/* 🔴 三形态：'[]' 与 NULL 语义不同，分两行摆，绝不并成「没归因」 */}
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 20px",
            fontSize: 12,
          }}
        >
          <span>
            未归因（判 × 且 <code style={MONO}>{"[]"}</code>，明确说
            「错的不属于本题所挂考点」）：
            <Num n={dist.unattributed.count} />
          </span>
          <span>
            未记录（判 × 且 <code style={MONO}>NULL</code>
            ，老批次/未走归因链）：
            <Num n={dist.unrecorded.count} />
          </span>
          {dist.copyReminder.count > 0 ? (
            <span>
              抄写提醒（口径③，不算错因）：
              <Num n={dist.copyReminder.count} />
            </span>
          ) : null}
        </div>
      </div>

      {/* ── 🔴 unmapped 红字：查不到映射的码不静默丢 ───────────────────── */}
      {dist.unmapped.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={
            <span style={{ fontSize: 12.5 }}>
              🔴 {dist.unmapped.length} 组 (考点, 码) 查不到 err_code_map
              映射，共 {dist.unmapped.reduce((s, x) => s + x.count, 0)} 个码次
            </span>
          }
          description={
            <div style={{ fontSize: 12 }}>
              这些错<b>没有被丢掉</b>，全在下面 ——
              静默丢等于说它们没发生过。处置：给这些 (考点, 码)
              铺映射，或确认这个码在这个考点下确实没有语义。
              <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
                {dist.unmapped.map((u) => (
                  <li
                    key={`${u.kpId}|${u.errCode}`}
                    style={{ lineHeight: 1.9 }}
                  >
                    <code style={MONO}>{u.errCode}</code>
                    <span style={灰}> @ </span>
                    {u.kpName}
                    <span style={{ marginInlineStart: 8 }}>
                      ×<Num n={u.count} />
                    </span>
                    <span
                      style={{ ...灰, marginInlineStart: 8, fontSize: 11.5 }}
                    >
                      {u.sample
                        .map((s) => `batch ${s.batchId} 第 ${s.qno} 题`)
                        .join("、")}
                    </span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 6 }}>
                <Link href="/cause">去错因管理铺映射 →</Link>
              </div>
            </div>
          }
        />
      ) : null}

      {/* ── 未挂桥明细：不神隐 ─────────────────────────────────────────── */}
      {cov.unmatched.length > 0 ? (
        <details style={{ fontSize: 12 }}>
          <summary style={{ ...灰, cursor: "pointer" }}>
            未挂桥的 {cov.unmatched.length} 个批次（学情算不到考点上，但看得见）
          </summary>
          <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>
            {cov.unmatched.map((u) => (
              <li key={u.batchId} style={{ lineHeight: 1.9 }}>
                <span style={MONO}>batch {u.batchId}</span>
                <span style={灰}>
                  {" "}
                  {u.student ?? "?"} 第 {u.day ?? "?"} 次
                  {u.auto ? `（${u.auto}）` : ""} —— {u.why}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default async function KpPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const sp = await searchParams;
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  let card: KpContextCard;
  try {
    card = await kpContext(id);
  } catch (e) {
    if (e instanceof KpNotFoundError) return <NotFound id={id} e={e} />;
    throw e;
  }

  const k = card.kp;
  const 版本数 = new Set(card.placements.map((p) => p.edition)).size;

  // 🔴 群错误率读的是圣域（只读）：连不上就如实说一句，**不让整页 500**。
  //    KG 治理页的主职责是考点本身，学情是加挂的一节 —— 加挂的东西不该拖垮主页面。
  let 群: {
    rate: KpGroupErrorRateResult;
    dist: CauseDistributionResult;
  } | null = null;
  let 群失败 = "";
  try {
    const [rate, dist] = await Promise.all([
      kpGroupErrorRate({ kpIds: [k.id] }),
      causeDistribution({ kpId: k.id }),
    ]);
    群 = { rate, dist };
  } catch (e) {
    群失败 = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  return (
    <>
      <PageHead
        title={k.name}
        tags={<StatusTag value={k.status} />}
        sub={
          card.resolvedThrough ? (
            <span style={{ color: "#c45656" }}>
              你给的 {card.resolvedThrough.originalId} 是合并壳，已追{" "}
              {card.resolvedThrough.hops} 跳到这里
            </span>
          ) : (
            "概念层的一个考点 —— 它在各教材版本上的挂位都在下面"
          )
        }
        source={
          <>
            core.kpContext（= MCP resolve_kg 的卡片包）/ core.kpGroupErrorRate /
            core.causeDistribution · 表 kp / kp_alias /
            node_kp_map（群错误率读圣域 审核.db，mode=ro）
          </>
        }
      />

      <Space size={10} wrap style={{ marginBottom: 12, fontSize: 12.5 }}>
        <IdTail id={k.id} />
        <Link href="/kg">← 回总览</Link>
        <Link href={`/question?kp=${encodeURIComponent(k.id)}`}>
          看挂在它下面的题 →
        </Link>
      </Space>

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

      <div style={双栏}>
        <Card size="small" title="是什么">
          <KV k="名称" v={k.name} />
          <KV k="状态" v={<StatusTag value={k.status} />} />
          <KV k="学段" v={k.gradeBand ?? "—"} />
          <KV k="领域 domain" v={k.domain ?? "—"} />
          <KV k="主题 topic" v={k.topic ?? "—"} />
          <KV
            k="挂载"
            v={
              <span style={{ fontSize: 12.5 }}>
                {/* 🔴 检查单 4「看到即可达」：题数点得进筛好的题目列表 */}
                <Link href={`/question?kp=${encodeURIComponent(k.id)}`}>
                  题 <Num n={card.counts.questions} />
                </Link>
                <span style={灰}> · </span>
                解题模型 <Num n={card.counts.examModels} />
                <span style={灰}> · </span>
                错因 <Num n={card.counts.errorCauses} />
              </span>
            }
          />
        </Card>

        <Card
          size="small"
          title={`教材挂位（${card.placements.length} 处 · ${版本数} 个教材版本）`}
          extra={
            版本数 > 1 ? (
              <Tag color="green">同一考点 · 多版本各挂各的</Tag>
            ) : null
          }
        >
          <Placements card={card} />
        </Card>
      </div>

      {/* ── 群错误率（AI:PRD-006 · 006-B / 验收 6-1）───────────────────── */}
      <Card
        size="small"
        title="群错误率（批改线回流 · 只读）"
        style={{ marginTop: 12 }}
        extra={
          群 ? (
            <Tag color={群.rate.coverage.matched > 0 ? "green" : "orange"}>
              覆盖 {群.rate.coverage.matched}/{群.rate.coverage.total}
            </Tag>
          ) : null
        }
      >
        {群 ? (
          <GroupStats kpId={k.id} rate={群.rate} dist={群.dist} />
        ) : (
          <Alert
            type="error"
            showIcon
            message="圣域（审核.db）只读连接开不了，群错误率这一节算不出来 —— 页面其余部分不受影响"
            description={
              <span style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>
                {群失败}
              </span>
            }
          />
        )}
      </Card>

      {/* ── 别名词表：resolve_kp 的料 ─────────────────────────────────── */}
      <Card
        size="small"
        title={`别名词表（${card.aliases.length} 条）`}
        style={{ marginTop: 12 }}
      >
        <div style={{ ...灰, fontSize: 12, marginBottom: 8 }}>
          别名是
          agent「问得出来」的入口：它按哪句话查得到这个考点，取决于这张表。
        </div>
        {card.aliases.length > 0 ? (
          <Space size={[8, 8]} wrap style={{ marginBottom: 10 }}>
            {card.aliases.map((a) => (
              <span
                key={a}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  border: "1px solid #ebeef5",
                  background: "#f4f4f5",
                  borderRadius: 2,
                  padding: "1px 4px 1px 8px",
                  fontSize: 12.5,
                }}
              >
                {a}
                <form action={removeAliasAction} style={{ display: "inline" }}>
                  <input type="hidden" name="kpId" value={k.id} />
                  <input type="hidden" name="alias" value={a} />
                  <ConfirmSubmit
                    label="×"
                    title={`删掉别名「${a}」？`}
                    description={
                      <>
                        从 <b>kp_alias</b> 删这一行（考点本身、挂位、题目
                        <b>一个都不动</b>）。
                        <br />
                        {/* 🔴 JSX 不认 Markdown：这条长在**会改库的二次确认弹层**
                            正文里，原来是 `**照这句话问就问不到**`，星号直接印给
                            正准备点确认的人看。 */}
                        后果：agent 之后<b>照这句话问就问不到</b>这个考点了
                        （resolve_kp 少一条命中路径），低置信工单会因此变多。
                        <br />
                        可逆：想回来在下面重新加一条同名别名即可。
                      </>
                    }
                    okText="确认删除"
                    danger
                  />
                </form>
              </span>
            ))}
          </Space>
        ) : (
          <div style={{ ...灰, fontSize: 12.5, marginBottom: 10 }}>
            一条别名都没有 —— 只有名字全等/前缀/子串能查到它。
          </div>
        )}
        <form
          action={addAliasAction}
          style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
        >
          <input type="hidden" name="kpId" value={k.id} />
          <Input
            name="alias"
            required
            maxLength={80}
            size="small"
            style={{ width: 280 }}
            placeholder="补一个说法，如「实数计算」"
          />
          <ConfirmSubmit
            label="加进词表"
            title="把这个说法补进别名词表？"
            description={
              <>
                往 <b>kp_alias</b> 加一行（幂等：本来就有就不重复加）。
                <br />
                后果：agent 之后<b>照这句话问就能命中这个考点</b> ——
                这正是补别名的意义。
                <br />
                🔴
                别把不相干的说法硬塞进来：词表脏了，之后每一次检索都在还这笔债。
              </>
            }
            okText="确认加入"
            primary
          />
        </form>
      </Card>

      {/* ── 考点卡片正文 ───────────────────────────────────────────────── */}
      <Card
        size="small"
        title="考点卡（口径 / 易错 / 教学建议）"
        style={{ marginTop: 12 }}
      >
        {k.cardMd ? (
          // 朴素为先：原样等宽展示，不引 markdown 渲染器（这页的读者是人，不是排版）
          <pre
            style={{
              background: "#f4f4f5",
              padding: 12,
              margin: 0,
              maxHeight: 420,
              overflow: "auto",
              fontSize: 12,
              lineHeight: 1.8,
              whiteSpace: "pre-wrap",
            }}
          >
            {k.cardMd}
          </pre>
        ) : (
          <EmptyHint>
            还没写卡片。🔴 「没有卡片」不是「这个考点没口径」——
            是口径只在人脑子里：出题时全靠出题人临场发挥，两个人出会出成两样。
          </EmptyHint>
        )}
      </Card>

      {card.mergedFrom && card.mergedFrom.length > 0 ? (
        <Card
          size="small"
          title={`合并来源（${card.mergedFrom.length} 个旧考点指向它）`}
          style={{ marginTop: 12 }}
        >
          <Space size={[10, 6]} wrap style={{ fontSize: 12.5 }}>
            {card.mergedFrom.map((m) => (
              <span key={m.id}>
                {m.name}
                <span
                  style={{
                    ...灰,
                    ...MONO,
                    fontSize: 10.5,
                    marginInlineStart: 4,
                  }}
                >
                  {m.id}
                </span>
              </span>
            ))}
          </Space>
        </Card>
      ) : null}

      <div
        style={{
          marginTop: 18,
          paddingTop: 12,
          borderTop: "1px solid #ebeef5",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: 16,
          fontSize: 12.5,
        }}
      >
        <Link href={`/kg/merge?from=${k.id}`}>把它合并到别的考点 →</Link>
        <Link href={`/kg/kp/${k.id}/retire`} style={{ color: "#c45656" }}>
          退役这个考点 →
        </Link>
        <span style={灰}>
          重复考点走合并（引用整体搬家），别走退役（引用会成悬挂）。
        </span>
      </div>
    </>
  );
}
