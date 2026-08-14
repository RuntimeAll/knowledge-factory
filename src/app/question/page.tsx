/**
 * 题库管理 · 题目管理（AI:PRD-008 · 地基 · 设计稿 §二·2）
 *
 * 🔴 这是题库的**唯一入口**（2026-08-14 起）：004-C 的 `/search` 与 `/q/[id]`
 *    已经下线 —— 设计稿 §一 写的是「/search → /question」「/q/[id] → /question/[id]」，
 *    留着旧页 = 新版式页把人导进旧版式页（那两页还用着 D1 作废的「学术纸感」kit）。
 *    旧地址上的三件事都在这条线上有落点：
 *      · 找相似   → 本页操作列的「相似题」弹层（?similar=q_… 也直接开）
 *      · 按考点看 → `?kp=kp_…`（带考点名回显，不用再去搜一遍）
 *      · 看一道题 → `/question/<id>`（四 tab）
 * 🔴 页面本身只做两件事：把 core 的四张枚举表（题型/状态/判档/来源）取出来传给表格；
 *    把地址栏带来的初值（batch / kp / similar）解析好。
 *    枚举**不许在前端抄第二份**：抄出来的那份迟早跟契约漂。
 */
import { PageHead } from "~/components/console/page-head";
import {
  DEFAULT_STATUSES,
  PROV_TYPES,
  QTYPES,
  QUESTION_STATUSES,
  SOLUTION_GRADES,
  kpContext,
} from "~/core";
import type { KpOption } from "./shared";
import { QuestionTable } from "./table";

export const dynamic = "force-dynamic";

function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function QuestionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const batch = one(sp, "batch");
  const kpId = one(sp, "kp");
  const similar = one(sp, "similar");

  // 考点初值要带名字进去：下拉的候选是远程搜出来的，只给 id 会显示成一串 ULID
  let initialKp: KpOption | undefined;
  if (kpId) {
    try {
      const card = await kpContext(kpId);
      initialKp = {
        value: card.kp.id,
        label: card.kp.name,
        confidence: 1,
        via: "url",
      };
    } catch {
      // 🔴 考点读不出来（id 写错/已合并）就不塞初值：宁可不筛，也不筛一个查无此考点的 id
      initialKp = undefined;
    }
  }

  return (
    <>
      <PageHead
        title={<>题目管理</>}
        sub={<>找题、盘题 —— 不管改题（录入线的事）、不管组卷（生产域）</>}
        source={
          <>
            core.searchQuestions（与 MCP search_questions 同一入口）· 表
            question / question_kp / question_fts / question_vec
          </>
        }
      />

      <QuestionTable
        qtypes={QTYPES}
        statuses={QUESTION_STATUSES}
        grades={SOLUTION_GRADES}
        provTypes={PROV_TYPES}
        defaultStatuses={DEFAULT_STATUSES}
        initialBatch={batch || undefined}
        initialKp={initialKp}
        initialSimilar={similar || undefined}
      />
    </>
  );
}
