import http from "node:http";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

const CONFIG = {
  port: Number(process.env.PORT || 8791),
  host: process.env.HOST || "127.0.0.1",
  upstreamBaseUrl: (process.env.LK888_BASE_URL || "https://api.lk888.ai").replace(/\/+$/, ""),
  upstreamModel: process.env.LK888_MODEL || "tt-image-2",
  upstreamApiKey: process.env.LK888_API_KEY || "",
  requestTimeoutMs: Number(process.env.LK888_REQUEST_TIMEOUT_MS || 120000),
  pollTimeoutMs: Number(process.env.LK888_POLL_TIMEOUT_MS || 600000),
  pollIntervalMs: Number(process.env.LK888_POLL_INTERVAL_MS || 3000),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES || 40 * 1024 * 1024),
  maxInputImages: Number(process.env.MAX_INPUT_IMAGES || 4),
  maxN: Number(process.env.MAX_N || 1),
  forwardQuality: envFlag("LK888_FORWARD_QUALITY", false)
};

const SUCCESS_STATUSES = new Set(["SUCCESS", "SUCCESSFUL", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY", "成功", "已成功", "已完成", "完成", "生成成功", "生成完成"]);
const FAILED_STATUSES = new Set(["FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED", "失败", "已失败", "生成失败", "错误", "取消", "已取消", "超时", "拒绝"]);

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || 500);
    const message = status >= 500 ? "lk888_adapter_error" : String(error?.message || "bad_request");
    log("request_failed", { status, error: String(error?.message || error), path: req.url });
    sendJson(res, status, { error: { message, type: "lk888_adapter_error" } });
  }
});

if (isMainModule()) {
  server.listen(CONFIG.port, CONFIG.host, () => {
    log("server_started", {
      host: CONFIG.host,
      port: CONFIG.port,
      upstreamBaseUrl: CONFIG.upstreamBaseUrl,
      upstreamModel: CONFIG.upstreamModel
    });
  });
}

export {
  aspectRatioParts,
  exactImageSize,
  extractImages,
  extractTaskId,
  normalizeIncomingRequest,
  parseMultipart,
  sizeParamsFromFields
};

async function route(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    return sendJson(res, 200, { ok: true, adapter: "lk888-gpt-image", model: CONFIG.upstreamModel });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: [
        { id: "gpt-image", object: "model", owned_by: "jingyin-lk888-adapter" },
        { id: "gpt-image-2", object: "model", owned_by: "jingyin-lk888-adapter" }
      ]
    });
  }

  if (req.method === "POST" && ["/v1/images/generations", "/v1/images/edits"].includes(url.pathname)) {
    const incoming = await normalizeIncomingRequest(req, CONFIG.maxBodyBytes);
    const n = clampInt(incoming.fields.n || incoming.fields.count || 1, 1, CONFIG.maxN);
    const outputs = [];
    const upstreamMeta = [];
    for (let i = 0; i < n; i += 1) {
      const result = await generateOne(incoming, req.headers.authorization || "");
      outputs.push(...result.images);
      upstreamMeta.push(result.meta);
    }
    return sendJson(res, 200, openAiImageResponse(outputs, upstreamMeta));
  }

  sendJson(res, 404, { error: { message: "not_found", type: "not_found" } });
}

async function normalizeIncomingRequest(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  const body = await readBody(req, maxBytes);
  if (contentType.includes("multipart/form-data")) {
    const boundary = multipartBoundary(contentType);
    if (!boundary) throw httpError(400, "missing_multipart_boundary");
    const parsed = parseMultipart(body, boundary);
    return {
      fields: parsed.fields,
      images: imageInputsFromFields(parsed.fields).concat(parsed.files
        .filter((file) => imageFieldName(file.name))
        .slice(0, CONFIG.maxInputImages)
        .map((file) => bufferToDataUrl(file.data, file.contentType || "image/png")))
    };
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(body.toString("utf8"));
    const fields = {};
    for (const [key, value] of params.entries()) appendField(fields, key, value);
    return { fields, images: imageInputsFromFields(fields) };
  }

  const text = body.toString("utf8").trim();
  const fields = text ? JSON.parse(text) : {};
  return { fields: fields && typeof fields === "object" ? fields : {}, images: imageInputsFromFields(fields) };
}

