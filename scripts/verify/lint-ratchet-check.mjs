// ESLint 棘轮：只拦「新增」的 lint 问题，不要求把存量清完。
//
// 为什么是棘轮而不是直接 0 容忍：
//   存量问题里有一部分还没定论（见第 4b 轮报告：masterWearingLockLines、
//   deferOutfitAutoSave、errorDetail、两个大块死代码……），现在就把 lint 接成
//   "必须 0 问题"，等于逼着人当场乱改或者干脆把规则关掉。棘轮把门禁先立起来：
//   存量记账，新增即失败。
//
// 比法：按「文件 + 规则」统计条数（不记行号，行号会随编辑漂移）。
//   - 某个 key 的条数比基线多 → 失败
//   - 出现基线里没有的新 key → 失败
//   - 变少（修掉了）→ 通过；想把新基线记下来就 --update
//
// 用法：
//   node scripts/verify/lint-ratchet-check.mjs            # 检查
//   node scripts/verify/lint-ratchet-check.mjs --update   # 刷新基线（要提交）
//   npm run lint:baseline                                 # 同上
//
// 没装 eslint（例如只 clone 了源码、没跑 npm install）时**跳过**并说明，
// 不让整个验证套件因为缺开发依赖而红。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const BASELINE = path.join(ROOT, "scripts", "verify", "lint-baseline.json");
const UPDATE = process.argv.includes("--update");

if (!existsSync(ESLINT)) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "没有安装 eslint（node_modules/eslint 不存在），棘轮跳过。跑一次 npm install 即可启用。"
  }, null, 2));
  process.exit(0);
}

const run = spawnSync(process.execPath, [ESLINT, ".", "--format", "json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});
if (run.error) {
  console.error(`[lint-ratchet] 执行 eslint 失败：${run.error.message}`);
  process.exit(1);
}
let report = null;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error("[lint-ratchet] eslint 的 JSON 输出无法解析：");
  console.error(String(run.stdout || "").slice(0, 500));
  console.error(String(run.stderr || "").slice(0, 500));
  process.exit(1);
}

/** 统计成 "相对路径|规则" → 条数 */
function countsOf(entries) {
  const counts = {};
  let errors = 0;
  let warnings = 0;
  for (const file of entries) {
    const rel = path.relative(ROOT, file.filePath).replace(/\\/g, "/");
    for (const message of file.messages) {
      const key = `${rel}|${message.ruleId || "(fatal)"}`;
      counts[key] = (counts[key] || 0) + 1;
      if (message.severity === 2) errors += 1;
      else warnings += 1;
    }
  }
  return { counts, errors, warnings };
}

const current = countsOf(report);
const eslintVersion = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "node_modules", "eslint", "package.json"), "utf8")).version;
  } catch { return "unknown"; }
})();

if (UPDATE) {
  writeFileSync(BASELINE, `${JSON.stringify({
    note: "ESLint 棘轮基线：按「文件|规则」记条数，只用来拦新增问题。刷新方式：npm run lint:baseline",
    generatedAt: new Date().toISOString().slice(0, 10),
    eslintVersion,
    totals: { errors: current.errors, warnings: current.warnings, total: current.errors + current.warnings },
    counts: Object.fromEntries(Object.entries(current.counts).sort(([a], [b]) => a.localeCompare(b)))
  }, null, 2)}\n`, "utf8");
  console.log(`[lint-ratchet] 基线已刷新：error ${current.errors} / warning ${current.warnings}（${Object.keys(current.counts).length} 个 文件|规则 分组）`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("[lint-ratchet] 找不到基线文件 scripts/verify/lint-baseline.json，先跑一次 npm run lint:baseline");
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

const regressions = [];
for (const [key, count] of Object.entries(current.counts)) {
  const before = baseline.counts[key] ?? 0;
  if (count > before) regressions.push({ key, before, now: count });
}
regressions.sort((a, b) => b.now - b.before - (a.now - a.before) || a.key.localeCompare(b.key));

const improved = Object.entries(baseline.counts)
  .filter(([key, before]) => (current.counts[key] ?? 0) < before)
  .map(([key, before]) => ({ key, before, now: current.counts[key] ?? 0 }));

const ok = regressions.length === 0;
console.log(JSON.stringify({
  ok,
  eslintVersion,
  baseline: { generatedAt: baseline.generatedAt, ...baseline.totals },
  current: { errors: current.errors, warnings: current.warnings, total: current.errors + current.warnings },
  regressions,
  improved: improved.slice(0, 10),
  note: ok
    ? "没有新增 lint 问题；存量按基线记账（棘轮只拦新增）"
    : `新增了 ${regressions.length} 组 lint 问题，请修掉；确实要接受就 npm run lint:baseline 并说明原因`
}, null, 2));
process.exit(ok ? 0 : 1);
