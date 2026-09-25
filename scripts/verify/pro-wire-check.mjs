// V11 香蕉 Pro 生图链路 wire 级验证（本地 mock 上游，不联网、不扣费）。
//
// 覆盖：
//   1. Pro 带参考图 → 必须走 JSON + image_urls 到 /v1/images/generations
//      （对齐 3.0 main.py:13428-13454 的带图路径）
//   2. 控制组 banana-2 → 仍然走 multipart /v1/images/edits（链路不变）
//   3. Pro 未提供 data URL（例如批量侧）→ 保守退回 multipart，不炸
//   4. mock 成功 / 上游超时 / HTTP 错误 / 图片 URL 坏 / 相对路径 五种响应下，
//      V11 都能返回、都能解除 loading，且给出可读错误
//
// 用法：node scripts/verify/pro-wire-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8891;
const APP_PORT = 8792;
// mock 上游挂住不返回时，让 V11 在 8 秒内自己超时（验证超时控制真的会解除等待）
const ATTEMPT_TIMEOUT_MS = 8000;
const FIXTURE_PROMPT = "wire check";
// mock 上游固定返回的那张 1x1 测试像素。按内容哈希认它，比按文件名可靠：
// 上一轮已经被删掉条目的归档图会变成孤儿文件，按 id 匹配就漏了。
const FIXTURE_PNG_SHA256 = "c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77";
// 测试实例自己用一套 data 目录（server/index.js:86 认这个环境变量），
// 这样 mock 出来的 1x1 测试图和历史条目根本不会写进用户的 data/。
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "pro-wire-check");

/**
 * 自清理：本脚本会让 V11 真实走完链路并把结果写进 data/history.json。
 * 那些结果是 1x1 的测试像素（红色），留在用户的结果列表里会变成"红卡片"。
 * 所以每次跑完都把 prompt === "wire check" 的条目和对应的归档图删掉。
 * 只删自己造的，不碰用户数据。
 */
function cleanupFixtureHistory() {
  const imageDir = path.join(ROOT, "data", "history-images");
  const historyPath = path.join(ROOT, "data", "history.json");

  // 先按内容哈希认出所有 mock 测试像素：比按文件名/按 prompt 可靠。
  const fixtureFiles = new Set();
  if (existsSync(imageDir)) {
    for (const name of readdirSync(imageDir)) {
      try {
        const hash = createHash("sha256").update(readFileSync(path.join(imageDir, name))).digest("hex");
        if (hash === FIXTURE_PNG_SHA256) fixtureFiles.add(name);
      } catch { /* ignore */ }
    }
  }

  // 条目要按两种特征删：prompt 是我们写的 "wire check"；
  // 另一种是 V11 的"历史图片"恢复条目——prompt 是空的，只能靠归档图内容认出来。
  let doomed = [];
  if (existsSync(historyPath)) {
    let items;
    try {
      items = JSON.parse(readFileSync(historyPath, "utf8"));
    } catch {
      items = null;
    }
    if (Array.isArray(items)) {
      const isFixture = (item) => String(item?.prompt || "") === FIXTURE_PROMPT
        || fixtureFiles.has(String(item?.image?.archiveFile || ""));
      doomed = items.filter(isFixture);
      if (doomed.length > 0) {
        writeFileSync(historyPath, JSON.stringify(items.filter((item) => !isFixture(item))), "utf8");
      }
    }
  }

  const deleted = new Set();
  const tryRemove = (name) => {
    try {
      // unlinkSync 而不是 rmSync：rmSync 在工作区路径上会静默无效（见 lib/sandbox.mjs）。
      unlinkSync(path.join(imageDir, name));
      deleted.add(name);
    } catch { /* ignore */ }
  };
  if (existsSync(imageDir)) {
    for (const item of doomed) {
      const base = String(item.id || "").replace(/_1$/, "");
      if (!base) continue;
      for (const name of readdirSync(imageDir)) {
        if (name.includes(base)) tryRemove(name);
      }
    }
    for (const name of fixtureFiles) tryRemove(name);
  }
  return { removed: doomed.length, files: deleted.size, deleted: [...deleted] };
}

