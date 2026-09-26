import "dotenv/config";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
// 图片地址判定与前端共用同一份（发布时 esbuild 会把 src/shared 内联进 server bundle）。
// 注意：这只管"图片回传"；生图 API 仍然只允许官方中转，见 PRIMARY_CHANNEL_API_BASE_URL。
import { isSafeRemoteImageUrl } from "../src/shared/image-hosts.js";
import {
  CHANNEL_MODELS,
  buildImageRequestVariants,
  extractImagesFromResponse,
  normalizeBaseUrl,
  normalizeImageRequest,
  validateImageCapabilities,
  validateImageRouting,
  summarizeResponse
} from "./channel.js";
import {
  PRIMARY_CHANNEL_API_BASE_URL,
  buildChannelBaseCandidates,
  buildImageChannelBaseCandidates,
  channelEndpointForBaseUrl,
  apiKeyForChannel,
  apiKeyHeadersForChannel,
  channelLogFields,
  publicChannelGateways,
  publicChannelModels,
  publicChannelPolicyConfig,
  upstreamModelForChannel,
  publicRoutingCatalog
} from "./channel-config.js";
import {
  JINGYIN_VIDEO_GATEWAY_CHANNEL_ID,
  createGatewayVideoBody,
  gatewayVideoBaseUrl,
  normalizeVideoGenerationRequest,
  publicVideoModels,
  publicVideoPolicyConfig
} from "./video-config.js";
import {
  billingGatewayPolicy,
  finalizeBillingTask,
  prepareImageBillingTask,
  prepareVideoBillingTask,
  publicBillingErrorPayload,
  publicBillingGatewayPolicy
} from "./billing-gateway.js";
import { createDetailAiPlan } from "./detail-ai.js";
import { buildDetailPromptGroup as buildDetailPromptGroupV2 } from "./detail-middleware.js";
import { buildOutfitPrompt, primaryOutfitGenerationError } from "./outfit-skill.js";
import { createOutfitMasterFitSpec } from "./outfit-master-fit-ai.js";
import { createOutfitQualityCheck } from "./outfit-quality-ai.js";
import { createOutfitPoseAnchor } from "./outfit-pose-ai.js";
import { createQuickPromptRewrite, quickPromptFallback } from "./quick-prompt-ai.js";
import { createReferencePromptRewrite, localReferencePrompt } from "./reference-ai.js";
import { normalizeApiKeyInput } from "./features/auth/api-key.js";
import { EMBEDDED_STATIC_ASSETS } from "./static-assets.generated.js";

const runtimeFile = typeof require !== "undefined" && typeof __filename !== "undefined"
  ? __filename
  : fileURLToPath(import.meta.url);
const runtimeDir = path.dirname(runtimeFile);
const sourceRootDir = path.resolve(runtimeDir, "..");
const executableRootDir = process.execPath ? path.dirname(process.execPath) : "";
const executableName = path.basename(process.execPath || "").toLowerCase();
const isMacAppBundleExecutable = process.platform === "darwin"
  && executableRootDir.replace(/\\/g, "/").endsWith(".app/Contents/MacOS");
const macAppDir = isMacAppBundleExecutable ? path.resolve(executableRootDir, "../..") : "";
const macAppDataRoot = macAppDir ? path.join(path.dirname(macAppDir), "静音AI绘画数据") : "";
const looksLikePackagedExecutable = Boolean(executableRootDir)
  && !["node", "node.exe"].includes(executableName);
const windowsPackagedDataRoot = process.platform === "win32" && looksLikePackagedExecutable
  ? path.join(process.env.LOCALAPPDATA || process.env.APPDATA || executableRootDir, "静音AI绘画数据")
  : "";
const packagedRootDir = executableRootDir && (
  existsSync(path.join(executableRootDir, "dist", "index.html")) || looksLikePackagedExecutable
)
  ? executableRootDir
  : "";
const rootDir = path.resolve(process.env.JINGYIN_RELEASE_ROOT || macAppDataRoot || windowsPackagedDataRoot || packagedRootDir || sourceRootDir);
const dataDir = path.join(rootDir, "data");
const historyFile = path.join(dataDir, "history.json");
const historyBackupFile = path.join(dataDir, "history.backup.json");
const historyImageDir = path.join(dataDir, "history-images");
const referenceAssetDir = path.join(dataDir, "reference-assets");
const canvasAssetDir = path.join(dataDir, "canvas-assets");
const resultDir = path.join(dataDir, "results");
const uploadTempDir = path.join(rootDir, "tmp", "uploads");
const appSettingsFile = path.join(dataDir, "app-settings.json");
const app = express();
const OUTFIT_UPLOAD_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const OUTFIT_UPLOAD_FILE_LIMIT_MB = Math.round(OUTFIT_UPLOAD_FILE_LIMIT_BYTES / 1024 / 1024);
// multer 的 maxCount 只是**解析硬上限**，真实上限由 routing catalog 的
// capabilities.maxInputImages 决定（见 server/channel.js validateImageCapabilities）。
// 这里取 4 个模型里的最大值 14，再留 2 个余量，保证不会被 multer 先截断。
const IMAGE_UPLOAD_PARSE_CEILING = 16;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: IMAGE_UPLOAD_PARSE_CEILING,
    fileSize: OUTFIT_UPLOAD_FILE_LIMIT_BYTES
  }
});
function safeUploadFilename(name = "upload") {
  const ext = path.extname(String(name || "")) || ".img";
  const base = path.basename(String(name || "upload"), ext)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "upload";
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`;
}
const imageForwardUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(uploadTempDir, { recursive: true }).then(() => cb(null, uploadTempDir), cb);
    },
    filename: (_req, file, cb) => cb(null, safeUploadFilename(file.originalname))
  }),
  limits: {
    files: IMAGE_UPLOAD_PARSE_CEILING,
    fileSize: OUTFIT_UPLOAD_FILE_LIMIT_BYTES,
    // 香蕉 Pro 参考图改走 JSON + image_urls 通道时，客户端会把 1536 长边的
    // JPEG data URL 作为文本字段一起上传；multer 默认 fieldSize 只有 1MB 会被截断。
    fieldSize: 8 * 1024 * 1024
  }
});
const largeImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 96 * 1024 * 1024
  }
});

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const PORT_FALLBACK_LIMIT = Math.max(
  0,
  Math.min(20, Number.parseInt(process.env.JINGYIN_PORT_FALLBACK_LIMIT || (process.env.PORT ? "0" : "10"), 10) || 0)
);
const IMAGE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_REQUEST_TIMEOUT_MS || "900000", 10);
const IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(IMAGE_REQUEST_TIMEOUT_MS, Number.parseInt(process.env.IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS || "360000", 10) || 360_000)
);
const LOCAL_HTTP_TIMEOUT_MS = Number.parseInt(process.env.LOCAL_HTTP_TIMEOUT_MS || "960000", 10);
const IMAGE_PROXY_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_PROXY_TIMEOUT_MS || "180000", 10);
const RESULT_DISPLAY_CACHE_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.RESULT_DISPLAY_CACHE_TIMEOUT_MS || "45000", 10) || 45000);
const RESULT_DISPLAY_CACHE_BLOCKING_TIMEOUT_MS = Math.max(
  1500,
  Math.min(
    RESULT_DISPLAY_CACHE_TIMEOUT_MS,
    Number.parseInt(process.env.RESULT_DISPLAY_CACHE_BLOCKING_TIMEOUT_MS || "8000", 10) || 8000
  )
);
const GATEWAY_COMPRESSION_MIN_BYTES = Number.parseInt(process.env.GATEWAY_COMPRESSION_MIN_BYTES || "1024", 10);
const DOWNLOAD_CHUNK_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.DOWNLOAD_CHUNK_BYTES || "262144", 10) || 262144);
const RESULT_URL_DOWNLOAD_CHUNK_BYTES = Math.max(128 * 1024, Number.parseInt(process.env.RESULT_URL_DOWNLOAD_CHUNK_BYTES || String(1024 * 1024), 10) || 1024 * 1024);
const RESULT_URL_DOWNLOAD_RETRIES = Math.max(1, Math.min(5, Number.parseInt(process.env.RESULT_URL_DOWNLOAD_RETRIES || "3", 10) || 3));
// 中文注释：每台电脑默认最多 5 个图片请求同时等待中转站，避免本机和网关一起被瞬时批量压满。
const IMAGE_CONCURRENCY_LIMIT = Math.max(1, Math.min(24, Number.parseInt(process.env.IMAGE_CONCURRENCY_LIMIT || "5", 10) || 5));
const RESULT_CACHE_TTL_DAYS = Math.max(1, Math.min(365, Number.parseInt(process.env.RESULT_CACHE_TTL_DAYS || "7", 10) || 7));
const RESULT_CACHE_TTL_MS = RESULT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const RESULT_CACHE_MAX_DISK_USAGE_RATIO = Math.max(
  0.5,
  Math.min(0.98, Number.parseFloat(process.env.RESULT_CACHE_MAX_DISK_USAGE_RATIO || "0.8") || 0.8)
);
const RESULT_CACHE_DISK_PRESSURE_MIN_FILE_AGE_MS = Math.max(
  0,
  Number.parseInt(process.env.RESULT_CACHE_DISK_PRESSURE_MIN_FILE_AGE_MS || String(30 * 60 * 1000), 10) || 30 * 60 * 1000
);
const RESULT_CACHE_POST_WRITE_CLEANUP_DELAY_MS = Math.max(
  5000,
  Number.parseInt(process.env.RESULT_CACHE_POST_WRITE_CLEANUP_DELAY_MS || "30000", 10) || 30000
);
const RESULT_CACHE_CLEANUP_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number.parseInt(process.env.RESULT_CACHE_CLEANUP_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10) || 6 * 60 * 60 * 1000
);
const VIDEO_BILLING_GATEWAY_REQUIRED = /^(1|true|on|yes)$/i.test(String(process.env.JINGYIN_REQUIRE_VIDEO_BILLING_GATEWAY || "0"));
const VIDEO_ROUTE_SESSION_TTL_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(process.env.VIDEO_ROUTE_SESSION_TTL_MS || String(4 * 60 * 60 * 1000), 10) || 4 * 60 * 60 * 1000
);
const RESULT_CACHE_CONTROL = `public, max-age=${Math.floor(RESULT_CACHE_TTL_MS / 1000)}, immutable`;
const GENERATION_LOG_MAX_BYTES = Math.max(
  1024 * 1024,
  Number.parseInt(process.env.JINGYIN_GENERATION_LOG_MAX_BYTES || String(8 * 1024 * 1024), 10) || 8 * 1024 * 1024
);
const RUNTIME_LOG_MAX_BYTES = Math.max(
  512 * 1024,
  Number.parseInt(process.env.JINGYIN_RUNTIME_LOG_MAX_BYTES || String(4 * 1024 * 1024), 10) || 4 * 1024 * 1024
);
const ASSET_LOG_MAX_BYTES = Math.max(
  512 * 1024,
  Number.parseInt(process.env.JINGYIN_ASSET_LOG_MAX_BYTES || String(4 * 1024 * 1024), 10) || 4 * 1024 * 1024
);
let activeImageRequestCount = 0;
const imageRequestQueue = [];
const videoRouteSessions = new Map();
const localGenerationRequestStartedAt = new Map();
let saveFilenameLock = Promise.resolve();
let resultCacheCleanupRunning = false;
let resultCacheCleanupTimer = null;
let resultCacheCleanupStarted = false;

app.use(express.json({ limit: "100mb" }));
app.use(gatewayCompressionMiddleware);
app.use(generationRequestTraceMiddleware);

function appendVaryHeader(current, value) {
  const parts = String(current || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.some((item) => item.toLowerCase() === value.toLowerCase())) parts.push(value);
  return parts.join(", ");
}

function acceptedGatewayEncoding(req) {
  const acceptEncoding = String(req.headers["accept-encoding"] || "").toLowerCase();
  if (/\bbr\b/.test(acceptEncoding) && !/\bbr\s*;\s*q=0(?:\.0+)?\b/.test(acceptEncoding)) return "br";
  if (/\bgzip\b/.test(acceptEncoding) && !/\bgzip\s*;\s*q=0(?:\.0+)?\b/.test(acceptEncoding)) return "gzip";
  return "";
}

function isCompressibleResponseType(contentType) {
  return /\b(json|text|javascript|css|html|xml|svg)\b/i.test(String(contentType || ""));
}

function gatewayCompressionMiddleware(req, res, next) {
  const originalSend = res.send.bind(res);

  res.send = function sendWithGatewayCompression(body) {
    const encoding = acceptedGatewayEncoding(req);
    const statusCode = res.statusCode || 200;
    const contentType = String(res.getHeader("Content-Type") || "");
    const shouldSkip = !encoding
      || req.method === "HEAD"
      || req.headers.range
      || statusCode === 204
      || statusCode === 304
      || res.getHeader("Content-Encoding")
      || !isCompressibleResponseType(contentType);

    if (shouldSkip || body == null || (!Buffer.isBuffer(body) && typeof body !== "string")) {
      return originalSend(body);
    }

    const source = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (source.length < GATEWAY_COMPRESSION_MIN_BYTES) return originalSend(body);

    try {
      const compressed = encoding === "br"
        ? brotliCompressSync(source)
        : gzipSync(source);
      if (compressed.length >= source.length) return originalSend(body);

      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", appendVaryHeader(res.getHeader("Vary"), "Accept-Encoding"));
      res.setHeader("Content-Length", String(compressed.length));
      return originalSend(compressed);
    } catch {
      return originalSend(body);
    }
  };

  next();
}

function shouldAutoOpenBrowser() {
  return process.env.JINGYIN_NO_BROWSER !== "1" && (
    Boolean(packagedRootDir) || process.env.JINGYIN_OPEN_BROWSER === "1"
  );
}

function openAppInBrowser(port = PORT) {
  if (!shouldAutoOpenBrowser()) return;
  const url = `http://127.0.0.1:${port}/`;
  const command = process.platform === "win32"
    ? { file: "cmd.exe", args: ["/c", "start", "", url] }
    : process.platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch {
    // Opening the browser is a convenience; the local server still works without it.
  }
}

function sendEmbeddedStaticAsset(req, res) {
  const files = EMBEDDED_STATIC_ASSETS?.files;
  if (!files) return false;

  let pathname = "/";
  try {
    pathname = new URL(req.originalUrl || req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    pathname = "/";
  }

  const normalizedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const asset = files[normalizedPath] || (!path.extname(normalizedPath) ? files["/index.html"] : null);
  if (!asset) return false;

  const body = Buffer.from(asset.data, "base64");
  res.status(200)
    .set({
      "Content-Type": asset.type || "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": normalizedPath.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache"
    })
    .end(body);
  return true;
}

function imageSlotWeight(value) {
  return Math.max(1, Math.min(IMAGE_CONCURRENCY_LIMIT, Number.parseInt(value, 10) || 1));
}

function drainImageQueue() {
  while (
    imageRequestQueue.length > 0
    && activeImageRequestCount + imageRequestQueue[0].weight <= IMAGE_CONCURRENCY_LIMIT
  ) {
    const next = imageRequestQueue.shift();
    next.grant();
  }
}

function acquireImageSlot(weight = 1) {
  const slotWeight = imageSlotWeight(weight);
  return new Promise((resolve) => {
    const grant = () => {
      activeImageRequestCount += slotWeight;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeImageRequestCount = Math.max(0, activeImageRequestCount - slotWeight);
        queueMicrotask(drainImageQueue);
      });
    };

    if (activeImageRequestCount + slotWeight <= IMAGE_CONCURRENCY_LIMIT) {
      grant();
    } else {
      imageRequestQueue.push({ weight: slotWeight, grant });
    }
  });
}

async function writeGenerationLog(entry) {
  if (process.env.JINGYIN_DISABLE_GENERATION_LOGS === "1") return;
  const logDir = path.join(rootDir, "logs");
  const logFile = path.join(logDir, "generation.jsonl");
  await mkdir(logDir, { recursive: true });
  await rotateLogFileIfNeeded(logFile, GENERATION_LOG_MAX_BYTES);
  await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  await appendTaskTextLog(entry).catch(() => {});
}

async function rotateLogFileIfNeeded(file, maxBytes) {
  const info = await stat(file).catch(() => null);
  if (!info || info.size <= maxBytes) return;
  const rotated = `${file}.1`;
  await unlink(rotated).catch(() => {});
  await rename(file, rotated).catch(async () => {
    await writeFile(file, "", "utf8").catch(() => {});
  });
}

