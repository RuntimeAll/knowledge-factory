# sidecar —— Python 侧车（AI:PRD-003 · 003-B）

JS 生态里没有像样替代物的两件事，交给 Python 干：

| op | 干什么 | 谁在用 |
|---|---|---|
| `segment` | 去 LaTeX + **jieba 分词**，出空格串 | `question_fts` 的写侧与查侧（001 疑问一 · 方案甲） |
| `calc_verify` | **sympy 实算**比对答案 | 「可实算即实算」闸 → `question.solution_grade` 判档 |
| `ping` | 探活 + 自报版本 | 装完自检 / 排障 |

Node 侧封装 = `src/core/sidecar.ts`（从 `~/core` 出口，别绕过它自己 spawn）。

---

## 安装（一次性，5 分钟）

前置：本机 `python --version` ≥ 3.11（开发机实测 3.11.9）。

```powershell
cd D:\workplace\ai-bkb\codeplace-AI\knowledge-factory\sidecar
python -m venv .venv-sidecar
.\.venv-sidecar\Scripts\python.exe -m pip install -r requirements.txt
```

装完自检（该打印出三个版本号）：

```powershell
'{"op":"ping"}' | .\.venv-sidecar\Scripts\python.exe main.py
# {"ok": true, "op": "ping", "sidecar": "kb-sidecar/1",
#  "versions": {"python": "3.11.9", "jieba": "0.42.1", "sympy": "1.14.0"}}
```

- `.venv-sidecar/` **不进 git**（.gitignore 已挡），`requirements.txt` 进 git；
- 🔴 版本 `==` 钉死。理由写在 requirements.txt 里：分词结果与实算结论会**落进库**，
  依赖一浮动就是数据漂移，且是最难查的那种。
- 解释器路径可用环境变量 `SIDECAR_PYTHON` 覆写（CI / 换机 / 用 uv 建的环境）。

---

## 调用契约

**一次进程一次请求**：stdin 一个 JSON → stdout 一个 JSON，进程退出。
批量在**请求内部**做（`texts` / `items` 是数组），别在外面起 N 个进程——
jieba 每次启动要载词典（~0.4s），一题一进程就是把这 0.4s 乘以题数。

退出码正常一律 **0**；业务失败用 `{"ok":false,...}` 表达，不拿退出码当错误通道
（node 侧要拿得到人话原因，裸崩只剩一个数字）。stdout 只有那一个 JSON，
jieba 的载词典日志走 stderr，不会污染。

### `segment`

```jsonc
// 请求
{"op":"segment","mode":"exact","texts":[{"id":"q1","text":"已知方程 $x^2-5x+6=0$，求它的两个根"}]}
// 响应
{"ok":true,"op":"segment","mode":"exact",
 "results":[{"id":"q1","segmented":"已知 方程 x 2 5x 6 0 求 它 的 两个 根"}]}
```

去 LaTeX 口径（`$...$` / `$$...$$` / `\(...\)` / `\[...\]`）：**保留数学词元的语义近似**
——命令名（`\frac`、`\times`…）剥掉，只留其中的中文与字母数字串，纯符号丢掉。
`$\frac{3}{4}+\frac{1}{2}$` → `3 4 1 2`。留数字不是为了检索数字，是为了别把题面掏成空壳。

`mode`：

| mode | jieba | 「一元一次方程的解法」切成 | 说明 |
|---|---|---|---|
| `exact`（默认） | `cut` 精确模式 | `一元 / 一次方程 / 的 / 解法` | 口径干净，但 **`方程` 查不到它** |
| `search` | `cut_for_search` 搜索引擎模式 | `一元 / 一次 / 次方 / 方程 / 一次方程 / 的 / 解法` | 长词再切，召回高，索引略胖 |

🔴 **写侧与查侧的 mode 必须成对决定**：查侧固定 `exact`（`ftsQuery`），
所以写侧选 `search` 只会**增加**召回、不会漏（查询 token 是索引 token 的子集）；
选 `exact` 则长词内部查不到。003-C 定写侧口径时按这条判，别两边各拍一次脑袋。

### `calc_verify`

```jsonc
// 请求
{"op":"calc_verify","items":[{"id":"q1","stem":"计算：3+5×2","answer":"13","analysis":"（可选，暂不参与判定）"}]}
// 响应
{"ok":true,"op":"calc_verify","results":[
  {"id":"q1","verdict":"verified",
   "detail":{"reason":"实算与答案等值","expr":"3+5*2","computed":"13","expected":"13"}}]}
```

| verdict | 含义 | 下游 |
|---|---|---|
| `verified` | 算出来了，且与答案**等值** | 可判 `calc_verified` |
| `mismatch` | 算出来了，但**对不上** | 🔴 红旗，必须人看（多半是答案错，也可能是题面录错） |
| `cannot_verify` | 读不成可计算表达式 / 答案读不出数 | 如实报，**绝不猜** |

能算的形态：纯数值四则、分数（`\frac`、`a/b`）、根式（`\sqrt{}`、`\sqrt[n]{}`）、
绝对值（`|-3|`）、乘方（`^` / `**`）、小数、`pi`。
一律 `cannot_verify` 的：含中文的应用题、含未知量的化简/解方程、百分号、单位换算、
以及触到护栏的（表达式 >200 字符 / 乘方 >4 处 / 16 位以上整数——sympy 会真的去算，
幂塔能把进程拖死）。

题面进解析前会剥掉**指令词与题号**（`计算：`/`求`/`化简`/`(3)`…），这与
「题面禁指令词」的既有纪律同源：指令词是属性不是题面。

等值判定 = `simplify(算出来 - 答案) == 0`，退路是数值容差 `< 1e-9`（给浮点答案）。
`3/4+1/2` vs `5/4` 判 `verified`（Rational 精确相等），不是靠浮点碰巧撞上。

### 出错

```jsonc
{"ok":false,"op":"segment","error":{"code":"BAD_REQUEST","message":"segment 需要 texts 数组：[{id, text}]"}}
```

`code`：`BAD_REQUEST`（请求坏了）| `UNKNOWN_OP` | `INTERNAL`（内部异常，message 带类型名）。

---

## 改这里之前

- 改分词口径 = 改**已入库数据**的含义（`question_fts` 里躺着的是旧口径的串）。
  换 mode / 换词典要连带回填 FTS，不是改一行就完事。
- 改 `calc_verify` 判定 = 改 `solution_grade` 判档依据，同理。
- 两件事的机器闸在 `tests/sidecar.test.ts`（三态各一例 + 去 LaTeX 一例 + 环境缺失一例）。