/** 目录里还剩多少张 mock 测试像素（正常的收尾检查指标，应该是 0）。 */
function countFixturePixels() {
  const imageDir = path.join(ROOT, "data", "history-images");
  if (!existsSync(imageDir)) return 0;
  let n = 0;
  for (const name of readdirSync(imageDir)) {
    try {
      const hash = createHash("sha256").update(readFileSync(path.join(imageDir, name))).digest("hex");
      if (hash === FIXTURE_PNG_SHA256) n += 1;
    } catch { /* ignore */ }
  }
  return n;
}

// 开跑前先扫一遍用户 data/：万一历史版本跑测试留下了 mock 测试图，顺手清掉，不让它累积。
const preCleanup = cleanupFixtureHistory();
// 准备测试实例自己的数据目录。
freshSandbox(SANDBOX_ROOT);
// 中途抛错时的兜底清理；正常路径在文件末尾显式收尾（要等进程真的退出）。
installExitCleanup({ getChild: () => child, sandboxDir: SANDBOX_ROOT });

const captured = [];
let mockMode = "ok";

function collectMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  const fields = [];
  const files = [];
  if (!boundary) return { fields, files };
  const raw = buffer.toString("latin1");
  for (const part of raw.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd);
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const bodyStart = headerEnd + 4;
    const bodyEnd = part.lastIndexOf("\r\n");
    if (bodyEnd < bodyStart) continue;
    const value = part.slice(bodyStart, bodyEnd);
    if (filenameMatch) files.push({ field: nameMatch[1], filename: filenameMatch[1] });
    else fields.push({ name: nameMatch[1], value: value.length > 80 ? `${value.slice(0, 40)}...(len=${value.length})` : value });
  }
  return { fields, files };
}

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);
    const contentType = String(req.headers["content-type"] || "");
    const record = { at: Date.now(), url: req.url, method: req.method, mode: mockMode };
    if (/multipart\/form-data/i.test(contentType)) {
      const parsed = collectMultipart(buffer, contentType);
      record.protocol = "multipart";
      record.fields = parsed.fields;
      record.files = parsed.files;
    } else {
      record.protocol = "json";
      try { record.json = JSON.parse(buffer.toString("utf8")); } catch { record.json = {}; }
      if (Array.isArray(record.json.image_urls)) {
        record.imageUrlCount = record.json.image_urls.length;
        record.imageUrlSample = String(record.json.image_urls[0] || "").slice(0, 32);
      }
    }
    captured.push(record);

    if (mockMode === "timeout") return; // 故意不响应，验证 V11 的超时控制

    if (mockMode === "http500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream exploded", type: "server_error" } }));
      return;
    }
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    if (mockMode === "badurl") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url: "http://127.0.0.1:1/definitely-not-here.png" }] }));
      return;
    }
    if (mockMode === "relative") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url: "/v1/files/mock-relative.png" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ b64_json: png }] }));
  });
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function tinyPng(name) {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return new File([bytes], name, { type: "image/png" });
}

const COMPACT_DATA_URL = `data:image/jpeg;base64,${Buffer.from("v11-wire-check-compact-ref").toString("base64")}`;

