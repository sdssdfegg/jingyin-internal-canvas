// 生图错误分类与用户可读文案的**唯一出口**（快捷生成 / 批量生成共用）。
//
// 目标：用户看到报错就能判断原因，而不是笼统的「生成失败」。
//
// 规则：
//   1. 优先保留并翻译**服务端实际返回的原因**（payload.message / payload.error），
//      只有完全没有可用信息时才落到「未知错误」。
//   2. 绝不把 KEY、Authorization、内部堆栈、上游原始敏感信息透给用户或日志。
//   3. 失败 / 超时 / 取消都必须能被调用方识别（`released` 语义由调用方负责解除 loading，
//      这里提供 `settled: true` 标志），并且**不做任何自动重试**。
//   4. 服务端有返回 requestId / taskId 时，带上它方便查日志。

/** 用户可判断的错误种类。 */
export const GENERATION_ERROR_KINDS = Object.freeze({
  NETWORK: "network",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  CHANNEL_UNAVAILABLE: "channel_unavailable",
  INVALID_REQUEST: "invalid_request",
  UPLOAD_REJECTED: "upload_rejected",
  AUTH: "auth",
  QUOTA: "quota",
  SERVER_ERROR: "server_error",
  MISSING_IMAGE: "missing_image",
  IMAGE_URL_INVALID: "image_url_invalid",
  UNKNOWN: "unknown"
});

const KIND_LABELS = Object.freeze({
  [GENERATION_ERROR_KINDS.NETWORK]: "网络连接失败",
  [GENERATION_ERROR_KINDS.TIMEOUT]: "请求超时",
  [GENERATION_ERROR_KINDS.CANCELLED]: "已取消",
  [GENERATION_ERROR_KINDS.CHANNEL_UNAVAILABLE]: "模型或渠道不可用",
  [GENERATION_ERROR_KINDS.INVALID_REQUEST]: "参数不支持或参数错误",
  [GENERATION_ERROR_KINDS.UPLOAD_REJECTED]: "上传图片过大或格式不支持",
  [GENERATION_ERROR_KINDS.AUTH]: "鉴权失败",
  [GENERATION_ERROR_KINDS.QUOTA]: "余额不足",
  [GENERATION_ERROR_KINDS.SERVER_ERROR]: "服务器返回错误",
  [GENERATION_ERROR_KINDS.MISSING_IMAGE]: "响应缺少图片",
  [GENERATION_ERROR_KINDS.IMAGE_URL_INVALID]: "图片 URL 无效或结果下载失败",
  [GENERATION_ERROR_KINDS.UNKNOWN]: "未知错误"
});

/** 每种错误的可执行建议（让用户知道下一步做什么）。 */
const KIND_ADVICE = Object.freeze({
  [GENERATION_ERROR_KINDS.NETWORK]: "检查网络或中转站地址后重新提交。",
  [GENERATION_ERROR_KINDS.TIMEOUT]: "可重新提交；若持续超时，换一条线路再试。",
  [GENERATION_ERROR_KINDS.CANCELLED]: "本次已取消，没有产生结果；需要时重新提交即可。",
  [GENERATION_ERROR_KINDS.CHANNEL_UNAVAILABLE]: "重新选择当前模型的线路再试；换线路仍失败说明该线路在渠道侧未启用。",
  [GENERATION_ERROR_KINDS.INVALID_REQUEST]: "检查比例、尺寸、模型与参考图数量后重新提交。",
  [GENERATION_ERROR_KINDS.UPLOAD_REJECTED]: "换更小的素材或改用 JPG/PNG 后重新上传。",
  [GENERATION_ERROR_KINDS.AUTH]: "到设置里检查并重新保存 API Key。",
  [GENERATION_ERROR_KINDS.QUOTA]: "充值或更换账号后再试。",
  [GENERATION_ERROR_KINDS.SERVER_ERROR]: "这是上游返回的错误，可稍后重试或换一条线路。",
  [GENERATION_ERROR_KINDS.MISSING_IMAGE]: "上游没有返回图片，可重新生成。",
  [GENERATION_ERROR_KINDS.IMAGE_URL_INVALID]: "结果图地址不可用，可重新生成。",
  [GENERATION_ERROR_KINDS.UNKNOWN]: "请重新提交；如果反复出现，把这个 requestId 发给开发者。"
});

