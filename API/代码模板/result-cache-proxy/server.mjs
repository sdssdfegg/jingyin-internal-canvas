import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CONFIG = {
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: process.env.RESULT_CACHE_PUBLIC_BASE_URL || "https://api.jingyin.online",
  cachePrefix: "/result-cache",
  cacheDir: process.env.RESULT_CACHE_DIR || "/www/wwwroot/jingyin-result-cache/files",
  dataDir: process.env.RESULT_CACHE_DATA_DIR || "/www/wwwroot/jingyin-result-cache/data",
  enabled: false,
  concurrency: Number(process.env.RESULT_CACHE_CONCURRENCY || 2),
  maxFileBytes: Number(process.env.RESULT_CACHE_MAX_FILE_BYTES || 100 * 1024 * 1024),
  downloadTimeoutMs: Number(process.env.RESULT_CACHE_DOWNLOAD_TIMEOUT_MS || 120000),
  servePendingTimeoutMs: Number(process.env.RESULT_CACHE_SERVE_PENDING_TIMEOUT_MS || 120000),
  allowOriginRedirectOnFailure: true,
  allowedHostPatterns: [],
  cleanup: {
    diskHighWatermarkPercent: 50,
    diskLowWatermarkPercent: 45,
    retentionDays: 7,
    intervalMs: 5 * 60 * 1000
  },
  adminToken: process.env.RESULT_CACHE_ADMIN_TOKEN || "",
  internalToken: process.env.RESULT_CACHE_INTERNAL_TOKEN || ""
};

const configPath = process.env.RESULT_CACHE_CONFIG || path.join(process.cwd(), "config.json");
let config = await loadConfig(configPath);
const statePath = path.join(config.dataDir, "state.json");
const waiters = new Map();
const queue = [];
const activeDownloads = new Set();
let state = { entries: {} };

await fs.mkdir(config.cacheDir, { recursive: true });
await fs.mkdir(config.dataDir, { recursive: true });
state = await loadState();
setInterval(() => cleanupOnce().catch((error) => log("cleanup_error", { error: String(error?.message || error) })), config.cleanup.intervalMs).unref();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(res, error.status, { error: error.message });
    }
    log("request_error", { error: String(error?.message || error), url: req.url });
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  log("server_started", {
    port: config.port,
    cacheDir: config.cacheDir,
    dataDir: config.dataDir,
    enabled: config.enabled
  });
});

async function route(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    const disk = await getDiskUsage(config.cacheDir).catch(() => null);
    return sendJson(res, 200, {
      ok: true,
      enabled: config.enabled,
      active_downloads: activeDownloads.size,
      queued_downloads: queue.length,
      disk
    });
  }

  if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    return sendHtml(res, adminHtml());
  }

  if (url.pathname.startsWith("/admin/")) {
    requireAdmin(req);
    if (req.method === "GET" && url.pathname === "/admin/status") {
      return sendJson(res, 200, await statusPayload());
    }
    if (req.method === "POST" && url.pathname === "/admin/toggle") {
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        return sendJson(res, 400, { error: "enabled_must_be_boolean" });
      }
      config.enabled = body.enabled;
      await saveRuntimeConfig();
      return sendJson(res, 200, await statusPayload());
    }
    if (req.method === "POST" && url.pathname === "/admin/cleanup") {
      const result = await cleanupOnce(true);
      return sendJson(res, 200, { ok: true, result, status: await statusPayload() });
    }
    return sendJson(res, 404, { error: "not_found" });
  }

  if (req.method === "POST" && url.pathname === "/cache/register") {
    requireInternal(req);
    const body = await readJson(req);
    const result = await registerUrl(body);
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname.startsWith(`${config.cachePrefix}/`)) {
    const id = decodeURIComponent(url.pathname.slice(config.cachePrefix.length + 1).split("/")[0] || "");
    return serveCached(id, req, res);
  }

  sendJson(res, 404, { error: "not_found" });
}

