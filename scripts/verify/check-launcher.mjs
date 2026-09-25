// 启动器静态检查 + 真实退出码检查（不启动真实服务、不联网、不产生费用）。
//
// 覆盖要求：
//   - 启动器不再把 Node 写死为 D:\RJ\node\node.exe（只允许作为最后兜底）
//   - 探测顺序：项目目录内 -> 启动脚本附近 -> PATH -> 常见安装路径 -> 旧固定路径
//   - .bat 只含 ASCII（cmd 用当前代码页解析 bat，混入中文会误解析）
//   - .ps1 是 UTF-8 with BOM（Windows PowerShell 5.1 才能正确读中文）
//   - .ps1 能被 PowerShell 解析器解析（0 语法错误）
//   - Node 启动失败时保留真实退出码（用受控 fixture 实测）
//
// 用法：node scripts/verify/check-launcher.mjs
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
let failures = 0;
const lines = [];
function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const batPath = path.join(root, "启动静音内测画板.bat");
const ps1Path = path.join(root, "scripts", "start-jingyin-board.ps1");

check("启动 bat 存在", existsSync(batPath), batPath);
check("启动 ps1 存在", existsSync(ps1Path), ps1Path);

// ---------------------------------------------------------------- .bat 只含 ASCII
const batBytes = readFileSync(batPath);
const nonAscii = [...batBytes].filter((byte) => byte > 127).length;
check("启动 bat 只含 ASCII 字节", nonAscii === 0, `non-ascii=${nonAscii}`);

const batText = batBytes.toString("utf8");
check("bat 引用了 ps1 启动脚本", batText.includes("start-jingyin-board.ps1"));
check("bat 把工作目录固定为源码目录", batText.includes('pushd "%APP_DIR%"'));
check("bat 透传参数给 ps1", batText.includes("%*"));
check("bat 失败时 pause 不静默关窗", /pause\s*>\s*nul/.test(batText) || /pause\b/.test(batText));
check("bat 会打印真实退出码", batText.includes("%START_EXIT%"));
check("bat 不再出现旧的写死路径文案", !batText.includes("D:\\RJ\\node\\node.exe"));

// ---------------------------------------------------------------- .ps1 编码与语法
const ps1Bytes = readFileSync(ps1Path);
const hasBom = ps1Bytes[0] === 0xef && ps1Bytes[1] === 0xbb && ps1Bytes[2] === 0xbf;
check("ps1 是 UTF-8 with BOM", hasBom, `first bytes = ${[...ps1Bytes.slice(0, 3)].map((b) => b.toString(16)).join(" ")}`);

const ps1Text = ps1Bytes.toString("utf8");

// 写死的旧路径只能出现在最后兜底那一条（注释里提到旧路径不算代码依赖）
const ps1CodeLines = ps1Text
  .split(/\r?\n/)
  .filter((line) => !line.trimStart().startsWith("#"));
const legacyMatches = ps1CodeLines
  .map((line) => [...line.matchAll(/D:\\RJ\\node\\node\.exe/g)].length)
  .reduce((sum, count) => sum + count, 0);
check("ps1 代码里 D:\\RJ\\node\\node.exe 只出现一次（最后兜底）", legacyMatches === 1, `count=${legacyMatches}`);
check(
  "ps1 把旧路径标记为 legacy-fallback",
  /legacy-fallback/.test(ps1Text) && /D:\\RJ\\node\\node\.exe"; Source = "legacy-fallback"/.test(ps1Text)
);

// 探测顺序：源码里的 return 顺序必须与要求一致
const searchFn = ps1Text.slice(
  ps1Text.indexOf("function Get-NodeSearchLocations"),
  ps1Text.indexOf("function Find-NodeExecutable")
);
const orderMarkers = ['"project-local"', '"launcher-dir"', '"PATH"', '"common-install"', '"legacy-fallback"'];
let lastIndex = -1;
let ordered = true;
for (const marker of orderMarkers) {
  const index = searchFn.indexOf(marker);
  if (index < 0 || index < lastIndex) { ordered = false; break; }
  lastIndex = index;
}
check("探测顺序 = 项目内 -> 启动脚本附近 -> PATH -> 常见路径 -> 旧固定路径", ordered);

