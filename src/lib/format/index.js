export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分`;
}

export function formatWholeSecondMs(ms) {
  if (!Number.isFinite(ms)) return "--";
  const seconds = Math.max(ms > 0 ? 1 : 0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

export function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
