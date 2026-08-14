<#
.SYNOPSIS
  一键全量回归（AI:PRD-001 · WP7 / AI:PRD-002 · 002-E / AI:PRD-003 · 003-E /
  AI:PRD-004 · 004-D / AI:PRD-005 · 005-D / AI:PRD-006 · 006-B）—— 回归清单 A~F 六组的正式载体。

.DESCRIPTION
  按序跑完所有关卡，逐关打 [PASS]/[FAIL]，**任一关红了也继续跑完**（一次跑完
  看到全部问题，比撞第一个就停手省一整轮），最后打汇总表，退出码 = 失败关数。

  🔴 跑完还会把**战报落库**（metric_event kind=regression，经
     scripts/regression-report.ts）——/health 的「回归最近一跑」读的就是它。
     那是一次库写（连带审计行），所以固定在全部关卡之后跑；写失败只警告，
     不改本轮结论（退出码仍 = 失败关数）。

  跑法：
    powershell -File scripts\regression.ps1              # 全量（收卡自证就跑它）
    powershell -File scripts\regression.ps1 -Only A3b    # 只跑一关（调试用，前缀 REG- 可省）
    powershell -File scripts\regression.ps1 -Only REG-A1

  关卡（后续卡往 $gates 里追加，别另起炉灶）：
    REG-A3a  静态检查        lint + typecheck + format:check 三绿
    REG-A3b  依赖规则活性探针 往 src/app 塞一个违规 import，lint **必须红**
    REG-A1   对账六项        integrity-check.ts 退出码=red 数，须 0
    REG-A2   审计链校验      audit-verify.ts 从创世行起整链重算
    REG-TEST 单测全量        vitest（全量基线）
    REG-B    KG 金标         tests/kg-golden.test.ts 单跑（B1~B4）
    REG-C    录题+产线接入   闸单测 + 管道端到端 + 金标重放 + 队列三链（C1~C4）
                             + 产线转换器 + SKU/模型链（C5~C6，AI:PRD-005）
    REG-D    检索            评测集不低于基线 + 命中来源标注 + FTS 注入安全（D1~D3）
    REG-E    产线流程与族谱  出册干跑全链 + 已售题拦截归因 + 变式族谱完整（E1~E3）
    REG-F    学情读侧        挂桥对数快照 + 错因三形态 + 圣域 schema hash + 只读物理验证（F1~F4）
    REG-A4   备份快照有效    backup-verify.ts 出新快照 + 独立只读复算

  🔴 REG-B / REG-C / REG-D 单独成关而不是「TEST 里已经跑过了」：触发矩阵里
     它们各自有一条 ——
     「KG 数据（导底/重整/合并）→ B 全 + A1②」、
     「core/gates 或 ingest → C 全 + A1 + G1」、
     「🔴 retrieval / 分词 / embedding → **D 全 + B1 + A1③（embed 版本单一性）**」。
     改了那一片要能 `-Only B` / `-Only C` / `-Only D` 只跑对应金标，十几秒出结论，
     不必每次都陪跑整轮单测。
     （D 组还有一条独有的触发面：**评测集或基准文件本身被改动** —— 那等于改了尺子，
       必须当场 `-Only D` 跑一遍看尺子还准不准。）

  🔴 REG-E 的触发面（AI:PRD-005 · 005-D，三条）：
     ① **转换器 / kb-submit CLI / 出册前置闸（convert-punch、dedup、kb-submit.ts）改动**
        → E 全 + C 全（E1 走的正是「转换 → 排重 → 登记 dry-run」那条链）；
     ② **dicts/ 两张映射表改动**（考点表、模型表）→ E 全。改映射表 = 改「产线说法指向谁」，
        指错了不会报错、只会悄悄挂到别的考点/别的模型上，只有 E1 那条
        「20 题必须全部带 modelId」的断言抓得住；
     ③ **exam_model / question.model_id / origin_qids_json 的数据变动**
        （新登记模型、拿模型出题入库、setModelOrigins）→ **E 全 + A1**。
        🔴 尤其是「拿一个新模型生成题并入库」：E3b 会当场问它「母题呢」。
     另有一条被动触发：**E1 夹具红了**。夹具永不入库，它撞库 = 库里灌进了同题
     （或查重的尺子变了）—— 去查那批题，别回来换夹具。

  🔴 D1 的基准（tests/fixtures/eval-baseline-20260813.json）**入 git**。
     它红了的正确反应是查检索改动，不是回来 `--baseline` 重立基准把红旗按灭；
     真要重立（比如库里新灌了一批题），重立那次得单独 commit 并说明原因。

  🔴 每月一次的「真库全恢复演练」(restore-drill --yes) **不在本脚本里**，
     它会真删库文件，必须人守着跑 —— 结尾 NOTE 只提示，不代劳。

  🔴 本文件存为 UTF-8 with BOM —— Windows PowerShell 5.1 对无 BOM 的脚本按
     ANSI(GBK) 解，中文会变乱码。改完请确认 BOM 还在。
  🔴 不写死绝对路径：仓根一律由 $PSScriptRoot 反推，整个目录搬走也照跑。