async function generateOne(incoming, inboundAuthorization) {
  const apiKey = CONFIG.upstreamApiKey || bearerToken(inboundAuthorization);
  if (!apiKey) throw httpError(401, "missing_lk888_api_key");

  const { size, fallbackSize, imageSize, aspectRatio } = sizeParamsFromFields(incoming.fields);
  const params = { size };
  const images = incoming.images.slice(0, CONFIG.maxInputImages);
  if (images.length) params.images = images;
  if (CONFIG.forwardQuality && incoming.fields.quality) params.quality = String(incoming.fields.quality);

  const requestBody = {
    model: CONFIG.upstreamModel,
    prompt: String(incoming.fields.prompt || ""),
    params
  };
  if (!requestBody.prompt.trim()) throw httpError(400, "missing_prompt");

  const createUrl = `${CONFIG.upstreamBaseUrl}/v1/media/generate`;
  let raw = await postJson(createUrl, requestBody, apiKey);
  let usedSize = size;

  if (lk888RawError(raw) && fallbackSize && fallbackSize !== size && looksLikeSizeError(lk888RawError(raw))) {
    requestBody.params.size = fallbackSize;
    usedSize = fallbackSize;
    raw = await postJson(createUrl, requestBody, apiKey);
  }

  const immediate = safeExtractImages(raw);
  if (immediate.length) {
    return {
      images: immediate,
      meta: { status: "immediate", size: usedSize, image_size: imageSize, aspect_ratio: aspectRatio }
    };
  }

  const taskId = extractTaskId(raw);
  if (!taskId) {
    const detail = lk888RawError(raw) || "LK888 did not return image or task_id";
    throw httpError(502, detail);
  }

  const finalPayload = await pollTask(taskId, apiKey);
  const finalImages = extractImages(finalPayload);
  return {
    images: finalImages,
    meta: { status: "completed", task_id: taskId, size: usedSize, image_size: imageSize, aspect_ratio: aspectRatio }
  };
}

async function pollTask(taskId, apiKey) {
  const startedAt = Date.now();
  let lastPayload = null;
  let polls = 0;

  while (Date.now() - startedAt < CONFIG.pollTimeoutMs) {
    await delay(polls === 0 ? 800 : CONFIG.pollIntervalMs);
    polls += 1;
    const statusUrl = `${CONFIG.upstreamBaseUrl}/v1/media/status?task_id=${encodeURIComponent(taskId)}`;
    lastPayload = await getJson(statusUrl, apiKey);
    const images = safeExtractImages(lastPayload);
    if (images.length) return lastPayload;

    const status = normalizedTaskStatus(lastPayload);
    if (SUCCESS_STATUSES.has(status)) return lastPayload;
    if (FAILED_STATUSES.has(status)) {
      throw httpError(502, taskFailReason(lastPayload));
    }
  }

  throw httpError(504, `LK888 task timeout, task_id=${taskId}, last=${safeJson(lastPayload, 800)}`);
}

function sizeParamsFromFields(fields) {
  const directSize = nestedValue(fields, ["params", "size"]) || fields.size || fields.output_size;
  if (isPixelSize(directSize)) {
    return {
      size: String(directSize).trim(),
      fallbackSize: imageSizeLabel(fields),
      imageSize: imageSizeLabel(fields),
      aspectRatio: aspectRatioValue(fields)
    };
  }

  const imageSize = imageSizeLabel(fields);
  const aspectRatio = aspectRatioValue(fields);
  return {
    size: exactImageSize(aspectRatio, imageSize),
    fallbackSize: imageSize,
    imageSize,
    aspectRatio
  };
}

function exactImageSize(aspectRatio, imageSize) {
  const longEdgeMap = { "1K": 1024, "2K": 2304, "4K": 4096 };
  const label = normalizeImageSizeLabel(imageSize);
  const edge = longEdgeMap[label] || longEdgeMap["2K"];
  const [w, h] = aspectRatioParts(aspectRatio);
  if (Math.abs(w - h) < 0.01) return `${edge}x${edge}`;
  if (w > h) return `${edge}x${Math.max(1, Math.round((edge * h) / w))}`;
  return `${Math.max(1, Math.round((edge * w) / h))}x${edge}`;
}

