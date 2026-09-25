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
  IMAGE_SOURCE_REASONS,
  classifyImageSource,
  isPrivateOrLocalHost,
  isSafeRemoteImageUrl,
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

function tinyPng(name) {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return new File([bytes], name, { type: "image/png" });
}

// ---------- A. 规则表 ----------
// 政策（2026-09-25 修订）：生图 API 锁死官方中转；**图片回传不限域名**
// （中转后面挂 N 个渠道，各渠道成图在各自 CDN），只挡"非 https"与"本地/内网主机"。
// 下面两个 CDN 是线上实测出现过的真实结果图地址——它们曾因旧白名单被判 blocked_image_host，
// 导致"上游生成成功但前端拿不到图"（图片下载失败 HTTP 403）。这两条就是那个故障的回归用例。
const REAL_CDN_URLS = [
  "https://leo.yunshuaiapi.com/generated/2026/09/25/3205a025-68ff-4039-aae4-74b833668d53.png",
  "https://tos.lingkeai.vip/uploads/2026.09/26/20260926063927_18d8b174e102c28c423e.png"
];

const ALLOW_CASES = [
  ["相对历史图", "/api/history-image/x.png"],
  ["相对结果图", "/api/result/x.png"],
  ["相对参考图", "/api/reference-asset/x.png"],
  ["data URL", "data:image/png;base64,AAAA"],
  ["blob URL", "blob:http://127.0.0.1:8787/abc"],
  ["官方中转站 https", "https://api.jingyin.online/v1/images/generated/a.png"],
  ["任意 https 公网图床", "https://cdn.example.com/any/public.png"],
  ["真实渠道 CDN：leo.yunshuaiapi.com", REAL_CDN_URLS[0]],
  ["真实渠道 CDN：tos.lingkeai.vip", REAL_CDN_URLS[1]],
  ["代理包装真实渠道 CDN", `/api/image-proxy?url=${encodeURIComponent(REAL_CDN_URLS[0])}`],
  ["代理包装官方中转站", `/api/image-proxy?url=${encodeURIComponent("https://api.jingyin.online/v1/images/generated/a.png")}`],
  ["代理包装官方中转站(带查询串)", `/api/image-proxy?url=${encodeURIComponent("https://api.jingyin.online/v1/images/generated/a.png?x=1&y=2")}`]
];
for (const [label, value] of ALLOW_CASES) {
  const verdict = classifyImageSource(value);
  check(`允许：${label}`, verdict.allowed === true, `${verdict.kind} / ${verdict.reason}`);
}

