<#
  为源码包准备一个"项目自带"的 Node 运行时：runtime\node\node.exe

  为什么需要它：
  启动器（scripts\start-jingyin-board.ps1）第一优先级就是找
  <源码目录>\runtime\node\node.exe。只要源码包里带着这个文件，
  不管目标机器有没有装 Node、PATH 里有没有 node，双击启动器都能跑起来。

  这个脚本会：
    1. 先在机器上找一个**可用**的 node.exe（优先官方签名，优先较新的 LTS）
    2. 校验它能跑 `node -v` 且主版本满足项目要求
    3. 复制到 <源码目录>\runtime\node\node.exe
    4. 再校验一次复制结果

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-local-node.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-local-node.ps1 -Source "D:\somewhere\node.exe"
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision-local-node.ps1 -Force

  本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 才能正确读中文）。
#>
param(
  [string]$Source = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $AppDir "runtime\node"
$Target = Join-Path $TargetDir "node.exe"
$MinMajor = 20

function Get-NodeVersionInfo([string]$ExePath) {
  try {
    $output = & $ExePath -v 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
  } catch {
    return $null
  }
  $first = @($output) | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($first)) { return $null }
  $text = ([string]$first).Trim()
  if ($text -notmatch '^v(\d+)\.(\d+)\.(\d+)') { return $null }
  return [pscustomobject]@{
    Text = $Matches[0]; Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Patch = [int]$Matches[3]
  }
}

function Get-SearchPaths {
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($commandName in @("node.exe", "node")) {
    foreach ($command in @(Get-Command $commandName -ErrorAction SilentlyContinue)) {
      if ($command -and $command.Source) { $paths.Add($command.Source) | Out-Null }
    }
  }
  foreach ($dir in ($env:PATH -split ";")) {
    if (-not [string]::IsNullOrWhiteSpace($dir)) { $paths.Add((Join-Path $dir.Trim() "node.exe")) | Out-Null }
  }
  foreach ($absolute in @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe",
    "$env:LOCALAPPDATA\Volta\node.exe",
    "C:\ProgramData\chocolatey\bin\node.exe",
    "D:\RJ\node\node.exe",
    "D:\RJ\dsh-desktop\DSH Desktop\resources\app\node_modules\node\bin\node.exe",
    "D:\RJ\腾讯文档\TencentDocs\resources\node\win32-x64\node.exe",
    "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
  )) {
    $paths.Add($absolute) | Out-Null
  }
  foreach ($root in @($env:NVM_HOME, $env:NVM_SYMLINK, (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"), (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes"))) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { continue }
    foreach ($match in @(Get-ChildItem -LiteralPath $root -Filter "node.exe" -File -Recurse -Depth 5 -ErrorAction SilentlyContinue)) {
      $paths.Add($match.FullName) | Out-Null
    }
  }
  return $paths
}

Write-Host ""
Write-Host "=== 准备项目自带 Node 运行时 / provisioning project-local Node ==="
Write-Host "target: $Target"
Write-Host ""

if ((Test-Path -LiteralPath $Target) -and -not $Force) {
  $existing = Get-NodeVersionInfo $Target
  if ($existing) {
    Write-Host "已经存在且可用 / already present: $($existing.Text)"
    Write-Host "需要覆盖请加 -Force。"
    exit 0
  }
  Write-Host "已存在但跑不起来，将覆盖 / present but unusable, will overwrite" -ForegroundColor Yellow
}

$candidates = New-Object System.Collections.Generic.List[object]
if (-not [string]::IsNullOrWhiteSpace($Source)) {
  $candidates.Add([pscustomobject]@{ Path = $Source; Source = "user-supplied" }) | Out-Null
} else {
  foreach ($path in Get-SearchPaths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $candidates.Add([pscustomobject]@{ Path = $path; Source = "detected" }) | Out-Null
  }
}

$chosen = $null
foreach ($candidate in $candidates) {
  if (-not (Test-Path -LiteralPath $candidate.Path -PathType Leaf)) { continue }
  $version = Get-NodeVersionInfo $candidate.Path
  if (-not $version) { continue }
  if ($version.Major -lt $MinMajor) {
    Write-Host ("跳过 {0}（{1} < v{2}）" -f $candidate.Path, $version.Text, $MinMajor) -ForegroundColor Yellow
    continue
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $candidate.Path -ErrorAction SilentlyContinue
  $signer = ""
  if ($signature -and $signature.SignerCertificate) { $signer = $signature.SignerCertificate.Subject }
  $isOfficial = $signer -match "OpenJS Foundation"
  $chosen = [pscustomobject]@{
    Path = $candidate.Path; Version = $version; Signer = $signer; Official = $isOfficial
  }
  if ($isOfficial) { break }   # 官方签名的第一个就够好，不再往下找
}

if (-not $chosen) {
  Write-Host "[ERROR] 在这台机器上没找到可用的 node.exe。" -ForegroundColor Red
  Write-Host ""
  Write-Host "已尝试的位置 / probed:"
  $index = 0
  foreach ($candidate in $candidates) {
    $index += 1
    $state = if (Test-Path -LiteralPath $candidate.Path -PathType Leaf) { "exists" } else { "missing" }
    Write-Host ("  {0,2}. {1}  -> {2}" -f $index, $candidate.Path, $state)
  }
  Write-Host ""
  Write-Host "请先安装 Node.js（https://nodejs.org/en/download，选 LTS 20 或 22），"
  Write-Host "或用 -Source 指定一个 node.exe 的完整路径再跑一次。"
  exit 2
}

Write-Host "选用 / chosen : $($chosen.Path)"
Write-Host "版本 / version: $($chosen.Version.Text)"
Write-Host "签名 / signer : $(if ($chosen.Signer) { $chosen.Signer } else { '(无签名信息)' })"
Write-Host ""

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item -LiteralPath $chosen.Path -Destination $Target -Force

$verify = Get-NodeVersionInfo $Target
if (-not $verify) {
  Write-Host "[ERROR] 复制后 runtime\node\node.exe 跑不起来，请检查磁盘空间或杀软拦截。" -ForegroundColor Red
  exit 1
}

$targetItem = Get-Item -LiteralPath $Target
Write-Host "完成 / done: $Target"
Write-Host "  version = $($verify.Text)"
Write-Host "  size    = $([math]::Round($targetItem.Length / 1MB, 1)) MB"
Write-Host "  sha256  = $((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash)"
Write-Host ""
Write-Host "现在双击 启动静音内测画板.bat 就会优先使用这个运行时。"
exit 0
