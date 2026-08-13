# knowledge-factory（AI:PRD-026 资料域产品线）

## 🔴 新 clone / 换机的一次性准备

```powershell
pnpm install
copy .env.example .env          # 再按注释把本机路径填对
powershell -File scriptsetch-embed-model.ps1   # 拉本地句向量模型（~95MB）
```

第三步是**必须的**：语义检索用的 `bge-small-zh-v1.5` ONNX 模型落在 `models/`，
**整目录 gitignore**（95MB 二进制不进仓库）。没有它 `embedTexts()` 会抛
`MODEL_MISSING` 并把这条命令打在脸上。脚本走 **ModelScope 直连**（本机 HF 大文件
经代理会被掐），每个文件按 Sha256 校验，已经对得上的跳过 —— 可以随便重跑。

自检：

```powershell
pnpm test                                   # 单测全量
powershell -File scriptsegression.ps1     # 全量回归（8 关）
```

分词词典 `dicts/math-terms.dict.txt` **在 git 里**（人可读、带出处注释）。
🔴 **改了它必须重派生存量**，否则新词只对新题生效：
`pnpm exec tsx --env-file=.env scriptsesegment-nodejieba-20260813.ts --commit`

---

# Create T3 App

This is a [T3 Stack](https://create.t3.gg/) project bootstrapped with `create-t3-app`.

## What's next? How do I make an app with this?

We try to keep this project as simple as possible, so you can start with just the scaffolding we set up for you, and add additional things later when they become necessary.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Drizzle](https://orm.drizzle.team)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

## How do I deploy this?

Follow our deployment guides for [Vercel](https://create.t3.gg/en/deployment/vercel), [Netlify](https://create.t3.gg/en/deployment/netlify) and [Docker](https://create.t3.gg/en/deployment/docker) for more information.
