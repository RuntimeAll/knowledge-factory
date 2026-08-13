/**
 * 题目详情（AI:PRD-004 · 004-C）—— getQuestion 全量卡片的可视化
 *
 * 检索页给的是**摘要**（题面截断、无答案解析），这页是那道题的正本：
 * 三段原文 / 考点（链到考点卡）/ 自由标签 / 配图（含审核态）/ **族谱**（AI:PRD-005 · 005-D）/
 * provenance 四型细节 / 录题批次 / 判档与实算徽章。
 *
 * ── 族谱这一节回答的是「这题跟别的题什么关系」 ─────────────────────────────
 *   母题 →（归纳）→ 考察模型（dsl_ref 指着真生成器）→（生成）→ 变式 A/B/C…
 *   变式侧看：我由哪个模型生成、那个模型的母题是谁、我的兄弟有哪些；
 *   母题侧看：由我归纳出了哪个模型、它派生了哪些变式。
 *   🔴 模型已经在出题、却说不出母题时，这一节直接写红字（不藏着）——
 *      和 REG-E3 的那条断言是同一条口径，只是一个给人看、一个给机器跑。
 *
 * ── 🔴 三段原文一律等宽原样，不渲染公式 ─────────────────────────────────────
 *   题面是 LaTeX 混排，这页的读者是**要核对的人**：他要看的是"库里到底存了什么字"，
 *   不是排得好不好看。渲染一层公式反而会把 `\\frac` 写错、少个 `$` 这类真问题藏起来。
 *
 * ── 🔴 编造的 id 走真 404（notFound()），不是一张 200 的"查无此题"页 ────────
 *   题 id 是纯 ULID，core 给不出"最近似候选"（给了也是瞎猜，见 retrieval.ts）。
 *   既然没有可挽救的信息，就老老实实回 404 + 一句指路（not-found.tsx），
 *   而不是拿 200 装作"页面存在、只是空的"。
 *
 * 🔴 配图走 /api/asset/<hash>：页面不碰文件系统，路径一律由库里的登记行说了算。
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { Chip, PageHead, Panel, Row } from "~/components/kit";
import {
  RetrievalError,
  getLineage,
  getQuestion,
  type LineageQuestion,
  type LineageView,
  type QuestionCard,
  type QuestionProvenance,
} from "~/core";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/** 正本一段（原样等宽；空段落如实说"库里就是空的"，别拿空白糊弄） */
function 正本段({
  title,
  text,
  空话,
}: {
  title: string;
  text: string | null;
  空话: string;
}) {
  return (
    <Panel title={title}>
      {text ? (
        <pre className="bg-code max-h-[520px] overflow-auto rounded-[2px] p-3 text-[12.5px] leading-[1.9] whitespace-pre-wrap">
          {text}
        </pre>
      ) : (
        <div className="text-amber text-[12.5px]">{空话}</div>
      )}
    </Panel>
  );
}

/** 图审态 → 色（passed 绿 / pending 黄 / rejected 红） */
function 图态色(s: string | null): "g" | "a" | "r" | "n" {
  return s === "passed"
    ? "g"
    : s === "pending"
      ? "a"
      : s === "rejected"
        ? "r"
        : "n";
}

const PROV_名: Record<string, string> = {
  scan: "扫描件抽出来的（有源文档与页码）",
  pipeline: "产线脚本生成的（有 pipeline_ref）",
  model: "由考察模型生成的",
  manual: "人手录的",
};

