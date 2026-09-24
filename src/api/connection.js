import { ApiError, postJson } from "./client.js";

/**
 * 连接测试（对照 3.0 的 `/api/providers/test-connection`）。
 *
 * 服务端只对上游发 `GET {base}/v1/models`：不调用生图、不上传图片、不扣费，
 * 也不会把 API Key / Authorization / 完整响应回传或写日志。
 *
 * @param {{baseUrl?: string, apiKey?: string, model?: string, channelId?: string}} input
 * @returns {Promise<{ok: boolean, status: number, latencyMs: number, message: string}>}
 */
export async function testConnection(input = {}) {
  try {
    return await postJson("/api/connection-test", {
      baseUrl: String(input.baseUrl || ""),
      apiKey: String(input.apiKey || ""),
      model: String(input.model || ""),
      channelId: String(input.channelId || "")
    }, "连接测试失败");
  } catch (error) {
    // 400（缺 KEY / 地址不合法）也会走这里：把服务端的可读原因带到界面上。
    if (error instanceof ApiError) {
      throw new Error(error.payload?.message || error.message || "连接测试失败");
    }
    throw error;
  }
}

/** 把连接测试结果整理成一行给用户看的文字（含耗时）。 */
export function formatConnectionResult(result = {}) {
  const ok = Boolean(result.ok);
  const latency = Number(result.latencyMs) > 0 ? ` · ${result.latencyMs} ms` : "";
  const statusText = Number(result.status) > 0 ? `HTTP ${result.status}` : "未收到 HTTP 响应";
  const head = ok ? "连接正常" : "连接失败";
  return `${head} · ${statusText}${latency} · ${result.message || ""}`.trim();
}
