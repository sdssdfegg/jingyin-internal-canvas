import "dotenv/config";
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  CHANNEL_MODELS,
  buildImageRequestVariants,
  extractImagesFromResponse,
  normalizeBaseUrl,
  normalizeImageRequest,
  summarizeResponse
} from "./channel.js";
import { createDetailAiPlan } from "./detail-ai.js";
import { buildDetailPromptGroup as buildDetailPromptGroupV2 } from "./detail-middleware.js";
import { buildOutfitPrompt, primaryOutfitGenerationError } from "./outfit-skill.js";
import { createOutfitPoseAnchor } from "./outfit-pose-ai.js";
import { createQuickPromptRewrite, quickPromptFallback } from "./quick-prompt-ai.js";
import { createReferencePromptRewrite, localReferencePrompt } from "./reference-ai.js";
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
const appSettingsFile = path.join(dataDir, "app-settings.json");
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 12,
    fileSize: 25 * 1024 * 1024
  }
});

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const IMAGE_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_REQUEST_TIMEOUT_MS || "420000", 10);
const IMAGE_PROXY_TIMEOUT_MS = Number.parseInt(process.env.IMAGE_PROXY_TIMEOUT_MS || "120000", 10);
const GATEWAY_COMPRESSION_MIN_BYTES = Number.parseInt(process.env.GATEWAY_COMPRESSION_MIN_BYTES || "1024", 10);
const DOWNLOAD_CHUNK_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.DOWNLOAD_CHUNK_BYTES || "262144", 10) || 262144);
const textFromCodes = (codes) => String.fromCharCode(...codes);
const JINGYIN_GATEWAY_BASE_URL = textFromCodes([
  104, 116, 116, 112, 115, 58, 47, 47, 97, 112, 105, 46, 106, 105, 110, 103, 121, 105, 110, 46, 111, 110, 108, 105, 110, 101, 47, 118, 49
]);
const LOCKED_CHANNEL_API_BASE_URLS = [
  JINGYIN_GATEWAY_BASE_URL
].map((url) => normalizeBaseUrl(url));
const PRIMARY_CHANNEL_API_BASE_URL = LOCKED_CHANNEL_API_BASE_URLS[0];
const FALLBACK_CHANNEL_API_BASE_URL = LOCKED_CHANNEL_API_BASE_URLS[1];
const successfulChannelByKey = new Map();
const IMAGE_CONCURRENCY_LIMIT = Math.max(1, Math.min(5, Number.parseInt(process.env.IMAGE_CONCURRENCY_LIMIT || "5", 10) || 5));
let activeImageRequestCount = 0;
const imageRequestQueue = [];
let saveFilenameLock = Promise.resolve();

app.use(express.json({ limit: "100mb" }));
app.use(gatewayCompressionMiddleware);

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

