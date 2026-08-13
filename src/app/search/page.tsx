/**
 * 题库检索（AI:PRD-004 · 004-C）
 *
 * 004-B 的 {@link searchQuestions} 在页面上的样子。🔴 **同一个入口**：
 * 这页和 MCP 的 search_questions 调的是同一个 core 函数、同一套默认口径 ——
 * 「页面上看得见的题，agent 查不到」是最难查的一类故障，从源头上就不许它发生。
 *
 * ── 三条轴在界面上的分工（写在人眼看得见的地方，不只是注释里）─────────────
 *   条件面板    = SQL 硬过滤：考点 chip / 题型 / 判档 / 含不含次考点。非黑即白。
 *   关键词      = FTS 轴：题面**字面**命中；它若本身是个考点的说法（「去绝对值」），
 *                 core 会再自动开一条**考点标签召回轴**（kpAutoResolve，页面默认开）。
 *   语意描述    = 向量轴：说不出关键词时用（「含字母的绝对值怎么讨论」）。
 *   多条轴同时活 ⇒ core 自动 RRF(k=60) 融合，每条命中带**来源徽章**。
 *
 * ── 🔴 界面如实，不粉饰 ─────────────────────────────────────────────────────
 *   · 难度控件**置灰**并写明「60 题尚未打档」—— 摆一个能点但永远零命中的难度筛选，
 *     比没有它更坏（用户会以为是库里没题）。
 *   · degraded / warnings **原样上墙**：语意轴降级、AND 退 OR 一律说出来。
 *     检索结果的可信度取决于用的人知不知道系统刚才少跑了哪条轴。
 *   · 关键词落靶成考点这件事也上墙（落靶条 + 「考点 #n」徽章）——
 *     「我查的是关键词，系统按考点给我召回了」不说清楚，命中数就永远对不上账。
 *   · 零命中时给放宽建议 + 回显分词 tokens 与落靶结果，让人自己判断是"库里没有"
 *     还是"我这么问系统听不懂"。
 *
 * 🔴 全 server component + GET 表单：URL 即状态（可收藏/可分享/可后退），零 client 状态。
 * 🔴 页面只调 core 的读侧函数，一个 SQL 都不自己写（app 层 import 不到 db）。
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel } from "~/components/kit";
import {
  KpNotFoundError,
  QTYPES,
  RetrievalError,
  findSimilarQuestions,
  kpContext,
  resolveKp,
  searchQuestions,
  type HitSources,
  type KpCandidate,
  type QType,
  type QuestionKpBrief,
  type SearchParams,
  type SearchResult,
  type SimilarResult,
} from "~/core";
import {
  GRADE_CHOICES,
  GRADE_TO_PARAM,
  LIMIT_CHOICES,
  hasCondition,
  parseForm,
  searchUrl,
  showRrf,
  sourceBadges,
  type SearchForm,
} from "./shared";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 表单 → core 入参
// ---------------------------------------------------------------------------

function 是题型(q: string): q is QType {
  return (QTYPES as readonly string[]).includes(q);
}

/**
 * 🔴 `kpAutoResolve: true` —— 页面上人会直接敲「去绝对值」这种**考点的说法**，
 *    而那四个字在任何题面里都不出现。落靶把它交给标签轴（回显在结果里），
 *    不硬塞 FTS。core 的默认仍是关（脚本/评测要的是纯字面口径）。
 */
function 转入参(f: SearchForm): SearchParams {
  const grades = GRADE_TO_PARAM[f.grade];
  return {
    ...(f.kpIds.length > 0 ? { kpIds: f.kpIds } : {}),
    ...(f.includeSub ? {} : { primaryOnly: true }),
    ...(f.keywords ? { keywords: f.keywords } : {}),
    ...(f.semantic ? { semanticQuery: f.semantic } : {}),
    ...(f.qtypes.filter(是题型).length > 0
      ? { qtype: f.qtypes.filter(是题型) }
      : {}),
    ...(grades
      ? { solutionGrade: grades as SearchParams["solutionGrade"] }
      : {}),
    kpAutoResolve: true,
    limit: f.limit,
  };
}