/** provenance 四型：只摆该型该有的那几格，缺的就是缺（不填占位符） */
function 出处({ p }: { p: QuestionProvenance }) {
  return (
    <>
      <Row
        k="类型"
        v={
          <span className="text-[12.5px]">
            <Chip tone="n">{p.type}</Chip>
            <span className="text-mut">{PROV_名[p.type] ?? "（未知型）"}</span>
          </span>
        }
      />

      {p.sourceDoc ? (
        <>
          <Row
            k="源文档"
            v={
              <span className="text-[12.5px]">
                {p.sourceDoc.title}
                <span className="text-mut ml-2">
                  {p.sourceDoc.kind ?? "类型未填"}
                  {p.sourceDoc.pages === null
                    ? ""
                    : ` · 共 ${p.sourceDoc.pages} 页`}
                </span>
              </span>
            }
          />
          <Row
            k="第几页"
            v={
              p.pageNo === undefined ? (
                <span className="text-amber text-[12.5px]">
                  没记页码 —— scan 型没有页码，回头核对时只能全本翻
                </span>
              ) : (
                <span className="num">{p.pageNo}</span>
              )
            }
          />
          {p.sourceDoc.path ? (
            <Row
              k="源文件"
              v={
                <span className="font-mono text-[11.5px]">
                  {p.sourceDoc.path}
                </span>
              }
            />
          ) : null}
        </>
      ) : null}

      {p.model ? (
        <Row
          k="考察模型"
          v={
            <span className="text-[12.5px]">
              {p.model.name}
              <Link
                href={`/kg/kp/${p.model.kpId}`}
                className="text-acc-deep ml-2 underline"
              >
                所属考点 →
              </Link>
              <span className="text-mut ml-2">{p.model.status}</span>
            </span>
          }
        />
      ) : null}

      {p.pipelineRef ? (
        <Row
          k="产线标识"
          v={<span className="font-mono text-[11.5px]">{p.pipelineRef}</span>}
        />
      ) : null}

      {p.createdBy ? <Row k="录入人" v={p.createdBy} /> : null}

      {p.batch ? (
        <Row
          k="录题批次"
          v={
            <span className="text-[12.5px]">
              <span className="font-mono text-[11.5px]">{p.batch.id}</span>
              <span className="text-mut ml-2">
                {p.batch.source} · {p.batch.contractVer} ·{" "}
                {p.batch.status ?? "状态未填"}
                {p.batch.committedAt ? ` · 提交于 ${p.batch.committedAt}` : ""}
              </span>
              <div className="text-mut mt-0.5 text-[11.5px]">
                🔴 逐题逐闸全账在库里，取法：
                <span className="font-mono">
                  get_ingest_batch({"{"}batch_id:&quot;{p.batch.id}&quot;{"}"})
                </span>
              </div>
            </span>
          }
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// 族谱（AI:PRD-005 · 005-D）
// ---------------------------------------------------------------------------

/** 族谱里的一条题链接（摘要 + 状态徽章；点进去就是那道题的正本） */
function 族谱题({ q, 我 }: { q: LineageQuestion; 我?: boolean }) {
  if (q.status === "missing") {
    // 🔴 origin 指了个查无此行的 id —— 明说，不静默略过
    return (
      <li className="text-pen text-[12.5px] leading-[1.9]">
        <span className="font-mono text-[11.5px]">{q.questionId}</span>{" "}
        {q.stemBrief}
      </li>
    );
  }
  return (
    <li className="text-[12.5px] leading-[1.9]">
      {我 ? (
        <Chip tone="g">本题</Chip>
      ) : (
        <Link
          href={`/q/${q.questionId}`}
          className="text-acc-deep mr-1.5 underline"
        >
          看 →
        </Link>
      )}
      <span>{q.stemBrief}</span>
      {q.qtype ? <span className="text-mut ml-1.5">{q.qtype}</span> : null}
      {q.status === "active" ? null : (
        <span className="text-mut ml-1.5">[{q.status}]</span>
      )}
    </li>
  );
}

/** 模型抬头：名字 + 态 + 归位考点 + dsl_ref（🔴 一路能指回真生成器文件） */
function 模型抬头({
  m,
}: {
  m: {
    modelId: string;
    name: string;
    status: string;
    dslRef: string | null;
    kpId: string;
    kpName: string | null;
  };
}) {
  return (
    <div className="text-[12.5px]">
      <b>{m.name}</b>
      <Chip tone={m.status === "active" ? "g" : "a"}>{m.status}</Chip>
      <Link
        href={`/kg/kp/${m.kpId}`}
        className="text-acc-deep ml-1.5 underline"
      >
        {m.kpName ?? m.kpId} →
      </Link>
      <div className="text-mut mt-0.5 font-mono text-[11px] break-all">
        {m.dslRef ?? "🔴 没有 dsl_ref —— 说不出「哪个脚本真会出这类题」"}
      </div>
    </div>
  );
}

/**
 * 变式族谱：母题 → 模型 → 变式，两个方向都摆出来。
 *
 * 🔴 一道题两边都可能占（拿变式再归纳出新模型），所以不是二选一 —— 有哪半就显哪半。
 * 🔴 「模型有生成题却没有母题」不藏着：那一格直接写红字。REG-E3 盯的就是它。
 */
function 族谱({ lin, meId }: { lin: LineageView; meId: string }) {
  if (!lin.bornOf && lin.originOf.length === 0) return null;
  return (
    <div className="mt-3.5">
      <Panel title="族谱（母题 → 考察模型 → 变式）">
        {lin.bornOf ? (
          <div className="mb-3">
            <div className="text-mut mb-1 text-[11.5px]">
              本题是<b>变式</b>：由下面这个考察模型生成
            </div>
            <模型抬头 m={lin.bornOf} />

            <div className="mt-2 text-[12.5px]">
              <span className="text-mut">
                ↑ 该模型的母题（从哪几道真题归纳出来）：
              </span>
              {lin.bornOf.origins.length === 0 ? (
                <div className="text-pen mt-0.5 text-[12.5px]">
                  🔴 一道都没记 ——
                  族谱在这儿断了：这个模型已经在出题，却说不出自己
                  照着什么归纳的。补法：core 的 setModelOrigins(modelId, [母题
                  qid])。
                </div>
              ) : (
                <ul className="mt-0.5 ml-4 list-disc">
                  {lin.bornOf.origins.map((q) => (
                    <族谱题 key={q.questionId} q={q} />
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-2 text-[12.5px]">
              <span className="text-mut">
                → 同模型的兄弟变式（共 {lin.bornOf.siblingTotal} 道
                {lin.bornOf.siblingTotal > lin.bornOf.siblings.length
                  ? `，列前 ${lin.bornOf.siblings.length} 道`
                  : ""}
                ）：
              </span>
              {lin.bornOf.siblings.length === 0 ? (
                <span className="text-mut ml-1">
                  就它一道（这个模型目前只生成过本题）
                </span>
              ) : (
                <ul className="mt-0.5 ml-4 list-disc">
                  {lin.bornOf.siblings.map((q) => (
                    <族谱题 key={q.questionId} q={q} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {lin.originOf.map((m) => (
          <div key={m.modelId} className="mt-3 first:mt-0">
            <div className="text-mut mb-1 text-[11.5px]">
              本题是<b>母题</b>：由它归纳出了下面这个考察模型
            </div>
            <模型抬头 m={m} />
            <div className="mt-2 text-[12.5px]">
              <span className="text-mut">
                ↓ 该模型派生的变式（共 {m.derivedTotal} 道
                {m.derivedTotal > m.derived.length
                  ? `，列前 ${m.derived.length} 道`
                  : ""}
                ）：
              </span>
              {m.derived.length === 0 ? (
                <span className="text-mut ml-1">还没生成过题</span>
              ) : (
                <ul className="mt-0.5 ml-4 list-disc">
                  {m.derived.map((q) => (
                    <族谱题
                      key={q.questionId}
                      q={q}
                      我={q.questionId === meId}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页
// ---------------------------------------------------------------------------

export default async function QuestionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);

  let card: QuestionCard;
  try {
    card = await getQuestion(id);
  } catch (e) {
    // 🔴 只有「库里没这道题」才是 404；库读不动是环境故障，必须原样炸出来
    if (e instanceof RetrievalError && e.code === "QUESTION_NOT_FOUND") {
      notFound();
    }
    throw e;
  }

  // 🔴 族谱只读、与主查询无关：它挂了不该把整页拖垮（页面主角是题的正本）
  const lin: LineageView = await getLineage(id).catch(() => ({
    questionId: id,
    bornOf: null,
    originOf: [],
  }));

  const 实算过 = card.solutionGrade === "calc_verified";

  return (
    <>
      <PageHead
        title="题目正本"
        sub={<span className="font-mono">{card.id}</span>}
        right={
          <div className="flex items-baseline gap-2.5 text-[12.5px]">
            <Link
              className="text-acc-deep underline"
              href={`/search?similar=${card.id}`}
            >
              找相似 →
            </Link>
            <Link className="text-mut underline" href="/search">
              ← 回检索
            </Link>
          </div>
        }
      />

      {/* ── 徽章条：一眼看清这道题「能不能直接拿去用」 ──────────────────── */}
      <div className="mb-3.5 flex flex-wrap items-baseline gap-1.5">
        <Chip tone={card.status === "active" ? "g" : "a"}>{card.status}</Chip>
        <Chip tone={实算过 ? "g" : "n"}>
          {card.solutionGrade}
          {实算过 ? " · 机器实算过" : ""}
        </Chip>
        <Chip tone="n">{card.qtype ?? "题型未填"}</Chip>
        {card.difficulty === null ? (
          <span title="全库 difficulty 当下都是 NULL，打档是后续的活">
            <Chip tone="a">难度未打档</Chip>
          </span>
        ) : (
          <Chip tone="n">难度 {card.difficulty}</Chip>
        )}
        {card.reviewRequired ? (
          <span title="题干图入库即必审：图审通过前它不算数">
            <Chip tone="r">必审 review_required</Chip>
          </span>
        ) : null}
        <Chip tone={card.hasVector ? "g" : "a"}>
          {card.hasVector ? "有句向量" : "没有句向量（语意轴找不到它）"}
        </Chip>
        {card.editionScope ? (
          <Chip tone="n">{card.editionScope}</Chip>
        ) : (
          <span title="edition_scope 为 NULL = 版本通用（M1 Q12）">
            <Chip tone="n">教材版本通用</Chip>
          </span>
        )}
      </div>

      {/* ── 正本三段 ───────────────────────────────────────────────────── */}
      <div className="space-y-3.5">
        <正本段
          title="题面 stem"
          text={card.stem}
          空话="题面是空的——这道题不该进库"
        />
        <正本段
          title="答案 answer"
          text={card.answer}
          空话="没有答案。判档是 analysis_only 时这是正常的（结论在解析里）。"
        />
        <正本段
          title="解析 analysis"
          text={card.analysis}
          空话="没有解析。solution_grade='no_solution' 的题默认不进检索（M1 Q11）。"
        />
      </div>

      {/* ── 考点 / 标签 ─────────────────────────────────────────────────── */}
      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Panel title={`考点（${card.kps.length} 个 · ★ = 主考点）`}>
          {card.kps.length === 0 ? (
            <div className="text-pen text-[12.5px]">
              一个考点都没挂 ——
              按考点检索永远找不到它（录题闸③本该拦下这种题）。
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {card.kps.map((k) => (
                <Link key={k.kpId} href={`/kg/kp/${k.kpId}`} title="看考点卡片">
                  <Chip tone={k.isPrimary ? "g" : "n"}>
                    {k.isPrimary ? "★" : ""}
                    {k.name}
                  </Chip>
                </Link>
              ))}
            </div>
          )}
          <div className="text-mut mt-2 text-[11.5px]">
            主考点 = 这题<b>到底在考什么</b>；副考点 = 顺带沾了点别的。
            resolve_kp 的近邻投票只认主考点。
          </div>
        </Panel>

        <Panel title={`自由标签（${card.tags.length} 条）`}>
          {card.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {card.tags.map((t) => (
                <Chip key={t} tone="n">
                  {t}
                </Chip>
              ))}
            </div>
          ) : (
            <div className="text-mut text-[12.5px]">没打自由标签。</div>
          )}
        </Panel>
      </div>

      {/* ── 配图 ───────────────────────────────────────────────────────── */}
      <div className="mt-3.5">
        <Panel title={`配图（${card.figures.length} 张）`}>
          {card.figures.length === 0 ? (
            <div className="text-mut text-[12.5px]">
              这道题没有配图（题面里也不该出现「［图」这类占位串，闸⑥盯着）。
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {card.figures.map((fig) => (
                <figure key={fig.id} className="max-w-[340px]">
                  {fig.hash ? (
                    // eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节，不进 next/image 优化管线
                    <img
                      src={`/api/asset/${fig.hash}`}
                      alt={`配图 ${fig.role ?? ""}`}
                      className="border-hair2 max-h-[300px] rounded-[2px] border bg-white"
                    />
                  ) : (
                    <div className="text-pen text-[12px]">
                      这张图没有 asset 登记行（对账 C1c 会红）
                    </div>
                  )}
                  <figcaption className="text-mut mt-1 text-[11px]">
                    <Chip tone={fig.role === "stem" ? "a" : "n"}>
                      {fig.role === "stem"
                        ? "题干图（必审）"
                        : (fig.role ?? "角色未填")}
                    </Chip>
                    <Chip tone={图态色(fig.reviewState)}>
                      {fig.reviewState ?? "审核态未填"}
                    </Chip>
                    <span className="font-mono">
                      {fig.hash?.slice(0, 12) ?? ""}
                    </span>
                    {fig.bytes === null ? null : (
                      <span className="ml-1">
                        {(fig.bytes / 1024).toFixed(0)} KB
                      </span>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── 族谱 ───────────────────────────────────────────────────────── */}
      <族谱 lin={lin} meId={card.id} />

      {/* ── 出处 ───────────────────────────────────────────────────────── */}
      <div className="mt-3.5">
        <Panel title="出处 provenance">
          <出处 p={card.provenance} />
          <Row
            k="查重键"
            v={
              <span className="font-mono text-[11px] break-all">
                {card.matchKey ?? "（没算 match_key）"}
              </span>
            }
          />
          <Row
            k="时间"
            v={
              <span className="text-mut num text-[12px]">
                建于 {card.createdAt ?? "未知"}
                {card.updatedAt ? ` · 改于 ${card.updatedAt}` : ""}
              </span>
            }
          />
        </Panel>
      </div>

      <hr className="rule-double my-5 border-0" />
      <div className="flex flex-wrap items-baseline gap-4 text-[12.5px]">
        <Link
          className="text-acc-deep underline"
          href={`/search?similar=${card.id}`}
        >
          找与它相似的题 →
        </Link>
        <span className="text-mut">
          按句向量余弦近邻找（不是关键词）——
          组卷排重、出变式题之前先看一眼这里。
        </span>
      </div>
    </>
  );
}
