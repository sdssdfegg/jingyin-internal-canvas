// 批量尺寸「最长边」默认值的浏览器探针（由 resize-long-edge-check.mjs 载入真实页面执行）。
//
// 验证三件事（都在真实 UI 上读输入框的值）：
//   1. 老存档里存着 3000（= 旧默认值，当年没改过）→ 迁移成 3500
//   2. 用户真正自定义过的值（例如 2000）→ 原样保留
//   3. 没有存档（全新）→ 用新默认值 3500

const STORAGE_KEY = "jingyin-outfit-workflow-resize-settings-v4";

export function setStoredLongEdge(value) {
  const payload = { ratio: "3:4", longEdge: value, resolution: "custom", fitMode: "original", outputFormat: "jpg", dpi: 72, fillColor: "#ffffff", cropMode: "batch" };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  return window.localStorage.getItem(STORAGE_KEY);
}

export function clearStoredLongEdge() {
  window.localStorage.removeItem(STORAGE_KEY);
  return window.localStorage.getItem(STORAGE_KEY);
}

export function storedSettingsRaw() {
  return window.localStorage.getItem(STORAGE_KEY);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 切到「批量改尺寸」视图，读出「最长边(px)」输入框的值，然后把视图切回去。 */
export async function readLongEdgeInput() {
  const facts = {};
  const navButton = (label) => [...document.querySelectorAll("button.navItem")]
    .find((node) => (node.textContent || "").includes(label)) || null;
  const activeLabel = () => (document.querySelector("button.navItem.active")?.textContent || "").trim();
  const initialView = activeLabel();

  const resizeNav = navButton("批量改尺寸");
  facts.navFound = Boolean(resizeNav);
  if (resizeNav) {
    resizeNav.click();
    await wait(1200);
  }

  // 找带「最长边(px)」字样的 label 里的数字输入框
  let input = null;
  for (const label of document.querySelectorAll("label")) {
    if ((label.textContent || "").includes("最长边")) {
      input = label.querySelector('input[type="number"]');
      if (input) break;
    }
  }
  facts.inputFound = Boolean(input);
  facts.value = input ? String(input.value) : "";
  facts.viewActive = activeLabel();

  if (initialView) {
    navButton(initialView)?.click();
    await wait(600);
    facts.restoredView = activeLabel().includes(initialView);
  }
  return facts;
}
