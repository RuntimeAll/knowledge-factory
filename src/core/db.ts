/**
 * core/db.ts —— 连接工厂（AI:PRD-001 · WP3）
 *
 * 🔴 这是全仓唯一开库的地方。app / mcp / scripts 一律不许自己 createClient，
 *    ESLint no-restricted-imports 已把 `@libsql/client` / `drizzle-orm` 对 app 层封死。
 *
 * 三件必须由本文件保证的事：
 *   ① 外键真的开着 —— libsql 的 `PRAGMA foreign_keys` 是 **每连接** 生效，默认 OFF；
 *   ② 撞锁不立刻炸 —— busy_timeout=5000ms；
 *   ③ 写操作串行 —— SQLite 单写者，进程内再加一道队列（理由见下面 §连接漂移）。
 *
 * 🔴 §连接漂移（读 @libsql/client@0.17.4 源码得来的事实，别凭直觉改）：
 *    `Sqlite3Client.transaction()` 拿到当前连接 BEGIN 之后，会把 `#db = null`
 *    ——「下次用的时候再懒建一条新连接」。也就是说：
 *      - 事务期间用 `client.execute()` 会打到 **另一条连接** 上（看不见事务内的写、
 *        还可能撞锁）⇒ 事务里的一切必须走回调拿到的 tx；
 *      - 一旦开过事务，之前设在老连接上的 `PRAGMA foreign_keys=ON` 就随老连接走了，
 *        新连接是默认 OFF ⇒ 外键必须在 **每次开事务前** 重新武装（armConnection）。
 *    而 `PRAGMA foreign_keys` 在事务内是 no-op（SQLite 规定），所以只能「先 PRAGMA 再 BEGIN」，
 *    这两步之间不能被别的写插进来 —— 这就是 serialize() 存在的第二个理由。
 *    busy_timeout 不受此影响：它是 createClient({timeout}) 的开库参数，
 *    libsql 对「包括 transaction() 之后内部新建的连接」都会带上（见 @libsql/core api.d.ts）。
 *
 * 🔴 本文件刻意不 import `~/env`：core 要能在纯 node 下跑（vitest / tsx 脚本 / MCP 进程），
 *    而 `~/env` 是 @t3-oss/env-nextjs 的 Next 侧校验，import 即执行。
 *    这里只在真正要连库时惰性读 process.env.DATABASE_URL，读不到给一句人话报错。
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import * as schema from "~/server/db/schema";

/** 撞锁重试窗口（ms）；开库参数，对客户端此后新建的每条连接都生效 */
export const BUSY_TIMEOUT_MS = 5000;

export type CoreDb = LibSQLDatabase<typeof schema>;

/** 事务句柄：业务写只认它（🔴 事务里绝不能用 handle.client，见 §连接漂移） */
export type CoreTx = Parameters<Parameters<CoreDb["transaction"]>[0]>[0];

export interface CoreDbHandle {
  /** 连接串（file:...） */
  readonly url: string;
  /** 裸客户端：只给 core 内部做 PRAGMA / sqlite_master 这类元操作 */
  readonly client: Client;
  /** drizzle 实例 */
  readonly db: CoreDb;
  /** 进程内写队列：串行化「武装连接 → 开事务 → 提交」这个不可分割的序列 */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

/**
 * 给「当前连接」重新装上 PRAGMA。
 * 🔴 必须在每次开事务前调一次 —— 事务会换连接，外键设置不跟着走。
 */
export async function armConnection(handle: CoreDbHandle): Promise<void> {
  await handle.client.execute("PRAGMA foreign_keys=ON");
  await handle.client.execute(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
}

/**
 * 建一个连接句柄。测试 / 脚本要连副本库时直接调它（传 VACUUM INTO 出来的那份）。
 * 常规业务走 getCoreDb() 单例。
 */
export async function createCoreDb(url: string): Promise<CoreDbHandle> {
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS });
  const db = drizzle(client, { schema });

  // 队列尾：永远是一个已「吞掉异常」的 promise，前一笔写失败不会毒死后一笔
  let tail: Promise<unknown> = Promise.resolve();

  const handle: CoreDbHandle = {
    url,
    client,
    db,
    serialize<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close() {
      client.close();
    },
  };

  // 顺带也是一次「库连得上吗」的探测：连不上这里就抛
  await armConnection(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let singleton: Promise<CoreDbHandle> | null = null;

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL 没设：core 连不上库。Next 侧由 .env 自动注入；" +
        "跑脚本/测试请显式 createCoreDb('file:./data/资料库.db') 或先设好环境变量。",
    );
  }
  return url;
}

/** 进程内单例句柄（HMR 下也只有一条连接：Next dev 每次热更新不重开库） */
export function getCoreDb(): Promise<CoreDbHandle> {
  singleton ??= createCoreDb(resolveDatabaseUrl());
  return singleton;
}

/** 关掉单例（脚本收尾 / 测试隔离用）；下次 getCoreDb() 会重开 */
export async function closeCoreDb(): Promise<void> {
  if (!singleton) return;
  const handle = await singleton;
  singleton = null;
  handle.close();
}
