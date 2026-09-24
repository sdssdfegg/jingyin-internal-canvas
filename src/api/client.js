export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.payload = options.payload || null;
    this.url = options.url || "";
    this.method = options.method || "";
    this.requestId = options.requestId || "";
    this.cause = options.cause;
  }
}

function createApiRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const GENERATION_ENDPOINTS = new Set([
  "/api/images",
  "/api/generate-outfit",
  "/api/videos/generations"
]);

function isGenerationEndpoint(url) {
  const text = String(url || "");
  try {
    return GENERATION_ENDPOINTS.has(new URL(text, window.location.origin).pathname);
  } catch {
    return GENERATION_ENDPOINTS.has(text.split("?")[0]);
  }
}

function summarizeFormData(form) {
  const summary = {
    kind: "form",
    fileCount: 0,
    fileBytes: 0,
    fieldNames: [],
    payload: {}
  };
  if (typeof FormData === "undefined" || !(form instanceof FormData)) return summary;
  const names = new Set();
  for (const [key, value] of form.entries()) {
    names.add(key);
    if (typeof File !== "undefined" && value instanceof File) {
      summary.fileCount += 1;
      summary.fileBytes += value.size || 0;
      continue;
    }
    if (key === "payload" && typeof value === "string") {
      try {
        const payload = JSON.parse(value);
        summary.payload = {
          taskId: payload?.taskId || "",
          workflowMode: payload?.workflowMode || "",
          pageName: payload?.pageName || "",
          model: payload?.model || "",
          imageSize: payload?.imageSize || "",
          aspectRatio: payload?.aspectRatio || "",
          generationCount: payload?.generationCount || ""
        };
      } catch {
        summary.payload = { parseFailed: true };
      }
    }
  }
  summary.fieldNames = Array.from(names).slice(0, 40);
  return summary;
}

function summarizeJsonBody(body) {
  try {
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    if (!payload || typeof payload !== "object") return { kind: "json" };
    return {
      kind: "json",
      model: payload.model || "",
      workflowMode: payload.workflowMode || "",
      imageSize: payload.imageSize || "",
      aspectRatio: payload.aspectRatio || "",
      duration: payload.duration || "",
      resolution: payload.resolution || "",
      hasPrompt: Boolean(payload.prompt),
      hasApiKey: Boolean(payload.apiKey)
    };
  } catch {
    return { kind: "json", parseFailed: true };
  }
}

function summarizeRequestBody(body) {
  if (typeof FormData !== "undefined" && body instanceof FormData) return summarizeFormData(body);
  if (body == null) return { kind: "empty" };
  return summarizeJsonBody(body);
}

function requestIdFromFormPayload(form) {
  if (typeof FormData === "undefined" || !(form instanceof FormData)) return "";
  const payloadText = form.get("payload");
  if (typeof payloadText !== "string") return "";
  try {
    const payload = JSON.parse(payloadText);
    return String(payload?.taskId || "").trim();
  } catch {
    return "";
  }
}

export function emitClientDiagnosticEvent(payload) {
  try {
    const body = JSON.stringify(payload);
    void fetch("/api/client-diagnostic-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: body.length < 60000
    }).catch(() => {});
  } catch {
    // Diagnostics must never affect the user's generation request.
  }
}

function installClientRuntimeDiagnostics() {
  if (typeof window === "undefined" || window.__jingyinClientDiagnosticsInstalled) return;
  window.__jingyinClientDiagnosticsInstalled = true;
  emitClientDiagnosticEvent({
    requestId: `client_load_${Date.now()}`,
    stage: "client-app-loaded",
    ok: true,
    detail: {
      href: window.location?.href || "",
      userAgent: navigator?.userAgent || "",
      language: navigator?.language || "",
      platform: navigator?.platform || "",
      online: navigator?.onLine
    }
  });

  window.addEventListener("error", (event) => {
    emitClientDiagnosticEvent({
      requestId: `client_error_${Date.now()}`,
      stage: "client-runtime-error",
      ok: false,
      detail: {
        message: event.message || "",
        filename: event.filename || "",
        lineno: event.lineno || 0,
        colno: event.colno || 0,
        error: event.error?.message || ""
      }
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    emitClientDiagnosticEvent({
      requestId: `client_rejection_${Date.now()}`,
      stage: "client-unhandled-rejection",
      ok: false,
      detail: {
        name: reason?.name || "",
        message: reason?.message || String(reason || ""),
        stack: reason?.stack || ""
      }
    });
  });
}

installClientRuntimeDiagnostics();

async function readResponsePayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500), raw: text };
  }
}

function responseErrorMessage(payload, fallbackMessage) {
  return payload?.message
    || payload?.error?.message
    || payload?.error
    || fallbackMessage;
}

export async function readJsonResponse(response, fallbackMessage = "请求失败", context = {}) {
  const payload = await readResponsePayload(response);
  if (!response.ok || payload?.ok === false) {
    throw new ApiError(responseErrorMessage(payload, fallbackMessage), {
      status: response.status,
      payload,
      ...context
    });
  }
  return payload || {};
}

export async function apiJson(url, options = {}, fallbackMessage = "请求失败") {
  const body = options.body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const requestId = options.requestId || createApiRequestId();
  const method = String(options.method || "GET").toUpperCase();
  const shouldTraceGeneration = method === "POST" && isGenerationEndpoint(url);
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const headers = {
    ...(!body || isFormData ? {} : { "Content-Type": "application/json" }),
    "X-Jingyin-Client-Request-Id": requestId,
    ...(options.headers || {})
  };
  const { headers: _headers, requestId: _requestId, ...fetchOptions } = options;
  if (shouldTraceGeneration) {
    emitClientDiagnosticEvent({
      requestId,
      stage: "client-generation-submit",
      endpoint: url,
      method,
      ok: true,
      detail: summarizeRequestBody(body)
    });
  }
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: Object.keys(headers).length ? headers : undefined
    });
    const payload = await readJsonResponse(response, fallbackMessage, { url, method, requestId });
    if (shouldTraceGeneration) {
      emitClientDiagnosticEvent({
        requestId,
        stage: "client-generation-response",
        endpoint: url,
        method,
        ok: true,
        status: response.status,
        durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
        detail: {
          payloadOk: payload?.ok,
          requestId: payload?.requestId || payload?.taskId || "",
          imageCount: Array.isArray(payload?.images) ? payload.images.length : payload?.image ? 1 : 0
        }
      });
    }
    return payload;
  } catch (error) {
    if (shouldTraceGeneration) {
      emitClientDiagnosticEvent({
        requestId,
        stage: "client-generation-error",
        endpoint: url,
        method,
        ok: false,
        status: error instanceof ApiError ? error.status : 0,
        durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
        detail: {
          name: error?.name || "",
          message: error?.message || String(error || ""),
          payloadError: error instanceof ApiError ? error.payload?.error || "" : "",
          payloadMessage: error instanceof ApiError ? error.payload?.message || "" : ""
        }
      });
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message ? `${fallbackMessage}：${error.message}` : fallbackMessage, {
      status: 0,
      payload: { networkError: true },
      url,
      method,
      requestId,
      cause: error
    });
  }
}

export function postJson(url, body = {}, fallbackMessage = "请求失败") {
  return apiJson(url, {
    method: "POST",
    body: JSON.stringify(body)
  }, fallbackMessage);
}

export function postForm(url, form, fallbackMessage = "请求失败") {
  const requestId = requestIdFromFormPayload(form);
  return apiJson(url, {
    method: "POST",
    body: form,
    ...(requestId ? { requestId } : {})
  }, fallbackMessage);
}
