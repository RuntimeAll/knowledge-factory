"""
sidecar/main.py —— Python 侧车（AI:PRD-003 · 003-B / 003-E）

做三件 JS 生态里没有像样替代物的事：
  ① segment      中文分词（jieba）——question_fts 是 unicode61 分词器，
                 中文必须由写侧**预分词成空格串**才检索得动（001 疑问一·方案甲）；
  ② calc_verify  数值实算（sympy）——「可实算即实算」闸的算力来源，
                 结论喂 question.solution_grade 判档（calc_verified / …）；
  ③ line_verify  逐行恒等（sympy）——解析里**每一行**都要与原式恒等，
                 补的正是 calc_verify 验不出的那一类：「答案对、过程错」
                 （2026-07-30 有理数打卡第二天第 9 题事故：去括号漏变号，
                 最后一行又锚回正确答案）。思路照 `举一反三产物/解题模型库/
                 _验算/逐行恒等校验.py`（只读，未改动）。

════════════════════════════════════════════════════════════════════════════
调用契约（一次进程一次请求；批量在请求内部做，别在外面起 N 个进程）

  stdin  ← 一个 JSON 对象
  stdout → 一个 JSON 对象（**只有它**，别的话一律往 stderr 写）
  退出码  正常一律 0 —— 业务失败也用 {"ok":false,...} 表达，不拿退出码当错误通道
          （node 侧要能拿到人话原因，裸崩只剩一个数字）。

  请求 / 响应：

  {"op":"ping"}
    → {"ok":true,"op":"ping","versions":{"python":"3.11.9","jieba":"0.42.1","sympy":"1.14.0"}}

  {"op":"segment","texts":[{"id":"q1","text":"解方程：$2x+1=7$"}],"mode":"exact"}
    → {"ok":true,"op":"segment","results":[{"id":"q1","segmented":"解 方程 2 x 1 7"}]}
    mode: "exact"（默认，jieba 精确模式）| "search"（搜索引擎模式，粒度更碎、召回更高）
    🔴 写侧与查侧必须同 mode，否则索引与查询口径不一致 —— 默认两边都用 exact。

  {"op":"calc_verify","items":[{"id":"q1","stem":"计算：3+5×2","answer":"13"}]}
    → {"ok":true,"op":"calc_verify","results":[
         {"id":"q1","verdict":"verified","detail":{
            "reason":"...","expr":"3+5*2","computed":"13","expected":"13"}}]}
    verdict: verified（算出来且与答案等值）
           | mismatch（算出来但对不上 —— 🔴 这是要人看的红旗）
           | cannot_verify（解析不成可计算表达式 / 答案读不出数）
    两档（kb-sidecar/3 起）：
      数值档  两侧都是纯数值式 → simplify(题面 - 答案) == 0
      符号档  两侧都是纯代数式且至少一侧含未知量（合并同类项/化简这类题）
              → simplify(expand(题面) - expand(答案)) == 0，reason 注明「符号恒等」
    🔴 符号档只在数值档已经 cannot_verify 时才走，**数值档行为一个字不改**。
    🔴 cannot_verify 是**如实报**，绝不猜：应用题、含未知量的方程/多解枚举、
       单位换算…一律 cannot_verify，把判档权交回上游，
       不许"看着像对的"就给 verified。

  {"op":"line_verify","items":[{"id":"q1","analysis":"原式 = -8-(-3-54)\\n= -8+3-54\\n= 49"}]}
  {"op":"line_verify","items":[{"id":"q1","lines":["-2**3-(-3+(-3)**2/(-1/6))","-8-(-3-54)"]}]}
    → {"ok":true,"op":"line_verify","results":[
         {"id":"q1","verdict":"line_mismatch","checked":2,"chains":1,
          "reason":"...","badLines":[{"line":3,"text":"= -8+3-54",
            "left":"-8-(-3-54)","right":"-8+3-54","computed":"-59","expected":"49"}]}]}
    verdict: all_identical      （做过比对，且每一段都与本链首段恒等）
           | line_mismatch      （🔴 有一段与首段不等 —— 中间行断裂）
           | no_checkable_lines （一次比对都没做成：全是文字/含未知量/读不成算式）
    🔴 **只判数值链**：含未知量的变形链（解方程、字母化简）一律 no_checkable_lines。
       判它们要比**解集**（逐行恒等校验.py 的 eq 模式），拿恒等去判 `x=1` 这种行
       会当场判出假红；本闸是红灯闸，假红的代价比漏判高得多，所以宁可如实说
       「这条我判不了」。

  出错（请求本身坏了 / 内部异常）：
    → {"ok":false,"op":"...","error":{"code":"BAD_REQUEST","message":"人话"}}
    code: BAD_REQUEST | UNKNOWN_OP | INTERNAL
════════════════════════════════════════════════════════════════════════════

🔴 GBK 控制台坑：本机控制台默认 GBK，print 中文/emoji 会直接杀进程 ——
   开头必 reconfigure utf-8（下面第一件事就是它），且全文件不出现 emoji。
"""