function localDateFolder(value = Date.now()) {
  const timestamp = Number(value);
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(value = Date.now()) {
  const timestamp = Number(value);
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  const pad = (number, size = 2) => String(number).padStart(size, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  ].join(" ");
}

function readableBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function readableMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)} 秒`;
  return `${Math.max(0, Math.round(ms))} 毫秒`;
}

function safeTaskLogId(value) {
  const id = String(value || "").trim();
  return sanitizeFilePart(id || `task_${Date.now()}`).slice(0, 120) || `task_${Date.now()}`;
}

function safeTaskLogRequestId(entry) {
  const detailRequestId = entry?.detail && typeof entry.detail === "object"
    ? String(entry.detail.requestId || entry.detail.taskId || "")
    : "";
  return detailRequestId || String(entry?.requestId || "");
}

function taskTextLogPath(entry) {
  const requestId = safeTaskLogRequestId(entry);
  if (!requestId || /^client_load_|^client_error_|^client_rejection_/i.test(requestId)) return "";
  const time = entry?.time ? Date.parse(entry.time) : Date.now();
  const folder = path.join(rootDir, "logs", "tasks", localDateFolder(Number.isFinite(time) ? time : Date.now()));
  return path.join(folder, `${safeTaskLogId(requestId)}.txt`);
}

function taskLogUrl(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text.split("?")[0].slice(0, 180);
  }
}

function taskLogStageTitle(stage) {
  return ({
    "client-generation-submit": "前端点击生成，准备提交",
    "client-generation-response": "前端收到本地接口响应",
    "client-generation-error": "前端生成请求失败",
    "client-generation-local-paste-composed": "局部回贴贴回合成完成",
    "client-result-display-ready": "前端结果图已完成显示准备",
    "local-request-received": "本地服务收到生成请求",
    "local-request-aborted": "本地请求被中断",
    "local-response-finished": "本地服务响应结束",
    "local-api-images-request-prepared": "快捷生成参数与上传文件解析完成",
    "local-outfit-request-prepared": "批量生成参数与上传文件解析完成",
    "smart-intervention-start": "智能干预/锚点分析开始",
    "smart-intervention-finished": "智能干预/锚点分析完成",
    "smart-intervention-failed": "智能干预/锚点分析失败并回退",
    "image-slot-acquired": "本地并发队列已放行",
    "forward-api-images-request": "开始转发快捷生成到中转站",
    "forward-outfit-request": "开始转发批量生成到中转站",
    "generate-outfit": "中转站批量生成返回",
    "upstream-api-images-ready": "中转站快捷生成已返回图片",
    "upstream-outfit-images-ready": "中转站批量生成已返回图片",
    "display-cache-base64-history-image": "结果图写入本地历史缓存",
    "display-cache-url-history-image": "结果图下载并写入本地历史缓存",
    "display-cache-history-image-deferred": "结果图本地缓存较慢，已改后台处理",
    "display-cache-outfit-result-image": "批量结果图下载/本地缓存",
    "background-display-cache-outfit-result-image": "批量结果图后台缓存完成",
    "local-api-images-response-ready": "快捷生成结果已准备返回前端",
    "local-outfit-response-ready": "批量生成结果已准备返回前端",
    "api-images-background-persist": "快捷生成后台保存完成",
    "background-cache-outfit-result-image": "批量结果图后台缓存完成"
  })[stage] || stage || "未命名阶段";
}

function taskLogLines(entry) {
  const stage = String(entry?.stage || "");
  if (!stage) return [];
  const allowed = /^client-generation-|^client-result-display-ready$|^local-|^smart-intervention-|^image-slot-acquired$|^forward-|^generate-outfit$|^upstream-|^display-cache-|^background-display-cache-|^background-cache-outfit-|^api-images-background-persist$/.test(stage);
  if (!allowed) return [];

  const lines = [
    "",
    "------------------------------------------------------------",
    `时间：${localDateTime(entry?.time ? Date.parse(entry.time) : Date.now())}`,
    `阶段：${taskLogStageTitle(stage)}`
  ];
  if (entry.endpoint) lines.push(`本地接口：${entry.endpoint}`);
  if (entry.method) lines.push(`方法：${entry.method}`);
  if (entry.status !== undefined) lines.push(`状态码：${entry.status}`);
  if (entry.ok !== undefined) lines.push(`结果：${entry.ok ? "成功/继续" : "失败/异常"}`);
  if (entry.model || entry.requestedModel) lines.push(`模型：${entry.model || entry.requestedModel}`);
  if (entry.imageSize || entry.aspectRatio) lines.push(`尺寸：${entry.imageSize || "-"} / ${entry.aspectRatio || "-"}`);
  if (entry.workflowMode) lines.push(`板块模式：${entry.workflowMode}`);
  if (entry.n !== undefined) lines.push(`生成数量：${entry.n}`);
  if (entry.fileCount !== undefined) lines.push(`上传图片数：${entry.fileCount}`);
  if (entry.uploadBytes !== undefined) lines.push(`上传图片总大小：${readableBytes(entry.uploadBytes)}`);
  if (entry.contentLength !== undefined) lines.push(`本地请求体大小：${readableBytes(entry.contentLength)}`);
  if (entry.promptChars !== undefined || entry.promptBytes !== undefined) {
    lines.push(`提示词长度：${entry.promptChars || 0} 字 / ${readableBytes(entry.promptBytes || 0)}`);
  }
  if (entry.url) lines.push(`请求地址：${taskLogUrl(entry.url)}`);
  if (entry.channelId || entry.channelLabel) lines.push(`中转站/渠道：${entry.channelLabel || entry.channelId}`);
  if (entry.attempt !== undefined) lines.push(`尝试次数：${entry.attempt}`);
  if (entry.imageCount !== undefined) lines.push(`返回图片数：${entry.imageCount}`);
  if (entry.localDisplayCount !== undefined) lines.push(`本地展示缓存数：${entry.localDisplayCount}`);
  if (entry.bytes !== undefined) lines.push(`结果图大小：${readableBytes(entry.bytes)}`);
  if (entry.localUploadParseMs !== undefined) lines.push(`上传到本地/解析文件：${readableMs(entry.localUploadParseMs)}`);
  if (entry.queueWaitMs !== undefined) lines.push(`本地并发排队：${readableMs(entry.queueWaitMs)}`);
  if (entry.durationMs !== undefined) lines.push(`前端请求耗时：${readableMs(entry.durationMs)}`);
  if (entry.timingMs !== undefined) lines.push(`本阶段耗时：${readableMs(entry.timingMs)}`);
  if (entry.displayCacheMs !== undefined) lines.push(`结果图下载/缓存耗时：${readableMs(entry.displayCacheMs)}`);
  if (entry.totalMs !== undefined) lines.push(`累计总耗时：${readableMs(entry.totalMs)}`);
  if (entry.timing && typeof entry.timing === "object") {
    if (entry.timing.channelWaitMs !== undefined) lines.push(`等待中转站/上游：${readableMs(entry.timing.channelWaitMs)}`);
    if (entry.timing.parseMs !== undefined) lines.push(`解析中转站响应：${readableMs(entry.timing.parseMs)}`);
    if (entry.timing.totalMs !== undefined) lines.push(`本地累计：${readableMs(entry.timing.totalMs)}`);
  }
  if (entry.upstreamChannelWaitMs !== undefined) lines.push(`等待中转站/上游：${readableMs(entry.upstreamChannelWaitMs)}`);
  if (entry.postParseMs !== undefined) lines.push(`中转站返回后本地处理：${readableMs(entry.postParseMs)}`);
  if (entry.timeoutMs !== undefined) lines.push(`本阶段超时上限：${readableMs(entry.timeoutMs)}`);
  if (entry.hasLocalDisplayImage !== undefined) lines.push(`是否已有本地展示图：${entry.hasLocalDisplayImage ? "是" : "否"}`);
  if (entry.autoSavedCount !== undefined) lines.push(`自动保存数量：${entry.autoSavedCount}`);

  const detail = entry.detail && typeof entry.detail === "object" ? entry.detail : null;
  if (detail) {
    if (detail.payload?.workflowMode) lines.push(`前端板块模式：${detail.payload.workflowMode}`);
    if (detail.payload?.model) lines.push(`前端模型：${detail.payload.model}`);
    if (detail.payload?.imageSize || detail.payload?.aspectRatio) lines.push(`前端尺寸：${detail.payload.imageSize || "-"} / ${detail.payload.aspectRatio || "-"}`);
    if (detail.fileCount !== undefined) lines.push(`前端上传文件数：${detail.fileCount}`);
    if (detail.fileBytes !== undefined) lines.push(`前端上传文件大小：${readableBytes(detail.fileBytes)}`);
    if (detail.imageCount !== undefined) lines.push(`前端收到图片数：${detail.imageCount}`);
    if (detail.displayMs !== undefined) lines.push(`前端展示准备耗时：${readableMs(detail.displayMs)}`);
    if (detail.placement) lines.push(`前端展示位置：${detail.placement}`);
    if (detail.module) lines.push(`前端模块：${detail.module}`);
    if (detail.workflowMode) lines.push(`前端工作流：${detail.workflowMode}`);
    if (detail.sourceType) lines.push(`前端图片来源：${detail.sourceType}`);
    if (detail.message) lines.push(`前端信息：${compactLogMessage(detail.message, 260)}`);
    // 局部回贴尺寸对账单：底图（= 我给的图）/ 选框 / 贴回输出，
    // 用于核对"给多少尺寸 → 返回多少尺寸"，以及排查贴回偏移。
    const localPaste = detail.localPaste && typeof detail.localPaste === "object" ? detail.localPaste : null;
    if (localPaste) {
      if (detail.baseName) lines.push(`贴回底图：${compactLogMessage(detail.baseName, 120)}`);
      if (localPaste.base) lines.push(`贴回底图尺寸：${localPaste.base}`);
      if (localPaste.uploadCopy) lines.push(`上传副本尺寸：${localPaste.uploadCopy}`);
      if (localPaste.rect) lines.push(`选框尺寸：${localPaste.rect}${localPaste.rectAt ? ` @ (${localPaste.rectAt})` : ""}`);
      if (localPaste.output) lines.push(`贴回输出尺寸：${localPaste.output}`);
      if (localPaste.matches !== undefined) {
        lines.push(`尺寸一致性：${localPaste.matches ? "输出与底图同尺寸" : "输出与底图不一致（异常，请反馈）"}`);
      }
    }
  }

  const error = entry.error || entry.upstreamError || entry.message;
  if (error) lines.push(`错误/备注：${compactLogMessage(error, 360)}`);
  return lines;
}

async function appendTaskTextLog(entry) {
  const file = taskTextLogPath(entry);
  if (!file) return;
  const lines = taskLogLines(entry);
  if (lines.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  const exists = existsSync(file);
  const header = exists ? "" : [
    "============================================================",
    "静音AI绘画 - 单任务诊断日志",
    `任务ID：${safeTaskLogRequestId(entry)}`,
    `创建时间：${localDateTime(entry?.time ? Date.parse(entry.time) : Date.now())}`,
    "说明：本日志只记录阶段、耗时、数量、大小和错误摘要；不会记录 API Key、图片 base64 编码或完整图片数据。",
    "============================================================",
    ""
  ].join("\n");
  await appendFile(file, `${header}${lines.join("\n")}\n`, "utf8");
}

function isGenerationTraceEndpoint(pathname = "") {
  return [
    "/api/images",
    "/api/generate-outfit",
    "/api/videos/generations"
  ].includes(pathname);
}

function generationRequestTraceMiddleware(req, res, next) {
  let pathname = "";
  try {
    pathname = new URL(req.originalUrl || req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    pathname = String(req.path || req.url || "").split("?")[0];
  }
  if (req.method !== "POST" || !isGenerationTraceEndpoint(pathname)) {
    next();
    return;
  }

  const startedAt = Date.now();
  const requestId = String(req.headers["x-jingyin-client-request-id"] || `local_${startedAt}_${Math.random().toString(36).slice(2, 8)}`);
  localGenerationRequestStartedAt.set(requestId, startedAt);
  const contentLength = Number.parseInt(String(req.headers["content-length"] || "0"), 10) || 0;
  const baseLog = {
    requestId,
    endpoint: pathname,
    method: req.method,
    contentLength,
    contentType: compactLogMessage(req.headers["content-type"] || "", 180),
    userAgent: compactLogMessage(req.headers["user-agent"] || "", 180)
  };

  writeGenerationLog({
    time: new Date().toISOString(),
    ok: true,
    stage: "local-request-received",
    ...baseLog,
    imageConcurrency: {
      limit: IMAGE_CONCURRENCY_LIMIT,
      active: activeImageRequestCount,
      queued: imageRequestQueue.length
    }
  }).catch(() => {});

  let abortedLogged = false;
  req.on("aborted", () => {
    abortedLogged = true;
    writeGenerationLog({
      time: new Date().toISOString(),
      ok: false,
      stage: "local-request-aborted",
      ...baseLog,
      timingMs: Date.now() - startedAt
    }).catch(() => {});
  });

  res.on("finish", () => {
    writeGenerationLog({
      time: new Date().toISOString(),
      ok: res.statusCode < 400 && !abortedLogged,
      stage: "local-response-finished",
      ...baseLog,
      status: res.statusCode,
      timingMs: Date.now() - startedAt,
      imageConcurrency: {
        limit: IMAGE_CONCURRENCY_LIMIT,
        active: activeImageRequestCount,
        queued: imageRequestQueue.length
      }
    }).catch(() => {});
    localGenerationRequestStartedAt.delete(requestId);
  });

  next();
}

function billingChannelCandidates(baseUrls = [], params = {}) {
  return baseUrls.map((baseUrl, index) => {
    const channel = channelLogFields(baseUrl, index, baseUrls.length);
    return {
      channelId: channel.channelId,
      channelRole: channel.channelRole,
      channelAttempt: channel.channelAttempt,
      channelCandidateCount: channel.channelCandidateCount,
      model: upstreamModelForChannel(baseUrl, params.model),
      billingMode: "lightweight-gateway"
    };
  });
}

function billingAttemptSummaries(attempts = []) {
  return (Array.isArray(attempts) ? attempts : []).map((attempt) => ({
    channelId: attempt?.channelId || "unknown",
    channelRole: attempt?.channelRole || "unknown",
    status: attempt?.status || 0,
    ok: Boolean(attempt?.ok),
    model: attempt?.model || "",
    requestFormat: attempt?.requestFormat || "",
    errorCode: attempt?.errorCode || ""
  }));
}

async function prepareImageBillingForRequest({ requestId, apiKey, params, files, candidates, metadata }) {
  try {
    const billingTask = await prepareImageBillingTask({
      requestId,
      customerApiKey: apiKey,
      params,
      files,
      candidates: billingChannelCandidates(candidates, params),
      metadata
    });
    if (billingTask?.enabled) {
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: true,
        stage: "billing-gateway-prepare",
        billingGatewayTaskId: billingTask.gatewayTaskId,
        hasRouteToken: Boolean(billingTask.routeToken),
        signedRoute: Boolean(billingTask.signedRoute),
        metadata
      });
    }
    return { billingTask, errorPayload: null };
  } catch (error) {
    const errorPayload = publicBillingErrorPayload(error, requestId);
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: false,
      stage: "billing-gateway-prepare",
      status: errorPayload.status,
      error: errorPayload.error,
      message: errorPayload.message,
      metadata
    });
    return { billingTask: null, errorPayload };
  }
}

function finalizeBillingInBackground(billingTask, result = {}) {
  if (!billingTask?.enabled) return;
  const payload = {
    ...result,
    attempts: billingAttemptSummaries(result.attempts)
  };
  setTimeout(() => {
    finalizeBillingTask(billingTask, payload)
      .then((finalized) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId: billingTask.requestId,
        ok: true,
        stage: "billing-gateway-finalize",
        billingGatewayTaskId: billingTask.gatewayTaskId,
        status: finalized.status,
        resultOk: Boolean(payload.ok),
        outputCount: payload.outputCount || 0,
        timingMs: payload.timingMs || 0
      }))
      .catch((error) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId: billingTask.requestId,
        ok: false,
        stage: "billing-gateway-finalize",
        billingGatewayTaskId: billingTask.gatewayTaskId,
        resultOk: Boolean(payload.ok),
        error: error instanceof Error ? error.message : String(error)
      }));
  }, 0);
}

async function writeRuntimeFaultLog(entry) {
  const logDir = path.join(rootDir, "logs");
  const logFile = path.join(logDir, "runtime-errors.log");
  await mkdir(logDir, { recursive: true });
  await rotateLogFileIfNeeded(logFile, RUNTIME_LOG_MAX_BYTES);
  await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

async function writeAssetLog(entry) {
  const logDir = path.join(rootDir, "logs");
  const logFile = path.join(logDir, "asset-errors.jsonl");
  await mkdir(logDir, { recursive: true });
  await rotateLogFileIfNeeded(logFile, ASSET_LOG_MAX_BYTES);
  await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function processFaultMessage(error) {
  if (error instanceof Error) return error.stack || error.message;
  if (error && typeof error === "object" && "reason" in error) return processFaultMessage(error.reason);
  return String(error || "");
}

function logProcessFault(stage, error) {
  const message = processFaultMessage(error);
  console.error(`[${stage}]`, message);
  const entry = {
    time: new Date().toISOString(),
    ok: false,
    stage,
    error: message.slice(0, 4000)
  };
  writeRuntimeFaultLog(entry).catch(() => {});
  writeGenerationLog(entry).catch(() => {});
}

process.on("unhandledRejection", (reason) => {
  logProcessFault("process-unhandled-rejection", reason);
});

process.on("uncaughtException", (error) => {
  logProcessFault("process-uncaught-exception", error);
});

function requestIdFromMultipartPayload(req, prefix = "upload") {
  try {
    const parsed = req.body?.payload ? JSON.parse(req.body.payload) : null;
    return String(parsed?.taskId || parsed?.requestId || `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function outfitUploadErrorPayload(error) {
  const code = String(error?.code || "");
  if (code === "LIMIT_FILE_SIZE") {
    return {
      status: 413,
      error: "upload_too_large",
      message: `本地上传失败：单张图片超过 ${OUTFIT_UPLOAD_FILE_LIMIT_MB}MB，请缩小局部回贴框或先压缩图片后再生成`
    };
  }
  if (code === "LIMIT_FILE_COUNT") {
    return {
      status: 400,
      error: "upload_file_count",
      message: "本地上传失败：一次上传图片数量过多，请减少图1/图2/图3数量后重试"
    };
  }
  return {
    status: 400,
    error: code || "upload_failed",
    message: `本地上传失败：${error?.message || "图片接收失败"}`
  };
}

function wrapOutfitUpload(middleware) {
  return (req, res, next) => {
    middleware(req, res, async (error) => {
      if (!error) return next();
      await removeUploadedFiles(req.files).catch(() => {});
      const requestId = requestIdFromMultipartPayload(req, "outfit_upload");
      const publicPayload = outfitUploadErrorPayload(error);
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: false,
        status: publicPayload.status,
        stage: "receive-outfit-upload",
        failureReason: publicPayload.error,
        error: error?.message || String(error || ""),
        message: publicPayload.message
      }).catch(() => {});
      return res.status(publicPayload.status).json({
        ok: false,
        ...publicPayload,
        requestId
      });
    });
  };
}

function flattenUploadedFiles(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => Array.isArray(item) ? item : []);
}

async function removeUploadedFiles(value) {
  const files = flattenUploadedFiles(value);
  await Promise.all(files.map(async (file) => {
    if (!file?.path) return;
    try {
      await unlink(file.path);
    } catch {}
  }));
}

async function ensureFileBuffer(file) {
  if (!file || file.buffer?.length || !file.path) return file;
  file.buffer = await readFile(file.path);
  return file;
}

async function readJsonArray(file) {
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function historyImageUrl(filename) {
  return `/api/history-image/${encodeURIComponent(filename)}`;
}

function referenceAssetUrl(filename) {
  return `/api/reference-asset/${encodeURIComponent(filename)}`;
}

function historyImagePath(filename) {
  const safeName = path.basename(String(filename || ""));
  const resolved = path.resolve(historyImageDir, safeName);
  if (!resolved.startsWith(path.resolve(historyImageDir) + path.sep)) {
    throw new Error("历史图片路径无效");
  }
  return resolved;
}

function referenceAssetPath(filename) {
  const safeName = path.basename(String(filename || ""));
  const resolved = path.resolve(referenceAssetDir, safeName);
  if (!resolved.startsWith(path.resolve(referenceAssetDir) + path.sep)) {
    throw new Error("invalid_reference_asset_path");
  }
  return resolved;
}

function canvasAssetPath(filename) {
  const safeName = path.basename(String(filename || ""));
  const resolved = path.resolve(canvasAssetDir, safeName);
  if (!resolved.startsWith(path.resolve(canvasAssetDir) + path.sep)) {
    throw new Error("invalid_canvas_asset_path");
  }
  return resolved;
}

function normalizeReferenceAsset(item, index = 0) {
  if (!item || typeof item !== "object") return null;
  const archiveFile = item.archiveFile ? path.basename(String(item.archiveFile)) : "";
  const localUrl = archiveFile
    ? referenceAssetUrl(archiveFile)
    : String(item.localUrl || item.url || "");
  return {
    id: String(item.id || `ref_${index}`),
    name: String(item.name || item.originalName || `reference-${index + 1}`),
    role: String(item.role || "reference"),
    index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
    size: Number(item.size || 0),
    mimeType: String(item.mimeType || ""),
    ...(archiveFile ? { archiveFile } : {}),
    ...(localUrl ? { localUrl } : {}),
    // P1 缺图自愈：失效标记必须一起持久化。
    // 这里原来是字段白名单，不带上 missing 的话标记只存在于接口响应里，
    // 一写盘就被丢掉，前端下次读到的仍是"未标记"（这个 bug 被 history-integrity-check 抓出来）。
    ...(item.missing === true ? { missing: true } : {}),
    ...(item.missingReason ? { missingReason: String(item.missingReason) } : {})
  };
}

function normalizeHistoryItem(item) {
  if (!item || typeof item !== "object") return null;
  const image = item.image && typeof item.image === "object"
    ? {
        ...item.image,
        ...(item.image.archiveFile ? { localUrl: historyImageUrl(item.image.archiveFile) } : {})
      }
    : item.image;
  const references = Array.isArray(item.references)
    ? item.references.map(normalizeReferenceAsset).filter(Boolean)
    : [];
  return {
    ...item,
    image,
    ...(references.length > 0 ? { references, referenceCount: references.length } : {})
  };
}

/**
 * 判断一条历史记录指向的本地文件是否还在。
 *
 * 「不在」分两种，都会让结果卡片变成无法解释的空白（P1 缺图）：
 *   1. 有 archiveFile 但 data/history-images 下找不到 → archive_missing
 *   2. 只有 /api/history-image/... 或 /api/result/... 的 localUrl，同样找不到 → archive_missing
 * 只有确实是本地引用且文件不存在才算失效；纯远程地址不在这里判定（它可能仍然有效）。
 */
function historyItemIntegrity(item) {
  const image = item?.image || {};
  const archiveFile = String(image.archiveFile || "").trim();
  if (archiveFile) {
    const target = historyImagePath(archiveFile);
    return existsSync(target)
      ? { missing: false, reason: "" }
      : { missing: true, reason: "archive_missing" };
  }
  const localUrl = String(image.localUrl || "").trim();
  const localMatch = /^\/api\/(history-image|result)\/(.+)$/.exec(localUrl);
  if (localMatch) {
    const dir = localMatch[1] === "result" ? resultDir : historyImageDir;
    const name = decodeURIComponent(localMatch[2]);
    return existsSync(path.join(dir, path.basename(name)))
      ? { missing: false, reason: "" }
      : { missing: true, reason: "archive_missing" };
  }
  return { missing: false, reason: "" };
}

/** 参考图缩略图的完整性（归档文件是否还在）。 */
function referenceAssetIntegrity(reference) {
  const archiveFile = String(reference?.archiveFile || "").trim();
  if (!archiveFile) return { missing: false, reason: "" };
  const target = path.join(referenceAssetDir, path.basename(archiveFile));
  return existsSync(target)
    ? { missing: false, reason: "" }
    : { missing: true, reason: "reference_missing" };
}

/** 给单条记录里的参考图补/清 missing 标记；返回是否发生变化。 */
function annotateReferences(references) {
  const list = Array.isArray(references) ? references : [];
  let changed = false;
  const next = list.map((reference) => {
    if (!reference || typeof reference !== "object") return reference;
    const integrity = referenceAssetIntegrity(reference);
    if (integrity.missing) {
      if (reference.missing && reference.missingReason === integrity.reason) return reference;
      changed = true;
      return { ...reference, missing: true, missingReason: integrity.reason };
    }
    if (reference.missing || reference.missingReason) {
      changed = true;
      const { missing: _m, missingReason: _r, ...rest } = reference;
      return rest;
    }
    return reference;
  });
  return { references: next, changed };
}

/**
 * 给历史记录补上完整性标记（**只加字段，绝不删除条目**）。
 * 幂等：已经标记过且结论一致的条目不会产生 diff，因此不会反复写盘。
 *
 * 同时处理两类失效引用：
 *   1. 结果图归档文件丢失（image.missing / archive_missing）
 *   2. 参考图缩略图归档丢失（references[].missing / reference_missing）
 */
function annotateHistoryIntegrity(items) {
  const list = Array.isArray(items) ? items : [];
  const missingIds = [];
  let changed = false;
  const next = list.map((item) => {
    if (!item || typeof item !== "object") return item;
    const integrity = historyItemIntegrity(item);
    const image = item.image && typeof item.image === "object" ? item.image : null;
    const references = annotateReferences(item.references);
    let nextItem = item;

    if (references.changed) {
      changed = true;
      nextItem = { ...nextItem, references: references.references };
    }

    if (!image) return nextItem;

    const wasMissing = Boolean(image.missing);
    const wasReason = String(image.missingReason || "");
    if (integrity.missing) {
      // 统计必须在幂等判断之前：否则第二次读取时 missingIds 会是空的，
      // 摘要归零、repair 也会找不到失效条目（这个 bug 是被 history-repair-check 抓出来的）。
      missingIds.push(item.id);
      if (wasMissing && wasReason === integrity.reason) return nextItem; // 已标记且结论一致 → 不写盘
      changed = true;
      return {
        ...nextItem,
        image: { ...image, missing: true, missingReason: integrity.reason, missingCheckedAt: Date.now() }
      };
    }
    // 文件回来了（用户手动恢复归档）→ 把旧标记清掉，让卡片恢复正常
    if (wasMissing || wasReason) {
      changed = true;
      const { missing: _m, missingReason: _r, missingCheckedAt: _c, ...restImage } = image;
      return { ...nextItem, image: restImage };
    }
    return nextItem;
  });
  return { items: next, changed, missingIds };
}

/**
 * 首次修复前留一份专用备份，保证"改用户数据"这件事是可回退的。
 * 只在备份不存在时创建一次，不覆盖。
 */
async function ensureHistoryRepairBackup() {
  const backupPath = path.join(dataDir, "history.pre-repair-backup.json");
  try {
    if (existsSync(backupPath)) return path.basename(backupPath);
    if (!existsSync(historyFile)) return "";
    await copyFile(historyFile, backupPath);
    return path.basename(backupPath);
  } catch {
    return "";
  }
}

async function recoverHistoryFromImageFiles() {
  try {
    const entries = await readdir(historyImageDir, { withFileTypes: true });
    const imageEntries = entries.filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name));
    const recovered = await Promise.all(imageEntries.map(async (entry, index) => {
      const file = historyImagePath(entry.name);
      const info = await stat(file);
      return {
        id: `recovered_${info.mtimeMs}_${index}`,
        image: {
          type: "url",
          value: historyImageUrl(entry.name),
          archiveFile: entry.name,
          localUrl: historyImageUrl(entry.name)
        },
        prompt: "",
        modelLabel: "历史图片",
        imageSize: "",
        aspectRatio: "",
        referenceCount: 0,
        generationMs: null,
        recovered: true,
        createdAt: info.mtimeMs
      };
    }));
    return recovered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

async function readHistoryResults() {
  const primary = (await readJsonArray(historyFile)).map(normalizeHistoryItem).filter(Boolean);
  if (primary.length > 0) return primary;

  const backup = (await readJsonArray(historyBackupFile)).map(normalizeHistoryItem).filter(Boolean);
  if (backup.length > 0) {
    await writeHistoryResults(backup);
    return backup;
  }

  const recovered = await recoverHistoryFromImageFiles();
  if (recovered.length > 0) {
    await writeHistoryResults(recovered);
  }
  return recovered;
}

async function writeHistoryResults(results, options = {}) {
  const normalized = (Array.isArray(results) ? results : []).map(normalizeHistoryItem).filter(Boolean);
  await mkdir(dataDir, { recursive: true });
  await writeFile(historyFile, JSON.stringify(normalized, null, 2), "utf8");
  if (normalized.length > 0 || options.replaceBackup) {
    await writeFile(historyBackupFile, JSON.stringify(normalized, null, 2), "utf8");
  }
}

function mergeHistoryItem(existing, incoming) {
  if (!existing) return normalizeHistoryItem(incoming);
  const next = normalizeHistoryItem({ ...existing, ...incoming });
  if (existing.image?.archiveFile && incoming?.image && !incoming.image.archiveFile) {
    next.image = {
      ...incoming.image,
      archiveFile: existing.image.archiveFile,
      archiveMime: existing.image.archiveMime,
      localUrl: historyImageUrl(existing.image.archiveFile)
    };
  }
  if (Array.isArray(existing.references) && existing.references.length > 0 && !Array.isArray(incoming?.references)) {
    next.references = existing.references;
    next.referenceCount = existing.references.length;
  }
  return next;
}

async function archiveHistoryItemImageFromBuffer(item, buffer, mimeType, sourceUrl = "") {
  const normalized = normalizeHistoryItem(item);
  const ext = imageExtensionFromType(mimeType, sourceUrl);
  const baseName = sanitizeFilePart(normalized?.id || `history_${Date.now()}`) || `history_${Date.now()}`;
  await mkdir(historyImageDir, { recursive: true });
  const target = await uniqueFilePath(historyImageDir, `${baseName}.${ext}`);
  await writeFile(target, buffer, { flag: "wx" });
  const archiveFile = path.basename(target);
  const localUrl = historyImageUrl(archiveFile);
  return normalizeHistoryItem({
    ...normalized,
    image: {
      type: "url",
      value: localUrl,
      archiveFile,
      archiveMime: mimeType || mimeTypeFromFile(archiveFile),
      localUrl,
      ...(sourceUrl ? { sourceUrl } : {})
    }
  });
}

async function archiveIncomingHistoryItem(item, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  const normalized = normalizeHistoryItem(item);
  if (!normalized?.image || normalized.image.archiveFile || String(normalized.image.localUrl || "").startsWith("/api/history-image/")) {
    return normalized;
  }

  try {
    const { buffer, mimeType, sourceUrl } = await imageBufferFromPayload(normalized.image, timeoutMs);
    return archiveHistoryItemImageFromBuffer(normalized, buffer, mimeType, sourceUrl);
  } catch (error) {
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId: normalized.id || "history",
      ok: false,
      stage: "archive-history-image",
      error: error instanceof Error ? error.message : String(error)
    });
    return normalized;
  }
}

async function appendHistoryResults(items) {
  const rawIncoming = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  const incoming = [];
  for (const item of rawIncoming) {
    const archived = await archiveIncomingHistoryItem(item);
    if (archived) incoming.push(archived);
  }
  if (incoming.length === 0) return [];
  const current = await readHistoryResults();
  const byId = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => {
    byId.set(item.id, mergeHistoryItem(byId.get(item.id), item));
  });
  const results = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  await writeHistoryResults(results);
  return results;
}

function defaultSaveDirectory() {
  return process.env.SAVE_DIRECTORY || path.join(rootDir, "data", "asset-library");
}

function hasDamagedPathText(value) {
  return /[\uFFFD]|闈欓煶|缁樼敾|����|\?\?\?/.test(String(value || ""));
}

async function isExistingDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function normalizeUsableSaveDirectory(directory) {
  const fallback = path.resolve(defaultSaveDirectory());
  const raw = String(directory || "").trim();
  if (!raw || hasDamagedPathText(raw)) return fallback;

  const resolved = path.resolve(raw);
  if (await isExistingDirectory(resolved)) return resolved;

  return fallback;
}

