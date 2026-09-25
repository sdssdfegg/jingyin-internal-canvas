// 共享弹窗外壳 `src/shared/ui/Modal.jsx` 的验证（真实浏览器，不打上游、不扣费）。
//
// 第 5 步「抽公共弹窗」是纯重构，所以这里验的不是"新功能"，而是：
//   1. 外壳结构与通用交互与抽取前一致（点遮罩关、点面板不关、点 Esc 不关、标题/副标题/关闭按钮）
//   2. **没有新增行为**：抽取前四个弹窗都没有 Esc 关闭、没有 body 滚动锁 → 外壳也不许有
//   3. 四个弹窗（快捷/批量 × 裁剪/局部回贴）确实都用上了这一个外壳，旧外壳不再各写一份
//   4. 快捷入口与批量入口各走一遍：打开 → 取消 → 应用 → 资源释放（objectURL 计数）
//
// 关于实例：浏览器要能 import `/src/...` 与 `/scripts/...`，而 server 把 Vite 的 root 设成
// `rootDir`（= JINGYIN_RELEASE_ROOT）。所以这个检查**不能**用沙盒 root，否则 Vite 会在空目录里
// 找模块、一律回落 index.html。这里用自己的端口 + 独立 origin（http://127.0.0.1:8810），
// 浏览器存储与用户的 8787 互不影响；data/ 目录是共享的，所以前后比对 history.json 指纹，
// 一旦被改动就报失败（不静默放过）。
//
// 用法：node scripts/verify/modal-shell-check.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { installExitCleanup, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8810;
const SHELL_FILE = path.join(ROOT, "src", "shared", "ui", "Modal.jsx");
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CLI = path.join(process.env.LOCALAPPDATA || "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

function hashOf(file) {
  try { return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "(不存在)"; }
  catch { return "(读不到)"; }
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

// ---------------------------------------------------------------- 源码级：四处都用了同一个外壳
const mainSrc = readFileSync(path.join(ROOT, "src", "main.jsx"), "utf8");
const outfitSrc = readFileSync(path.join(ROOT, "src", "outfit-workflow.jsx"), "utf8");
check("共享外壳文件存在（src/shared/ui/Modal.jsx，README 里约定的名字）", existsSync(SHELL_FILE), "src/shared/ui/Modal.jsx");
check("两个页面都 import 了共享外壳",
  mainSrc.includes('from "./shared/ui/Modal.jsx"') && outfitSrc.includes('from "./shared/ui/Modal.jsx"'),
  "main/outfit");
check("快捷裁剪弹窗改用共享外壳且面板类名不变",
  mainSrc.includes('panelClassName="quickLocalEditModal quickCropViewportModal"'), "quickCropViewportModal");
check("快捷局部回贴弹窗改用共享外壳且面板类名不变",
  (mainSrc.match(/panelClassName="quickLocalEditModal"/g) || []).length === 1, "quickLocalEditModal");
check("批量裁剪弹窗改用共享外壳且面板类名不变",
  outfitSrc.includes('<Modal layerClassName="modalLayer" panelClassName="cropModal"'), "cropModal");
check("批量局部回贴弹窗改用共享外壳且面板类名不变",
  outfitSrc.includes('panelClassName="quickLocalEditModal"'), "quickLocalEditModal(batch)");
check("四处合计 4 个 <Modal 用法（没有漏改或多改）",
  (mainSrc.match(/<Modal(?![A-Za-z])/g) || []).length + (outfitSrc.match(/<Modal(?![A-Za-z])/g) || []).length === 4,
  `main=${(mainSrc.match(/<Modal(?![A-Za-z])/g) || []).length} outfit=${(outfitSrc.match(/<Modal(?![A-Za-z])/g) || []).length}`);
check("旧的 div+section 外壳写法在这四个弹窗里已清除（剩余的 preview 弹窗不在本次范围）",
  !mainSrc.includes('className="quickLocalEditModal quickCropViewportModal" onMouseDown')
    && !outfitSrc.includes('className="cropModal" onMouseDown'),
  "无残留");

const shellSrc = readFileSync(SHELL_FILE, "utf8");
check("外壳本身没有引入 Esc 关闭（抽取前就没有，加了就是改交互）",
  !/Escape|onKeyDown|keydown/.test(shellSrc), "无 Esc 逻辑");
check("外壳本身没有引入 body 滚动锁（同上）",
  !/document\.body|overflow/.test(shellSrc), "无滚动锁");

// ---------------------------------------------------------------- 浏览器：外壳 + 两个入口
let child = null;
let shellFacts = null;
let entranceFacts = null;
let browserReason = "";
const historyBefore = hashOf(HISTORY_FILE);
try {
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      JINGYIN_PORT_FALLBACK_LIMIT: "0",
      JINGYIN_NO_BROWSER: "1"
      // 故意不设 JINGYIN_RELEASE_ROOT：Vite 的 root 就是它，设了模块就取不到了
    }
  });
  installExitCleanup({ getChild: () => child });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  if (!existsSync(CLI)) {
    browserReason = "tabbit-cli 不存在，跳过浏览器部分";
  } else {
    const program = `
await page.goto("http://127.0.0.1:${APP_PORT}/", {waitUntil: "domcontentloaded"});
await page.waitForTimeout(2600);
return await page.evaluate(async () => {
  const mod = await import("/scripts/verify/modal-shell-page.jsx?v=" + Date.now());
  const shell = await mod.run();
  const entrances = await mod.runEntrances();
  return { shell, entrances };
});
`;
    const stdout = await new Promise((resolve) => {
      const cli = spawn(CLI, [
        "nodejs",
        "--task", "V11 modal shell check",
        "--request-id", `modalshell-${process.pid}`,
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
    let payload = null;
    const start = stdout.indexOf('{"result"');
    if (start >= 0) {
      const tail = stdout.slice(start);
      for (let cut = tail.lastIndexOf("}"); cut > 0 && !payload; cut -= 1) {
        if (tail[cut] !== "}") continue;
        try { payload = JSON.parse(tail.slice(0, cut + 1))?.result?.value || null; } catch { /* 继续往前找 */ }
      }
    }
    if (payload) {
      shellFacts = payload.shell || null;
      entranceFacts = payload.entrances || null;
    } else {
      browserReason = `浏览器回执无法解析（长度 ${stdout.length}）`;
    }
  }
} catch (error) {
  browserReason = error instanceof Error ? error.message : String(error);
} finally {
  await stopChild(child);
}

if (shellFacts) {
  const f = shellFacts;
  check("浏览器：外壳渲染出 modalLayer + 面板", f.rendered === true, String(f.rendered));
  check("浏览器：面板里有 header（标题+副标题）", f.panelHasHeader === true && f.titleText === "探针标题",
    `title=${f.titleText} subtitle=${f.subtitleText}`);
  check("浏览器：关闭按钮是 iconButton（带 X 图标）", f.closeButtonHasIcon === true, `aria-label=${f.closeButtonAriaLabel}`);
  check("浏览器：children 渲染在面板内、不在 header 里", f.childInsidePanel === true && f.childOutsideHeader === true, "");
  check("浏览器：点面板内部不触发关闭", f.panelClickDoesNotClose === true, "");
  check("浏览器：点遮罩触发关闭（onClose 恰好 1 次）", f.backdropCloses === true, "");
  check("浏览器：Esc 不关闭（与抽取前的行为一致）", f.escapeDoesNotClose === true, "");
  check("浏览器：子内容里的按钮照常可用", f.applyClickReachesChild === true, "");
  check("浏览器：不传 closeLabel 时不渲染 aria-label（批量裁剪弹窗原本就没有）",
    f.ariaLabelOmittedWhenNotProvided === true, "");
  check("浏览器：没有给 body 加滚动锁", f.bodyOverflowUnchanged === true, "");
  check("浏览器：卸载后不再响应点击（监听已清）", f.noCloseAfterUnmount === true && f.hostRemoved === true, "");
  check("浏览器：重新挂载后行为正常且只记一次关闭（无残留监听打架）", f.remountWorksOnce === true, "");
} else {
  check("浏览器探针（外壳）未执行", false, browserReason || "未知原因");
}

if (entranceFacts) {
  const q = entranceFacts.quick || {};
  const b = entranceFacts.batch || {};
  // 快捷入口
  check("快捷入口：找到了参考上传区", q.foundReferenceBox === true, q.error || "");
  check("快捷入口：上传后有裁剪入口按钮", q.cropEntryFound === true, "");
  check("快捷入口：点裁剪切能打开共享外壳（modalLayer>面板）", q.opened === true && q.layerIsSharedShell === true,
    `opened=${q.opened} layer=${q.layerIsSharedShell} title=${q.title}`);
  check("快捷入口：弹窗标题与关闭按钮就位", q.title === "普通裁剪" && q.closeButtonPresent === true, `title=${q.title}`);
  check("快捷入口：取消能关掉弹窗且释放了 objectURL", q.closedOnCancel === true && q.refReleasedOnCancel === true,
    `closed=${q.closedOnCancel} released=${q.refReleasedOnCancel}`);
  check("快捷入口：能再次打开", q.reopened === true, "");
  check("快捷入口：应用裁剪后弹窗关闭且裁剪状态已生效", q.closedOnApply === true && q.cropStateApplied === true,
    `closed=${q.closedOnApply} applied=${q.cropStateApplied}`);
  check("快捷入口：用完能清理干净（取消裁剪 + 移除参考图，不留残留状态）", q.cleanedUp === true, "");

  // 批量入口
  check("批量入口：切到批量页并找到上传区", b.navSwitched === true && b.foundUploadZone === true, b.error || "");
  check("批量入口：上传后有裁剪入口按钮", b.cropEntryFound === true, "");
  check("批量入口：点裁剪切能打开共享外壳（modalLayer>cropModal）", b.opened === true && b.layerIsSharedShell === true,
    `opened=${b.opened} layer=${b.layerIsSharedShell}`);
  check("批量入口：关闭按钮就位", b.closeButtonPresent === true, "");
  check("批量入口：取消能关掉弹窗", b.closedOnCancel === true, `closed=${b.closedOnCancel}`);
  check("批量入口：能再次打开并应用（应用后弹窗关闭）", b.reopened === true && b.closedOnApply === true,
    `reopened=${b.reopened} closedOnApply=${b.closedOnApply}`);
} else {
  check("浏览器探针（两个入口）未执行", false, browserReason || "未知原因");
}

const historyAfter = hashOf(HISTORY_FILE);
check("真实 data/history.json 未被本次浏览器验证改动", historyBefore === historyAfter,
  `before=${historyBefore} after=${historyAfter}`);

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  browser: shellFacts ? "ran" : `skipped: ${browserReason}`,
  counters: entranceFacts?.counters || null,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
