// 一键跑完全部验证脚本（`npm test` / `pnpm test` 的入口）。
//
// 为什么需要它：这些脚本以前只能手工逐个敲，等于"测试写了但没人跑"。
// 现在有一个统一入口：顺序执行、汇总结果、任何一个失败就以非 0 退出（能被 CI 拦住）。
//
// 用法：
//   node scripts/verify/run-all.mjs                 # 全部
//   node scripts/verify/run-all.mjs --only history  # 只跑名字含 history 的
//   node scripts/verify/run-all.mjs --skip-launcher # 跳过启动器检查（会起子进程，较慢）
//   node scripts/verify/run-all.mjs --json          # 输出机器可读结果
//   node scripts/verify/run-all.mjs --list          # 只打印这次会跑哪些脚本，不执行
//
// 注意：部分脚本需要本地 8787 在跑才能验证浏览器行为；不在跑时会自行跳过浏览器部分，
// 不影响整体通过（会在结果里标注 skipped）。

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const VERIFY_DIR = path.join(ROOT, "scripts", "verify");
const NODE = process.execPath; // 用当前运行时，保证与跑脚本的是同一个 node

/**
 * 执行顺序有意设计：先便宜且纯逻辑的，再跑要起进程/浏览器、较慢的，
 * 这样出错时能最快给出反馈。
 *
 * 说明：`crop-geometry-page.js` 与 `error-boundary-page.jsx` 是**浏览器侧模块**
 * （由其它脚本或手工 import 到页面里跑），不是可独立执行的脚本，因此不在本列表内。
 *
 * 每个脚本都自带测试实例（自己起服务、自己的沙盒数据目录、跑完自己收），
 * 所以这里顺序执行即可，不依赖你本机 8787 上是否开着开发服务。
 */
const ORDER = [
  "run-node-check",
  "image-host-allowlist-check",
  "canvas-asset-check",
  "history-repair-check",
  "history-integrity-check",
  "local-edit-ratio-check",
  "local-edit-base-file-check",
  "resize-long-edge-check",
  "generation-error-check",
  "reference-gate-check",
  "batch-prompt-passthrough-check",
  "connection-test-check",
  "http-mock-check",
  "generation-failure-path-check",
  "outfit-defer-autosave-check",
  "pro-wire-check",
  "error-boundary-check",
  "routing-check",
  "ui-duplication-check",
  "modal-shell-check",
  "quickgen-prompt-passthrough-check",
  // 2026-09-26：批量换装结构化意图 + 唯一精简提示词编译器。
  // 前者是纯逻辑断言（七种部位组合 / 层级 / 穿法 / 事实过滤 / 字符数）；
  // 后者用本地 mock 上游钉住"结构化意图真的进了发给模型的最终提示词"。
  "outfit-intent-check",
  "outfit-intent-request-check",
  "lint-ratchet-check",
  "run-all-check",
  "check-launcher"
];

/**
 * 只读取证 / 诊断工具：**不做断言**、恒以 0 退出，输出取决于跑的时候日志里恰好有什么。
 * 它们不适合当回归门禁（永远绿，等于没测），所以不进 ORDER，也不由 run-all 执行。
 * 需要时直接跑：node scripts/verify/speed-investigation.mjs
 */
const TOOLS = [
  "speed-investigation"
];

/** 可直接执行的脚本（.mjs）；.js/.jsx 是浏览器侧模块，由脚本内部或手工加载。 */
function discoverRunnable() {
  if (!existsSync(VERIFY_DIR)) return [];
  return readdirSync(VERIFY_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.replace(/\.mjs$/, ""));
}

/**
 * `__` 开头的是测试夹具 / 临时脚本（run-all-check 会临时丢一个必失败的夹具进来）。
 * 它们**默认不跑**：夹具是给元测试用的，不该进正式门禁；
 * 而且夹具清理失败时（Windows 句柄延迟）残留一个必失败文件，
 * 会把下一次 `npm test` 整体带崩——这种自毒效果必须避免。
 * 但 `--only __xxx` 明确点名时仍然可选中，否则元测试没法验证"失败会传播"。
 */
const isFixture = (name) => name.startsWith("__");

/**
 * run-all 自己永远不参与执行：`discoverRunnable()` 会扫到它，
 * 一旦当成普通脚本跑，就是 run-all 跑 run-all，再各自跑一遍全部脚本——
 * 递归爆炸（这个坑在接入时被 `--list` 抓到了）。`--only run-all` 也不放行。
 */