/**
 * 脱敏：去掉 KEY / Authorization / 明显的堆栈片段。
 * 任何要展示或写日志的错误文本都要先过这里。
 */
export function sanitizeErrorText(value, maxLength = 300) {
  let text = String(value ?? "");
  if (!text) return "";
  text = text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*)"[^"]*"/gi, "$1\"***\"")
    .replace(/\bat\s+[\w$.<>]+\s*\([^)]*\)/g, "") // 堆栈行
    .replace(/\s{2,}/g, " ")
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
}

/** 从错误对象 / payload 里取服务端给的 requestId（或 taskId）。 */
export function extractRequestId(error, context = {}) {
  const payload = error?.payload || context.payload || null;
  const candidates = [
    context.requestId,
    payload?.requestId,
    payload?.taskId,
    payload?.request_id,
    error?.requestId,
    error?.taskId
  ];
  const found = candidates.find((item) => typeof item === "string" && item.trim());
  return found ? String(found).trim().slice(0, 96) : "";
}

/** 取原始错误文本（含服务端 payload 里的真实原因）。 */
export function rawErrorText(error, context = {}) {
  const payload = error?.payload || context.payload || null;
  const candidates = [
    payload?.message,
    payload?.error?.message,
    typeof payload?.error === "string" ? payload.error : "",
    context.payloadError,
    payload?.errors,
    context.message,
    error?.message,
    error?.cause?.message,
    error ? String(error) : ""
  ];
  const parts = [];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate.filter(Boolean).join("；") : candidate;
    if (typeof value !== "string" || !value.trim()) continue;
    const text = value.trim();
    // 去重：完全相同、或被已有片段包含（上游经常把同一个错误码同时放在 message 和 error 里）
    if (parts.some((kept) => kept === text || kept.includes(text) || text.includes(kept))) continue;
    parts.push(text);
  }
  // 上游错误码放最后并用 / 分隔，避免看起来像重复了两遍
  return parts.join(" / ");
}

/**
 * 判断错误种类。
 *
 * @param {unknown} error 抛出的错误（ApiError / TypeError / AbortError / Error）
 * @param {object} [context] `{ cancelled, status, payload, requestId, phase }`
 *        `phase` 可取 "upload" / "request" / "result" / "save"，用于区分"结果下载失败"。
 */
