// 临时探针（验证用）：用应用自己的 React 渲染必抛错的子组件，检查 ErrorBoundary
// 是否给出兜底面板而不是白屏；并在**活的应用树**上核对边界到底挂在哪几个区域。
// 放在 scripts/verify 下由 Vite 解析其 import，避免在 page.evaluate 里猜 dep 路径。
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "/src/shared/error-boundary.jsx";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 用模块级开关控制"是否抛错"，这样能验证「重试这一块」真的能恢复
let crashEnabled = true;

function Boom({ marker }) {
  if (crashEnabled) throw new Error(`verify: intentional render crash ${marker || ""} sk-live-shouldnotleak`);
  return React.createElement("div", { id: "verify-recovered" }, "RECOVERED");
}

function Healthy({ id }) {
  return React.createElement("div", { id }, "HEALTHY");
}

const buttonByText = (root, text) =>
  [...(root || document).querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text) || null;

/** 抓取兜底边界发出的诊断上报（POST /api/client-diagnostic-event）。 */
function captureDiagnosticPosts() {
  const posts = [];
  const originalFetch = window.fetch;
  window.fetch = (input, init) => {
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/client-diagnostic-event") && init?.body) posts.push(JSON.parse(String(init.body)));
    } catch { /* 解析失败不影响原请求 */ }
    return originalFetch(input, init);
  };
  return {
    posts,
    restore: () => { window.fetch = originalFetch; }
  };
}

/** 抓取「复制诊断」写进剪贴板的文本。 */
function captureClipboard() {
  const captured = { text: "" };
  try {
    const original = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!original) return { captured, restore: () => {} };
    navigator.clipboard.writeText = async (text) => { captured.text = String(text); return original(text); };
    return { captured, restore: () => { navigator.clipboard.writeText = original; } };
  } catch {
    return { captured, restore: () => {} };
  }
}

export async function run() {
  const facts = {};
  crashEnabled = true;

  const host = document.createElement("div");
  host.id = "verify-error-boundary";
  document.body.appendChild(host);
  const root = createRoot(host);
  const diagnostic = captureDiagnosticPosts();
  const clipboard = captureClipboard();
  const originalError = console.error;
  console.error = () => {};
  try {
    root.render(
      React.createElement(
        ErrorBoundary,
        { label: "验证区域" },
        React.createElement("div", { id: "verify-ok-sibling" }, "SIBLING-ALIVE"),
        React.createElement(Boom, { marker: "main" })
      )
    );
    await wait(900);
  } finally {
    console.error = originalError;
  }

  const panel = host.querySelector(".errorBoundaryPanel");
  const text = panel ? (panel.innerText || "").replace(/\s+/g, " ").trim() : "";
  facts.fallbackRendered = Boolean(panel);
  facts.fallbackText = text.slice(0, 200);
  facts.hasRetry = /重试这一块/.test(text);
  facts.hasReload = /重新加载页面/.test(text);
  facts.hasCopy = /复制诊断/.test(text);
  facts.leaksRawKey = /sk-live-shouldnotleak/.test(text);
  facts.siblingAlive = Boolean(host.querySelector("#verify-ok-sibling"));
  facts.appStillAlive = Boolean(document.querySelector(".appShell"));
  facts.buttons = panel ? [...panel.querySelectorAll("button")].map((button) => button.innerText.trim()) : [];
  facts.panelRole = panel?.getAttribute("role") || "";
  facts.hintMentionsOthersUsable = /其它功能仍可继续使用/.test(text);

  // 诊断上报：边界上报的是脱敏后的原因（不含原始 key）
  await wait(300);
  const event = diagnostic.posts.find((item) => item?.stage === "client-render-error") || null;
  facts.reportedStage = event?.stage || "";
  facts.reportedLabel = event?.detail?.label || "";
  facts.reportedMessageSanitized = Boolean(event?.detail?.message) && !/sk-live-shouldnotleak/.test(String(event?.detail?.message || ""));
  facts.reportedHasComponentStack = Boolean(String(event?.detail?.componentStack || "").trim());

  // 复制诊断：点一下不该抛错，且文本带区域名
  const copyButton = buttonByText(panel, "复制诊断");
  let copyThrew = false;
  try {
    copyButton?.click();
    await wait(250);
  } catch { copyThrew = true; }
  facts.copyClickedWithoutThrowing = Boolean(copyButton) && !copyThrew;
  facts.copiedTextHasLabel = /「?验证区域」?/.test(clipboard.captured.text || "");
  facts.copiedTextSanitized = !/sk-live-shouldnotleak/.test(clipboard.captured.text || "");
  clipboard.restore();
  diagnostic.restore();

  // 重试：让子组件不再抛错，点「重试这一块」应恢复渲染
  crashEnabled = false;
  buttonByText(panel, "重试这一块")?.click();
  await wait(500);
  facts.retryRecovered = Boolean(host.querySelector("#verify-recovered"));
  facts.retryClearedPanel = !host.querySelector(".errorBoundaryPanel");
  facts.retryKeptSibling = Boolean(host.querySelector("#verify-ok-sibling"));
  root.unmount();
  host.remove();

  // 兄弟隔离：一个边界崩了，旁边另一个边界的内容必须还在
  const host2 = document.createElement("div");
  document.body.appendChild(host2);
  const root2 = createRoot(host2);
  crashEnabled = true;
  console.error = () => {};
  try {
    root2.render(
      React.createElement("div", null,
        React.createElement(ErrorBoundary, { label: "坏区域" }, React.createElement(Boom, { marker: "left" })),
        React.createElement(ErrorBoundary, { label: "好区域" }, React.createElement(Healthy, { id: "verify-healthy-sibling" }))
      )
    );
    await wait(700);
  } finally {
    console.error = originalError;
  }
  facts.siblingBoundarySurvives = Boolean(host2.querySelector("#verify-healthy-sibling"));
  facts.siblingPanelOnlyOne = host2.querySelectorAll(".errorBoundaryPanel").length === 1;
  facts.siblingPanelLabelIsBadRegion = /「坏区域」这块界面出错了/.test(host2.querySelector(".errorBoundaryPanel")?.innerText || "");
  root2.unmount();
  host2.remove();

  // 嵌套：内层边界吃掉异常，外层边界不该被触发（对应 main.jsx 的 主界面 > 批量生成/图片编辑 结构）
  const host3 = document.createElement("div");
  document.body.appendChild(host3);
  const root3 = createRoot(host3);
  crashEnabled = true;
  console.error = () => {};
  try {
    root3.render(
      React.createElement(ErrorBoundary, { label: "外层验证" },
        React.createElement("div", { id: "verify-outer-healthy" }, "OUTER-ALIVE"),
        React.createElement(ErrorBoundary, { label: "内层验证" }, React.createElement(Boom, { marker: "inner" }))
      )
    );
    await wait(700);
  } finally {
    console.error = originalError;
  }
  const innerPanel = host3.querySelector(".errorBoundaryPanel");
  facts.nestedInnerPanelShown = /「内层验证」这块界面出错了/.test(innerPanel?.innerText || "");
  facts.nestedOuterNotTriggered = !/「外层验证」这块界面出错了/.test(host3.innerText || "");
  facts.nestedOuterContentAlive = Boolean(host3.querySelector("#verify-outer-healthy"));
  root3.unmount();
  host3.remove();

  return facts;
}

