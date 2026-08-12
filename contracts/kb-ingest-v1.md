# kb-ingest/v1 —— 录题管道契约（终稿）

> 立于 2026-08-12（AI:PRD-003 · 003-C）。
> 🔴 **机读正本 = [`src/core/ingest-schema.ts`](../src/core/ingest-schema.ts)（zod）**，本文是它的人读面。
> 两份同步改：这边加一行 = 那边加一个字段。
> 🔴 punch-ingest/v1 的**超集**：所有它能表达的，这边都表达得了；它表达不了的（解析、题级配图、
> 来源四型、真查重、真实算），这边补齐并且**真的拦**。

---

## 0. 一句话

一次 `runIngestBatch(payload)` = 一个 `ingest_batch` = 一批题过十道硬闸后落库，
**页页有账**（每题每闸的结论都留在 `ingest_batch.gate_report_json` 里），
坏题进 `quarantine`（带原样 payload），好题进 `question`。

与 punch-ingest/v1 最根本的差别不在字段，在**态度**：
那边认不出的契约 `console.log` 跳过、stem 只 `trim()`、`实算` 信产线自报、查重只算 hash 不拦；
这边**坏料一律红灯 + 人话 + 怎么改**，一个字都不静默。

---

## 1. 批级（IngestFile 的对位）

```jsonc
{
  "contract": "kb-ingest/v1",          // 必填，不等即整批拒
  "source": "每日打卡@2026-08-12",      // 必填，喂料方 skill/脚本@版本 → ingest_batch.source
  "sourceDoc": {                        // 可选；prov.type='scan' 时必填
    "title": "七上必刷题",              // 必填
    "kind": "册子",                     // 册子|群卷|试卷|讲义|其他（= source_doc.kind 的 CHECK）
    "path": "D:/…/七上必刷题.pdf",      // 可选
    "hash": "<文件 sha256>",            // 可选；🔴 给了就按它跨批复用同一行 source_doc
    "pages": 216,                       // 可选
    "note": "第三章缺页"                 // 可选
  },
  "items": [ /* 见 §2，至少一条 */ ]
}
```

- 根**只能是对象**（punch 那边允许数组根 = 一次多册；kb 这边一批一个语义单元，多批就多调几次）。
- `payload_hash = sha256(规范化 JSON)` 落 `ingest_batch.payload_hash`，同一份料重喂查得出来。

## 2. 题级

```jsonc
{
  "seq": 1,                              // 必填，批内唯一（红灯定位 + 隔离回溯的坐标）
  "stem": "$3+5\\times 2$",              // 必填
  "answer": "13",                        // answer / analysis 🔴 至少一个
  "analysis": "先乘除后加减…",            // 同上；null 与空串等价（归一成 null）
  "qtype": "计算",                        // 计算|填空|选择|解答|判断|作图|证明|应用|其他
  "difficulty": 3,                        // 1-5
  "kps": [                                // 🔴 至少一个；主考点恰一个
    { "ref": "有理数的乘方", "isPrimary": true },
    { "ref": "kp_01KZV2HDVCM9VCC97V263KPBMN" }
  ],
  "tags": ["易错", "凑整法"],              // 自由标签
  "figures": [                             // 题级配图（punch 无此面）
    { "role": "stem", "path": "D:/…/fig-01.png" },
    { "role": "analysis", "path": "D:/…/fig-01-ans.png" }
  ],
  "prov": { "type": "pipeline", "pipelineRef": "gen_打卡.py@2026-08-10" },
  "editionScope": "浙教",                  // 可选；不填 = 版本通用
  "punchPos": { "day": 1, "section": "有理数混合运算", "seq": 3 }
}
```

### 2.1 `kps[].ref` 两种形态

| 形态 | 例 | 解析规则 |
|---|---|---|
| 考点名/别名 | `"有理数的乘方"` | resolve_kp，🔴 **只认 confidence=1.0 的精确命中**；一名多考点 → 红灯 `AMBIGUOUS_KP` 带候选；无精确命中 → 红灯 `KP_NOT_FOUND` 带最近似候选 |
| kp_id | `"kp_01KZ…"` | 直接查库：必须存在且最终状态 `active`；命中 merged 壳 → 自动追链到落点并记 note |

不显式给 `isPrimary` ⇒ **第一个当主**（并在账上记一笔）。

### 2.2 `prov` 四型必填项

| type | 必填 | 落库列 |
|---|---|---|
| `scan` | 批级 `sourceDoc` + 题级 `page` | `source_doc_id` / `source_page_no` |
| `pipeline` | `pipelineRef` | `pipeline_ref` |
| `model` | `modelId`（且该模型 `status='active'`，查库） | `model_id` |
| `manual` | `createdBy`（🔴 manual 不是无条件逃逸阀） | `created_by` |

