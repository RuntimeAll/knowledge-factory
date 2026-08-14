/**
 * 资料货架 · 货架题目（AI:PRD-009 验收修复 · `/shelf/questions`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：本页读 **punch 库 `举一反三产物/资料库.db`** 的 `question`
 *      （3230 题 / 15 本册子），**不是**本库的 `data/资料库.db`（那边的题在 /question）。
 *      两个文件同名、schema 完全不同、**数据零交集**（同一口径 hash 实测交集为 0）。
 * 🔴🔴 全程 mode=ro、**零写**；两库绝不互写。本页没有任何能改字的控件。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 为什么补这一页 ──────────────────────────────────────────────────────────
 *   验收判红：punch 库那 3230 道题在货架上**一道都看不到** —— 货架只到
 *   「按 section×题型 数个数」为止，core 对 punch 的 question 表也只有 COUNT。
 *   而 punch-console v2 有整张 `/questions`（关键词 + 考点/题型/册 筛选、
 *   考点覆盖条、逐题题面/实算/第几天·section·seq），册详情页还能一键跳过去。
 *   设计稿 §五·3 的判据是「/shelf 与 punch-console 功能对照**零缺项**（浏览面）」。
 *
 * 🔴 与 v2 的**唯一差别**（写在脸上，不假装）：v2 是三路检索（FTS + 考点 + 语意向量），
 *    这里只有两路 —— punch 的 `向量` 是 v2 自己那套 sidecar 模型算的，
 *    本产品用另一套 ONNX 句向量，**两边不同源**，拿本库的模型去查它的向量是错的。
 *    要补语意轴得先把两边的 embedding 口径对齐，那是数据迁移的事（待用户拍板）。
 */
import { Alert } from "antd";
import Link from "next/link";

import { PageHead } from "~/components/console/page-head";
import { ShelfQuestionTable } from "./table";

export const dynamic = "force-dynamic";

/** 地址栏取一个值（数组/缺失都当没给） */
function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export default async function ShelfQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const doc = one(sp, "doc");
  const kp = one(sp, "kp");

  return (
    <>
      <PageHead
        title={<>货架题目</>}
        sub={<>punch 库那 3230 道题 —— 只看不改</>}
        source={
          <>
            core.listPunchQuestions · <b>punch 库</b>
            （举一反三产物/资料库.db，mode=ro）表 question / question_fts / doc
            —— 🔴 同名异库，不是本库的 data/资料库.db
          </>
        }
      />

      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          marginBottom: 12,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <Link href="/shelf">← 回资料货架</Link>
        <Link href="/shelf/reconcile">两库对账</Link>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            🔴 这一页的题是 <b>punch 库的题</b>，与本库题库（
            <Link href="/question">题目列表</Link>）<b>零交集</b>
            ：实测两边按同一口径算 hash，3230 题 × 642 题 交集为 0。 所以这里
            <b>一个跳本库题详情的链接都没有</b> —— 指过去就是指到另一本账上。
          </span>
        }
        description={
          <span style={{ fontSize: 12, color: "#606266" }}>
            检索只有两路：<b>关键词</b>（punch 自己那套 bigram 分词的 FTS5，
            索引落后时自动退成 LIKE 并如实说一声）+ <b>考点/题型/册</b> 硬过滤。
            <b>语意轴没有搬过来</b>：punch 的向量是产线那套模型算的，
            与本产品的句向量不同源，拿这边的模型去查它的向量是错的。
          </span>
        }
      />

      <ShelfQuestionTable
        {...(doc ? { defaultDoc: doc } : {})}
        {...(kp ? { defaultKp: kp } : {})}
      />
    </>
  );
}