// ---------------------------------------------------------------------------
// 运行时接线核对：在**活的应用树**上确认边界真的挂在对应区域
// （只读遍历 React fiber，不改任何状态；从 #root 的 container fiber 往下找 ErrorBoundary）
// ---------------------------------------------------------------------------
export async function runWiring() {
  const facts = { rootFiberFound: false, quick: [], batch: null, editor: null, appShellInsideMain: false };

  // 取"当前"的根 fiber：不能只在开头抓一次 —— React 更新时会换 root fiber 对象，
  // 抓着旧的往下走会读到上一次的树（实测"切到图片编辑"时读到的还是批量生成）。
  // 正确做法：从当前 DOM 节点的 fiber 往上走到顶。
  const currentRootFiber = () => {
    const anchor = document.querySelector("main.appShell") || document.body.querySelector("div");
    const key = anchor ? Object.keys(anchor).find((name) => name.startsWith("__reactFiber$")) : null;
    let fiber = key ? anchor[key] : null;
    if (!fiber) return null;
    let top = fiber;
    while (top.return) top = top.return;
    return top.stateNode?.current || top;
  };

  const rootFiber = currentRootFiber();
  facts.rootFiberFound = Boolean(rootFiber);
  if (!rootFiber) return facts;

  const collect = () => {
    const start = currentRootFiber();
    if (!start) return [];
    const found = [];
    const visit = (startFiber) => {
      let fiber = startFiber;
      while (fiber) {
        if (fiber.type && fiber.type.name === "ErrorBoundary") {
          let parent = fiber.return;
          let parentLabel = "";
          while (parent) {
            if (parent.type && parent.type.name === "ErrorBoundary") {
              parentLabel = String(parent.memoizedProps?.label || "");
              break;
            }
            parent = parent.return;
          }
          found.push({ label: String(fiber.memoizedProps?.label || ""), parentLabel });
        }
        if (fiber.child) visit(fiber.child);
        fiber = fiber.sibling;
      }
    };
    visit(start.child || start);
    return found;
  };

  const navTo = (label) => {
    const button = [...document.querySelectorAll("button.navItem")]
      .find((node) => (node.textContent || "").includes(label));
    if (!button) return false;
    button.click();
    return true;
  };
  const activeNavLabel = () => (document.querySelector("button.navItem.active")?.textContent || "").trim();

  // 记下进来时的视图，最后切回去：应用会把当前视图持久化，
  // 不还原就会把用户/下一个检查留在"图片编辑"页。
  const initialView = activeNavLabel();

  facts.quick = collect();
  const shell = document.querySelector("main.appShell");
  const shellKey = shell ? Object.keys(shell).find((key) => key.startsWith("__reactFiber$")) : null;
  if (shellKey) {
    let fiber = shell[shellKey];
    while (fiber) {
      if (fiber.type?.name === "ErrorBoundary" && String(fiber.memoizedProps?.label || "") === "应用主界面") {
        facts.appShellInsideMain = true;
        break;
      }
      fiber = fiber.return;
    }
  }

  if (navTo("批量生成")) {
    await wait(1000);
    facts.batch = collect();
  }
  if (navTo("图片编辑")) {
    await wait(1000);
    facts.editor = collect();
  }

  // 还原到进入时的视图（切回去是尽力而为，失败也不影响结论）
  // 注意：点完导航要等 React 更新完再读 active class —— 不等就会读到旧的 class，
  // 这个断言在"原视图恰好就是图片编辑"时蒙对、在别的视图下必错（套件里实测踩到）。
  if (initialView) {
    const clicked = navTo(initialView);
    if (clicked) await wait(1000);
    facts.restoredView = clicked && activeNavLabel().includes(initialView);
  }
  return facts;
}
