# gates/

每闸一个文件、可单独单测，命名 `<domain>-<name>.gate.ts`，默认导出一个实现 `Gate` 接口的对象。

- 契约在 [types.ts](types.ts)：`{ ok:true }` 或 `{ ok:false, code, message, recoverable, candidates? }`，
  和「错误契约」（技术设计 §5 / 回归清单 REG-G2）同一个 shape。
- 执行器在 [index.ts](index.ts)：`runGates(gates, input)` 串行跑完聚合成 `gate_report`，
  报告整份进 `audit_log.gate_results_json` —— 页页有账。
- 🔴 闸必须是**确定性判定**：查库可以，问 LLM 不行（那是软闸，走 `review_queue`）。
- 🔴 **管道做变换，闸做判定**（见 [ingest-context.ts](ingest-context.ts) 文件头）：
  闸文件同时导出纯函数（剥/清/算），管道相一调它们算出 `derived`，闸只读 `derived` 判红绿
  并把结论写回去。变换塞进闸里 = 闸之间有顺序耦合 = 「每闸可单测」作废。

## 录题十闸（AI:PRD-003 · kb-ingest/v1，顺序即 gate_report 顺序）

| # | 文件 | 判什么 | 红灯 code |
|---|---|---|---|
| ① | `ingest-contract.gate.ts` | zod 契约（批级；**结构错整批拒**） | `INGEST_CONTRACT_INVALID` |
| ② | `ingest-provenance.gate.ts` | 来源四型必填项（model 还要查库 status='active'） | `PROV_*` 七个 |
| ③ | `ingest-kp.gate.ts` | ≥1 考点、主考点恰一、ref 只认 1.0 精确命中 | `KP_NOT_FOUND` / `AMBIGUOUS_KP` / `KP_ID_NOT_FOUND` / `KP_NOT_ACTIVE` / `KP_DUPLICATE` / `KP_PRIMARY_MULTI` |
| ④ | `ingest-instruction.gate.ts` | 句首裸指令词剥离（🔴 句中不动）+ 元词红灯 | `STEM_HAS_META_WORD` / `STEM_EMPTY_AFTER_STRIP` |
| ⑤ | `ingest-prefix.gate.ts` | 前缀清洗 + 残留机器复核（老口径的 `REGEXP=0`） | `STEM_PREFIX_RESIDUE` / `STEM_EMPTY_AFTER_CLEAN` |
| ⑥ | `ingest-placeholder.gate.ts` | 空题面 / 纯占位 / 声称有图却没图 | `STEM_EMPTY` / `STEM_PLACEHOLDER` / `FIGURE_DECLARED_BUT_MISSING` |
| ⑦ | `ingest-dedup.gate.ts` | match_key 撞库 / 撞批 | `DUPLICATE` / `DUPLICATE_IN_BATCH` |
| ⑧ | `ingest-calc.gate.ts` | 可实算即实算（自家 sympy 算，不继承产线自报） | `CALC_MISMATCH` |
| ⑨ | `ingest-solution-grade.gate.ts` | 三档判档 | `NO_SOLUTION`（防御） |
| ⑩ | `ingest-figure.gate.ts` | 图文件存在 + hash 去重 + 题干图必审 | `FIGURE_FILE_MISSING` / `FIGURE_UNREADABLE` / `FIGURE_NOT_A_FILE` |

串闸的是 [`core/ingest.ts`](../ingest.ts) 的 `ITEM_GATES`（②~⑩）；人读契约 = [`contracts/kb-ingest-v1.md`](../../../contracts/kb-ingest-v1.md)。