from __future__ import annotations

import json
import re
import sys

# 🔴 第一件事：三条流一律 UTF-8。晚一步就可能在报错路径上被 GBK 咬。
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except Exception:  # pragma: no cover - 老 Python / 非 TextIO 时忽略
        pass

SIDECAR_VERSION = "kb-sidecar/3"

# ---------------------------------------------------------------------------
# 去 LaTeX（segment 与 calc_verify 共用的前处理）
# ---------------------------------------------------------------------------

# \frac \times \left … 这类命令名
_CMD = re.compile(r"\\[A-Za-z]+\s*")
# 数学环境里"值得留下"的东西：中文 + 字母数字串（纯符号一律丢）
_WORD = re.compile(r"[0-9A-Za-z]+|[\u4e00-\u9fff]+")
# 一个 token 里只要有这类字符就算有意义（否则是纯标点，分词后丢掉）
_MEANINGFUL = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")


def _math_keep(inner: str) -> str:
    """数学环境内容 → 语义近似串：命令名剥掉，只留中文与字母数字，空格分开。

    `$3+5\\times 2$` → `3 5 2`；`$\\frac{1}{2}$` → `1 2`；`$x^2$` → `x 2`。
    留数字不是为了"检索数字"，是为了别把一道题的题面掏成空壳。
    """
    return " ".join(_WORD.findall(_CMD.sub(" ", inner)))


def de_latex(text: str) -> str:
    """去 LaTeX：数学环境替成语义近似串，裸命令清掉，空白归一。"""

    def rep(m: "re.Match[str]") -> str:
        return " " + _math_keep(m.group(1)) + " "

    s = text or ""
    # 顺序要紧：$$..$$ 必须先于 $..$，否则会被后者从中间切开
    s = re.sub(r"\$\$(.+?)\$\$", rep, s, flags=re.S)
    s = re.sub(r"\\\[(.+?)\\\]", rep, s, flags=re.S)
    s = re.sub(r"\\\((.+?)\\\)", rep, s, flags=re.S)
    s = re.sub(r"\$(.+?)\$", rep, s, flags=re.S)
    # 没包在数学环境里的裸命令（\alpha 之类）一并清掉
    s = _CMD.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------------------
# op: segment
# ---------------------------------------------------------------------------


def op_segment(req: dict) -> dict:
    import jieba  # 惰性导入：calc_verify 用不着它，省掉词典加载

    texts = req.get("texts")
    if not isinstance(texts, list):
        raise _BadRequest("segment 需要 texts 数组：[{id, text}]")

    mode = req.get("mode", "exact")
    if mode not in ("exact", "search"):
        raise _BadRequest("mode 只能是 exact | search")

    results = []
    for i, item in enumerate(texts):
        if not isinstance(item, dict) or "id" not in item:
            raise _BadRequest(f"texts[{i}] 缺 id")
        plain = de_latex(str(item.get("text") or ""))
        cut = jieba.cut_for_search(plain) if mode == "search" else jieba.cut(plain)
        toks = [t.strip() for t in cut]
        segmented = " ".join(t for t in toks if t and _MEANINGFUL.search(t))
        results.append({"id": item["id"], "segmented": segmented})

    return {"ok": True, "op": "segment", "mode": mode, "results": results}


# ---------------------------------------------------------------------------
# op: calc_verify · 共用解析层（剥指令词 / 去 LaTeX / 数值档解析）
# ---------------------------------------------------------------------------

# 题号：1. / (2) / 【3】 / 4、
_LEAD_NUM = re.compile(r"^\s*[（(\[【]?\s*\d{1,3}\s*[)）\]】.、．]\s*")

# 指令词（长的排前面，逐轮剥到不动为止）。
# 🔴 这些是"属性不是题面"（用户口径：题面禁指令词），剥掉才谈得上解析表达式。
_INSTRUCTIONS = (
    "直接写出得数",
    "用简便方法计算",
    "简便方法计算",
    "递等式计算",
    "脱式计算",
    "简便计算",
    "口算",
    "计算下面各题",
    "计算下列各题",
    "计算",
    "求下列各式的值",
    "求值",
    "化简",
    "求",
    "解",
)

