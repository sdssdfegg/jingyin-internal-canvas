// V11 干净开发基线：生成可校验、可回滚的快照（本机没有 git，用等效快照代替）。
//
// 只纳入「源码开发需要的东西」：
//   src/ server/ prompts/ scripts/ public/ docs/ API/ V11维护文档/
//   index.html vite.config.js package.json package-lock.json .env.example .gitignore
//   启动静音内测画板.bat scripts/*.ps1 以及根目录的说明/报告类 .md
//
// 明确排除（不纳入基线，也不删除，仍在工作目录里）：
//   node_modules/ dist/ logs/ data/ tmp/ .codex-artifacts/ .secure-build/ .release-temp/
//   runtime/node/**（85MB 运行时二进制：保留在工作目录，只记录大小与 SHA-256）
//   任何 .env（真实密钥）/ *.log / *.local
//
// 用法：node scripts/baseline/create-baseline.mjs [--id NAME]
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const idArgIndex = process.argv.indexOf("--id");
// "2026-09-24T17:41:45.123Z" → "20260924-174145"
const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const BASELINE_ID = idArgIndex > -1 && process.argv[idArgIndex + 1]
  ? String(process.argv[idArgIndex + 1])
  : `V11-baseline-${stamp}`;
const OUT_DIR = path.join(ROOT, "baselines", BASELINE_ID);
const TREE_DIR = path.join(OUT_DIR, "tree");

// 纳入基线的目录/文件（白名单）
const INCLUDE_DIRS = ["src", "server", "prompts", "scripts", "public", "docs", "API", "V11维护文档"];
const INCLUDE_ROOT_FILES = [
  "index.html",
  "vite.config.js",
  "package.json",
  "package-lock.json",
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "版本记录.md",
  "V3-封存说明.md",
  "启动静音内测画板.bat"
];
const EXCLUDE_DIR_NAMES = new Set([
  "node_modules", "dist", "logs", "data", "tmp", ".codex-artifacts", ".secure-build",
  ".release-temp", "baselines", ".git", "runtime"
]);
const EXCLUDE_FILE_PATTERNS = [
  /\.log$/i,
  /\.local$/i,
  /^\.env$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.zip$/i,
  /\.7z$/i
];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function shouldExcludeFile(name, fullPath) {
  if (EXCLUDE_FILE_PATTERNS.some((pattern) => pattern.test(name))) return true;
  if (EXCLUDE_DIR_NAMES.has(name)) return true;
  // 用户数据/日志/密钥类目录下的任何东西都不进基线
  return /[\\/](data|logs|tmp|node_modules|dist|runtime|\.codex-artifacts|\.secure-build|\.release-temp|baselines)[\\/]/i.test(fullPath);
}

function walk(dir, collected) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      walk(full, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldExcludeFile(entry.name, full)) continue;
    collected.push(full);
  }
}

if (existsSync(OUT_DIR)) {
  console.error(JSON.stringify({ ok: false, error: `基线目录已存在，换个 --id：${path.relative(ROOT, OUT_DIR)}` }, null, 2));
  process.exit(1);
}

const files = [];
for (const dir of INCLUDE_DIRS) {
  const full = path.join(ROOT, dir);
  if (existsSync(full) && statSync(full).isDirectory()) walk(full, files);
}
for (const name of INCLUDE_ROOT_FILES) {
  const full = path.join(ROOT, name);
  if (existsSync(full) && statSync(full).isFile()) files.push(full);
}
// 根目录的报告/说明类 .md（保留历史交付记录，方便回滚时对照）
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
  if (INCLUDE_ROOT_FILES.includes(entry.name)) continue;
  if (shouldExcludeFile(entry.name, path.join(ROOT, entry.name))) continue;
  files.push(path.join(ROOT, entry.name));
}

files.sort((a, b) => a.localeCompare(b));

const manifestFiles = [];
let totalBytes = 0;
for (const file of files) {
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  const target = path.join(TREE_DIR, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(file, target);
  const size = statSync(file).size;
  totalBytes += size;
  manifestFiles.push({ path: relative, bytes: size, sha256: sha256(target) });
}

// runtime/node 运行时：保留在工作目录，只登记大小与校验值（不复制进基线）
const runtimeDir = path.join(ROOT, "runtime", "node");
const runtimeEntries = [];
if (existsSync(runtimeDir)) {
  for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(runtimeDir, entry.name);
    runtimeEntries.push({
      path: `runtime/node/${entry.name}`,
      bytes: statSync(full).size,
      sha256: sha256(full)
    });
  }
}