async function readAppSettings() {
  try {
    const text = await readFile(appSettingsFile, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAppSettings(nextSettings) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(appSettingsFile, JSON.stringify(nextSettings, null, 2), "utf8");
}

async function getSaveDirectory() {
  const settings = await readAppSettings();
  const directory = await normalizeUsableSaveDirectory(settings.saveDirectory);
  await mkdir(directory, { recursive: true });
  if (settings.saveDirectory !== directory) {
    await writeAppSettings({ ...settings, saveDirectory: directory });
  }
  return directory;
}

async function setSaveDirectory(directory) {
  const resolved = await normalizeUsableSaveDirectory(directory);
  await mkdir(resolved, { recursive: true });
  const current = await readAppSettings();
  await writeAppSettings({ ...current, saveDirectory: resolved });
  return resolved;
}

function sanitizeFilePart(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return cleaned || "jingyin";
}

function imageExtensionFromType(mimeType, fallbackUrl = "") {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("jpeg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  let pathname = String(fallbackUrl || "image.png");
  try {
    pathname = new URL(fallbackUrl || "https://local/image.png", "https://local").pathname;
  } catch {
    pathname = String(fallbackUrl || "image.png");
  }
  const ext = path.extname(pathname).replace(".", "").toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? (ext === "jpeg" ? "jpg" : ext) : "png";
}

function mimeTypeFromFile(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function parseReferenceMeta(rawValue) {
  try {
    const parsed = JSON.parse(String(rawValue || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function archiveReferenceAssets(files, rawMeta, requestId) {
  const incoming = Array.isArray(files) ? files.filter((file) => file?.buffer?.length || file?.path) : [];
  if (incoming.length === 0) return [];
  const metadata = parseReferenceMeta(rawMeta);
  const createdAt = Date.now();

  await mkdir(referenceAssetDir, { recursive: true });
  return Promise.all(incoming.map(async (file, index) => {
    const meta = metadata[index] && typeof metadata[index] === "object" ? metadata[index] : {};
    const ext = imageExtensionFromType(file.mimetype, file.originalname);
    const baseName = sanitizeFilePart(`${requestId}_ref_${index + 1}_${meta.name || file.originalname || "reference"}`);
    const target = await uniqueFilePath(referenceAssetDir, `${baseName}.${ext}`);
    if (file.path) {
      await copyFile(file.path, target);
    } else {
      await writeFile(target, file.buffer);
    }
    const archiveFile = path.basename(target);
    return {
      id: `${requestId}_ref_${index + 1}`,
      name: String(meta.name || file.originalname || `reference-${index + 1}.${ext}`),
      role: String(meta.role || "reference"),
      index: Number.isFinite(Number(meta.index)) ? Number(meta.index) : index,
      size: Number(meta.size || file.size || 0),
      mimeType: String(meta.type || file.mimetype || mimeTypeFromFile(`reference.${ext}`)),
      archiveFile,
      localUrl: referenceAssetUrl(archiveFile),
      ...(meta.localEdit ? { localEdit: true } : {}),
      createdAt: createdAt + index
    };
  }));
}

function modelLabel(model) {
  return CHANNEL_MODELS.find((item) => item.value === model)?.label || model || "图片";
}

function buildHistoryItems(images, params, files, requestId, timing, createdAt, references = []) {
  const normalizedReferences = Array.isArray(references)
    ? references.map(normalizeReferenceAsset).filter(Boolean)
    : [];
  return images.map((image, index) => ({
    id: `${requestId}_${index + 1}`,
    requestId,
    image,
    prompt: params.prompt,
    modelLabel: modelLabel(params.model),
    imageSize: params.imageSize,
    aspectRatio: params.aspectRatio,
    referenceCount: normalizedReferences.length || files.length,
    ...(normalizedReferences.length > 0 ? { references: normalizedReferences } : {}),
    generationMs: timing.totalMs,
    source: params.source,
    createdAt: createdAt + index
  }));
}

async function imageBufferFromPayload(image, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  if (!image || typeof image !== "object") {
    throw new Error("图片数据无效");
  }

  if (image.archiveFile) {
    const file = historyImagePath(image.archiveFile);
    return {
      buffer: await readFile(file),
      mimeType: image.archiveMime || mimeTypeFromFile(image.archiveFile),
      sourceUrl: image.localUrl || historyImageUrl(image.archiveFile)
    };
  }

  const localUrl = String(image.localUrl || image.value || "");
  const proxiedRemoteUrl = String(image.proxySourceUrl || remoteUrlFromImageProxyPath(localUrl) || "").trim();
  if (/^https?:\/\//i.test(proxiedRemoteUrl)) {
    return downloadExternalImageWithFallback(proxiedRemoteUrl, timeoutMs);
  }

  if (localUrl.startsWith("/api/history-image/")) {
    const filename = decodeURIComponent(localUrl.split("/").pop() || "");
    const file = historyImagePath(filename);
    return {
      buffer: await readFile(file),
      mimeType: mimeTypeFromFile(filename),
      sourceUrl: localUrl
    };
  }

  if (localUrl.startsWith("/api/canvas-asset/")) {
    const filename = decodeURIComponent(localUrl.split("/").pop() || "");
    const file = canvasAssetPath(filename);
    return {
      buffer: await readFile(file),
      mimeType: mimeTypeFromFile(filename),
      sourceUrl: localUrl
    };
  }

  if (localUrl.startsWith("/api/result/")) {
    const filename = path.basename(decodeURIComponent(localUrl.split("/").pop() || ""));
    const file = path.join(resultDir, filename);
    if (!file.startsWith(path.resolve(resultDir) + path.sep)) {
      throw new Error("本地换装结果路径无效");
    }
    return {
      buffer: await readFile(file),
      mimeType: mimeTypeFromFile(filename),
      sourceUrl: localUrl
    };
  }

  if (image.type === "b64_json") {
    const value = String(image.value || "");
    const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(value);
    const raw = dataUrlMatch ? dataUrlMatch[2] : value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (!raw) throw new Error("图片 base64 为空");
    return {
      buffer: Buffer.from(raw, "base64"),
      mimeType: image.mimeType || image.archiveMime || dataUrlMatch?.[1] || "image/png",
      sourceUrl: ""
    };
  }

  if (image.type === "url" && image.value) {
    return downloadExternalImageWithFallback(image.value, timeoutMs);
  }

  throw new Error("不支持的图片类型");
}

async function itemWithArchivedImage(item) {
  if (!item?.id || item.image?.archiveFile || String(item.image?.localUrl || "").startsWith("/api/history-image/")) {
    return item;
  }
  const historyItems = await readHistoryResults();
  const match = historyItems.find((historyItem) => historyItem.id === item.id);
  if (!match?.image?.archiveFile && !String(match?.image?.localUrl || "").startsWith("/api/history-image/")) {
    return item;
  }
  return {
    ...item,
    image: match.image
  };
}

function autoSaveModuleFolder(source) {
  if (source === "detail-main") return "一键详情主图";
  if (source === "reference-remix") return "参考生图";
  if (source === "infinite-canvas") return "无限画布";
  return "";
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function uniqueFilePath(directory, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(directory, filename);
  let index = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${base}_${index}${ext}`);
    index += 1;
  }
  return candidate;
}

async function withSaveFilenameLock(task) {
  const previous = saveFilenameLock;
  let releaseLock = () => {};
  saveFilenameLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    releaseLock();
  }
}

function currentDailyImagePrefix() {
  return String(new Date().getDate());
}

async function highestDailyImageIndex(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let highest = 0;
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.[^.]+$`, "i");
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return highest;
}

async function writeJingyinNumberedImage(directory, buffer, extension) {
  const ext = sanitizeFilePart(extension || "png").replace(/^_+/, "").toLowerCase() || "png";
  await mkdir(directory, { recursive: true });
  return withSaveFilenameLock(async () => {
    const prefix = currentDailyImagePrefix();
    const start = await highestDailyImageIndex(directory, prefix) + 1;
    for (let index = start; index < start + 100000; index += 1) {
      const filename = `${prefix}-${index}.${ext}`;
      const target = path.join(directory, filename);
      try {
        await writeFile(target, buffer, { flag: "wx" });
        return { filename, target };
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("当天图片文件序号已超过可用范围");
  });
}

function sanitizeSubfolderName(value) {
  const cleaned = String(value || "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  return cleaned || "裁剪";
}

async function writeProcessedImage(directory, buffer, extension, subfolder = "裁剪") {
  const outputFolder = String(subfolder ?? "").trim()
    ? path.join(directory, sanitizeSubfolderName(subfolder))
    : directory;
  await mkdir(outputFolder, { recursive: true });
  return writeJingyinNumberedImage(outputFolder, buffer, extension);
}

async function persistGeneratedItems(items) {
  const incoming = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  if (incoming.length === 0) return { items: [], autoSavedCount: 0 };

  const saveRoot = await getSaveDirectory();
  const persistedItems = [];
  let autoSavedCount = 0;

  for (const item of incoming) {
    let nextItem = item;
    let buffer = null;
    let mimeType = "";
    let sourceUrl = "";

    try {
      const payload = await imageBufferFromPayload(item.image);
      buffer = payload.buffer;
      mimeType = payload.mimeType;
      sourceUrl = payload.sourceUrl;
    } catch (error) {
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId: item.id,
        ok: false,
        stage: "prepare-generated-image",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (buffer) {
      try {
        const moduleFolder = autoSaveModuleFolder(item.source);
        const targetDirectory = moduleFolder ? path.join(saveRoot, moduleFolder) : saveRoot;
        await mkdir(targetDirectory, { recursive: true });
        await writeJingyinNumberedImage(
          targetDirectory,
          buffer,
          imageExtensionFromType(mimeType, sourceUrl)
        );
        autoSavedCount += 1;
      } catch (error) {
        await writeGenerationLog({
          time: new Date().toISOString(),
          requestId: item.id,
          ok: false,
          stage: "auto-save-generated-image",
          error: error instanceof Error ? error.message : String(error)
        });
      }

      try {
        nextItem = item.image?.archiveFile || String(item.image?.localUrl || "").startsWith("/api/history-image/")
          ? item
          : await archiveHistoryItemImageFromBuffer(item, buffer, mimeType, sourceUrl);
      } catch (error) {
        await writeGenerationLog({
          time: new Date().toISOString(),
          requestId: item.id,
          ok: false,
          stage: "cache-generated-image",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    persistedItems.push(nextItem);
  }

  await appendHistoryResults(persistedItems);
  return { items: persistedItems, autoSavedCount };
}

function persistGeneratedItemsInBackground(items, requestId, stage = "background-persist-generated-items") {
  const incoming = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  if (incoming.length === 0) return;

  setTimeout(() => {
    persistGeneratedItems(incoming)
      .then((result) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: true,
        stage,
        itemCount: incoming.length,
        autoSavedCount: result.autoSavedCount
      }))
      .catch((error) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: false,
        stage,
        itemCount: incoming.length,
        error: error instanceof Error ? error.message : String(error)
      }));
  }, 0);
}

async function openDirectory(directory) {
  const resolved = await setSaveDirectory(directory || await getSaveDirectory());
  const child = spawn("explorer.exe", [resolved], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return resolved;
}

async function pickDirectory(initialDirectory) {
  const normalizedInitialDirectory = await normalizeUsableSaveDirectory(initialDirectory);
  await mkdir(normalizedInitialDirectory, { recursive: true });
  return new Promise((resolve, reject) => {
    const script = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "Add-Type -AssemblyName System.Drawing | Out-Null",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.Text = 'Jingyin Directory Picker'",
      "$owner.ShowInTaskbar = $false",
      "$owner.StartPosition = 'Manual'",
      "$owner.Size = New-Object System.Drawing.Size(1, 1)",
      "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
      "$owner.TopMost = $true",
      "$owner.Opacity = 0",
      "$null = $owner.Show()",
      "$owner.Activate()",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select save directory'",
      "$dialog.ShowNewFolderButton = $true",
      "$dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer",
      "$initial = $env:JY_PICK_INITIAL",
      "if ($initial -and (Test-Path -LiteralPath $initial)) { $dialog.SelectedPath = $initial }",
      "try { $result = $dialog.ShowDialog($owner); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath } } finally { $owner.Close(); $owner.Dispose(); $dialog.Dispose() }"
    ].join("; ");

    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], {
      env: { ...process.env, JY_PICK_INITIAL: normalizedInitialDirectory },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `目录选择器退出 ${code}`));
        return;
      }
      const directory = stdout.trim();
      resolve(directory ? path.resolve(directory) : "");
    });
  });
}

function clampDetailPromptCount(value) {
  return Math.max(1, Math.min(12, Number.parseInt(value, 10) || 8));
}

function clampModelUsage(value) {
  return Math.max(1, Math.min(12, Number.parseInt(value, 10) || 4));
}

function clampReverseScreens(value) {
  return Math.max(0, Math.min(4, Number.parseInt(value, 10) || 0));
}

function buildDetailPromptGroup(input) {
  const count = clampDetailPromptCount(input.count);
  const lang = String(input.lang || "中文").trim() || "中文";
  const productName = String(input.productName || "").trim() || "目标产品";
  const ratio = String(input.ratio || "21:9").trim();
  const imageSize = String(input.imageSize || "2K").trim();
  const model = String(input.model || "gpt-image").trim();
  const workflow = String(input.workflow || "taobao-detail").trim();
  const pageType = workflow.includes("main") ? "主图" : "详情页";
  const platform = workflow.includes("amazon") ? "亚马逊" : "淘宝";
  const productFeature = String(input.productFeature || input.features || "").trim();
  const userInstruction = String(input.userInstruction || "").trim();
  const sellingPoints = String(input.sellingPoints || "").trim();
  const rawCopywriting = String(input.copywriting || "need");
  const copywriting = rawCopywriting === "none" ? "poster" : rawCopywriting === "light" ? "blank" : rawCopywriting;
  const richness = String(input.richness || "simple");
  const fontStyle = String(input.fontStyle || "auto");
  const modelMode = String(input.modelMode || "no-model");
  const modelPose = String(input.modelPose || "regular");
  const modelUsage = clampModelUsage(input.modelUsage);
  const reverseScreens = clampReverseScreens(input.reverseScreens);
  const productImages = Array.isArray(input.productImages) ? input.productImages : [];
  const referenceImages = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const createdAt = Date.now();
  const sellingList = sellingPoints
    .split(/\r?\n|[；;]/)
    .map((item) => item.replace(/^第?\d+[屏、.：:\s-]*/, "").trim())
    .filter(Boolean);

  const sceneTemplates = [
    ["主视觉开场", "完整展示产品与核心气质，建立整套页面的颜色、光线、材质与版式基准。"],
    ["核心卖点", "围绕最重要卖点做强对比构图，产品占画面中心，文字区留白清晰。"],
    ["材质细节", "拉近展示面料、纹理、边缘、扣子、袖口、拉链或工艺细节，避免改动产品结构。"],
    ["版型结构", "展示穿着/摆放后的比例、轮廓和适用身形，保持产品真实尺度。"],
    ["场景氛围", "切换到生活化或高级商业场景，但延续首屏的光线、色彩和字体系统。"],
    ["功能体验", "表现使用方式、舒适度、便捷性或搭配效果，不增加不存在的功能部件。"],
    ["信任背书", "用简洁图标感版式展示品质、细节、售后、包装或工艺可信点。"],
    ["收尾转化", "回到完整产品，形成干净的购买引导/品牌收束画面。"],
    ["补充卖点", "用同一视觉体系补充新的卖点，避免与前面屏幕重复。"],
    ["细节延展", "围绕产品局部做第二组特写，强化真实材质和工艺一致性。"],
    ["对比说明", "通过左右或上下分区说明使用前后/搭配前后，文案少而准确。"],
    ["长图衔接", "作为详情长图的过渡屏，承接上一屏并自然进入下一屏。"]
  ];

  const copyText = copywriting === "poster"
    ? "无文案纯海报：画面中不要生成任何文字、标题、卖点、标签、图标说明或促销信息，只保留产品、模特和场景氛围。"
    : copywriting === "blank"
      ? "文案留白：画面需要预留干净文字排版区域，但只生成极少量短标题或不直接生成文字，留白不能遮挡产品。"
      : "需要生成清晰可读的电商文案，标题、卖点和辅助说明层级分明。";
  const richText = richness === "rich"
    ? "画面可以更丰富，有道具、场景层次和信息分区，但不能干扰产品。"
    : richness === "balanced"
      ? "画面丰富度适中，保留呼吸感和清晰产品焦点。"
      : "画面简洁高级，背景干净，主体和文字信息优先。";
  const fontText = fontStyle === "modern"
    ? "字体风格偏现代杂志感，清爽、有留白。"
    : fontStyle === "soft"
      ? "字体风格偏柔和女性化，圆润、轻盈、亲和。"
      : fontStyle === "heiti"
        ? "字体风格使用常用黑体体系，字重清晰、横竖稳定、排版规整，适合电商详情页阅读。"
        : fontStyle === "bold"
          ? "字体风格偏醒目电商标题，粗细对比明确但不廉价。"
          : "字体风格根据参考图自动匹配，整套统一。";
  const modelText = modelMode === "use-model"
    ? `模特设置：使用模特。全组最多 ${Math.min(modelUsage, count)} 屏出现模特，其余屏以产品静物、局部细节或场景陈列为主；模特必须服务产品展示，不能改变产品结构。`
    : "模特设置：无模特。所有屏幕禁止出现真人、虚拟人、人体局部、手持穿着或模特影子，使用产品静物、挂拍、平铺、局部特写和场景陈列。";
  const poseText = modelMode === "use-model"
    ? modelPose === "special"
      ? "模特姿势：特殊姿态。允许广角镜头、极端透视、动态模特、视觉主体极端贴近镜头，但必须保持产品真实结构、面料比例和关键细节不畸变，不出现夸张肢体或错误手脚。"
      : "模特姿势：常规姿态。使用自然站姿、坐姿、行走或轻微互动动作，镜头透视正常，产品展示清楚。"
    : "模特姿势：已选择无模特，因此不生成任何模特姿态。";
  const reverseText = reverseScreens > 0
    ? `反转屏设置：在全组插入 ${Math.min(reverseScreens, count)} 屏反转/痛点对比画面，用同一视觉系统表现“问题场景 → 本产品解决”，禁止变成廉价促销或贬低竞品。`
    : "反转屏设置：不插入反转屏，全组按常规详情页节奏推进。";

  const globalLock = [
    `目标平台：${platform}${pageType}，输出语言：${lang}，比例：${ratio}，分辨率：${imageSize}。`,
    `目标产品只来自产品图：${productName}。参考图仅用于风格、配色、版式、字体和氛围，不允许混入参考图中的产品、logo、人物身份或品牌信息。`,
    productFeature ? `产品一致性锁定：${productFeature}` : "产品一致性锁定：保持产品颜色、结构、面料、五金、袖口、领口、版型、logo/文字和比例，不凭空增删部件。",
    `${copyText}${richText}${fontText}`,
    `${modelText}${poseText}${reverseText}`,
    userInstruction ? `用户额外要求：${userInstruction}` : "用户额外要求：无。"
  ].join("\n");

  const rounds = [
    {
      stage: "生成前",
      title: "产品身份锁定",
      content: "先只识别产品图里的目标产品，确认颜色、结构、材质、关键文字/logo、模特穿着关系；参考图只读风格，不读产品。"
    },
    {
      stage: "提示词生成时",
      title: "全局视觉锚点",
      content: "为所有屏幕统一光线方向、背景层级、色彩比例、字体系统、留白尺度和产品占比，后续每屏必须继承。"
    },
    {
      stage: "每屏提交前",
      title: "单屏任务介入",
      content: "每一屏只变化场景和卖点表达，不变化产品本体；上一屏的风格锚点会重复注入，减少详情页拼接割裂。"
    },
    {
      stage: "出图后",
      title: "一致性复查",
      content: "检查产品结构、模特身份、色彩、文字层级和画面边缘，发现跑偏时用该屏提示词重刷或裂变。"
    }
  ];

  const modelScreens = new Set();
  if (modelMode === "use-model") {
    const allowed = Math.min(modelUsage, count);
    for (let index = 0; index < allowed; index += 1) {
      modelScreens.add(index);
    }
  }

  const reverseScreenIndexes = new Set();
  if (reverseScreens > 0 && count > 0) {
    const interval = Math.max(1, Math.floor(count / Math.min(reverseScreens, count)));
    for (let index = 0; index < Math.min(reverseScreens, count); index += 1) {
      reverseScreenIndexes.add(Math.min(count - 1, 1 + index * interval));
    }
  }

  const prompts = Array.from({ length: count }, (_, index) => {
    const reverseScreen = reverseScreenIndexes.has(index);
    const baseTemplate = sceneTemplates[index] || sceneTemplates[sceneTemplates.length - 1];
    const template = reverseScreen
      ? ["反转痛点", "用同一套视觉语言呈现用户常见困扰或普通穿搭/普通展示的不足，再自然过渡到目标产品解决方案，产品仍然是唯一主角。"]
      : baseTemplate;
    const screen = index + 1;
    const selling = sellingList[index] || sellingList[index % Math.max(1, sellingList.length)] || template[1];
    const useModelOnScreen = modelScreens.has(index);
    const screenModelText = modelMode === "use-model"
      ? useModelOnScreen
        ? modelPose === "special"
          ? "本屏使用模特，并采用广角/低机位/近镜头动态姿态；产品可极近镜头形成冲击力，但产品结构、袖口、扣子、面料和版型必须真实。"
          : "本屏使用模特，采用自然常规姿态，优先清楚展示产品穿着效果、比例和版型。"
        : "本屏不使用模特，使用产品静物、局部细节、挂拍、平铺或场景陈列，避免突然出现人物。"
      : "本屏无模特，禁止出现真人、人体局部、手持穿着或模特影子。";
    const screenCopyText = copywriting === "poster"
      ? "本屏禁止生成任何文字，避免错字乱码。"
      : copywriting === "blank"
        ? "本屏需要保留可后期排版的干净留白区，文字极少或不出字。"
        : `本屏文案围绕：${selling}`;
    const reverseInstruction = reverseScreen
      ? "【反转屏介入】本屏是反转屏：先呈现常见痛点/普通效果，再用目标产品形成高级解决感；不能换产品、不能出现贬低竞品文字。"
      : "";
    const text = [
      `第${screen}屏：${template[0]}。`,
      "【输入图引用】产品图为唯一目标产品来源；参考图只作为设计风格参考。",
      `【全局一致性锁定】${globalLock}`,
      `【本屏目标】${template[1]}`,
      `【模特与镜头】${screenModelText}`,
      `【文案策略】${screenCopyText}`,
      reverseInstruction,
      "【构图与光线】主体清晰、边缘干净、四周柔光、低反差、无生硬黑影；画面可直接作为电商长图单屏。",
      "【衔接要求】与上一屏/下一屏保持相同色彩体系、文字层级、边距、背景材质和产品比例，不要突然换风格。",
      "【负面约束】不要出现错误产品、参考图产品、错字乱码、多余肢体、畸形手、破碎拼贴、低清晰度、过曝、廉价促销感。"
    ].filter(Boolean).join("\n");
    return {
      screen,
      title: template[0],
      summary: selling,
      intervention: reverseScreen ? "反转屏介入" : index === 0 ? "建立全局风格" : index === count - 1 ? "收束并检查拼接" : "继承风格并变化卖点",
      useModel: useModelOnScreen,
      reverseScreen,
      text,
      enabled: true,
      status: "pending",
      generationMs: null,
      results: []
    };
  });

  return {
    id: `detail_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    label: `${new Date(createdAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} | ${productName}`,
    createdAt,
    status: "confirming",
    params: {
      workflow,
      platform,
      pageType,
      model,
      ratio,
      imageSize,
      count,
      lang,
      copywriting,
      richness,
      fontStyle,
      modelMode,
      modelPose,
      modelUsage,
      reverseScreens,
      productName,
      productFeature,
      userInstruction,
      sellingPoints,
      productImageNames: productImages.map((item) => item.name).filter(Boolean),
      referenceImageNames: referenceImages.map((item) => item.name).filter(Boolean)
    },
    rounds,
    prompts
  };
}

function resolveApiKey(requestKey) {
  return normalizeApiKeyInput(requestKey);
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

async function readTextSafely(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function upstreamErrorMessage(parsed, status) {
  const json = parsed?.json;
  const candidates = [
    json?.error?.message,
    json?.message,
    json?.error_description,
    json?.error?.code,
    parsed?.text
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return candidates[0] || `HTTP ${status}`;
}

function compactLogMessage(value, limit = 700) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function sanitizeClientDiagnosticValue(key, value, depth = 0) {
  const field = String(key || "").toLowerCase();
  if (field.includes("apikey") || field.includes("api_key") || field.includes("authorization") || field.includes("token") || field === "key") {
    return "[hidden]";
  }
  if (field === "prompt" || field.endsWith("prompt") || field.includes("prompttext")) {
    return "[hidden]";
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return compactLogMessage(value, 300);
  if (depth >= 4) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item, index) => sanitizeClientDiagnosticValue(`${key}.${index}`, item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeClientDiagnosticValue(entryKey, entryValue, depth + 1)
    ]));
  }
  return compactLogMessage(String(value), 300);
}

function clientDiagnosticStage(value) {
  const stage = String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
  return stage.startsWith("client-") ? stage : "client-event";
}

function imagePromptLogFields(params = {}, payload = {}) {
  const prompt = String(params.prompt || "");
  const userPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  return {
    promptChars: prompt.length,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    userPromptChars: userPrompt.length,
    productNoteChars: productNote.length
  };
}

function isImageRouteNotFoundError(status, message) {
  const numericStatus = Number(status) || 0;
  if (numericStatus !== 404) return false;
  return /openai_error|bad_response_status_code|not[_\s-]*found|route|endpoint|model|unsupported|模型.*不可用|模型.*不存在|无可用渠道/i.test(String(message || ""));
}

/**
 * 2026-09-26：中转站按请求体里的 channelId 做手动选线时，如果这条线路在中转站适配器里
 * **根本没有登记**（例如客户端目录刚加了新线路、中转站还没加），中转站会返回 HTTP 400 +
 * `manual_channel_not_found`。
 *
 * 这类失败不是"等待超时"，也不是网络问题：换请求变体、换上游地址、重试都不会成功，
 * 唯一解是中转站把这条线路补上。所以必须单独识别，原样告诉用户"线路没接通"，
 * 不能被 shouldTryNextChannel 的 400 分支吞掉，最后包装成 504「生成超时，请重新生成。」
 * （真实事故：2026-09-26 15:58:56 批量换装选 banana-2 的 Origin 线路，上游 2.36 秒就返回
 *   `manual_channel_not_found`，界面却显示"生成超时"，用户会一直白等/重试。）
 */
function isImageManualChannelNotFoundError(message) {
  return /manual[_\s-]*channel[_\s-]*(not[_\s-]*found|missing|unknown|invalid)|channel[_\s-]*not[_\s-]*found|线路[^，。；]{0,16}(不存在|未开通|未接入|未配置|不可用)/i.test(String(message || ""));
}

/**
 * 2026-09-26：有些线路在中转站里声明了「只允许手动选线」（strictManualDispatch）。
 * 客户端带了这条线路的 channelId 但 dispatchMode 不是 manual 时，中转站会直接返回
 * 400 `manual_dispatch_required`——因为不拒绝的话适配器会**把这条线路从自动候选里剔除、
 * 静默改走同模型的其它线路**，用户以为选的是这条线路，实际扣的是别的线路的钱。
 * 这种失败换线路变体/换上游地址都不会成功，重试也没意义，所以单独识别、直接判死。
 */
function isImageManualDispatchRequiredError(message) {
  return /manual[_\s-]*dispatch[_\s-]*(required|only)|requires?[_\s-]*manual[_\s-]*dispatch|只支持手动选线|只允许手动选线/i.test(String(message || ""));
}

function imageWorkflowPublicLabel(mode) {
  const key = String(mode || "").trim();
  if (key === "random-background") return "随机背景";
  if (key === "white-refine") return "白底精修";
  if (key === "background-change") return "固定背景";
  if (key === "outpaint") return "批量扩图";
  if (key === "recolor") return "批量改色";
  if (key === "face-swap") return "批量换脸";
  if (key === "pose-remix") return "批量姿态";
  if (key === "local-detail") return "局部回贴";
  if (key === "design-draft") return "设计稿";
  return "图片编辑";
}

function imageRouteFailureMessage(params = {}) {
  const workflowLabel = imageWorkflowPublicLabel(params.workflowMode);
  return `${workflowLabel}请求被中转站/上游模型路由返回 404；请检查中转站里该模型是否支持当前图片编辑接口，或切换模型/渠道后重试。`;
}

function shouldTryNextImageVariant(status, message) {
  const numericStatus = Number(status) || 0;
  const text = String(message || "");
  if (
    isImageAuthError(numericStatus, text)
    || isImageQuotaError(numericStatus, text)
    || isImageTooLargeError(text)
    || isImagePermissionError(numericStatus, text)
  ) {
    return false;
  }
  if (isImageRouteNotFoundError(numericStatus, text)) return true;
  if ([429, 500, 502, 503, 504, 524].includes(numericStatus)) return false;
  if (/too many requests|rate\s*limit|timeout|timed out|aborted|openai_error|upstream|bad gateway|gateway|overload|busy|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(text)) return false;

  const isRequestShapeError = /unsupported|not supported|unknown|unrecognized|invalid[_\s-]*(parameter|param|field|request|format|size|image_size|aspect_ratio)|image_size|aspect_ratio|response_format|size.*must|model_not_found|model.*not.*found|No available channel for model/i.test(text);
  if ([400, 404, 409, 422].includes(numericStatus)) return isRequestShapeError;
  return isRequestShapeError && /model|parameter|param|field|size|image_size|aspect_ratio|format/i.test(text);
}

function isImageQuotaError(status, message) {
  return status === 402
    || /quota|余额|额度|remain quota|need quota|insufficient[_\s-]*(quota|balance|credit|token|tokens)|insufficient\s+tokens|billing|balance/i.test(String(message || ""));
}

function isImageAuthError(status, message) {
  return status === 401
    || /invalid token|unauthorized|invalid_api_key|api key.*invalid|token.*invalid|key.*invalid|不接受这把 API Key|密钥|key\s*无效|key无效/i.test(String(message || ""));
}

function isImageTooLargeError(message) {
  return /image too large|file too large|max\s*(?:2|4|10|20|25)\s*mb|(?:2|4|10|20|25)\s*mb|图片.*过大|文件.*过大/i.test(String(message || ""));
}

function isImagePermissionError(status, message) {
  if (isImageQuotaError(status, message) || isImageAuthError(status, message)) return false;
  return status === 403 || /forbidden|permission|无权限|未开通|not allowed/i.test(String(message || ""));
}

function shouldTryNextChannel(status, message) {
  if (isImageAuthError(status, message) || isImageQuotaError(status, message) || isImageTooLargeError(message) || isImagePermissionError(status, message)) return false;
  // 线路在中转站没登记：换上游地址/换变体都没有意义，直接判死，不做任何隐藏重试。
  if (isImageManualChannelNotFoundError(message)) return false;
  // 线路只允许手动选线：换变体也不会变成手动，直接判死。
  if (isImageManualDispatchRequiredError(message)) return false;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if ([400, 404, 422].includes(status)) {
    return /model|unsupported|unknown|image_size|aspect_ratio|openai_error|upstream|not[_\s-]*found|模型.*不可用|模型.*不存在/i.test(String(message || ""));
  }
  return /timeout|aborted|abort|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|gateway|overload|busy|上游|渠道|openai_error|upstream/i.test(String(message || ""));
}

function shouldTreatPrivateChannelAuthAsChannelFault(candidate, status, message) {
  if (!candidate?.usesSignedRoute || !candidate?.hasCredential) return false;
  return isImageAuthError(status, message) || /Invalid token|not accepted|unrecognized|unsupported.*key/i.test(String(message || ""));
}

function publicImageStatus(status, message) {
  if (isImageAuthError(status, message)) return 401;
  if (isImageQuotaError(status, message)) return 402;
  if (isImageTooLargeError(message)) return 400;
  if (isImagePermissionError(status, message)) return 403;
  // 线路没在中转站登记：这是"配置缺失"，不是"服务器/超时"，状态保持客户端错误。
  if (isImageManualChannelNotFoundError(message)) return 400;
  // 线路只允许手动选线：同样是客户端参数问题。
  if (isImageManualDispatchRequiredError(message)) return 400;
  if (isImageRouteNotFoundError(status, message)) return 502;
  if (shouldTryNextChannel(status, message) || status >= 500 || status === 429 || !status) return 504;
  return status;
}

function quotaFailureMessage(message) {
  const text = String(message || "");
  const quotaMatch = text.match(/remain quota:\s*[＄$]?([\d.]+)[\s\S]*?need quota:\s*[＄$]?([\d.]+)/i);
  if (quotaMatch) return `余额不足：剩余 $${quotaMatch[1]} / 需要 $${quotaMatch[2]}，请充值后重新生成。`;
  return "余额不足，请充值后重新生成。";
}

function imageFailureMessage(status, upstreamMessage, params, _attempts) {
  const message = compactLogMessage(upstreamMessage || `HTTP ${status}`, 600);
  if (isImageAuthError(status, message)) return "API Key 无效，请检查 KEY 后重新生成。";
  if (isImageQuotaError(status, message)) return quotaFailureMessage(message);
  if (isImageTooLargeError(message)) return "上传图片过大，请压缩或更换素材后重新生成。";
  if (isImagePermissionError(status, message)) return "当前 KEY 无权限调用该模型，请检查账号权限。";
  // 线路在中转站没登记：换线路能马上恢复，重试同一条线路永远不会成功。
  if (isImageManualChannelNotFoundError(message)) {
    return "所选线路在中转站尚未开通，请换一条线路；若每条线路都报这个错，请联系管理员。";
  }
  if (isImageManualDispatchRequiredError(message)) {
    return "所选线路只支持手动选线（dispatchMode=manual），请重新选择线路后重试。";
  }
  if (isImageRouteNotFoundError(status, message)) return imageRouteFailureMessage(params);
  if (/model_not_found|model.*not.*found|模型.*不存在|unsupported.*model/i.test(message)) {
    return "当前模型暂不可用，请稍后重新生成。";
  }
  // 上游 HTTP 5xx/429：和"等待超时"分开说，用户才知道是对方服务的问题。
  // （V11 自己等待超时的消息固定是"图片接口等待超时"，那种仍算超时。）
  if (!/图片接口等待超时/.test(message) && (status >= 500 || status === 429)) {
    return `上游服务器返回错误（HTTP ${status}），请稍后重试或换一条线路。`;
  }
  if (shouldTryNextChannel(status, message)) return "生成超时，请重新生成。";
  return message;
}

function publicImageErrorCode(status, message) {
  if (isImageAuthError(status, message)) return "invalid_api_key";
  if (isImageQuotaError(status, message)) return "insufficient_quota";
  if (isImageTooLargeError(message)) return "image_too_large";
  if (isImagePermissionError(status, message)) return "permission_denied";
  if (isImageManualChannelNotFoundError(message)) return "channel_not_available";
  if (isImageManualDispatchRequiredError(message)) return "manual_dispatch_required";
  if (isImageRouteNotFoundError(status, message)) return "channel_route_not_found";
  if (/model_not_found|model.*not.*found|模型.*不存在|unsupported.*model/i.test(String(message || ""))) return "model_unavailable";
  // 2026-09-25：上游真的返回了 HTTP 5xx/429 时，不要再统一报成"超时"。
  // 用户需要能区分"服务器返回错误"（上游挂了/限流）和"请求超时"（一直在等没响应）。
  // 注意：V11 自己等待超时被中断时，状态也写成 504，但消息固定是"图片接口等待超时"，
  // 那种情况必须仍然归到 channel_timeout，不能算成上游服务器错误。
  const localWaitTimeout = /图片接口等待超时/.test(String(message || ""));
  if (!localWaitTimeout && (status >= 500 || status === 429)) return "upstream_server_error";
  if (shouldTryNextChannel(status, message) || !status) return "channel_timeout";
  return "upstream_error";
}

function isFallbackAuthMismatchAfterChannelFault(status, message, attempts) {
  if (!isImageAuthError(status, message) || !Array.isArray(attempts) || attempts.length < 2) return false;
  return attempts.slice(0, -1).some((attempt) => {
    const attemptMessage = attempt?.message || "";
    const attemptStatus = Number(attempt?.status) || 0;
    if (
      isImageAuthError(attemptStatus, attemptMessage)
      || isImageQuotaError(attemptStatus, attemptMessage)
      || isImageTooLargeError(attemptMessage)
      || isImagePermissionError(attemptStatus, attemptMessage)
    ) {
      return false;
    }
    return shouldTryNextChannel(attemptStatus, attemptMessage)
      || attempt?.errorCode === "channel_timeout"
      || attempt?.errorCode === "channel_error";
  });
}

function publicImageErrorPayload({ requestId = "", status = 502, upstreamMessage = "", params = {}, attempts = [] }) {
  const fallbackAuthMismatch = isFallbackAuthMismatchAfterChannelFault(status, upstreamMessage, attempts);
  return {
    ok: false,
    requestId,
    status: fallbackAuthMismatch ? 504 : publicImageStatus(status, upstreamMessage),
    error: fallbackAuthMismatch ? "channel_timeout" : publicImageErrorCode(status, upstreamMessage),
    message: fallbackAuthMismatch || publicImageErrorCode(status, upstreamMessage) === "channel_timeout"
      ? "生成超时，请重新生成。"
      : imageFailureMessage(status, upstreamMessage, params, attempts),
    attemptCount: attempts.length
  };
}

function isSmartOutfitInterventionEnabled(value) {
  if (value === false) return false;
  const text = String(value ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no", "regular", "normal", "常规", "关闭"].includes(text);
}

/**
 * 图片下载/代理允许的目标主机。
 *
 * 2026-09-25 修订（按产品口径）：**生图 API 仍然只允许官方中转**（那是
 * PRIMARY_CHANNEL_API_BASE_URL 管的，见图片转发路径），但**图片回传不限域名**——
 * 官方中转后面挂着 N 个渠道，每个渠道的成图在各自的 CDN 上
 * （实测：leo.yunshuaiapi.com、tos.lingkeai.vip、api.luckfill.com…）。
 * 之前这里拿"渠道 API 主机"当图片白名单，导致这些真实结果图被判 blocked_image_host、
 * 显示缓存失败、前端只能拿到无法加载的原始地址（表现为"图片下载失败 HTTP 403"）。
 *
 * 现在这里只挡两件事：非 https、以及本地/内网主机（SSRF）。
 * 判定与前端共用同一份实现（src/shared/image-hosts.js），发布时由 esbuild 内联进 bundle。
 */
function parseProxyTarget(rawUrl) {
  const target = new URL(String(rawUrl || ""));
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("unsupported_protocol");
  }
  if (!isSafeRemoteImageUrl(target.toString())) {
    throw new Error("blocked_image_host");
  }
  return target;
}

function imageProxyUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  return value ? `/api/image-proxy?url=${encodeURIComponent(value)}` : "";
}

function remoteUrlFromImageProxyPath(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/api/image-proxy")) return "";
  try {
    const parsed = new URL(text, "http://127.0.0.1");
    return parsed.pathname === "/api/image-proxy" ? String(parsed.searchParams.get("url") || "") : "";
  } catch {
    return "";
  }
}

function imageForImmediateDisplay(image) {
  if (!image || typeof image !== "object") return image;
  if (image.type !== "url") return image;
  const sourceUrl = String(image.sourceUrl || image.value || "").trim();
  if (!/^https?:\/\//i.test(sourceUrl)) return image;
  const localUrl = imageProxyUrl(sourceUrl);
  return {
    ...image,
    value: sourceUrl,
    localUrl,
    proxySourceUrl: sourceUrl,
    sourceUrl
  };
}

function isBase64ImagePayload(image) {
  if (!image || typeof image !== "object") return false;
  if (image.type === "b64_json") return true;
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(image.value || image.localUrl || ""));
}

function hasHistoryDisplayArchive(item) {
  return Boolean(
    item?.image?.archiveFile
    || String(item?.image?.localUrl || "").startsWith("/api/history-image/")
  );
}

async function historyItemForImmediateDisplay(item, requestId = "", timeoutMs = RESULT_DISPLAY_CACHE_BLOCKING_TIMEOUT_MS) {
  const normalized = normalizeHistoryItem(item);
  const wasArchived = hasHistoryDisplayArchive(normalized);
  const cacheStartedAt = Date.now();
  const archived = await archiveIncomingHistoryItem(normalized, timeoutMs);
  if (hasHistoryDisplayArchive(archived)) {
    if (!wasArchived) {
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId: requestId || item.id,
        ok: true,
        stage: isBase64ImagePayload(item?.image) ? "display-cache-base64-history-image" : "display-cache-url-history-image",
        itemId: item.id,
        archiveFile: archived.image.archiveFile || "",
        localUrl: archived.image.localUrl || "",
        timingMs: Date.now() - cacheStartedAt,
        timeoutMs
      });
    }
    return archived;
  }
  if (!wasArchived && normalized?.image) {
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId: requestId || item.id,
      ok: true,
      stage: "display-cache-history-image-deferred",
      itemId: item.id,
      timingMs: Date.now() - cacheStartedAt,
      timeoutMs
    });
  }
  return {
    ...normalized,
    image: imageForImmediateDisplay(archived?.image || normalized?.image)
  };
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  const total = match[3] === "*" ? NaN : Number.parseInt(match[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end, total };
}

async function fetchImageRangeChunk(target, start, end, timeoutMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= RESULT_URL_DOWNLOAD_RETRIES; attempt += 1) {
    const abort = createAbortSignal(timeoutMs);
    try {
      const response = await fetch(target, {
        method: "GET",
        headers: {
          Range: `bytes=${start}-${end}`,
          "Accept-Encoding": "identity",
          "User-Agent": "JingyinAI/0.1"
        },
        signal: abort.signal
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${compactLogMessage(text, 200)}`);
      }
      return {
        status: response.status,
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "",
        contentRange: response.headers.get("content-range") || "",
        contentLength: Number.parseInt(response.headers.get("content-length") || "", 10)
      };
    } catch (error) {
      lastError = error;
      if (attempt >= RESULT_URL_DOWNLOAD_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    } finally {
      abort.dispose();
    }
  }
  throw lastError || new Error("range_download_failed");
}

async function downloadExternalImageWithRanges(rawUrl, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  const target = parseProxyTarget(rawUrl);
  const sourceUrl = String(rawUrl || "");
  const firstEnd = RESULT_URL_DOWNLOAD_CHUNK_BYTES - 1;
  const first = await fetchImageRangeChunk(target, 0, firstEnd, timeoutMs);
  const mimeType = first.mimeType || mimeTypeFromFile(target.pathname);

  if (first.status === 200) {
    return {
      buffer: first.buffer,
      mimeType,
      sourceUrl,
      rangeMode: "ignored"
    };
  }

  if (first.status !== 206) {
    throw new Error(`range_download_unexpected_status_${first.status}`);
  }

  const firstRange = parseContentRange(first.contentRange);
  if (!firstRange || !Number.isFinite(firstRange.total) || firstRange.total <= 0) {
    throw new Error("range_download_missing_total");
  }

  const chunks = [first.buffer];
  let nextStart = firstRange.end + 1;
  while (nextStart < firstRange.total) {
    const nextEnd = Math.min(firstRange.total - 1, nextStart + RESULT_URL_DOWNLOAD_CHUNK_BYTES - 1);
    const next = await fetchImageRangeChunk(target, nextStart, nextEnd, timeoutMs);
    if (next.status !== 206) {
      throw new Error(`range_download_unexpected_status_${next.status}`);
    }
    const nextRange = parseContentRange(next.contentRange);
    if (!nextRange || nextRange.start !== nextStart || nextRange.end < nextRange.start) {
      throw new Error("range_download_mismatched_chunk");
    }
    chunks.push(next.buffer);
    nextStart = nextRange.end + 1;
  }

  return {
    buffer: Buffer.concat(chunks, firstRange.total),
    mimeType,
    sourceUrl,
    rangeMode: "range"
  };
}

async function downloadExternalImageDirect(rawUrl, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  const target = parseProxyTarget(rawUrl);
  const abort = createAbortSignal(timeoutMs);
  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": "JingyinAI/0.1"
      },
      signal: abort.signal
    });
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") || mimeTypeFromFile(target.pathname),
      sourceUrl: String(rawUrl || ""),
      rangeMode: "direct"
    };
  } finally {
    abort.dispose();
  }
}

function forwardHeader(response, res, name) {
  const value = response.headers.get(name);
  if (value) res.setHeader(name, value);
}

async function streamExternalImageProxy(req, res, rawUrl, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  const target = parseProxyTarget(rawUrl);
  const abort = createAbortSignal(timeoutMs);
  try {
    const headers = {
      "Accept-Encoding": "identity",
      "User-Agent": "JingyinAI/0.1"
    };
    if (req.headers.range) headers.Range = String(req.headers.range);
    const response = await fetch(target, {
      headers,
      signal: abort.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`HTTP ${response.status} ${compactLogMessage(text, 200)}`);
      error.status = response.status;
      throw error;
    }

    res.status(response.status);
    res.setHeader("Content-Type", response.headers.get("content-type") || mimeTypeFromFile(target.pathname));
    res.setHeader("Cache-Control", "private, max-age=300");
    forwardHeader(response, res, "content-length");
    forwardHeader(response, res, "content-range");
    forwardHeader(response, res, "accept-ranges");

    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), res);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  } finally {
    abort.dispose();
  }
}