# 题面尾巴
_TRAILS = (
    "的值",
    "等于多少",
    "是多少",
    "得多少",
    "＝",
    "=",
    "。",
    "．",
    ".",
    "？",
    "?",
    "：",
    ":",
    "；",
    ";",
    "，",
    ",",
)

# 全角/中文运算符 → ASCII
_SYMBOLS = {
    "×": "*",
    "✕": "*",
    "∙": "*",
    "·": "*",
    "⋅": "*",
    "÷": "/",
    "−": "-",
    "－": "-",
    "﹣": "-",
    "＋": "+",
    "＊": "*",
    "／": "/",
    "（": "(",
    "）": ")",
    "［": "[",
    "］": "]",
    "｛": "{",
    "｝": "}",
    "＝": "=",
    "，": ",",
    "、": ",",
    " ": " ",  # NBSP
}

# 允许出现的函数名/常量（白名单之外的标识符一律拒 —— 拒了才不会被 auto_symbol
# 悄悄变成自由符号，然后算出一个"看着像数"的东西）
_ALLOWED_NAMES = ("sqrt", "root", "Abs", "pi")
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_PURE_MATH = re.compile(r"^[0-9+\-*/().,\s]*$")
_CJK = re.compile(r"[\u4e00-\u9fff]")

# 防炸护栏：表达式过长 / 幂塔 / 天文数字一律不算（sympy 会真的去算，能把进程拖死）
_MAX_EXPR_LEN = 200
_MAX_POW = 4
_HUGE_INT = re.compile(r"\d{16,}")


def _strip_instructions(stem: str) -> str:
    s = (stem or "").strip()
    s = _LEAD_NUM.sub("", s)
    changed = True
    while changed:
        changed = False
        s = s.lstrip()
        for w in _INSTRUCTIONS:
            if s.startswith(w):
                s = s[len(w) :].lstrip(" :：,，、")
                changed = True
                break
    changed = True
    while changed:
        changed = False
        s = s.rstrip()
        for t in _TRAILS:
            if s.endswith(t):
                s = s[: -len(t)]
                changed = True
                break
    return s.strip()


def _latex_to_expr(s: str) -> str:
    """LaTeX / 中文运算符 → sympy 能读的表达式串（只做机械翻译，不做猜测）。"""
    s = s.replace("$", " ")
    # 行内/行间数学定界符 \( \) \[ \]（群卷题面就是这个形态：`\(23-\left(-5\right)-14\)`）。
    # 🔴 必须先于 \\left|\\right 与命令名剥离处理：留着它，后面的白名单会因为一个裸
    #    反斜杠把整条式子判成「含不认识的符号」，一道算得动的题就白白降级成 cannot_verify。
    s = re.sub(r"\\[()\[\]]", " ", s)
    s = re.sub(r"\\left|\\right", " ", s)
    s = s.replace("\\times", "*").replace("\\cdot", "*").replace("\\div", "/")

    # \frac{a}{b} 可能套娃，反复替到不动为止（上限防病态输入）
    for _ in range(5):
        new = re.sub(r"\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}", r"((\1)/(\2))", s)
        if new == s:
            break
        s = new

    s = re.sub(r"\\sqrt\s*\[\s*([^\[\]{}]*)\s*\]\s*\{([^{}]*)\}", r"root((\2),(\1))", s)
    s = re.sub(r"\\sqrt\s*\{([^{}]*)\}", r"sqrt((\1))", s)

    for k, v in _SYMBOLS.items():
        s = s.replace(k, v)

    # |x| → Abs(x)（成对才换；单根竖线是坏输入，留着让白名单去拒）
    for _ in range(5):
        new = re.sub(r"\|([^|]+)\|", r"Abs(\1)", s)
        if new == s:
            break
        s = new

    s = s.replace("{", "(").replace("}", ")")
    s = s.replace("^", "**")
    return re.sub(r"\s+", " ", s).strip()