check("ps1 真正执行 node -v 验证可用性", ps1Text.includes("& $ExePath -v"));
check("ps1 支持 .cmd/.bat shim 解析", ps1Text.includes("Resolve-NodeShim"));
check(
  "项目自带运行时 runtime\\node\\node.exe 是第一优先",
  searchFn.indexOf('"runtime\\node\\node.exe"') > 0
    && searchFn.indexOf('"runtime\\node\\node.exe"') < searchFn.indexOf('"node\\node.exe"')
    && searchFn.indexOf('"runtime\\node\\node.exe"') < searchFn.indexOf('"launcher-dir"')
    && searchFn.indexOf('"runtime\\node\\node.exe"') < searchFn.indexOf('"PATH"'),
  `runtime-first index=${searchFn.indexOf('"runtime\\node\\node.exe"')}`
);
check("ps1 支持 nvm/fnm/volta/winget/choco 目录展开", ps1Text.includes("Add-NodeVersionCandidates") && ps1Text.includes("version-manager"));
check("ps1 支持其它程序自带的 Node 运行时", ps1Text.includes("app-bundled"));

// 项目自带运行时是否真的可用（存在就必须能跑 -v）
const localNode = path.join(root, "runtime", "node", "node.exe");
if (existsSync(localNode)) {
  const v = spawnSync(localNode, ["-v"], { encoding: "utf8" });
  check(
    "项目自带 runtime\\node\\node.exe 可执行",
    v.status === 0 && /^v\d+\.\d+\.\d+/.test(String(v.stdout || "").trim()),
    `${String(v.stdout || "").trim()} ${String(v.stderr || "").trim()}`.trim()
  );
} else {
  check("项目自带 runtime\\node\\node.exe（不存在，跳过可执行检查）", true, "未随源码包提供，将依赖机器上的 Node");
}

