import { postJson } from "./client.js";

export function generateVideo(payload) {
  return postJson("/api/videos/generations", payload, "视频生成提交失败");
}

export function getVideoStatus(payload) {
  return postJson("/api/videos/status", payload, "视频状态查询失败");
}