def _parse_number_expr(raw: str):
    """表达式串 → sympy 数值表达式；解析不了/不是纯数值就抛 _CannotVerify。"""
    from sympy import Abs, pi, root, sqrt
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations

    s = _latex_to_expr(raw)
    if not s:
        raise _CannotVerify("空表达式")
    if _CJK.search(s):
        raise _CannotVerify("含中文，不是纯算式（应用题/需要建模的题不做实算）")
    if len(s) > _MAX_EXPR_LEN:
        raise _CannotVerify(f"表达式过长（>{_MAX_EXPR_LEN} 字符）")
    if s.count("**") > _MAX_POW:
        raise _CannotVerify("乘方过多，拒算（防幂塔把进程拖死）")
    if _HUGE_INT.search(s):
        raise _CannotVerify("含 16 位以上整数，拒算")

    for name in set(_NAME_RE.findall(s)):
        if name not in _ALLOWED_NAMES:
            raise _CannotVerify(f"含未知标识符 {name}（只认 {', '.join(_ALLOWED_NAMES)}）")
    if not _PURE_MATH.match(_NAME_RE.sub(" ", s)):
        bad = "".join(sorted(set(re.sub(r"[0-9+\-*/().,\s]", "", _NAME_RE.sub(" ", s)))))
        raise _CannotVerify(f"含不认识的符号：{bad}")

    try:
        expr = parse_expr(
            s,
            local_dict={"sqrt": sqrt, "root": root, "Abs": Abs, "pi": pi},
            transformations=standard_transformations,
            evaluate=True,
        )
    except Exception as e:  # 语法错 / 括号不配对…
        raise _CannotVerify(f"表达式解析失败：{type(e).__name__}") from e

    if getattr(expr, "free_symbols", set()):
        raise _CannotVerify("含未知量，不是可计算的数值表达式")
    return expr, s


def _equal(a, b) -> bool:
    """等值判定：先 simplify 求差为 0，再退到数值容差（浮点答案用）。"""
    from sympy import N, simplify

    try:
        d = simplify(a - b)
    except Exception:
        return False
    if d == 0:
        return True
    try:
        v = complex(N(d))
    except Exception:
        return False
    return abs(v) < 1e-9


# ---------------------------------------------------------------------------
# 符号恒等档（003-E2）
#
# 数值档判不了的那一堆里，有一块是**判得死**的：题面与答案都是纯代数式
# （`-21x+19y+21x-27y` vs `-8y`）—— 合并同类项、去括号化简这类题全在这块。
# 它们不需要"建模"，只需要判两个式子恒不恒等，而这正是符号计算的本行。
# 当初把 calc_verify 收窄到纯数值，是宁可漏判也不误判；这一档把漏的那块捡回来，
# 边界照样收得死：
#
#   ① **只在数值档已经 cannot_verify 时才走** —— 数值档的 verified/mismatch
#      一个字都碰不到（零回归的物理保证，不是靠"小心点"）。
#   ② **两侧至少一侧含未知量**。纯数值式仍归数值档，不许从这条路溜进来 ——
#      否则「隐式乘法」这类更宽的解析口径会悄悄改掉数值档的收案范围。
#   ③ **含中文 / 等号 / 比较号 / 多字符标识符 一律不收**：
#      `|x-4|+|x+2|=6` 是方程不是式子（判它要比**解集**，那是另一类闸），
#      「整数 x 为 -2，-1，0…」是枚举不是式子。如实退回 cannot_verify。
#   ④ **判 mismatch 必须拿得出反证**（找得到一组取值让两式不等）。
#      光凭 simplify 没化到 0 就判红 = 假红 —— 这条与 line_verify 同口径：
#      红灯闸假红拦下真题的代价，比漏判一条大得多。
#
# 隐式乘法（`21x` / `6ab` / `2(a+b)`）不用 sympy 的 implicit_multiplication：
# 那条路会把不在词典里的多字母名按 sympy 自己的规则切（希腊字母名还不切），
# 口径不在我们手里。这里**自己机械地插 `*`**，插完每个标识符都是单字母或白名单，
# 再全部显式绑成 Symbol —— sympy 全局命名空间里的 `beta`/`N`/`E` 一个都溜不进来。
# ---------------------------------------------------------------------------

# 未知量：单个拉丁字母（x/y/a/b/c/m/n…）。带下标、多字符名一律不收
_ONE_LETTER = re.compile(r"^[A-Za-z]$")
# 字母连写 = 连乘（`ab` → `a*b`）；再长就不像题面了，拒
_MAX_VAR_RUN = 4
# 自由符号上限（反证取样要一符号一个取值，也防病态输入）
_MAX_SYMBOLS = 8
# 符号档的乘方护栏：多项式天然带好几个乘方，比数值档松；真正的炸点是**指数大小**
_MAX_POW_SYM = 8
_MAX_EXPONENT = 12
_EXPONENT = re.compile(r"\*\*\s*\(?\s*-?\s*(\d+)")
# 比较号（判断句不是式子）。与 line_verify 的 _COMPARE 同源，各自留一份便于单独改
_COMPARE_SYM = re.compile(r"[<>≤≥≠]|&lt;|&gt;")

