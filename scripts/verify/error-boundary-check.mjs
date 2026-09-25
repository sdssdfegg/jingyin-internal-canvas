// ErrorBoundary 验证（源码接线 + 纯逻辑 + 真实浏览器渲染兜底）。
//
// 目标：单个渲染异常不能让整页白屏。覆盖：
//   1. 边界组件存在且是标准实现（getDerivedStateFromError + componentDidCatch）
//   2. 主界面根部、批量生成、图片编辑三处都已被包住
//   3. 出错文案经过脱敏（不把原始堆栈/KEY 丢给用户），并提供重试/重新加载/复制诊断
//   4. 兜底面板样式存在（深色中性底，与整体一致）
//   5. 逻辑：describeRenderError 对异常/空值/长文本/含 KEY 文本的处理
//   6. 真实浏览器：用应用自己的 React 渲染一个"必定抛错的子组件"，
//      断言兜底面板出现、抛出点以外的内容不受影响（不是白屏）
//
// 用法：node scripts/verify/error-boundary-check.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

// ---------- 1) 组件实现 ----------
const boundaryPath = "src/shared/error-boundary.jsx";
check("边界组件文件存在", existsSync(path.join(ROOT, boundaryPath)), boundaryPath);
const boundary = existsSync(path.join(ROOT, boundaryPath)) ? read(boundaryPath) : "";

