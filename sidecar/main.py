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
    🔴 cannot_verify 是**如实报**，绝不猜：应用题、含未知量的化简、单位换算…
       一律 cannot_verify，把判档权交回上游，不许"看着像对的"就给 verified。

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

SIDECAR_VERSION = "kb-sidecar/2"

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
# op: calc_verify
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


def op_calc_verify(req: dict) -> dict:
    from sympy import nsimplify
    from sympy.printing import sstr

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

        detail: dict = {"reason": "", "expr": None, "computed": None, "expected": None}
        try:
            expr, exprs = _parse_number_expr(_strip_instructions(stem))
        except _CannotVerify as e:
            detail["reason"] = f"题面读不成算式：{e}"
            results.append({"id": rid, "verdict": "cannot_verify", "detail": detail})
            continue
        except Exception as e:  # sympy 深处的意外，也如实报 cannot_verify
            detail["reason"] = f"题面解析异常：{type(e).__name__}: {e}"
            results.append({"id": rid, "verdict": "cannot_verify", "detail": detail})
            continue

        detail["expr"] = exprs
        try:
            detail["computed"] = sstr(nsimplify(expr) if expr.is_Float else expr)
        except Exception:
            detail["computed"] = sstr(expr)

        # 答案侧：剥掉"答案/解/=", 再走同一条解析路
        ans_raw = re.sub(r"^\s*(答案|答|解)\s*[:：]?\s*", "", answer.strip())
        ans_raw = re.sub(r"^[=＝]\s*", "", ans_raw).strip()
        if not ans_raw:
            detail["reason"] = "答案为空，无从比对"
            results.append({"id": rid, "verdict": "cannot_verify", "detail": detail})
            continue
        try:
            ans, anss = _parse_number_expr(ans_raw)
        except _CannotVerify as e:
            detail["reason"] = f"答案读不成数：{e}"
            results.append({"id": rid, "verdict": "cannot_verify", "detail": detail})
            continue
        except Exception as e:
            detail["reason"] = f"答案解析异常：{type(e).__name__}: {e}"
            results.append({"id": rid, "verdict": "cannot_verify", "detail": detail})
            continue

        detail["expected"] = anss
        if _equal(expr, ans):
            detail["reason"] = "实算与答案等值"
            results.append({"id": rid, "verdict": "verified", "detail": detail})
        else:
            detail["reason"] = f"实算得 {detail['computed']}，答案是 {sstr(ans)}"
            results.append({"id": rid, "verdict": "mismatch", "detail": detail})

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
