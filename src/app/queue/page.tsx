/**
 * 审查队列（AI:PRD-003 · 003-D）—— 全域队列的处置台
 *
 * 002-D 的 /kg/queue 只能「表个态」（通过/驳回）。003 的管道会往队列里扔**带活儿**的工单，
 * 所以这页按四类分 tab，每类的按钮背后是一条真的处置链（core/review.ts）：
 *
 *   考点低置信  通过 / 驳回 / 快捷加别名（002-D 搬过来，一字未改）
 *   图片        看图核对 → 通过（图 passed + 全过则摘掉题的必审）/ 驳回（题保持必审）
 *   新题草稿    看题与预检 → 转正（跑同一条管道真入库）/ 驳回
 *   隔离区      读 quarantine 表：改判重投（改 JSON 再走一遍闸）/ 废弃
 *   全部        兜底：KG提议、模型转正、抽查、其他 全在这儿
 *
 * 🔴 页面只读 core 的读侧函数 + 调 core 的写原语，一个 SQL 都不自己写（app 层 import 不到 db）。
 * 🔴 破坏性/需理由的动作一律走确认页（002-D 定式）：驳回、废弃、改判重投。
 * 🔴 图片走 `/api/asset/<hash>` 拿字节 —— 页面不碰文件系统，路径一律由库里的登记行说了算。
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel } from "~/components/kit";
import {
  countOpenQueueByKind,
  getDraftCard,
  getFigureReviewCard,
  listQuarantine,
  listQueueItems,
  type DraftCard,
  type FigureReviewCard,
  type QuarantineRow,
  type QueueItem,
} from "~/core";
import { param } from "../kg/shared";
import {
  promoteDraftAction,
  passFigureAction,
  verdictQueueAction,
} from "./actions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// tab 表（🔴 URL 用 ascii key，别拿中文 kind 当 query —— 编码后没法读也没法手敲）
// ---------------------------------------------------------------------------

const TABS = [
  { key: "kp", label: "考点低置信", kind: "kp低置信" },
  { key: "figure", label: "图片", kind: "图片" },
  { key: "draft", label: "新题草稿", kind: "新题草稿" },
  { key: "quarantine", label: "隔离区", kind: null },
  { key: "all", label: "全部", kind: null },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** 工单三态（隔离区另有一套，见 QR_STATES） */
const QUEUE_STATES = ["open", "passed", "rejected"] as const;
/** 隔离行两态 + 全部（quarantine 没有裁决，只有「结没结」） */
const QR_STATES = ["open", "resolved", "all"] as const;

const 状态名: Record<string, string> = {
  open: "未处置",
  passed: "已通过",
  rejected: "已驳回",
  resolved: "已结",
  all: "全部",
};

function 状态色(state: string): "a" | "g" | "r" | "n" {
  return state === "open"
    ? "a"
    : state === "passed"
      ? "g"
      : state === "rejected"
        ? "r"
        : "n";
}