function 人话(e: unknown): string {
  if (e instanceof RetrievalError || e instanceof KpNotFoundError) {
    return `[${e.code}] ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

const 输入框 =
  "border-hair2 bg-sheet rounded-[2px] border px-2 py-[4px] text-[12.5px]";
const 按钮绿 =
  "border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3.5 py-[4px] text-[12.5px]";
const 按钮素 =
  "border-hair2 hover:bg-sel rounded-[2px] border px-2.5 py-[3px] text-[12px]";

/** 一条命中（检索与找相似共用；similar 的分数按语意轴徽章渲染） */
function 命中条({
  questionId,
  stemBrief,
  qtype,
  difficulty,
  solutionGrade,
  status,
  kps,
  rrfScore,
  sources,
}: {
  questionId: string;
  stemBrief: string;
  qtype: string | null;
  difficulty: number | null;
  solutionGrade: string;
  status: string;
  kps: QuestionKpBrief[];
  rrfScore: number;
  sources: HitSources;
}) {
  return (
    <div className="border-hair bg-sheet rounded-[3px] border px-[14px] py-[11px]">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {sourceBadges(sources).map((b) => (
          <span key={b.label} title={b.title}>
            <Chip tone={b.tone}>{b.label}</Chip>
          </span>
        ))}
        {showRrf(sources) ? (
          <span
            className="text-mut num text-[11px]"
            title="RRF(k=60) 融合分 = Σ 1/(60+各轴名次)；两条轴都靠前的才排得上来"
          >
            rrf {rrfScore}
          </span>
        ) : null}
        <Link
          href={`/q/${questionId}`}
          className="text-acc-deep ml-auto text-[12px] underline"
        >
          看全文 →
        </Link>
      </div>

      {/* 🔴 LaTeX 原样等宽展示，不引公式渲染器：朴素优先，先把「查得到」做对 */}
      <Link href={`/q/${questionId}`} className="block">
        <div className="bg-code hover:bg-sel rounded-[2px] px-2.5 py-2 font-mono text-[12.5px] leading-[1.85] break-words whitespace-pre-wrap">
          {stemBrief}
        </div>
      </Link>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1 gap-y-1">
        {kps.map((k) => (
          <Link key={k.kpId} href={`/kg/kp/${k.kpId}`} title="看考点卡片">
            <Chip tone={k.isPrimary ? "g" : "n"}>
              {k.isPrimary ? "★" : ""}
              {k.name}
            </Chip>
          </Link>
        ))}
        <span className="ml-auto flex items-baseline gap-1">
          <Chip tone="n">{qtype ?? "题型未填"}</Chip>
          <Chip tone={solutionGrade === "calc_verified" ? "g" : "n"}>
            {solutionGrade}
          </Chip>
          {status === "active" ? null : <Chip tone="a">{status}</Chip>}
          {difficulty === null ? null : <Chip tone="n">难度 {difficulty}</Chip>}
        </span>
      </div>
      <div className="text-mut mt-1 font-mono text-[10.5px]">{questionId}</div>
    </div>
  );
}

/** 各轴干了什么：命中数 / 降级 / 分词 —— 检索的「仪表盘」 */
function 轴条({ r }: { r: SearchResult }) {
  return (
    <div className="border-hair bg-sheet mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-[3px] border px-3 py-2 text-[12px]">
      <span title="SQL 硬过滤留下的候选题数">
        候选 <span className="num">{r.candidateCount}</span>
      </span>
      <span className={r.axes.fts.active ? "" : "text-mut"}>
        关键词轴{" "}
        {r.axes.fts.active ? (
          <>
            <span className="num">{r.axes.fts.count}</span> 中（
            {r.axes.fts.op === "or" ? "OR·已降级" : "AND"}
            {r.axes.fts.tokens.length > 0
              ? ` · 分词 ${r.axes.fts.tokens.join(" / ")}`
              : ""}
            ）
          </>
        ) : (
          "未启用"
        )}
      </span>
      <span className={r.axes.vector.active ? "" : "text-mut"}>
        语意轴{" "}
        {r.axes.vector.active ? (
          <>
            <span className="num">{r.axes.vector.count}</span> 中（
            {r.axes.vector.modelVer}）
          </>
        ) : (
          "未启用"
        )}
      </span>
      <span className={r.axes.kpAuto.active ? "" : "text-mut"}>
        考点轴{" "}
        {r.axes.kpAuto.active ? (
          <>
            <span className="num">{r.axes.kpAuto.count}</span> 中（关键词落靶
            {r.axes.kpAuto.kpIds.length} 个考点）
          </>
        ) : (
          "未启用"
        )}
      </span>
      <span>
        共 <span className="num">{r.total}</span> 条 · 显示{" "}
        <span className="num">{r.hits.length}</span>
      </span>
      <span className="text-mut num ml-auto">{r.ms}ms</span>
      {r.degraded ? <Chip tone="a">degraded</Chip> : null}
    </div>
  );
}

/** 降级/截断/落靶失败一律上墙，一个字不吞 */
function 告警({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <div className="border-amber/30 bg-amber-soft text-amber mb-3 rounded-[3px] border px-3 py-2 text-[12px] leading-[1.8]">
      {list.map((w, i) => (
        <div key={i} className="break-words">
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

/** 落靶回显：「你敲的词被当成了考点」这件事必须看得见 */
function 落靶条({ r }: { r: SearchResult }) {
  if (r.query.kpAutoResolved.length === 0) return null;
  return (
    <div className="border-acc/30 bg-acc-soft mb-3 rounded-[3px] border px-3 py-2 text-[12px] leading-[1.8]">
      关键词「{r.query.kpAutoResolved[0]!.query}」是<b>考点的说法</b>
      ，已额外开一条考点召回轴（挂着这些考点的题一并召回，带「考点 #n」徽章）：
      {r.query.kpAutoResolved.map((k) => (
        <Link key={k.kpId} href={`/kg/kp/${k.kpId}`}>
          <Chip tone="g">
            {k.name}
            {k.aliasHit ? `（别名「${k.aliasHit}」）` : ""}
          </Chip>
        </Link>
      ))}
      <span className="text-mut">
        —— 只认精确名/别名（confidence=1.0）；一词多考点全部并入。 🔴 它
        <b>不改硬过滤</b>，所以只会加召回，不会把字面本来查得到的题挤掉。
      </span>
    </div>
  );
}

/** 零命中：给能立刻动手的下一步，而不是一句「无结果」 */
function 零命中({ r, f }: { r: SearchResult; f: SearchForm }) {
  return (
    <Panel title="零命中">
      <div className="text-[12.5px] leading-[1.9]">
        <div className="mb-2">
          硬过滤后还剩 <span className="num">{r.candidateCount}</span>{" "}
          道候选，但召回轴在里面一条都没排出来。可以试试：
        </div>
        <ul className="ml-4 list-disc space-y-1">
          {f.qtypes.length > 0 ? (
            <li>去掉题型限制（当前 {f.qtypes.join("、")}）</li>
          ) : null}
          {f.kpIds.length > 0 ? (
            <li>去掉考点 chip，或勾上「含次考点」放宽</li>
          ) : null}
          {f.grade !== "" ? <li>判档改回「默认」</li> : null}
          {f.keywords ? (
            <li>
              关键词换个说法：现在按{" "}
              <span className="font-mono">
                {r.axes.fts.tokens.join(" / ") || "（切不出词）"}
              </span>{" "}
              逐词{r.axes.fts.op === "or" ? "OR" : "AND"} 找<b>题面字面</b>
              ——
              若你要找的是「这类题」而不是「有这几个字的题」，把它挪到右边的语意框
            </li>
          ) : (
            <li>
              填「语意描述」那一栏：说不出关键词的问法（「含字母的绝对值怎么讨论」）走向量轴
            </li>
          )}
          <li>
            或者库里确实没有这类题 —— 那就是{" "}
            <span className="font-mono">kb_ingest</span> 该补料了
          </li>
        </ul>
        {r.query.kpAutoResolved.length === 0 && f.keywords ? (
          <div className="text-mut mt-2">
            这个词没落靶成考点（只认 confidence=1.0 的精确名/别名）——
            想按考点找就用上面的考点搜索框选 chip。
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 页
// ---------------------------------------------------------------------------

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const f = parseForm(sp);
  const 有条件 = hasCondition(f);
  const 相似模式 = f.similar.length > 0;

  // ── 已选考点 chip 的名字（kpContext 顺带把 merged 壳追到活跃落点）──────────
  const chips = await Promise.all(
    f.kpIds.map(async (id) => {
      try {
        const c = await kpContext(id);
        return { id, name: c.kp.name, ok: true };
      } catch {
        // 🔴 一个坏 id（手改地址栏）不该让整页白屏：chip 照挂，名字位显示原 id
        return { id, name: id, ok: false };
      }
    }),
  );

  // ── 考点搜索框的候选（server 端 resolve，选中才变成 chip）──────────────────
  let 候选: KpCandidate[] = [];
  let 候选低置信 = false;
  let 候选错 = "";
  if (f.kpq) {
    try {
      // 🔴 enqueue:false —— 页面上每敲一次回车就往人的待办队列塞一张工单，队列就废了
      const r = await resolveKp(f.kpq, { enqueue: false, limit: 10 });
      候选 = r.candidates;
      候选低置信 = r.lowConfidence;
    } catch (e) {
      候选错 = 人话(e);
    }
  }

  // ── 检索 / 找相似 ─────────────────────────────────────────────────────────
  let result: SearchResult | null = null;
  let similar: SimilarResult | null = null;
  let 检索错 = "";
  try {
    if (相似模式) {
      // 🔴 metric 照落：「找相似」也是真人的一次真实查询（004-D 评测集的原料）
      similar = await findSimilarQuestions(f.similar, { limit: f.limit });
    } else {
      result = await searchQuestions(转入参(f), { metric: 有条件 });
    }
  } catch (e) {
    检索错 = 人话(e);
  }

  return (
    <>
      <PageHead
        title="题库检索"
        sub="标签硬过滤（能不能要）× 关键词字面 × 语意近邻 —— 后两条只在候选集内排名，RRF k=60 融合"
        right={
          <div className="flex gap-3 text-[12.5px]">
            <Link className="text-acc-deep underline" href="/kg">
              知识图谱
            </Link>
            <Link className="text-acc-deep underline" href="/queue">
              审查队列
            </Link>
          </div>
        }
      />

      {检索错 ? <Notice tone="err">{检索错}</Notice> : null}

      {/* ── 相似模式的横幅 ──────────────────────────────────────────────── */}
      {相似模式 ? (
        <div className="border-hair bg-sheet mb-3.5 rounded-[3px] border px-3 py-2 text-[12.5px]">
          <b>找与这道题相似的</b>
          <span className="text-mut ml-2 font-mono text-[11px]">
            {f.similar}
          </span>
          <Link
            href={`/q/${f.similar}`}
            className="text-acc-deep ml-3 underline"
          >
            回到这道题 →
          </Link>
          <Link href="/search" className="text-mut ml-3 underline">
            退出相似模式
          </Link>
          {similar ? (
            <div className="bg-code mt-2 rounded-[2px] px-2.5 py-2 font-mono text-[12px] break-words whitespace-pre-wrap">
              {similar.stemBrief}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── 条件面板（GET 表单：URL 即状态）────────────────────────────── */}
      <form action="/search" className="mb-4">
        {/* 🔴 见 shared.ts 文件头：区分「首屏」与「提交了但没勾」 */}
        <input type="hidden" name="f" value="1" />
        {f.kpIds.map((id) => (
          <input key={id} type="hidden" name="kp" value={id} />
        ))}

        <Panel
          title="检索条件"
          right={
            <button type="submit" className={按钮绿}>
              检索
            </button>
          }
        >
          {/* 考点 */}
          <div className="border-hair border-b pb-2.5">
            <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
              <span className="text-mut w-[68px] shrink-0 text-[11.5px] tracking-[0.5px]">
                考点
              </span>
              {chips.length > 0 ? (
                chips.map((c) => (
                  <span
                    key={c.id}
                    className="border-acc/30 bg-acc-soft text-acc-deep inline-flex items-baseline gap-1.5 rounded-[2px] border px-2 py-[1px] text-[12.5px]"
                  >
                    {c.ok ? (
                      <Link href={`/kg/kp/${c.id}`}>{c.name}</Link>
                    ) : (
                      <span
                        className="text-pen font-mono"
                        title="库里没有这个考点 id"
                      >
                        {c.name}
                      </span>
                    )}
                    <Link
                      href={searchUrl(f, {
                        kpIds: f.kpIds.filter((x) => x !== c.id),
                      })}
                      title="从条件里去掉它"
                      className="text-mut hover:text-pen"
                    >
                      ×
                    </Link>
                  </span>
                ))
              ) : (
                <span className="text-mut text-[12px]">
                  没选考点 = 不按考点过滤（全库）
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-baseline gap-2">
              <span className="w-[68px] shrink-0" />
              <input
                name="kpq"
                defaultValue={f.kpq}
                placeholder="搜考点：绝对值 / 去绝对值 / 合并同类项…"
                className={`${输入框} w-[300px]`}
              />
              <label className="text-[12.5px]">
                <input
                  type="checkbox"
                  name="sub"
                  value="1"
                  defaultChecked={f.includeSub}
                  className="mr-1 align-middle"
                />
                含次考点
                <span className="text-mut ml-1 text-[11px]">
                  （不勾 = 只认主考点 ★）
                </span>
              </label>
            </div>

            {候选错 ? (
              <div className="text-pen mt-1.5 text-[12px]">{候选错}</div>
            ) : null}
            {f.kpq && !候选错 ? (
              <div className="mt-1.5 pl-[76px]">
                {候选.length === 0 ? (
                  <div className="text-amber text-[12px]">
                    「{f.kpq}」一条候选都没有 ——
                    换个说法，或者这个考点词表里还没有。
                  </div>
                ) : (
                  <>
                    {候选低置信 ? (
                      <div className="text-amber mb-1 text-[11.5px]">
                        🔴 词表四路没把握（最高
                        {候选[0]!.confidence}）——
                        下面的候选只作参考，别硬挑一个。
                      </div>
                    ) : null}
                    <ul className="space-y-[3px] text-[12.5px]">
                      {候选.map((c) => (
                        <li key={c.kpId} className="flex items-baseline gap-2">
                          <Link
                            href={searchUrl(f, {
                              kpIds: [...new Set([...f.kpIds, c.kpId])],
                              kpq: "",
                            })}
                            className={按钮素}
                          >
                            选它
                          </Link>
                          <span>{c.name}</span>
                          <span className="num text-mut">{c.confidence}</span>
                          <span className="text-mut text-[11px]">
                            {c.matchedVia}
                            {c.aliasHit ? ` · 别名「${c.aliasHit}」` : ""}
                            {c.evidence
                              ? ` · ${c.evidence.supportQuestions} 道近邻题投的（旁证）`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : null}
          </div>

          {/* 两个词框 */}
          <div className="border-hair grid gap-3 border-b py-2.5 lg:grid-cols-2">
            <div>
              <label className="block text-[12.5px] font-semibold">
                关键词（字面轴）
              </label>
              <div className="text-mut mb-1 text-[11.5px]">
                题面里<b>真出现过</b>这些字才算命中（jieba 分词后逐词
                AND，全中不了自动退 OR）。
              </div>
              <input
                name="kw"
                defaultValue={f.keywords}
                placeholder="最小值 / 立方根 / 去绝对值"
                className={`${输入框} w-full`}
              />
            </div>
            <div>
              <label className="block text-[12.5px] font-semibold">
                语意描述（语意轴）
              </label>
              <div className="text-mut mb-1 text-[11.5px]">
                描述你要找<b>什么样的题</b>，不必是题面里的字（句向量近邻）。
              </div>
              <input
                name="sem"
                defaultValue={f.semantic}
                placeholder="含字母的绝对值怎么分类讨论正负"
                className={`${输入框} w-full`}
              />
            </div>
          </div>

          {/* 题型 / 判档 / 难度 / limit */}
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2 pt-2.5">
            <div>
              <div className="text-mut mb-1 text-[11.5px] tracking-[0.5px]">
                题型（多选 = 命中任一）
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                {QTYPES.map((q) => (
                  <label key={q}>
                    <input
                      type="checkbox"
                      name="qt"
                      value={q}
                      defaultChecked={f.qtypes.includes(q)}
                      className="mr-1 align-middle"
                    />
                    {q}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div className="text-mut mb-1 text-[11.5px] tracking-[0.5px]">
                判档 solution_grade
              </div>
              <select name="sg" defaultValue={f.grade} className={输入框}>
                {GRADE_CHOICES.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 🔴 如实置灰：全库 difficulty 都是 NULL，能点的难度筛选只会永远零命中 */}
            <div>
              <div className="text-mut mb-1 text-[11.5px] tracking-[0.5px]">
                难度区间
              </div>
              <div className="flex items-baseline gap-1.5">
                <select disabled className={`${输入框} opacity-50`}>
                  <option>1</option>
                </select>
                <span className="text-mut">–</span>
                <select disabled className={`${输入框} opacity-50`}>
                  <option>5</option>
                </select>
                <span className="text-amber text-[11.5px]">
                  60 题尚未打档 —— 打档后启用
                </span>
              </div>
            </div>

            <div>
              <div className="text-mut mb-1 text-[11.5px] tracking-[0.5px]">
                返回条数
              </div>
              <select name="limit" defaultValue={f.limit} className={输入框}>
                {LIMIT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-mut ml-auto self-end text-[11.5px]">
              状态默认只看 active + pending（隔离/驳回/退役的题不进检索）
            </div>
          </div>
        </Panel>
      </form>

      {/* ── 结果 ───────────────────────────────────────────────────────── */}
      {similar ? (
        <>
          {similar.degraded ? <告警 list={similar.warnings} /> : null}
          <div className="border-hair bg-sheet mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-[3px] border px-3 py-2 text-[12px]">
            <span>语意近邻（余弦）</span>
            <span>
              共 <span className="num">{similar.hits.length}</span> 条
            </span>
            <span className="text-mut">{similar.modelVer ?? "模型不可用"}</span>
            <span className="text-mut num ml-auto">{similar.ms}ms</span>
          </div>
          <div className="space-y-2.5">
            {similar.hits.map((h, i) => (
              <命中条
                key={h.questionId}
                questionId={h.questionId}
                stemBrief={h.stemBrief}
                qtype={h.qtype}
                difficulty={h.difficulty}
                solutionGrade={h.solutionGrade}
                status={h.status}
                kps={h.kps}
                rrfScore={0}
                sources={{ vector: { rank: i + 1, score: h.score } }}
              />
            ))}
          </div>
          {similar.hits.length === 0 ? (
            <Panel title="没有相似题">
              <div className="text-mut text-[12.5px]">
                语意轴没给出近邻 ——
                多半是它降级了（见上面的告警），或者库里就这一道。
              </div>
            </Panel>
          ) : null}
        </>
      ) : null}

      {result ? (
        <>
          <落靶条 r={result} />
          <告警 list={result.warnings} />
          <轴条 r={result} />
          {result.hits.length === 0 ? (
            <零命中 r={result} f={f} />
          ) : (
            <div className="space-y-2.5">
              {result.hits.map((h) => (
                <命中条
                  key={h.questionId}
                  questionId={h.questionId}
                  stemBrief={h.stemBrief}
                  qtype={h.qtype}
                  difficulty={h.difficulty}
                  solutionGrade={h.solutionGrade}
                  status={h.status}
                  kps={h.kps}
                  rrfScore={h.rrfScore}
                  sources={h.sources}
                />
              ))}
            </div>
          )}
          {result.total > result.hits.length ? (
            <div className="text-mut mt-3 text-[12px]">
              还有{" "}
              <span className="num">{result.total - result.hits.length}</span>{" "}
              条没显示 —— 把「返回条数」调大，或者再加个条件收窄。
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
