import JavaScriptObfuscator from "javascript-obfuscator";
import { build as esbuild } from "esbuild";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(rootDir, ".secure-build");
const releaseParentDir = path.resolve(rootDir, "..");
// 发布身份（可配置，默认就是本次要发的这一版）。
// 换版本号/产品名只改环境变量即可，不用动脚本：
//   JINGYIN_WIN_RELEASE_NAME / JINGYIN_WIN_PRODUCT_NAME / JINGYIN_WIN_PRODUCT_VERSION
const releaseName = String(process.env.JINGYIN_WIN_RELEASE_NAME || "静音AI画板（v3.7）").trim();
const productName = String(process.env.JINGYIN_WIN_PRODUCT_NAME || "静音AI画板").trim();
const productVersion = String(process.env.JINGYIN_WIN_PRODUCT_VERSION || "3.7.0").trim();
const defaultReleaseDir = path.join(releaseParentDir, releaseName);
const releaseDir = path.resolve(process.env.JINGYIN_WIN_RELEASE_DIR || defaultReleaseDir);
const exeName = `${productName}.exe`;
const releaseExe = path.join(releaseDir, exeName);
const iconFile = path.join(rootDir, "public", "app-avatar.ico");
// npm 调用方式：优先用 node 同目录的 npm.cmd；便携 node（runtime/node）旁边没有 npm.cmd 时，
// 回退到仓库自带的便携 npm-cli.js，避免打包第一步就找不到 npm。
const siblingNpm = path.join(path.dirname(process.execPath), "npm.cmd");
const portableNpmCli = path.join(rootDir, "runtime", "npm", "package", "bin", "npm-cli.js");
const npmInvocation = process.platform !== "win32"
  ? { command: "npm", prefix: [] }
  : existsSync(siblingNpm)
    ? { command: siblingNpm, prefix: [] }
    : { command: process.execPath, prefix: [portableNpmCli] };
const rceditCommand = process.platform === "win32"
  ? path.join(rootDir, "node_modules", "rcedit", "bin", process.arch === "x64" ? "rcedit-x64.exe" : "rcedit.exe")
  : localBin("rcedit");
