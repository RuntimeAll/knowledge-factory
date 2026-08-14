/**
 * 系统监控 · 审计日志（AI:PRD-008 · P3 · 设计稿 §二·15）
 *
 * 职责：谁在什么时候动了库。顶部横幅=链校验状态，下面=seq 倒序列表。**只读**。
 *
 * 🔴 横幅是**现跑的整链重算**（core.verifyAuditChain），不是"最近一次的结果"：
 *    - 它纯只读（scripts/audit-verify.ts 文件头原话：一个字节都不往库里写），
 *      不像对账那样要连圣域、扫 assets、收尾还 logMetric；
 *    - 当下 547 行，从创世行重算一遍是毫秒级的事；
 *    - 而「链好不好」这个问题**缓存过就没有意义了**——你要知道的正是此刻。
 *    行数真的涨到重算变慢那天，再改成读最近一次结果（那时横幅上要写明是哪一刻的）。
 * 🔴 页面没有任何写按钮。audit_log 是 append-only：库里两只无条件 RAISE 的触发器
 *    连 core 自己都改不动这张表，页面更不该给一个假装能改的入口。
 */
import { Alert } from "antd";

import { PageHead } from "~/components/console/page-head";
import { CopyCmd } from "~/components/console/ui";
import { verifyAuditChain } from "~/core";
import { AuditTable } from "./table";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  let banner: React.ReactNode;
  try {
    const r = await verifyAuditChain();
    banner = r.ok ? (
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            审计链完好：从创世行起逐行重算，校验 <b>{r.checkedRows}</b> 行，
            链尾 seq <b>{r.headSeq ?? "（空链）"}</b> ——
            本次打开页面时现算，不是缓存
          </span>
        }
        description={
          <span
            style={{
              fontSize: 11.5,
              color: "#606266",
              fontFamily: "Consolas, Menlo, monospace",
              wordBreak: "break-all",
            }}
          >
            下一行应携带的 prev_hash：{r.nextPrevHash}
          </span>
        }
      />
    ) : (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span style={{ fontSize: 12.5 }}>
            🔴 审计链断了：seq <b>{r.brokenAtSeq}</b> 对不上（已校验{" "}
            {r.checkedRows} 行）
          </span>
        }
        description={
          <span style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
            {r.reason ?? ""}
            {"\n"}
            断链只有两种成因：有人绕过 core 改了库文件，或者库被重建过。
            先别写任何东西，去比对 data/backup/ 里的快照。
          </span>
        }
      />
    );
  } catch (e) {
    banner = (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message="链校验没跑成（原文照登）"
        description={
          <span style={{ fontSize: 12.5 }}>
            {e instanceof Error ? `${e.name}: ${e.message}` : String(e)}
          </span>
        }
      />
    );
  }

  return (
    <>
      <PageHead
        title="审计日志"
        sub="谁在什么时候动了库 —— 只读，页面永不长出写入口"
        source="core.verifyAuditChain（横幅 · 现跑整链重算）/ core.listAuditRows（列表）· 表 audit_log（kb-audit/v1 哈希链）"
      />

      {banner}

      <div style={{ marginBottom: 10 }}>
        <CopyCmd
          label="命令行同款校验（退出码 0=完好）"
          cmd="pnpm exec tsx --env-file=.env scripts/audit-verify.ts"
        />
      </div>

      <AuditTable />
    </>
  );
}