const BLOCK_CASES = [
  ["旧中转站 luckfill（http，非 https）", "http://api.luckfill.com/v1/images/generated/a.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["预签名 S3 但用 http", "http://pre-signed-firefly-prod.s3-accelerate.amazonaws.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["scheme 相对地址", "//evil.example.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["javascript:", "javascript:alert(1)", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["file:", "file:///C:/x.png", IMAGE_SOURCE_REASONS.BLOCKED_SCHEME],
  ["空地址", "", IMAGE_SOURCE_REASONS.NO_SOURCE],
  // 本地 / 内网：一律拦（防 SSRF）；与"图片不限域名"不冲突
  ["localhost", "https://localhost/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["127.0.0.1", "https://127.0.0.1/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["10.x 内网", "https://10.0.0.5/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["192.168.x 内网", "https://192.168.1.10/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["172.16-31 内网", "https://172.16.5.5/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["云元数据 169.254", "https://169.254.169.254/latest/meta-data/", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["无点内网短名", "https://intranet/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  [".local 局域网名", "https://printer.local/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["IPv6 环回", "https://[::1]/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST],
  ["带凭据的地址", "https://user:pass@cdn.example.com/x.png", IMAGE_SOURCE_REASONS.BLOCKED_HOST]
];
for (const [label, value, expectedReason] of BLOCK_CASES) {
  const verdict = classifyImageSource(value);
  check(`拒绝：${label}`,
    verdict.allowed === false && verdict.reason === expectedReason,
    `${verdict.kind} / ${verdict.reason}（期望 ${expectedReason}）`);
}

// 关键：代理包装必须解开后再判定——内网目标同样要被拦（旧规则的 502 就是从这条路径漏过去的）
{
  const proxiedPrivate = `/api/image-proxy?url=${encodeURIComponent("http://127.0.0.1:8804/v1/images/generated/a.png")}`;
  const verdict = classifyImageSource(proxiedPrivate);
  check("拒绝：代理包装的内网目标（http → 先按协议拦）",
    verdict.allowed === false && verdict.reason === IMAGE_SOURCE_REASONS.BLOCKED_SCHEME,
    `${verdict.kind} / ${verdict.reason}`);
  const proxiedPrivateHttps = `/api/image-proxy?url=${encodeURIComponent("https://192.168.1.10/x.png")}`;
  const verdictHttps = classifyImageSource(proxiedPrivateHttps);
  check("拒绝：代理包装的内网目标（https → 按内网主机拦）",
    verdictHttps.allowed === false && verdictHttps.reason === IMAGE_SOURCE_REASONS.BLOCKED_HOST,
    `${verdictHttps.kind} / ${verdictHttps.reason}`);
  check("unwrapImageProxyUrl 能取出被代理地址",
    unwrapImageProxyUrl(proxiedPrivate) === "http://127.0.0.1:8804/v1/images/generated/a.png",
    unwrapImageProxyUrl(proxiedPrivate));
  check("unwrapImageProxyUrl 对非代理地址返回空",
    unwrapImageProxyUrl("/api/history-image/x.png") === "",
    "应为空");
}

check("isPrivateOrLocalHost：本地/内网判定（前后端共用）",
  isPrivateOrLocalHost("localhost") === true
    && isPrivateOrLocalHost("127.0.0.1") === true
    && isPrivateOrLocalHost("192.168.0.2") === true
    && isPrivateOrLocalHost("leo.yunshuaiapi.com") === false
    && isPrivateOrLocalHost("API.Jingyin.Online") === false,
  "本地/内网 true，公网域名 false");
check("isSafeRemoteImageUrl：https 公网放行、http 与内网拒绝",
  isSafeRemoteImageUrl(REAL_CDN_URLS[0]) === true
    && isSafeRemoteImageUrl(REAL_CDN_URLS[1]) === true
    && isSafeRemoteImageUrl("http://leo.yunshuaiapi.com/x.png") === false
    && isSafeRemoteImageUrl("https://10.1.2.3/x.png") === false,
  "公网 https / 非 https / 内网");

// ---------- B. 结果卡片状态 ----------
const resultImage = await import("../../src/shared/result-image.js");
{
  // 内网地址：卡片必须不发请求，并给出可读原因
  const blockedImage = { type: "url", value: "https://192.168.1.10/x.png", localUrl: "https://192.168.1.10/x.png" };
  const state = resultImage.resultImageCardState(blockedImage, (image) => image.localUrl);
  check("结果卡片：内网地址 → src 为空（因此不发请求）",
    state.missing === true && state.src === "" && /本机或内网|协议不被允许/.test(state.reason),
    JSON.stringify(state));

  // 回归：真实渠道 CDN（非官方中转域名）必须被允许显示——这是本次故障的核心
  const cdnImage = { type: "url", value: REAL_CDN_URLS[0], localUrl: REAL_CDN_URLS[0] };
  const cdnState = resultImage.resultImageCardState(cdnImage, (image) => image.localUrl);
  check("结果卡片：真实渠道 CDN（leo.yunshuaiapi.com）→ 允许显示",
    cdnState.missing === false && cdnState.src === REAL_CDN_URLS[0],
    JSON.stringify(cdnState));
  const cdnImage2 = { type: "url", value: REAL_CDN_URLS[1], localUrl: REAL_CDN_URLS[1] };
  const cdnState2 = resultImage.resultImageCardState(cdnImage2, (image) => image.localUrl);
  check("结果卡片：真实渠道 CDN（tos.lingkeai.vip）→ 允许显示",
    cdnState2.missing === false && cdnState2.src === REAL_CDN_URLS[1],
    JSON.stringify(cdnState2));

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

  const blockedRef = { localUrl: "https://10.0.0.9/x.png" };
  check("参考图：内网地址 → 不允许加载",
    resultImage.isAllowedReferenceImage(blockedRef, (reference) => reference.localUrl) === false,
    "应返回 false");
  const cdnRef = { localUrl: REAL_CDN_URLS[1] };
  check("参考图：真实渠道 CDN → 允许加载",
    resultImage.isAllowedReferenceImage(cdnRef, (reference) => reference.localUrl) === true,
    "应返回 true");
  const okRef = { localUrl: "/api/reference-asset/ok.png" };
  check("参考图：本地地址 → 允许加载",
    resultImage.isAllowedReferenceImage(okRef, (reference) => reference.localUrl) === true,
    "应返回 true");
}

// ---------- C. 服务端 /api/image-proxy 闸门 ----------
const upstreamHits = [];
const mock = http.createServer((req, res) => {
  const url = String(req.url || "");
  upstreamHits.push(url);
  // 生图请求：返回"非官方中转域名"的真实 CDN 图片地址（复现线上那次的形态）
  if (/images\/(edits|generations)/.test(url)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: [{ url: REAL_CDN_URLS[0] }] }));
    return;
  }
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

  // 渠道基址指向本地 mock：新规则下 127.0.0.1 属于"本地/内网"，正好用来验证 SSRF 闸门
  // （拦内网目标、且**不发**上游请求）；公网 https 则应当放行。
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

  // C1) 内网/本地目标必须 403，且**不能**发起上游请求（防 SSRF）
  const privateUrl = "http://127.0.0.1:8804/v1/images/generated/should-not-be-fetched.png";
  const privateRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent(privateUrl)}`);
  const privateBody = await privateRes.json().catch(() => null);
  check("服务端代理：内网/本地目标 → 403 blocked_image_host",
    privateRes.status === 403 && privateBody?.message === "blocked_image_host",
    `status=${privateRes.status} body=${JSON.stringify(privateBody)}`);
  check("服务端代理：被拦时**没有**发起任何上游请求",
    upstreamHits.length === 0,
    `上游请求数=${upstreamHits.length}`);

  // C2) 真实渠道 CDN（非官方中转域名）**不再**被拦——这是本次故障的回归点。
  // 这条会真的走一次外网；网络不可用时允许失败，但**绝不能**是 403。
  const cdnRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent(REAL_CDN_URLS[0])}`);
  check("服务端代理：真实渠道 CDN 不再被 403（外网失败可接受）",
    cdnRes.status !== 403,
    `status=${cdnRes.status}`);
  if (cdnRes.status === 200) {
    check("服务端代理：CDN 取回的是图片",
      String(cdnRes.headers.get("content-type") || "").includes("image"),
      `ct=${cdnRes.headers.get("content-type")}`);
  }

  // C3) 非法协议仍是 400（原有行为不变）
  const badRes = await fetch(`http://127.0.0.1:${APP_PORT}/api/image-proxy?url=${encodeURIComponent("ftp://x/y.png")}`);
  check("服务端代理：非法协议仍是 400", badRes.status === 400, `status=${badRes.status}`);

  // C4) 端到端回归（就是线上那次故障的形态）：
  //     上游返回结果图的地址在 leo.yunshuaiapi.com（非官方中转域名）→ 服务端的"显示缓存"
  //     必须能把它下载并落成本地 /api/result/ 地址；至少不能是自己判 blocked_image_host 拦掉的。
  {
    const form = new FormData();
    form.set("payload", JSON.stringify({
      taskId: "image-host-cdn-result",
      apiKey: "sk-mock-not-real",
      model: "banana-2",
      channelId: "silent-banana-line-08",
      dispatchMode: "manual",
      imageSize: "2K",
      aspectRatio: "3:4",
      prompt: "image host check",
      workflowMode: "outfit",
      pageName: "批量AI换装",
      pairingMode: "fixed",
      smartIntervention: false,
      garmentParts: { upper: "single-upper", lower: "" },
      garmentComposition: "single-upper",
      garmentLengths: { upper: "", lower: "" },
      referenceCount: 0
    }));
    form.append("image", tinyPng("model.png"), "model.png");
    form.append("image", tinyPng("clothing.png"), "clothing.png");
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate-outfit`, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    const localUrl = String(body?.image?.localUrl || "");
    const assetLogFile = path.join(SANDBOX_ROOT, "logs", "asset-errors.jsonl");
    const assetLog = existsSync(assetLogFile) ? (await import("node:fs")).readFileSync(assetLogFile, "utf8") : "";
    const blockedByOwnGate = /image-proxy-blocked-host[\s\S]{0,200}leo\.yunshuaiapi\.com/.test(assetLog);
    check("端到端：上游结果图在非官方中转域名时，不再被自己的白名单拦下",
      body?.ok === true && blockedByOwnGate === false,
      `ok=${body?.ok} localUrl=${localUrl} blockedByOwnGate=${blockedByOwnGate}`);
    check("端到端：该结果图落成本地地址（/api/result/），或仅因外网不可达而未落盘",
      /^\/api\/result\//.test(localUrl) || blockedByOwnGate === false,
      `localUrl=${localUrl}`);
  }
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

// ---------- D. 前后端一致性（同一条规则，不允许各写一套）----------
{
  const fs = await import("node:fs");
  const serverSource = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  check("服务端 import 了前端的同一份图片规则（单一来源，不会漂移）",
    /from "\.\.\/src\/shared\/image-hosts\.js"/.test(serverSource) && /isSafeRemoteImageUrl\(/.test(serverSource),
    "server/index.js → src/shared/image-hosts.js");
  check("服务端不再把渠道 API 主机当图片白名单（图片回传不限域名）",
    !/ALLOWED_IMAGE_PROXY_HOSTS|isAllowedImageProxyHost/.test(serverSource),
    "旧白名单符号已移除");
  // 生图 API 仍然只允许官方中转：这条规则不能被上面的放宽带偏
  const channelConfig = fs.readFileSync(path.join(ROOT, "server", "channel-config.js"), "utf8");
  check("生图 API 仍然锁死官方中转（PRIMARY_CHANNEL_API_BASE_URL 仍在渠道配置里）",
    /PRIMARY_CHANNEL_API_BASE_URL/.test(channelConfig) && /api\.jingyin\.online/.test(channelConfig),
    "生成路径不受图片放宽影响");
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  sandboxRemoved,
  policy: {
    generationApi: "仅官方中转 https://api.jingyin.online",
    resultImages: "不限域名：https 公网主机放行；非 https 与本地/内网拒绝"
  },
  realCdnSamples: REAL_CDN_URLS,
  failures: failed,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
