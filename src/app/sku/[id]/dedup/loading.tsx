/**
 * 排重报告的加载态（AI:PRD-009 · 打磨检查单 §三·1）
 *
 * 🔴 这一页是全站**最慢**的一页，所以它自己要一份话说得更清的骨架：
 *    ① 逐题 `getQuestion` 取 stem 正本（题面必须取正本，摘要算出来的 match_key
 *       是另一个键，报告会假绿）——一本 120 题的册子就是 120 次读；
 *    ② 开了语义轴（`?similar=1`）还要跑整册句向量（本地 ONNX），要等好几秒。
 *    没有这份骨架时，点「开语义轴」那条链接**看上去完全没反应** ——
 *    人会以为链接坏了，然后连点几下。
 * 🔴 只说事实，不编进度条：这里没有真实进度可报，编一个假的比不报更坏。
 */
import { PageSkeleton } from "~/components/console/skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      titleWidth={220}
      note={
        <>
          正在跑排重（core.assertNoSoldDuplicates）：
          <br />· 逐题取题面<b>正本</b>（getQuestion）——
          题数越多越慢，一本打卡册就是上百次读；
          <br />· 若开了语义轴，还要为整册跑一遍句向量（本地 ONNX），要等几秒。
        </>
      }
      cards={[
        { rows: 2 },
        { title: "硬撞（match_key）", rows: 4 },
        { title: "语义近似（只报不拦）", rows: 3 },
      ]}
    />
  );
}