const isSelf = (name) => name === "run-all";

function orderScripts(all) {
  const runnable = all.filter((name) => !TOOLS.includes(name) && !isSelf(name));
  const known = ORDER.filter((name) => runnable.includes(name));
  const extra = runnable.filter((name) => !ORDER.includes(name));
  return [...known, ...extra];
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex > -1 ? String(args[onlyIndex + 1] || "").trim() : "";
const skipLauncher = args.includes("--skip-launcher");
const asJson = args.includes("--json");
const listOnly = args.includes("--list");

if (onlyIndex > -1 && !only) {
  console.error("--only 后面要跟名字片段，例如 --only history");
  process.exit(2);
}

const discovered = discoverRunnable();
// 默认只跑正式脚本（排除夹具）；`--only` 明确点名时可以选到夹具，
// 但无论如何都排除 run-all 自己（见 isSelf）。
let scripts = orderScripts(only ? discovered.filter((name) => !isSelf(name)) : discovered.filter((name) => !isFixture(name)));
if (only) scripts = scripts.filter((name) => name.includes(only));
if (skipLauncher) scripts = scripts.filter((name) => name !== "check-launcher");

if (scripts.length === 0) {
  console.error(`没有匹配的验证脚本（--only ${only || "-"}）`);
  process.exit(2);
}

// --list：只打印这次会跑哪些脚本，不执行。给人看，也让元测试能便宜地断言选择逻辑。
if (listOnly) {
  console.log(scripts.join("\n"));
  process.exit(0);
}

function runOne(name) {
  const file = path.join(VERIFY_DIR, `${name}.mjs`);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(NODE, [file], { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolve({ name, ok: false, ms: Date.now() - startedAt, exitCode: -1, stdout, stderr: String(error?.message || error), summary: "" });
    });
    child.on("close", (code) => {
      resolve({
        name,
        ok: code === 0,
        ms: Date.now() - startedAt,
        exitCode: code,
        stdout,
        stderr,
        summary: summarize(name, stdout, stderr)
      });
    });
  });
}

/** 从脚本输出里摘一行摘要，方便一眼看出跑了多少项。 */
function summarize(name, stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const jsonMatch = /"passed":\s*(\d+)[\s\S]{0,200}?"total":\s*(\d+)/.exec(text);
  if (jsonMatch) return `passed ${jsonMatch[1]}/${jsonMatch[2]}`;
  const countMatch = /失败 (\d+) 项 \/ 共 (\d+) 项/.exec(text);
  if (countMatch) return `失败 ${countMatch[1]} / 共 ${countMatch[2]} 项`;
  const targetMatch = /目标 (\d+) 个，失败 (\d+) 个/.exec(text);
  if (targetMatch) return `目标 ${targetMatch[1]} 个 / 失败 ${targetMatch[2]} 个`;
  const okFail = /"ok":\s*(true|false)/.exec(text);
  if (okFail) return `ok=${okFail[1]}`;
  if (/skipped/.test(text)) return "部分跳过（浏览器未运行）";
  return "";
}

const results = [];
const overallStart = Date.now();
for (const name of scripts) {
  process.stdout.write(`▶ ${name} … `);
  // 顺序执行便于定位失败点（且部分脚本要占用端口，不能并发）
  const result = await runOne(name);
  results.push(result);
  process.stdout.write(`${result.ok ? "通过" : "失败"} (${result.ms} ms)${result.summary ? "  " + result.summary : ""}\n`);
  if (!result.ok) {
    const tail = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(Boolean).slice(-14);
    process.stdout.write(`  失败详情（末 14 行）：\n${tail.map((line) => "    " + line).join("\n")}\n`);
  }
}

const failed = results.filter((item) => !item.ok);
const totalMs = Date.now() - overallStart;
const summaryLine = `[run-all] ${results.length} 个脚本：通过 ${results.length - failed.length}，失败 ${failed.length}，用时 ${(totalMs / 1000).toFixed(1)}s`;

if (asJson) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    scripts: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    totalMs,
    entries: results.map((item) => ({ name: item.name, ok: item.ok, ms: item.ms, summary: item.summary, exitCode: item.exitCode }))
  }, null, 2));
} else {
  console.log("");
  console.log(summaryLine);
  if (failed.length > 0) {
    console.log(`[run-all] 失败脚本：${failed.map((item) => item.name).join(", ")}`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
