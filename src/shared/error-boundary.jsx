// 渲染错误兜底（ErrorBoundary）。
//
// 目标：单个组件渲染异常时**不要整页白屏** —— 出错的区域显示可读原因 + 恢复入口，
// 其它区域继续可用。
//
// 设计要点：
//   1. 不展示原始堆栈给用户；错误文本先脱敏（见 ./error-report.js），
//      完整信息走 client-diagnostic-event 上报，便于排查。
//   2. 提供三种恢复方式：重试（清掉错误状态重新渲染）、重新加载页面、复制诊断。
//   3. 组件本身极简、无额外依赖，避免"兜底组件自己出错"。

import React from "react";
import { emitClientDiagnosticEvent } from "../api/client.js";
import { formatRenderErrorReport, describeRenderError } from "./error-report.js";

export { describeRenderError } from "./error-report.js";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: "" };
    this.handleRetry = this.handleRetry.bind(this);
    this.handleReload = this.handleReload.bind(this);
    this.handleCopy = this.handleCopy.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    const label = String(this.props?.label || "界面");
    this.setState({ componentStack: String(errorInfo?.componentStack || "").slice(0, 2000) });
    try {
      emitClientDiagnosticEvent({
        requestId: `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        stage: "client-render-error",
        ok: false,
        detail: {
          label,
          name: error?.name || "",
          message: describeRenderError(error),
          componentStack: String(errorInfo?.componentStack || "").slice(0, 2000)
        }
      });
    } catch {
      // 上报失败不能影响兜底界面
    }
  }

  handleRetry() {
    this.setState({ error: null, componentStack: "" });
    this.props?.onRetry?.();
  }

  handleReload() {
    try {
      window.location.reload();
    } catch { /* ignore */ }
  }

  async handleCopy() {
    const text = formatRenderErrorReport({
      label: String(this.props?.label || "界面"),
      error: this.state.error,
      componentStack: this.state.componentStack
    });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      } catch { /* ignore */ }
    }
  }

  render() {
    if (!this.state.error) return this.props?.children ?? null;
    const label = String(this.props?.label || "界面");
    return (
      <section className="errorBoundaryPanel" role="alert">
        <strong>「{label}」这块界面出错了</strong>
        <p>{describeRenderError(this.state.error)}</p>
        <p className="errorBoundaryHint">其它功能仍可继续使用；也可以重试这一块、或重新加载页面。</p>
        <div className="errorBoundaryActions">
          <button className="smallButton" type="button" onClick={this.handleRetry}>重试这一块</button>
          <button className="smallButton" type="button" onClick={this.handleReload}>重新加载页面</button>
          <button className="smallButton" type="button" onClick={() => void this.handleCopy()}>复制诊断</button>
        </div>
      </section>
    );
  }
}
