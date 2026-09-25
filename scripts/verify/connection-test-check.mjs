// 「连接测试」验证（本地 mock 上游，不联网、不出图、不扣费）。
//
// 证明四件事：
//   1. 只向 mock 上游发 GET /v1/models，**没有任何生图请求**（不出现 /images/ 路径）
//   2. 请求里只有 Authorization 头，**没有上传任何图片**（无 multipart、无 body）
//   3. 成功 / 401 / 500 / 连不上 / 超时 五种上游表现都能给出 ok、状态码、耗时和可读原因
//   4. 响应里不回显 API Key / Authorization / 上游原始敏感信息
//
// 用法：node scripts/verify/connection-test-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { freshSandbox, removeTreeSync } from "./lib/sandbox.mjs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8895;
const APP_PORT = 8796;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "connection-test-check");
const FAKE_KEY = "sk-mock-connection-test-1234567890";

const captured = [];
let mode = "ok";

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);
    captured.push({
      url: req.url,
      method: req.method,
      contentType: String(req.headers["content-type"] || ""),
      authorization: String(req.headers.authorization || ""),
      bodyBytes: buffer.length
    });
    if (mode === "timeout") return;
    if (mode === "unauthorized") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid token for ${FAKE_KEY}` } }));
      return;
    }
    if (mode === "server-error") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "service unavailable" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "nano-banana-pro", object: "model" },
        { id: "banana-2", object: "model" },
        { id: "tt-image-2", object: "model" }
      ]
    }));
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

async function callConnectionTest({ baseUrl, apiKey }) {
  const before = captured.length;
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/connection-test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: baseUrl === undefined ? `http://127.0.0.1:${MOCK_PORT}/v1` : baseUrl,
      apiKey: apiKey === undefined ? FAKE_KEY : apiKey,
      model: "nano-banana-pro",
      channelId: "silent-pro-line-10"
    })
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { httpStatus: res.status, body, upstream: captured.slice(before), rawText: JSON.stringify(body || {}) };
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

freshSandbox(SANDBOX_ROOT);

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
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // ---- 1) 成功
  mode = "ok";
  const okRun = await callConnectionTest({});
  check("成功：HTTP 200 且 ok=true", okRun.httpStatus === 200 && okRun.body?.ok === true, `http=${okRun.httpStatus} ok=${okRun.body?.ok}`);
  check("成功：状态码 200 + 有耗时", okRun.body?.status === 200 && Number(okRun.body?.latencyMs) >= 0, `status=${okRun.body?.status} ms=${okRun.body?.latencyMs}`);
  check("成功：可读结果里带模型数量", /连接正常/.test(String(okRun.body?.message || "")), `msg=${okRun.body?.message}`);
  check("成功：只发了 1 个上游请求，且是 GET /v1/models",
    okRun.upstream.length === 1 && okRun.upstream[0].method === "GET" && okRun.upstream[0].url === "/v1/models",
    JSON.stringify(okRun.upstream));
  check("成功：请求体为空（没有上传图片 / 没有提示词）",
    okRun.upstream.every((item) => item.bodyBytes === 0 && !/multipart/i.test(item.contentType)),
    JSON.stringify(okRun.upstream.map((i) => ({ ct: i.contentType, bytes: i.bodyBytes }))));
  check("成功：请求带了 Bearer 鉴权头（用 key 真实探测线路）",
    okRun.upstream[0]?.authorization === `Bearer ${FAKE_KEY}`,
    `authLen=${String(okRun.upstream[0]?.authorization || "").length}`);
  check("成功：响应不回显 API Key / Authorization", !okRun.rawText.includes(FAKE_KEY) && !/Bearer\s+sk-/i.test(okRun.rawText), "rawText 已检查");

  // ---- 2) 关键安全断言：整个过程没有任何生图请求
  const anyImageCall = captured.some((item) => /\/images\//.test(item.url) || /generations|edits/i.test(item.url));
  check("全程没有调用生图接口（/images/... 一次都没有）", !anyImageCall, `captured=${captured.map((i) => i.url).join(",")}`);

  // ---- 3) 401
  mode = "unauthorized";
  const authRun = await callConnectionTest({});
  check("401：ok=false 且提示 Key 无效", authRun.body?.ok === false && /无效|无权限/.test(String(authRun.body?.message || "")), `msg=${authRun.body?.message}`);
  check("401：不回显上游原始 token 文案", !authRun.rawText.includes(FAKE_KEY), "rawText 已检查");

  // ---- 4) 上游 5xx
  mode = "server-error";
  const errorRun = await callConnectionTest({});
  check("上游 503：ok=false 且提示服务不可用", errorRun.body?.ok === false && /不可用/.test(String(errorRun.body?.message || "")), `msg=${errorRun.body?.message}`);
  check("上游 503：状态码被如实带回", errorRun.body?.status === 503, `status=${errorRun.body?.status}`);

  // ---- 5) 连不上（端口没人监听）
  const refusedRun = await callConnectionTest({ baseUrl: "http://127.0.0.1:9/v1" });
  check("连不上：ok=false 且给出可读失败原因", refusedRun.body?.ok === false && /连接失败/.test(String(refusedRun.body?.message || "")), `msg=${refusedRun.body?.message}`);

  // ---- 6) 地址不合法 / 缺 KEY 的入参校验
  const badUrl = await callConnectionTest({ baseUrl: "ftp://example.com" });
  check("非法地址：HTTP 400 + 可读提示", badUrl.httpStatus === 400 && /http/.test(String(badUrl.body?.message || "")), `http=${badUrl.httpStatus} msg=${badUrl.body?.message}`);
  const noKey = await callConnectionTest({ apiKey: "" });
  check("缺 KEY：HTTP 400 + 提示先填 KEY", noKey.httpStatus === 400 && /API Key/.test(String(noKey.body?.message || "")), `http=${noKey.httpStatus} msg=${noKey.body?.message}`);

  // ---- 7) 超时（mock 挂住），用短的 PROBE 超时验证会返回而不是永远挂住
  mode = "timeout";
  const timeoutStartedAt = Date.now();
  const timeoutRun = await callConnectionTest({});
  const timeoutMs = Date.now() - timeoutStartedAt;
  check("超时：ok=false、返回超时提示、不会永远挂住",
    timeoutRun.body?.ok === false && /超时/.test(String(timeoutRun.body?.message || "")) && timeoutMs < 30000,
    `ms=${timeoutMs} msg=${timeoutRun.body?.message}`);

  results.push({
    name: "SAMPLE",
    pass: true,
    detail: JSON.stringify({
      upstreamCalls: captured.map((item) => `${item.method} ${item.url} ct=${item.contentType || "-"} bytes=${item.bodyBytes}`),
      okMessage: okRun.body?.message,
      okLatencyMs: okRun.body?.latencyMs
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
  removeTreeSync(SANDBOX_ROOT);
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