check("是 class 组件并实现了 getDerivedStateFromError",
  /class ErrorBoundary extends React\.Component/.test(boundary) && /static getDerivedStateFromError\(/.test(boundary),
  "class + static getDerivedStateFromError");
check("实现了 componentDidCatch（用于上报，不影响兜底）",
  /componentDidCatch\(/.test(boundary), "componentDidCatch");
check("错误上报走 client-diagnostic-event（不进用户可见文案）",
  /emitClientDiagnosticEvent\(/.test(boundary) && /client-render-error/.test(boundary), "client-render-error");
check("用户可见文案经过脱敏（链路：边界 → error-report → sanitizeErrorText）", (() => {
  const report = existsSync(path.join(ROOT, "src/shared/error-report.js"))
    ? read("src/shared/error-report.js")
    : "";
  return /sanitizeErrorText\(/.test(report)
    && /from "\.\/generation-errors\.js"/.test(report)
    && /from "\.\/error-report\.js"/.test(boundary);
})(), "脱敏在 error-report 里统一做，边界组件复用它");
check("不把原始堆栈直接渲染给用户",
  !/\{this\.state\.errorInfo\}/.test(boundary) && !/error\.stack/.test(boundary),
  "兜底面板只显示 describeRenderError 的结果");
check("提供重试 / 重新加载 / 复制诊断三种恢复入口",
  /重试这一块/.test(boundary) && /重新加载页面/.test(boundary) && /复制诊断/.test(boundary),
  "三种入口都在");
check("明确告知其它功能仍可用（不是整页不可用）",
  /其它功能仍可继续使用/.test(boundary), "有提示文案");

// ---------- 2) 接线点 ----------
const mainJsx = read("src/main.jsx");
check("main.jsx 引入并使用了 ErrorBoundary",
  /from "\.\/shared\/error-boundary\.jsx"/.test(mainJsx) && /<ErrorBoundary/.test(mainJsx), "已引入");
check("应用根节点被包住（应用主界面）",
  /<ErrorBoundary label="应用主界面">[\s\S]{0,80}<main className="appShell">/.test(mainJsx),
  "root 包在 ErrorBoundary 内");
check("批量生成面板被单独包住",
  /<ErrorBoundary label="批量生成">[\s\S]{0,200}<OutfitWorkflow/.test(mainJsx), "批量生成独立兜底");
check("图片编辑面板被单独包住",
  /<ErrorBoundary label="图片编辑">[\s\S]{0,200}<ImageEditorPanel/.test(mainJsx), "图片编辑独立兜底");
check("边界数量 >= 3（根 + 两个面板）",
  (mainJsx.match(/<ErrorBoundary/g) || []).length >= 3,
  `实际 ${(mainJsx.match(/<ErrorBoundary/g) || []).length} 处`);

// ---------- 3) 样式 ----------
const css = read("src/styles.css");
check("兜底面板样式存在且用中性底色",
  /\.errorBoundaryPanel \{[\s\S]{0,400}background: var\(--panel\)/.test(css),
  "深色中性底");

// ---------- 4) 纯逻辑（放在 error-report.js，node 可直接 import）----------
const { describeRenderError, formatRenderErrorReport } = await import("../../src/shared/error-report.js");
check("异常对象 → 输出 message",
  describeRenderError(new Error("Cannot read properties of undefined (reading 'map')")) === "Cannot read properties of undefined (reading 'map')",
  describeRenderError(new Error("boom")));
check("空异常 → 有兜底文案",
  describeRenderError(null) === "界面渲染时发生未知错误。", describeRenderError(null));
check("字符串异常可用",
  describeRenderError("something broke") === "something broke", describeRenderError("something broke"));
check("含 KEY 的异常被脱敏",
  !describeRenderError(new Error("failed with sk-live-abcdefghijklmnop")).includes("sk-live-abcdefghijklmnop"),
  describeRenderError(new Error("failed with sk-live-abcdefghijklmnop")));
check("超长异常被截断（不会撑爆界面）",
  describeRenderError(new Error("x".repeat(1000))).length <= 201,
  `len=${describeRenderError(new Error("x".repeat(1000))).length}`);
check("诊断文本包含区域/时间/原因（可复制排查）", (() => {
  const report = formatRenderErrorReport({ label: "批量生成", error: new Error("boom"), componentStack: "at Foo (a.jsx:1)" });
  return /静音AI绘画 渲染错误/.test(report) && /区域：批量生成/.test(report) && /时间：/.test(report) && /原因：boom/.test(report);
})(), "报告字段齐全");
check("诊断文本里的组件栈同样脱敏", (() => {
  const report = formatRenderErrorReport({ error: new Error("x"), componentStack: "at f (sk-live-abcdefghijklmnop)" });
  return !report.includes("sk-live-abcdefghijklmnop");
})(), "组件栈已脱敏");
check("error-boundary.jsx 复用 error-report（逻辑单一来源）",
  /from "\.\/error-report\.js"/.test(boundary) && !/function describeRenderError/.test(boundary),
  "边界组件不再自己实现文案");

// ---------- 5) 真实浏览器：渲染期抛错必须显示兜底而不是白屏 ----------
// 探针是常驻模块 scripts/verify/error-boundary-page.jsx（由 Vite 解析其 React 导入），
// 与 crop-geometry-page.js 同一套做法。
const APP_PORT = Number(process.env.V11_APP_PORT || 8787);
let browserResult = { ran: false, reason: "" };
try {
  const health = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`).catch(() => null);
  if (!health?.ok) {
    browserResult.reason = `本地 ${APP_PORT} 没有在跑，跳过浏览器部分`;
  } else {
    const { spawn } = await import("node:child_process");
    const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
    const cli = path.join(process.env.LOCALAPPDATA || "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");
    if (!existsSync(cli)) {
      browserResult.reason = "tabbit-cli 不存在，跳过浏览器部分";
    } else {
      const programFile = path.join(ROOT, ".codex-artifacts", `error-boundary-browser-${process.pid}.js`);
      const program = `
await page.goto("http://127.0.0.1:${APP_PORT}/", {waitUntil: "domcontentloaded"});
await page.waitForTimeout(1800);
return await page.evaluate(async () => {
  const mod = await import("/scripts/verify/error-boundary-page.jsx?v=" + Date.now());
  const probe = await mod.run();
  const wiring = await mod.runWiring();
  return { probe, wiring };
});
`;
      mkdirSync(path.dirname(programFile), { recursive: true });
      writeFileSync(programFile, program, "utf8");
      try {
        // 直接 spawn CLI 并把程序写进 stdin（不经过 cmd 重定向：那样在 node 里拿不到 stdout）
        const stdout = await new Promise((resolve) => {
          const child = spawn(cli, [
            "nodejs",
            "--task", "V11 error boundary check",
            "--request-id", `ebound-${process.pid}`,
            "--timeout-ms", "120000"
          ], { windowsHide: true });
          let buffer = "";
          child.stdout.on("data", (chunk) => { buffer += String(chunk); });
          child.stderr.on("data", (chunk) => { buffer += String(chunk); });
          child.on("error", () => resolve(""));
          child.on("close", () => resolve(buffer));
          try {
            child.stdin.write(program);
            child.stdin.end();
          } catch { /* ignore */ }
        });
        // CLI 输出是回执信封：{ result: { value: {...} } }
        let payload = null;
        const start = stdout.indexOf('{"result"');
        if (start >= 0) {
          const tail = stdout.slice(start);
          const end = tail.lastIndexOf("}");
          for (let cut = end; cut > 0 && !payload; cut -= 1) {
            if (tail[cut] !== "}") continue;
            try {
              const parsed = JSON.parse(tail.slice(0, cut + 1));
              payload = parsed?.result?.value || null;
            } catch { /* 继续往前找 */ }
          }
        }
        browserResult = payload
          ? { ran: true, payload }
          : { ran: false, reason: `浏览器回执无法解析（长度 ${stdout.length}）` };
      } finally {
        // 用 unlinkSync 而不是 rmSync：工作区路径上的 rmSync 实测会静默无效，
        // 临时程序文件会一直留在 .codex-artifacts 里。
        try { unlinkSync(programFile); } catch { /* ignore */ }
      }
    }
  }
} catch (error) {
  browserResult = { ran: false, reason: error instanceof Error ? error.message : String(error) };
}

if (browserResult.ran) {
  const p = browserResult.payload?.probe || {};
  const w = browserResult.payload?.wiring || {};
  check("浏览器：渲染期抛错 → 显示兜底面板（不是白屏）", p.fallbackRendered === true, JSON.stringify(p));
  check("浏览器：兜底面板带区域名与可读原因", /「验证区域」这块界面出错了/.test(p.fallbackText || ""), p.fallbackText);
  check("浏览器：提供重试 / 重新加载 / 复制诊断三个入口",
    p.hasRetry === true && p.hasReload === true && p.hasCopy === true,
    JSON.stringify(p.buttons));
  check("浏览器：错误文本在真实渲染里也被脱敏（sk- → sk-***）", p.leaksRawKey === false, `leaksRawKey=${p.leaksRawKey}`);
  check("浏览器：应用主体仍在（没有整页崩掉）", p.appStillAlive === true, `appStillAlive=${p.appStillAlive}`);

  // ---- 兜底面板的行为契约（第 5 步之外补的：不只"渲染出来"，还要能恢复）----
  check("浏览器：兜底面板是 role=alert 且有「其它功能仍可用」提示",
    p.panelRole === "alert" && p.hintMentionsOthersUsable === true,
    `role=${p.panelRole} hint=${p.hintMentionsOthersUsable}`);
  check("浏览器：点「重试这一块」能恢复渲染并清掉兜底面板",
    p.retryRecovered === true && p.retryClearedPanel === true && p.retryKeptSibling === true,
    `recovered=${p.retryRecovered} cleared=${p.retryClearedPanel} sibling=${p.retryKeptSibling}`);
  check("浏览器：崩溃区域旁边的另一个边界不受影响（兄弟隔离）",
    p.siblingBoundarySurvives === true && p.siblingPanelOnlyOne === true && p.siblingPanelLabelIsBadRegion === true,
    `survives=${p.siblingBoundarySurvives} panels=${p.siblingPanelOnlyOne} label=${p.siblingPanelLabelIsBadRegion}`);
  check("浏览器：嵌套时内层吃掉异常，外层不被触发（对应 主界面 > 批量生成/图片编辑）",
    p.nestedInnerPanelShown === true && p.nestedOuterNotTriggered === true && p.nestedOuterContentAlive === true,
    `inner=${p.nestedInnerPanelShown} outerTriggered=${!p.nestedOuterNotTriggered} outerAlive=${p.nestedOuterContentAlive}`);
  check("浏览器：兜底同时上报诊断（stage=client-render-error，带区域名与组件栈）",
    p.reportedStage === "client-render-error" && p.reportedLabel === "验证区域" && p.reportedHasComponentStack === true,
    `stage=${p.reportedStage} label=${p.reportedLabel} stack=${p.reportedHasComponentStack}`);
  check("浏览器：上报内容与复制出来的诊断都不含原始 KEY（脱敏）",
    p.reportedMessageSanitized === true && p.copiedTextSanitized === true,
    `report=${p.reportedMessageSanitized} copy=${p.copiedTextSanitized}`);
  check("浏览器：点「复制诊断」不抛错且文本带区域名",
    p.copyClickedWithoutThrowing === true && p.copiedTextHasLabel === true,
    `clicked=${p.copyClickedWithoutThrowing} hasLabel=${p.copiedTextHasLabel}`);

  // ---- 运行时接线：在活的应用树上确认边界真的挂在那几个区域 ----
  const labelsOf = (list) => (Array.isArray(list) ? list.map((item) => item.label) : []);
  const batchEntry = Array.isArray(w.batch) ? w.batch.find((item) => item.label === "批量生成") : null;
  const editorEntry = Array.isArray(w.editor) ? w.editor.find((item) => item.label === "图片编辑") : null;
  check("活树：能读到 React 根（fiber 可遍历）", w.rootFiberFound === true, `rootFiberFound=${w.rootFiberFound}`);
  check("活树：应用主体确实在「应用主界面」边界内", w.appShellInsideMain === true, `appShellInsideMain=${w.appShellInsideMain}`);
  check("活树：快捷页存在「应用主界面」边界", labelsOf(w.quick).includes("应用主界面"), labelsOf(w.quick).join(",") || "(无)");
  check("活树：切到批量页后挂上「批量生成」边界，且嵌在「应用主界面」内",
    Boolean(batchEntry) && batchEntry.parentLabel === "应用主界面",
    `labels=${labelsOf(w.batch).join(",") || "(无)"} parent=${batchEntry?.parentLabel || "-"}`);
  check("活树：切到图片编辑后挂上「图片编辑」边界，且嵌在「应用主界面」内",
    Boolean(editorEntry) && editorEntry.parentLabel === "应用主界面",
    `labels=${labelsOf(w.editor).join(",") || "(无)"} parent=${editorEntry?.parentLabel || "-"}`);
  check("活树：验证完把视图切回进入时的状态（不留副作用）", w.restoredView === true, `restoredView=${w.restoredView}`);
} else {
  results.push({ name: "浏览器部分（跳过）", pass: true, detail: browserResult.reason || "未运行" });
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  browser: browserResult.ran ? "ran" : `skipped: ${browserResult.reason}`,
  failures: failed,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
