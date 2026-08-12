# gates/

每闸一个文件、可单独单测，命名 `<domain>-<name>.gate.ts`（如 `question-provenance.gate.ts`、
`kp-exists.gate.ts`、`stem-no-instruction-words.gate.ts`），默认导出一个实现 `Gate` 接口的对象。

- 契约在 [types.ts](types.ts)：`{ ok:true }` 或 `{ ok:false, code, message, recoverable, candidates? }`，
  和「错误契约」（技术设计 §5 / 回归清单 REG-G2）同一个 shape。
- 执行器在 [index.ts](index.ts)：`runGates(gates, input)` 串行跑完聚合成 `gate_report`，
  报告整份进 `audit_log.gate_results_json` —— 页页有账。
- 🔴 闸必须是**确定性判定**：查库可以，问 LLM 不行（那是软闸，走 `review_queue`）。
- AI:PRD-001 只交付骨架；真闸从 AI:PRD-003（录题管道）起逐个长。
