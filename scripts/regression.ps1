<#
.SYNOPSIS
  一键全量回归（AI:PRD-001 · WP7）—— 回归清单 A 组的正式载体。

.DESCRIPTION
  按序跑完所有关卡，逐关打 [PASS]/[FAIL]，**任一关红了也继续跑完**（一次跑完
  看到全部问题，比撞第一个就停手省一整轮），最后打汇总表，退出码 = 失败关数。

  跑法：
    powershell -File scripts\regression.ps1              # 全量（收卡自证就跑它）
    powershell -File scripts\regression.ps1 -Only A3b    # 只跑一关（调试用，前缀 REG- 可省）
    powershell -File scripts\regression.ps1 -Only REG-A1

  关卡（后续卡往 $gates 里追加，别另起炉灶）：
    REG-A3a  静态检查        lint + typecheck + format:check 三绿
    REG-A3b  依赖规则活性探针 往 src/app 塞一个违规 import，lint **必须红**
    REG-A1   对账六项        integrity-check.ts 退出码=red 数，须 0
    REG-A2   审计链校验      audit-verify.ts 从创世行起整链重算
    REG-TEST 单测全量        vitest（102 例基线）
    REG-A4   备份快照有效    backup-verify.ts 出新快照 + 独立只读复算

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
    Name   = '单测全量（vitest，102 例基线）'
    Action = {
      & pnpm test | Write-Host
      if ($LASTEXITCODE -ne 0) { return "vitest 退出码 $LASTEXITCODE（有用例挂了）" }
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
  Write-Host $bar
  Write-Host "全量回归 · AI:PRD-001"
  Write-Host "  仓根  ：$root"
  Write-Host "  开始  ：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
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