check("提供 provision-local-node.ps1 以便重建运行时", existsSync(path.join(root, "scripts", "provision-local-node.ps1")));
check("ps1 保留 Node 真实退出码", /real exit code/.test(ps1Text) && /exit \$nodeExitCode/.test(ps1Text));
check(
  "ps1 用 .NET Process + cmd 重定向（PS 5.1 下 Start-Process -PassThru 读不到 ExitCode）",
  ps1Text.includes("System.Diagnostics.ProcessStartInfo") && ps1Text.includes("/d /s /c")
);
check("ps1 进程退出后不再退化成超时分支", /if \(\$exited\) \{/.test(ps1Text));
check("ps1 检查 /api/health", ps1Text.includes("/api/health"));
check("ps1 输出未找到 Node 的明确提示", ps1Text.includes("未找到可用 Node.js"));
check("ps1 输出探测过的路径清单", ps1Text.includes("Probed locations"));
check("ps1 给出安装/PATH 解决方法", ps1Text.includes("nodejs.org") && ps1Text.includes("PATH"));
check("ps1 不再提示直接双击 node.exe", !/Do not open D:\\RJ/.test(ps1Text));
check("ps1 保留自动打开浏览器逻辑", ps1Text.includes("Start-Process $AppUrl"));
check("ps1 支持 -NoOpen", ps1Text.includes("[switch]$NoOpen"));

// ---------------------------------------------------------------- 窗口常驻 + 跟随日志
// 需求（2026-09-25）：点启动器进去页面后，黑框不要自动消失；窗口留着并能看服务日志。
// 服务本身在独立进程里跑，所以"关窗"与"停服务"是两件事。
check("ps1 支持 -KeepOpen（窗口常驻 + 跟随日志）",
  ps1Text.includes("[switch]$KeepOpen"), "[switch]$KeepOpen");
check("bat 把 -KeepOpen 传给 ps1",
  /-File "%START_SCRIPT%" -KeepOpen/.test(batText), "bat → ps1");
check("bat 成功后不再 8 秒自动关窗",
  !/timeout\s+\/t\s+8/.test(batText), "没有 timeout /t 8");
check("bat 成功后用 pause 顶住窗口",
  /LAUNCHER FINISHED[\s\S]{0,600}?pause\s*>\s*nul/.test(batText), "pause 在收尾提示之后");
check("bat 明确告知关窗不会停服务",
  /Closing this window does NOT stop the server/.test(batText), "提示文案");
check("bat 把跟随日志被 Ctrl+C 中断当成正常收尾（不当启动失败）",
  batText.includes(":follow_stopped") && batText.includes('"%START_EXIT%"=="-1073741510"'),
  "follow_stopped 分支");
check("ps1 在 -KeepOpen 时跟随日志（Get-Content -Wait）",
  /Get-Content\s+-LiteralPath\s+\$ServerLog[\s\S]{0,40}-Wait/.test(ps1Text), "Get-Content -Wait $ServerLog");
check("ps1 在 -KeepOpen 时提示关窗不停服务",
  ps1Text.includes("关闭窗口不会停止服务"), "提示文案");
check("ps1 的跟随日志代码在成功路径之后（exit 0 之前）",
  ps1Text.indexOf("if ($KeepOpen)") > ps1Text.indexOf("启动成功 / started successfully")
    && ps1Text.indexOf("if ($KeepOpen)") < ps1Text.lastIndexOf("exit 0"),
  `keepOpenIndex=${ps1Text.indexOf("if ($KeepOpen)")}`);

// PowerShell 解析器语法检查
const parseScript = [
  "$errors = $null; $tokens = $null;",
  `[System.Management.Automation.Language.Parser]::ParseFile('${ps1Path.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors) | Out-Null;`,
  "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output (\"{0}: {1}\" -f $_.Extent.StartLineNumber, $_.Message) }; exit 1 }",
  "Write-Output 'PARSE_OK'; exit 0"
].join(" ");
const parseResult = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", parseScript],
  { encoding: "utf8", cwd: root }
);
check(
  "ps1 通过 PowerShell 解析（0 语法错误）",
  parseResult.status === 0 && String(parseResult.stdout || "").includes("PARSE_OK"),
  `${String(parseResult.stdout || "").trim()} ${String(parseResult.stderr || "").trim()}`.trim()
);

// ------------------------------------------- Node 启动失败必须保留真实退出码（实测）
const fixtureRelative = "scripts\\verify\\fixtures\\exit-code-fixture.cjs";
const expectedCode = 7;
// 用一个隔离端口，避免机器上真的跑着本项目服务时命中"already running"分支。
const isolatedPort = 8799;
const runResult = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ps1Path,
    "-NoOpen",
    "-Port", String(isolatedPort),
    "-ServerEntryRelative", fixtureRelative
  ],
  {
    encoding: "utf8",
    cwd: root,
    timeout: 120000,
    env: { ...process.env, JINGYIN_LAUNCHER_FIXTURE_EXIT_CODE: String(expectedCode) }
  }
);
const combined = `${runResult.stdout || ""}\n${runResult.stderr || ""}`;
check(
  "fixture 失败时 ps1 退出码等于 Node 真实退出码",
  runResult.status === expectedCode,
  `ps1 exit=${runResult.status}, expected=${expectedCode}`
);
check(
  "ps1 明确打印了真实退出码",
  combined.includes(`real exit code: ${expectedCode}`),
  combined.split("\n").find((line) => line.includes("real exit code")) || "(未找到该行)"
);
check(
  "fixture 失败时没有打印“启动成功”",
  !combined.includes("启动成功") && !combined.includes("started successfully")
);
check(
  "fixture 失败时保留了失败快照日志",
  /launcher-failure-\d{8}-\d{6}\.log/.test(combined),
  combined.split("\n").find((line) => line.includes("launcher-failure")) || "(未找到该行)"
);

console.log(lines.join("\n"));
console.log(`\n[check-launcher] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
