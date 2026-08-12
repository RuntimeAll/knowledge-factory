/**
 * `node:sqlite` 最小类型垫片（AI:PRD-001 · WP4）
 *
 * 为什么要手写这份：@types/node 钉在 20.19.43，那一版还没有 `node:sqlite` 的类型
 * （22.x 才带）。而圣域只读连接**必须**用 node:sqlite —— 理由见 core/grading.ts 文件头：
 * 只有它能真的以 SQLITE_OPEN_READONLY 打开文件（`readOnly: true`），
 * @libsql/client 做不到（它连 `?mode=ro` 这个查询参数都会直接抛 URL_PARAM_NOT_SUPPORTED）。
 *
 * 🔴 只声明我们真正用到的那几个成员，不做完整移植 —— 这不是 DefinitelyTyped 的替代品。
 * 🔴 将来 @types/node 升到 22+ 自带这套类型时，**删掉本文件**（否则重复声明会打架）。
 */
declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    /** 构造时就打开（默认 true） */
    open?: boolean;
    /** 🔴 以 SQLITE_OPEN_READONLY 打开：任何写入被 SQLite 自己按下（"attempt to write a readonly database"） */
    readOnly?: boolean;
    /** 打开后是否执行 PRAGMA foreign_keys=ON（默认 true；只读连接上也是无害的只读 PRAGMA） */
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }

  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    close(): void;
    prepare(sql: string): StatementSync;
  }
}
