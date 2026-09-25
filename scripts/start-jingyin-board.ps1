param(
  [switch]$NoOpen,
  [int]$Port = 0,
  # 启动成功后保持这个控制台窗口不关，并跟随服务日志（启动 bat 会传它）。
  # 服务本身跑在独立进程里，关掉窗口不会停服务；这个开关只影响"窗口留不留、看不看日志"。
  [switch]$KeepOpen,
  # 仅供校验使用的入口覆盖参数：默认就是真实入口 server\index.js。
  # scripts/verify/check-launcher-exitcode.mjs 会把它指向一个受控 fixture，
  # 用来证明"Node 启动失败时保留真实退出码"这条要求确实成立。
  [string]$ServerEntryRelative = "server\index.js"
)

# ============================================================================
#  静音AI绘画 V11 源码版启动器 / Jingyin AI Board launcher
#
#  这个脚本只有一个职责：找到一台机器上**真实可用**的 Node.js，
#  然后用它在本目录下启动 server/index.js，等端口监听起来、健康检查通过，
#  最后显示真实访问地址。
#
#  绝对不允许：
#    - 把 Node 路径写死成某一个固定盘符（旧版本写死 D:\RJ\node\node.exe，
#      在没装这个目录的机器上直接误报 "Node was not found"）
#    - 在服务没起来的时候打印"启动成功"
#    - 吞掉 Node 的真实退出码
#
#  本文件必须保存为 **UTF-8 with BOM**：
#  启动入口用的是 Windows PowerShell 5.1，它会把没有 BOM 的 UTF-8 当成本地
#  ANSI 代码页读取，中文提示会变成乱码。scripts/verify/check-launcher.mjs
#  会检查这一点。
# ============================================================================

$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $AppDir = (Get-Location).Path
}
$ServerEntry = Join-Path $AppDir $ServerEntryRelative
$ServerEntry = [IO.Path]::GetFullPath($ServerEntry)
# 入口必须落在源码目录内，避免这个覆盖参数被拿去启动目录外的脚本。
if (-not $ServerEntry.StartsWith([IO.Path]::GetFullPath($AppDir), [StringComparison]::OrdinalIgnoreCase)) {
  Write-Host "[ERROR] Server entry must live inside the source directory." -ForegroundColor Red
  Write-Host "  appDir : $AppDir"
  Write-Host "  entry  : $ServerEntry"
  exit 1
}

if ($Port -le 0) {
  $Port = 8787
}
$PortSearchWindow = 10

$LogDir = Join-Path $AppDir "logs"
$ServerLog = Join-Path $LogDir "launcher-server.log"
$ServerErrorLog = Join-Path $LogDir "launcher-server.err.log"
$DiagnosticLog = Join-Path $LogDir "launcher-diagnostic.log"

$script:DiagnosticLines = New-Object System.Collections.Generic.List[string]
$script:ProbedCandidates = New-Object System.Collections.Generic.List[object]
# 由版本管理器 / 应用自带运行时这类"目录展开"得到的候选，统一登记到这里，
# 排在固定清单之后使用。
$script:VersionCandidates = New-Object System.Collections.Generic.List[object]

function Write-Diag([string]$Message, [string]$Color = "") {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  $script:DiagnosticLines.Add($line)
  if ($Color) {
    Write-Host $Message -ForegroundColor $Color
  } else {
    Write-Host $Message
  }
}

function Save-Diagnostic {
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $header = @(
      "静音AI绘画 V11 启动器诊断 / launcher diagnostic",
      "time        : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
      "appDir      : $AppDir",
      "script      : $PSCommandPath",
      "powershell  : $($PSVersionTable.PSVersion)",
      "port        : $Port",
      "serverEntry : $ServerEntry",
      ""
    )
    $footer = @(
      "",
      "--- probed node candidates ---"
    ) + ($script:ProbedCandidates | ForEach-Object { "{0}  [{1}]  exists={2}" -f $_.Path, $_.Source, $_.Exists })
    $text = ($header + $script:DiagnosticLines + $footer) -join [Environment]::NewLine
    Set-Content -LiteralPath $DiagnosticLog -Value $text -Encoding UTF8
  } catch {
    Write-Host "[WARN] Could not write diagnostic log: $DiagnosticLog"
  }
}