async function downloadExternalImageWithFallback(rawUrl, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  try {
    return await downloadExternalImageWithRanges(rawUrl, timeoutMs);
  } catch (rangeError) {
    try {
      const direct = await downloadExternalImageDirect(rawUrl, timeoutMs);
      return {
        ...direct,
        rangeFallbackError: rangeError instanceof Error ? rangeError.message : String(rangeError || "")
      };
    } catch (directError) {
      directError.rangeError = rangeError;
      throw directError;
    }
  }
}

function channelBaseCandidates() {
  // 中文注释：每次请求都从主渠道开始；备用渠道只做当次故障兜底，不把上次成功备用缓存成下一次默认。
  return buildChannelBaseCandidates(PRIMARY_CHANNEL_API_BASE_URL);
}

function imageChannelBaseCandidates(model) {
  return buildImageChannelBaseCandidates(model);
}

function imageParamsForBaseUrl(params, baseUrl) {
  const upstreamModel = upstreamModelForChannel(baseUrl, params.model);
  return upstreamModel === params.model ? params : { ...params, model: upstreamModel };
}

function imageRequestVariantsForBaseUrl(params, files, baseUrl) {
  return buildImageRequestVariants(imageParamsForBaseUrl(params, baseUrl), files);
}

function imageRequestLogTargets(params, files, baseUrls) {
  return baseUrls.flatMap((baseUrl) => (
    imageRequestVariantsForBaseUrl(params, files, baseUrl).map((variant) => ({
      url: `${baseUrl}${variant.path}`,
      protocol: variant.protocol,
      model: variant.model,
      requestFormat: variant.requestFormat
    }))
  ));
}

function clampDiagnosticImageCount(value) {
  return Math.max(0, Math.min(12, Number.parseInt(value, 10) || 0));
}

function diagnosticPlaceholderFiles(count) {
  return Array.from({ length: count }, (_, index) => ({
    buffer: Buffer.from([0]),
    mimetype: "image/png",
    originalname: `diagnostic-image-${index + 1}.png`,
    size: 0
  }));
}

function diagnosticFieldValue(key, value, params, imageIndex) {
  const field = String(key || "").toLowerCase();
  if (field.includes("key") || field === "authorization" || field.includes("token")) return "[hidden]";
  if (field === "prompt") return "[hidden]";
  if (field === "model") return String(value || "") === params.model ? params.model : "[server-mapped]";
  if (field === "image") return `image#${imageIndex}`;
  return String(value ?? "");
}

async function describeDiagnosticVariantFields(variant, params) {
  if (variant.protocol === "json") {
    const payload = JSON.parse(await variant.createBody());
    return Object.entries(payload).map(([key, value]) => ({
      key,
      value: diagnosticFieldValue(key, value, params, 0)
    }));
  }

  let imageIndex = 0;
  const body = await variant.createBody();
  return Array.from(body.entries()).map(([key, value]) => {
    const isImage = String(key || "").toLowerCase() === "image";
    if (isImage) imageIndex += 1;
    return {
      key,
      value: diagnosticFieldValue(key, typeof value === "string" ? value : "", params, imageIndex)
    };
  });
}

async function buildImageRequestDiagnostic(input = {}) {
  const requestedImageCount = clampDiagnosticImageCount(input.imageCount);
  const hasImages = Boolean(input.hasImages ?? requestedImageCount > 0);
  const imageCount = hasImages ? Math.max(1, requestedImageCount || 2) : 0;
  const params = normalizeImageRequest({
    ...input,
    prompt: "diagnostic prompt omitted",
    n: input.n || 1
  });
  const files = diagnosticPlaceholderFiles(imageCount);
  const baseCandidates = imageChannelBaseCandidates(params.model);
  const primaryBaseUrl = baseCandidates[0] || PRIMARY_CHANNEL_API_BASE_URL;
  const primaryParams = imageParamsForBaseUrl(params, primaryBaseUrl);
  const variants = await Promise.all(buildImageRequestVariants(primaryParams, files).map(async (variant, index) => ({
    attempt: index + 1,
    id: variant.id,
    path: variant.path,
    protocol: variant.protocol,
    requestFormat: variant.requestFormat,
    modelField: variant.model === params.model ? params.model : "[server-mapped]",
    fields: await describeDiagnosticVariantFields(variant, params)
  })));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    charged: false,
    upstreamCalled: false,
    security: {
      apiKeyIncluded: false,
      promptIncluded: false,
      imageContentIncluded: false,
      upstreamBaseUrlIncluded: false,
      priceIncluded: false
    },
    params: {
      model: params.model,
      source: params.source || "",
      workflowMode: params.workflowMode || "",
      imageSize: params.imageSize,
      aspectRatio: params.aspectRatio,
      n: params.n,
      hasImages: files.length > 0,
      imageCount: files.length
    },
    routes: baseCandidates.map((baseUrl, index) => {
      const logFields = channelLogFields(baseUrl, index, baseCandidates.length);
      return {
        attempt: index + 1,
        role: logFields.channelRole,
        fallback: Boolean(logFields.channelIsFallback)
      };
    }),
    billingGateway: {
      enabled: billingGatewayPolicy().enabled,
      note: billingGatewayPolicy().enabled
        ? "真实生成时计费网关可能签发优先路由；自检不会展示签发路由、token、KEY 或真实域名。"
        : "未启用计费签发；自检只展示本地静态候选摘要。"
    },
    primary: variants[0] || null,
    variants
  };
}

function outfitUploadFileGroups(req) {
  if (Array.isArray(req.files)) {
    return {
      imageFiles: req.files,
      maskFile: null
    };
  }
  const groups = req.files && typeof req.files === "object" ? req.files : {};
  return {
    imageFiles: Array.isArray(groups.image) ? groups.image : [],
    maskFile: Array.isArray(groups.mask) ? groups.mask[0] || null : null
  };
}

function outfitResultUrl(filename) {
  return `/api/result/${encodeURIComponent(filename)}`;
}

function outfitResultPath(filename) {
  const safeName = path.basename(String(filename || ""));
  const resolved = path.resolve(resultDir, safeName);
  if (!resolved.startsWith(path.resolve(resultDir) + path.sep)) {
    throw new Error("本地换装结果路径无效");
  }
  return resolved;
}

function imageFromOutfitArchive(archived) {
  if (!archived?.localUrl) return null;
  return {
    type: "url",
    value: archived.localUrl,
    localUrl: archived.localUrl,
    archiveMime: archived.archiveMime || mimeTypeFromFile(archived.filename),
    resultArchiveFile: archived.filename,
    ...(archived.sourceUrl ? { sourceUrl: archived.sourceUrl } : {})
  };
}

function parseByteRange(rangeHeader, size) {
  const raw = String(rangeHeader || "").trim();
  if (!raw) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!match) return false;

  const [, startText, endText] = match;
  if (!startText && !endText) return false;

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return false;
  }

  return { start, end: Math.min(end, size - 1) };
}

async function streamLocalImageFile(req, res, file, options = {}) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("not_file");

  const size = info.size;
  const range = parseByteRange(req.headers.range, size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": options.contentType || mimeTypeFromFile(file),
    "Cache-Control": options.cacheControl || "public, max-age=31536000, immutable"
  };

  if (range === false) {
    res.status(416)
      .set({
        ...headers,
        "Content-Range": `bytes */${size}`
      })
      .end();
    return;
  }

  if (size === 0) {
    res.status(200).set({ ...headers, "Content-Length": "0" }).end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const contentLength = end - start + 1;
  res.status(range ? 206 : 200).set({
    ...headers,
    "Content-Length": String(contentLength),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
  });

  await pipeline(createReadStream(file, { start, end, highWaterMark: DOWNLOAD_CHUNK_BYTES }), res);
}

