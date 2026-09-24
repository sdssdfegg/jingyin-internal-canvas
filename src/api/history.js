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

/**
 * 修复失效历史引用（P1 缺图自愈）。
 *
 * 默认只标记、不删除；只有显式传 `dropMissing: true` 才会清理掉失效条目。
 * 服务端在第一次修复前会留 data/history.pre-repair-backup.json。
 */
export function repairHistoryResults({ dropMissing = false } = {}) {
  return postJson("/api/history/repair", { dropMissing }, "修复历史记录失败");
}