# 反证取样：两轮定值（**不随机**，同一道题任何时候都得出同一个结论）。
# 一轮全正整数，一轮带负数与分数 —— 差式若真不恒等，两轮 16 个点上全为 0 的
# 概率低到可以不谈；真碰上了也不判红，如实说判不了（见纪律④）。
_SAMPLE_ROUNDS = ((2, 3, 5, 7, 11, 13, 17, 19), (-1, 4, -5, 6, -9, 8, -3, 10))


def _split_implicit_mul(s: str) -> str:
    """机械地把隐式乘法补成显式 `*`；顺便把多字母连写拆成单字母连乘。"""

    def 拆标识符(m: "re.Match[str]") -> str:
        run = m.group(0)
        if run in _ALLOWED_NAMES:
            return run
        if not run.isalpha():
            raise _CannotVerify(f"标识符 {run} 不是纯字母（下标/带数字的名一律不收）")
        if len(run) > _MAX_VAR_RUN:
            raise _CannotVerify(
                f"含 {len(run)} 个字母连写的标识符 {run}（未知量只收单字母，"
                f"连乘最多 {_MAX_VAR_RUN} 个）"
            )
        return "*".join(run)

    s = _NAME_RE.sub(拆标识符, s)
    # 非白名单标识符后面跟括号 = 连乘（`a(b+c)` → `a*(b+c)`）；白名单是函数调用
    s = re.sub(
        r"([A-Za-z_][A-Za-z0-9_]*)\s*\(",
        lambda m: m.group(1) + ("(" if m.group(1) in _ALLOWED_NAMES else "*("),
        s,
    )
    # 数字/右括号 后面跟 字母或左括号（`21x` `2(a+b)` `(a+b)(c+d)`）
    s = re.sub(r"(?<=[0-9)])\s*(?=[A-Za-z(])", "*", s)
    # 右括号 后面跟 数字（`(a+b)2`）
    s = re.sub(r"(?<=\))\s*(?=[0-9])", "*", s)
    return s


def _parse_symbolic_expr(raw: str):
    """表达式串 → sympy 代数式；不是"纯代数式"就抛 _CannotVerify。返回 (expr, 归一串)。"""
    from sympy import Abs, Expr, Symbol, pi, root, sqrt
    from sympy.parsing.sympy_parser import parse_expr, standard_transformations

    s = _latex_to_expr(raw)
    if not s:
        raise _CannotVerify("空表达式")
    if _CJK.search(s):
        raise _CannotVerify("含中文，不是纯代数式")
    if "=" in s:
        raise _CannotVerify("含等号，是方程/枚举不是代数式（判它要比解集，不是比恒等）")
    if _COMPARE_SYM.search(s):
        raise _CannotVerify("含比较号，是判断句不是代数式")
    if len(s) > _MAX_EXPR_LEN:
        raise _CannotVerify(f"表达式过长（>{_MAX_EXPR_LEN} 字符）")
    if s.count("**") > _MAX_POW_SYM:
        raise _CannotVerify(f"乘方过多（>{_MAX_POW_SYM} 处），拒算")
    if any(int(e) > _MAX_EXPONENT for e in _EXPONENT.findall(s)):
        raise _CannotVerify(f"指数大于 {_MAX_EXPONENT}，拒算（展开会把进程拖死）")
    if _HUGE_INT.search(s):
        raise _CannotVerify("含 16 位以上整数，拒算")

    s = _split_implicit_mul(s)

    local: dict = {"sqrt": sqrt, "root": root, "Abs": Abs, "pi": pi}
    for name in set(_NAME_RE.findall(s)):
        if name in _ALLOWED_NAMES:
            continue
        if not _ONE_LETTER.match(name):  # 走过 _split_implicit_mul 后不该还有，兜底
            raise _CannotVerify(f"含多字符标识符 {name}")
        local[name] = Symbol(name)  # 🔴 显式绑定：sympy 全局命名空间一个名都别想溜进来
    if len(local) - 4 > _MAX_SYMBOLS:
        raise _CannotVerify(f"未知量超过 {_MAX_SYMBOLS} 个，拒算")
    if not _PURE_MATH.match(_NAME_RE.sub(" ", s)):
        bad = "".join(sorted(set(re.sub(r"[0-9+\-*/().,\s]", "", _NAME_RE.sub(" ", s)))))
        raise _CannotVerify(f"含不认识的符号：{bad}")

    try:
        expr = parse_expr(
            s,
            local_dict=local,
            transformations=standard_transformations,
            evaluate=True,
        )
    except Exception as e:
        raise _CannotVerify(f"表达式解析失败：{type(e).__name__}") from e

    if not isinstance(expr, Expr):
        raise _CannotVerify("解析出来的不是一个式子（元组/关系式？）")
    return expr, s


