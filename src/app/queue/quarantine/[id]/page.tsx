/**
 * 队列 · 隔离行改判（AI:PRD-003 · 003-D）
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
 */
import Link from "next/link";

import { Chip, Notice, PageHead, Panel, Row } from "~/components/kit";
import { getQuarantineRow } from "~/core";
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
    error = e instanceof Error ? e.message : String(e);
  }

  if (!row) {
    return (
      <>
        <PageHead
          title="隔离行"
          sub={<span className="font-mono">{id}</span>}
        />
        <div className="text-pen text-[12.5px] whitespace-pre-wrap">
          {error ?? "这条隔离行不在库里。"}
        </div>
        <div className="mt-4 text-[12.5px]">
          <Link
            className="text-acc-deep underline"
            href="/queue?tab=quarantine"
          >
            ← 回队列
          </Link>
        </div>
      </>
    );
  }

  const 已结 = Boolean(row.resolvedAt);

  return (
    <>
      <PageHead
        title="改判这条隔离料"
        sub={<span className="font-mono">{row.id}</span>}
        right={
          <span className="flex items-baseline gap-2">
            <Chip tone={已结 ? "n" : "a"}>{已结 ? "已结" : "未结"}</Chip>
            <Link
              className="text-acc-deep text-[12.5px] underline"
              href="/queue?tab=quarantine"
            >
              ← 队列
            </Link>
          </span>
        }
      />

      {err ? <Notice tone="err">{err}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      <Panel title="管道为什么拒了它">
        <div className="text-pen text-[12.5px] leading-[1.9] break-words whitespace-pre-wrap">
          {row.why}
        </div>
        <div className="mt-2">
          <Row k="进隔离时间" v={row.createdAt ?? "—"} />
          <Row
            k="来自批"
            v={
              row.batchId ? (
                <span className="font-mono">{row.batchId}</span>
              ) : (
                "—"
              )
            }
          />
          {已结 ? <Row k="结案时间" v={row.resolvedAt} /> : null}
        </div>
      </Panel>

      {已结 ? (
        <div className="text-mut mt-4 text-[12.5px] leading-[1.9]">
          这条已经在 {row.resolvedAt} 结过了 —— 不重复处置（处置痕迹见上面 why
          的【处置】行）。
          <br />
          还想录这道题就直接走录题管线（MCP 的 kb_ingest / propose_question）。
        </div>
      ) : (
        <>
          <div className="mt-3.5">
            <Panel title="① 改判重投（改完再走一遍全套闸）">
              <form action={reingestQuarantineAction}>
                <input type="hidden" name="id" value={row.id} />
                <label
                  htmlFor="payload"
                  className="text-mut mb-1 block text-[11.5px] tracking-[1px]"
                >
                  单题 payload（原样 JSON；不动它 = 拿原样重投）
                </label>
                <textarea
                  id="payload"
                  name="payload"
                  rows={16}
                  defaultValue={pretty(row.payloadJson)}
                  spellCheck={false}
                  className="border-hair2 bg-paper w-full rounded-[2px] border px-2 py-1.5 font-mono text-[11.5px] leading-[1.7]"
                />
                <label
                  htmlFor="note"
                  className="text-mut mt-2 mb-1 block text-[11.5px] tracking-[1px]"
                >
                  改了什么（记进 quarantine.why 的处置行）
                </label>
                <input
                  id="note"
                  name="note"
                  placeholder="例：考点名写错了，改成「有理数的混合运算」"
                  className="border-hair2 bg-paper w-full rounded-[2px] border px-2 py-1.5 text-[12.5px]"
                />
                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    className="border-acc/40 text-acc-deep bg-acc-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
                  >
                    重投这一题
                  </button>
                  <span className="text-mut text-[11.5px]">
                    🔴
                    还红就零写返回（这条隔离行原地不动，不会多长一行），红灯原文贴在页顶
                  </span>
                </div>
              </form>
            </Panel>
          </div>

          <div className="mt-3.5">
            <Panel title="② 废弃（这题不要了）">
              <form action={discardQuarantineAction}>
                <input type="hidden" name="id" value={row.id} />
                <label
                  htmlFor="dnote"
                  className="text-mut mb-1 block text-[11.5px] tracking-[1px]"
                >
                  废弃理由（必填 ——
                  日后翻账时，「为什么不要它」比「不要它」有用得多）
                </label>
                <textarea
                  id="dnote"
                  name="note"
                  rows={2}
                  required
                  placeholder="例：题源本身抄错了，卷子已作废，不必再录。"
                  className="border-hair2 bg-paper w-full rounded-[2px] border px-2 py-1.5 text-[12.5px]"
                />
                <div className="mt-2.5 flex items-center gap-3">
                  <button
                    type="submit"
                    className="border-pen/40 text-pen bg-pen-soft rounded-[2px] border px-3 py-[5px] text-[12.5px] font-semibold"
                  >
                    确认废弃
                  </button>
                  <Link
                    href="/queue?tab=quarantine"
                    className="text-mut text-[12.5px] underline"
                  >
                    取消，回队列
                  </Link>
                </div>
              </form>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