function isResultCacheImageFile(name) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(name || ""));
}

function roundCacheRatio(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

async function getResultCacheDiskUsage() {
  await mkdir(resultDir, { recursive: true });
  const info = await statfs(resultDir);
  const blockSize = Number(info.bsize || info.frsize || 0);
  const totalBlocks = Number(info.blocks || 0);
  const availableBlocks = Number(info.bavail ?? info.bfree ?? 0);
  const totalBytes = blockSize * totalBlocks;
  const availableBytes = Math.max(0, blockSize * availableBlocks);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedRatio: usedBytes / totalBytes
  };
}

async function deleteResultCacheFile(file) {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupResultCache(reason = "scheduled") {
  if (resultCacheCleanupRunning) return;
  resultCacheCleanupRunning = true;
  const startedAt = Date.now();
  let scannedCount = 0;
  let deletedCount = 0;
  let deletedBytes = 0;
  let expiredDeletedCount = 0;
  let expiredDeletedBytes = 0;
  let pressureDeletedCount = 0;
  let pressureDeletedBytes = 0;
  let diskPressureTriggered = false;
  let diskUsageBeforePressure = null;
  let diskUsageAfterCleanup = null;

  try {
    await mkdir(resultDir, { recursive: true });
    const cutoff = Date.now() - RESULT_CACHE_TTL_MS;
    const entries = await readdir(resultDir, { withFileTypes: true });
    const remainingItems = [];

    for (const entry of entries) {
      if (!entry.isFile() || !isResultCacheImageFile(entry.name)) continue;
      scannedCount += 1;
      const file = outfitResultPath(entry.name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      const touchedAt = Math.max(info.mtimeMs || 0, info.birthtimeMs || 0);
      const size = info.size || 0;
      if (touchedAt >= cutoff) {
        remainingItems.push({ file, size, touchedAt });
        continue;
      }
      if (!await deleteResultCacheFile(file)) continue;
      deletedCount += 1;
      deletedBytes += size;
      expiredDeletedCount += 1;
      expiredDeletedBytes += size;
    }

    diskUsageBeforePressure = await getResultCacheDiskUsage().catch(() => null);
    if (diskUsageBeforePressure?.usedRatio > RESULT_CACHE_MAX_DISK_USAGE_RATIO) {
      diskPressureTriggered = true;
      remainingItems.sort((left, right) => left.touchedAt - right.touchedAt);
      let projectedAvailableBytes = diskUsageBeforePressure.availableBytes;
      const totalBytes = diskUsageBeforePressure.totalBytes;
      const minimumTouchedAt = Date.now() - RESULT_CACHE_DISK_PRESSURE_MIN_FILE_AGE_MS;

      for (const item of remainingItems) {
        const projectedUsedRatio = (totalBytes - projectedAvailableBytes) / totalBytes;
        if (projectedUsedRatio <= RESULT_CACHE_MAX_DISK_USAGE_RATIO) break;
        if (item.touchedAt > minimumTouchedAt) continue;
        if (!await deleteResultCacheFile(item.file)) continue;
        projectedAvailableBytes += item.size;
        deletedCount += 1;
        deletedBytes += item.size;
        pressureDeletedCount += 1;
        pressureDeletedBytes += item.size;
      }
    }

    diskUsageAfterCleanup = await getResultCacheDiskUsage().catch(() => null);

    if (deletedCount > 0 || diskPressureTriggered) {
      await writeGenerationLog({
        time: new Date().toISOString(),
        ok: true,
        stage: "result-cache-cleanup",
        reason,
        ttlDays: RESULT_CACHE_TTL_DAYS,
        maxDiskUsageRatio: RESULT_CACHE_MAX_DISK_USAGE_RATIO,
        diskUsageRatioBeforePressure: roundCacheRatio(diskUsageBeforePressure?.usedRatio),
        diskUsageRatioAfterCleanup: roundCacheRatio(diskUsageAfterCleanup?.usedRatio),
        diskPressureTriggered,
        scannedCount,
        deletedCount,
        deletedBytes,
        expiredDeletedCount,
        expiredDeletedBytes,
        pressureDeletedCount,
        pressureDeletedBytes,
        timingMs: Date.now() - startedAt
      });
    }
  } catch (error) {
    await writeGenerationLog({
      time: new Date().toISOString(),
      ok: false,
      stage: "result-cache-cleanup",
      reason,
      ttlDays: RESULT_CACHE_TTL_DAYS,
      maxDiskUsageRatio: RESULT_CACHE_MAX_DISK_USAGE_RATIO,
      diskUsageRatioBeforePressure: roundCacheRatio(diskUsageBeforePressure?.usedRatio),
      diskUsageRatioAfterCleanup: roundCacheRatio(diskUsageAfterCleanup?.usedRatio),
      diskPressureTriggered,
      scannedCount,
      deletedCount,
      deletedBytes,
      expiredDeletedCount,
      expiredDeletedBytes,
      pressureDeletedCount,
      pressureDeletedBytes,
      timingMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error || "")
    });
  } finally {
    resultCacheCleanupRunning = false;
  }
}

function scheduleResultCacheCleanup(reason = "scheduled", delayMs = 0) {
  if (delayMs <= 0) {
    void cleanupResultCache(reason);
    return;
  }
  if (resultCacheCleanupTimer) return;
  resultCacheCleanupTimer = setTimeout(() => {
    resultCacheCleanupTimer = null;
    void cleanupResultCache(reason);
  }, delayMs);
  resultCacheCleanupTimer.unref?.();
}

function startResultCacheCleanup() {
  scheduleResultCacheCleanup("startup");
  const timer = setInterval(() => {
    scheduleResultCacheCleanup("scheduled");
  }, RESULT_CACHE_CLEANUP_INTERVAL_MS);
  timer.unref?.();
}

async function archiveOutfitGeneratedImage(image, taskId, timeoutMs = IMAGE_PROXY_TIMEOUT_MS) {
  const payload = await imageBufferFromPayload(image, timeoutMs);
  const ext = imageExtensionFromType(payload.mimeType, payload.sourceUrl);
  const safeTaskId = sanitizeFilePart(taskId || "task");
  const filename = `HZ-${new Date().getDate()}-${safeTaskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const target = outfitResultPath(filename);
  await mkdir(resultDir, { recursive: true });
  await writeFile(target, payload.buffer, { flag: "wx" });
  scheduleResultCacheCleanup("post-result-write", RESULT_CACHE_POST_WRITE_CLEANUP_DELAY_MS);
  return {
    type: "local",
    filename,
    localUrl: outfitResultUrl(filename),
    bytes: payload.buffer.length,
    archiveMime: payload.mimeType,
    ...(payload.sourceUrl ? { sourceUrl: payload.sourceUrl } : {})
  };
}

async function cacheOutfitGeneratedImageForDisplay(image, taskId, timeoutMs = RESULT_DISPLAY_CACHE_TIMEOUT_MS) {
  const startedAt = Date.now();
  try {
    const archived = await archiveOutfitGeneratedImage(image, taskId, timeoutMs);
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId: taskId,
      ok: true,
      stage: "display-cache-outfit-result-image",
      bytes: archived.bytes,
      localUrl: archived.localUrl,
      sourceUrl: archived.sourceUrl || "",
      timingMs: Date.now() - startedAt,
      timeoutMs
    });
    return imageFromOutfitArchive(archived) || image;
  } catch (error) {
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId: taskId,
      ok: false,
      stage: "display-cache-outfit-result-image",
      error: error instanceof Error ? error.message : String(error),
      timingMs: Date.now() - startedAt,
      timeoutMs
    });
    return image;
  }
}

function archiveOutfitGeneratedImageInBackground(image, taskId, stage = "background-cache-outfit-result-image") {
  setTimeout(() => {
    archiveOutfitGeneratedImage(image, taskId)
      .then((archived) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId: taskId,
        ok: true,
        stage,
        bytes: archived.bytes,
        localUrl: archived.localUrl,
        sourceUrl: archived.sourceUrl || ""
      }))
      .catch((error) => writeGenerationLog({
        time: new Date().toISOString(),
        requestId: taskId,
        ok: false,
        stage,
        error: error instanceof Error ? error.message : String(error)
      }));
  }, 0);
}

app.get("/api/config", (_req, res) => {
  const billingPolicy = publicBillingGatewayPolicy();
  const videoPolicy = publicVideoPolicyConfig();
  const videoAvailableByGateway = billingPolicy.enabled;
  const videoAvailable = videoPolicy.enabled || videoAvailableByGateway;
  res.json({
    ok: true,
    defaultBaseUrl: PRIMARY_CHANNEL_API_BASE_URL,
    fallbackBaseUrl: "",
    hasServerKey: false,
    channelPolicy: publicChannelPolicyConfig(),
    models: publicChannelModels(),
    routing: publicRoutingCatalog(),
    billingGatewayPolicy: {
      ...billingPolicy,
      videoRequired: VIDEO_BILLING_GATEWAY_REQUIRED
    },
    videoPolicy: {
      ...videoPolicy,
      enabled: videoAvailable,
      routeSource: videoAvailableByGateway ? "billing-gateway" : (videoPolicy.enabled ? "server-key" : "unconfigured")
    },
    videoModels: publicVideoModels().map((model) => ({
      ...model,
      enabled: videoAvailable
    }))
  });
});

// 与 3.0 使用同一份模型能力/手动线路目录；旧 V11 页面也可直接读取。
app.get("/api/ecommerce/routing", (_req, res) => {
  res.json({ ok: true, ...publicRoutingCatalog() });
});

function gatewayRootUrl(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

async function checkGatewayConnectivity(gateway) {
  const url = gatewayRootUrl(gateway.baseUrl);
  const startedAt = Date.now();
  const abort = createAbortSignal(8000);
  try {
    let response = await fetch(url, {
      method: "HEAD",
      signal: abort.signal
    });
    if (response.status === 405) {
      response = await fetch(url, {
        method: "GET",
        signal: abort.signal
      });
    }
    return {
      ...gateway,
      checkUrl: url,
      reachable: true,
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      statusText: response.statusText,
      server: response.headers.get("server") || "",
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ...gateway,
      checkUrl: url,
      reachable: false,
      ok: false,
      status: 0,
      statusText: "",
      server: "",
      latencyMs: Date.now() - startedAt,
      error: error?.name === "AbortError" ? "timeout" : error instanceof Error ? error.message : String(error)
    };
  } finally {
    abort.dispose();
  }
}

/**
 * POST /api/connection-test —— 「连接测试」。
 *
 * 行为对照 3.0 的 `/api/providers/test-connection`：
 *   只向上游发 `GET {base}/models`（带 Authorization），**不调用生图、不上传图片、不扣费**。
 * 与 3.0 的差异：V11 的网关/线路来自本仓库的 channel 配置，KEY 由前端传入（服务端不落盘），
 * 所以这里按 V11 自己的字段名收发。
 *
 * 安全：
 *   - 绝不回显 API Key / Authorization；
 *   - 上游错误信息先做脱敏（去掉 key/token 片段）再返回；
 *   - 不写入任何日志文件，也不返回完整响应体，只给结论 + 状态码 + 耗时。
 */
app.post("/api/connection-test", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const requestedBaseUrl = String(body.baseUrl || body.base_url || "").trim().replace(/\/+$/, "");
  const fallbackBaseUrl = String(channelBaseCandidates()[0] || PRIMARY_CHANNEL_API_BASE_URL || "").replace(/\/+$/, "");
  const baseUrl = requestedBaseUrl || fallbackBaseUrl;
  const startedAt = Date.now();

  if (!baseUrl) {
    return res.status(400).json({ ok: false, status: 0, message: "请先填写请求地址", latencyMs: 0 });
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return res.status(400).json({ ok: false, status: 0, message: "请求地址必须以 http:// 或 https:// 开头", latencyMs: 0 });
  }

  const apiKey = resolveApiKey(body.apiKey);
  if (!apiKey) {
    return res.status(400).json({ ok: false, status: 0, message: "请先填写或保存 API Key", latencyMs: 0 });
  }

  // 与 3.0 一致：base 以 /v1 结尾就直接拼 /models，否则补 /v1/models。
  const probeUrl = /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const abort = createAbortSignal(15000);
  try {
    const response = await fetch(probeUrl, {
      method: "GET",
      redirect: "manual",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });
    const status = Number(response.status || 0);
    let message;
    if (status === 401 || status === 403) {
      message = `API Key 无效或无权限（HTTP ${status}）`;
    } else if (status === 404) {
      message = "连接可达，但上游没有 /v1/models 接口（HTTP 404）";
    } else if (status >= 500) {
      message = `上游服务暂时不可用（HTTP ${status}）`;
    } else if (status >= 400) {
      message = `上游拒绝了探测请求（HTTP ${status}）`;
    } else {
      // 只读模型清单，用来证明这条线路真的可用；不展示完整响应内容。
      let modelCount = 0;
      try {
        const payload = await response.json();
        const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
        modelCount = list.length;
      } catch { /* 模型清单解析失败不影响连通结论 */ }
      message = modelCount > 0
        ? `连接正常，可用模型 ${modelCount} 个`
        : "连接正常";
    }
    return res.json({
      ok: status >= 200 && status < 400,
      status,
      latencyMs: Date.now() - startedAt,
      model: String(body.model || ""),
      channelId: String(body.channelId || ""),
      message
    });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    const raw = error instanceof Error ? error.message : String(error);
    // 脱敏：上游报错里可能带 key/token 片段，统一替换掉再回前端。
    const safe = raw.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
    return res.json({
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      model: String(body.model || ""),
      channelId: String(body.channelId || ""),
      message: isTimeout ? "连接超时（15 秒无响应）" : `连接失败：${safe}`
    });
  } finally {
    abort.dispose();
  }
});

app.get("/api/gateways", (_req, res) => {
  const gateways = publicChannelGateways();
  res.json({
    ok: true,
    priorityRule: "priority 数字越小越靠前；第 1 个是主中转站，后续是备用中转站。",
    activeEndpointCount: gateways.length,
    gateways
  });
});

app.get("/api/gateways/status", async (_req, res) => {
  const gateways = publicChannelGateways();
  const checks = await Promise.all(gateways.map(checkGatewayConnectivity));
  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    priorityRule: "priority 数字越小越靠前；本检查不携带用户 KEY、不调用生图、不扣费。",
    activeEndpointCount: checks.length,
    allReachable: checks.every((item) => item.reachable),
    gateways: checks
  });
});

app.get("/api/health", (_req, res) => {
  const memory = process.memoryUsage();
  res.json({
    ok: true,
    version: "11.0.0",
    now: new Date().toISOString(),
    gatewayBaseUrl: PRIMARY_CHANNEL_API_BASE_URL,
    imageConcurrency: {
      limit: IMAGE_CONCURRENCY_LIMIT,
      active: activeImageRequestCount,
      queued: imageRequestQueue.length
    },
    memory: {
      rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
      heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
      heapTotalMb: Number((memory.heapTotal / 1024 / 1024).toFixed(1)),
      externalMb: Number((memory.external / 1024 / 1024).toFixed(1))
    },
    uptimeSec: Math.floor(process.uptime())
  });
});

app.post("/api/client-diagnostic-event", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const requestId = String(body.requestId || `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  writeGenerationLog({
    time: new Date().toISOString(),
    requestId,
    ok: body.ok !== false,
    stage: clientDiagnosticStage(body.stage),
    event: sanitizeClientDiagnosticValue("event", body.event || body.stage || ""),
    endpoint: sanitizeClientDiagnosticValue("endpoint", body.endpoint || body.url || ""),
    method: sanitizeClientDiagnosticValue("method", body.method || ""),
    status: Number.isFinite(Number(body.status)) ? Number(body.status) : undefined,
    durationMs: Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : undefined,
    detail: sanitizeClientDiagnosticValue("detail", body.detail || {})
  }).catch(() => {});
  res.json({ ok: true });
});

app.post("/api/debug/image-request-params", async (req, res) => {
  try {
    res.json(await buildImageRequestDiagnostic(req.body || {}));
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "传参自检失败"
    });
  }
});

function publicVideoErrorCode(status, message) {
  if (isImageAuthError(status, message)) return "invalid_api_key";
  if (isImageQuotaError(status, message)) return "insufficient_quota";
  if (isImagePermissionError(status, message)) return "permission_denied";
  if (/model_not_found|model.*not.*found|unsupported.*model|模型.*不可用|模型.*不存在/i.test(String(message || ""))) return "model_unavailable";
  if (status >= 500 || status === 429 || !status || /timeout|timed out|upstream|channel|渠道|上游/i.test(String(message || ""))) return "channel_timeout";
  return "upstream_error";
}

function publicVideoErrorMessage(status, message) {
  const code = publicVideoErrorCode(status, message);
  if (code === "invalid_api_key") return "视频 API Key 无效或当前账号无权限，请检查配置后重试。";
  if (code === "insufficient_quota") return quotaFailureMessage(message);
  if (code === "permission_denied") return "当前视频通道无权调用该模型，请检查静音中转站视频权限。";
  if (code === "model_unavailable") return "当前视频模型暂不可用，请稍后重试。";
  if (code === "channel_timeout") return "视频生成超时，请重新生成。";
  return compactLogMessage(message || `HTTP ${status}`, 600);
}

function publicVideoTaskFailureMessage(message) {
  const text = compactLogMessage(message, 600);
  if (!text) return null;
  if (/all cookies failed|cookie#|insufficient\s+tokens/i.test(text)) {
    return "视频上游通道资源不足，任务已自动退款，请稍后重试或切换可用视频渠道。";
  }
  return text;
}

function publicVideoTaskPayload(json = {}, fallbackTaskId = "") {
  const firstDataItem = Array.isArray(json.data) ? json.data.find((item) => item && typeof item === "object") : null;
  const dataObject = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : null;
  const taskObject = json.task && typeof json.task === "object" && !Array.isArray(json.task) ? json.task : null;
  const nestedDataObject = dataObject?.data && typeof dataObject.data === "object" && !Array.isArray(dataObject.data) ? dataObject.data : null;
  const output = json.output && typeof json.output === "object" ? json.output : null;
  const videoUrl = [
    json.url,
    json.video_url,
    json.output_url,
    output?.url,
    taskObject?.url,
    taskObject?.video_url,
    taskObject?.output_url,
    dataObject?.url,
    dataObject?.video_url,
    dataObject?.output_url,
    dataObject?.result_url,
    nestedDataObject?.url,
    nestedDataObject?.video_url,
    nestedDataObject?.output_url,
    nestedDataObject?.result_url,
    firstDataItem?.url,
    firstDataItem?.video_url,
    firstDataItem?.output_url,
    firstDataItem?.result_url
  ].map((value) => String(value || "").trim()).find((value) => /^(https?:|data:)/i.test(value)) || "";
  const rawErrorMessage = [
    json.error?.message,
    json.error,
    taskObject?.error?.message,
    taskObject?.error,
    dataObject?.fail_reason,
    dataObject?.error?.message,
    dataObject?.error,
    nestedDataObject?.error?.message,
    nestedDataObject?.error,
    nestedDataObject?.fail_reason,
    firstDataItem?.fail_reason,
    firstDataItem?.error?.message,
    firstDataItem?.error,
    dataObject?.result_url && !/^(https?:|data:)/i.test(String(dataObject.result_url)) ? dataObject.result_url : ""
  ].map((value) => String(value || "").trim()).filter(Boolean)[0] || null;
  const errorMessage = publicVideoTaskFailureMessage(rawErrorMessage);
  const taskId = json.task_id
    || json.taskId
    || json.id
    || json.video_id
    || taskObject?.task_id
    || taskObject?.taskId
    || taskObject?.id
    || dataObject?.task_id
    || dataObject?.taskId
    || dataObject?.id
    || nestedDataObject?.task_id
    || nestedDataObject?.taskId
    || nestedDataObject?.id
    || firstDataItem?.task_id
    || firstDataItem?.taskId
    || firstDataItem?.id
    || fallbackTaskId
    || "";
  return {
    taskId,
    id: taskId,
    status: json.status || taskObject?.status || dataObject?.status || nestedDataObject?.status || firstDataItem?.status || (taskId ? "queued" : "unknown"),
    progress: Number.isFinite(Number(json.progress ?? taskObject?.progress ?? dataObject?.progress ?? nestedDataObject?.progress ?? firstDataItem?.progress))
      ? Number(json.progress ?? taskObject?.progress ?? dataObject?.progress ?? nestedDataObject?.progress ?? firstDataItem?.progress)
      : null,
    url: videoUrl,
    format: json.format || taskObject?.format || dataObject?.format || nestedDataObject?.format || firstDataItem?.format || "",
    model: json.model || taskObject?.model || dataObject?.model || nestedDataObject?.model || firstDataItem?.model || "",
    seconds: json.seconds || json.duration || taskObject?.seconds || taskObject?.duration || dataObject?.seconds || dataObject?.duration || nestedDataObject?.seconds || nestedDataObject?.duration || firstDataItem?.seconds || firstDataItem?.duration || "",
    size: json.size || taskObject?.size || dataObject?.size || nestedDataObject?.size || firstDataItem?.size || "",
    metadata: json.metadata || taskObject?.metadata || dataObject?.metadata || nestedDataObject?.metadata || firstDataItem?.metadata || null,
    error: errorMessage,
    raw: json
  };
}

function videoRouteText(value) {
  return String(value || "").trim();
}

function hasHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

function safeSignedRouteHeaders(input = {}) {
  const headers = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return headers;
  const blocked = new Set(["host", "connection", "content-length", "transfer-encoding"]);
  for (const [key, value] of Object.entries(input)) {
    const name = videoRouteText(key);
    if (!name || blocked.has(name.toLowerCase())) continue;
    const text = videoRouteText(value);
    if (text) headers[name] = text;
  }
  return headers;
}

function signedRouteCredential(route = {}) {
  return resolveApiKey(
    route.apiKey
    || route.api_key
    || route.bearerToken
    || route.bearer_token
    || route.token
    || route.accessToken
    || route.access_token
    || ""
  );
}