def _counterexample(diff):
    """找一组取值让 diff != 0 —— 找到就是**不恒等的反证**。返回 (取值串, 值) 或 (None, None)。"""
    from sympy import N

    syms = sorted(diff.free_symbols, key=lambda x: str(x))
    if len(syms) > _MAX_SYMBOLS:
        return None, None
    for 取值 in _SAMPLE_ROUNDS:
        mapping = {s: 取值[i] for i, s in enumerate(syms)}
        try:
            v = complex(N(diff.subs(mapping)))
        except Exception:
            continue
        if v != v or abs(v) == float("inf"):  # nan / zoo：这一轮踩到奇点，换下一轮
            continue
        if abs(v) > 1e-9:
            点 = "，".join(f"{s}={mapping[s]}" for s in syms)
            return 点, v
    return None, None


def _symbolic_calc(stem: str, answer: str):
    """符号恒等档 → (verdict, detail)；**不属于本档**（读不成代数式/两侧全是数）返回 None。"""
    from sympy import expand, simplify
    from sympy.printing import sstr

    ans_raw = _strip_answer_prefix(answer)
    if not ans_raw:
        return None  # 答案为空：数值档已经说清楚了，这里不重复
    try:
        expr, exprs = _parse_symbolic_expr(_strip_instructions(stem))
        ans, anss = _parse_symbolic_expr(ans_raw)
    except _CannotVerify:
        return None  # 不是纯代数式 —— 保留数值档那句更贴切的原因
    except Exception:
        return None

    # 🔴 两侧都没有未知量 ⇒ 这是纯数值题，归数值档，不许从符号档溜进来改结论
    if not (expr.free_symbols or ans.free_symbols):
        return None

    detail: dict = {"reason": "", "expr": exprs, "computed": None, "expected": None}
    try:
        detail["computed"] = sstr(expand(expr))
        detail["expected"] = sstr(expand(ans))
    except Exception:
        detail["computed"] = sstr(expr)
        detail["expected"] = sstr(ans)

    diff = None
    try:
        diff = expand(expr - ans)
        if diff == 0:
            detail["reason"] = f"符号恒等：题面式与答案式展开后完全相同（{detail['computed']}）"
            return "verified", detail
    except Exception:
        diff = None
    try:
        if simplify(expr - ans) == 0:
            detail["reason"] = f"符号恒等：simplify(题面 - 答案) = 0（{detail['computed']}）"
            return "verified", detail
    except Exception:
        pass

    if diff is None:
        detail["reason"] = "符号档：两式相减算不动（如实报，不猜）"
        return "cannot_verify", detail

    点, 值 = _counterexample(diff)
    if 点 is not None:
        detail["reason"] = (
            f"符号恒等不成立：题面式化为 {detail['computed']}，"
            f"答案式化为 {detail['expected']}（反证点 {点} 处两式相差 {值.real:g}）"
        )
        return "mismatch", detail

    # 🔴 化不到 0，也拿不出反证 ⇒ 判不了。不许拿"化不开"当红灯（假红比漏判贵）
    detail["reason"] = "符号档：既化不到 0 也找不到反证点，判不了（如实报，不猜）"
    return "cannot_verify", detail


# ---------------------------------------------------------------------------
# op: calc_verify（两档：数值档 → 符号档）
# ---------------------------------------------------------------------------


def _strip_answer_prefix(answer: str) -> str:
    """答案侧的壳：`答案：` / `解：` / 开头的等号。数值档与符号档共用同一口径。"""
    s = re.sub(r"^\s*(答案|答|解)\s*[:：]?\s*", "", (answer or "").strip())
    return re.sub(r"^[=＝]\s*", "", s).strip()


