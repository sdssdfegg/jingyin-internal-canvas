export function normalizeApiKeyInput(value) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

export function isAuthErrorMessage(message) {
  return /invalid token|unauthorized|api key|401|密钥|key 无效|key无效/i.test(String(message || ""));
}