function Add-Candidate([string]$Path, [string]$Source) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $full = $Path
  try { $full = [IO.Path]::GetFullPath($Path) } catch { return }
  foreach ($existing in $script:ProbedCandidates) {
    if ($existing.Path -eq $full) { return }
  }
  $script:ProbedCandidates.Add([pscustomobject]@{
    Path   = $full
    Source = $Source
    Exists = (Test-Path -LiteralPath $full -PathType Leaf)
  }) | Out-Null
}

function Get-NodeVersionInfo([string]$ExePath) {
  # 真正跑一次 `node -v`；跑不起来或版本号不认识就当作不可用。
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
    Text  = $Matches[0]
    Major = [int]$Matches[1]
    Minor = [int]$Matches[2]
    Patch = [int]$Matches[3]
  }
}

function Resolve-NodeShim([string]$ShimPath) {
  # .cmd / .bat 转发脚本（例如某些工具链自带的 node.cmd）不能直接拿来
  # Start-Process -RedirectStandardOutput，所以先从内容里解析出真实的 node.exe。
  try {
    $content = Get-Content -LiteralPath $ShimPath -Raw -ErrorAction Stop
  } catch {
    return $null
  }
  foreach ($match in [regex]::Matches($content, '"([^"\r\n]*node\.exe)"')) {
    $candidate = $match.Groups[1].Value
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  foreach ($match in [regex]::Matches($content, '(?m)^\s*"?([A-Za-z]:\\[^"\r\n]*node\.exe)"?')) {
    $candidate = $match.Groups[1].Value
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Add-NodeVersionCandidates([string]$Root, [string]$Pattern, [int]$Depth, [string]$Source) {
  # 版本管理器的目录结构带版本号（nvm: v20.11.0\node.exe，fnm/volta/winget 更深），
  # 死路径列不完，这里做**有上限**的展开，避免全盘扫描拖慢启动。
  if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) { return }
  try {
    $matches = Get-ChildItem -LiteralPath $Root -Filter "node.exe" -File -Recurse -Depth $Depth -ErrorAction SilentlyContinue
  } catch {
    return
  }
  foreach ($match in $matches) {
    $script:VersionCandidates.Add([pscustomobject]@{ Path = $match.FullName; Source = $Source }) | Out-Null
  }
}

function Get-NodeSearchLocations {
  $locations = New-Object System.Collections.Generic.List[object]
  if ($null -eq $script:VersionCandidates) {
    $script:VersionCandidates = New-Object System.Collections.Generic.List[object]
  }
  $script:VersionCandidates.Clear()

  # --- 1) 项目内自带 Node（第一优先：源码包自带 runtime\node\node.exe，
  #        不依赖这台机器装没装 Node） ---
  foreach ($relative in @(
    "runtime\node\node.exe",
    "runtime\nodejs\node.exe",
    "node\node.exe",
    "nodejs\node.exe",
    "tools\node\node.exe",
    "bin\node.exe",
    "node_modules\node\bin\node.exe"
  )) {
    $locations.Add([pscustomobject]@{ Path = (Join-Path $AppDir $relative); Source = "project-local" }) | Out-Null
  }
  # 项目根下任意一层 runtime\*\node.exe（例如 runtime\node-v22\node.exe）
  try {
    $runtimeRoot = Join-Path $AppDir "runtime"
    if (Test-Path -LiteralPath $runtimeRoot) {
      foreach ($match in @(Get-ChildItem -LiteralPath $runtimeRoot -Filter "node.exe" -File -Recurse -Depth 2 -ErrorAction SilentlyContinue)) {
        $locations.Add([pscustomobject]@{ Path = $match.FullName; Source = "project-local" }) | Out-Null
      }
    }
  } catch { }

  # --- 2) 启动脚本所在目录及上一级 ---
  foreach ($relative in @("node.exe", "node\node.exe")) {
    $locations.Add([pscustomobject]@{ Path = (Join-Path $PSScriptRoot $relative); Source = "launcher-dir" }) | Out-Null
  }
  $locations.Add([pscustomobject]@{ Path = (Join-Path (Split-Path -Parent $AppDir) "node.exe"); Source = "app-parent" }) | Out-Null

  # --- 3) 当前 PATH ---
  foreach ($commandName in @("node.exe", "node")) {
    foreach ($command in @(Get-Command $commandName -ErrorAction SilentlyContinue)) {
      if ($command -and $command.Source) {
        $locations.Add([pscustomobject]@{ Path = $command.Source; Source = "PATH" }) | Out-Null
      }
    }
  }
  foreach ($dir in ($env:PATH -split ";")) {
    if ([string]::IsNullOrWhiteSpace($dir)) { continue }
    $locations.Add([pscustomobject]@{ Path = (Join-Path $dir.Trim() "node.exe"); Source = "PATH-entry" }) | Out-Null
  }

  # --- 4) 常见 Windows 安装路径 ---
  $commonRoots = New-Object System.Collections.Generic.List[string]
  foreach ($envName in @("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA", "APPDATA", "ProgramData", "NVM_HOME", "NVM_SYMLINK", "VOLTA_HOME", "FNM_DIR")) {
    $value = [Environment]::GetEnvironmentVariable($envName)
    if (-not [string]::IsNullOrWhiteSpace($value)) { $commonRoots.Add($value) | Out-Null }
  }
  foreach ($root in $commonRoots) {
    foreach ($relative in @("nodejs\node.exe", "node\node.exe", "Programs\nodejs\node.exe", "npm\node.exe", "bin\node.exe")) {
      $locations.Add([pscustomobject]@{ Path = (Join-Path $root $relative); Source = "common-install" }) | Out-Null
    }
  }
  foreach ($absolute in @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:APPDATA\npm\node.exe",
    "$env:LOCALAPPDATA\Volta\node.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\node.exe",
    "C:\ProgramData\chocolatey\bin\node.exe",
    "C:\ProgramData\chocolatey\lib\nodejs\tools\node.exe",
    "$env:USERPROFILE\scoop\shims\node.exe",
    "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe",
    "C:\nodejs\node.exe",
    "D:\nodejs\node.exe",
    "D:\Program Files\nodejs\node.exe",
    "D:\dev\nodejs\node.exe"
  )) {
    $locations.Add([pscustomobject]@{ Path = $absolute; Source = "common-install" }) | Out-Null
  }

  # --- 4b) 版本管理器 / 包管理器的目录展开（有深度上限） ---
  # nvm-windows: %APPDATA%\nvm\v20.11.0\node.exe / %NVM_HOME%\v20.11.0\node.exe
  Add-NodeVersionCandidates $env:APPDATA "node.exe" 2 "version-manager"
  Add-NodeVersionCandidates $env:NVM_HOME "node.exe" 2 "version-manager"
  Add-NodeVersionCandidates $env:NVM_SYMLINK "node.exe" 1 "version-manager"
  # fnm
  Add-NodeVersionCandidates (Join-Path $env:LOCALAPPDATA "fnm") "node.exe" 4 "version-manager"
  Add-NodeVersionCandidates (Join-Path $env:APPDATA "fnm") "node.exe" 4 "version-manager"
  # volta
  Add-NodeVersionCandidates (Join-Path $env:LOCALAPPDATA "Volta") "node.exe" 5 "version-manager"
  # winget 安装的 OpenJS.NodeJS
  Add-NodeVersionCandidates (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") "node.exe" 4 "winget"
  # chocolatey
  Add-NodeVersionCandidates "C:\ProgramData\chocolatey\lib" "node.exe" 4 "chocolatey"

  # --- 4c) 其它程序自带的 Node 运行时 ---
  # 这些是"机器上确实装了 Node，但不在 PATH 里"的情况。放在标准安装位之后、
  # 旧固定路径之前，只在前面全都失败时才用得上。
  foreach ($versionRoot in @(
    (Join-Path $env:LOCALAPPDATA "Programs"),
    (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes"),
    (Join-Path $env:LOCALAPPDATA "Tabbit Browser\Application"),
    "D:\RJ"
  )) {
    Add-NodeVersionCandidates $versionRoot "node.exe" 6 "app-bundled"
  }
  # 已知的几个确定位置（比整目录扫描更准，命中更快）
  foreach ($absolute in @(
    "D:\RJ\dsh-desktop\DSH Desktop\resources\app\node_modules\node\bin\node.exe",
    "D:\RJ\腾讯文档\TencentDocs\resources\node\win32-x64\node.exe",
    "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe"
  )) {
    $locations.Add([pscustomobject]@{ Path = $absolute; Source = "app-bundled" }) | Out-Null
  }

  # --- 5) 最后才检查旧版本写死的目录 ---
  $locations.Add([pscustomobject]@{ Path = "D:\RJ\node\node.exe"; Source = "legacy-fallback" }) | Out-Null

  # 4b/4c 展开出来的候选统一排在固定清单之后
  foreach ($candidate in $script:VersionCandidates) {
    $locations.Add($candidate) | Out-Null
  }

  return $locations
}

function Find-NodeExecutable {
  foreach ($location in Get-NodeSearchLocations) {
    Add-Candidate $location.Path $location.Source
  }

  foreach ($candidate in $script:ProbedCandidates) {
    if (-not $candidate.Exists) { continue }

    $extension = [IO.Path]::GetExtension($candidate.Path).ToLowerInvariant()
    if ($extension -eq ".exe") {
      $version = Get-NodeVersionInfo $candidate.Path
      if ($version) {
        return [pscustomobject]@{ Path = $candidate.Path; Source = $candidate.Source; Version = $version }
      }
      continue
    }

    if ($extension -eq ".cmd" -or $extension -eq ".bat") {
      $resolved = Resolve-NodeShim $candidate.Path
      if ($resolved) {
        Add-Candidate $resolved ("$($candidate.Source)-shim")
        $version = Get-NodeVersionInfo $resolved
        if ($version) {
          return [pscustomobject]@{ Path = $resolved; Source = "$($candidate.Source)-shim"; Version = $version }
        }
      }
    }
  }

  return $null
}

function Get-LatestServerSourceWriteTime {
  # 判断"运行中的服务是不是比源码旧"，用来决定要不要自动重启。
  # server/static-assets.generated.js 是构建产物，server/skill-baselines 是历史备份，
  # 都不应该触发重启。
  $roots = @(
    (Join-Path $AppDir "server"),
    (Join-Path $AppDir "prompts\server")
  )
  $latest = $null
  foreach ($dir in $roots) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $files = Get-ChildItem -LiteralPath $dir -Filter "*.js" -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne "static-assets.generated.js" -and $_.FullName -notmatch "skill-baselines" }
    foreach ($file in $files) {
      if ($null -eq $latest -or $file.LastWriteTime -gt $latest) { $latest = $file.LastWriteTime }
    }
  }
  return $latest
}

function Get-BoardServerStaleReason($ProcessInfo) {
  if (-not $ProcessInfo) { return "" }
  $latestSource = Get-LatestServerSourceWriteTime
  if (-not $latestSource) { return "" }
  $created = $null
  try {
    $live = Get-Process -Id ([int]$ProcessInfo.ProcessId) -ErrorAction Stop
    $created = $live.StartTime
  } catch {
    $created = $null
  }
  if (-not $created) {
    try { $created = [datetime]$ProcessInfo.CreationDate } catch { $created = $null }
  }
  if (-not $created) { return "" }
  if ($created -lt $latestSource) {
    return ("process started {0:HH:mm:ss}, newest server source {1:HH:mm:ss}" -f $created, $latestSource)
  }
  return ""
}

function Get-BoardServerProcess($Connection) {
  if (-not $Connection) { return $null }
  $ownerPid = [int]$Connection.OwningProcess
  if ($ownerPid -le 0) { return $null }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
  if (-not $processInfo) { return $null }
  if ([string]$processInfo.CommandLine -notmatch "server[/\\]index\.js") { return $null }
  return $processInfo
}

function Get-BoardListener([int]$BasePort, [int]$Window) {
  foreach ($offset in 0..$Window) {
    $candidatePort = $BasePort + $offset
    $connection = Get-NetTCPConnection -LocalPort $candidatePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) { continue }
    $processInfo = Get-BoardServerProcess $connection
    if ($processInfo) {
      return [pscustomobject]@{ Port = $candidatePort; Connection = $connection; Process = $processInfo }
    }
  }
  return $null
}

