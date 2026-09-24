import { ApiError, postForm } from "./client.js";

function postOutfitForm(url, form, fallbackMessage) {
  return postForm(url, form, fallbackMessage).then((payload) => {
    if (payload?.ok !== true) throw new Error(payload?.message || fallbackMessage);
    return payload;
  });
}

export function analyzeOutfitMasterFit(form) {
  return postOutfitForm("/api/outfit-master-fit-analysis", form, "母版版型分析失败");
}

export function checkOutfitQuality(form) {
  return postOutfitForm("/api/outfit-quality-check", form, "AI质检失败");
}

export async function generateOutfit(form) {
  try {
    return await postOutfitForm("/api/generate-outfit", form, "批量换装生成失败");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    const payload = error.payload || {};
    const errorParts = [
      payload.message,
      ...(Array.isArray(payload.errors) ? payload.errors : [])
    ].filter(Boolean);
    const detail = [...new Set(errorParts)].join("\n");
    const detailedError = new Error(payload.message || (error.status ? `HTTP ${error.status}` : error.message));
    detailedError.detail = detail || detailedError.message;
    detailedError.status = error.status;
    detailedError.payload = payload;
    throw detailedError;
  }
}