function videoRouteUrl(rawValue, baseUrl, fallbackPath) {
  const raw = videoRouteText(rawValue || fallbackPath);
  if (/^https?:\/\//i.test(raw)) return raw;
  const normalizedBase = normalizeBaseUrl(baseUrl || gatewayVideoBaseUrl());
  const routePath = raw.startsWith("/") ? raw : `/${raw}`;
  return `${normalizedBase}${routePath}`;
}

function videoStatusUrlFromRoute(route, taskId) {
  const encodedTaskId = encodeURIComponent(taskId);
  const template = videoRouteText(route.statusUrlTemplate || route.statusUrl || "");
  if (template) {
    return videoRouteUrl(
      template
        .replace(/\{task_id\}/g, encodedTaskId)
        .replace(/\{taskId\}/g, encodedTaskId)
        .replace(/:taskId\b/g, encodedTaskId)
        .replace(/:task_id\b/g, encodedTaskId),
      route.baseUrl,
      `/video/generations/${encodedTaskId}`
    );
  }
  return videoRouteUrl(route.statusPath, route.baseUrl, `/video/generations/${encodedTaskId}`);
}

function createVideoRouteFromBillingTask(billingTask, fallbackBaseUrl, fallbackApiKey) {
  const signedRoute = billingTask?.signedRoute && typeof billingTask.signedRoute === "object" && !Array.isArray(billingTask.signedRoute)
    ? billingTask.signedRoute
    : null;
  const route = signedRoute || {};
  const baseUrl = normalizeBaseUrl(
    route.baseUrl
    || route.base_url
    || route.upstreamBaseUrl
    || route.upstream_base_url
    || fallbackBaseUrl
  );
  const headers = safeSignedRouteHeaders(route.headers);
  const credential = signedRouteCredential(route) || resolveApiKey(fallbackApiKey);
  if (credential && !hasHeader(headers, "authorization")) {
    headers.Authorization = /^Bearer\s+/i.test(credential) ? credential : `Bearer ${credential}`;
  }
  const routeTokenHeader = videoRouteText(route.routeTokenHeader || route.route_token_header);
  if (routeTokenHeader && billingTask?.routeToken && !hasHeader(headers, routeTokenHeader)) {
    headers[routeTokenHeader] = billingTask.routeToken;
  }

  return {
    baseUrl,
    createUrl: videoRouteUrl(
      route.createUrl
      || route.create_url
      || route.generationUrl
      || route.generation_url
      || route.url
      || route.path,
      baseUrl,
      "/video/generations"
    ),
    statusUrlTemplate: videoRouteText(route.statusUrlTemplate || route.status_url_template || route.statusUrl || route.status_url),
    statusPath: videoRouteText(route.statusPath || route.status_path),
    headers,
    usesSignedRoute: Boolean(signedRoute),
    hasCredential: hasHeader(headers, "authorization") || Boolean(routeTokenHeader && billingTask?.routeToken),
    channelId: videoRouteText(route.channelId || route.channel_id || JINGYIN_VIDEO_GATEWAY_CHANNEL_ID),
    channelRole: videoRouteText(route.channelRole || route.channel_role || "video-primary")
  };
}

function bearerHeaderValue(credential) {
  const text = resolveApiKey(credential);
  if (!text) return "";
  return /^Bearer\s+/i.test(text) ? text : `Bearer ${text}`;
}

function imageRouteUrl(rawValue, baseUrl, fallbackPath) {
  const raw = videoRouteText(rawValue || fallbackPath);
  if (/^https?:\/\//i.test(raw)) return raw;
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const routePath = raw.startsWith("/") ? raw : `/${raw}`;
  return `${normalizedBase}${routePath}`;
}

function imageRouteModel(route = {}) {
  return videoRouteText(
    route.model
    || route.upstreamModel
    || route.upstream_model
    || route.realModel
    || route.real_model
  );
}

function createImageRouteFromBillingTask(billingTask) {
  const signedRoute = billingTask?.signedRoute && typeof billingTask.signedRoute === "object" && !Array.isArray(billingTask.signedRoute)
    ? billingTask.signedRoute
    : null;
  if (!signedRoute) return null;

  const route = signedRoute;
  const baseUrl = normalizeBaseUrl(
    route.baseUrl
    || route.base_url
    || route.upstreamBaseUrl
    || route.upstream_base_url
    || ""
  );
  if (!baseUrl) return null;

  const headers = safeSignedRouteHeaders(route.headers);
  const credential = signedRouteCredential(route);
  const routeApiKeyHeader = videoRouteText(route.apiKeyHeader || route.api_key_header || route.authHeader || route.auth_header);
  if (credential && routeApiKeyHeader && !hasHeader(headers, routeApiKeyHeader)) {
    headers[routeApiKeyHeader] = credential;
  } else if (credential && !hasHeader(headers, "authorization")) {
    headers.Authorization = bearerHeaderValue(credential);
  }
  const routeTokenHeader = videoRouteText(route.routeTokenHeader || route.route_token_header);
  if (routeTokenHeader && billingTask?.routeToken && !hasHeader(headers, routeTokenHeader)) {
    headers[routeTokenHeader] = billingTask.routeToken;
  }
  const hasApiKeyHeader = Boolean(routeApiKeyHeader && hasHeader(headers, routeApiKeyHeader));

  return {
    baseUrl,
    headers,
    usesSignedRoute: true,
    hasCredential: hasHeader(headers, "authorization") || hasApiKeyHeader || Boolean(routeTokenHeader && billingTask?.routeToken),
    channelId: videoRouteText(route.channelId || route.channel_id || "billing-signed-image"),
    channelRole: videoRouteText(route.channelRole || route.channel_role || "image-signed"),
    channelLabel: videoRouteText(route.channelLabel || route.channel_label || "静音计费签发图片路由"),
    model: imageRouteModel(route),
    route
  };
}

function imageCandidateEntries(baseUrls = [], billingTask = null) {
  const entries = [];
  const signedRoute = createImageRouteFromBillingTask(billingTask);
  if (signedRoute) entries.push(signedRoute);
  const seen = new Set(entries.map((entry) => normalizeBaseUrl(entry.baseUrl)));
  for (const baseUrl of baseUrls) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const endpoint = channelEndpointForBaseUrl(normalized);
    entries.push({
      baseUrl: normalized,
      headers: {},
      usesSignedRoute: false,
      hasCredential: Boolean(endpoint?.upstreamApiKey),
      channelId: endpoint?.id || "",
      channelRole: endpoint?.role || "",
      channelLabel: endpoint?.label || "",
      model: "",
      route: null
    });
  }
  return entries;
}

function imageChannelLogForCandidate(candidate, index, candidateCount) {
  const baseLog = channelLogFields(candidate.baseUrl, index, candidateCount);
  if (!candidate?.usesSignedRoute) return baseLog;
  const channelRole = candidate.channelRole || baseLog.channelRole || "image-signed";
  return {
    ...baseLog,
    channelId: candidate.channelId || baseLog.channelId || "billing-signed-image",
    channelLabel: candidate.channelLabel || baseLog.channelLabel || "静音计费签发图片路由",
    channelRole,
    channelIsFallback: index > 0 || /fallback|backup/i.test(channelRole),
    channelBaseUrl: normalizeBaseUrl(candidate.baseUrl),
    channelAttempt: index + 1,
    channelCandidateCount: candidateCount,
    channelSignedRoute: true
  };
}

function imageParamsForCandidate(params, candidate) {
  const upstreamModel = candidate?.model || upstreamModelForChannel(candidate.baseUrl, params.model);
  return upstreamModel === params.model ? params : { ...params, model: upstreamModel };
}

function imageRequestVariantsForCandidate(params, files, candidate) {
  return buildImageRequestVariants(imageParamsForCandidate(params, candidate), files);
}

function imageUrlForCandidate(candidate, variant, hasImages) {
  if (!candidate?.usesSignedRoute) return `${candidate.baseUrl}${variant.path}`;
  const route = candidate.route || {};
  const raw = hasImages
    ? route.editUrl || route.edit_url || route.editsUrl || route.edits_url || route.url || route.path
    : route.generationUrl || route.generation_url || route.generationsUrl || route.generations_url || route.createUrl || route.create_url || route.url || route.path;
  return imageRouteUrl(raw, candidate.baseUrl, variant.path);
}

function imageApiKeyForCandidate(candidate, fallbackApiKey) {
  if (candidate?.usesSignedRoute && candidate.hasCredential) return "";
  if (candidate?.usesSignedRoute) return signedRouteCredential(candidate.route) || apiKeyForChannel(candidate.baseUrl, fallbackApiKey);
  return apiKeyForChannel(candidate.baseUrl, fallbackApiKey);
}

function imageHeadersForCandidate(candidate, channelApiKey, variantHeaders = {}) {
  const headers = { ...(candidate?.headers || {}) };
  const authHeaders = apiKeyHeadersForChannel(candidate?.baseUrl, channelApiKey);
  for (const [name, value] of Object.entries(authHeaders)) {
    if (value && !hasHeader(headers, name)) headers[name] = value;
  }
  return {
    ...headers,
    ...variantHeaders
  };
}

function rememberVideoRouteSession(taskId, route) {
  if (!taskId || !route?.hasCredential) return;
  const now = Date.now();
  for (const [id, session] of videoRouteSessions) {
    if (!session?.expiresAt || session.expiresAt <= now) videoRouteSessions.delete(id);
  }
  videoRouteSessions.set(taskId, {
    ...route,
    createUrl: "",
    expiresAt: now + VIDEO_ROUTE_SESSION_TTL_MS
  });
}

function videoRouteForStatus(taskId, fallbackBaseUrl, fallbackApiKey) {
  const now = Date.now();
  const session = videoRouteSessions.get(taskId);
  if (session?.expiresAt > now) {
    return {
      ...session,
      statusUrl: videoStatusUrlFromRoute(session, taskId)
    };
  }
  if (session) videoRouteSessions.delete(taskId);
  const route = createVideoRouteFromBillingTask(null, fallbackBaseUrl, fallbackApiKey);
  return {
    ...route,
    statusUrl: videoStatusUrlFromRoute(route, taskId)
  };
}

app.post("/api/videos/generations", async (req, res) => {
  const receivedAt = Date.now();
  const requestId = `vid_${receivedAt}_${Math.random().toString(36).slice(2, 9)}`;
  const apiKey = resolveApiKey(req.body?.apiKey);
  const fallbackBaseUrl = gatewayVideoBaseUrl();
  const params = normalizeVideoGenerationRequest(req.body || {});

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key" });
  }
  if (params.validationError === "missing_prompt") {
    return res.status(400).json({ ok: false, error: "missing_prompt", message: "缺少视频提示词" });
  }
  if (params.validationError === "invalid_duration") {
    return res.status(400).json({ ok: false, error: "invalid_duration", message: "当前视频模型不支持该时长" });
  }
  if (VIDEO_BILLING_GATEWAY_REQUIRED && !billingGatewayPolicy().enabled) {
    return res.status(503).json({
      ok: false,
      error: "video_billing_gateway_required",
      message: "视频计费网关未启用，请先接入静音中转站计费后再生成。"
    });
  }

  const body = createGatewayVideoBody(params);
  let abort = null;
  let forwardedAt = receivedAt;
  let billingTask = null;
  let route = null;

  try {
    try {
      billingTask = await prepareVideoBillingTask({
        requestId,
        customerApiKey: apiKey,
        params,
        metadata: {
          endpoint: "/api/videos/generations"
        }
      });
      if (billingTask?.enabled) {
        await writeGenerationLog({
          time: new Date().toISOString(),
          requestId,
          ok: true,
          stage: "billing-gateway-prepare-video",
          billingGatewayTaskId: billingTask.gatewayTaskId,
          hasRouteToken: Boolean(billingTask.routeToken),
          signedRoute: Boolean(billingTask.signedRoute)
        });
      }
    } catch (error) {
      const errorPayload = publicBillingErrorPayload(error, requestId);
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: false,
        stage: "billing-gateway-prepare-video",
        status: errorPayload.status,
        error: errorPayload.error,
        message: errorPayload.message
      });
      return res.status(errorPayload.status).json(errorPayload);
    }

    route = createVideoRouteFromBillingTask(billingTask, fallbackBaseUrl, apiKey);
    if (!route.hasCredential) {
      return res.status(400).json({
        ok: false,
        requestId,
        error: "video_channel_not_configured",
        message: billingTask?.enabled
          ? "视频通道未签发网关路由，请检查静音中转站的视频渠道配置。"
          : "视频通道未配置，请先在静音中转站启用视频模型路由。"
      });
    }

    abort = createAbortSignal(Math.max(60_000, Number.parseInt(process.env.VIDEO_REQUEST_TIMEOUT_MS || "120000", 10) || 120_000));
    forwardedAt = Date.now();

    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: true,
      stage: "forward-video-request",
      url: route.createUrl,
      channelId: route.channelId,
      channelRole: route.channelRole,
      requestedModel: params.model,
      duration: params.duration,
      resolution: params.resolution,
      aspectRatio: params.aspectRatio,
      width: params.width,
      height: params.height,
      hasApiKey: Boolean(apiKey),
      hasChannelApiKey: route.hasCredential,
      usesSignedRoute: route.usesSignedRoute,
      usesPrivateChannelKey: false,
      hasImageReference: Boolean(params.image),
      costEstimate: params.costEstimate
    });

    const response = await fetch(route.createUrl, {
      method: "POST",
      headers: {
        ...route.headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });
    const responseAt = Date.now();
    const parsed = await readTextSafely(response);
    const upstreamMessage = upstreamErrorMessage(parsed, response.status);
    const timing = {
      totalMs: Date.now() - receivedAt,
      channelWaitMs: responseAt - forwardedAt,
      parseMs: Date.now() - responseAt
    };

    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: response.ok,
      status: response.status,
      stage: "video-generate",
      url: route.createUrl,
      channelId: route.channelId,
      channelRole: route.channelRole,
      requestedModel: params.model,
      duration: params.duration,
      resolution: params.resolution,
      aspectRatio: params.aspectRatio,
      width: params.width,
      height: params.height,
      hasApiKey: Boolean(apiKey),
      hasChannelApiKey: route.hasCredential,
      usesSignedRoute: route.usesSignedRoute,
      usesPrivateChannelKey: false,
      hasImageReference: Boolean(params.image),
      costEstimate: params.costEstimate,
      timing,
      response: parsed.json ? { taskId: parsed.json.task_id || parsed.json.id || "", status: parsed.json.status || "" } : { textLength: parsed.text.length },
      ...(response.ok ? {} : {
        failureReason: publicVideoErrorCode(response.status, upstreamMessage),
        upstreamError: compactLogMessage(upstreamMessage, 900)
      })
    });

    if (!response.ok) {
      const error = publicVideoErrorCode(response.status, upstreamMessage);
      finalizeBillingInBackground(billingTask, {
        ok: false,
        status: isImageAuthError(response.status, upstreamMessage) ? 401 : response.status >= 500 ? 504 : response.status,
        error,
        message: publicVideoErrorMessage(response.status, upstreamMessage),
        usedModel: params.model,
        timingMs: timing.totalMs,
        attempts: [{
          channelId: route.channelId,
          channelRole: route.channelRole,
          status: response.status,
          ok: false,
          model: params.model,
          errorCode: error
        }]
      });
      return res.status(isImageAuthError(response.status, upstreamMessage) ? 401 : response.status >= 500 ? 504 : response.status).json({
        ok: false,
        requestId,
        error,
        message: publicVideoErrorMessage(response.status, upstreamMessage),
        timing
      });
    }

    const publicTask = publicVideoTaskPayload(parsed.json || {});
    rememberVideoRouteSession(publicTask.taskId, route);
    finalizeBillingInBackground(billingTask, {
      ok: true,
      status: response.status,
      usedChannel: {
        channelId: route.channelId,
        channelRole: route.channelRole,
        status: response.status,
        ok: true,
        model: params.model
      },
      usedModel: params.model,
      upstreamTaskId: publicTask.taskId,
      outputCount: publicTask.taskId ? 1 : 0,
      timingMs: timing.totalMs,
      attempts: [{
        channelId: route.channelId,
        channelRole: route.channelRole,
        status: response.status,
        ok: true,
        model: params.model
      }]
    });

    return res.json({
      ok: true,
      requestId,
      task: publicTask,
      timing,
      usedModel: params.model,
      duration: params.duration,
      resolution: params.resolution,
      aspectRatio: params.aspectRatio,
      costEstimate: params.costEstimate
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "视频接口等待超时" : error instanceof Error ? error.message : String(error);
    const status = error?.name === "AbortError" ? 504 : 502;
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: false,
      status,
      stage: "video-generate-error",
      url: route?.createUrl || "",
      channelId: route?.channelId || JINGYIN_VIDEO_GATEWAY_CHANNEL_ID,
      channelRole: route?.channelRole || "video-primary",
      requestedModel: params.model,
      duration: params.duration,
      resolution: params.resolution,
      aspectRatio: params.aspectRatio,
      hasApiKey: Boolean(apiKey),
      hasChannelApiKey: Boolean(route?.hasCredential),
      usesSignedRoute: Boolean(route?.usesSignedRoute),
      usesPrivateChannelKey: false,
      timing: {
        totalMs: Date.now() - receivedAt,
        channelWaitMs: Date.now() - forwardedAt,
        parseMs: 0
      },
      failureReason: publicVideoErrorCode(status, message),
      upstreamError: compactLogMessage(message, 900)
    });
    finalizeBillingInBackground(billingTask, {
      ok: false,
      status,
      error: publicVideoErrorCode(status, message),
      message: publicVideoErrorMessage(status, message),
      usedModel: params.model,
      timingMs: Date.now() - receivedAt,
      attempts: [{
        channelId: route?.channelId || JINGYIN_VIDEO_GATEWAY_CHANNEL_ID,
        channelRole: route?.channelRole || "video-primary",
        status,
        ok: false,
        model: params.model,
        errorCode: publicVideoErrorCode(status, message)
      }]
    });
    return res.status(status).json({
      ok: false,
      requestId,
      error: publicVideoErrorCode(status, message),
      message: publicVideoErrorMessage(status, message)
    });
  } finally {
    abort?.dispose();
  }
});

app.post("/api/videos/status", async (req, res) => {
  const receivedAt = Date.now();
  const taskId = String(req.body?.taskId || req.body?.id || "").trim();
  const requestId = `vid_status_${receivedAt}_${Math.random().toString(36).slice(2, 9)}`;
  const apiKey = resolveApiKey(req.body?.apiKey);

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key" });
  }
  if (!taskId) {
    return res.status(400).json({ ok: false, error: "missing_task_id", message: "缺少视频任务 ID" });
  }
  const route = videoRouteForStatus(taskId, gatewayVideoBaseUrl(), apiKey);
  if (!route.hasCredential) {
    return res.status(400).json({
      ok: false,
      error: "video_channel_not_configured",
      message: "视频通道未配置或任务签发路由已过期，请重新生成。"
    });
  }

  const url = route.statusUrl;
  const abort = createAbortSignal(Math.max(30_000, Number.parseInt(process.env.VIDEO_STATUS_TIMEOUT_MS || "60000", 10) || 60_000));
  const forwardedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: route.headers,
      signal: abort.signal
    });
    const responseAt = Date.now();
    const parsed = await readTextSafely(response);
    const upstreamMessage = upstreamErrorMessage(parsed, response.status);
    const timing = {
      totalMs: Date.now() - receivedAt,
      channelWaitMs: responseAt - forwardedAt,
      parseMs: Date.now() - responseAt
    };
    const statusTask = publicVideoTaskPayload(parsed.json || {}, taskId);

    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: response.ok,
      status: response.status,
      stage: "video-status",
      url,
      channelId: route.channelId,
      channelRole: route.channelRole,
      taskId,
      hasApiKey: Boolean(apiKey),
      hasChannelApiKey: route.hasCredential,
      usesSignedRoute: route.usesSignedRoute,
      usesPrivateChannelKey: false,
      timing,
      response: parsed.json
        ? {
            taskId: statusTask.taskId,
            status: statusTask.status || "",
            hasUrl: Boolean(statusTask.url),
            error: compactLogMessage(statusTask.error, 300)
          }
        : { textLength: parsed.text.length },
      ...(response.ok ? {} : {
        failureReason: publicVideoErrorCode(response.status, upstreamMessage),
        upstreamError: compactLogMessage(upstreamMessage, 900)
      })
    });

    if (!response.ok) {
      return res.status(isImageAuthError(response.status, upstreamMessage) ? 401 : response.status >= 500 ? 504 : response.status).json({
        ok: false,
        requestId,
        error: publicVideoErrorCode(response.status, upstreamMessage),
        message: publicVideoErrorMessage(response.status, upstreamMessage),
        timing
      });
    }

    return res.json({
      ok: true,
      requestId,
      task: statusTask,
      timing
    });
  } catch (error) {
    const message = error?.name === "AbortError" ? "视频状态查询超时" : error instanceof Error ? error.message : String(error);
    const status = error?.name === "AbortError" ? 504 : 502;
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: false,
      status,
      stage: "video-status-error",
      url,
      channelId: route.channelId,
      channelRole: route.channelRole,
      taskId,
      hasApiKey: Boolean(apiKey),
      hasChannelApiKey: route.hasCredential,
      usesSignedRoute: route.usesSignedRoute,
      usesPrivateChannelKey: false,
      timing: {
        totalMs: Date.now() - receivedAt,
        channelWaitMs: Date.now() - forwardedAt,
        parseMs: 0
      },
      failureReason: publicVideoErrorCode(status, message),
      upstreamError: compactLogMessage(message, 900)
    });
    return res.status(status).json({
      ok: false,
      requestId,
      error: publicVideoErrorCode(status, message),
      message: publicVideoErrorMessage(status, message)
    });
  } finally {
    abort.dispose();
  }
});

app.post("/api/quick-prompt-rewrite", upload.array("image", 6), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : (req.body || {});
  } catch {
    return res.status(400).json({ ok: false, message: "快捷生成提示词优化参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key，无法调用快捷生成文本模型" });
  }

  const files = (req.files || []).map((file, index) => ({ ...file, quickRole: "reference", quickIndex: index }));

  try {
    const plan = await createQuickPromptRewrite({
      input: payload,
      files,
      apiKey,
      baseUrls: channelBaseCandidates(apiKey)
    });
    res.json({ ok: true, ...plan });
  } catch (error) {
    const fallbackPrompt = quickPromptFallback(payload, files);
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "快捷生成文本模型优化失败",
      fallbackPrompt
    });
  }
});

app.post("/api/reference-prompt-rewrite", upload.fields([
  { name: "productImage", maxCount: 6 },
  { name: "referenceImage", maxCount: 6 }
]), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : (req.body || {});
  } catch {
    return res.status(400).json({ ok: false, message: "参考生图扩写参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key，无法调用参考生图文本模型" });
  }

  const files = [
    ...((req.files?.productImage || []).map((file, index) => ({ ...file, referenceRole: "product", referenceIndex: index }))),
    ...((req.files?.referenceImage || []).map((file, index) => ({ ...file, referenceRole: "reference", referenceIndex: index })))
  ];

  try {
    const plan = await createReferencePromptRewrite({
      input: payload,
      files,
      apiKey,
      baseUrls: channelBaseCandidates(apiKey)
    });
    res.json({ ok: true, ...plan });
  } catch (error) {
    const fallbackPrompt = localReferencePrompt(payload);
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "参考生图文本模型扩写失败",
      fallbackPrompt
    });
  }
});

app.get("/api/history", async (_req, res) => {
  const stored = await readHistoryResults();
  // P1 缺图自愈：读历史时顺带核对"归档文件是否还在"，把失效条目标记出来并落盘一次。
  // 只加标记、不删条目；标记过的条目不会重复写盘。
  const annotated = annotateHistoryIntegrity(stored);
  if (annotated.changed) {
    await ensureHistoryRepairBackup();
    await writeHistoryResults(annotated.items);
  }
  res.json({
    ok: true,
    results: annotated.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    integrity: {
      checked: annotated.items.length,
      missing: annotated.missingIds.length,
      missingIds: annotated.missingIds
    }
  });
});

/**
 * POST /api/history/repair —— 显式修复失效历史引用。
 *
 * 默认只做"标记"，**不会删除任何记录**（`dropMissing` 必须由用户显式传入 true 才清理）。
 * 第一次修复前会留一份 data/history.pre-repair-backup.json，保证可回退。
 */
app.post("/api/history/repair", async (req, res) => {
  const dropMissing = req.body?.dropMissing === true;
  const stored = await readHistoryResults();
  const annotated = annotateHistoryIntegrity(stored);
  const backupFile = annotated.changed || dropMissing ? await ensureHistoryRepairBackup() : "";
  let kept = annotated.items;
  let dropped = 0;
  if (dropMissing && annotated.missingIds.length > 0) {
    const missingSet = new Set(annotated.missingIds);
    kept = annotated.items.filter((item) => !missingSet.has(item.id));
    dropped = annotated.items.length - kept.length;
  }
  if (annotated.changed || dropped > 0) {
    await writeHistoryResults(kept, { replaceBackup: kept.length === 0 });
  }
  res.json({
    ok: true,
    checked: annotated.items.length,
    missing: annotated.missingIds.length,
    missingIds: annotated.missingIds,
    marked: annotated.changed ? annotated.missingIds.length : 0,
    dropped,
    remaining: kept.length,
    backupFile
  });
});

app.post("/api/history", async (req, res) => {
  const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
  if (incoming.length === 0) {
    return res.json({ ok: true, count: 0 });
  }

  const results = await appendHistoryResults(incoming);
  res.json({ ok: true, count: incoming.length, total: results.length, results });
});

app.delete("/api/history", async (req, res) => {
  const current = await readHistoryResults();
  if (req.body?.clear) {
    await writeHistoryResults([], { replaceBackup: true });
    return res.json({ ok: true, total: 0 });
  }

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const results = current.filter((item) => !ids.includes(item.id));
  await writeHistoryResults(results, { replaceBackup: results.length === 0 });
  res.json({ ok: true, total: results.length });
});

app.get("/api/history-image/:filename", async (req, res) => {
  try {
    const file = historyImagePath(req.params.filename);
    await streamLocalImageFile(req, res, file);
  } catch {
    res.status(404).json({ ok: false, message: "历史图片不存在" });
  }
});

app.get("/api/reference-asset/:filename", async (req, res) => {
  try {
    const file = referenceAssetPath(req.params.filename);
    await streamLocalImageFile(req, res, file);
  } catch {
    res.status(404).json({ ok: false, message: "reference_asset_not_found" });
  }
});

app.post("/api/canvas-assets", upload.array("image", 12), async (req, res) => {
  try {
    const files = (req.files || []).filter((file) => file?.buffer?.length);
    if (files.length === 0) {
      return res.status(400).json({ ok: false, message: "missing_canvas_assets" });
    }

    const createdAt = Date.now();
    // 现在直接回 data URL：前端把画布资源随请求带上就行，不需要服务端落盘。
    // （旧实现是写 data/canvas-assets 再回 /api/canvas-asset/xxx；那段代码已经删掉，
    //  但 GET /api/canvas-asset/:filename 路由保留，用于兼容历史链接。）
    return res.json({
      ok: true,
      assets: files.map((file, index) => {
        const mimeType = file.mimetype || mimeTypeFromFile(file.originalname || "");
        return {
          id: `canvas_asset_${createdAt}_${index}`,
          name: file.originalname || `canvas-${index + 1}.${imageExtensionFromType(mimeType, file.originalname)}`,
          filename: "",
          url: `data:${mimeType};base64,${file.buffer.toString("base64")}`,
          mimeType,
          size: file.size,
          createdAt: createdAt + index
        };
      })
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "canvas_asset_upload_failed"
    });
  }
});

app.get("/api/canvas-asset/:filename", async (req, res) => {
  try {
    await streamLocalImageFile(req, res, canvasAssetPath(req.params.filename));
  } catch {
    res.status(404).json({ ok: false, message: "canvas_asset_not_found" });
  }
});

app.get("/api/save-directory", async (_req, res) => {
  const directory = await setSaveDirectory(await getSaveDirectory());
  res.json({ ok: true, directory });
});

app.post("/api/save-directory", async (req, res) => {
  try {
    const directory = await setSaveDirectory(req.body?.directory);
    res.json({ ok: true, directory });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "保存目录设置失败"
    });
  }
});

app.post("/api/pick-directory", async (req, res) => {
  try {
    const directory = await pickDirectory(req.body?.directory);
    if (!directory) {
      return res.json({ ok: true, cancelled: true, directory: "" });
    }
    res.json({ ok: true, cancelled: false, directory });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "目录选择失败"
    });
  }
});

app.post("/api/open-save-directory", async (req, res) => {
  try {
    const directory = await openDirectory(req.body?.directory || await getSaveDirectory());
    res.json({ ok: true, directory });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "打开保存目录失败"
    });
  }
});

