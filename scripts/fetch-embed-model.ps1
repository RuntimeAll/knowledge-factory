<#
.SYNOPSIS
  拉本地句向量模型 bge-small-zh-v1.5（ONNX）到 models\（AI:PRD-004 · 004-A）。

.DESCRIPTION
  模型文件 95MB，**刻意不进 git**（仓库会被撑死）。换机 / 新 clone / 手滑删了，
  跑一次本脚本重建即可。跑第二次会按 Sha256 跳过已经对得上的文件。

  🔴 源 = **ModelScope 直连**，不是 HuggingFace。
     本机 HF 大文件走代理会被掐（记忆在案：大模型走 ModelScope），
     ModelScope 直连稳定且不需要 token。仓库 Xenova/bge-small-zh-v1.5 是
     官方 BAAI 权重的 ONNX 导出（同一份 tokenizer.json / vocab.txt）。

  🔴 每个文件都比对 **ModelScope API 给的 Sha256**，对不上就删掉重来（最多 3 次），
     三次还不对就红着退出。半截文件是最难查的一类故障：
     ONNX 会话建不起来只报一句 "Protobuf parsing failed"，谁也想不到是没下完。

.PARAMETER Force
  已存在且校验通过的文件也重下（换 Revision、怀疑本地被改过时用）。

.PARAMETER OutDir
  落地目录，默认 <仓根>\models\bge-small-zh-v1.5

.EXAMPLE
  powershell -File scripts\fetch-embed-model.ps1
  powershell -File scripts\fetch-embed-model.ps1 -Force

.NOTES
  🔴 本文件存为 UTF-8 with BOM —— Windows PowerShell 5.1 对无 BOM 的脚本按
     ANSI(GBK) 解，中文会变乱码。改完请确认 BOM 还在。
  🔴 不写死绝对路径：仓根一律由 $PSScriptRoot 反推。
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'models\bge-small-zh-v1.5' }

$repo = 'Xenova/bge-small-zh-v1.5'
$revision = 'master'
# 要哪几个文件（前三个是运行时刚需，后三个留着做 provenance / 人工核对）
$want = @(
  'onnx/model.onnx',
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
  'vocab.txt',
  'special_tokens_map.json'
)
# onnx/model.onnx 落地时拍平成 model.onnx（core/embed.ts 按扁平结构找）
function Get-LocalName([string]$path) { return Split-Path -Leaf $path }

Write-Host '=============================================================================='
Write-Host "本地句向量模型拉取（AI:PRD-004 · 004-A）"
Write-Host "  源仓库 : modelscope.cn/models/$repo  (Revision=$revision)"
Write-Host "  落地   : $OutDir"
Write-Host "  模式   : $(if ($Force) { '强制重下 (-Force)' } else { '已校验通过的跳过' })"
Write-Host '=============================================================================='

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---------------------------------------------------------------------------
# 1) 问 ModelScope 要文件清单（拿 Size + Sha256 当校验基准）
# ---------------------------------------------------------------------------
function Get-RepoFiles([string]$sub) {
  $u = "https://www.modelscope.cn/api/v1/models/$repo/repo/files?Revision=$revision"
  if ($sub) { $u += "&Root=$sub" }
  # 🔴 --noproxy "*"：本机挂着代理，ModelScope 要直连
  $json = & curl.exe -sL --noproxy '*' -m 60 $u
  if ($LASTEXITCODE -ne 0) { throw "问 ModelScope 要文件清单失败（curl 退出码 $LASTEXITCODE）：$u" }
  return ($json | ConvertFrom-Json).Data.Files
}

Write-Host ''
Write-Host '① 取远端文件清单…'
$meta = @{}
foreach ($f in (Get-RepoFiles $null)) { $meta[$f.Path] = $f }
foreach ($f in (Get-RepoFiles 'onnx')) { $meta[$f.Path] = $f }

$missing = $want | Where-Object { -not $meta.ContainsKey($_) }
if ($missing) { throw "远端仓库里找不到这些文件：$($missing -join '、') —— Revision 变了？" }

foreach ($p in $want) {
  Write-Host ("   {0,-28} {1,12:N0} bytes" -f $p, $meta[$p].Size)
}

# ---------------------------------------------------------------------------
# 2) 逐个下载 + Sha256 校验（最多重试 3 次）
# ---------------------------------------------------------------------------
function Test-File([string]$local, $remote) {
  if (-not (Test-Path $local)) { return $false }
  if ((Get-Item $local).Length -ne $remote.Size) { return $false }
  if ($remote.Sha256) {
    $h = (Get-FileHash -Path $local -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $remote.Sha256.ToLower()) { return $false }
  }
  return $true
}

Write-Host ''
Write-Host '② 下载并校验…'
$bad = @()
foreach ($p in $want) {
  $remote = $meta[$p]
  $local = Join-Path $OutDir (Get-LocalName $p)
  if (-not $Force -and (Test-File $local $remote)) {
    Write-Host ("   [SKIP] {0}  已存在且 Sha256 对得上" -f (Get-LocalName $p))
    continue
  }
  $url = "https://www.modelscope.cn/api/v1/models/$repo/repo?Revision=$revision&FilePath=$p"
  $ok = $false
  for ($try = 1; $try -le 3 -and -not $ok; $try++) {
    Write-Host ("   [GET ] {0}  (第 {1} 次)" -f (Get-LocalName $p), $try)
    & curl.exe -sL --noproxy '*' -m 1800 -o $local $url
    if ($LASTEXITCODE -ne 0) {
      Write-Host ("          curl 退出码 {0}，重来" -f $LASTEXITCODE)
      continue
    }
    if (Test-File $local $remote) { $ok = $true; break }
    Write-Host '          🔴 大小/Sha256 对不上（下了半截？），删掉重来'
    Remove-Item -Force -ErrorAction SilentlyContinue $local
  }
  if ($ok) {
    Write-Host ("   [OK  ] {0}  {1:N0} bytes" -f (Get-LocalName $p), (Get-Item $local).Length)
  }
  else {
    $bad += $p
    Write-Host ("   [FAIL] {0}  三次都没下对" -f (Get-LocalName $p))
  }
}

# ---------------------------------------------------------------------------
# 3) 收尾
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '------------------------------------------------------------------------------'
if ($bad.Count -gt 0) {
  Write-Host "🔴 失败：$($bad -join '、')"
  Write-Host '   先确认能直连 modelscope.cn（curl.exe -sI --noproxy "*" https://www.modelscope.cn），再重跑。'
  exit 1
}
Write-Host "模型就位：$OutDir"
Write-Host '下一步：'
Write-Host '  1) .env 里确认  EMBED_MODEL_VER="bge-small-zh-v1.5"'
Write-Host '  2) 自检         pnpm exec tsx --env-file=.env -e "import(''./src/core/index.ts'').then(async m=>{const [v]=await m.embedTexts([''试一下'']);console.log(''维度'',v.length)})"'
Write-Host '  3) 回填存量     pnpm exec tsx --env-file=.env scripts\backfill-embed-20260813.ts --commit'
exit 0