def _numeric_calc(stem: str, answer: str) -> tuple:
    """数值档（kb-sidecar/1 起的原口径，一个字没改）→ (verdict, detail)。"""
    from sympy import nsimplify
    from sympy.printing import sstr

    detail: dict = {"reason": "", "expr": None, "computed": None, "expected": None}
    try:
        expr, exprs = _parse_number_expr(_strip_instructions(stem))
    except _CannotVerify as e:
        detail["reason"] = f"题面读不成算式：{e}"
        return "cannot_verify", detail
    except Exception as e:  # sympy 深处的意外，也如实报 cannot_verify
        detail["reason"] = f"题面解析异常：{type(e).__name__}: {e}"
        return "cannot_verify", detail

    detail["expr"] = exprs
    try:
        detail["computed"] = sstr(nsimplify(expr) if expr.is_Float else expr)
    except Exception:
        detail["computed"] = sstr(expr)

    # 答案侧：剥掉"答案/解/=", 再走同一条解析路
    ans_raw = _strip_answer_prefix(answer)
    if not ans_raw:
        detail["reason"] = "答案为空，无从比对"
        return "cannot_verify", detail
    try:
        ans, anss = _parse_number_expr(ans_raw)
    except _CannotVerify as e:
        detail["reason"] = f"答案读不成数：{e}"
        return "cannot_verify", detail
    except Exception as e:
        detail["reason"] = f"答案解析异常：{type(e).__name__}: {e}"
        return "cannot_verify", detail

    detail["expected"] = anss
    if _equal(expr, ans):
        detail["reason"] = "实算与答案等值"
        return "verified", detail
    detail["reason"] = f"实算得 {detail['computed']}，答案是 {sstr(ans)}"
    return "mismatch", detail


def op_calc_verify(req: dict) -> dict:
    items = req.get("items")
    if not isinstance(items, list):
        raise _BadRequest("calc_verify 需要 items 数组：[{id, stem, answer, analysis?}]")

    results = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "id" not in item:
            raise _BadRequest(f"items[{i}] 缺 id")
        rid = item["id"]
        stem = str(item.get("stem") or "")
        answer = str(item.get("answer") or "")

        verdict, detail = _numeric_calc(stem, answer)
        # 🔴 符号档只接数值档判不了的那一批；数值档给了结论就到此为止（零回归）
        if verdict == "cannot_verify":
            sym = _symbolic_calc(stem, answer)
            if sym is not None:
                verdict, detail = sym

        results.append({"id": rid, "verdict": verdict, "detail": detail})

    return {"ok": True, "op": "calc_verify", "results": results}


# ---------------------------------------------------------------------------
# op: line_verify（逐行恒等）
# ---------------------------------------------------------------------------

# 等号（含全角）。⩵/≡ 之类不收：那是"恒等号"，写法罕见，收进来只会多一条猜测。
_EQ_SPLIT = re.compile(r"[=＝]")
# 「这一行是上一行的续行」：整行以等号开头（`= -8+3-54` 这种解析常见写法）
_CONT_LINE = re.compile(r"^[\s　]*[=＝]")
# 一行里出现比较号/不等号 ⇒ 不是恒等链（`a+c>0`、`27 < 50 < 64` 是判断句）
_COMPARE = re.compile(r"[<>≤≥≠]|&lt;|&gt;")
# 防炸：一道题最多看这么多行、做这么多次比对
_MAX_LINES = 200
_MAX_CHECKS = 120


def _chain_segments(line: str) -> list:
    """一行 → 等号切出来的片段（去空白后的非空片段）。"""
    return [seg.strip() for seg in _EQ_SPLIT.split(line) if seg.strip()]


def _numeric_value(seg: str):
    """片段 → sympy 数值；读不成纯数值表达式就返回 None（如实跳过，不猜）。"""
    try:
        expr, _norm = _parse_number_expr(seg)
    except Exception:
        # _CannotVerify（含未知量/含中文/触护栏）与 sympy 深处的意外，一律当"这段判不了"
        return None
    return expr