const serverBundle = path.join(buildDir, "server.bundle.cjs");
const protectedServerBundle = path.join(buildDir, "server.protected.cjs");
const seaConfigFile = path.join(buildDir, "sea-config.json");
const seaBlob = path.join(buildDir, "jingyin-sea.blob");
const releaseId = `secure-win-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const binExt = process.platform === "win32" ? ".cmd" : "";
const localBin = (name) => path.join(rootDir, "node_modules", ".bin", `${name}${binExt}`);

function ensureInsideRoot(target, allowedRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(allowedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`Refusing to touch path outside ${resolvedRoot}: ${resolvedTarget}`);
  }
}

function ensureChildPath(target, allowedRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(allowedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use unsafe release path outside ${resolvedRoot}: ${resolvedTarget}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
      windowsHide: true
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function obfuscateFile(file, options) {
  const source = await readFile(file, "utf8");
  const result = JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode();
  await writeFile(file, `${result}\n`, "utf8");
}

async function sha256(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex").toUpperCase();
}

ensureInsideRoot(buildDir, rootDir);
ensureChildPath(releaseDir, releaseParentDir);
await rm(buildDir, { recursive: true, force: true });
await rm(releaseDir, { recursive: true, force: true });
// 2026-09-27：**必须先清空 dist**。实测 vite build 在部分配置下不会清 dist，
// 于是历史产物（一次一个 index-<hash>.js）会越积越多：上一次打包时 dist 里躺着 29 个
// 旧 bundle（每个 ~2MB），混淆 + 内嵌 29 份会让 javascript-obfuscator 内存爆掉
// （报 charenc md5 的 RangeError: Invalid array length），而且会把一堆过期前端一起打进安装包。
// 发布包只允许包含"这一次构建"的前端资源。
const distDir = path.join(rootDir, "dist");
ensureInsideRoot(distDir, rootDir);
await rm(distDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });

console.log("1/8 Build frontend in public release mode");
await run(npmInvocation.command, [...npmInvocation.prefix, "run", "build"], {
  env: {
    NODE_ENV: "production",
    VITE_JINGYIN_PUBLIC_RELEASE: "1",
    VITE_JINGYIN_RELEASE_ID: releaseId,
    VITE_JINGYIN_STORAGE_PREFIX: "jingyin-public-secure"
  }
});

console.log("2/8 Obfuscate frontend JavaScript assets");
const distAssetFiles = await walkFiles(path.join(rootDir, "dist"));
for (const file of distAssetFiles.filter((item) => item.endsWith(".js"))) {
  await obfuscateFile(file, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.25,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.05,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.75,
    transformObjectKeys: true
  });
}

console.log("3/8 Embed frontend assets into server module");
await run(process.execPath, [path.join(rootDir, "scripts", "generate-static-assets.mjs")]);

console.log("4/8 Bundle server");
await esbuild({
  entryPoints: [path.join(rootDir, "server", "index.js")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: serverBundle,
  minify: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": "\"production\"",
    "process.env.JINGYIN_DISABLE_GENERATION_LOGS": "\"0\""
  },
  external: ["vite", "lightningcss"]
});

console.log("5/8 Obfuscate server bundle");
await copyFile(serverBundle, protectedServerBundle);
await obfuscateFile(protectedServerBundle, {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.6,
  transformObjectKeys: false
});

console.log("6/8 Build Node SEA blob");
// 2026-09-29（v3.7）：useCodeCache 必须关掉。
// 实测 Node v24.9.0 + 本次混淆后 9.9MB 的 server bundle，开启 code cache 会让
// `node --experimental-sea-config` 直接崩溃（exit 3221226505 = 0xC0000409
// STATUS_STACK_BUFFER_OVERRUN），v3.7 打包就卡在这一步；同一 bundle 关掉后正常产出 9.9MB blob。
// code cache 只是启动期编译缓存，关掉不影响功能，仅冷启动略慢。
await writeFile(seaConfigFile, JSON.stringify({
  main: protectedServerBundle,
  output: seaBlob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false
}, null, 2), "utf8");
await run(process.execPath, ["--experimental-sea-config", seaConfigFile]);

console.log("7/8 Inject blob and app icon into Windows executable");
await copyFile(process.execPath, releaseExe);
if (process.platform === "win32") {
  await run(rceditCommand, [
    releaseExe,
    "--set-icon",
    iconFile,
    "--set-version-string",
    "FileDescription",
    productName,
    "--set-version-string",
    "ProductName",
    productName,
    // 复制 node.exe 会带过来 Node.js 的公司名/原始文件名，发布包必须换成自己的，否则"属性"里露馅。
    "--set-version-string",
    "CompanyName",
    "静音AI",
    "--set-version-string",
    "InternalName",
    productName,
    "--set-version-string",
    "OriginalFilename",
    exeName,
    "--set-version-string",
    "LegalCopyright",
    `Copyright (C) ${new Date().getFullYear()} 静音AI`,
    "--set-file-version",
    productVersion,
    "--set-product-version",
    productVersion
  ]);
}

// 2026-09-29（v3.7）：postject 改为直接用 node 调 dist/cli.js。
// 走 node_modules/.bin/postject.cmd 要经过 cmd.exe，在中文发布路径下曾出现
// wasm 内存分配失败（WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory），
// 直接调用同一个 CLI 则稳定注入成功。
const postjectCli = path.join(rootDir, "node_modules", "postject", "dist", "cli.js");
const postjectArgs = [
  releaseExe,
  "NODE_SEA_BLOB",
  seaBlob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
];
if (existsSync(postjectCli)) {
  await run(process.execPath, [postjectCli, ...postjectArgs]);
} else {
  await run(localBin("postject"), postjectArgs);
}

console.log("8/8 Write release notes and checksum");
const exeInfo = await stat(releaseExe);
const hash = await sha256(releaseExe);
const diagnosticPowerShell = `$ErrorActionPreference = "Continue"

function Write-TextFile {
  param([string]$Path, [string]$Value)
  Set-Content -LiteralPath $Path -Value $Value -Encoding UTF8
}