function openAppInBrowser() {
  if (!shouldAutoOpenBrowser()) return;
  const url = `http://127.0.0.1:${PORT}/`;
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
  await mkdir(logDir, { recursive: true });
  await appendFile(path.join(logDir, "generation.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
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

function canvasAssetUrl(filename) {
  return `/api/canvas-asset/${encodeURIComponent(filename)}`;
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
    ...(localUrl ? { localUrl } : {})
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

async function archiveIncomingHistoryItem(item) {
  const normalized = normalizeHistoryItem(item);
  if (!normalized?.image || normalized.image.archiveFile || String(normalized.image.localUrl || "").startsWith("/api/history-image/")) {
    return normalized;
  }
  if (normalized.image.type !== "b64_json") return normalized;

  try {
    const { buffer, mimeType, sourceUrl } = await imageBufferFromPayload(normalized.image);
    const ext = imageExtensionFromType(mimeType, sourceUrl);
    const baseName = sanitizeFilePart(normalized.id || `history_${Date.now()}`) || `history_${Date.now()}`;
    await mkdir(historyImageDir, { recursive: true });
    const target = await uniqueFilePath(historyImageDir, `${baseName}.${ext}`);
    await writeFile(target, buffer);
    const archiveFile = path.basename(target);
    return normalizeHistoryItem({
      ...normalized,
      image: {
        type: "url",
        value: historyImageUrl(archiveFile),
        archiveFile,
        archiveMime: mimeType,
        localUrl: historyImageUrl(archiveFile)
      }
    });
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
  const incoming = Array.isArray(files) ? files.filter((file) => file?.buffer?.length) : [];
  if (incoming.length === 0) return [];
  const metadata = parseReferenceMeta(rawMeta);
  const createdAt = Date.now();

  await mkdir(referenceAssetDir, { recursive: true });
  return Promise.all(incoming.map(async (file, index) => {
    const meta = metadata[index] && typeof metadata[index] === "object" ? metadata[index] : {};
    const ext = imageExtensionFromType(file.mimetype, file.originalname);
    const baseName = sanitizeFilePart(`${requestId}_ref_${index + 1}_${meta.name || file.originalname || "reference"}`);
    const target = await uniqueFilePath(referenceAssetDir, `${baseName}.${ext}`);
    await writeFile(target, file.buffer);
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

async function imageBufferFromPayload(image) {
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
    const target = parseProxyTarget(image.value);
    const abort = createAbortSignal(IMAGE_PROXY_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        headers: { "User-Agent": "JingyinAI/0.1" },
        signal: abort.signal
      });
      if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "application/octet-stream",
        sourceUrl: image.value
      };
    } finally {
      abort.dispose();
    }
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

async function archiveHistoryItems(items) {
  const incoming = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  if (incoming.length > 0) {
    await appendHistoryResults(incoming);
  }
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
    }

    persistedItems.push(nextItem);
  }

  await appendHistoryResults(persistedItems);
  return { items: persistedItems, autoSavedCount };
}

function buildSaveFilename(_item, mimeType, sourceUrl) {
  const ext = imageExtensionFromType(mimeType, sourceUrl);
  return `JY.${ext}`;
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
  return String(requestKey || "")
    .replace(/^Bearer\s+/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
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

function shouldTryNextImageVariant(status, message) {
  if ([401, 403, 429].includes(status)) return false;
  if ([400, 404, 422, 500, 502, 503, 504].includes(status)) return true;
  return /model|unsupported|unknown|image_size|aspect_ratio|openai_error|upstream/i.test(String(message || ""));
}

function imageFailureMessage(status, upstreamMessage, params, attempts) {
  const message = compactLogMessage(upstreamMessage || `HTTP ${status}`, 600);
  const tried = attempts
    .map((attempt) => `${attempt.model || "unknown"} ${attempt.requestFormat || ""} -> HTTP ${attempt.status}`)
    .filter(Boolean)
    .join("；");
  if (status === 502 || /openai_error|upstream/i.test(message)) {
    return [
      `网关已收到请求，但上游模型调用失败：${message}`,
      `已尝试：${tried || params.model}`,
      "请检查 api.jingyin.online 后台这把 Key 是否启用了对应模型、渠道余额和上游账号状态。"
    ].join("\n");
  }
  if (/model_not_found|model.*not.*found|模型.*不存在|unsupported.*model/i.test(message)) {
    return [
      `当前网关模型不可用：${message}`,
      `已尝试：${tried || params.model}`,
      "请在 api.jingyin.online 后台确认模型别名是否启用。"
    ].join("\n");
  }
  return message;
}

function isSmartOutfitInterventionEnabled(value) {
  if (value === false) return false;
  const text = String(value ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no", "regular", "normal", "常规", "关闭"].includes(text);
}

function parseProxyTarget(rawUrl) {
  const target = new URL(String(rawUrl || ""));
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("unsupported_protocol");
  }
  return target;
}

function apiKeySignature(apiKey) {
  return createHash("sha256").update(String(apiKey || "")).digest("hex").slice(0, 16);
}

function isLockedChannelBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return LOCKED_CHANNEL_API_BASE_URLS.includes(normalized);
}

function channelBaseCandidates(apiKey) {
  const cachedBaseUrl = successfulChannelByKey.get(apiKeySignature(apiKey));
  return [
    isLockedChannelBaseUrl(cachedBaseUrl) ? cachedBaseUrl : "",
    ...LOCKED_CHANNEL_API_BASE_URLS
  ].filter((value, index, all) => value && all.indexOf(value) === index);
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

async function archiveOutfitGeneratedImage(image, taskId) {
  const payload = await imageBufferFromPayload(image);
  const ext = imageExtensionFromType(payload.mimeType, payload.sourceUrl);
  const safeTaskId = sanitizeFilePart(taskId || "task");
  const filename = `HZ-${new Date().getDate()}-${safeTaskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const target = outfitResultPath(filename);
  await mkdir(resultDir, { recursive: true });
  await writeFile(target, payload.buffer, { flag: "wx" });
  return {
    type: "local",
    filename,
    localUrl: outfitResultUrl(filename),
    bytes: payload.buffer.length,
    archiveMime: payload.mimeType,
    ...(payload.sourceUrl ? { sourceUrl: payload.sourceUrl } : {})
  };
}

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    defaultBaseUrl: PRIMARY_CHANNEL_API_BASE_URL,
    fallbackBaseUrl: "",
    hasServerKey: false,
    models: CHANNEL_MODELS
  });
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
  const results = await readHistoryResults();
  res.json({
    ok: true,
    results: results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
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

    void canvasAssetDir;
    const assets = [];
    for (const [index, file] of files.entries()) {
      const ext = imageExtensionFromType(file.mimetype, file.originalname);
      const filename = `canvas_${createdAt}_${index}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      void canvasAssetPath;
      assets.push({
        id: `canvas_asset_${createdAt}_${index}`,
        name: file.originalname || `canvas-${index + 1}.${ext}`,
        filename,
        url: canvasAssetUrl(filename),
        mimeType: file.mimetype || mimeTypeFromFile(filename),
        size: file.size,
        createdAt: createdAt + index
      });
    }

    res.json({ ok: true, assets });
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
          baseUrls: channelBaseCandidates(apiKey)
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
        aiError = error instanceof Error ? error.message : String(error);
        await writeGenerationLog({
          time: new Date().toISOString(),
          ok: false,
          stage: "detail-ai-plan",
          error: aiError
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
          usedBaseUrl: aiPlan.usedBaseUrl,
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

app.post("/api/save-processed-image", upload.single("image"), async (req, res) => {
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

app.get("/api/result/:filename", async (req, res) => {
  try {
    const filename = path.basename(decodeURIComponent(req.params.filename || ""));
    const file = outfitResultPath(filename);
    if (!existsSync(file)) return res.status(404).end();
    await streamLocalImageFile(req, res, file, { contentType: mimeTypeFromFile(filename) });
  } catch {
    res.status(404).end();
  }
});

app.post("/api/generate-outfit", upload.array("image", 12), async (req, res) => {
  let payload = {};
  try {
    payload = req.body?.payload ? JSON.parse(req.body.payload) : {};
  } catch {
    return res.status(400).json({ ok: false, message: "任务参数解析失败" });
  }

  const apiKey = resolveApiKey(payload.apiKey);
  if (!apiKey) {
    return res.status(401).json({ ok: false, message: "请先在设置里填写 API Key" });
  }
  const receivedAt = Date.now();
  const requestId = String(payload.taskId || `outfit_${receivedAt}_${Math.random().toString(36).slice(2, 8)}`);
  const files = req.files || [];
  const errors = [];
  const attempts = [];
  const baseCandidates = channelBaseCandidates(apiKey);
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
  const backgroundChangeWorkflow = String(payload.workflowMode || "") === "background-change"
    || /换背景|換背景|背景更换|背景替换|换场景/i.test(pageNameForWorkflow)
    || /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitleForWorkflow)
    || (/人物图|人物照|人物|模特图|模特/i.test(modelTitleForWorkflow)
      && /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitleForWorkflow))
    || /PS贴回/i.test(workflowText);
  const designDraftWorkflow = String(payload.workflowMode || "") === "design-draft"
    || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/i.test(workflowText);
  const faceSwapWorkflow = String(payload.workflowMode || "") === "face-swap"
    || /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(workflowText)
    || (/目标人物图|人物图|模特图|原图/i.test(modelTitleForWorkflow)
      && /人脸参考|脸部参考|人脸身份|换脸|脸/i.test(clothingTitleForWorkflow));
  const deferOutfitArchive = String(payload.deferAutoSave || "") === "1" || Boolean(payload.localEdit?.enabled);

  if (!Array.isArray(req.files) || req.files.length < 2) {
    return res.status(400).json({
      ok: false,
      message: faceSwapWorkflow
        ? "至少需要 1 张目标人物图和 1 张人脸参考图"
        : backgroundChangeWorkflow
          ? "至少需要 1 张人物图和 1 张场景图"
          : "至少需要 1 张模特图和 1 张服装图"
    });
  }

  const smartInterventionEnabled = !designDraftWorkflow && !customWorkflow && isSmartOutfitInterventionEnabled(payload.smartIntervention);

  if (smartInterventionEnabled) {
    try {
      poseAi = await createOutfitPoseAnchor({
        input: payload,
        modelFile: files[0],
        apiKey,
        baseUrls: baseCandidates
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
          ? (faceSwapWorkflow ? "头脸锚点分析超时，已回退到基础换脸 SKILL" : backgroundChangeWorkflow ? "人物锚点分析超时，已回退到基础换背景 SKILL" : "姿态分析超时，已回退到基础香蕉 SKILL")
          : error instanceof Error ? error.message : String(error)
      };
    }
  }

  const params = normalizeImageRequest({
    ...promptPayload,
    prompt: buildOutfitPrompt(promptPayload),
    n: 1,
    source: "outfit"
  });
  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0);
  const requestVariants = buildImageRequestVariants(params, files);
  let releaseImageSlot = null;

  try {
    releaseImageSlot = await acquireImageSlot(1);

    baseLoop:
    for (const [baseIndex, baseUrl] of baseCandidates.entries()) {
      for (const [variantIndex, variant] of requestVariants.entries()) {
        const url = `${baseUrl}${variant.path}`;
        const body = variant.createBody();
        const abort = createAbortSignal(IMAGE_REQUEST_TIMEOUT_MS);
        const forwardedAt = Date.now();
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...variant.headers
            },
            body,
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
          attempts.push({
            url,
            status: response.status,
            ok: response.ok,
            model: variant.model,
            requestFormat: variant.requestFormat,
            message: compactLogMessage(upstreamMessage, 500)
          });

          await writeGenerationLog({
            time: new Date().toISOString(),
            requestId,
            ok: response.ok,
            status: response.status,
            url,
            stage: "generate-outfit",
            attempt: attempts.length,
            baseAttempt: baseIndex + 1,
            candidateCount: baseCandidates.length,
            requestVariant: variant.id,
            requestFormat: variant.requestFormat,
            requestedModel: params.model,
            model: variant.model,
            protocol: variant.protocol,
            imageSize: params.imageSize,
            aspectRatio: params.aspectRatio,
            fileCount: files.length,
            uploadBytes,
            timing,
            smartIntervention: smartInterventionEnabled,
            workflowMode: payload.workflowMode || null,
            customWorkflow,
            backgroundChangeWorkflow,
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
            ...(response.ok ? {} : { upstreamError: compactLogMessage(upstreamMessage, 900) })
          });

          if (!response.ok) {
            errors.push(`HTTP ${response.status} ${compactLogMessage(upstreamMessage, 500)} [${variant.model} / ${variant.requestFormat}]`);
            if (response.status === 401 && baseIndex < baseCandidates.length - 1) continue baseLoop;
            if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(response.status, upstreamMessage)) continue;
            continue baseLoop;
          }

          const images = extractImagesFromResponse(parsed.json);
          if (!images.length) {
            errors.push(`渠道返回成功但没有图片 [${variant.model} / ${variant.requestFormat}]`);
            if (variantIndex < requestVariants.length - 1) continue;
            continue baseLoop;
          }

          successfulChannelByKey.set(apiKeySignature(apiKey), baseUrl);
          const archived = deferOutfitArchive ? images[0] : await archiveOutfitGeneratedImage(images[0], requestId);
          return res.json({
            ok: true,
            taskId: requestId,
            image: archived,
            prompt: params.prompt,
            timingMs: Date.now() - receivedAt,
            usedBaseUrl: baseUrl,
            usedModel: variant.model,
            usedRequestVariant: variant.id,
            smartIntervention: smartInterventionEnabled,
            poseAi: poseAi ? {
              ok: poseAi.ok,
              model: poseAi.model || null,
              mode: poseAi.mode || null,
              timing: poseAi.timing || null
            } : null
          });
        } catch (error) {
          errors.push(error?.name === "AbortError" ? "图片接口等待超时" : error instanceof Error ? error.message : String(error));
        } finally {
          abort.dispose();
        }
      }
    }

    res.status(502).json({
      ok: false,
      message: imageFailureMessage(502, primaryOutfitGenerationError(errors), params, attempts),
      errors,
      smartIntervention: smartInterventionEnabled,
      poseAi,
      attempts
    });
  } finally {
    releaseImageSlot?.();
  }
});

app.get("/api/image-proxy", async (req, res) => {
  let target;
  try {
    target = parseProxyTarget(req.query.url);
  } catch {
    return res.status(400).json({ ok: false, message: "图片地址无效" });
  }

  const abort = createAbortSignal(IMAGE_PROXY_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": "JingyinAI/0.1"
      },
      signal: abort.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(response.status).json({
        ok: false,
        message: text || `图片下载失败 HTTP ${response.status}`
      });
    }

    res.status(200);
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    const length = response.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);

    if (response.body) {
      await pipeline(Readable.fromWeb(response.body), res);
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        message: error?.name === "AbortError" ? "图片下载超时" : error?.message || "图片下载失败"
      });
    }
  } finally {
    abort.dispose();
  }
});

app.post("/api/images", upload.array("image", 6), async (req, res) => {
  const receivedAt = Date.now();
  const files = req.files || [];
  const params = normalizeImageRequest(req.body);
  const deferAutoSave = String(req.body?.deferAutoSave || "") === "1";
  const apiKey = resolveApiKey(req.body.apiKey);
  const candidates = channelBaseCandidates(apiKey);
  const requestVariants = buildImageRequestVariants(params, files);
  const requestId = `img_${receivedAt}_${Math.random().toString(36).slice(2, 9)}`;

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "missing_api_key", message: "缺少 API Key" });
  }
  if (!params.prompt) {
    return res.status(400).json({ ok: false, error: "missing_prompt", message: "缺少提示词" });
  }

  const uploadBytes = files.reduce((sum, file) => sum + file.size, 0);
  const attempts = [];
  let abort = null;
  let releaseImageSlot = null;
  let lastForwardedAt = receivedAt;

  try {
    releaseImageSlot = await acquireImageSlot(params.n);
    abort = createAbortSignal(IMAGE_REQUEST_TIMEOUT_MS);
    baseLoop:
    for (const [baseIndex, baseUrl] of candidates.entries()) {
      for (const [variantIndex, variant] of requestVariants.entries()) {
        const url = `${baseUrl}${variant.path}`;
        const body = variant.createBody();
        const headers = {
          Authorization: `Bearer ${apiKey}`,
          ...variant.headers
        };

        const forwardedAt = Date.now();
        lastForwardedAt = forwardedAt;
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
        const timing = {
          totalMs: Date.now() - receivedAt,
          channelWaitMs: responseAt - forwardedAt,
          parseMs: Date.now() - responseAt
        };
        const attempt = {
          url,
          status: response.status,
          ok: response.ok,
          model: variant.model,
          requestFormat: variant.requestFormat,
          message: compactLogMessage(upstreamMessage, 500)
        };
        attempts.push(attempt);

        await writeGenerationLog({
          time: new Date().toISOString(),
          requestId,
          ok: response.ok,
          status: response.status,
          url,
          attempt: attempts.length,
          baseAttempt: baseIndex + 1,
          candidateCount: candidates.length,
          requestVariant: variant.id,
          requestFormat: variant.requestFormat,
          protocol: variant.protocol,
          requestedModel: params.model,
          model: variant.model,
          imageSize: params.imageSize,
          aspectRatio: params.aspectRatio,
          fileCount: files.length,
          uploadBytes,
          hasApiKey: Boolean(apiKey),
          timing,
          response: parsed.json ? summarizeResponse(parsed.json) : { textLength: parsed.text.length },
          ...(response.ok ? {} : { upstreamError: compactLogMessage(upstreamMessage, 900) })
        });

        if (response.ok) {
          successfulChannelByKey.set(apiKeySignature(apiKey), baseUrl);
          const referenceAssets = await archiveReferenceAssets(files, req.body.referenceMeta, requestId);
          const historyItems = buildHistoryItems(images, params, files, requestId, timing, responseAt, referenceAssets);
          let persisted = { items: historyItems, autoSavedCount: 0 };
          if (historyItems.length > 0) {
            persisted = deferAutoSave
              ? { items: historyItems, autoSavedCount: 0 }
              : await persistGeneratedItems(historyItems);
          }

          return res.json({
            ok: true,
            requestId,
            images: persisted.items.map((item) => item.image),
            historyItems: persisted.items,
            autoSavedCount: persisted.autoSavedCount,
            timing,
            usedBaseUrl: baseUrl,
            usedModel: variant.model,
            usedRequestVariant: variant.id,
            attempts,
            response: parsed.json ? summarizeResponse(parsed.json) : { textLength: parsed.text.length }
          });
        }

        if (response.status === 401 && baseIndex < candidates.length - 1) continue baseLoop;
        if (variantIndex < requestVariants.length - 1 && shouldTryNextImageVariant(response.status, upstreamMessage)) continue;

        return res.status(response.status).json({
          ok: false,
          requestId,
          status: response.status,
          error: response.status === 401 ? "invalid_api_key" : parsed.json?.error?.code || "upstream_error",
          message: response.status === 401
            ? `渠道认证失败：已尝试 ${attempts.length} 个当前渠道地址，但都不接受这把 API Key。渠道返回：${upstreamMessage}`
            : imageFailureMessage(response.status, upstreamMessage, params, attempts),
          timing,
          attempts,
          raw: parsed.json || parsed.text
        });
      }
    }

    return res.status(502).json({
      ok: false,
      requestId,
      message: imageFailureMessage(502, "图片接口请求失败", params, attempts),
      attempts,
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
    await writeGenerationLog({
      time: new Date().toISOString(),
      requestId,
      ok: false,
      urls: candidates.flatMap((baseUrl) => requestVariants.map((variant) => `${baseUrl}${variant.path}`)),
      protocols: requestVariants.map((variant) => variant.protocol),
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
    return res.status(502).json({
      ok: false,
      requestId,
      message: error?.name === "AbortError" ? "图片接口等待超时" : error?.message || "图片接口请求失败",
      timing
    });
  } finally {
    abort?.dispose();
    releaseImageSlot?.();
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

attachFrontend().then(() => {
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`静音AI绘画 http://127.0.0.1:${PORT}`);
    openAppInBrowser();
  });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE" && shouldAutoOpenBrowser()) {
      openAppInBrowser();
      process.exitCode = 0;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