def _verify_one(lines: list) -> dict:
    """逐行恒等的核心（纯函数，无 IO）。

    链的语义（与 逐行恒等校验.py 的 expr 模式同源）：
      · 一条链的**首个可读片段**是基准（原式）；
      · 同一条链上此后的每个可读片段都必须与基准恒等；
      · 「以等号开头的行」= 上一行的续行，接着同一条链算；
        其余行另起一条链（多小问的解析里，(1)(2)(3) 各是各的链）。
    """
    from sympy import simplify
    from sympy.printing import sstr

    bad = []
    checked = 0
    chains = 0
    ref = None
    ref_text = ""

    for i, raw in enumerate(lines[:_MAX_LINES], 1):
        line = (raw or "").strip()
        if not line:
            continue
        # 判断句不是恒等链（`27 < 50 < 64`）—— 拿它去判恒等必出假红
        if _COMPARE.search(line):
            ref = None
            continue

        segs = _chain_segments(line)
        if not segs:
            continue

        if not _CONT_LINE.match(raw or ""):
            # 新起一条链：基准清空，由本行第一个可读片段重新定
            ref = None
            ref_text = ""

        for seg in segs:
            if checked >= _MAX_CHECKS:
                break
            v = _numeric_value(seg)
            if v is None:
                continue  # 文字/含未知量/读不成算式 —— 如实跳过
            if ref is None:
                ref, ref_text = v, seg
                chains += 1
                continue
            checked += 1
            try:
                same = simplify(ref - v) == 0
            except Exception:
                same = False
            if not same:
                bad.append(
                    {
                        "line": i,
                        "text": line,
                        "left": ref_text,
                        "right": seg,
                        "computed": sstr(v),
                        "expected": sstr(ref),
                    }
                )

    if bad:
        first = bad[0]
        return {
            "verdict": "line_mismatch",
            "checked": checked,
            "chains": chains,
            "badLines": bad,
            "reason": (
                f"第 {first['line']} 行断裂：「{first['right']}」算出 {first['computed']}，"
                f"而本链原式「{first['left']}」= {first['expected']}"
            ),
        }
    if checked == 0:
        return {
            "verdict": "no_checkable_lines",
            "checked": 0,
            "chains": chains,
            "badLines": [],
            "reason": "没有可机读的数值等式链（全是文字、含未知量或读不成算式）——如实报，不猜",
        }
    return {
        "verdict": "all_identical",
        "checked": checked,
        "chains": chains,
        "badLines": [],
        "reason": f"{chains} 条链共 {checked} 处比对全部恒等",
    }


def op_line_verify(req: dict) -> dict:
    items = req.get("items")
    if not isinstance(items, list):
        raise _BadRequest("line_verify 需要 items 数组：[{id, lines?|analysis?}]")

    results = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "id" not in item:
            raise _BadRequest(f"items[{i}] 缺 id")
        raw_lines = item.get("lines")
        if isinstance(raw_lines, list):
            # 显式给链：整条当**一条链**（首行 = 原式），与 逐行恒等校验.py expr 模式一致。
            # 实现上把首行之后的行都当续行，续行判据就是行首等号 —— 这里替调用方补上。
            lines = [str(x) for x in raw_lines]
            lines = [lines[0]] + [
                x if _CONT_LINE.match(x) else f"= {x}" for x in lines[1:]
            ]
        else:
            text = str(item.get("analysis") or item.get("text") or "")
            lines = text.splitlines()
        out = _verify_one(lines)
        out["id"] = item["id"]
        results.append(out)

    return {"ok": True, "op": "line_verify", "results": results}


# ---------------------------------------------------------------------------
# op: ping（探活 + 版本自报；node 侧诊断与 README 冒烟都用它）
# ---------------------------------------------------------------------------


def op_ping(_req: dict) -> dict:
    versions = {"python": sys.version.split()[0]}
    for mod in ("jieba", "sympy"):
        try:
            versions[mod] = __import__(mod).__version__
        except Exception as e:
            versions[mod] = f"缺失：{type(e).__name__}"
    return {"ok": True, "op": "ping", "sidecar": SIDECAR_VERSION, "versions": versions}


# ---------------------------------------------------------------------------
# 骨架
# ---------------------------------------------------------------------------


class _BadRequest(Exception):
    pass


class _CannotVerify(Exception):
    pass


_OPS = {
    "segment": op_segment,
    "calc_verify": op_calc_verify,
    "line_verify": op_line_verify,
    "ping": op_ping,
}


def handle(raw: str) -> dict:
    try:
        req = json.loads(raw)
    except Exception as e:
        return _err("BAD_REQUEST", f"stdin 不是合法 JSON：{e}", None)
    if not isinstance(req, dict):
        return _err("BAD_REQUEST", "请求必须是一个 JSON 对象", None)

    op = req.get("op")
    fn = _OPS.get(op) if isinstance(op, str) else None
    if fn is None:
        return _err("UNKNOWN_OP", f"不认识的 op：{op!r}（只有 {'/'.join(_OPS)}）", op)

    try:
        return fn(req)
    except _BadRequest as e:
        return _err("BAD_REQUEST", str(e), op)
    except Exception as e:
        return _err("INTERNAL", f"{type(e).__name__}: {e}", op)


def _err(code: str, message: str, op) -> dict:
    out: dict = {"ok": False, "error": {"code": code, "message": message}}
    if op is not None:
        out["op"] = op
    return out


def main() -> int:
    raw = sys.stdin.read()
    try:
        out = handle(raw)
    except Exception as e:  # 兜底：绝不裸崩，一律 JSON 报错
        out = _err("INTERNAL", f"{type(e).__name__}: {e}", None)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