async function registerUrl(body) {
  if (!body || typeof body.url !== "string") {
    return { error: "url_required" };
  }

  if (!config.enabled) {
    return {
      cache_enabled: false,
      cache_status: "bypassed",
      image_url: body.url
    };
  }

  const originUrl = normalizeAndValidateUrl(body.url);
  const id = stableId(originUrl, body.task_id || "", body.file_id || "");
  const now = new Date().toISOString();
  let entry = state.entries[id];
  if (!entry) {
    entry = {
      id,
      originUrl,
      taskId: String(body.task_id || ""),
      fileId: String(body.file_id || ""),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      localPath: cachePathFor(id, originUrl),
      contentType: "",
      bytes: 0,
      sha256: "",
      attempts: 0,
      error: ""
    };
    state.entries[id] = entry;
    await saveState();
  }

  enqueue(entry);
  const waitMs = Math.max(0, Math.min(Number(body.wait_ms || 0), config.servePendingTimeoutMs));
  if (waitMs > 0) {
    await waitForEntry(id, waitMs);
    entry = state.entries[id] || entry;
  }

  return {
    cache_enabled: true,
    cache_status: entry.status,
    image_url: publicCacheUrl(id),
    cache_id: id
  };
}

async function serveCached(id, req, res) {
  const entry = state.entries[id];
  if (!entry) {
    return sendJson(res, 404, { error: "cache_entry_not_found" });
  }

  if (entry.status !== "ready") {
    enqueue(entry);
    await waitForEntry(id, config.servePendingTimeoutMs);
  }

  const latest = state.entries[id];
  if (latest?.status === "ready") {
    return serveFile(latest, req, res);
  }

  if (config.allowOriginRedirectOnFailure && latest?.originUrl) {
    res.writeHead(302, { Location: latest.originUrl, "Cache-Control": "no-store" });
    return res.end();
  }

  sendJson(res, 202, {
    status: latest?.status || "missing",
    cache_status: latest?.status || "missing",
    retry_after: 3
  });
}

async function serveFile(entry, req, res) {
  const stat = await fs.stat(entry.localPath).catch(() => null);
  if (!stat?.isFile()) {
    entry.status = "failed";
    entry.error = "cached_file_missing";
    entry.updatedAt = new Date().toISOString();
    await saveState();
    notify(entry.id);
    return sendJson(res, 404, { error: "cached_file_missing" });
  }

  const contentType = entry.contentType || "application/octet-stream";
  const range = parseRange(req.headers.range, stat.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=604800, immutable"
  };

  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    res.writeHead(206, headers);
    createReadStream(entry.localPath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  headers["Content-Length"] = String(stat.size);
  res.writeHead(200, headers);
  createReadStream(entry.localPath).pipe(res);
}

function enqueue(entry) {
  if (entry.status === "ready" || activeDownloads.has(entry.id) || queue.some((item) => item.id === entry.id)) return;
  entry.status = "queued";
  entry.updatedAt = new Date().toISOString();
  queue.push(entry);
  drainQueue();
}

function drainQueue() {
  while (activeDownloads.size < config.concurrency && queue.length > 0) {
    const entry = queue.shift();
    activeDownloads.add(entry.id);
    downloadEntry(entry)
      .catch((error) => {
        entry.status = "failed";
        entry.error = String(error?.message || error);
        entry.updatedAt = new Date().toISOString();
      })
      .finally(async () => {
        activeDownloads.delete(entry.id);
        await saveState().catch((error) => log("save_state_error", { error: String(error?.message || error) }));
        notify(entry.id);
        drainQueue();
      });
  }
}

async function downloadEntry(entry) {
  entry.status = "downloading";
  entry.attempts += 1;
  entry.updatedAt = new Date().toISOString();
  await saveState();
  notify(entry.id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.downloadTimeoutMs);
  const tmpPath = `${entry.localPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    const response = await fetch(entry.originUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "JingyinResultCache/1.0"
      }
    });
    if (!response.ok || !response.body) {
      throw new Error(`upstream_http_${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > config.maxFileBytes) {
      throw new Error("file_too_large");
    }

    await fs.mkdir(path.dirname(entry.localPath), { recursive: true });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const source = Readable.fromWeb(response.body);
    const sink = createWriteStream(tmpPath, { flags: "wx" });

    source.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > config.maxFileBytes) {
        source.destroy(new Error("file_too_large"));
        return;
      }
      hash.update(chunk);
    });

    await pipeline(source, sink);
    await fs.rename(tmpPath, entry.localPath);
    entry.status = "ready";
    entry.contentType = response.headers.get("content-type") || contentTypeFromPath(entry.localPath);
    entry.bytes = bytes;
    entry.sha256 = hash.digest("hex");
    entry.error = "";
    entry.updatedAt = new Date().toISOString();
    log("download_ready", { id: entry.id, bytes: entry.bytes, contentType: entry.contentType });
  } finally {
    clearTimeout(timer);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function cleanupOnce(force = false) {
  const now = Date.now();
  const maxAgeMs = config.cleanup.retentionDays * 24 * 60 * 60 * 1000;
  const entries = Object.values(state.entries);
  let deleted = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    const age = now - Date.parse(entry.createdAt || entry.updatedAt || 0);
    if (age > maxAgeMs && entry.status !== "downloading") {
      freedBytes += await deleteEntry(entry);
      deleted += 1;
    }
  }

  let disk = await getDiskUsage(config.cacheDir).catch(() => null);
  if (force || (disk && disk.usedPercent >= config.cleanup.diskHighWatermarkPercent)) {
    const oldest = Object.values(state.entries)
      .filter((entry) => entry.status !== "downloading")
      .sort((a, b) => Date.parse(a.createdAt || a.updatedAt || 0) - Date.parse(b.createdAt || b.updatedAt || 0));

    for (const entry of oldest) {
      disk = await getDiskUsage(config.cacheDir).catch(() => disk);
      if (!force && disk && disk.usedPercent <= config.cleanup.diskLowWatermarkPercent) break;
      freedBytes += await deleteEntry(entry);
      deleted += 1;
    }
  }

  await saveState();
  const afterDisk = await getDiskUsage(config.cacheDir).catch(() => null);
  return { deleted, freedBytes, disk: afterDisk };
}

