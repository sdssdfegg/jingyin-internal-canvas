export function normalizeApiKeyInput(value) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}