### 2.3 `figures[].role` 分级审核

| role | 处置 |
|---|---|
| `stem` | 🔴 该题 `review_required=1`，批后开一张 `review_queue(kind='图片')` 工单 —— 题干图错 = 题目本身错，不抽检 |
| `analysis` | 抽检：只在 `gate_report.items[].sampled` 里记一笔，不建工单 |

图按**内容寻址**入库：`sha256(文件)` → `data/assets/<hash><ext>`，`asset.hash` 上有 UNIQUE ⇒ 同一张图全库一行。

---

## 3. 与 punch-ingest/v1 的字段映射

| punch-ingest/v1 | kb-ingest/v1 | 说明 |
|---|---|---|
| `契约` | `contract` | 值从 `punch-ingest/v1` 换成 `kb-ingest/v1` |
| `册` / `组名` / `册型` / `成员` | —— | ❌ 不收：那是**册子的结构**，属 SKU 域（E 域 `sku`/`sku_item`），不是题的属性 |
| `类型` / `科目` / `年级` | —— | ❌ 不收：题挂考点，考点自带学段与领域（KG 双层的全部意义） |
| `源目录` | `sourceDoc.path` | |
| `交付件` | —— | ❌ 不收：成品 PDF 属 SKU 产出（`sku_output`） |
| `版本[].版本名` / `layout_key` | —— | ❌ 不收：版式是册子的事 |
| `版本[].考点` | `items[].kps` | 🔴 从**册级裸字符串数组**降到**题级 kp_id 解析** |
| `版本[].day_spec` | —— | ❌ 不收（体检口径归产线） |
| `题[].day/section/seq` | `items[].punchPos` | 入库落 `question_tag`：`src:d1-s有理数混合运算-q3` |
| `题[].stem` | `items[].stem` | 🔴 从「只 `trim()`」升到「剥指令词 + 前缀清洗 + 占位红旗 + 机器复核」 |
| `题[].answer` | `items[].answer` | |
| —— | `items[].analysis` | 🆕 **解析通道**（punch 完全没有；专项卷那 10 题只有解析没有独立答案） |
| `题[].考点` | `items[].kps[].ref` | 同上 |
| `题[].题型` | `items[].qtype` | 收敛成字典值 |
| `题[].难度` | `items[].difficulty` | 收敛成 1-5 |
| `题[].来源` | `items[].prov` | 🔴 从**一行自由文本**升到**四型 + 建表 CHECK + 硬闸** |
| `题[].实算` | —— | ❌ **刻意不收**：产线自报的绿不作数，本管道自己用 sympy 侧车算一遍 |
| （算出）`hash_L1` | （算出）`match_key` | 归一口径是它的超集（多剥 HTML + LaTeX 归一），且**撞了红灯**而不是只算不拦 |
| —— | `items[].figures` | 🆕 题级配图 + 分级审核（punch 只有册级宣发图，走目录约定） |
| —— | `items[].editionScope` | 🆕 Q12 版本适用 |

### 3.1 新增能力总表（= 备料 §9 那十条差集的落地）

| # | punch-ingest/v1 | kb-ingest/v1 |
|---|---|---|
| 1 | 只有 answer | ＋`analysis`，且「answer 与 analysis 至少其一」是硬闸 |
| 2 | 无题级图 | ＋`figures` + 内容寻址入 asset + 题干图必审 |
| 3 | 考点是裸字符串，不校验 | resolve_kp 精确命中真叶子，主考点唯一，禁编造 |
| 4 | 来源是自由文本 | provenance 四型 + 建表 CHECK + 逐型硬闸 |
| 5 | `实算` 产线自报 | 管道内 sympy 实算三态，verified 才给 `calc_verified`；**外加逐行恒等**（003-E）：`qtype='计算'` 且有解析的题，解析里每一行都要与原式恒等，断了红灯 `CALC_LINE_MISMATCH` —— 这是产线那个「实算:绿」结构性验不出的一类（答案对、过程错） |
| 6 | 查重只算 hash 不拦 | `match_key` 部分唯一索引 ＋ 撞库/撞批双向红灯（带撞的是哪一行） |
| 7 | 题面纯净零校验 | 指令词闸 ＋ 前缀清洗闸（含机器复核）＋ 占位红旗闸 |
| 8 | 契约不认识就跳过 | 结构错 = 整批拒，带 `z.prettifyError` 的逐字段人话 |
| 9 | 无 schema、无前置校验器 | schema 即文件（本文 + zod），入库前全量校验 |
| 10 | stem 三格式混存无声明 | 归一在管道里做：查重键剥 HTML/LaTeX，检索投影走侧车去 LaTeX + 分词 |

---

