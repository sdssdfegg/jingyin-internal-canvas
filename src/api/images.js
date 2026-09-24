import { postForm } from "./client.js";

export function generateImages(form) {
  return postForm("/api/images", form, "图片生成失败");
}
