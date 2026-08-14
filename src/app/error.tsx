"use client";

/**
 * 全站错误边界（AI:PRD-009 · 打磨检查单 ②「API 失败 Alert 上墙带原文，绝不吞」）
 *
 * 🔴 为什么必须有这一个文件：页面里逐个 `safe()` 包住的读能自己上墙报错，
 *    但**没包住的那一个**（或壳自己抛的）会直接掀掉整棵树 —— Next 默认错误页
 *    是一块与本站毫无关系的白板，连侧栏都没有，人只会以为"整个站挂了"。
 *    这一层把它接住：壳还在，错误原文照登，旁边给一个重试。
 *
 * 🔴 原文照登，不改写、不安慰：`error.message` 是排查的全部线索。
 *    生产构建下 Next 会把 server component 的报错正文抹成一句通用话 + digest，
 *    所以 digest 也必须显示 —— 那是去终端日志里对号的唯一钥匙。
 * 🔴 `reset()` 只是重渲染这一段，不是"修好了"：按钮文案写清楚它做什么
 *    （检查单 ⑨：按钮说清点下去发生什么）。
 */
import { Alert, Button, Space } from "antd";
import Link from "next/link";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 12px" }}>
        这一页没画出来
      </h1>
      <Alert
        type="error"
        showIcon
        message="页面渲染时抛了异常（原文照登）"
        description={
          <div style={{ fontSize: 12.5 }}>
            <div
              style={{
                fontFamily: "Consolas, Menlo, monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {error.name}: {error.message}
            </div>
            {error.digest ? (
              <div style={{ marginTop: 6, color: "#606266" }}>
                digest <code>{error.digest}</code> —— 生产构建下正文会被 Next
                抹掉，拿这串去跑 dev 的终端日志里对号。
              </div>
            ) : null}
            <div style={{ marginTop: 8, color: "#606266" }}>
              🔴
              最常见的两种：库文件不在位（data/资料库.db）、或某个只读函数撞到了
              脏数据。都不是「点一下就能好」的事 —— 重试没用就去看终端。
            </div>
          </div>
        }
      />
      <Space style={{ marginTop: 12 }}>
        <Button onClick={reset}>重新渲染这一页（不改库，只再试一次读）</Button>
        <Link href="/">
          <Button type="link">回工作台</Button>
        </Link>
      </Space>
    </div>
  );
}