function Save-JsonFile {
  param($Value, [string]$Path)
  $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Save-CommandText {
  param([scriptblock]$Command, [string]$Path)
  try {
    $text = & $Command | Out-String
    Write-TextFile $Path $text
  } catch {
    Write-TextFile $Path ("执行失败：" + $_.Exception.Message)
  }
}

try {
  Write-Host "正在导出静音AI画板诊断日志..."
  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $desktop = [Environment]::GetFolderPath("Desktop")
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path $env:USERPROFILE "Desktop"
  }
  if (!(Test-Path -LiteralPath $desktop)) {
    $desktop = $PSScriptRoot
  }

  $out = Join-Path $desktop ("静音AI画板诊断日志_" + $stamp)
  New-Item -ItemType Directory -Path $out -Force | Out-Null

  $logRoot = Join-Path $env:LOCALAPPDATA "静音AI绘画数据\\logs"
  $gen = Join-Path $logRoot "generation.jsonl"
  $genRotated = Join-Path $logRoot "generation.jsonl.1"
  $asset = Join-Path $logRoot "asset-errors.jsonl"
  $assetRotated = Join-Path $logRoot "asset-errors.jsonl.1"
  $runtime = Join-Path $logRoot "runtime-errors.log"
  $runtimeRotated = Join-Path $logRoot "runtime-errors.log.1"

  if (Test-Path -LiteralPath $gen) {
    Get-Content -LiteralPath $gen -Tail 1000 | Set-Content -LiteralPath (Join-Path $out "generation-last-1000.jsonl") -Encoding UTF8
    Get-Content -LiteralPath $gen -Tail 1000 | Where-Object { $_ -notmatch '"stage":"image-proxy' } | Select-Object -Last 500 | Set-Content -LiteralPath (Join-Path $out "generation-key-events-last-500.jsonl") -Encoding UTF8
  } elseif (Test-Path -LiteralPath $genRotated) {
    Get-Content -LiteralPath $genRotated -Tail 1000 | Set-Content -LiteralPath (Join-Path $out "generation-last-1000.jsonl") -Encoding UTF8
    Get-Content -LiteralPath $genRotated -Tail 1000 | Where-Object { $_ -notmatch '"stage":"image-proxy' } | Select-Object -Last 500 | Set-Content -LiteralPath (Join-Path $out "generation-key-events-last-500.jsonl") -Encoding UTF8
  } else {
    Write-TextFile (Join-Path $out "generation-last-1000.jsonl") "未找到 generation.jsonl。可能原因：软件未启动、还没点过生成、或旧版本未开启本地诊断日志。"
    Write-TextFile (Join-Path $out "generation-key-events-last-500.jsonl") "未找到 generation.jsonl。可能原因：软件未启动、还没点过生成、或旧版本未开启本地诊断日志。"
  }

  if (Test-Path -LiteralPath $asset) {
    Get-Content -LiteralPath $asset -Tail 300 | Set-Content -LiteralPath (Join-Path $out "asset-errors-last-300.jsonl") -Encoding UTF8
  } elseif (Test-Path -LiteralPath $assetRotated) {
    Get-Content -LiteralPath $assetRotated -Tail 300 | Set-Content -LiteralPath (Join-Path $out "asset-errors-last-300.jsonl") -Encoding UTF8
  }

  $taskLogRoot = Join-Path $logRoot "tasks"
  $taskOut = Join-Path $out "单任务TXT日志"
  if (Test-Path -LiteralPath $taskLogRoot) {
    New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
    $recentTaskLogs = Get-ChildItem -LiteralPath $taskLogRoot -Recurse -File -Filter "*.txt" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 40
    foreach ($taskLog in $recentTaskLogs) {
      $safeName = ($taskLog.Directory.Name + "_" + $taskLog.Name)
      Copy-Item -LiteralPath $taskLog.FullName -Destination (Join-Path $taskOut $safeName) -Force
    }
    if ($recentTaskLogs.Count -eq 0) {
      Write-TextFile (Join-Path $taskOut "未找到单任务日志.txt") "未找到单任务 TXT 日志。可能原因：还没用新版生成过图片。"
    }
  } else {
    New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
    Write-TextFile (Join-Path $taskOut "未找到单任务日志.txt") "未找到单任务 TXT 日志。可能原因：还没用新版生成过图片。"
  }

  foreach ($item in @($genRotated, $assetRotated, $runtime, $runtimeRotated)) {
    if (Test-Path -LiteralPath $item) {
      Copy-Item -LiteralPath $item -Destination (Join-Path $out (Split-Path $item -Leaf)) -Force
    }
  }

  $scanLines = New-Object System.Collections.Generic.List[string]
  $foundPort = $null
  foreach ($port in 8787..8797) {
    $healthUri = "http://127.0.0.1:" + $port + "/api/health"
    try {
      $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 3
      Save-JsonFile $health (Join-Path $out ("health-" + $port + ".json"))
      $scanLines.Add("OK   " + $healthUri)
      if ($null -eq $foundPort) {
        $foundPort = $port
      }
    } catch {
      $scanLines.Add("FAIL " + $healthUri + " | " + $_.Exception.Message)
    }
  }
  Write-TextFile (Join-Path $out "health-scan.txt") ($scanLines -join [Environment]::NewLine)

  if ($null -ne $foundPort) {
    foreach ($path in @("/api/config", "/api/gateways", "/api/gateways/status")) {
      $name = $path.Trim("/").Replace("/", "-") + ".json"
      try {
        $payload = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $foundPort + $path) -TimeoutSec 8
        Save-JsonFile $payload (Join-Path $out $name)
      } catch {
        Write-TextFile (Join-Path $out ($name + ".txt")) ("请求失败：" + $_.Exception.Message)
      }
    }
  } else {
    Write-TextFile (Join-Path $out "health.txt") "没有扫描到正在运行的本地服务。请先双击 静音AI绘画.exe，等浏览器打开后再导出。"
  }

  Save-CommandText { Resolve-DnsName api.jingyin.online } (Join-Path $out "dns-api-jingyin-online.txt")
  Save-CommandText { Test-NetConnection api.jingyin.online -Port 443 -InformationLevel Detailed } (Join-Path $out "network-api-jingyin-online-443.txt")
  Save-CommandText { Get-Process | Where-Object { $_.ProcessName -like "*静音*" -or $_.ProcessName -like "node*" } | Select-Object ProcessName, Id, CPU, WorkingSet64, StartTime } (Join-Path $out "process-info.txt")
  Save-CommandText { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime } (Join-Path $out "system-info.txt")

  $summary = @(
    "导出时间：" + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"),
    "导出目录：" + $out,
    "日志原始目录：" + $logRoot,
    "本地服务端口：" + ($(if ($null -ne $foundPort) { $foundPort } else { "未找到" })),
    "",
    "请把整个文件夹发给管理员/Codex，不需要单独挑文件。"
  )
  Write-TextFile (Join-Path $out "说明.txt") ($summary -join [Environment]::NewLine)

  Write-Host ""
  Write-Host "导出完成：" $out
  Start-Process explorer.exe -ArgumentList $out
  exit 0
} catch {
  Write-Host ""
  Write-Host "导出失败：" $_.Exception.Message
  exit 1
}
`;
const diagnosticBatch = `@echo off
setlocal
title Jingyin AI Diagnostics Export
echo Exporting Jingyin AI diagnostics. Please wait...
echo.
set "SCRIPT=%~dp0export-diagnostics.ps1"
if not exist "%SCRIPT%" (
  echo Missing diagnostics script: %SCRIPT%
  echo Please unzip the full WIN package again and retry.
  echo.
  pause
  exit /b 1
)
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell was not found on this computer.
  echo Please send a screenshot of this window to the administrator.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo Export complete. A diagnostics folder should open on the desktop.
) else (
  echo Export failed. Please send a screenshot of this window to the administrator.
)
echo.
pause
exit /b %EXITCODE%
`;
await writeFile(path.join(releaseDir, "export-diagnostics.ps1"), `\uFEFF${diagnosticPowerShell}`, "utf8");
await writeFile(path.join(releaseDir, "导出诊断日志.bat"), diagnosticBatch, "utf8");
await writeFile(path.join(releaseDir, "导出诊断日志.cmd"), diagnosticBatch, "utf8");
await writeFile(path.join(releaseDir, "使用说明.txt"), `\uFEFF${[
  `${productName} Windows 使用说明`,
  "",
  `版本：${releaseName} / ${productVersion}`,
  "",
  `启动文件：${exeName}`,
  `SHA256：${hash}`,
  `大小：${(exeInfo.size / 1024 / 1024).toFixed(2)} MB`,
  "",
  "使用方法：",
  `1. 双击 ${exeName} 启动软件；弹出的黑色运行框可以最小化，但不要关闭。`,
  "2. 打开 https://api.jingyin.online/ 注册账号。",
  "3. 联系管理员兑换算力：15871470202（手机微信同号）。",
  "4. 回到软件前端服务器页面，填写自己的 KEY 后即可使用。",
  "",
  "数据存放位置（重要）：",
  "1. 历史图片、上传的参考图、结果缓存和日志都不在安装包里，而是保存在你的用户目录：",
  "   %LOCALAPPDATA%\\静音AI绘画数据\\",
  "2. 想查看/清理这些文件：打开软件 → 左下角「设置」→「数据与存储」，可直接“打开目录”，",
  "   也可以分别“清理历史图片”“清理参考图”“清理结果缓存”（会真正删除磁盘文件，无法撤销）。",
  "3. 只点界面上的清空按钮、但磁盘图片还在时，历史会在下次启动被扫描重建；",
  "   要彻底清空，请用上面的“清理历史图片”。",
  "4. 想让数据落到别的盘（便携模式）：用记事本打开同目录的“启动（推荐）.bat”，",
  "   把 DATA_ROOT 改成目标目录（例如 D:\\静音AI绘画数据），之后一律用这个 bat 启动。",
  "5. 卸载：删除本文件夹即可；数据目录需要自行删除或保留。",
  "",
  "排查慢速/卡顿：",
  "1. 软件启动后，如果超过 5 分钟没出图、输入法打字卡、或后台没有生成记录，双击“导出诊断日志.bat”。",
  "2. 弹出的窗口会显示导出进度；桌面会生成“静音AI画板诊断日志_时间”文件夹。",
  "3. 把整个诊断文件夹发给管理员，不需要手动挑文件。",
  "4. 如果 .bat 被电脑拦截，双击同目录的“导出诊断日志.cmd”。",
  "5. 不要删除同目录的 export-diagnostics.ps1；bat/cmd 会调用它导出日志。",
  "6. 手动查找日志路径：%LOCALAPPDATA%\\静音AI绘画数据\\logs\\generation.jsonl。",
  "",
  "模型、渠道、价格和限流：以 api.jingyin.online 后台当前配置为准。",
  "客户端只保存客户自己的静音统一 KEY，不内置渠道商 KEY、上游地址、上游价格或备用渠道策略。",
  "",
  "安装包里不含任何 KEY、历史图片或图片缓存：这些只会在你本机运行时写入",
  "%LOCALAPPDATA%\\静音AI绘画数据\\（历史图/结果缓存/日志），不会打进这个安装包。",
  "",
  "安全提示：渠道商 API、真实上游 KEY、模型映射、价格口径和失败兜底统一由静音中转站控制；APP 不内置上传图、历史图或生成记录。"
].join("\r\n")}`, "utf8");

// ---------------------------------------------------------------------------
// 2026-09-29（v3.7）：发布包结构规范化。
// 以前发布目录只有一个 exe + 说明 + 诊断脚本，用户既不知道数据在哪、也无法校验文件。
// 这里补齐：version.json（版本/构建时间/校验和/数据目录）、更新日志.md、
// 启动（推荐）.bat（可用 DATA_ROOT 指定数据目录 → 便携模式）、tools\校验和.txt。
const buildTime = new Date().toISOString();
const internalVersion = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")).version;

await writeFile(path.join(releaseDir, "version.json"), `\uFEFF${JSON.stringify({
  productName,
  releaseName,
  appVersion: productVersion,
  internalVersion,
  releaseId,
  buildTime,
  executable: exeName,
  sha256: hash,
  sizeBytes: exeInfo.size,
  sizeMB: Number((exeInfo.size / 1024 / 1024).toFixed(2)),
  defaultDataDir: "%LOCALAPPDATA%\\静音AI绘画数据",
  dataDirOverrideEnv: "JINGYIN_RELEASE_ROOT",
  notes: "改动见 更新日志.md"
}, null, 2)}\n`, "utf8");

await writeFile(path.join(releaseDir, "更新日志.md"), `\uFEFF${[
  "# 静音AI画板 更新日志",
  "",
  "## v3.7（2026-09-29）",
  "",
  "### 修复",
  "- 「清空全部」后历史会在下次启动被扫描重建：现在只要 history.json 存在就完全以它为准",
  "  （空数组同样尊重），只有文件缺失/损坏时才走备份恢复或扫描 history-images 重建。",
  "  此前封装版 357 条历史全部是 recovered（无提示词），就是被旧兜底逻辑复活的。",
  "",
  "### 新增",
  "- 设置 →「数据与存储」：显示数据目录路径、历史图片/参考图/结果缓存/日志的个数与占用、历史条数；",
  "  支持一键“打开目录”，并可按类别清理（历史图片会同时把历史清单置空并覆盖备份）。",
  "- 清理是真删磁盘文件，删完立即刷新用量，无法撤销（有二次确认）。",
  "",
  "### 变更",
  "- TT Image 2.5 的 Subdirect 线路（silent-tt25-line-07）改走 JSON + image_urls 提交；",
  "  中转计费表达式只能解析 JSON 请求体，这样线路档位（0.11）才会生效。其它线路/模型不受影响。",
  "- 历史图片的读取不再无条件扫描目录重建，清空之后才会真的空。",
  "",
  "### 打包",
  "- 发布目录不再只有一个 exe，新增：",
  "  · version.json —— 版本号、内部版本、构建时间、exe SHA256/大小、默认数据目录、数据目录覆盖变量；",
  "  · 更新日志.md —— 本文件；",
  "  · 启动（推荐）.bat —— 可用 DATA_ROOT 指定数据目录（便携模式），留空则用默认数据目录；",
  "  · tools\\\\校验和.txt —— exe 的 SHA256 与大小，便于分发核对。",
  "- 使用说明补充：数据目录位置、如何彻底清理、如何自定义数据目录、如何卸载。",
  "",
  "## v3.6（2026-09-27）",
  "",
  "- 首个对外发布的内测封装版本（Node SEA 单文件 exe + 诊断日志导出）。"
].join("\r\n")}\n`, "utf8");

const launcherBatch = `@echo off
setlocal
title Jingyin AI Board Launcher

