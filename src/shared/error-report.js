// 渲染错误的用户可见文案与诊断文本（纯逻辑，无 React 依赖，便于单测）。
//
// 与 generation-errors.js 的分工：
//   - generation-errors：生图链路（网络/上游/参数…）的错误分类
//   - 本模块：**渲染期**异常（React 组件抛错）的用户文案与可复制诊断
//
// 安全：绝不把原始堆栈直接给用户；文本一律先脱敏再截断。

import { sanitizeErrorText } from "./generation-errors.js";

/** 把渲染错误转成用户看得懂的一行说明（已脱敏、已截断）。 */
export function describeRenderError(error) {
  const raw = error instanceof Error ? error.message : String(error || "");
  const text = sanitizeErrorText(raw, 200);
  if (!text) return "界面渲染时发生未知错误。";
  return text;
}

/** 组装可复制的诊断文本（含组件栈，供排查；不直接展示在界面上）。 */
export function formatRenderErrorReport({ label = "界面", error, componentStack = "", at = new Date() } = {}) {
  return [
    "静音AI绘画 渲染错误",
    `区域：${label}`,
    `时间：${at.toLocaleString("zh-CN")}`,
    `原因：${describeRenderError(error)}`,
    componentStack ? `组件栈：${sanitizeErrorText(componentStack, 2000)}` : ""
  ].filter(Boolean).join("\n");
}
