import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * 脚手架自检：这不是业务测试，是「锁版口径」的机器闸。
 * 依赖版本被谁不小心改回去时，这里先红。
 */
describe("脚手架口径", () => {
  it("zod 必须是真 v4（顶层 format API 存在，不是 v3 的 z.string().url()）", () => {
    // z.url() / z.email() 这批顶层校验器是 zod v4 才有的；v3 只有 z.string().url()
    expect(typeof z.url).toBe("function");
    expect(typeof z.email).toBe("function");
    expect(z.email().safeParse("a@b.com").success).toBe(true);
    expect(z.email().safeParse("nope").success).toBe(false);
  });

  it("zod v4 的 error 定制走 `error` 而非 v3 的 message/invalid_type_error", () => {
    const schema = z.string({ error: "必须是字符串" });
    const r = schema.safeParse(123);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("必须是字符串");
  });
});
