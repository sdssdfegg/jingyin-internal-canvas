import { apiJson } from "./client.js";

export function getAppConfig() {
  return apiJson("/api/config", {}, "读取配置失败");
}