function aspectRatioParts(aspectRatio) {
  const text = String(aspectRatio || "1:1").trim().replace("/", ":");
  const match = text.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return [1, 1];
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w > 0 && h > 0 ? [w, h] : [1, 1];
}

function imageSizeLabel(fields) {
  const value = fields.image_size || fields.imageSize || fields.resolution || fields.quality_size || fields.size || "2K";
  return normalizeImageSizeLabel(value);
}

function normalizeImageSizeLabel(value) {
  const text = String(value || "").trim().toUpperCase();
  if (["1K", "2K", "4K"].includes(text)) return text;
  if (/^1024X1024$/i.test(text)) return "1K";
  if (/^2048X2048$/i.test(text) || /^2304X2304$/i.test(text)) return "2K";
  if (/^4096X4096$/i.test(text)) return "4K";
  return "2K";
}

function aspectRatioValue(fields) {
  return String(fields.aspect_ratio || fields.aspectRatio || fields.ratio || "1:1").trim() || "1:1";
}

function parseMultipart(body, boundary) {
  const delimiter = `--${boundary}`;
  const raw = body.toString("latin1");
  const fields = {};
  const files = [];

  for (let part of raw.split(delimiter)) {
    if (!part || part === "--\r\n" || part === "--") continue;
    part = part.replace(/^\r\n/, "");
    if (part.endsWith("--\r\n")) part = part.slice(0, -4);
    if (part.endsWith("--")) part = part.slice(0, -2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd);
    const dataText = part.slice(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = headers["content-disposition"] || "";
    const name = dispositionParam(disposition, "name");
    if (!name) continue;

    const filename = dispositionParam(disposition, "filename");
    const contentType = headers["content-type"] || "";
    const data = Buffer.from(dataText, "latin1");
    if (filename || contentType.startsWith("image/")) {
      files.push({ name, filename, contentType, data });
    } else {
      appendField(fields, name, data.toString("utf8"));
    }
  }

  return { fields, files };
}

function parsePartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function dispositionParam(disposition, name) {
  const pattern = new RegExp(`${name}="([^"]*)"`, "i");
  const match = disposition.match(pattern);
  return match ? match[1] : "";
}

function imageInputsFromFields(fields) {
  const images = [];
  collectImageValues(images, fields.image);
  collectImageValues(images, fields.images);
  collectImageValues(images, fields.image_url);
  collectImageValues(images, fields.image_urls);
  collectImageValues(images, fields.imageUrl);
  collectImageValues(images, fields.imageUrls);
  collectImageValues(images, fields.reference_image);
  collectImageValues(images, fields.reference_images);
  return images.filter(Boolean).slice(0, CONFIG.maxInputImages);
}

function collectImageValues(out, value) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectImageValues(out, item);
    return;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (typeof value === "object") {
    collectImageValues(out, value.url || value.image_url || value.imageUrl || value.b64_json || value.base64);
  }
}

function extractImages(payload) {
  const found = [];
  const seen = new Set();

  function add(type, value, mimeType = "image/png") {
    if (!value) return;
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ type, value, mimeType });
  }

  function walk(value, depth = 0, trustedKey = "") {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) add("url", value);
      else if (looksLikeImageUrl(value) || imageOutputKey(trustedKey)) add("url", value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, trustedKey);
      return;
    }
    if (typeof value !== "object") return;

    for (const key of ["b64_json", "base64", "image_base64"]) {
      if (typeof value[key] === "string" && value[key].trim()) add("b64", stripDataUrl(value[key].trim()), value.mime_type || value.mimeType || "image/png");
    }
    for (const key of Object.keys(value)) {
      walk(value[key], depth + 1, key);
    }
  }

  walk(payload);
  if (!found.length) throw httpError(502, "no_image_in_lk888_response");
  return found;
}

function safeExtractImages(payload) {
  try {
    return extractImages(payload);
  } catch {
    return [];
  }
}