async function callImages({ model, channelId, withDataUrls }) {
  const form = new FormData();
  form.set("apiKey", "sk-mock-not-real");
  form.set("model", model);
  form.set("channelId", channelId);
  form.set("dispatchMode", "manual");
  form.set("prompt", "wire check");
  form.set("imageSize", "2K");
  form.set("aspectRatio", "3:4");
  form.set("n", "1");
  form.append("image", tinyPng("model.png"), "model.png");
  form.append("image", tinyPng("clothing.png"), "clothing.png");
  if (withDataUrls) form.append("referenceDataUrl", COMPACT_DATA_URL);
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/images`, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ms: Date.now() - started,
    images: Array.isArray(payload?.images) ? payload.images.length : 0,
    error: payload?.error || "",
    message: String(payload?.message || "").slice(0, 90)
  };
}

const results = [];
let child = null;
try {
  await listen(mock, MOCK_PORT);
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      JINGYIN_PORT_FALLBACK_LIMIT: "0",
      IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS: String(ATTEMPT_TIMEOUT_MS),
      JINGYIN_GATEWAY_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      // 把测试实例的数据目录挪到 .codex-artifacts 里，绝不碰用户 data/。
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  const scenarios = [
    { name: "Pro line-10 JSON+image_urls", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "ok" },
    { name: "Pro line-09 JSON+image_urls", model: "nano-banana-pro", channelId: "silent-pro-line-09", withDataUrls: true, mode: "ok" },
    { name: "Pro 无 data URL 时退回 multipart", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: false, mode: "ok" },
    { name: "控制组 banana-2（链路不变）", model: "banana-2", channelId: "silent-banana-line-08", withDataUrls: false, mode: "ok" },
    { name: "控制组 tt-image-2（链路不变）", model: "tt-image-2", channelId: "silent-tt2-line-10", withDataUrls: false, mode: "ok" },
    { name: "mock 成功（Pro）", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "ok" },
    { name: "mock 上游挂住 → V11 超时", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "timeout" },
    { name: "mock HTTP 500", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "http500" },
    { name: "mock 图片 URL 不可达", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "badurl" },
    { name: "mock 相对路径 URL", model: "nano-banana-pro", channelId: "silent-pro-line-10", withDataUrls: true, mode: "relative" }
  ];

  for (const scenario of scenarios) {
    mockMode = scenario.mode;
    const before = captured.length;
    const call = await callImages(scenario);
    const received = captured.slice(before);
    const first = received[0] || {};
    const effective = first.protocol === "multipart"
      ? Object.fromEntries(first.fields.map((f) => [f.name, f.value]))
      : (first.json || {});
    results.push({
      name: scenario.name,
      mode: scenario.mode,
      model: scenario.model,
      channelId: scenario.channelId,
      httpStatus: call.status,
      totalMs: call.ms,
      imagesReturned: call.images,
      v11Error: call.error,
      v11Message: call.message,
      upstreamRequestCount: received.length,
      upstreamPath: first.url || "",
      upstreamProtocol: first.protocol || "",
      upstreamModel: effective.model || "",
      upstreamChannelId: effective.channelId || "",
      upstreamDispatchMode: effective.dispatchMode || "",
      upstreamManualModel: effective.manualModel || "",
      imageUrlCount: first.imageUrlCount || 0,
      fileFields: first.files ? first.files.map((f) => f.field) : []
    });
  }
} catch (error) {
  results.push({ fatal: error instanceof Error ? error.message : String(error) });
} finally {
  await stopChild(child);
  mock.close();
}

// 收尾：测试实例自己的数据目录整个删掉（mock 图和 mock 历史条目都在里面）。
// 同时再扫一次用户 data/，确认本次没往里写任何东西。
const cleanup = cleanupFixtureHistory();
const residue = countFixturePixels();
// 统计沙箱里落了几个归档图 / 几条历史，证明 mock 产物确实被隔离在沙箱里。
const sandboxImageDir = path.join(SANDBOX_ROOT, "data", "history-images");
const sandboxArchives = existsSync(sandboxImageDir) ? readdirSync(sandboxImageDir).length : 0;
const sandboxHistoryFile = path.join(SANDBOX_ROOT, "data", "history.json");
let sandboxHistoryEntries = 0;
try {
  const parsed = JSON.parse(readFileSync(sandboxHistoryFile, "utf8"));
  if (Array.isArray(parsed)) sandboxHistoryEntries = parsed.length;
} catch { /* ignore */ }
const sandboxRemoved = await removeSandbox(SANDBOX_ROOT);
const fixtureCleanup = {
  removed: cleanup.removed,
  files: cleanup.files,
  deleted: cleanup.deleted,
  preRunRemoved: preCleanup.removed,
  preRunFiles: preCleanup.files,
  userDataResidue: residue,
  sandboxArchives,
  sandboxHistoryEntries,
  sandboxRemoved,
  sandboxRoot: path.relative(ROOT, SANDBOX_ROOT)
};
console.log(JSON.stringify({ ok: results.every((r) => !r.fatal) && residue === 0, fixtureCleanup, results }, null, 2));
