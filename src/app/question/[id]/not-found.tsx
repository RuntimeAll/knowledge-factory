/**
 * 查无此题 —— `/question/<编造的 id>` 落在这里，HTTP 真 404。
 *
 * 🔴 为什么不像考点页那样给「最近似的候选」：
 *    考点 id 里常能读出人话（`kp_绝对值` → "绝对值"），所以 kpContext 猜得出候选；
 *    题 id 是纯 ULID（`q_01KZVF40T06F21857EWW015M89`），**一个语义字符都没有**，
 *    硬猜只会给出误导。给不出就如实给不出 —— 但必须写清楚下一步该干什么。
 *    （同一条口径在 core/retrieval.ts 的 RetrievalError.candidates 上有正本注释。）
 */
import { Alert, Card } from "antd";
import Link from "next/link";

export default function QuestionNotFound() {
  return (
    <>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 12px" }}>
        查无此题
      </h1>

      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message="这道题不在库里"
        description={
          <span style={{ fontSize: 12.5 }}>
            🔴 题 id 是纯 ULID，里面读不出任何语义，所以这里给不出「最像的候选」——
            给了也是瞎猜。
          </span>
        }
      />

      <Card size="small" title="下一步">
        <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.5, lineHeight: 2 }}>
          <li>
            回 <Link href="/question">题目管理</Link>{" "}
            按考点 / 关键词 / 语意把它找出来，点「查看」进来 —— 链接里的 id 一定是真的。
          </li>
          <li>
            id 是从别处抄来的？先确认它抄全了（ULID 26 位，少一位就是另一道题，
            也可能谁都不是）。
          </li>
          <li>
            agent 侧对应的是 <code>get_question</code> 回的{" "}
            <code>code=QUESTION_NOT_FOUND</code>，处置方式一样：改调{" "}
            <code>search_questions</code> 重新查一次。
          </li>
          <li>
            题真被删了 / 还没录？录题走 <code>kb_ingest</code>；待审的草稿在{" "}
            <Link href="/queue">审查队列</Link>。
          </li>
        </ul>
      </Card>
    </>
  );
}
