// 临时探针（验证用，跑完即删）：用应用自己的 React 渲染一个必抛错的子组件，
// 检查 ErrorBoundary 是否给出兜底面板而不是白屏。
// 放在 scripts/verify 下由 Vite 解析其 import，避免在 page.evaluate 里猜 dep 路径。
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "/src/shared/error-boundary.jsx";

function Boom() {
  throw new Error("verify: intentional render crash sk-live-shouldnotleak");
}

export async function run() {
  const host = document.createElement("div");
  host.id = "verify-error-boundary";
  document.body.appendChild(host);
  const root = createRoot(host);
  const originalError = console.error;
  console.error = () => {};
  try {
    root.render(
      React.createElement(
        ErrorBoundary,
        { label: "验证区域" },
        React.createElement("div", { id: "verify-ok-sibling" }, "SIBLING-ALIVE"),
        React.createElement(Boom)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    console.error = originalError;
  }
  const panel = host.querySelector(".errorBoundaryPanel");
  const text = panel ? (panel.innerText || "").replace(/\s+/g, " ").trim() : "";
  return {
    fallbackRendered: Boolean(panel),
    fallbackText: text.slice(0, 160),
    hasRetry: /重试这一块/.test(text),
    hasReload: /重新加载页面/.test(text),
    hasCopy: /复制诊断/.test(text),
    leaksRawKey: /sk-live-shouldnotleak/.test(text),
    siblingAlive: Boolean(host.querySelector("#verify-ok-sibling")),
    appStillAlive: Boolean(document.querySelector(".appShell")),
    buttons: panel ? [...panel.querySelectorAll("button")].map((button) => button.innerText.trim()) : []
  };
}