// 用户数据/配置：不做副本，但登记校验值，确保基线前后"用户数据没被动过"
const userDataFiles = ["data/history.json", "data/app-settings.json", "data/history.backup.json"];
const userDataState = [];
for (const relative of userDataFiles) {
  const full = path.join(ROOT, relative);
  if (!existsSync(full)) continue;
  userDataState.push({ path: relative, bytes: statSync(full).size, sha256: sha256(full) });
}

const manifest = {
  baselineId: BASELINE_ID,
  createdAt: new Date().toISOString(),
  createdAtLocal: new Date().toLocaleString("zh-CN"),
  root: ROOT,
  scheme: "本机没有 git，因此用「完整源码快照 + SHA-256 清单 + 回滚脚本」作为等效基线",
  included: {
    dirs: INCLUDE_DIRS,
    rootFiles: INCLUDE_ROOT_FILES,
    note: "根目录所有 .md（含历史交付报告）也纳入，便于对照回滚点"
  },
  excluded: {
    dirs: [...EXCLUDE_DIR_NAMES],
    patterns: EXCLUDE_FILE_PATTERNS.map((pattern) => String(pattern)),
    reason: "运行依赖(node_modules)、构建产物(dist)、日志(logs)、用户数据(data)、临时产物(tmp/.codex-artifacts/.secure-build/.release-temp)、真实密钥(.env)都不进基线"
  },
  runtime: {
    note: "runtime/node 是启动必需的本地运行时，保留在工作目录、不从基线删除也不复制进快照；此处登记校验值，需要时可核对",
    files: runtimeEntries
  },
  userDataSnapshot: {
    note: "用户数据不复制、不清理；这里只登记 SHA-256，用于证明建立基线没有改动用户数据",
    files: userDataState
  },
  counts: {
    files: manifestFiles.length,
    bytes: totalBytes
  },
  files: manifestFiles
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const restoreScript = `# 回滚到 ${BASELINE_ID}

本机没有 git，用这个快照回滚。

## 回滚整份源码

\`\`\`powershell
# 1) 先备份当前状态（不要跳过）
Copy-Item -Recurse -Force "D:\\源码开发\\静音AI绘画（源码）" "D:\\源码开发\\_before-rollback-$(Get-Date -Format yyyyMMdd-HHmmss)"

# 2) 把快照里的源码覆盖回去（只覆盖基线纳入的文件，不动 data/ logs/ runtime/ node_modules/）
Copy-Item -Recurse -Force "${path.join(OUT_DIR, "tree", "*")}" "D:\\源码开发\\静音AI绘画（源码）"
\`\`\`

## 只回滚单个文件

\`\`\`powershell
Copy-Item -Force "${path.join(OUT_DIR, "tree", "src", "main.jsx")}" "D:\\源码开发\\静音AI绘画（源码）\\src\\main.jsx"
\`\`\`

## 校验快照完整性

\`\`\`powershell
node scripts/baseline/verify-baseline.mjs --id ${BASELINE_ID}
\`\`\`

## 这个基线包含什么

- 纳入：${INCLUDE_DIRS.join(" / ")}，以及根目录的源码/配置/启动器/说明与报告 .md
- 排除：node_modules、dist、logs、data、tmp、.codex-artifacts、.secure-build、.release-temp、真实 .env
- runtime/node：保留在工作目录（未删除、未复制），校验值见 manifest.json
`;
writeFileSync(path.join(OUT_DIR, "RESTORE.md"), restoreScript, "utf8");

console.log(JSON.stringify({
  ok: true,
  baselineId: BASELINE_ID,
  snapshotPath: path.relative(ROOT, OUT_DIR),
  treePath: path.relative(ROOT, TREE_DIR),
  files: manifestFiles.length,
  bytes: totalBytes,
  runtimeFiles: runtimeEntries.length,
  userDataRegistered: userDataState.length,
  manifestSha256: sha256(path.join(OUT_DIR, "manifest.json"))
}, null, 2));