## 4. 十道闸（顺序 = gate_report 里的顺序）

| # | 闸 | 红灯 code |
|---|---|---|
| ① | 契约 kb-ingest/v1（批级，结构错整批拒） | `INGEST_CONTRACT_INVALID` |
| ② | 来源 provenance | `PROV_SCAN_NO_SOURCE_DOC` / `PROV_SCAN_NO_PAGE` / `PROV_PIPELINE_NO_REF` / `PROV_MODEL_NO_ID` / `PROV_MODEL_NOT_FOUND` / `PROV_MODEL_NOT_ACTIVE` / `PROV_MANUAL_NO_CREATED_BY` |
| ③ | 考点标全 | `KP_NOT_FOUND` / `AMBIGUOUS_KP` / `KP_ID_NOT_FOUND` / `KP_NOT_ACTIVE` / `KP_DUPLICATE` / `KP_PRIMARY_MULTI` |
| ④ | 题面禁指令词 | `STEM_HAS_META_WORD` / `STEM_EMPTY_AFTER_STRIP` |
| ⑤ | 前缀清洗（含残留机器复核） | `STEM_PREFIX_RESIDUE` / `STEM_EMPTY_AFTER_CLEAN` |
| ⑥ | 占位红旗 | `STEM_EMPTY` / `STEM_PLACEHOLDER` / `FIGURE_DECLARED_BUT_MISSING` |
| ⑦ | 查重 match_key | `DUPLICATE` / `DUPLICATE_IN_BATCH` |
| ⑧ | 可实算即实算（**两个判据**：最终答案 + 过程逐行恒等） | `CALC_MISMATCH` / `CALC_LINE_MISMATCH` |
| ⑨ | 判档 solution_grade | `NO_SOLUTION`（防御） |
| ⑩ | 配图分级 | `FIGURE_FILE_MISSING` / `FIGURE_UNREADABLE` / `FIGURE_NOT_A_FILE` |

失败 shape 与全仓「错误契约」一致：`{ ok:false, code, message, recoverable, example?, nextTool?, candidates? }`。
🔴 默认**跑完全部闸再判**（不见红即停）：一次让喂料方看到全部问题。

### 4.1 判档口径（`question.solution_grade`）

| 档 | 条件 | 语义 |
|---|---|---|
| `calc_verified` | 闸⑧ 实算 verified | 机器算过且与答案等值（⚠️ 判档只看最终答案；「过程对不对」由同一道闸的第二判据 `CALC_LINE_MISMATCH` 拦，不进判档） |
| `analysis_only` | 有 analysis **或** 有 answer | 人核得动。`qtype='计算'` 却算不动又没解析 ⇒ 落这一档并在账上记 warn |
| `no_solution` | 两样都没有 | 🔴 Q11 排除出出题检索；契约层已拦，闸⑨ 是防御 |

---

## 5. 落库与返回

**一次调用一个事务**（`withCoreWrite`：开闸 / 业务写 / 审计 / 关闸 同一事务）：

```
ingest_batch(open) → source_doc（有则复用）
  → 逐题：question + question_kp + question_tag + question_figure + asset + question_fts 投影
         / 红灯题 → quarantine（why + 原样 payload，🔴 不落 question）
  → 题干图 → review_queue(kind='图片', ref_type='question')
  → ingest_batch(committed + n_* + gate_report_json)
```

返回：

```ts
{ batchId, contractVer, source,
  counts: { total, accepted, queued /* accepted 的子集 */, rejected },
  gateReport, questionIds, queueIds, quarantineIds, dryRun, backup }
```

- 新题一律落 `status='pending'`（转正走审查队列，不在管道里）。
- 收批后（事务外）出一份 `backup` 快照。
- `dryRun: true` ⇒ 只跑相一：返回完整 gate_report，**库与磁盘零变化**（005 产线接入前的试跑）。

## 6. 纪律（写给后来改这条路的人）

1. 🔴 **改 stem/answer/analysis 的任何写路径，必须同事务调 `writeQuestionFts`**。
   方案甲撤了 FTS 的 INSERT/UPDATE 触发器，漏一次 = 那题 FTS 永远查不到且不报错。
   机器闸 = 对账 **C1(f)**（可检索题 id 集 ≡ 索引 id 集）。
2. 🔴 题的 `status` 迁出 `pending/active` 时，同事务删掉它的 FTS 行（C1(f) 反向也会红）。
3. 🔴 写侧分词一律 `mode:'search'`，查侧 `exact`。方向不能反。
4. 🔴 闸只做**确定性判定**（查库可以，问 LLM 不行 —— 那是软闸，走 `review_queue`）。
5. 🔴 变换在管道（相一），判定在闸。别把变换塞回闸里，那会让闸有顺序耦合、没法单测。