export function classifyGenerationError(error, context = {}) {
  const status = Number(context.status || error?.status || error?.payload?.status || 0);
  const payloadError = String(error?.payload?.error || context.payloadError || "").trim();
  // rawErrorText 已经把 payload.error / payloadError 一起收进来并去重，这里不再重复拼接。
  const text = rawErrorText(error, { ...context, payloadError }).trim();
  const lower = text.toLowerCase();
  const name = String(error?.name || "").toLowerCase();
  const phase = String(context.phase || "");

  const match = (patterns) => patterns.some((pattern) => pattern.test(text) || pattern.test(lower));

  let kind = GENERATION_ERROR_KINDS.UNKNOWN;
  if (context.cancelled === true || name === "aborterror" && context.userCancelled === true
    || match([/用户取消/, /user cancel/, /cancell?ed by user/, /已取消/])) {
    kind = GENERATION_ERROR_KINDS.CANCELLED;
  } else if (phase === "result" || match([/图片下载失败/, /download.*fail/, /结果图.*失败/, /image.*download/, /图片地址无效/, /图片 URL 无效/, /invalid image url/])) {
    kind = GENERATION_ERROR_KINDS.IMAGE_URL_INVALID;
  } else if (match([/没有解析到图片/, /没有返回图片/, /未返回图片/, /响应缺少图片/, /missing image/, /no image/])) {
    // 上游 200 但结果里没有图片：属于"响应缺少图片"，不是未知错误。
    kind = GENERATION_ERROR_KINDS.MISSING_IMAGE;
  } else if (payloadError === "upstream_server_error" || match([/上游服务器返回错误/, /upstream_server_error/])) {
    // 上游真的返回了 HTTP 5xx/429（服务端会带 504 状态，但语义是"服务器错误"不是"等待超时"）。
    kind = GENERATION_ERROR_KINDS.SERVER_ERROR;
  } else if (status === 504 || match([/channel_timeout/, /timeout/, /timed?\s*out/, /超时/, /etimedout/, /abort.*timeout/]) || (name === "aborterror" && context.timeout !== false)) {
    kind = GENERATION_ERROR_KINDS.TIMEOUT;
  } else if (status === 0 && match([/fetch failed/, /failed to fetch/, /networkerror/, /network error/, /econnrefused/, /econnreset/, /enotfound/, /eai_again/, /socket hang up/, /网络/])) {
    kind = GENERATION_ERROR_KINDS.NETWORK;
  } else if (status === 401 || status === 403 || match([/invalid_api_key/, /invalid token/, /unauthorized/, /api key.*invalid/, /key 无效/, /鉴权/])) {
    kind = GENERATION_ERROR_KINDS.AUTH;
  } else if (status === 402 || match([/quota/, /余额/, /额度/, /insufficient/])) {
    kind = GENERATION_ERROR_KINDS.QUOTA;
  } else if (status === 413 || status === 415 || match([/image too large/, /payload too large/, /max\s*(?:2|4|10)\s*mb/, /(?:2|4|10)\s*mb/i, /unsupported media type/, /格式不支持/, /文件过大/, /图片过大/])) {
    kind = GENERATION_ERROR_KINDS.UPLOAD_REJECTED;
  } else if (match([/manual_channel_required/, /manual_channel_not_found/, /channel_not_found/, /route_not_found/, /no available channel/, /dispatch_mode/, /模型不存在/, /model not found/, /model_not_found/, /线路未生效/, /渠道不可用/])) {
    kind = GENERATION_ERROR_KINDS.CHANNEL_UNAVAILABLE;
  } else if (status === 400 || status === 404 || status === 422 || match([/invalid_request/, /invalid parameter/, /unsupported/, /不支持/, /参数/, /aspect/, /size.*not.*support/])) {
    kind = GENERATION_ERROR_KINDS.INVALID_REQUEST;
  } else if (status >= 500) {
    kind = GENERATION_ERROR_KINDS.SERVER_ERROR;
  }

  return {
    kind,
    label: KIND_LABELS[kind],
    advice: KIND_ADVICE[kind],
    status,
    requestId: extractRequestId(error, context),
    reason: sanitizeErrorText(text),
    // 交给调用方解除 loading 的依据；这里永远为 true（分类本身就是"已经结束"）。
    settled: true
  };
}

/** 请求成功但响应里没有图片时使用。 */
export function describeEmptyResult(context = {}) {
  return {
    kind: GENERATION_ERROR_KINDS.MISSING_IMAGE,
    label: KIND_LABELS[GENERATION_ERROR_KINDS.MISSING_IMAGE],
    advice: KIND_ADVICE[GENERATION_ERROR_KINDS.MISSING_IMAGE],
    status: Number(context.status || 0),
    requestId: extractRequestId(null, context),
    reason: sanitizeErrorText(context.message || "上游返回成功，但没有图片数据"),
    settled: true
  };
}

/**
 * 组装给用户看的一行文案。
 * 形如：`请求超时（504）· 可重新提交；若持续超时，换一条线路再试。 [requestId: xxx]`
 */
export function formatGenerationError(error, context = {}) {
  const info = error?.kind && error?.label ? error : classifyGenerationError(error, context);
  const statusText = Number(info.status) > 0 ? `（HTTP ${info.status}）` : "";
  const reasonText = info.reason && info.reason !== info.label ? `：${info.reason}` : "";
  const idText = info.requestId ? ` [requestId: ${info.requestId}]` : "";
  return `${info.label}${statusText}${reasonText} ${info.advice}${idText}`.trim();
}