function Get-AnyListener([int]$BasePort, [int]$Window) {
  foreach ($offset in 0..$Window) {
    $candidatePort = $BasePort + $offset
    $connection = Get-NetTCPConnection -LocalPort $candidatePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return $candidatePort }
  }
  return 0
}

function Get-PortFromServerLog {
  # server/index.js 监听成功后会打印 "Jingyin AI Canvas http://127.0.0.1:<port>"。
  # 端口被占用时它会顺延到下一个端口，所以要以日志里的真实端口为准。
  if (-not (Test-Path -LiteralPath $ServerLog)) { return 0 }
  try {
    $content = Get-Content -LiteralPath $ServerLog -Raw -ErrorAction SilentlyContinue
  } catch {
    return 0
  }
  if ([string]::IsNullOrWhiteSpace($content)) { return 0 }
  $matches = [regex]::Matches($content, 'Jingyin AI Canvas http://127\.0\.0\.1:(\d+)')
  if ($matches.Count -eq 0) { return 0 }
  return [int]$matches[$matches.Count - 1].Groups[1].Value
}

function Test-BoardHealth([int]$TargetPort) {
  $url = "http://127.0.0.1:$TargetPort/api/health"
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -ne 200) {
      return [pscustomobject]@{ Ok = $false; Url = $url; Detail = "HTTP $($response.StatusCode)" }
    }
    $detail = ""
    try {
      $json = $response.Content | ConvertFrom-Json
      $parts = New-Object System.Collections.Generic.List[string]
      if ($null -ne $json.imageConcurrency) {
        $parts.Add("imageConcurrency=$($json.imageConcurrency)") | Out-Null
      }
      if ($null -ne $json.queued) { $parts.Add("queued=$($json.queued)") | Out-Null }
      if ($null -ne $json.ok) { $parts.Add("ok=$($json.ok)") | Out-Null }
      $detail = ($parts -join ", ")
    } catch {
      $detail = "health JSON parse skipped"
    }
    return [pscustomobject]@{ Ok = $true; Url = $url; Detail = $detail }
  } catch {
    return [pscustomobject]@{ Ok = $false; Url = $url; Detail = $_.Exception.Message }
  }
}

