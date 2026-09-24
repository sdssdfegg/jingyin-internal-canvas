import { apiJson, postJson } from "./client.js";

export function getHistoryResults() {
  return apiJson("/api/history", {}, "读取历史记录失败");
}

export function appendHistoryResults(items) {
  return postJson("/api/history", { items }, "保存历史记录失败");
}

export function deleteHistoryResults(ids) {
  return apiJson("/api/history", {
    method: "DELETE",
    body: JSON.stringify({ ids })
  }, "删除历史记录失败");
}

export function clearHistoryResultsOnServer() {
  return apiJson("/api/history", {
    method: "DELETE",
    body: JSON.stringify({ clear: true })
  }, "清空历史记录失败");
}
