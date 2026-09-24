import { apiJson, postJson } from "./client.js";

export function getSaveDirectory() {
  return apiJson("/api/save-directory", {}, "读取保存目录失败");
}

export function setSaveDirectory(directory) {
  return postJson("/api/save-directory", { directory }, "保存目录设置失败");
}

export function pickSaveDirectory(directory) {
  return postJson("/api/pick-directory", { directory }, "目录选择失败");
}

export function openSaveDirectoryRequest(directory) {
  return postJson("/api/open-save-directory", { directory }, "打开保存目录失败");
}
