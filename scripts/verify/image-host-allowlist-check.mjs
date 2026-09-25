// P1 收尾：图片地址白名单校验（纯规则 + 服务端代理闸门，本地 mock，不联网）。
//
// 规则（产品要求）：
//   允许：① 相对本地 API 地址（含经 /api/image-proxy 包装且目标合规的）
//        ② data: / blob:
//        ③ https://api.jingyin.online 的绝对地址
//   其它绝对地址一律判失效，前端不发请求；服务端代理也不再转发（403，不发起上游请求）。
//
// 覆盖：
//   A. 规则表：允许/拒绝各若干条（含"解代理"这条关键路径）
//   B. 结果卡片状态：非白名单地址 → src 为空（因此不会发请求）+ 可读原因
//   C. 服务端 /api/image-proxy：白名单主机放行、旧域名 403 且**没有发生任何上游请求**
//   D. 前后端白名单一致性（前端常量 vs 服务端渠道配置主机）
//
// 用法：node scripts/verify/image-host-allowlist-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { freshSandbox, removeTreeSync } from "./lib/sandbox.mjs";
import path from "node:path";
import process from "node:process";
import {
  ALLOWED_IMAGE_HOSTS,
  IMAGE_SOURCE_REASONS,
  classifyImageSource,
  isAllowedImageHost,
  unwrapImageProxyUrl
} from "../../src/shared/image-hosts.js";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8803;
const SANDBOX_ROOT = path.join(
  ROOT,
  ".codex-artifacts",
  `image-host-check-${Date.now().toString(36)}-${process.pid}`
);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

// ---------- A. 规则表 ----------
const ALLOW_CASES = [
  ["相对历史图", "/api/history-image/x.png"],
  ["相对结果图", "/api/result/x.png"],
  ["相对参考图", "/api/reference-asset/x.png"],
  ["data URL", "data:image/png;base64,AAAA"],
  ["blob URL", "blob:http://127.0.0.1:8787/abc"],
  ["官方中转站 https", "https://api.jingyin.online/v1/images/generated/a.png"],
  ["代理包装官方中转站", `/api/image-proxy?url=${encodeURIComponent("https://api.jingyin.online/v1/images/generated/a.png")}`],
  ["代理包装官方中转站(带查询串)", `/api/image-proxy?url=${encodeURIComponent("https://api.jingyin.online/v1/images/generated/a.png?x=1&y=2")}`]
];
for (const [label, value] of ALLOW_CASES) {
  const verdict = classifyImageSource(value);
  check(`允许：${label}`, verdict.allowed === true, `${verdict.kind} / ${verdict.reason}`);
}

