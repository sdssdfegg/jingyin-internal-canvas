const textFromCodes = (codes) => String.fromCharCode(...codes);

const DEFAULT_GATEWAY_BASE_URL = textFromCodes([
  104, 116, 116, 112, 115, 58, 47, 47, 97, 112, 105, 46, 106, 105, 110, 103, 121, 105, 110, 46, 111, 110, 108, 105, 110, 101
]);

const FALSE_VALUE_PATTERN = /^(0|false|off|no)$/i;

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || String(value).trim() === "") return fallback;
  return !FALSE_VALUE_PATTERN.test(String(value).trim());
}

function normalizeRootUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  return raw || DEFAULT_GATEWAY_BASE_URL;
}

function normalizePath(value, fallback) {
  const raw = String(value || "").trim() || fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function joinUrl(baseUrl, routePath) {
  if (/^https?:\/\//i.test(routePath)) return routePath;
  return `${normalizeRootUrl(baseUrl)}${normalizePath(routePath, "")}`;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function summarizeFiles(files = []) {
  const incoming = Array.isArray(files) ? files : [];
  return {
    fileCount: incoming.length,
    uploadBytes: incoming.reduce((sum, file) => sum + safeNumber(file?.size || file?.buffer?.length, 0), 0),
    mimeTypes: [...new Set(incoming.map((file) => safeText(file?.mimetype)).filter(Boolean))]
  };
}

function summarizeImageParams(params = {}, files = []) {
  const fileSummary = summarizeFiles(files);
  return {
    kind: "image",
    model: safeText(params.model),
    source: safeText(params.source),
    imageSize: safeText(params.imageSize),
    aspectRatio: safeText(params.aspectRatio),
    n: Math.max(1, safeNumber(params.n, 1)),
    hasInputImages: fileSummary.fileCount > 0,
    promptLength: safeText(params.prompt).length,
    ...fileSummary
  };
}

function summarizeVideoParams(params = {}) {
  const model = safeText(params.model);
  const duration = safeNumber(params.duration || params.seconds, 0);
  const resolution = safeText(params.resolution);
  const aspectRatio = safeText(params.aspectRatio);
  return {
    kind: "video",
    model,
    duration,
    resolution,
    aspectRatio,
    width: safeNumber(params.width, 0),
    height: safeNumber(params.height, 0),
    hasImageReference: Boolean(params.image),
    promptLength: safeText(params.prompt).length,
    billingSku: ["video", model, resolution, `${duration}s`].filter(Boolean).join(":"),
    billableQuantity: duration,
    billableUnit: "second",
    costEstimate: params.costEstimate || null
  };
}

export class BillingGatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BillingGatewayError";
    this.status = options.status || 502;
    this.code = options.code || "billing_gateway_error";
    this.payload = options.payload || null;
  }
}

export function billingGatewayPolicy() {
  const enabled = envFlag("JINGYIN_BILLING_GATEWAY_ENABLED", false);
  return {
    enabled,
    mode: enabled ? "lightweight-task-signing" : "disabled",
    baseUrl: normalizeRootUrl(process.env.JINGYIN_BILLING_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL),
    preparePath: normalizePath(process.env.JINGYIN_BILLING_GATEWAY_PREPARE_PATH, "/api/gateway/tasks/prepare"),
    finalizePath: normalizePath(process.env.JINGYIN_BILLING_GATEWAY_FINALIZE_PATH, "/api/gateway/tasks/finalize"),
    timeoutMs: Math.max(3000, Number.parseInt(process.env.JINGYIN_BILLING_GATEWAY_TIMEOUT_MS || "12000", 10) || 12000),
    hasServiceToken: Boolean(safeText(process.env.JINGYIN_BILLING_GATEWAY_SERVICE_TOKEN))
  };
}

export function publicBillingGatewayPolicy() {
  const policy = billingGatewayPolicy();
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    baseUrl: policy.enabled ? policy.baseUrl : "",
    hasServiceToken: policy.hasServiceToken
  };
}

function publicErrorCode(status, message, payload = {}) {
  const text = `${message || ""} ${payload?.error || ""} ${payload?.code || ""}`.toLowerCase();
  if (status === 401 || /invalid_api_key|unauthorized|invalid.*key|key.*invalid|token.*invalid/.test(text)) return "invalid_api_key";
  if (status === 402 || /insufficient|quota|balance|credit|billing|余额|额度/.test(text)) return "insufficient_quota";
  if (status === 403 || /permission|forbidden|not allowed|无权|权限/.test(text)) return "permission_denied";
  if (status >= 500 || status === 429 || /timeout|timed out|network|gateway|upstream|channel|超时|渠道|上游/.test(text)) return "channel_timeout";
  return "billing_gateway_error";
}