function Write-NodeNotFoundHelp {
  Write-Host ""
  Write-Host "[ERROR] 未找到可用 Node.js / No usable Node.js runtime found." -ForegroundColor Red
  Write-Host ""
  Write-Host "已探测过下面这些位置（都不存在，或存在但跑不起来）："
  Write-Host "Probed locations:"
  $index = 0
  foreach ($candidate in $script:ProbedCandidates) {
    $index += 1
    $state = if ($candidate.Exists) { "exists but not runnable" } else { "missing" }
    Write-Host ("  {0,2}. [{1}] {2}  -> {3}" -f $index, $candidate.Source, $candidate.Path, $state)
  }
  Write-Host ""
  Write-Host "解决方法 / How to fix:"
  Write-Host "  1. 安装 Node.js（推荐 LTS 20 或 22）：https://nodejs.org/en/download"
  Write-Host "     安装时保持默认勾选 'Add to PATH'。"
  Write-Host "  2. 或者把便携版 Node 放到下面任一位置（本项目会优先使用）："
  Write-Host "     $AppDir\node\node.exe"
  Write-Host "     $AppDir\runtime\node\node.exe"
  Write-Host "  3. 或者把已经装好的 Node 目录加进系统 PATH，然后重新打开这个启动器。"
  Write-Host "  4. 安装完成后可以在新窗口里执行  node -v  确认，再重新双击启动脚本。"
  Write-Host ""
  Write-Host "注意：不需要、也不要去双击 node.exe 本身；请始终双击本启动脚本。"
  Write-Host "完整探测记录：$DiagnosticLog"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "========================================"
Write-Host " Jingyin AI Board Launcher"
Write-Host "========================================"
Write-Host ""
Write-Diag "appDir = $AppDir"
Write-Diag "serverEntry = $ServerEntry"

if (-not (Test-Path -LiteralPath $ServerEntry -PathType Leaf)) {
  Write-Diag "[ERROR] This is not the board source directory: $AppDir" "Red"
  Write-Diag "Expected to find: $ServerEntry"
  Save-Diagnostic
  exit 1
}

Write-Diag "正在探测可用的 Node.js ... / probing for Node.js ..."
$node = Find-NodeExecutable
if (-not $node) {
  Write-NodeNotFoundHelp
  Save-Diagnostic
  exit 2
}

$NodeExe = $node.Path
$NodeVersion = $node.Version
Write-Diag "使用 Node / using Node : $NodeExe"
Write-Diag "Node 版本 / version    : $($NodeVersion.Text)  (source: $($node.Source))"

if ($NodeVersion.Major -lt 18) {
  Write-Diag "[WARN] Node $($NodeVersion.Text) 过旧，建议升级到 20 LTS 或 22 LTS。" "Yellow"
} elseif ($NodeVersion.Major -eq 20 -and $NodeVersion.Minor -lt 19) {
  Write-Diag "[WARN] 本项目前端用 Vite 7，需要 Node 20.19+ 或 22.12+；当前 $($NodeVersion.Text) 可能启动失败。" "Yellow"
} elseif ($NodeVersion.Major -eq 21) {
  Write-Diag "[WARN] Node 21 不是 LTS，建议 20 LTS 或 22 LTS。" "Yellow"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$boardListener = Get-BoardListener $Port $PortSearchWindow
$shouldStart = $true

if ($boardListener) {
  $runningPort = $boardListener.Port
  Write-Diag "检测到已在运行的本项目服务，端口 / existing board server on port $runningPort"
  $health = Test-BoardHealth $runningPort
  $staleReason = Get-BoardServerStaleReason $boardListener.Process
  if ($health.Ok -and -not $staleReason) {
    Write-Diag "服务已在运行且健康检查通过 / already running and healthy"
    $shouldStart = $false
    $Port = $runningPort
  } else {
    if ($staleReason) {
      Write-Diag "运行中的服务比源码旧（$staleReason），重启它 / restarting stale server" "Yellow"
    } else {
      Write-Diag "已有服务进程但健康检查失败($($health.Detail))，重启它 / restarting it" "Yellow"
    }
    try {
      Stop-Process -Id ([int]$boardListener.Process.ProcessId) -Force -ErrorAction Stop
    } catch {
      Write-Diag "[WARN] 无法结束旧进程: $($_.Exception.Message)" "Yellow"
    }
    for ($i = 0; $i -lt 40; $i += 1) {
      Start-Sleep -Milliseconds 250
      if (-not (Get-AnyListener $Port $PortSearchWindow)) { break }
    }
  }
} else {
  $foreignPort = Get-AnyListener $Port $PortSearchWindow
  if ($foreignPort -gt 0 -and $foreignPort -eq $Port) {
    Write-Diag "端口 $Port 已被别的程序占用，本服务会自动顺延到下一个端口。" "Yellow"
  }
}

$startedProcess = $null
if ($shouldStart) {
  Write-Diag "正在启动本地服务 / starting local server ..."

  # 如果固定日志名被上一次的服务进程占着（例如从旧版启动器升级上来，
  # 旧进程还持有 launcher-server.log 的句柄），cmd 的 > 重定向会直接失败并返回 1，
  # 用户只会看到一个莫名的退出码。这里先探测能不能接管日志文件，
  # 接不了就改用带时间戳的日志名，保证服务照常启动。
  $logLocked = $false
  foreach ($candidateLog in @($ServerLog, $ServerErrorLog)) {
    if (-not (Test-Path -LiteralPath $candidateLog)) { continue }
    try {
      Remove-Item -LiteralPath $candidateLog -Force -ErrorAction Stop
    } catch {
      $logLocked = $true
    }
  }
  if ($logLocked) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $ServerLog = Join-Path $LogDir ("launcher-server-{0}.log" -f $stamp)
    $ServerErrorLog = Join-Path $LogDir ("launcher-server-{0}.err.log" -f $stamp)
    Write-Diag "[WARN] 上一次的日志文件被占用，本次改用带时间戳的日志。" "Yellow"
    Write-Diag "       out: $ServerLog"
    Write-Diag "       err: $ServerErrorLog"
  }

  # Windows PowerShell 5.1 的 Start-Process -PassThru 一旦配合
  # -RedirectStandardOutput/-RedirectStandardError 就读不到真实 ExitCode
  # （实测 ExitCode 恒为空），所以这里直接用 .NET Process + cmd 重定向：
  # cmd /c 会把子进程的真实退出码原样返回，日志由 cmd 直接落盘，
  # 不经过 PowerShell 的异步事件，避免输出量大时死锁。
  try {
    $comspec = [Environment]::GetEnvironmentVariable("ComSpec")
    if ([string]::IsNullOrWhiteSpace($comspec)) { $comspec = Join-Path $env:SystemRoot "System32\cmd.exe" }
    $commandLine = '""{0}" "{1}" >"{2}" 2>"{3}""' -f $NodeExe, $ServerEntry, $ServerLog, $ServerErrorLog

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $comspec
    $startInfo.Arguments = "/d /s /c $commandLine"
    $startInfo.WorkingDirectory = $AppDir
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true

    $startedProcess = New-Object System.Diagnostics.Process
    $startedProcess.StartInfo = $startInfo
    $startedProcess.Start() | Out-Null
  } catch {
    Write-Diag "[ERROR] 无法用这个 Node 启动服务 / failed to spawn Node: $($_.Exception.Message)" "Red"
    Write-Diag "Node 路径: $NodeExe"
    Save-Diagnostic
    exit 1
  }

  # 等端口监听；Node 中途退出就立刻用真实退出码收场（绝不退化成"超时"）。
  $readyPort = 0
  $exited = $false
  $nodeExitCode = $null
  for ($i = 0; $i -lt 60; $i += 1) {
    Start-Sleep -Milliseconds 500
    if ($startedProcess) {
      try { $startedProcess.Refresh() } catch { }
      if ($startedProcess.HasExited) {
        $exited = $true
        try { $nodeExitCode = $startedProcess.ExitCode } catch { $nodeExitCode = $null }
        break
      }
    }
    $listener = Get-BoardListener $Port $PortSearchWindow
    if ($listener) {
      $readyPort = $listener.Port
      break
    }
    $loggedPort = Get-PortFromServerLog
    if ($loggedPort -gt 0) {
      $readyPort = $loggedPort
      break
    }
  }

  if ($exited) {
    $exitText = if ($null -eq $nodeExitCode) { "unknown" } else { [string]$nodeExitCode }
    Write-Diag "[ERROR] Node 进程启动后退出，真实退出码 / real exit code: $exitText" "Red"
    $failureLog = Join-Path $LogDir ("launcher-failure-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
    $tail = @()
    if (Test-Path -LiteralPath $ServerErrorLog) { $tail = @(Get-Content -LiteralPath $ServerErrorLog -Tail 60 -ErrorAction SilentlyContinue) }
    if (Test-Path -LiteralPath $ServerLog) { $tail += @(Get-Content -LiteralPath $ServerLog -Tail 60 -ErrorAction SilentlyContinue) }
    if ($tail.Count -gt 0) {
      Write-Host ""
      Write-Host "--- server output (tail) ---"
      $tail | ForEach-Object { Write-Host $_ }
      $tail | Set-Content -LiteralPath $failureLog -Encoding UTF8
    } else {
      Write-Host "(server produced no output)"
      Write-Host "可能原因 / possible causes:"
      Write-Host "  - 日志文件被别的进程占用，重定向失败（本次已尝试自动改用带时间戳的日志）"
      Write-Host "  - 入口文件路径或 Node 路径带特殊字符，进程无法启动"
      Write-Host "  - Node 与项目不兼容（例如版本过旧）"
    }
    Write-Diag "错误日志 / error log : $ServerErrorLog"
    Write-Diag "失败快照 / failure log: $failureLog"
    Save-Diagnostic
    if ($null -ne $nodeExitCode -and $nodeExitCode -is [int] -and $nodeExitCode -ne 0) { exit $nodeExitCode }
    exit 1
  }

  if ($readyPort -le 0) {
    Write-Diag "[ERROR] 服务在超时时间内没有监听端口，启动失败。" "Red"
    Write-Diag "已尝试端口范围: $Port .. $($Port + $PortSearchWindow)"
    if (Test-Path -LiteralPath $ServerErrorLog) {
      Write-Host ""
      Write-Host "--- launcher-server.err.log (tail) ---"
      Get-Content -LiteralPath $ServerErrorLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
    if (Test-Path -LiteralPath $ServerLog) {
      Write-Host ""
      Write-Host "--- launcher-server.log (tail) ---"
      Get-Content -LiteralPath $ServerLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
    Write-Diag "错误日志 / error log: $ServerErrorLog"
    Save-Diagnostic
    exit 1
  }

  # 端口监听起来 ≠ 服务真的可用，必须再过一次健康检查。
  $health = $null
  for ($i = 0; $i -lt 30; $i += 1) {
    $health = Test-BoardHealth $readyPort
    if ($health.Ok) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $health -or -not $health.Ok) {
    Write-Diag "[ERROR] 端口 $readyPort 已监听，但 /api/health 未通过：$($health.Detail)" "Red"
    Write-Diag "错误日志 / error log: $ServerErrorLog"
    Save-Diagnostic
    exit 3
  }
  Write-Diag "服务已启动 / server started on port $readyPort"
  Write-Diag "健康检查 / health : $($health.Url) -> OK $($health.Detail)"
  $Port = $readyPort
} else {
  Save-Diagnostic
}

$AppUrl = "http://127.0.0.1:$Port/"

if ($shouldStart) {
  Write-Host ""
  Write-Host "启动成功 / started successfully" -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "服务已经在运行 / server already running" -ForegroundColor Green
}
Write-Host "访问地址 / URL  : $AppUrl"
Write-Host "健康检查 / health: http://127.0.0.1:$Port/api/health"
Write-Host "Node 路径 / node : $NodeExe ($($NodeVersion.Text))"
Write-Host "错误日志 / errlog: $ServerErrorLog"
Write-Host ""

if (-not $NoOpen) {
  try {
    Start-Process $AppUrl | Out-Null
    Write-Host "已尝试打开浏览器 / browser open requested."
  } catch {
    Write-Host "自动打开浏览器失败，请手动复制上面的地址。/ could not open the browser automatically."
  }
} else {
  Write-Host "已跳过打开浏览器（-NoOpen）。"
}
Write-Host "如果浏览器没有自动打开，把上面的地址复制到浏览器即可。"
Write-Host ""

if (-not $shouldStart) {
  Save-Diagnostic
}

# 启动成功（或服务已在运行）之后，按 bat 的要求把窗口留住并跟随日志。
# 说明：
#   - 服务是 cmd 起的独立进程，关掉本窗口不会停服务；
#   - Ctrl+C 只停止"跟随日志"，不影响服务；
#   - 跟结束之后**不在这里 Read-Host**：窗口由 bat 末尾的 pause 顶住，
#     否则会出现"PS1 按一次键 + bat 再按一次键"的双重停顿。
if ($KeepOpen) {
  Write-Host "----------------------------------------------------------------------"
  Write-Host "这个窗口会保持打开，下面跟随服务日志（新日志会继续出现在这里）。"
  Write-Host "  · 关闭窗口不会停止服务（服务在独立进程里跑）"
  Write-Host "  · 按 Ctrl+C 只是停止跟随日志，不影响服务"
  Write-Host "日志文件：$ServerLog"
  Write-Host "----------------------------------------------------------------------"
  Write-Host ""
  try {
    if (Test-Path -LiteralPath $ServerLog) {
      Get-Content -LiteralPath $ServerLog -Tail 30 -Wait
    } else {
      Write-Host "（日志文件还没有生成：$ServerLog）"
    }
  } catch {
    # Ctrl+C 或读文件失败都走这里：只提示，不当作启动失败
    Write-Host ""
  }
  Write-Host ""
  Write-Host "已停止跟随日志（服务仍在运行）。"
}

exit 0
