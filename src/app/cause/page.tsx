/**
 * 学情中心 · 错因管理（AI:PRD-008 · P2 · 设计稿 §二·13）
 *
 * 职责：错因实体与映射的台账 + **unmapped 红旗工作队列**。
 * **不管**：建/退役错因实体、挂诊断例题（数据生产类的写，走 agent/MCP）。
 *
 * 🔴 这一页只取数：三块数据一次算完（口径才对得上），画表在 `panels.tsx`（client），
 *    写在 `actions.ts` 的三个 server action 上，且**都要走确认页按第二次**。
 * 🔴 err_code_map 的全量行没有专门的 core 列表函数：这里用
 *    listCauses → getCause(每个错因) 拼出来（都是只读）。错因数是个位数量级，
 *    本地 SQLite 一次几毫秒；真长到几百条时该在 core 补一个 listErrCodeMaps。
 */
import { Alert } from "antd";

import { PageHead } from "~/components/console/page-head";
import { causeDistribution, getCause, listCauses } from "~/core";
import { param } from "../kg/shared";
import { CausePanels } from "./panels";
import type { CauseEntityRow, ErrCodeMapRow, UnmappedRow } from "./shared";

export const dynamic = "force-dynamic";

export default async function CausePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ok = param(sp, "ok");
  const err = param(sp, "err");

  const 头 = (
    <PageHead
      title={<>错因管理</>}
      sub={
        <>
          错因实体 + (考点,码) 映射台账 + unmapped 红旗队列 ——
          补映射是页面上的写，其余只读
        </>
      }
      source={
        <>
          表 error_cause / err_code_map(kp_id, err_code) / kp_error /
          cause_example · core.listCauses / getCause / causeDistribution（挂桥
          现算自圣域 mode=ro）
        </>
      }
    />
  );

  let causes: CauseEntityRow[];
  let maps: ErrCodeMapRow[];
  let dist: Awaited<ReturnType<typeof causeDistribution>>;
  try {
    const briefs = await listCauses({ limit: 500 });
    const cards = await Promise.all(
      briefs.map((b) => getCause(b.causeId).then((c) => [b, c] as const)),
    );
    causes = briefs.map((b) => ({
      causeId: b.causeId,
      name: b.name,
      desc: b.desc,
      seedCode: b.seedCode,
      status: b.status,
      kps: b.counts.kps,
      examples: b.counts.examples,
      errCodes: b.counts.errCodes,
    }));
    maps = cards
      .flatMap(([b, c]) =>
        c.errCodes.map((m) => ({
          kpId: m.kpId,
          kpName: m.kpName,
          errCode: m.errCode,
          causeId: b.causeId,
          causeName: b.name,
          causeStatus: b.status,
          causeSeedCode: b.seedCode,
          causeDesc: b.desc,
          mappedBy: m.mappedBy,
          mappedAt: m.mappedAt,
        })),
      )
      .sort(
        (a, b) =>
          a.kpName.localeCompare(b.kpName) ||
          a.errCode.localeCompare(b.errCode),
      );
    dist = await causeDistribution();
  } catch (e) {
    return (
      <>
        {头}
        <Alert
          type="error"
          showIcon
          message="错因台账读不出来（原文照登）"
          description={
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, margin: 0 }}>
              {e instanceof Error ? `${e.name}: ${e.message}` : String(e)}
            </pre>
          }
        />
      </>
    );
  }

  const unmapped: UnmappedRow[] = dist.unmapped.map((u) => ({
    kpId: u.kpId,
    kpName: u.kpName,
    errCode: u.errCode,
    count: u.count,
    samples: u.sample.map((s) => `b${s.batchId}·q${s.qno}`),
  }));

  return (
    <>
      {头}
      <CausePanels
        causes={causes}
        maps={maps}
        unmapped={unmapped}
        coverage={{
          matched: dist.coverage.matched,
          total: dist.coverage.total,
          rate: dist.coverage.rate,
        }}
        sampleCodes={dist.sampleCodes}
        rubric={[...dist.rubric]}
        warnings={dist.warnings}
        ok={ok || undefined}
        err={err || undefined}
      />
    </>
  );
}