export function publicBillingErrorPayload(error, requestId = "") {
  const status = error?.status || 502;
  const payload = error?.payload || {};
  const code = publicErrorCode(status, error?.message, payload);
  if (code === "invalid_api_key") {
    return { ok: false, requestId, status: 401, error: code, message: "API Key 无效或当前账号无权限，请检查 KEY 后重新生成。" };
  }
  if (code === "insufficient_quota") {
    return { ok: false, requestId, status: 402, error: code, message: "余额不足，请充值后重新生成。" };
  }
  if (code === "permission_denied") {
    return { ok: false, requestId, status: 403, error: code, message: "当前 KEY 无权限调用该模型，请检查账号权限。" };
  }
  if (code === "channel_timeout") {
    return { ok: false, requestId, status: 504, error: code, message: "生成超时，请重新生成。" };
  }
  return {
    ok: false,
    requestId,
    status: status >= 400 && status < 500 ? status : 502,
    error: code,
    message: safeText(error?.message, "计费网关请求失败，请稍后重试。")
  };
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

async function readJsonSafely(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function postGatewayJson(routePath, payload) {
  const policy = billingGatewayPolicy();
  if (!policy.enabled) {
    return { enabled: false, ok: true, status: 0, json: null, text: "" };
  }

  const abort = createAbortSignal(policy.timeoutMs);
  try {
    const serviceToken = safeText(process.env.JINGYIN_BILLING_GATEWAY_SERVICE_TOKEN);
    const response = await fetch(joinUrl(policy.baseUrl, routePath), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: abort.signal
    });
    const parsed = await readJsonSafely(response);
    const message = safeText(parsed.json?.message || parsed.json?.error?.message || parsed.json?.error || parsed.text, `HTTP ${response.status}`);
    const code = safeText(parsed.json?.code || parsed.json?.error?.code || parsed.json?.error, response.ok ? "" : "billing_gateway_error");
    if (!response.ok || parsed.json?.ok === false) {
      throw new BillingGatewayError(message, {
        status: response.status,
        code,
        payload: parsed.json || { text: parsed.text }
      });
    }
    return {
      enabled: true,
      ok: true,
      status: response.status,
      json: parsed.json || {},
      text: parsed.text
    };
  } catch (error) {
    if (error instanceof BillingGatewayError) throw error;
    throw new BillingGatewayError(error?.name === "AbortError" ? "计费网关等待超时" : error instanceof Error ? error.message : String(error), {
      status: error?.name === "AbortError" ? 504 : 502,
      code: error?.name === "AbortError" ? "billing_gateway_timeout" : "billing_gateway_error"
    });
  } finally {
    abort.dispose();
  }
}

function normalizeGatewayTask(json = {}, requestId = "") {
  return {
    enabled: true,
    requestId,
    gatewayTaskId: safeText(json.gatewayTaskId || json.billingTaskId || json.taskId || json.id || requestId),
    routeToken: safeText(json.routeToken || json.token),
    signedRoute: json.route || json.upstream || null,
    rawStatus: json.status || ""
  };
}

export async function prepareImageBillingTask({ requestId, customerApiKey, params, files = [], candidates = [], metadata = {} }) {
  const policy = billingGatewayPolicy();
  if (!policy.enabled) return { enabled: false, requestId };
  const response = await postGatewayJson(policy.preparePath, {
    version: "jingyin-lightweight-billing-v1",
    taskType: "image",
    requestId,
    customerKey: customerApiKey,
    usage: summarizeImageParams(params, files),
    candidates,
    metadata
  });
  return normalizeGatewayTask(response.json, requestId);
}

export async function prepareVideoBillingTask({ requestId, customerApiKey, params, metadata = {} }) {
  const policy = billingGatewayPolicy();
  if (!policy.enabled) return { enabled: false, requestId };
  const usage = summarizeVideoParams(params);
  const response = await postGatewayJson(policy.preparePath, {
    version: "jingyin-lightweight-billing-v1",
    taskType: "video",
    requestId,
    customerKey: customerApiKey,
    usage,
    candidates: [
      {
        channelId: "jingyin-gateway-video",
        channelRole: "video-primary",
        provider: "jingyin-gateway",
        model: safeText(params.model),
        billingSku: usage.billingSku,
        resolution: usage.resolution,
        duration: usage.duration,
        billableUnit: usage.billableUnit,
        costEstimate: usage.costEstimate
      }
    ],
    metadata
  });
  return normalizeGatewayTask(response.json, requestId);
}

export async function finalizeBillingTask(task, result = {}) {
  if (!task?.enabled) return { enabled: false, ok: true };
  const policy = billingGatewayPolicy();
  const response = await postGatewayJson(policy.finalizePath, {
    version: "jingyin-lightweight-billing-v1",
    requestId: task.requestId,
    gatewayTaskId: task.gatewayTaskId,
    ok: Boolean(result.ok),
    status: result.status || (result.ok ? 200 : 502),
    error: result.error || "",
    message: safeText(result.message).slice(0, 1000),
    usedChannel: result.usedChannel || null,
    usedModel: result.usedModel || "",
    upstreamTaskId: result.upstreamTaskId || "",
    outputCount: safeNumber(result.outputCount, 0),
    timingMs: safeNumber(result.timingMs, 0),
    attempts: Array.isArray(result.attempts) ? result.attempts : []
  });
  return {
    enabled: true,
    ok: true,
    status: response.status,
    json: response.json || {}
  };
}
