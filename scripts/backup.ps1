<#
.SYNOPSIS
  资料库.db 每日快照（AI:PRD-001 · WP4 / R-SYS-0）。

.DESCRIPTION
  PowerShell 包装层：切到项目根 -> 调 tsx 薄脚本 -> 打人话摘要。
  真逻辑在 src/core/backup.ts（VACUUM INTO + 可选异地副本 + logMetric 留痕）。

  手跑：      .\scripts\backup.ps1
  指定类型：  .\scripts\backup.ps1 -Reason manual
  计划任务：  schtasks /create /tn "kf-backup" /tr "powershell -NoProfile -File D:\...\scripts\backup.ps1" /sc daily /st 23:30

  🔴 本文件存为 UTF-8 with BOM —— Windows PowerShell 5.1 对无 BOM 的脚本按 ANSI(GBK) 解，
     中文会变乱码。改完请确认 BOM 还在。
.PARAMETER Reason
  daily / batch / manual / pre-restore，默认 daily。
#>
[CmdletBinding()]
param(
  [ValidateSet('daily', 'batch', 'manual', 'pre-restore')]
  [string]$Reason = 'daily'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not (Test-Path (Join-Path $root '.env'))) {
    throw ".env 不在（$root\.env）：DATABASE_URL 读不到，先照 .env.example 建一份"
  }

  Write-Host "[backup] 项目根 = $root"
  Write-Host "[backup] reason = $Reason"
  $started = Get-Date

  & pnpm exec tsx --env-file=.env scripts/backup.ts --reason $Reason
  if ($LASTEXITCODE -ne 0) {
    throw "备份脚本退出码 $LASTEXITCODE —— 快照没出成，别当成功记账"
  }

  $secs = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Write-Host "[backup] 完成，用时 $secs 秒"
}
finally {
  Pop-Location
}
