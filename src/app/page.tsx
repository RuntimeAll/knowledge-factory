/**
 * 首页 = 系统底座状态页（AI:PRD-001 · WP6）
 *
 * 三张卡：库体检 / 对账 / 备份 —— 「地基还在不在」的一屏答案。
 * 🔴 本卡只做状态展示，没有任何按钮能改库：写操作一律走 core（MCP / 脚本）。
 *
 * 全部 server component + 现算：本地 SQLite 毫秒级，不上任何 client 状态管理，
 * 也不做缓存（缓存过的「健康」是最没用的健康）。
 * force-dynamic 的理由见 layout.tsx 文件头。
 */
import {
  getLatestIntegritySummary,
  health,
  listBackups,
  type BackupSnapshotInfo,
  type HealthReport,
  type IntegritySummary,
} from "~/core";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 版式小件（设计稿 .panel / .st / .kpi 的 React 版，只在本页用）
// ---------------------------------------------------------------------------

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-hair bg-sheet rounded-[3px] border px-[18px] py-[15px]">
      <h3 className="panel-title text-mut mb-2.5 text-[12px] font-semibold tracking-[1.5px]">
        {title}
      </h3>
      {children}
    </section>
  );
}

const CHIP = {
  g: "text-acc-deep bg-acc-soft border-acc/30",
  a: "text-amber bg-amber-soft border-amber/30",
  r: "text-pen bg-pen-soft border-pen/30",
  n: "text-mut bg-code border-hair",
} as const;

