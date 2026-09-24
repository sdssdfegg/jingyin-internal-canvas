import { postForm } from "./client.js";

export function rewriteQuickPrompt(form) {
  return postForm("/api/quick-prompt-rewrite", form, "快捷生成提示词优化失败");
}

export function rewriteReferencePrompt(form) {
  return postForm("/api/reference-prompt-rewrite", form, "参考生图提示词扩写失败");
}

export function createDetailPrompts(form) {
  return postForm("/api/detail-prompts", form, "分段提示词生成失败");
}
