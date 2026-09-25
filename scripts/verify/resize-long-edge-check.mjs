// 批量尺寸「最长边」默认值验证（自建实例 + 真实浏览器，不打上游、不扣费）。
//
// 背景：`DEFAULT_RESIZE_SETTINGS.longEdge` 早在之前就写成了 3500，但老用户看不到——
// 因为存档（localStorage `jingyin-outfit-workflow-resize-settings-v4`）里存的是当年的默认值 3000，
// `normalizeResizeSettings` 会"原样保留用户保存过的值"。
// 所以真正要验的是**迁移**：3000 → 3500，而自定义值不能被动。
//
// 覆盖：
//   源码级：默认值 3500、迁移逻辑在、迁移只认旧默认值 3000
//   浏览器：存档 3000 → 输入框显示 3500；存档 2000 → 仍 2000；无存档 → 3500
//
// 关于实例：Vite 的 root 就是 server 的 rootDir（= JINGYIN_RELEASE_ROOT），所以不能带沙盒
// root（否则模块取不到）。这里用自己的端口 8811 + 独立 origin，不动用户的浏览器存储；
// data/ 是共享的，前后比对 history.json 指纹。
//
// 用法：node scripts/verify/resize-long-edge-check.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { installExitCleanup, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8811;
const OUTFIT_FILE = path.join(ROOT, "src", "outfit-workflow.jsx");
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CLI = path.join(process.env.LOCALAPPDATA || "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

const hashOf = (file) => {
  try { return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "(不存在)"; }
  catch { return "(读不到)"; }
};

// ---------------------------------------------------------------- 源码级
const outfitSrc = readFileSync(OUTFIT_FILE, "utf8");
check("默认最长边是 3500", /longEdge:\s*3500/.test(outfitSrc), "DEFAULT_RESIZE_SETTINGS.longEdge");
check("保留旧默认值常量用于迁移", /LEGACY_RESIZE_LONG_EDGE_DEFAULT\s*=\s*3000/.test(outfitSrc), "3000");
check("normalizeResizeSettings 里有迁移（只认旧默认值）",
  /LEGACY_RESIZE_LONG_EDGE_DEFAULT\)\s*\{\s*next\.longEdge\s*=\s*DEFAULT_RESIZE_SETTINGS\.longEdge/.test(outfitSrc),
  "3000 → 3500");

// ---------------------------------------------------------------- 浏览器
let child = null;
let facts = null;
let browserReason = "";
const historyBefore = hashOf(HISTORY_FILE);
try {
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PORT: String(APP_PORT), JINGYIN_PORT_FALLBACK_LIMIT: "0", JINGYIN_NO_BROWSER: "1" }
  });
  installExitCleanup({ getChild: () => child });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  if (!existsSync(CLI)) {
    browserReason = "tabbit-cli 不存在，跳过浏览器部分";
  } else {
    const program = `
const mod = async () => (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now()));
await page.goto("http://127.0.0.1:${APP_PORT}/", {waitUntil: "domcontentloaded"});
await page.waitForTimeout(2400);
const facts = { };
// 1) 老存档：3000（旧默认值）
await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); m.setStoredLongEdge(3000); });
await page.reload({waitUntil: "domcontentloaded"});
await page.waitForTimeout(2400);
facts.legacy3000 = await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); return await m.readLongEdgeInput(); });
facts.legacyStoredAfter = await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); return m.storedSettingsRaw(); });
// 2) 自定义值：2000
await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); m.setStoredLongEdge(2000); });
await page.reload({waitUntil: "domcontentloaded"});
await page.waitForTimeout(2400);
facts.custom2000 = await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); return await m.readLongEdgeInput(); });
// 3) 没有存档：全新
await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); m.clearStoredLongEdge(); });
await page.reload({waitUntil: "domcontentloaded"});
await page.waitForTimeout(2400);
facts.fresh = await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); return await m.readLongEdgeInput(); });
// 收尾：清掉测试写的存档
await page.evaluate(async () => { const m = await (await import("/scripts/verify/resize-long-edge-page.jsx?v=" + Date.now())); m.clearStoredLongEdge(); });
return facts;
`;
    const stdout = await new Promise((resolve) => {
      const cli = spawn(CLI, [
        "nodejs",
        "--task", "V11 resize long edge check",
        "--request-id", `resizeedge-${process.pid}`,
        "--timeout-ms", "180000"
      ], { windowsHide: true });
      let buffer = "";
      cli.stdout.on("data", (chunk) => { buffer += String(chunk); });
      cli.stderr.on("data", (chunk) => { buffer += String(chunk); });
      cli.on("error", () => resolve(""));
      cli.on("close", () => resolve(buffer));
      try {
        cli.stdin.write(program);
        cli.stdin.end();
      } catch { /* ignore */ }
    });
    const start = stdout.indexOf('{"result"');
    if (start >= 0) {
      const tail = stdout.slice(start);
      for (let cut = tail.lastIndexOf("}"); cut > 0 && !facts; cut -= 1) {
        if (tail[cut] !== "}") continue;
        try { facts = JSON.parse(tail.slice(0, cut + 1))?.result?.value || null; } catch { /* 继续往前找 */ }
      }
    }
    if (!facts) browserReason = `浏览器回执无法解析（长度 ${stdout.length}）`;
  }
} catch (error) {
  browserReason = error instanceof Error ? error.message : String(error);
} finally {
  await stopChild(child);
}

if (facts) {
  check("浏览器：老存档 3000（旧默认值）→ 输入框显示 3500",
    facts.legacy3000?.value === "3500",
    `value=${facts.legacy3000?.value} inputFound=${facts.legacy3000?.inputFound} view=${facts.legacy3000?.viewActive}`);
  check("浏览器：自定义 2000 不被动（迁移只认旧默认值）",
    facts.custom2000?.value === "2000",
    `value=${facts.custom2000?.value} inputFound=${facts.custom2000?.inputFound}`);
  check("浏览器：无存档（全新）→ 3500",
    facts.fresh?.value === "3500",
    `value=${facts.fresh?.value} inputFound=${facts.fresh?.inputFound}`);
  check("浏览器：能找到「最长边(px)」输入框并切到批量改尺寸视图",
    facts.fresh?.inputFound === true && facts.fresh?.navFound === true,
    `input=${facts.fresh?.inputFound} nav=${facts.fresh?.navFound}`);
  check("浏览器：验证完把视图切回、测试存档已清理",
    facts.fresh?.restoredView === true && facts.legacy3000?.restoredView === true,
    `fresh=${facts.fresh?.restoredView} legacy=${facts.legacy3000?.restoredView}`);
} else {
  check("浏览器探针未执行", false, browserReason || "未知原因");
}

const historyAfter = hashOf(HISTORY_FILE);
check("真实 data/history.json 未被本次验证改动", historyBefore === historyAfter,
  `before=${historyBefore} after=${historyAfter}`);

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  browser: facts ? "ran" : `skipped: ${browserReason}`,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