async function deleteEntry(entry) {
  let size = entry.bytes || 0;
  const stat = await fs.stat(entry.localPath).catch(() => null);
  if (stat?.isFile()) size = stat.size;
  await fs.rm(entry.localPath, { force: true }).catch(() => {});
  delete state.entries[entry.id];
  return size;
}

function waitForEntry(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const set = waiters.get(id);
      if (set) set.delete(resolve);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id).add(done);
  });
}

function notify(id) {
  const set = waiters.get(id);
  if (!set) return;
  for (const resolve of set) resolve();
  waiters.delete(id);
}

function normalizeAndValidateUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_url");
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new HttpError(400, "unsupported_url_protocol");
  }
  if (!hostAllowed(parsed.hostname)) {
    throw new HttpError(400, "host_not_allowed");
  }
  return parsed.toString();
}

function hostAllowed(hostname) {
  const patterns = config.allowedHostPatterns || [];
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    }
    return hostname === pattern;
  });
}

function stableId(originUrl, taskId, fileId) {
  return crypto.createHash("sha256").update(`${taskId}\n${fileId}\n${originUrl}`).digest("hex").slice(0, 32);
}

function cachePathFor(id, originUrl) {
  const ext = safeExt(new URL(originUrl).pathname) || ".img";
  return path.join(config.cacheDir, id.slice(0, 2), `${id}${ext}`);
}

function safeExt(pathname) {
  const ext = path.extname(pathname || "").toLowerCase();
  if (/^\.(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(ext)) return ext;
  return "";
}

function contentTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif"
  };
  return map[ext] || "application/octet-stream";
}

