# sidecar —— Python 侧车（AI:PRD-003 · 003-B / 003-E）

JS 生态里没有像样替代物的三件事，交给 Python 干：

| op | 干什么 | 谁在用 |
|---|---|---|
| `segment` | 去 LaTeX + **jieba 分词**，出空格串 | `question_fts` 的写侧与查侧（001 疑问一 · 方案甲） |
| `calc_verify` | **sympy 实算**比对答案 | 「可实算即实算」闸 → `question.solution_grade` 判档 |
| `line_verify` | **逐行恒等**：解析里每一行都要与原式恒等 | 同一道闸的第二判据 → 红灯 `CALC_LINE_MISMATCH`（003-E） |
| `ping` | 探活 + 自报版本 | 装完自检 / 排障 |

协议版本 `kb-sidecar/2`（`ping` 自报）：1 → 2 = 加了 `line_verify`，
并给 `calc_verify` 的解析器补了 `\(…\)`/`\[…\]` 定界符剥离（群卷题面就是这个形态，
不剥的话一道算得动的题会被那个裸反斜杠判成 `cannot_verify`）。

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

### `line_verify`

```jsonc
// 请求：给解析原文（按行切），或者直接给转写好的链
{"op":"line_verify","items":[{"id":"q1","analysis":"原式 = -8-(-3-54)\n= -8+3-54\n= 49"}]}
{"op":"line_verify","items":[{"id":"q1","lines":["-2**3-(-3+(-3)**2/(-1/6))","-8-(-3-54)"]}]}
// 响应
{"ok":true,"op":"line_verify","results":[
  {"id":"q1","verdict":"line_mismatch","checked":2,"chains":1,
   "reason":"第 3 行断裂：「-8+3-54」算出 -59，而本链原式「-8-(-3-54)」= 49",
   "badLines":[{"line":3,"text":"= -8+3-54","left":"-8-(-3-54)","right":"-8+3-54",
                "computed":"-59","expected":"49"}]}]}
```

| verdict | 含义 | 下游 |
|---|---|---|
| `all_identical` | 做过比对，且每一段都与本链首段恒等 | 记一笔 note |
| `line_mismatch` | 🔴 有一段与首段不等 = **中间行断裂** | 红灯 `CALC_LINE_MISMATCH`（带 badLines） |
| `no_checkable_lines` | 一次比对都没做成 | 不拦路，账上记一笔 |

**为什么非要它**：`calc_verify` 只验最终答案，对「答案对、过程错」完全免疫 ——
2026-07-30 有理数打卡第二天第 9 题就是这么漏过去的（去括号漏变号，最后一行又锚回
正确答案）。思路照 `举一反三产物/解题模型库/_验算/逐行恒等校验.py`（只读，未改动）。

链是怎么切的：

- 一条链的**首个可读片段**是基准（原式），此后每个可读片段都必须与它恒等；
- **以等号开头的行 = 上一行的续行**（解析里最常见的写法），接着同一条链算；
  其余行另起一条链 —— 多小问的解析里 (1)(2)(3) 各是各的链，不能互相比；
- `lines` 形态：整条当**一条链**（首行 = 原式），与 逐行恒等校验.py 的 expr 模式同源。

🔴 **只判数值链**。含未知量的变形链（解方程、字母化简）一律 `no_checkable_lines`：
判它们要比**解集**（那是 eq 模式，另一类闸），拿恒等去判 `x=1` 这种行会当场判出假红。
本闸是红灯闸 —— 假红拦下真题的代价，比漏判一条大得多。
带比较号的行（`27 < 50 < 64`）同理跳过：那是判断句不是恒等链。

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
- 改 `line_verify` 的链切法 = 改一道**红灯闸**的松紧：放宽（比如放行含未知量的行）
  之前先想清楚假红的代价 —— 它会把真题拦进隔离区。
- 机器闸在 `tests/sidecar.test.ts`（calc 三态 + 去 LaTeX + 环境缺失）与
  `tests/ingest-golden.test.ts`（REG-C4：三绿 + 答案错 + 中间行错）。