function extractTaskId(payload) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of ["task_id", "taskId", "task", "job_id", "jobId"]) {
    if (payload[key]) return String(payload[key]);
  }
  const taskIds = payload["任务ids"] || payload.task_ids || payload.taskIds;
  if (Array.isArray(taskIds) && taskIds.length) return String(taskIds[0]);
  if (payload.id && (String(payload.id).startsWith("task") || payload.status || payload.task_status || payload.state)) return String(payload.id);
  const nested = payload.data;
  if (Array.isArray(nested) && nested.length) return extractTaskId(nested[0]);
  if (nested && typeof nested === "object") return extractTaskId(nested);
  return "";
}

function normalizedTaskStatus(payload) {
  const data = payload && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  if (!data || typeof data !== "object") return "";
  if (payload && payload.code != null && ![0, 200, "0", "200", ""].includes(payload.code)) return "FAILED";
  return String(data.status || data.task_status || data.state || data["任务状态"] || data.status_msg || data.statusMsg || data["状态"] || "").trim().toUpperCase();
}

function taskFailReason(payload) {
  const data = payload && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  const error = data?.error && typeof data.error === "object" ? data.error : {};
  return String(data?.fail_reason || data?.["失败原因"] || data?.error_msg || data?.message || data?.msg || error.message || "LK888 task failed");
}

function lk888RawError(payload) {
  if (!payload || typeof payload !== "object") return "";
  if ([undefined, null, "", 0, 200, "0", "200"].includes(payload.code)) return "";
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return String(payload.message || payload.msg || data.message || data.msg || data["失败原因"] || "");
}

function looksLikeSizeError(text) {
  const value = String(text || "").toLowerCase();
  return value.includes("size") && (value.includes("invalid") || value.includes("unsupported") || value.includes("illegal") || value.includes("不合法"));
}

async function postJson(url, body, apiKey) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, CONFIG.requestTimeoutMs);
  return responseJsonOrThrow(response, "LK888 create request failed");
}

async function getJson(url, apiKey) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` }
  }, CONFIG.requestTimeoutMs);
  return responseJsonOrThrow(response, "LK888 status request failed");
}

async function responseJsonOrThrow(response, fallback) {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || payload?.msg || text || `${fallback}: HTTP ${response.status}`;
    throw httpError(502, String(message).slice(0, 500));
  }
  return payload;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function openAiImageResponse(images, upstreamMeta) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: images.map((image) => image.type === "b64"
      ? { b64_json: stripDataUrl(image.value) }
      : { url: image.value }),
    upstream: {
      adapter: "lk888-gpt-image",
      model: CONFIG.upstreamModel,
      tasks: upstreamMeta
    }
  };
}

function imageFieldName(name) {
  return ["image", "images", "image[]", "file", "files"].includes(String(name || ""));
}

function imageOutputKey(key) {
  return /^(url|image|image_url|imageUrl|output|result|origin_image_url|originImageUrl)$/i.test(String(key || ""));
}

function looksLikeImageUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return /\.(png|jpe?g|webp|gif|bmp|tiff)(?:$|\?)/i.test(parsed.pathname + parsed.search)
      || /image|img|cdn|oss|cos|r2|s3|media|output|result/i.test(parsed.hostname + parsed.pathname);
  } catch {
    return false;
  }
}

function isPixelSize(value) {
  return /^\d{2,5}\s*x\s*\d{2,5}$/i.test(String(value || "").trim());
}

function nestedValue(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function bufferToDataUrl(buffer, contentType) {
  return `data:${contentType || "image/png"};base64,${buffer.toString("base64")}`;
}

function stripDataUrl(value) {
  return String(value || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}

function appendField(fields, key, value) {
  if (fields[key] == null) {
    fields[key] = value;
  } else if (Array.isArray(fields[key])) {
    fields[key].push(value);
  } else {
    fields[key] = [fields[key], value];
  }
}

function multipartBoundary(contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2] || "").trim() : "";
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw httpError(413, "request_body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*"
  });
  res.end(text);
}

function safeJson(value, limit = 1000) {
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return "";
  }
}

function log(event, data = {}) {
  const clean = JSON.stringify(data).replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...JSON.parse(clean) }));
}

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
