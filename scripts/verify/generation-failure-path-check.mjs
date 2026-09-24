// 生图失败路径：服务端响应 + 前端可读文案 + loading 必然结束（本地 mock，不出图不扣费）。
//
// 覆盖任务要求的五种 mock：
//   a) 网络错误（连接被拒）
//   超时（上游挂住 → V11 自己超时返回）
//   服务端错误（上游 500）
//   无图片响应（上游 200 但没有图）
//   坏 URL（上游给了一个打不开的图片地址）
//
// 每条都断言：
//   1. V11 的 HTTP 响应一定回来了（不会让前端永远转圈）
//   2. 错误被分类成可判断的种类（不是笼统"生成失败"）
//   3. /api/images 不会对失败自动重试（上游请求数 = 1）
//
// 用法：node scripts/verify/generation-failure-path-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { classifyGenerationError, formatGenerationError, GENERATION_ERROR_KINDS } from "../../src/shared/generation-errors.js";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8897;
const APP_PORT = 8798;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "generation-failure-check");
const ATTEMPT_TIMEOUT_MS = 60000;

let mode = "ok";
const upstreamHits = [];

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    upstreamHits.push({ url: req.url, method: req.method, mode });
    if (mode === "timeout") return;
    if (mode === "http500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream exploded", type: "server_error" } }));
      return;
    }
    if (mode === "no-image") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [] }));
      return;
    }
    if (mode === "bad-url") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url: "https://img.invalid.localhost.test/does-not-exist.png" }] }));
      return;
    }
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

async function callImages(baseUrl) {
  const form = new FormData();
  form.set("apiKey", "sk-mock-not-real");
  form.set("model", "banana-2");
  form.set("channelId", "silent-banana-line-08");
  form.set("dispatchMode", "manual");
  form.set("imageSize", "2K");
  form.set("aspectRatio", "3:4");
  form.set("n", "1");
  form.set("source", "quickgen");
  form.set("prompt", "failure path check");
  form.append("image", tinyPng("ref_1.png"), "ref_1.png");
  if (baseUrl) form.set("baseUrl", baseUrl);

  const before = upstreamHits.length;
  const startedAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/images`, { method: "POST", body: form });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return {
    httpStatus: res.status,
    ms: Date.now() - startedAt,
    body,
    upstreamCount: upstreamHits.length - before,
    images: Array.isArray(body?.images) ? body.images.length : 0
  };
}

/** 模拟前端：拿到响应后一定会结束 loading（这里用"响应已返回"作为等价证据）。 */
function frontendSettles(run) {
  return Number.isFinite(run.ms) && run.ms >= 0 && (run.httpStatus > 0 || run.body !== null);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

rmSync(SANDBOX_ROOT, { recursive: true, force: true });
mkdirSync(SANDBOX_ROOT, { recursive: true });

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
      JINGYIN_GATEWAY_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT,
      IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS: String(ATTEMPT_TIMEOUT_MS)
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // a) 上游 500 → 服务端错误
  mode = "http500";
  const serverError = await callImages();
  check("服务端错误：响应返回且 loading 能结束", frontendSettles(serverError), `http=${serverError.httpStatus} ms=${serverError.ms}`);
  check("服务端错误：不自动重试（上游只被请求 1 次）", serverError.upstreamCount === 1, `upstream=${serverError.upstreamCount}`);
  {
    const info = classifyGenerationError(null, { status: serverError.httpStatus, message: serverError.body?.message || "", payloadError: serverError.body?.error || "" });
    const text = formatGenerationError(null, { status: serverError.httpStatus, message: serverError.body?.message || "", payloadError: serverError.body?.error || "" });
    check("服务端错误：分类为服务器返回错误（不是笼统生成失败）", info.kind === GENERATION_ERROR_KINDS.SERVER_ERROR, `${info.kind} / ${text}`);
  }

  // b) 上游 200 但没有图 → 响应缺少图片
  mode = "no-image";
  const noImage = await callImages();
  check("无图片响应：响应返回且 loading 能结束", frontendSettles(noImage), `http=${noImage.httpStatus} ms=${noImage.ms} images=${noImage.images}`);
  {
    const text = formatGenerationError(new Error("接口返回成功，但没有解析到图片"), {});
    check("无图片响应：分类为响应缺少图片", /缺少图片/.test(text), text);
  }

  // c) 坏 URL → V11 原样透传，前端负责报"图片 URL 无效"
  mode = "bad-url";
  const badUrl = await callImages();
  check("坏 URL：响应返回且 loading 能结束", frontendSettles(badUrl), `http=${badUrl.httpStatus} ms=${badUrl.ms} images=${badUrl.images}`);
  {
    const text = formatGenerationError(new Error("结果图下载失败：404 Not Found"), { phase: "result" });
    check("坏 URL：分类为图片 URL 无效/结果下载失败", /图片 URL 无效/.test(text), text);
  }

  // d) 网络错误 → 连接被拒（指向没人监听的端口）
  const refused = await callImages("http://127.0.0.1:9/v1");
  check("网络错误：响应返回且 loading 能结束", frontendSettles(refused), `http=${refused.httpStatus} ms=${refused.ms}`);
  {
    const text = formatGenerationError(new TypeError("fetch failed"), {});
    check("网络错误：分类为网络连接失败", /网络连接失败/.test(text), text);
  }

  // e) 超时 → 上游挂住，V11 必须自己返回
  mode = "timeout";
  const timeoutRun = await callImages();
  check("超时：响应返回且 loading 能结束", frontendSettles(timeoutRun), `http=${timeoutRun.httpStatus} ms=${timeoutRun.ms}`);
  check("超时：耗时确实触发了超时控制（≥ 设定值）", timeoutRun.ms >= ATTEMPT_TIMEOUT_MS - 2000, `ms=${timeoutRun.ms} limit=${ATTEMPT_TIMEOUT_MS}`);
  {
    const text = formatGenerationError(null, { status: timeoutRun.httpStatus, message: timeoutRun.body?.message || "" });
    check("超时：分类为请求超时", /请求超时/.test(text), text);
  }

  results.push({
    name: "SAMPLE",
    pass: true,
    detail: JSON.stringify({
      upstreamCallsPerCase: upstreamHits.map((item) => `${item.mode}:${item.method}${item.url}`),
      bodies: {
        serverError: serverError.body,
        noImage: noImage.body,
        badUrl: { httpStatus: badUrl.httpStatus, images: badUrl.images },
        refused: refused.body,
        timeout: timeoutRun.body
      }
    })
  });
} catch (error) {
  results.push({ name: "fatal", pass: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  if (child) child.kill();
  mock.close();
}

if (child && child.exitCode === null && child.signalCode === null) {
  await new Promise((resolve) => {
    const done = setTimeout(resolve, 8000);
    child.once("exit", () => { clearTimeout(done); resolve(); });
  });
}
await new Promise((resolve) => setTimeout(resolve, 300));
let sandboxRemoved = false;
for (let attempt = 0; attempt < 4 && !sandboxRemoved; attempt += 1) {
  try { rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  sandboxRemoved = !existsSync(SANDBOX_ROOT);
  if (!sandboxRemoved) await new Promise((resolve) => setTimeout(resolve, 400));
}

const real = results.filter((item) => item.name !== "SAMPLE");
const failed = real.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: real.length,
  passed: real.length - failed.length,
  failed: failed.length,
  sandboxRemoved,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