function Chip({
  tone = "n",
  children,
}: {
  tone?: keyof typeof CHIP;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`mr-1.5 inline-block rounded-[2px] border px-[7px] text-[11px] leading-[1.6] ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="border-hair flex items-baseline gap-3 border-b py-[5px] last:border-b-0">
      <span className="text-mut w-[92px] shrink-0 text-[11.5px] tracking-[0.5px]">
        {k}
      </span>
      <span className="min-w-0 flex-1 break-all">{v}</span>
    </div>
  );
}

function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 读不动就把错误如实端出来（本地工具页，藏错误没有任何好处） */
async function safe<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn();
  } catch (e) {
    return String(e);
  }
}

function Broken({ what, err }: { what: string; err: string }) {
  return (
    <div className="text-pen text-[12.5px]">
      {what}读不出来：<span className="break-all">{err}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 三张卡
// ---------------------------------------------------------------------------

function HealthCard({ r }: { r: HealthReport | string }) {
  if (typeof r === "string") {
    return (
      <Panel title="库体检">
        <Broken what="体检" err={r} />
      </Panel>
    );
  }
  return (
    <Panel title="库体检">
      <div className="mb-2">
        {r.ok ? (
          <Chip tone="g">库活着 · 闸静息</Chip>
        ) : (
          <Chip tone="r">不健康</Chip>
        )}
        <span className="text-mut text-[11.5px]">{r.checkedAt}</span>
      </div>
      <Row
        k="表数"
        v={
          <>
            <span className="num text-[16px]">{r.tableCount}</span>
            <span className="text-mut ml-2 text-[11.5px]">
              张（WP2 基线 41）
            </span>
          </>
        }
      />
      <Row
        k="审计链尾"
        v={
          <>
            <span className="num">seq {r.auditHeadSeq ?? "—（空链）"}</span>
            <span className="text-mut ml-2 font-mono text-[11px]">
              next prev_hash {r.auditNextPrevHash.slice(0, 16)}…
            </span>
          </>
        }
      />
      <Row
        k="写闸"
        v={
          r.gateResting ? (
            <Chip tone="g">静息 allowed=0</Chip>
          ) : (
            <Chip tone="r">allowed={r.writeGate} · 闸没关！</Chip>
          )
        }
      />
      <Row
        k="journal"
        v={
          <span className="text-[12.5px]">
            {r.journalMode} · 外键 {r.foreignKeys ? "ON" : "OFF"} · busy_timeout{" "}
            {r.busyTimeoutMs}ms
          </span>
        }
      />
      <Row
        k="库"
        v={<span className="font-mono text-[11.5px]">{r.url}</span>}
      />
    </Panel>
  );
}

function IntegrityCard({ s }: { s: IntegritySummary | null | string }) {
  if (typeof s === "string") {
    return (
      <Panel title="对账">
        <Broken what="对账摘要" err={s} />
      </Panel>
    );
  }
  if (!s) {
    return (
      <Panel title="对账">
        <div className="text-mut text-[12.5px]">
          还没跑过对账。跑一次：
          <div className="bg-code mt-1.5 rounded-[2px] p-2 font-mono text-[11.5px]">
            pnpm exec tsx --env-file=.env scripts/integrity-check.ts
          </div>
          <div className="mt-1.5">或调 MCP 工具 integrity_check。</div>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="对账">
      <div className="mb-2">
        {s.ok ? (
          <Chip tone="g">全绿 · 无红旗</Chip>
        ) : (
          <Chip tone="r">红旗 {s.red.length} 项</Chip>
        )}
        {s.warn.length > 0 ? <Chip tone="a">warn {s.warn.length}</Chip> : null}
        <span className="text-mut text-[11.5px]">{s.ts ?? "时间未知"}</span>
      </div>
      {/* 🔴 没有对账详情页可跳（那是后面的卡），所以逐项就地展开 */}
      {s.items.length > 0 ? (
        <ul className="space-y-1 text-[12.5px]">
          {s.items.map((it) => (
            <li key={it.id} className="flex items-baseline gap-2">
              <span className="num text-mut w-[22px] shrink-0">{it.id}</span>
              {it.ok ? (
                <Chip tone="g">ok</Chip>
              ) : it.level === "red" ? (
                <Chip tone="r">red</Chip>
              ) : (
                <Chip tone="a">warn</Chip>
              )}
              {/* 🔴 break-words 少不得：check 名里带 question_kp/node_kp_map/…
                  这种长 ASCII 串，不给断词点就会整条撑破面板 */}
              <span className="min-w-0 flex-1 break-words">{it.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-mut text-[12.5px]">
          这条摘要是 WP6 之前的老口径（没有逐项明细）： 红{" "}
          {s.red.join("、") || "无"} · warn {s.warn.join("、") || "无"}
          。重跑一次对账即可看到六项全名。
        </div>
      )}
    </Panel>
  );
}

function BackupCard({ list }: { list: BackupSnapshotInfo[] | string }) {
  if (typeof list === "string") {
    return (
      <Panel title="备份">
        <Broken what="快照目录" err={list} />
      </Panel>
    );
  }
  if (list.length === 0) {
    return (
      <Panel title="备份">
        <div className="text-mut text-[12.5px]">
          <Chip tone="r">一份快照都没有</Chip>
          <div className="bg-code mt-1.5 rounded-[2px] p-2 font-mono text-[11.5px]">
            pnpm exec tsx --env-file=.env scripts/backup.ts
          </div>
        </div>
      </Panel>
    );
  }
  const [latest, ...rest] = list;
  return (
    <Panel title="备份">
      <div className="mb-2">
        <Chip tone="g">最近快照</Chip>
        <span className="num text-[12.5px]">{latest!.mtime}</span>
      </div>
      <div className="font-mono text-[11.5px] break-all">{latest!.file}</div>
      <div className="text-mut mt-1 text-[12px]">
        {bytesText(latest!.bytes)} · reason={latest!.reason}
      </div>
      {rest.length > 0 ? (
        <table className="mt-2.5 w-full text-[11.5px]">
          <tbody>
            {rest.map((b) => (
              <tr key={b.path} className="border-hair border-t">
                <td className="text-mut num py-1 pr-2 whitespace-nowrap">
                  {b.mtime}
                </td>
                <td className="text-mut py-1 text-right whitespace-nowrap">
                  {bytesText(b.bytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export default async function HomePage() {
  const [h, s, b] = await Promise.all([
    safe(() => health()),
    safe(() => getLatestIntegritySummary()),
    // 5 份足够看出「今天有没有、隔多久打一次」，再多就是翻目录的事
    safe(() => listBackups({ limit: 5 })),
  ]);

  return (
    <>
      <h1 className="font-serif text-[23px] font-bold tracking-[1px]">
        系统底座
      </h1>
      <div className="text-mut mt-[3px] mb-5 text-[12.5px]">
        库还在不在 · 数据自不自洽 · 丢了能不能捞回来
      </div>

      <div className="grid gap-3.5 lg:grid-cols-3">
        <HealthCard r={h} />
        <IntegrityCard s={s} />
        <BackupCard list={b} />
      </div>

      <hr className="rule-double my-5 border-0" />
      <div className="text-mut text-[12px] leading-[1.9]">
        本页只读、现算，没有缓存。要动库请走 MCP 工具或 scripts/ —— 页面壳与
        agent 共用同一个 core，绕过去就没有审计行。
      </div>
    </>
  );
}
