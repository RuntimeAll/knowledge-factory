"use client";

/**
 * 册详情 · 网盘那一格的**复制入口**（AI:PRD-009 验收修复 · 2026-08-15）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 🔴🔴 同名异库：这里显示的链接/提取码来自 **punch 库（`举一反三产物/资料库.db`）**
 *      的 `doc.网盘链接` / `doc.提取码`，**不是**本库 SKU 上的网盘指针。
 *      本组件**零写**：只把 server 现算好的字符串摆出来 + 复制。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── 为什么非要有这三个按钮 ──────────────────────────────────────────────────
 *   验收判红：这一格原来只有 `<Tag>{提取码}</Tag>` + 一个「打开」外链，
 *   **链接与提取码都只能靠手选文本** —— 而 v1（punch-console/app.py:299-306）
 *   与 v2（web/src/app/book/[id]/page.tsx:126-163）**两代都给了复制按钮**，
 *   v2 的代码注释原话：「网盘链接与提取码是最常复制的两处……手机上手选一串长 URL
 *   极难对准，必须给按钮」。「/shelf 与 punch-console 功能对照零缺项」这条判据
 *   （设计稿 §五·3）在这一格上是实打实的缺项。
 *
 * 🔴 分享语**现拼**（core 之外的纯函数 `netdiskShareText`），不依赖 material：
 *    实测 28 本有链接的册子里有 4 本没有任何在用物料的分享语，
 *    只读 material 的话那 4 本整页仍然零复制入口。
 */
import { Tag, Tooltip, Typography } from "antd";

import { netdiskShareText } from "../../shared";

export function NetdiskCopy({
  name,
  link,
  code,
}: {
  /** 册名（拼分享语时会去掉 `2.10 ` 这种管线序号前缀） */
  name: string;
  link: string | null;
  code: string | null;
}) {
  if (!link) {
    return (
      <Tooltip title="doc.网盘链接 是空的 —— 账上没记网盘（不代表一定没传过；唯一指引在 网盘分发记录/分享链接总表.md）">
        <span style={{ color: "#909399" }}>没记</span>
      </Tooltip>
    );
  }

  const 三行 = netdiskShareText(name, link, code);

  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
      }}
    >
      {/* ① 链接：整串太长，屏幕上只留一个可点的「打开」+ 一个复制 */}
      <a href={link} target="_blank" rel="noreferrer">
        打开
      </a>
      <Typography.Text
        copyable={{ text: link, tooltips: ["复制网盘链接", "已复制"] }}
        style={{ fontSize: 12.5 }}
      >
        链接
      </Typography.Text>

      {/* ② 提取码：本身就短，直接摆出来并让它自己可复制 */}
      {code ? (
        <Typography.Text
          copyable={{ text: code, tooltips: ["复制提取码", "已复制"] }}
          style={{ fontSize: 12.5 }}
        >
          <Tag
            color="green"
            style={{ marginInlineEnd: 4, fontFamily: "Consolas, monospace" }}
          >
            {code}
          </Tag>
        </Typography.Text>
      ) : (
        <Tooltip title="doc.提取码 是空的：链接可能是免提取码的分享，也可能是账上漏记了">
          <Tag>没记提取码</Tag>
        </Tooltip>
      )}

      {/* ③ 三行分享语：发出去的时候本来就是这三行一起发 */}
      {三行 ? (
        <Tooltip
          title={
            <span style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{三行}</span>
          }
        >
          <Typography.Text
            copyable={{
              text: 三行,
              tooltips: ["复制三行（文件名 / 链接 / 提取码）", "已复制"],
            }}
            style={{ fontSize: 12.5 }}
          >
            三行分享语
          </Typography.Text>
        </Tooltip>
      ) : null}
    </span>
  );
}

export default NetdiskCopy;
