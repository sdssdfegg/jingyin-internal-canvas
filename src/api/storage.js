import { apiJson, postJson } from "./client.js";

/**
 * 2026-09-29（v3.7）：数据与存储自助接口。
 *
 * 封装版的数据目录不在安装包内（Windows 为 %LOCALAPPDATA%\静音AI绘画数据），
 * 用户既看不到路径，也没有能真正清掉磁盘文件的手段，因此提供：
 *   用量查询 / 打开数据目录 / 安全清理（只删固定目录下的普通文件）。
 */
export function getStorageUsage() {
  return apiJson("/api/storage/usage", {}, "读取存储用量失败");
}

export function revealStorageDir(target = "data") {
  return postJson("/api/storage/reveal", { target }, "打开数据目录失败");
}

export function cleanStorageTargets(targets) {
  return postJson("/api/storage/clean", { targets }, "清理数据失败");
}