app.post("/api/detail-prompts", upload.fields([
  { name: "productImage", maxCount: 6 },
  { name: "referenceImage", maxCount: 6 }
]), async (req, res) => {
  try {
    const payload = req.body?.payload
      ? JSON.parse(req.body.payload)
      : (req.body || {});
    const files = [
      ...((req.files?.productImage || []).map((file, index) => ({ ...file, detailRole: "product", detailIndex: index }))),
      ...((req.files?.referenceImage || []).map((file, index) => ({ ...file, detailRole: "reference", detailIndex: index })))
    ];
    const apiKey = resolveApiKey(payload.apiKey);
    let aiPlan = null;
    let aiError = "";

    if (String(payload.analysisMode || "ai") === "ai" && apiKey) {
      try {
        aiPlan = await createDetailAiPlan({
          input: payload,
          files,
          apiKey,
          baseUrls: channelBaseCandidates()
        });
        await writeGenerationLog({
          time: new Date().toISOString(),
          ok: true,
          stage: "detail-ai-plan",
          model: aiPlan.model,
          usedBaseUrl: aiPlan.usedBaseUrl,
          mode: aiPlan.mode,
          timing: aiPlan.timing,
          attempts: aiPlan.attempts
        });
      } catch (error) {
        const rawAiError = error?.name === "AbortError"
          ? "详情 AI 分析超时"
          : error instanceof Error ? error.message : String(error);
        aiError = imageFailureMessage(error?.name === "AbortError" ? 504 : 502, rawAiError, payload, []);
        await writeGenerationLog({
          time: new Date().toISOString(),
          ok: false,
          stage: "detail-ai-plan",
          error: rawAiError,
          publicError: aiError
        });
      }
    }

    const group = await buildDetailPromptGroupV2(
      {
        ...payload,
        analysisMode: aiPlan?.ok ? "ai" : "local"
      },
      files,
      {
        aiPlan: aiPlan?.plan || null,
        aiMeta: aiPlan ? {
          model: aiPlan.model,
          mode: aiPlan.mode,
          timing: aiPlan.timing
        } : null,
        aiError
      }
    );
    res.json({ ok: true, group });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "详情提示词生成失败"
    });
  }
});

app.post("/api/save-image", async (req, res) => {
  try {
    const item = await itemWithArchivedImage(req.body?.item || req.body);
    const directory = await setSaveDirectory(req.body?.directory || await getSaveDirectory());
    const { buffer, mimeType, sourceUrl } = await imageBufferFromPayload(item.image);
    const { filename, target } = await writeJingyinNumberedImage(
      directory,
      buffer,
      imageExtensionFromType(mimeType, sourceUrl)
    );
    res.json({ ok: true, directory, filename, path: target, bytes: buffer.length });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "保存图片失败"
    });
  }
});

app.post("/api/save-processed-image", largeImageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, message: "缺少整理后的图片文件" });
    }

    const directory = await setSaveDirectory(req.body?.directory || await getSaveDirectory());
    const hasSubfolder = Object.prototype.hasOwnProperty.call(req.body || {}, "subfolder");
    const subfolder = hasSubfolder ? req.body.subfolder : "裁剪";
    const { filename, target } = await writeProcessedImage(
      directory,
      req.file.buffer,
      imageExtensionFromType(req.file.mimetype, req.file.originalname),
      subfolder
    );

    res.json({
      ok: true,
      directory,
      cropDirectory: String(subfolder ?? "").trim() ? path.join(directory, sanitizeSubfolderName(subfolder)) : directory,
      filename,
      path: target,
      bytes: req.file.size
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "保存整理后图片失败"
    });
  }
});

