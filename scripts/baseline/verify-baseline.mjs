// 校验一份基线快照：逐文件比对 SHA-256，确认快照与清单一致、且没有被改动过。
//
// 用法：node scripts/baseline/verify-baseline.mjs [--id V11-baseline-XXXX]
//      node scripts/baseline/verify-baseline.mjs --id <ID> --against-live   # 同时比对工作目录当前状态
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const idArgIndex = process.argv.indexOf("--id");
let baselineId = idArgIndex > -1 ? String(process.argv[idArgIndex + 1] || "") : "";
const againstLive = process.argv.includes("--against-live");

const baselinesDir = path.join(ROOT, "baselines");
if (!existsSync(baselinesDir)) {
  console.error(JSON.stringify({ ok: false, error: "还没有任何基线（baselines/ 不存在）" }, null, 2));
  process.exit(1);
}
if (!baselineId) {
  const dirs = readdirSync(baselinesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  baselineId = dirs[dirs.length - 1] || "";
}
if (!baselineId) {
  console.error(JSON.stringify({ ok: false, error: "baselines/ 下没有快照" }, null, 2));
  process.exit(1);
}

const outDir = path.join(baselinesDir, baselineId);
const manifestPath = path.join(outDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(JSON.stringify({ ok: false, error: `找不到清单：${path.relative(ROOT, manifestPath)}` }, null, 2));
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const problems = [];
let verified = 0;
const liveMismatch = [];

for (const item of manifest.files || []) {
  const snapshotFile = path.join(outDir, "tree", item.path);
  if (!existsSync(snapshotFile)) {
    problems.push({ type: "missing_in_snapshot", path: item.path });
    continue;
  }
  const size = statSync(snapshotFile).size;
  if (size !== item.bytes) {
    problems.push({ type: "size_mismatch", path: item.path, expected: item.bytes, actual: size });
    continue;
  }
  const hash = sha256(snapshotFile);
  if (hash !== item.sha256) {
    problems.push({ type: "sha256_mismatch", path: item.path, expected: item.sha256, actual: hash });
    continue;
  }
  verified += 1;

  if (againstLive) {
    const liveFile = path.join(ROOT, item.path);
    if (!existsSync(liveFile)) {
      liveMismatch.push({ path: item.path, state: "deleted_since_baseline" });
    } else if (sha256(liveFile) !== item.sha256) {
      liveMismatch.push({ path: item.path, state: "changed_since_baseline" });
    }
  }
}

// runtime 与用户数据只核对"还在不在"和大小，不做强制哈希比对（运行时二进制不该被改）
const runtimeIssues = [];
for (const item of manifest.runtime?.files || []) {
  const full = path.join(ROOT, item.path);
  if (!existsSync(full)) {
    runtimeIssues.push({ path: item.path, state: "missing" });
    continue;
  }
  const size = statSync(full).size;
  if (size !== item.bytes) runtimeIssues.push({ path: item.path, state: "size_changed", expected: item.bytes, actual: size });
}
const userDataIssues = [];
for (const item of manifest.userDataSnapshot?.files || []) {
  const full = path.join(ROOT, item.path);
  if (!existsSync(full)) {
    userDataIssues.push({ path: item.path, state: "missing" });
    continue;
  }
  if (sha256(full) !== item.sha256) userDataIssues.push({ path: item.path, state: "changed_since_baseline" });
}

console.log(JSON.stringify({
  ok: problems.length === 0,
  baselineId: manifest.baselineId,
  createdAt: manifest.createdAtLocal || manifest.createdAt,
  snapshotPath: path.relative(ROOT, outDir),
  filesInManifest: (manifest.files || []).length,
  filesVerified: verified,
  problems,
  runtime: { issues: runtimeIssues, checked: (manifest.runtime?.files || []).length },
  userData: {
    issues: userDataIssues,
    checked: (manifest.userDataSnapshot?.files || []).length,
    note: "用户数据在建立基线后如果发生变化（例如你自己生成了新图）也会显示在这里，这属于正常使用，不是基线损坏"
  },
  againstLive: againstLive ? { compared: (manifest.files || []).length, differences: liveMismatch.length, items: liveMismatch.slice(0, 50) } : null
}, null, 2));

if (problems.length > 0) process.exitCode = 1;