function publicCacheUrl(id) {
  return `${config.publicBaseUrl.replace(/\/$/, "")}${config.cachePrefix}/${encodeURIComponent(id)}`;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireAdmin(req) {
  if (!config.adminToken) throw new HttpError(403, "admin_token_not_configured");
  const token = bearerToken(req) || req.headers["x-admin-token"];
  if (token !== config.adminToken) throw new HttpError(401, "invalid_admin_token");
}

function requireInternal(req) {
  if (!config.internalToken) throw new HttpError(403, "internal_token_not_configured");
  const token = bearerToken(req) || req.headers["x-cache-token"];
  if (token !== config.internalToken) throw new HttpError(401, "invalid_internal_token");
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || "";
}

async function statusPayload() {
  const entries = Object.values(state.entries);
  const disk = await getDiskUsage(config.cacheDir).catch(() => null);
  return {
    config: {
      ...config,
      adminToken: config.adminToken ? "[configured]" : "",
      internalToken: config.internalToken ? "[configured]" : ""
    },
    stats: {
      total: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      queued: entries.filter((entry) => entry.status === "queued").length,
      downloading: entries.filter((entry) => entry.status === "downloading").length,
      failed: entries.filter((entry) => entry.status === "failed").length,
      bytes: entries.reduce((sum, entry) => sum + Number(entry.bytes || 0), 0),
      active_downloads: activeDownloads.size,
      queued_downloads: queue.length
    },
    disk
  };
}

async function getDiskUsage(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  if (process.platform === "win32") {
    const bytes = await dirSize(targetPath);
    return { platform: "win32", cacheBytes: bytes, usedPercent: null };
  }
  const { stdout } = await execFileAsync("df", ["-Pk", targetPath]);
  const lines = stdout.trim().split(/\r?\n/);
  const parts = lines[lines.length - 1].split(/\s+/);
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);
  const availableKb = Number(parts[3]);
  const usedPercent = Number(String(parts[4]).replace("%", ""));
  return { totalKb, usedKb, availableKb, usedPercent, mount: parts[5] };
}

async function dirSize(dir) {
  let total = 0;
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) total += await dirSize(itemPath);
    if (item.isFile()) total += (await fs.stat(itemPath)).size;
  }
  return total;
}

async function loadConfig(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!text.trim()) return structuredClone(DEFAULT_CONFIG);
  const loaded = JSON.parse(text);
  return mergeConfig(DEFAULT_CONFIG, loaded);
}

function mergeConfig(base, override) {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof output[key] === "object") {
      output[key] = { ...output[key], ...value };
    } else {
      output[key] = value;
    }
  }
  output.port = Number(output.port);
  output.concurrency = Number(output.concurrency);
  output.maxFileBytes = Number(output.maxFileBytes);
  return output;
}

async function saveRuntimeConfig() {
  const persisted = { ...config };
  delete persisted.adminToken;
  delete persisted.internalToken;
  await fs.writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`);
}

async function loadState() {
  const text = await fs.readFile(statePath, "utf8").catch(() => "");
  if (!text.trim()) return { entries: {} };
  const parsed = JSON.parse(text);
  return parsed?.entries ? parsed : { entries: {} };
}

async function saveState() {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(tmp, statePath);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function adminHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Jingyin Result Cache</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:32px;max-width:760px}
button,input{font:inherit;padding:8px 10px;margin:4px 0}
pre{background:#111;color:#eee;padding:12px;overflow:auto}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
</style>
<h1>Jingyin Result Cache</h1>
<div class="row">
  <input id="token" type="password" placeholder="Admin token">
  <button onclick="loadStatus()">Status</button>
  <button onclick="toggle(true)">Enable</button>
  <button onclick="toggle(false)">Disable</button>
  <button onclick="cleanup()">Cleanup</button>
</div>
<pre id="out">Not loaded</pre>
<script>
const out = document.getElementById('out');
const tokenInput = document.getElementById('token');
const adminBase = location.pathname.startsWith('/result-cache-admin') ? '/result-cache-admin' : '/admin';
tokenInput.value = localStorage.resultCacheAdminToken || '';
function headers(){ localStorage.resultCacheAdminToken = tokenInput.value; return { 'Authorization':'Bearer '+tokenInput.value, 'Content-Type':'application/json' }; }
async function loadStatus(){ out.textContent = JSON.stringify(await (await fetch(adminBase+'/status',{headers:headers()})).json(), null, 2); }
async function toggle(enabled){ out.textContent = JSON.stringify(await (await fetch(adminBase+'/toggle',{method:'POST',headers:headers(),body:JSON.stringify({enabled})})).json(), null, 2); }
async function cleanup(){ out.textContent = JSON.stringify(await (await fetch(adminBase+'/cleanup',{method:'POST',headers:headers()})).json(), null, 2); }
</script>`;
}

function log(event, payload) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...payload }));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