app.post("/api/cache-result-image", largeImageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ ok: false, message: "缺少结果图片文件" });
    }

    const safeTaskId = sanitizeFilePart(req.body?.taskId || "task");
    const ext = imageExtensionFromType(req.file.mimetype, req.file.originalname);
    const filename = `HZ-${new Date().getDate()}-${safeTaskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const target = outfitResultPath(filename);
    await mkdir(resultDir, { recursive: true });
    await writeFile(target, req.file.buffer, { flag: "wx" });
    scheduleResultCacheCleanup("post-result-write", RESULT_CACHE_POST_WRITE_CLEANUP_DELAY_MS);
    res.json({
      ok: true,
      filename,
      localUrl: outfitResultUrl(filename),
      bytes: req.file.size,
      mimeType: req.file.mimetype || mimeTypeFromFile(filename)
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error instanceof Error ? error.message : "缓存结果图片失败"
    });
  }
});

app.get("/api/result/:filename", async (req, res) => {
  try {
    const filename = path.basename(decodeURIComponent(req.params.filename || ""));
    const file = outfitResultPath(filename);
    if (!existsSync(file)) return res.status(404).end();
    await streamLocalImageFile(req, res, file, {
      contentType: mimeTypeFromFile(filename),
      cacheControl: RESULT_CACHE_CONTROL
    });
  } catch {
    res.status(404).end();
  }
});

app.post("/api/generate-outfit", wrapOutfitUpload(imageForwardUpload.fields([
  { name: "image", maxCount: IMAGE_UPLOAD_PARSE_CEILING },
  { name: "mask", maxCount: 1 }
])), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : {};
  } catch {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, message: "任务参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    await removeUploadedFiles(req.files);
    return res.status(401).json({ ok: false, message: "请先在设置里填写 API Key" });
  }
  const receivedAt = Date.now();
  const requestId = String(payload.taskId || `outfit_${receivedAt}_${Math.random().toString(36).slice(2, 8)}`);
  const uploaded = outfitUploadFileGroups(req);
  let files = uploaded.imageFiles || [];
  let maskFile = uploaded.maskFile || null;
  const errors = [];
  const attempts = [];
  const helperBaseCandidates = channelBaseCandidates();
  let poseAi = null;
  let promptPayload = payload;
  const pageNameForWorkflow = String(payload.pageName || "");
  const modelTitleForWorkflow = String(payload.uploadLabels?.model?.title || "");
  const clothingTitleForWorkflow = String(payload.uploadLabels?.clothing?.title || "");
  const referenceTitleForWorkflow = String(payload.uploadLabels?.reference?.title || "");
  const workflowText = [
    payload.workflowMode,
    pageNameForWorkflow,
    modelTitleForWorkflow,
    clothingTitleForWorkflow,
    referenceTitleForWorkflow
  ].join(" ");
  const customWorkflow = String(payload.workflowMode || "") === "custom"
    || /临时需求|自定义需求|批量需求|custom/i.test(pageNameForWorkflow);
  const localDetailWorkflow = String(payload.workflowMode || "") === "local-detail"
    || /局部回贴|局部贴回|局部细节|局部精修|local\s*detail/i.test(workflowText);
  const designDraftWorkflow = String(payload.workflowMode || "") === "design-draft"
    || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/i.test(workflowText);
  const faceSwapWorkflow = String(payload.workflowMode || "") === "face-swap"
    || /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(pageNameForWorkflow)
    || /人脸参考|脸部参考|人脸身份|脸部身份/i.test(workflowText)
    || (/目标人物图|人物图|模特图|原图/i.test(modelTitleForWorkflow)
      && /人脸参考|脸部参考|人脸身份|换脸|脸/i.test(clothingTitleForWorkflow));
  const poseRemixWorkflow = !faceSwapWorkflow && (
    String(payload.workflowMode || "") === "pose-remix"
    || /批量姿态|批量姿态图|姿态参考图|固定模特换姿势|固定模特|固定人物|固定成片|批量姿势|换姿势|姿势生成|姿势参考|pose/i.test(workflowText)
    || /固定母版成片|批量姿势参考图|只提取姿势/i.test(workflowText)
  );
  const outpaintWorkflow = String(payload.workflowMode || "") === "outpaint"
    || /批量扩图|扩图|扩画布|向下扩|下半身扩图|补全下半身|outpaint|expand/i.test(workflowText)
    || /待扩图原图|扩图参考图/i.test(workflowText);
  const randomBackgroundWorkflow = String(payload.workflowMode || "") === "random-background"
    || /随机背景|随机场景|随机实景|random\s*background/i.test(pageNameForWorkflow);
  const backgroundChangeWorkflow = !randomBackgroundWorkflow && (
    String(payload.workflowMode || "") === "background-change"
    || /换背景|換背景|背景更换|背景替换|换场景/i.test(pageNameForWorkflow)
    || /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitleForWorkflow)
    || (/人物图|人物照|人物|模特图|模特/i.test(modelTitleForWorkflow)
      && /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitleForWorkflow))
    || /PS贴回/i.test(workflowText)
  );
  const recolorWorkflow = String(payload.workflowMode || "") === "recolor"
    || /批量改色|改色|换色|服装改色|颜色替换|颜色参考|recolor/i.test(pageNameForWorkflow)
    || /改色服装参考图|目标颜色|颜色参考|颜色替换|换色/i.test(clothingTitleForWorkflow)
    || /改色服装参考图|目标颜色|颜色替换/i.test(workflowText);
  const whiteRefineWorkflow = String(payload.workflowMode || "") === "white-refine"
    || /批量白底精修|白底精修|白底图精修|服装精修|平铺精修|挂拍精修|去衣架|去掉衣架|white\s*refine/i.test(pageNameForWorkflow)
    || /批量平铺图|挂拍图|可选参考.*细节图|白底商品图|衣架去除/i.test(workflowText);
  const outfitWorkflow = !customWorkflow && !localDetailWorkflow && !poseRemixWorkflow && !outpaintWorkflow && !backgroundChangeWorkflow && !randomBackgroundWorkflow && !recolorWorkflow && !whiteRefineWorkflow && !designDraftWorkflow && !faceSwapWorkflow;
  if (!outpaintWorkflow) {
    maskFile = null;
  }
  const outfitReferenceMentioned = /图\s*3|图三|第三张|第三个|补充图|补充参考|参考图\s*3|reference\s*3/i.test([
    payload.prompt,
    payload.productNote
  ].join("\n"));
  if (outfitWorkflow && files.length > 2 && !outfitReferenceMentioned) {
    files = files.slice(0, 2);
    payload = { ...payload, referenceCount: 0 };
    promptPayload = payload;
  }
  if (localDetailWorkflow && !payload.localEdit?.enabled) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({
      ok: false,
      message: "局部回贴页需要先在图1缩略图下方设置局部回贴区域"
    });
  }

  const minRequiredFiles = outpaintWorkflow || whiteRefineWorkflow || randomBackgroundWorkflow ? 1 : 2;
  if (!Array.isArray(files) || files.length < minRequiredFiles) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({
      ok: false,
      message: faceSwapWorkflow
        ? "至少需要 1 张图1目标人物图和 1 张图2人脸参考图"
        : poseRemixWorkflow
          ? "至少需要 1 张图1姿态参考图和 1 张图2固定母版成片"
          : outpaintWorkflow
            ? "至少需要 1 张图1待扩图原图"
            : whiteRefineWorkflow
              ? "至少需要 1 张图1平铺图或挂拍图；图2参考图可选"
            : randomBackgroundWorkflow
              ? "至少需要 1 张图1人物图"
            : backgroundChangeWorkflow
              ? "至少需要 1 张人物图和 1 张场景图"
              : recolorWorkflow
                ? "至少需要 1 张图1原图和 1 张图2颜色参考图"
                : localDetailWorkflow
                  ? "至少需要 1 张图1待回贴图和 1 张图2细节结构参考图"
                  : "至少需要 1 张模特图和 1 张服装图"
    });
  }

  // 路由 + 能力校验必须排在智能介入之前。
  // 智能介入会带服务器 KEY 调上游（可能真实扣费），旧 channelId 不能等到那之后才拒绝。
  const preflightParams = normalizeImageRequest({
    ...payload,
    prompt: buildOutfitPrompt(payload),
    n: 1,
    source: "outfit"
  });
  const preflightRouting = validateImageRouting(preflightParams);
  if (!preflightRouting.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: preflightRouting.code || "invalid_channel", message: preflightRouting.message });
  }
  const preflightCapability = validateImageCapabilities(preflightParams, files);
  if (!preflightCapability.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: preflightCapability.code, message: preflightCapability.message });
  }

  const smartInterventionEnabled = !designDraftWorkflow
    && !customWorkflow
    && !poseRemixWorkflow
    && !outpaintWorkflow
    && !randomBackgroundWorkflow
    && !recolorWorkflow
    && !whiteRefineWorkflow
    && isSmartOutfitInterventionEnabled(payload.smartIntervention);

  if (smartInterventionEnabled) {
    const smartStartedAt = Date.now();
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: true,
      stage: "smart-intervention-start",
      endpoint: "/api/generate-outfit",
      workflowMode: payload.workflowMode || null,
      fileCount: files.length,
      uploadBytes: files.reduce((sum, file) => sum + file.size, 0),
      baseCandidateCount: helperBaseCandidates.length
    });
    try {
      poseAi = await createOutfitPoseAnchor({
        input: payload,
        modelFile: await ensureFileBuffer(files[0]),
        apiKey,
        baseUrls: helperBaseCandidates
      });
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: true,
        stage: "smart-intervention-finished",
        endpoint: "/api/generate-outfit",
        timingMs: Date.now() - smartStartedAt,
        model: poseAi.model || "",
        mode: poseAi.mode || "",
        attemptCount: Array.isArray(poseAi.attempts) ? poseAi.attempts.length : 0
      });
      promptPayload = {
        ...payload,
        smartIntervention: true,
        poseAnchorPrompt: poseAi.promptBlock
      };
    } catch (error) {
      poseAi = {
        ok: false,
        message: error?.name === "AbortError"
          ? (faceSwapWorkflow ? "头脸锚点分析超时，已回退到基础换脸 SKILL" : poseRemixWorkflow ? "母版锚点分析超时，已回退到基础换姿势 SKILL" : backgroundChangeWorkflow ? "人物锚点分析超时，已回退到基础换背景 SKILL" : "姿态分析超时，已回退到基础香蕉 SKILL")
          : error instanceof Error ? error.message : String(error)
      };
      await writeGenerationLog({
        time: new Date().toISOString(),
        requestId,
        ok: false,
        stage: "smart-intervention-failed",
        endpoint: "/api/generate-outfit",
        timingMs: Date.now() - smartStartedAt,
        error: poseAi.message
      });
    }
  }

  const params = normalizeImageRequest({
    ...promptPayload,
    prompt: buildOutfitPrompt(promptPayload),
    n: 1,
    source: "outfit"
  });
  const routing = validateImageRouting(params);
  if (!routing.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: routing.code || "invalid_channel", message: routing.message });
  }
  // 批量换装同样走 capabilities 最终校验（图片数量 / 单张大小 / 提示词长度 / 比例 / 尺寸）。
  const capability = validateImageCapabilities(params, files);
  if (!capability.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: capability.code, message: capability.message });
  }
  if (maskFile) {
    params.maskFile = maskFile;
  }
  const promptLog = imagePromptLogFields(params, promptPayload);
  // 注意（2026-09-25 审查）：这个信号前端确实在发（src/outfit-workflow.jsx 的
  // `deferAutoSave: Boolean(localEdit || taskIsOutpaint)`），但**这里算完没人用**。
  // V3 基线里同名字段（deferOutfitArchive）是拿来跳过服务端归档的；V11 架构变了：
  // 批量接口压根没有"写历史"这一步（persistGeneratedItemsInBackground 只被 /api/images 调用），
  // 服务端只做 HZ- 显示缓存，而 UI 依赖这个本地地址显示结果——照搬"跳过归档"会踩到显示契约。
  // 所以**先保留、不改保存时机**，等产品确认批量局部回贴/扩图到底要不要省掉这次归档。
  // 现状已被 scripts/verify/outfit-defer-autosave-check.mjs 钉住，改行为必须先让它红。
  // 这里**故意不加 `void`**：让 ESLint 继续报它未使用，等于把"这个问题还没定"留在门禁视野里。
  const deferOutfitAutoSave = Boolean(payload.deferAutoSave || payload.localEdit?.enabled);
  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0) + (maskFile?.size || 0);
  const baseCandidates = imageChannelBaseCandidates(params.model);
  let releaseImageSlot = null;
  let billingTask = null;

  writeGenerationLog({
    time: new Date().toISOString(),
    requestId,
    ok: true,
    stage: "local-outfit-request-prepared",
    endpoint: "/api/generate-outfit",
    workflowMode: payload.workflowMode || null,
    model: params.model,
    imageSize: params.imageSize,
    aspectRatio: params.aspectRatio,
    fileCount: files.length,
    hasMask: Boolean(maskFile),
    uploadBytes,
    localUploadParseMs: Math.max(0, receivedAt - (localGenerationRequestStartedAt.get(requestId) || receivedAt)),
    hasApiKey: Boolean(apiKey),
    smartIntervention: smartInterventionEnabled,
    masterFitLock: Boolean(promptPayload.masterFitLock),
    localEdit: Boolean(payload.localEdit?.enabled),
    imageConcurrency: {
      limit: IMAGE_CONCURRENCY_LIMIT,
      active: activeImageRequestCount,
      queued: imageRequestQueue.length
    }
  }).catch(() => {});

  try {
    const queueStartedAt = Date.now();
    releaseImageSlot = await acquireImageSlot(1);
    const queueWaitMs = Date.now() - queueStartedAt;
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: true,
      stage: "image-slot-acquired",
      endpoint: "/api/generate-outfit",
      weight: 1,
      queueWaitMs,
      imageConcurrency: {
        limit: IMAGE_CONCURRENCY_LIMIT,
        active: activeImageRequestCount,
        queued: imageRequestQueue.length
      }
    });
    const billing = await prepareImageBillingForRequest({
      requestId,
      apiKey,
      params,
      files,
      candidates: baseCandidates,
      metadata: {
        endpoint: "/api/generate-outfit",
        workflowMode: payload.workflowMode || null,
        localEdit: Boolean(payload.localEdit?.enabled),
        hasMask: Boolean(maskFile),
        smartIntervention: smartInterventionEnabled,
        masterFitLock: Boolean(promptPayload.masterFitLock)
      }
    });
    if (billing.errorPayload) {
      return res.status(billing.errorPayload.status).json({
        ...billing.errorPayload,
        errors: [billing.errorPayload.message],
        smartIntervention: smartInterventionEnabled,
        poseAi
      });
    }
    billingTask = billing.billingTask;
    const imageCandidates = imageCandidateEntries(baseCandidates, billingTask);

    baseLoop:
    for (const [baseIndex, candidate] of imageCandidates.entries()) {
      const channelLog = imageChannelLogForCandidate(candidate, baseIndex, imageCandidates.length);
      const channelApiKey = imageApiKeyForCandidate(candidate, apiKey);
      const usesPrivateChannelKey = Boolean((candidate.usesSignedRoute && candidate.hasCredential) || (channelApiKey && channelApiKey !== apiKey));
      const requestVariants = imageRequestVariantsForCandidate(params, files, candidate);
      for (const [variantIndex, variant] of requestVariants.entries()) {
        const url = imageUrlForCandidate(candidate, variant, files.length > 0);
        const body = await variant.createBody();
        const headers = imageHeadersForCandidate(candidate, channelApiKey, variant.headers);
        const abort = createAbortSignal(IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS);
        const forwardedAt = Date.now();
        try {
          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: true,
            stage: "forward-outfit-request",
            url,
            ...channelLog,
            attempt: attempts.length + 1,
            baseAttempt: baseIndex + 1,
            candidateCount: imageCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            requestedModel: params.model,
            requestedChannelId: params.channelId,
            model: variant.model,
            protocol: variant.protocol,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            ...promptLog,
            fileCount: files.length,
            hasMask: Boolean(maskFile),
            uploadBytes,
            hasApiKey: Boolean(apiKey),
            hasChannelApiKey: Boolean(channelApiKey) || candidate.hasCredential,
            usesPrivateChannelKey,
            usesSignedRoute: Boolean(candidate.usesSignedRoute),
            smartIntervention: smartInterventionEnabled,
            masterFitLock: Boolean(promptPayload.masterFitLock),
            workflowMode: payload.workflowMode || null
          });
          const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: abort.signal
          });
          const responseAt = Date.now();
          const parsed = await readTextSafely(response);
          const upstreamMessage = upstreamErrorMessage(parsed, response.status);
          const privateChannelAuthFault = !response.ok && shouldTreatPrivateChannelAuthAsChannelFault(candidate, response.status, upstreamMessage);
          const timing = {
            totalMs: Date.now() - receivedAt,
            channelWaitMs: responseAt - forwardedAt,
            parseMs: Date.now() - responseAt
          };
          attempts.push({
            url,
            ...channelLog,
            status: response.status,
            ok: response.ok,
            model: variant.model,
            requestFormat: variant.requestFormat,
            errorCode: response.ok ? "" : (privateChannelAuthFault ? "channel_timeout" : publicImageErrorCode(response.status, upstreamMessage)),
            message: compactLogMessage(upstreamMessage, 500)
          });

          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: response.ok,
            status: response.status,
            url,
            ...channelLog,
            stage: "generate-outfit",
            attempt: attempts.length,
            baseAttempt: baseIndex + 1,
            candidateCount: imageCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            requestedModel: params.model,
            requestedChannelId: params.channelId,
            model: variant.model,
            protocol: variant.protocol,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            ...promptLog,
            fileCount: files.length,
            hasMask: Boolean(maskFile),
            uploadBytes,
            hasApiKey: Boolean(apiKey),
            hasChannelApiKey: Boolean(channelApiKey) || candidate.hasCredential,
            usesPrivateChannelKey,
            usesSignedRoute: Boolean(candidate.usesSignedRoute),
            timing,
            smartIntervention: smartInterventionEnabled,
            masterFitLock: Boolean(promptPayload.masterFitLock),
            workflowMode: payload.workflowMode || null,
            customWorkflow,
            localDetailWorkflow,
            outpaintWorkflow,
            backgroundChangeWorkflow,
            randomBackgroundWorkflow,
            faceSwapWorkflow,
            localEdit: Boolean(payload.localEdit?.enabled),
            poseAi: poseAi ? {
              ok: poseAi.ok,
              model: poseAi.model,
              mode: poseAi.mode,
              totalMs: poseAi.timing?.totalMs,
              message: poseAi.message ? compactLogMessage(poseAi.message, 400) : undefined
            } : null,
            response: parsed.json ? summarizeResponse(parsed.json) : { textLength: parsed.text.length },
            ...(response.ok ? {} : {
              failureReason: privateChannelAuthFault ? "channel_timeout" : publicImageErrorCode(response.status, upstreamMessage),
              upstreamError: compactLogMessage(upstreamMessage, 900)
            })
          });

          if (!response.ok) {
            errors.push(`HTTP ${response.status} ${compactLogMessage(upstreamMessage, 500)} [${variant.model} / ${variant.requestFormat}]`);
            if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(response.status, upstreamMessage)) continue;
            if (baseIndex < imageCandidates.length - 1 && (privateChannelAuthFault || shouldTryNextChannel(response.status, upstreamMessage))) continue baseLoop;
            const publicPayload = publicImageErrorPayload({
              requestId,
              status: privateChannelAuthFault ? 504 : response.status,
              upstreamMessage: privateChannelAuthFault ? "private channel auth failed" : upstreamMessage,
              params,
              attempts
            });
            finalizeBillingInBackground(billingTask, {
              ok: false,
              status: publicPayload.status,
              error: publicPayload.error,
              message: publicPayload.message,
              usedModel: variant.model,
              timingMs: timing.totalMs,
              attempts
            });
            return res.status(publicPayload.status).json({
              ...publicPayload,
              errors: [publicPayload.message],
              smartIntervention: smartInterventionEnabled,
              poseAi
            });
          }

          const images = extractImagesFromResponse(parsed.json);
          if (!images.length) {
            errors.push(`渠道返回成功但没有图片 [${variant.model} / ${variant.requestFormat}]`);
            if (variantIndex < requestVariants.length - 1) continue;
            if (baseIndex < imageCandidates.length - 1 && shouldTryNextChannel(502, "渠道返回成功但没有图片")) continue baseLoop;
            const publicPayload = publicImageErrorPayload({
              requestId,
              status: 502,
              upstreamMessage: "渠道返回成功但没有图片",
              params,
              attempts
            });
            finalizeBillingInBackground(billingTask, {
              ok: false,
              status: publicPayload.status,
              error: publicPayload.error,
              message: publicPayload.message,
              usedModel: variant.model,
              timingMs: timing.totalMs,
              attempts
            });
            return res.status(publicPayload.status).json({
              ...publicPayload,
              errors: [publicPayload.message],
              smartIntervention: smartInterventionEnabled,
              poseAi
            });
          }

          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: true,
            stage: "upstream-outfit-images-ready",
            imageCount: images.length,
            timing,
            postParseMs: Date.now() - responseAt
          });
          const displayCacheStartedAt = Date.now();
          const displayImage = await cacheOutfitGeneratedImageForDisplay(images[0], requestId, RESULT_DISPLAY_CACHE_BLOCKING_TIMEOUT_MS);
          const displayCacheMs = Date.now() - displayCacheStartedAt;
          const hasLocalDisplayImage = String(displayImage?.localUrl || "").startsWith("/api/result/")
            || Boolean(displayImage?.resultArchiveFile);
          if (!hasLocalDisplayImage) {
            archiveOutfitGeneratedImageInBackground(images[0], requestId, "background-display-cache-outfit-result-image");
          }
          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: true,
            stage: "local-outfit-response-ready",
            imageCount: images.length,
            hasLocalDisplayImage,
            displayCacheMs,
            totalMs: Date.now() - receivedAt,
            upstreamChannelWaitMs: timing.channelWaitMs
          });
          finalizeBillingInBackground(billingTask, {
            ok: true,
            status: response.status,
            usedChannel: attempts[attempts.length - 1] || null,
            usedModel: variant.model,
            outputCount: images.length,
            timingMs: Date.now() - receivedAt,
            attempts
          });
          return res.json({
            ok: true,
            taskId: requestId,
            image: displayImage,
            prompt: params.prompt,
            timingMs: Date.now() - receivedAt,
            usedModel: params.model,
            autoSavePending: false,
            smartIntervention: smartInterventionEnabled,
            poseAi: poseAi ? {
              ok: poseAi.ok,
              model: poseAi.model || null,
              mode: poseAi.mode || null,
              timing: poseAi.timing || null
            } : null
          });
        } catch (error) {
          const errorMessage = error?.name === "AbortError" ? "图片接口等待超时" : error instanceof Error ? error.message : String(error);
          const failureStatus = error?.name === "AbortError" ? 504 : 502;
          errors.push(errorMessage);
          attempts.push({
            url,
            ...channelLog,
            status: failureStatus,
            ok: false,
            model: variant.model,
            requestFormat: variant.requestFormat,
            errorCode: error?.name === "AbortError" ? "channel_timeout" : "channel_error",
            message: compactLogMessage(errorMessage, 500)
          });
          if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(failureStatus, errorMessage)) continue;
          if (baseIndex < imageCandidates.length - 1 && shouldTryNextChannel(failureStatus, errorMessage)) continue baseLoop;
          const publicPayload = publicImageErrorPayload({
            requestId,
            status: failureStatus,
            upstreamMessage: errorMessage,
            params,
            attempts
          });
          finalizeBillingInBackground(billingTask, {
            ok: false,
            status: publicPayload.status,
            error: publicPayload.error,
            message: publicPayload.message,
            usedModel: variant.model,
            timingMs: Date.now() - receivedAt,
            attempts
          });
          return res.status(publicPayload.status).json({
            ...publicPayload,
            errors: [publicPayload.message],
            smartIntervention: smartInterventionEnabled,
            poseAi,
            timingMs: Date.now() - receivedAt
          });
        } finally {
          abort.dispose();
        }
      }
    }

    const upstreamMessage = primaryOutfitGenerationError(errors);
    const publicPayload = publicImageErrorPayload({
      requestId,
      status: 502,
      upstreamMessage,
      params,
      attempts
    });
    finalizeBillingInBackground(billingTask, {
      ok: false,
      status: publicPayload.status,
      error: publicPayload.error,
      message: publicPayload.message,
      usedModel: params.model,
      timingMs: Date.now() - receivedAt,
      attempts
    });
    res.status(publicPayload.status).json({
      ...publicPayload,
      errors: [publicPayload.message],
      smartIntervention: smartInterventionEnabled,
      poseAi,
      timingMs: Date.now() - receivedAt
    });
  } finally {
    releaseImageSlot?.();
    await removeUploadedFiles(req.files);
  }
});

// 中文注释：只分析当前图2上身母版一次，返回可编辑的固定版型规格，不参与图片生成。
app.post("/api/outfit-master-fit-analysis", upload.single("image"), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : {};
  } catch {
    return res.status(400).json({ ok: false, message: "母版分析参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    return res.status(401).json({ ok: false, message: "请先在设置里填写 API Key" });
  }
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ ok: false, message: "请先选择图2服装母版" });
  }

  const receivedAt = Date.now();
  try {
    const result = await createOutfitMasterFitSpec({
      input: payload,
      clothingFile: req.file,
      apiKey,
      baseUrls: channelBaseCandidates()
    });
    await writeGenerationLog({
      time: new Date().toISOString(),
      ok: true,
      stage: "outfit-master-fit-analysis",
      model: result.model,
      usedBaseUrl: result.usedBaseUrl,
      mode: result.mode,
      timing: result.timing,
      attempts: result.attempts,
      source: result.source
    });
    res.json({
      ok: true,
      model: result.model,
      mode: result.mode,
      timingMs: Date.now() - receivedAt,
      source: result.source,
      spec: result.masterFitSpec,
      promptBlock: result.promptBlock,
      fields: {
        garmentCategory: result.garmentCategory,
        silhouette: result.silhouette,
        shoulderNeckline: result.shoulderNeckline,
        sleeveCuff: result.sleeveCuff,
        sleeveWearing: result.sleeveWearing,
        closureState: result.closureState,
        buttonCountState: result.buttonCountState,
        zipperBeltState: result.zipperBeltState,
        necklineOpening: result.necklineOpening,
        tuckDrape: result.tuckDrape,
        waistFit: result.waistFit,
        upperHem: result.upperHem,
        lowerHem: result.lowerHem,
        material: result.material,
        details: result.details,
        wearingDriftBan: result.wearingDriftBan,
        driftBan: result.driftBan
      }
    });
  } catch (error) {
    const rawMessage = error?.name === "AbortError"
      ? "图2母版版型分析超时，请稍后重试"
      : error instanceof Error ? error.message : String(error);
    const publicPayload = publicImageErrorPayload({
      requestId: `master_fit_${receivedAt}`,
      status: error?.name === "AbortError" ? 504 : 502,
      upstreamMessage: rawMessage,
      attempts: []
    });
    await writeGenerationLog({
      time: new Date().toISOString(),
      ok: false,
      stage: "outfit-master-fit-analysis",
      timing: { totalMs: Date.now() - receivedAt },
      error: rawMessage,
      publicError: publicPayload.message
    });
    res.status(publicPayload.status).json({
      ok: false,
      error: publicPayload.error,
      message: publicPayload.message
    });
  }
});

// 中文注释：生成后可选 AI 质检，只标记结果和返修建议，不自动返修，方便先测试质检准确性。
app.post("/api/outfit-quality-check", upload.fields([
  { name: "image1", maxCount: 1 },
  { name: "image2", maxCount: 1 },
  { name: "result", maxCount: 1 },
  { name: "reference", maxCount: 6 }
]), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : {};
  } catch {
    return res.status(400).json({ ok: false, message: "AI质检参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    return res.status(401).json({ ok: false, message: "请先在设置里填写 API Key" });
  }

  const files = {
    image1: req.files?.image1?.[0] || null,
    image2: req.files?.image2?.[0] || null,
    result: req.files?.result?.[0] || null,
    reference: req.files?.reference || []
  };
  if (!files.image1?.buffer?.length || !files.image2?.buffer?.length || !files.result?.buffer?.length) {
    return res.status(400).json({ ok: false, message: "AI质检需要图1、图2和生成结果" });
  }

  const receivedAt = Date.now();
  try {
    const result = await createOutfitQualityCheck({
      input: payload,
      files,
      apiKey,
      baseUrls: channelBaseCandidates()
    });
    await writeGenerationLog({
      time: new Date().toISOString(),
      ok: true,
      stage: "outfit-quality-check",
      workflowMode: payload.workflowMode || null,
      pageName: payload.pageName || null,
      pass: result.pass,
      score: result.score,
      model: result.model,
      usedBaseUrl: result.usedBaseUrl,
      mode: result.mode,
      timing: result.timing,
      attempts: result.attempts
    });
    res.json({
      ok: true,
      pass: result.pass,
      score: result.score,
      summary: result.summary,
      issues: result.issues,
      repairPrompt: result.repairPrompt,
      faceQuality: result.faceQuality,
      poseMatch: result.poseMatch,
      outfitMatch: result.outfitMatch,
      model: result.model,
      mode: result.mode,
      timingMs: Date.now() - receivedAt
    });
  } catch (error) {
    const rawMessage = error?.name === "AbortError"
      ? "AI质检超时，请稍后重试"
      : error instanceof Error ? error.message : String(error);
    const publicPayload = publicImageErrorPayload({
      requestId: `quality_${receivedAt}`,
      status: error?.name === "AbortError" ? 504 : 502,
      upstreamMessage: rawMessage,
      attempts: []
    });
    await writeGenerationLog({
      time: new Date().toISOString(),
      ok: false,
      stage: "outfit-quality-check",
      workflowMode: payload.workflowMode || null,
      pageName: payload.pageName || null,
      timing: { totalMs: Date.now() - receivedAt },
      error: compactLogMessage(rawMessage, 600),
      publicError: publicPayload.message
    });
    res.status(publicPayload.status).json({
      ok: false,
      error: publicPayload.error,
      message: publicPayload.message
    });
  }
});

app.get("/api/image-proxy", async (req, res) => {
  let target;
  try {
    target = parseProxyTarget(req.query.url);
  } catch (error) {
    // 非白名单主机：直接回 403，**不发起任何上游请求**（避免无意义的 502 与等待）
    if (error instanceof Error && error.message === "blocked_image_host") {
      await writeAssetLog({
        time: new Date().toISOString(),
        ok: false,
        stage: "image-proxy-blocked-host",
        url: String(req.query.url || "").slice(0, 300),
        error: "blocked_image_host"
      }).catch(() => {});
      return res.status(403).json({ ok: false, message: "blocked_image_host" });
    }
    return res.status(400).json({ ok: false, message: "图片地址无效" });
  }
  void target;

  try {
    await streamExternalImageProxy(req, res, req.query.url, IMAGE_PROXY_TIMEOUT_MS);
    return;
  } catch (streamError) {
    if (res.headersSent) return;
    await writeAssetLog({
      time: new Date().toISOString(),
      ok: false,
      stage: "image-proxy-stream",
      url: String(req.query.url || "").slice(0, 500),
      error: streamError instanceof Error ? streamError.message : String(streamError || "")
    }).catch(() => {});
  }

  const imageDownload = await downloadExternalImageWithFallback(req.query.url, IMAGE_PROXY_TIMEOUT_MS).catch((error) => ({
    error
  }));
  if (res.headersSent) return;
  if (!imageDownload.error) {
    res.status(200);
    res.setHeader("Content-Type", imageDownload.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Length", String(imageDownload.buffer.length));
    res.end(imageDownload.buffer);
    return;
  }

  return res.status(502).json({
    ok: false,
    message: "图片下载失败，请检查结果图源是否可访问",
    error: imageDownload.error instanceof Error ? imageDownload.error.message : String(imageDownload.error || ""),
    rangeError: imageDownload.error?.rangeError instanceof Error ? imageDownload.error.rangeError.message : undefined
  });
});

app.post("/api/images", wrapOutfitUpload(imageForwardUpload.array("image", IMAGE_UPLOAD_PARSE_CEILING)), async (req, res) => {
  const receivedAt = Date.now();
  const files = req.files || [];
  const deferAutoSave = String(req.body?.deferAutoSave || "") === "1";
  const params = normalizeImageRequest(req.body);
  const routing = validateImageRouting(params);
  if (!routing.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: routing.code || "invalid_channel", message: routing.message });
  }
  // 服务端最终校验：图片数量 / 单张大小 / 提示词长度 / 比例 / 尺寸 / 质量 / 背景
  // 全部以 routing catalog 的 capabilities 为准，不依赖前端。
  const capability = validateImageCapabilities(params, files);
  if (!capability.ok) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: capability.code, message: capability.message });
  }
  const apiKey = resolveApiKey(req.body.apiKey);
  const candidates = imageChannelBaseCandidates(params.model);
  const requestId = String(req.headers["x-jingyin-client-request-id"] || `img_${receivedAt}_${Math.random().toString(36).slice(2, 9)}`);

  if (!apiKey) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key" });
  }
  if (!params.prompt) {
    await removeUploadedFiles(req.files);
    return res.status(400).json({ ok: false, error: "missing_prompt", message: "缺少提示词" });
  }

  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0);
  const promptLog = imagePromptLogFields(params, req.body || {});
  const attempts = [];
  let releaseImageSlot = null;
  let lastForwardedAt = receivedAt;
  let billingTask = null;

  writeGenerationLog({
    time: new Date().toISOString(),
    requestId,
    ok: true,
    stage: "local-api-images-request-prepared",
    endpoint: "/api/images",
    model: params.model,
    imageSize: params.imageSize,
    aspectRatio: params.aspectRatio,
    n: params.n,
    fileCount: files.length,
    uploadBytes,
    localUploadParseMs: Math.max(0, receivedAt - (localGenerationRequestStartedAt.get(requestId) || receivedAt)),
    hasApiKey: Boolean(apiKey),
    deferAutoSave,
    imageConcurrency: {
      limit: IMAGE_CONCURRENCY_LIMIT,
      active: activeImageRequestCount,
      queued: imageRequestQueue.length
    }
  }).catch(() => {});

  try {
    const queueStartedAt = Date.now();
    releaseImageSlot = await acquireImageSlot(params.n);
    const queueWaitMs = Date.now() - queueStartedAt;
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: true,
      stage: "image-slot-acquired",
      endpoint: "/api/images",
      weight: imageSlotWeight(params.n),
      queueWaitMs,
      imageConcurrency: {
        limit: IMAGE_CONCURRENCY_LIMIT,
        active: activeImageRequestCount,
        queued: imageRequestQueue.length
      }
    });
    const billing = await prepareImageBillingForRequest({
      requestId,
      apiKey,
      params,
      files,
      candidates,
      metadata: {
        endpoint: "/api/images",
        deferAutoSave
      }
    });
    if (billing.errorPayload) {
      return res.status(billing.errorPayload.status).json(billing.errorPayload);
    }
    billingTask = billing.billingTask;
    const imageCandidates = imageCandidateEntries(candidates, billingTask);

    baseLoop:
    for (const [baseIndex, candidate] of imageCandidates.entries()) {
      const channelLog = imageChannelLogForCandidate(candidate, baseIndex, imageCandidates.length);
      const channelApiKey = imageApiKeyForCandidate(candidate, apiKey);
      const usesPrivateChannelKey = Boolean((candidate.usesSignedRoute && candidate.hasCredential) || (channelApiKey && channelApiKey !== apiKey));
      const requestVariants = imageRequestVariantsForCandidate(params, files, candidate);
      for (const [variantIndex, variant] of requestVariants.entries()) {
        const url = imageUrlForCandidate(candidate, variant, files.length > 0);
        const body = await variant.createBody();
        const headers = imageHeadersForCandidate(candidate, channelApiKey, variant.headers);

        const forwardedAt = Date.now();
        lastForwardedAt = forwardedAt;
        const abort = createAbortSignal(IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS);
        try {
          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: true,
            stage: "forward-api-images-request",
            url,
            ...channelLog,
            attempt: attempts.length + 1,
            baseAttempt: baseIndex + 1,
            candidateCount: imageCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            protocol: variant.protocol,
            requestedModel: params.model,
            requestedChannelId: params.channelId,
            model: variant.model,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            ...promptLog,
            fileCount: files.length,
            uploadBytes,
            hasApiKey: Boolean(apiKey),
            hasChannelApiKey: Boolean(channelApiKey) || candidate.hasCredential,
            usesPrivateChannelKey,
            usesSignedRoute: Boolean(candidate.usesSignedRoute)
          });
          const response = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: abort.signal
          });
          const responseAt = Date.now();
          const parsed = await readTextSafely(response);
          const images = parsed.json ? extractImagesFromResponse(parsed.json) : [];
          const upstreamMessage = upstreamErrorMessage(parsed, response.status);
          const privateChannelAuthFault = !response.ok && shouldTreatPrivateChannelAuthAsChannelFault(candidate, response.status, upstreamMessage);
          const timing = {
            totalMs: Date.now() - receivedAt,
            channelWaitMs: responseAt - forwardedAt,
            parseMs: Date.now() - responseAt
          };
          const attempt = {
            url,
            ...channelLog,
            status: response.status,
            ok: response.ok,
            model: variant.model,
            requestFormat: variant.requestFormat,
            errorCode: response.ok ? "" : (privateChannelAuthFault ? "channel_timeout" : publicImageErrorCode(response.status, upstreamMessage)),
            message: compactLogMessage(upstreamMessage, 500)
          };
          attempts.push(attempt);

          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: response.ok,
            status: response.status,
            url,
            ...channelLog,
            attempt: attempts.length,
            baseAttempt: baseIndex + 1,
            candidateCount: imageCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            protocol: variant.protocol,
            requestedModel: params.model,
            requestedChannelId: params.channelId,
            model: variant.model,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            ...promptLog,
            fileCount: files.length,
            uploadBytes,
            hasApiKey: Boolean(apiKey),
            hasChannelApiKey: Boolean(channelApiKey) || candidate.hasCredential,
            usesPrivateChannelKey,
            usesSignedRoute: Boolean(candidate.usesSignedRoute),
            timing,
            response: parsed.json ? summarizeResponse(parsed.json) : { textLength: parsed.text.length },
            ...(response.ok ? {} : {
              failureReason: privateChannelAuthFault ? "channel_timeout" : publicImageErrorCode(response.status, upstreamMessage),
              upstreamError: compactLogMessage(upstreamMessage, 900)
            })
          });

          if (response.ok && images.length) {
            await writeGenerationLog({
              time: new Date().toISOString(),
              requestId,
              ok: true,
              stage: "upstream-api-images-ready",
              imageCount: images.length,
              timing,
              postParseMs: Date.now() - responseAt
            });
            const referenceAssets = await archiveReferenceAssets(files, req.body.referenceMeta, requestId);
            const historyItems = buildHistoryItems(images, params, files, requestId, timing, responseAt, referenceAssets);
            const displayCacheStartedAt = Date.now();
            const displayHistoryItems = await Promise.all(historyItems.map((item) => (
              historyItemForImmediateDisplay(item, requestId, RESULT_DISPLAY_CACHE_BLOCKING_TIMEOUT_MS)
            )));
            const displayCacheMs = Date.now() - displayCacheStartedAt;
            const localDisplayCount = displayHistoryItems.filter(hasHistoryDisplayArchive).length;
            if (!deferAutoSave) {
              persistGeneratedItemsInBackground(displayHistoryItems, requestId, "api-images-background-persist");
            }
            await writeGenerationLog({
              time: new Date().toISOString(),
              requestId,
              ok: true,
              stage: "local-api-images-response-ready",
              imageCount: images.length,
              localDisplayCount,
              displayCacheMs,
              totalMs: Date.now() - receivedAt,
              upstreamChannelWaitMs: timing.channelWaitMs
            });

            finalizeBillingInBackground(billingTask, {
              ok: true,
              status: response.status,
              usedChannel: attempt,
              usedModel: variant.model,
              outputCount: images.length,
              timingMs: timing.totalMs,
              attempts
            });

            return res.json({
              ok: true,
              requestId,
              images: displayHistoryItems.map((item) => item.image),
              historyItems: displayHistoryItems,
              autoSavedCount: 0,
              autoSavePending: !deferAutoSave && historyItems.length > 0,
              timing,
              usedModel: params.model,
              response: parsed.json ? summarizeResponse(parsed.json) : { textLength: parsed.text.length }
            });
          }

          const failureStatus = response.ok ? 502 : response.status;
          const failureMessage = response.ok ? "渠道返回成功但没有图片" : upstreamMessage;
          if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(failureStatus, failureMessage)) continue;
          if (baseIndex < imageCandidates.length - 1 && (privateChannelAuthFault || shouldTryNextChannel(failureStatus, failureMessage))) continue baseLoop;

          const publicPayload = publicImageErrorPayload({
            requestId,
            status: privateChannelAuthFault ? 504 : failureStatus,
            upstreamMessage: privateChannelAuthFault ? "private channel auth failed" : failureMessage,
            params,
            attempts
          });
          finalizeBillingInBackground(billingTask, {
            ok: false,
            status: publicPayload.status,
            error: publicPayload.error,
            message: publicPayload.message,
            usedModel: variant.model,
            timingMs: timing.totalMs,
            attempts
          });
          return res.status(publicPayload.status).json({
            ...publicPayload,
            timing
          });
        } catch (error) {
          const errorMessage = error?.name === "AbortError" ? "图片接口等待超时" : error instanceof Error ? error.message : String(error);
          const failureStatus = error?.name === "AbortError" ? 504 : 502;
          attempts.push({
            url,
            ...channelLog,
            status: failureStatus,
            ok: false,
            model: variant.model,
            requestFormat: variant.requestFormat,
            errorCode: error?.name === "AbortError" ? "channel_timeout" : "channel_error",
            message: compactLogMessage(errorMessage, 500)
          });
          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: false,
            status: failureStatus,
            url,
            ...channelLog,
            stage: "api-images-channel-error",
            attempt: attempts.length,
            baseAttempt: baseIndex + 1,
            candidateCount: imageCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            protocol: variant.protocol,
            requestedModel: params.model,
            requestedChannelId: params.channelId,
            model: variant.model,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            ...promptLog,
            fileCount: files.length,
            uploadBytes,
            hasApiKey: Boolean(apiKey),
            hasChannelApiKey: Boolean(channelApiKey) || candidate.hasCredential,
            usesPrivateChannelKey,
            usesSignedRoute: Boolean(candidate.usesSignedRoute),
            timing: {
              totalMs: Date.now() - receivedAt,
              channelWaitMs: Date.now() - forwardedAt,
              parseMs: 0
            },
            failureReason: error?.name === "AbortError" ? "channel_timeout" : "channel_error",
            upstreamError: compactLogMessage(errorMessage, 900)
          });
          if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(failureStatus, errorMessage)) continue;
          if (baseIndex < imageCandidates.length - 1 && shouldTryNextChannel(failureStatus, errorMessage)) continue baseLoop;
          const publicPayload = publicImageErrorPayload({
            requestId,
            status: failureStatus,
            upstreamMessage: errorMessage,
            params,
            attempts
          });
          const catchTiming = {
            totalMs: Date.now() - receivedAt,
            channelWaitMs: Date.now() - forwardedAt,
            parseMs: 0
          };
          finalizeBillingInBackground(billingTask, {
            ok: false,
            status: publicPayload.status,
            error: publicPayload.error,
            message: publicPayload.message,
            usedModel: variant.model,
            timingMs: catchTiming.totalMs,
            attempts
          });
          return res.status(publicPayload.status).json({
            ...publicPayload,
            timing: catchTiming
          });
        } finally {
          abort.dispose();
        }
      }
    }

    const publicPayload = publicImageErrorPayload({
      requestId,
      status: 502,
      upstreamMessage: "图片接口请求失败",
      params,
      attempts
    });
    finalizeBillingInBackground(billingTask, {
      ok: false,
      status: publicPayload.status,
      error: publicPayload.error,
      message: publicPayload.message,
      usedModel: params.model,
      timingMs: Date.now() - receivedAt,
      attempts
    });
    return res.status(publicPayload.status).json({
      ...publicPayload,
      timing: {
        totalMs: Date.now() - receivedAt,
        channelWaitMs: Date.now() - receivedAt,
        parseMs: 0
      }
    });
  } catch (error) {
    const timing = {
      totalMs: Date.now() - receivedAt,
      channelWaitMs: Date.now() - lastForwardedAt,
      parseMs: 0
    };
    const requestTargets = imageRequestLogTargets(params, files, candidates);
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: false,
      urls: requestTargets.map((target) => target.url),
      protocols: [...new Set(requestTargets.map((target) => target.protocol))],
      upstreamModels: [...new Set(requestTargets.map((target) => target.model))],
      requestFormats: [...new Set(requestTargets.map((target) => target.requestFormat))],
      model: params.model,
      imageSize: params.imageSize,
      aspectRatio: params.aspectRatio,
      fileCount: files.length,
      uploadBytes,
      hasApiKey: Boolean(apiKey),
      timing,
      attempts,
      error: error instanceof Error ? error.message : String(error)
    });
    const publicPayload = publicImageErrorPayload({
      requestId,
      status: error?.name === "AbortError" ? 504 : 502,
      upstreamMessage: error?.name === "AbortError" ? "图片接口等待超时" : error?.message || "图片接口请求失败",
      params,
      attempts
    });
    finalizeBillingInBackground(billingTask, {
      ok: false,
      status: publicPayload.status,
      error: publicPayload.error,
      message: publicPayload.message,
      usedModel: params.model,
      timingMs: timing.totalMs,
      attempts
    });
    return res.status(publicPayload.status).json({
      ...publicPayload,
      timing
    });
  } finally {
    releaseImageSlot?.();
    await removeUploadedFiles(req.files);
  }
});

async function attachFrontend() {
  if (process.env.NODE_ENV === "production") {
    const distDir = path.join(rootDir, "dist");
    const hasDiskFrontend = existsSync(path.join(distDir, "index.html"));
    if (hasDiskFrontend) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
      return;
    }
    app.get("*", (req, res, next) => {
      if (sendEmbeddedStaticAsset(req, res)) return;
      next();
    });
    return;
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
  app.get("*", async (req, res, next) => {
    try {
      const template = await readFile(path.join(rootDir, "index.html"), "utf8");
      const html = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });
}

function startResultCacheCleanupOnce() {
  if (resultCacheCleanupStarted) return;
  resultCacheCleanupStarted = true;
  startResultCacheCleanup();
}

function configureHttpServer(server) {
  server.requestTimeout = LOCAL_HTTP_TIMEOUT_MS;
  server.headersTimeout = LOCAL_HTTP_TIMEOUT_MS + 30000;
  server.keepAliveTimeout = 65000;
  server.timeout = LOCAL_HTTP_TIMEOUT_MS;
}

function listenOnPort(port, remainingFallbacks = PORT_FALLBACK_LIMIT) {
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Jingyin AI Canvas http://127.0.0.1:${port}`);
    startResultCacheCleanupOnce();
    openAppInBrowser(port);
  });
  configureHttpServer(server);
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE" && remainingFallbacks > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use, trying ${nextPort}.`);
      setTimeout(() => listenOnPort(nextPort, remainingFallbacks - 1), 100);
      return;
    }
    if (error?.code === "EADDRINUSE" && shouldAutoOpenBrowser()) {
      console.error(`Port ${port} is already in use. Opened the existing local app instead.`);
      openAppInBrowser(port);
      process.exitCode = 0;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  return server;
}

attachFrontend().then(() => {
  listenOnPort(PORT);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