const BLOCK_CASES = [
  ["旧中转站 luckfill（直接）", "http://api.luckfill.com/v1/images/generated/a.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["旧中转站 luckfill（https）", "https://api.luckfill.com/v1/images/generated/a.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["预签名 S3 临时链接", "https://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["任意第三方域名", "https://example.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["scheme 相对地址", "//evil.example.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["javascript:", "javascript:alert(1)", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["file:", "file:///C:/x.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["空地址", "", IMAGE_SOURCE_REASONS.NO_SOURCE]
];
for (const [label, value, expectedReason] of BLOCK_CASES) {
  const verdict = classifyImageSource(value);
  check(`拒绝：${label}`,
    verdict.allowed === false && verdict.reason === expectedReason,
    `${verdict.kind} / ${verdict.reason}（期望 ${expectedReason}）`);
}

// 关键：代理包装的旧域名必须被拒绝（P1 实测的 3 个 502 就是这条路径）
{
  const proxied = `/api/image-proxy?url=${encodeURIComponent("http://api.luckfill.com/v1/images/generated/a.png")}`;
  const verdict = classifyImageSource(proxied);
  check("拒绝：代理包装的旧域名（解代理后判定）",
    verdict.allowed === false && verdict.reason === IMAGE_SOURCE_REASONS.BLOCKED_SCHEME,
    `${verdict.kind} / ${verdict.reason}`);
  const proxiedHttps = `/api/image-proxy?url=${encodeURIComponent("https://api.luckfill.com/v1/images/generated/a.png")}`;
  check("拒绝：代理包装的旧域名（https 版本）",
    classifyImageSource(proxiedHttps).allowed === false,
    JSON.stringify(classifyImageSource(proxiedHttps)));
  check("unwrapImageProxyUrl 能取出被代理地址",
    unwrapImageProxyUrl(proxied) === "http://api.luckfill.com/v1/images/generated/a.png",
    unwrapImageProxyUrl(proxied));
  check("unwrapImageProxyUrl 对非代理地址返回空",
    unwrapImageProxyUrl("/api/history-image/x.png") === "",
    "应为空");
}

check("isAllowedImageHost 大小写不敏感",
  isAllowedImageHost("API.Jingyin.Online") === true && isAllowedImageHost("api.luckfill.com") === false,
  "大小写与拒绝都正确");

// ---------- B. 结果卡片状态 ----------
const resultImage = await import("../../src/shared/result-image.js");
{
  const blockedImage = { type: "url", value: "https://api.luckfill.com/v1/images/generated/a.png", localUrl: "/api/image-proxy?url=http%3A%2F%2Fapi.luckfill.com%2Fv1%2Fimages%2Fgenerated%2Fa.png" };
  const state = resultImage.resultImageCardState(blockedImage, (image) => image.localUrl);
  check("结果卡片：非白名单地址 → src 为空（因此不发请求）",
    state.missing === true && state.src === "" && /不属于允许的来源|协议不被允许/.test(state.reason),
    JSON.stringify(state));

  const okImage = { type: "url", value: "/api/history-image/a.png", localUrl: "/api/history-image/a.png" };
  const okState = resultImage.resultImageCardState(okImage, (image) => image.localUrl);
  check("结果卡片：本地地址 → 正常返回 src",
    okState.missing === false && okState.src === "/api/history-image/a.png",
    JSON.stringify(okState));

  const relayImage = { type: "url", value: "https://api.jingyin.online/v1/images/generated/a.png" };
  const relayState = resultImage.resultImageCardState(relayImage, (image) => image.value);
  check("结果卡片：官方中转站地址 → 允许",
    relayState.missing === false && relayState.src.startsWith("https://api.jingyin.online/"),
    JSON.stringify(relayState));

  const markedImage = { missing: true, missingReason: "archive_missing", localUrl: "/api/history-image/gone.png" };
  const markedState = resultImage.resultImageCardState(markedImage, (image) => image.localUrl);
  check("结果卡片：服务端已标记的归档缺失 → 保留更具体的原因",
    markedState.missing === true && /本地归档文件已丢失/.test(markedState.reason),
    JSON.stringify(markedState));

  const blockedRef = { localUrl: "https://api.luckfill.com/x.png" };
  check("参考图：非白名单地址 → 不允许加载",
    resultImage.isAllowedReferenceImage(blockedRef, (reference) => reference.localUrl) === false,
    "应返回 false");
  const okRef = { localUrl: "/api/reference-asset/ok.png" };
  check("参考图：本地地址 → 允许加载",
    resultImage.isAllowedReferenceImage(okRef, (reference) => reference.localUrl) === true,
    "应返回 true");
}

// ---------- C. 服务端 /api/image-proxy 闸门 ----------
const upstreamHits = [];
const mock = http.createServer((req, res) => {
  upstreamHits.push(String(req.url || ""));
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
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

freshSandbox(SANDBOX_ROOT);

let child = null;
try {
  await listen(mock, 8804);

  // 故意把渠道基址指向本地 mock：这样"允许的主机"就是 127.0.0.1，
  // 用来验证白名单本身生效（放行白名单、拦截其它主机），而不是只验证某个具体域名。
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      JINGYIN_PORT_FALLBACK_LIMIT: "0",
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT,
      JINGYIN_GATEWAY_BASE_URL: "http://127.0.0.1:8804/v1"
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // C1) 白名单主机（=渠道基址所在主机）应放行并真的取到图
  const allowedUrl = "http://127.0.0.1:8804/v1/images/generated/ok.png";
  const allowedRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent(allowedUrl)}`);
  check("服务端代理：白名单主机放行（200 且拿到图片）",
    allowedRes.status === 200 && String(allowedRes.headers.get("content-type") || "").includes("image"),
    `status=${allowedRes.status} ct=${allowedRes.headers.get("content-type")}`);
  check("服务端代理：白名单请求确实转发到了上游",
    upstreamHits.some((u) => u.includes("ok.png")),
    upstreamHits.join(","));

  const hitsBefore = upstreamHits.length;

  // C2) 非白名单主机必须 403，且**不能**发起上游请求
  const blockedUrl = "http://api.luckfill.com/v1/images/generated/gone.png";
  const blockedRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent(blockedUrl)}`);
  const blockedBody = await blockedRes.json().catch(() => null);
  check("服务端代理：非白名单主机 → 403 blocked_image_host",
    blockedRes.status === 403 && blockedBody?.message === "blocked_image_host",
    `status=${blockedRes.status} body=${JSON.stringify(blockedBody)}`);
  check("服务端代理：被拦时**没有**发起任何上游请求",
    upstreamHits.length === hitsBefore,
    `上游请求数 before=${hitsBefore} after=${upstreamHits.length}`);

  // C3) 非法协议仍是 400（原有行为不变）
  const badRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent("ftp://x/y.png")}`);
  check("服务端代理：非法协议仍是 400", badRes.status === 400, `status=${badRes.status}`);
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
await new Promise((resolve) => setTimeout(resolve, 600));
let sandboxRemoved = false;
for (let attempt = 0; attempt < 6 && !sandboxRemoved; attempt += 1) {
  removeTreeSync(SANDBOX_ROOT);
  sandboxRemoved = !existsSync(SANDBOX_ROOT);
  if (!sandboxRemoved) await new Promise((resolve) => setTimeout(resolve, 600));
}

// ---------- D. 前后端白名单一致性 ----------
{
  const source = await import("node:fs").then((fs) => fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8"));
  const usesChannelConfig = /ALLOWED_IMAGE_PROXY_HOSTS[\s\S]{0,400}PRIMARY_CHANNEL_API_BASE_URL/.test(source);
  check("服务端白名单来自渠道配置（避免两处硬编码漂移）", usesChannelConfig, "已确认引用 PRIMARY_CHANNEL_API_BASE_URL");
  const channelConfig = await import("node:fs").then((fs) => fs.readFileSync(path.join(ROOT, "server", "channel-config.js"), "utf8"));
  const hosts = [...channelConfig.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1].toLowerCase());
  const uniqueHosts = [...new Set(hosts)];
  check("渠道配置里的主机都在前端白名单内（前端不会误拦真实渠道图）",
    uniqueHosts.every((host) => ALLOWED_IMAGE_HOSTS.includes(host)),
    `渠道主机=${uniqueHosts.join(",")} / 前端白名单=${ALLOWED_IMAGE_HOSTS.join(",")}`);
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  sandboxRemoved,
  allowlist: ALLOWED_IMAGE_HOSTS,
  failures: failed,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