rem ==========================================================================
rem  静音AI画板 启动器（推荐）
rem
rem  便携模式：把 DATA_ROOT 改成你想要的数据目录（例如 D:\\静音AI绘画数据），
rem  之后一律用这个 bat 启动，历史图片/参考图/日志就会写到那里。
rem  留空（DATA_ROOT=）则使用默认目录 %LOCALAPPDATA%\\静音AI绘画数据
rem ==========================================================================

set "DATA_ROOT="

if not "%DATA_ROOT%"=="" (
  set "JINGYIN_RELEASE_ROOT=%DATA_ROOT%"
  echo Data directory: %JINGYIN_RELEASE_ROOT%
) else (
  echo Data directory: %%LOCALAPPDATA%%\\静音AI绘画数据
)

start "" "%~dp0${exeName}"
exit /b 0
`;
await writeFile(path.join(releaseDir, "启动（推荐）.bat"), launcherBatch, "utf8");

await mkdir(path.join(releaseDir, "tools"), { recursive: true });
await writeFile(path.join(releaseDir, "tools", "校验和.txt"), `\uFEFF${[
  `${productName} ${releaseName}`,
  `构建时间：${buildTime}`,
  `文件：${exeName}`,
  `大小：${(exeInfo.size / 1024 / 1024).toFixed(2)} MB (${exeInfo.size} 字节)`,
  `SHA256：${hash}`,
  "",
  "校验命令（PowerShell）：",
  `  Get-FileHash -Algorithm SHA256 ".\\${exeName}"`,
  "",
  "发行说明：本安装包不含任何 KEY、上传图、历史图片或图片缓存；",
  "这些只会在运行时写入数据目录（默认 %LOCALAPPDATA%\\静音AI绘画数据）。"
].join("\r\n")}\n`, "utf8");

console.log(`Release ready: ${releaseExe}`);
console.log(`SHA256: ${hash}`);
console.log(`Release files: ${exeName}, version.json, 更新日志.md, 启动（推荐）.bat, 使用说明.txt, 导出诊断日志.bat/.cmd, export-diagnostics.ps1, tools/校验和.txt`);