function pretty(json: string | null): string {
  if (!json) return "（空）";
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** 低置信工单 payload 里那句 query（取不到就 null，绝不猜） */
function queryOf(item: QueueItem): string | null {
  if (!item.payloadJson) return null;
  try {
    const p: unknown = JSON.parse(item.payloadJson);
    if (p && typeof p === "object" && "query" in p) {
      return typeof p.query === "string" ? p.query : null;
    }
  } catch {
    /* 不是 JSON 也不是灾难：下面 details 里原样展示它 */
  }
  return null;
}

function 链接(tab: string, state: string): string {
  const p = new URLSearchParams();
  p.set("tab", tab);
  if (state) p.set("state", state);
  return `/queue?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

/** 已裁工单的落款（谁裁的、什么时候、理由） */
function 落款({ it }: { it: QueueItem }) {
  return (
    <div className="border-hair text-mut mt-2.5 border-t pt-2 text-[12px]">
      {it.verdictBy ?? "未记名"} 于 {it.verdictAt ?? "时间未知"} 裁：{it.state}
      {it.verdictNote ? (
        <div className="text-ink mt-1 break-words whitespace-pre-wrap">
          理由：{it.verdictNote}
        </div>
      ) : null}
    </div>
  );
}

function 工单头({ it }: { it: QueueItem }) {
  return (
    <span className="flex items-baseline gap-2">
      <Chip tone={状态色(it.state)}>{it.state}</Chip>
      <span className="text-mut num text-[11px]">
        {it.createdAt ?? "时间未知"}
      </span>
    </span>
  );
}

/** 原样 payload（折叠）——处置不了的时候，人总得看得见原始那一坨 */
function 原样({ it }: { it: QueueItem }) {
  return (
    <details className="mt-2">
      <summary className="text-mut cursor-pointer text-[12px]">
        payload_json / signals_json（原样）
      </summary>
      <pre className="bg-code mt-1 max-h-[280px] overflow-auto rounded-[2px] p-2 text-[11.5px] whitespace-pre-wrap">
        {pretty(it.payloadJson)}
        {it.signalsJson ? `\n--- signals ---\n${pretty(it.signalsJson)}` : ""}
      </pre>
    </details>
  );
}

/** 隐藏字段：把当前 tab/state 带进 action，处置完还回原地 */
function 回位({ tab, state }: { tab: string; state: string }) {
  return (
    <>
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="state" value={state} />
    </>
  );
}

const 按钮绿 =
  "border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3 py-[3px] text-[12.5px]";
const 按钮红 =
  "border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[3px] text-[12.5px]";
const 按钮素 =
  "border-hair2 hover:bg-sel rounded-[2px] border px-3 py-[3px] text-[12.5px]";

// ---------------------------------------------------------------------------
// 页
// ---------------------------------------------------------------------------

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tabRaw = param(sp, "tab");
  const tab: TabKey = TABS.find((t) => t.key === tabRaw)?.key ?? "kp";
  const 隔离视图 = tab === "quarantine";
  const stateRaw = param(sp, "state");
  const 可选态: readonly string[] = 隔离视图 ? QR_STATES : QUEUE_STATES;
  const state = 可选态.includes(stateRaw) ? stateRaw : "open";
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  // 计数：tab 上的徽章（未处置数）。零 open 的 tab 不挂数字，别制造焦虑。
  const [byKind, 隔离未结] = await Promise.all([
    countOpenQueueByKind(),
    listQuarantine({ state: "open", limit: 500 }),
  ]);
  const 未处置 = (kind: string) =>
    byKind.find((k) => k.kind === kind)?.count ?? 0;
  const openTotal = byKind.reduce((a, b) => a + b.count, 0);

  // 本 tab 的料
  const kind = TABS.find((t) => t.key === tab)?.kind ?? null;
  const items: QueueItem[] = 隔离视图
    ? []
    : await listQueueItems({
        kind: kind ?? undefined,
        state: state as "open" | "passed" | "rejected",
        limit: 200,
      });

  // 图片/草稿两类要额外的卡片包（题面、图 hash、预检）——本地库，逐条取够快
  const 图卡 = new Map<string, FigureReviewCard>();
  const 草稿卡 = new Map<string, DraftCard>();
  const 卡错 = new Map<string, string>();
  if (tab === "figure" || tab === "draft") {
    for (const it of items) {
      try {
        if (tab === "figure") 图卡.set(it.id, await getFigureReviewCard(it.id));
        else 草稿卡.set(it.id, await getDraftCard(it.id));
      } catch (e) {
        // 🔴 一条坏工单不该让整页白屏：把报错挂在那一条上，其余照常处置
        卡错.set(it.id, e instanceof Error ? e.message : String(e));
      }
    }
  }

  const 隔离行: QuarantineRow[] = 隔离视图
    ? await listQuarantine({
        state: state as "open" | "resolved" | "all",
        limit: 200,
      })
    : [];

  const 条数 = 隔离视图 ? 隔离行.length : items.length;

  return (
    <>
      <PageHead
        title="审查队列"
        sub="agent 拿不准的、管道拦下的、必须人看一眼的，都在这儿排队 —— 处置一条，链条就往前走一格"
        right={
          <div className="flex gap-3 text-[12.5px]">
            <Link className="text-acc-deep underline" href="/kg">
              知识图谱
            </Link>
            <span className="text-mut">
              未处置 <span className="num">{openTotal + 隔离未结.length}</span>
            </span>
          </div>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      {/* ── tab 条（纯链接，无 JS）───────────────────────────────────────── */}
      <div className="border-hair bg-sheet mb-3.5 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 rounded-[3px] border px-3 py-2 text-[12.5px]">
        {TABS.map((t) => {
          const n =
            t.key === "quarantine"
              ? 隔离未结.length
              : t.key === "all"
                ? openTotal
                : 未处置(t.kind);
          return (
            <Link
              key={t.key}
              href={链接(t.key, "open")}
              className={
                t.key === tab
                  ? "text-acc-deep border-acc border-b-2 pb-[2px] font-bold"
                  : "text-mut underline"
              }
            >
              {t.label}
              {n > 0 ? <span className="num ml-1">({n})</span> : null}
            </Link>
          );
        })}

        <span className="border-hair ml-3 border-l pl-3" />
        <span className="text-mut text-[12px] tracking-[1px]">状态</span>
        {可选态.map((s) => (
          <Link
            key={s}
            href={链接(tab, s)}
            className={
              s === state
                ? "text-acc-deep text-[12px] font-bold"
                : "text-mut text-[12px] underline"
            }
          >
            {状态名[s] ?? s}
          </Link>
        ))}
        <span className="text-mut ml-auto text-[12px]">
          共 <span className="num">{条数}</span> 条
        </span>
      </div>

      {条数 === 0 ? (
        <Panel title="空">
          <div className="text-mut text-[12.5px]">
            {state === "open"
              ? "这一类没有待处置的东西 —— 队列空是好事：它说明管道拦下的、agent 问不出来的，都已经有人看过了。"
              : "没有符合条件的记录。"}
          </div>
        </Panel>
      ) : null}

      {/* ── 隔离区（读 quarantine 表，不是 review_queue）──────────────────── */}
      {隔离视图 ? (
        <div className="space-y-3">
          {隔离行.map((q) => (
            <Panel
              key={q.id}
              title="隔离"
              right={
                <span className="flex items-baseline gap-2">
                  <Chip tone={q.resolvedAt ? "n" : "a"}>
                    {q.resolvedAt ? "已结" : "未结"}
                  </Chip>
                  <span className="text-mut num text-[11px]">
                    {q.createdAt ?? "时间未知"}
                  </span>
                </span>
              }
            >
              <div className="text-pen text-[12.5px] leading-[1.8] break-words whitespace-pre-wrap">
                {q.why}
              </div>
              <details className="mt-2">
                <summary className="text-mut cursor-pointer text-[12px]">
                  原样 payload（改判时就是拿它改）
                </summary>
                <pre className="bg-code mt-1 max-h-[280px] overflow-auto rounded-[2px] p-2 text-[11.5px] whitespace-pre-wrap">
                  {pretty(q.payloadJson)}
                </pre>
              </details>
              <div className="border-hair mt-2.5 flex flex-wrap items-center gap-3 border-t pt-2.5">
                {q.resolvedAt ? (
                  <span className="text-mut text-[12px]">
                    已于 {q.resolvedAt} 结案（处置痕迹见上面 why 的【处置】行）
                  </span>
                ) : (
                  <Link href={`/queue/quarantine/${q.id}`} className={按钮素}>
                    改判重投 / 废弃…
                  </Link>
                )}
                <span className="text-mut ml-auto font-mono text-[10.5px]">
                  {q.id}
                  {q.batchId ? ` · 批 ${q.batchId}` : ""}
                </span>
              </div>
            </Panel>
          ))}
        </div>
      ) : null}

      {/* ── 工单三类 + 全部 ─────────────────────────────────────────────── */}
      {!隔离视图 ? (
        <div className="space-y-3">
          {items.map((it) => {
            const 已裁 = it.state !== "open";
            const 图 = 图卡.get(it.id);
            const 草 = 草稿卡.get(it.id);
            const 卡的错 = 卡错.get(it.id);
            const q = queryOf(it);

            return (
              <Panel
                key={it.id}
                title={it.kind ?? "（未分类）"}
                right={<工单头 it={it} />}
              >
                <div className="text-[12.5px] leading-[1.8] break-words whitespace-pre-wrap">
                  {it.reason ?? "（没写理由）"}
                </div>

                {it.refType || it.refId ? (
                  <div className="text-mut mt-1 text-[11.5px]">
                    指向 {it.refType ?? "?"} ·{" "}
                    <span className="font-mono">{it.refId ?? "?"}</span>
                  </div>
                ) : null}

                {卡的错 ? (
                  <div className="text-pen mt-2 text-[12px] whitespace-pre-wrap">
                    这条工单的详情读不出来：{卡的错}
                  </div>
                ) : null}

                {/* 图片工单：题面 + 图，对着看 */}
                {图 ? (
                  <div className="mt-2.5">
                    <div className="border-hair bg-paper rounded-[2px] border px-3 py-2 text-[13px] leading-[1.9] break-words whitespace-pre-wrap">
                      {图.question?.stem ?? "（题不在库里了）"}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {图.figures.map((f) => (
                        <figure key={f.id} className="max-w-[320px]">
                          {f.hash ? (
                            // eslint-disable-next-line @next/next/no-img-element -- 本地资产走 /api/asset 直返字节，不进 next/image 优化管线
                            <img
                              src={`/api/asset/${f.hash}`}
                              alt={`配图 ${f.role ?? ""}`}
                              className="border-hair2 max-h-[260px] rounded-[2px] border bg-white"
                            />
                          ) : (
                            <div className="text-pen text-[12px]">
                              这张图没有 asset 登记行（对账 C1c 会红）
                            </div>
                          )}
                          <figcaption className="text-mut mt-1 text-[11px]">
                            <Chip tone={f.role === "stem" ? "a" : "n"}>
                              {f.role ?? "?"}
                            </Chip>
                            <Chip tone={状态色(f.reviewState ?? "")}>
                              {f.reviewState ?? "?"}
                            </Chip>
                            <span className="font-mono">
                              {f.hash?.slice(0, 12) ?? ""}
                            </span>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                    {图.question ? (
                      <div className="text-mut mt-1.5 text-[11.5px]">
                        题 <span className="font-mono">{图.question.id}</span> ·
                        review_required=
                        <span className="num">
                          {图.question.reviewRequired}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* 新题草稿：题 + 预检 */}
                {草 ? (
                  <div className="mt-2.5">
                    <div className="border-hair bg-paper rounded-[2px] border px-3 py-2 text-[13px] leading-[1.9] break-words whitespace-pre-wrap">
                      {typeof 草.draft.item.stem === "string"
                        ? 草.draft.item.stem
                        : "（payload 里没有 stem）"}
                    </div>
                    <div className="text-mut mt-1.5 text-[11.5px]">
                      答案：
                      {typeof 草.draft.item.answer === "string"
                        ? 草.draft.item.answer
                        : "（无）"}
                      {" · "}来源 {草.draft.source}
                    </div>
                    {草.draft.precheck ? (
                      <div className="mt-2 text-[12px]">
                        预检：
                        <Chip tone={草.draft.precheck.ok ? "g" : "r"}>
                          {草.draft.precheck.ok ? "全绿" : "有红灯"}
                        </Chip>
                        {草.draft.precheck.calcVerdict ? (
                          <Chip tone="n">
                            实算 {草.draft.precheck.calcVerdict}
                          </Chip>
                        ) : null}
                        {草.draft.precheck.solutionGrade ? (
                          <Chip tone="n">
                            {草.draft.precheck.solutionGrade}
                          </Chip>
                        ) : null}
                        {草.draft.precheck.reds?.length ? (
                          <ul className="text-pen mt-1.5 space-y-1">
                            {草.draft.precheck.reds.map((r, i) => (
                              <li key={i} className="break-words">
                                <span className="num mr-1">{r.gate}</span>
                                <span className="font-mono">
                                  [{r.code}]
                                </span>{" "}
                                {r.message}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <原样 it={it} />

                {!已裁 ? (
                  <div className="border-hair mt-2.5 flex flex-wrap items-center gap-3 border-t pt-2.5">
                    {/* 图片：通过 = 一条 core 原语串完（图 + 题 + 工单，单事务） */}
                    {tab === "figure" ? (
                      <form action={passFigureAction}>
                        <input type="hidden" name="id" value={it.id} />
                        <回位 tab={tab} state={state} />
                        <button type="submit" className={按钮绿}>
                          图对得上，通过
                        </button>
                      </form>
                    ) : null}

                    {/* 新题草稿：转正 = 真跑管道入库 */}
                    {tab === "draft" ? (
                      <form action={promoteDraftAction}>
                        <input type="hidden" name="id" value={it.id} />
                        <回位 tab={tab} state={state} />
                        <button type="submit" className={按钮绿}>
                          转正入库
                        </button>
                      </form>
                    ) : null}

                    {/* 其余类别：通过 = 只表态，不改数据 */}
                    {tab !== "figure" && tab !== "draft" ? (
                      <form action={verdictQueueAction}>
                        <input type="hidden" name="id" value={it.id} />
                        <input type="hidden" name="verdict" value="passed" />
                        <回位 tab={tab} state={state} />
                        <button type="submit" className={按钮绿}>
                          通过
                        </button>
                      </form>
                    ) : null}

                    <Link href={`/queue/${it.id}/reject`} className={按钮红}>
                      驳回…
                    </Link>

                    {it.kind === "kp低置信" && q ? (
                      <Link href={`/queue/${it.id}/alias`} className={按钮素}>
                        快捷加别名（把「{q}」补进词表）
                      </Link>
                    ) : null}

                    <span className="text-mut ml-auto font-mono text-[10.5px]">
                      {it.id}
                    </span>
                  </div>
                ) : (
                  <落款 it={it} />
                )}
              </Panel>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
