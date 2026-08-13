/**
 * 查无此题（AI:PRD-004 · 004-C）—— `/q/<编造的 id>` 落在这里，HTTP 真 404。
 *
 * 🔴 为什么不像考点页那样给"最近似的候选"：
 *    考点 id 里常能读出人话（`kp_绝对值` → "绝对值"），所以 kpContext 猜得出候选；
 *    题 id 是纯 ULID（`q_01KZVF40T06F21857EWW015M89`），**一个语义字符都没有**，
 *    硬猜只会给出误导。给不出就如实给不出 —— 但必须写清楚下一步该干什么。
 *    （同一条口径在 core/retrieval.ts 的 RetrievalError.candidates 上有正本注释。）
 */
import Link from "next/link";

import { Notice, PageHead, Panel } from "~/components/kit";

export default function QuestionNotFound() {
  return (
    <>
      <PageHead title="查无此题" sub="地址栏里的那个 question_id 不在库里" />

      <Notice tone="err">
        这道题不在库里。🔴 题 id 是纯
        ULID，里面读不出任何语义，所以这里给不出「最像的候选」—— 给了也是瞎猜。
      </Notice>

      <Panel title="下一步">
        <ul className="ml-4 list-disc space-y-1.5 text-[12.5px] leading-[1.9]">
          <li>
            回{" "}
            <Link href="/search" className="text-acc-deep underline">
              题库检索
            </Link>{" "}
            按考点 / 关键词 / 语意把它找出来，点命中条上的「看全文」进来 ——
            链接里的 id 一定是真的。
          </li>
          <li>
            id 是从别处抄来的？先确认它抄全了（ULID 26
            位，少一位就是另一道题，也可能谁都不是）。
          </li>
          <li>
            agent 侧对应的是 <span className="font-mono">get_question</span>{" "}
            回的 <span className="font-mono">code=QUESTION_NOT_FOUND</span>
            ，处置方式一样： 改调{" "}
            <span className="font-mono">search_questions</span> 重新查一次。
          </li>
          <li>
            题真被删了 / 还没录？录题走{" "}
            <span className="font-mono">kb_ingest</span>；待审的草稿在{" "}
            <Link href="/queue" className="text-acc-deep underline">
              审查队列
            </Link>
            。
          </li>
        </ul>
      </Panel>
    </>
  );
}