.PARAMETER Only
  只跑某一关，取 Id（REG-A3b）或去掉前缀的短名（A3b）。默认全跑。
#>
[CmdletBinding()]
param(
  [string]$Only
)

$ErrorActionPreference = 'Stop'

# 让中文在「被重定向到文件/管道」时也是 UTF-8（控制台是 GBK 时同样有效：
# 设 OutputEncoding 会顺带把控制台输出代码页切到 65001）。切不动就算了，不为这个停手。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}
catch {
  Write-Verbose "控制台编码没切成 UTF-8（不影响关卡结果）：$($_.Exception.Message)"
}

# 🔴 仓根 = scripts/ 的上一级，不写死路径
$root = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# 关卡定义
#   Action 约定：PASS 返回 $null，FAIL 返回一句人话原因（字符串）。
#   🔴 关卡内跑命令一律 `| Write-Host`：既能实时看到子进程输出，又不让它污染
#      Action 的返回值（不加管道的话 pnpm 的每一行 stdout 都会变成"返回值"，
#      于是每关都被判成 FAIL —— 这个坑踩过一次就够了）。
# ---------------------------------------------------------------------------
$gates = @(
  [pscustomobject]@{
    Id     = 'REG-A3a'
    Name   = '静态检查（lint + typecheck + format:check）'
    Action = {
      $bad = @()
      foreach ($s in 'lint', 'typecheck', 'format:check') {
        Write-Host "  -> pnpm $s"
        & pnpm $s | Write-Host
        if ($LASTEXITCODE -ne 0) { $bad += "pnpm $s 退出码 $LASTEXITCODE" }
      }
      if ($bad.Count -gt 0) { return ($bad -join '；') }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-A3b'
    Name   = '依赖规则活性探针（app 层禁直连 db，红=通过）'
    Action = {
      # 🔴 反证闸：常绿的闸等于没有闸。这里故意造一个**应该被拦下**的文件，
      #    lint 红了才算规则活着；lint 绿了说明依赖红线已经失效（配置被改坏 /
      #    files 范围漂了 / 插件没加载），那是本关要抓的事故。
      # 文件名带随机后缀：万一上次异常退出留了残骸，也不会撞车。
      $tag = [Guid]::NewGuid().ToString('N').Substring(0, 8)
      $rel = "_reg-probe-$tag.ts"
      $probe = Join-Path $root (Join-Path 'src/app' $rel)
      try {
        # 无 BOM 写入（.ts 文件不该带 BOM）；内容是纯 ASCII
        [IO.File]::WriteAllText(
          $probe,
          "import {} from `"drizzle-orm`";" + [Environment]::NewLine,
          (New-Object System.Text.UTF8Encoding($false))
        )
        Write-Host "  -> 探针 src/app/$rel  内容：import {} from `"drizzle-orm`";"
        Write-Host "  -> pnpm lint（期望红）"
        $out = & pnpm lint
        $code = $LASTEXITCODE
        $text = ($out | Out-String)
        Write-Host $text.TrimEnd()

        if ($code -eq 0) {
          return '🔴 规则死了：探针在 src/app 里 import drizzle-orm，pnpm lint 竟然全绿'
        }
        if ($text -notmatch 'no-restricted-imports') {
          return "lint 是红了，但不是被依赖红线拦的（输出里没有 no-restricted-imports）——红对了地方才算数"
        }
        if ($text -notmatch [regex]::Escape($rel)) {
          return "lint 是红了，但红的不是探针文件（输出里没提到 $rel）"
        }
        return $null
      }
      finally {
        # 🔴 无论上面怎么走，探针必须消失：留在 src/app 里会把后面每一次 lint 都染红
        if (Test-Path -LiteralPath $probe) {
          try {
            Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
            Write-Host "  -> 探针已删除"
          }
          catch {
            Write-Warning "🔴 探针没删掉，请手工删：$probe（$($_.Exception.Message)）"
          }
        }
      }
    }
  },

  [pscustomobject]@{
    Id     = 'REG-A1'
    Name   = '对账六项 C1~C6（red=0 放行，warn 不拦）'
    Action = {
      & pnpm exec tsx --env-file=.env scripts/integrity-check.ts | Write-Host
      if ($LASTEXITCODE -ne 0) {
        return "对账有 $LASTEXITCODE 项 red（该脚本退出码 = red 项数；warn 按 M1 口径不拦）"
      }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-A2'
    Name   = '审计链校验（从创世行整链重算）'
    Action = {
      & pnpm exec tsx --env-file=.env scripts/audit-verify.ts | Write-Host
      if ($LASTEXITCODE -ne 0) { return '审计链断了（断点 seq 见上面输出）' }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-TEST'
    Name   = '单测全量（vitest，342 例基线）'
    Action = {
      & pnpm test | Write-Host
      if ($LASTEXITCODE -ne 0) { return "vitest 退出码 $LASTEXITCODE（有用例挂了）" }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-B'
    Name   = 'KG 金标（B1 十条 / B2 双版本 / B3 合并无悬挂 / B4 编造 id）'
    Action = {
      # 🔴 单跑金标文件：触发矩阵「KG 数据变更 → B 全 + A1②」时 -Only B 就够了。
      #    金标 B1/B2/B4 直接打**真库**且只读（文件末尾有行数自证），
      #    B3 要真合并所以走 VACUUM INTO 副本 —— 库被改动过，这一关会先红。
      & pnpm exec vitest run tests/kg-golden.test.ts | Write-Host
      if ($LASTEXITCODE -ne 0) {
        return "KG 金标红了（哪条见上面输出）——KG 数据动过就重核期望值，别顺手改金标把红旗按灭"
      }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-C'
    Name   = '录题管道 + 产线接入（C1 逐闸红绿 / C2 金标重放 / C3 题干图必审 / C4 实算+逐行恒等 / C5 转换器 / C6 SKU·模型链）'
    Action = {
      # 🔴 六个文件一起跑才叫 C 组：
      #    ingest-gates  = C1 逐闸一红一绿（十道闸各自的判定）
      #    ingest        = 管道端到端（页页有账 / dryRun 零写 / 隔离 / 对账）
      #    ingest-golden = C2 金标重放 + C3 题干图必审 + C4 实算与逐行恒等
      #    queue-flows   = 图审/草稿/隔离三条处置链（红灯题的去处，和 C3 是同一条链的下半截）
      #    🆕 AI:PRD-005 · 005-B（这两条与录题是同一条链的上下游，跟着 C 组一起跑）：
      #    convert-punch = C5 产线三形态 → kb-ingest/v1（搬运/归一/未知字段透传）
      #    sku-model     = C6 SKU 原语 + 幽灵映射防线 + 模型 propose→activate
      #                    （含「未 active 模型的题被闸② 拦下」的联通验证 —— 它同时是闸②的活性探针）
      # 🔴 C2/C4 打**真库**且零写（dryRun）：金标验的就是「库现在这个状态下这份料被怎么判」，
      #    所以库被清空/重灌之后它会红 —— 红对了，那说明库不是收卡时那个库。
      & pnpm exec vitest run tests/ingest-gates.test.ts tests/ingest.test.ts tests/ingest-golden.test.ts tests/queue-flows.test.ts tests/convert-punch.test.ts tests/sku-model.test.ts | Write-Host
      if ($LASTEXITCODE -ne 0) {
        return "录题管道回归红了（哪条见上面输出）——闸的判定或管道行为漂了，先查是改对了还是改坏了，别顺手改基准把红旗按灭"
      }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-D'
    Name   = '检索（D1 评测集不低于基线 / D2 命中来源标注 / D3 FTS 注入安全）'
    Action = {
      # 🔴 三小关一起跑才叫 D 组（回归清单 D 组三条）：
      #    D1 = 37 条真实查询（32 正 + 5 负）过评测集，四个总指标与 git 里的基准比，
      #         任一跌破容忍 0.02 或负样本变脏 → 脚本自己退 1 并写 metric_event；
      #    D2 = 拿**最近 20 条真实检索打点**重放，断言每条命中都带 sources 来源标注、
      #         且语意轴贡献计数从打点里取得出来（语意轴退出判据的取数面得一直活着）；
      #    D3 = FTS 注入用例（MATCH 语法字符进不来），挂 vitest 过滤单跑。
      # 🔴 D1/D2 打**真库**且零写（评测全程 metric:false）：评测不许污染真查询日志，
      #    否则下一轮评测集会从自己的回声里抽料。
      $bad = @()

      Write-Host '  -> D1 评测集回归（scripts/eval-retrieval.ts，对基准无下降）'
      & pnpm exec tsx --env-file=.env scripts/eval-retrieval.ts | Write-Host
      if ($LASTEXITCODE -eq 1) {
        $bad += 'D1 指标跌破容忍（已写 metric_event kind=eval_regression_red，逐项 Δ 见上面输出）——先弄清检索是改对了还是改坏了，别重立基准把红旗按灭'
      }
      elseif ($LASTEXITCODE -eq 2) {
        $bad += 'D1 找不到基准文件 tests/fixtures/eval-baseline-20260813.json —— 先跑一次 scripts/eval-retrieval.ts --baseline'
      }
      elseif ($LASTEXITCODE -ne 0) {
        $bad += "D1 评测脚本自身出错（退出码 $LASTEXITCODE）"
      }

      Write-Host '  -> D2 最近 20 条真检索打点重放：每条命中带 sources + 语意轴贡献计数可取'
      & pnpm exec tsx --env-file=.env scripts/eval-retrieval.ts --audit-sources --n 20 | Write-Host
      if ($LASTEXITCODE -ne 0) { $bad += 'D2 来源标注审计红了（哪条见上面输出）' }

      # 🔴 过滤器用纯 ASCII 的 MATCH：中文参数经 PS5.1 传给原生 exe 要过 ANSI 代码页，
      #    没必要在闸上赌编码。空跑（一条都没选中）也判红 —— 常绿的闸等于没有闸。
      Write-Host '  -> D3 FTS 注入用例（vitest -t MATCH）'
      $out = & pnpm exec vitest run tests/retrieval.test.ts -t MATCH
      $code = $LASTEXITCODE
      $text = ($out | Out-String)
      Write-Host $text.TrimEnd()
      if ($code -ne 0) {
        $bad += 'D3 FTS 注入用例红了（拼串禁令的机器背书失效）'
      }
      elseif ($text -notmatch 'Tests\s+1 passed') {
        $bad += 'D3 过滤器没恰好选中 1 条用例（名字改了/用例被删了）—— 空跑判红，不许假绿'
      }

      if ($bad.Count -gt 0) { return ($bad -join '；') }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-E'
    Name   = '产线流程与族谱（E1 出册干跑 / E2 已售题拦截归因 / E3 变式族谱完整）'
    Action = {
      # 🔴 三关一个文件（tests/lineage-flow.test.ts），全部打**真库**且零写：
      #    E1 = recipe→选题→全库排重断言→登记 dry-run 四步全链绿（夹具永不入库）；
      #    E2 = 新册料里混进一道已售天卷真题 ⇒ 必拦，且回执指名「哪本册子第几题」；
      #    E3 = 变式↔母题双向可达 + **全库口径**「模型有生成题就必须有血缘上游」。
      # 🔴 E3 放在这儿而不是塞进对账六项：对账是 M1 §5「孤儿对账」的机读镜像
      #    （integrity.ts 文件头写着「不多不少」），而 E3 问的是工艺纪律有没有被遵守
      #    （数据完全自洽，只是有人拿说不出母题的模型出了题）。理由全文见测试文件头。
      & pnpm exec vitest run tests/lineage-flow.test.ts | Write-Host
      if ($LASTEXITCODE -ne 0) {
        return "产线流程/族谱回归红了（哪条见上面输出）——E1 红先查库里是不是灌进了同题；E3 红是有模型在出题却说不出母题，去补 origin，别改断言"
      }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-F'
    Name   = '学情读侧（F1 挂桥对数快照 / F2 错因三形态 / F3 圣域 schema hash / F4 只读物理验证）'
    Action = {
      # 🔴 四关一个文件（tests/gradebridge.test.ts），触发面 = 触发矩阵那条
      #    「学情读侧 / 挂桥 → F 全」，外加 schema/migration 那条也带 F3。
      #    F1/F2 打**真库 + 真圣域**且零写：快照验的就是「库现在这个状态下桥搭成什么样」，
      #    造假数据验等于验了个寂寞；要写的错因域原语跑在 VACUUM INTO 的副本上。
      # 🔴 圣域零写有机器背书：文件头尾各取一次 sha256/size/mtime，跑完必须逐位相同
      #    （afterAll 里断言），并确认没留下 -wal/-shm。
      # 🔴 F3 红了的正确反应是**人工重新快照并评估**（批改线改了表，我们的读侧口径
      #    可能已经错了），不是回来重跑快照脚本把红旗按灭 —— 这条写在测试的失败信息里。
      # 🔴 F1 基准（tests/fixtures/reg-f1-挂桥快照-20260813.json）**入 git**。
      #    需求卡/回归清单里写的「小崽子×2/鼻涕虫×1」是立卡当天的旧数，已被实况取代
      #    （实为 batch 10/13/14），基准文件里记着这件事。新批次只增不改旧：
      #    batch 总数涨了不判红，旧的那三条挂桥结果变了才判红。
      & pnpm exec vitest run tests/gradebridge.test.ts | Write-Host
      if ($LASTEXITCODE -ne 0) {
        return "学情读侧回归红了（哪条见上面输出）——F1 红先看是不是补录了桥（那就改基准并说明）；F3 红走人工重新快照评估；🔴 F4 红 = 圣域只读防线破了，立刻停手查是谁写的"
      }
      return $null
    }
  },

  [pscustomobject]@{
    Id     = 'REG-A4'
    Name   = '备份快照有效（出新快照 + 独立只读复算）'
    Action = {
      & pnpm exec tsx --env-file=.env scripts/backup-verify.ts | Write-Host
      if ($LASTEXITCODE -ne 0) { return '新出的快照没通过复算断言（哪条挂了见上面输出）' }
      return $null
    }
  }
)

# ---------------------------------------------------------------------------
# 选关
# ---------------------------------------------------------------------------
$selected = $gates
if ($Only) {
  $key = $Only.Trim()
  if ($key -notmatch '^(?i)REG-') { $key = "REG-$key" }
  $selected = @($gates | Where-Object { $_.Id -ieq $key })
  if ($selected.Count -eq 0) {
    throw "-Only $Only 认不出来。可选：$(($gates | ForEach-Object { $_.Id }) -join '、')"
  }
}

# ---------------------------------------------------------------------------
# 跑
# ---------------------------------------------------------------------------
Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root '.env'))) {
    throw ".env 不在（$root\.env）：DATABASE_URL 读不到，先照 .env.example 建一份"
  }

  $bar = '=' * 78
  $startedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'
  Write-Host $bar
  Write-Host "全量回归 · AI:PRD-001 + AI:PRD-002 + AI:PRD-003 + AI:PRD-004 + AI:PRD-005 + AI:PRD-006（A/B/C/D/E/F 六组）"
  Write-Host "  仓根  ：$root"
  Write-Host "  开始  ：$startedAt"
  Write-Host "  关卡  ：$($selected.Count) 关（$(($selected | ForEach-Object { $_.Id }) -join '、')）"
  Write-Host $bar

  $results = @()
  $allSw = [System.Diagnostics.Stopwatch]::StartNew()

  foreach ($g in $selected) {
    Write-Host ''
    Write-Host ('-' * 78)
    Write-Host "$($g.Id)  $($g.Name)"
    Write-Host ('-' * 78)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $reason = $null
    try {
      $reason = & $g.Action
    }
    catch {
      # 关卡自己抛了（命令不存在、探针写不进去…）也算这一关 FAIL，不中断整轮
      $reason = "关卡自身抛异常：$($_.Exception.Message)"
    }
    $sw.Stop()

    # Action 里若不慎多吐了东西，只取最后一句非空的当原因
    if ($reason -is [array]) {
      $reason = ($reason | Where-Object { $_ } | Select-Object -Last 1)
    }
    $ok = [string]::IsNullOrWhiteSpace([string]$reason)
    $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)

    $results += [pscustomobject]@{
      Id     = $g.Id
      Name   = $g.Name
      Ok     = $ok
      Secs   = $secs
      Reason = [string]$reason
    }

    if ($ok) {
      Write-Host "[PASS] $($g.Id) $($g.Name) ($secs 秒)"
    }
    else {
      Write-Host "[FAIL] $($g.Id) $($g.Name) ($secs 秒)"
      Write-Host "       原因：$reason"
    }
  }

  $allSw.Stop()
  $failed = @($results | Where-Object { -not $_.Ok })

  Write-Host ''
  Write-Host $bar
  Write-Host "汇总（$([math]::Round($allSw.Elapsed.TotalSeconds, 1)) 秒）"
  Write-Host $bar
  foreach ($r in $results) {
    $tag = if ($r.Ok) { '[PASS]' } else { '[FAIL]' }
    Write-Host ("  {0} {1} {2} {3}" -f $tag, $r.Id.PadRight(9), ("$($r.Secs)s").PadLeft(7), $r.Name)
    if (-not $r.Ok) { Write-Host "                             原因：$($r.Reason)" }
  }
  Write-Host ('-' * 78)
  if ($failed.Count -eq 0) {
    Write-Host "结论：全量回归通过（$($results.Count)/$($results.Count) 关绿）"
  }
  else {
    Write-Host "结论：🔴 $($failed.Count) 关红（$(($failed | ForEach-Object { $_.Id }) -join '、')），$($results.Count - $failed.Count) 关绿"
  }
  # -------------------------------------------------------------------------
  # 战报落库（AI:PRD-008 验收缺陷修复）
  #
  # 🔴 为什么非写不可：不写，/health 的「回归 11 关最近一跑」就永远没有数据 ——
  #    人只能凭记忆说"上次好像是绿的"。战报落 metric_event（kind=regression），
  #    页面照它显示时间与逐关红绿。
  # 🔴 位置固定在**所有关卡跑完之后**：这是一次库写（连带一条审计行），
  #    跑在中途会被 REG-A2（审计链校验）撞见自己刚造出来的行。
  # 🔴 写失败**不改本轮结论**：退出码仍然 = 失败关数（战报是账，不是判据）。
  # -------------------------------------------------------------------------
  $report = [pscustomobject]@{
    ok         = ($failed.Count -eq 0)
    total      = $results.Count
    passed     = ($results.Count - $failed.Count)
    failed     = $failed.Count
    secs       = [math]::Round($allSw.Elapsed.TotalSeconds, 1)
    only       = $(if ($Only) { $Only.Trim() } else { '' })
    startedAt  = $startedAt
    finishedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
    gates      = @($results | ForEach-Object {
        [pscustomobject]@{
          id     = $_.Id
          name   = $_.Name
          ok     = $_.Ok
          secs   = $_.Secs
          reason = $_.Reason
        }
      })
  }
  $reportFile = Join-Path ([IO.Path]::GetTempPath()) "kf-regression-$([Guid]::NewGuid().ToString('N').Substring(0,8)).json"
  try {
    # 🔴 无 BOM 的 UTF-8：Out-File 会写 BOM，Node 的 JSON.parse 撞上它就抛
    [IO.File]::WriteAllText(
      $reportFile,
      ($report | ConvertTo-Json -Depth 5),
      (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host ''
    Write-Host '  -> 战报落库（metric_event kind=regression）'
    & pnpm exec tsx --env-file=.env scripts/regression-report.ts $reportFile | Write-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "战报没落库（退出码 $LASTEXITCODE）——本轮结论不受影响，但 /health 的「最近一跑」还是旧的"
    }
  }
  catch {
    Write-Warning "战报没落库：$($_.Exception.Message)（本轮结论不受影响）"
  }
  finally {
    if (Test-Path -LiteralPath $reportFile) {
      Remove-Item -LiteralPath $reportFile -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Host ''
  Write-Host "NOTE 每月一次的【真库全恢复演练】不在本脚本里（它会真删库文件，必须人守着跑）："
  Write-Host "     pnpm exec tsx --env-file=.env scripts/restore-drill.ts --yes"
  Write-Host "     跑之前先关掉 Next dev / DB 客户端；不带 --yes 只打印计划不动库。"
  Write-Host $bar

  exit $failed.Count
}
finally {
  Pop-Location
}


