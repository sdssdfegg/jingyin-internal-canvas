import { postForm } from "./client.js";

const IMAGE_BLOB_FETCH_TIMEOUT_MS = 120000;

export function displayImageRequestUrl(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return /^https?:\/\//i.test(src) ? `/api/image-proxy?url=${encodeURIComponent(src)}` : src;
}

export async function fetchImageBlob(src, fallbackMessage = "Image request failed", options = {}) {
  const timeoutMs = Math.max(5000, Number.parseInt(options.timeoutMs || IMAGE_BLOB_FETCH_TIMEOUT_MS, 10) || IMAGE_BLOB_FETCH_TIMEOUT_MS);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(displayImageRequestUrl(src), {
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) throw new Error(`${fallbackMessage} HTTP ${response.status}`);
    return response.blob();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${fallbackMessage}：图片读取超时`);
    }
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

export function uploadCanvasAssets(form) {
  return postForm("/api/canvas-assets", form, "Canvas assets upload failed");
}
