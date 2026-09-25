// `/api/canvas-assets` 与 `/api/canvas-asset/:filename` 的行为钉桩（本地实例，不打上游、不扣费）。
//
// 背景（2026-09-25 第 4b 轮审查）：
//   `POST /api/canvas-assets` 里 `return res.json({...})` 之后还留着 18 行旧实现
//   （把画布资源写进 data/canvas-assets 再回 `/api/canvas-asset/xxx`），永远执行不到。
//   本轮把那段不可达代码和它专用的 canvasAssetUrl() 一起删掉，
//   同时**保留** `GET /api/canvas-asset/:filename` 路由与 canvasAssetPath()。
//
// 两个决定分开判定的依据：
//   - 不可达代码：在 return 之后，任何调用方都不可能依赖它 → 删。
//   - GET 路由：当前前端 bundle 里 0 处引用、用户数据里 0 处引用、data/canvas-assets
//     目录都不存在；但服务端自己还有一条兼容分支在解析 `/api/canvas-asset/…`
//     （server/index.js 的 imageBufferFromPayload），旧版本前端也会生成这种链接。
//     删掉它是协议级变更、收益为零，所以保留。
//
// 这个测试把上面两个决定钉住：谁把落盘写回来、或者谁把路由删了，都会红。
//
// 用法：node scripts/verify/canvas-asset-check.mjs
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8809;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "canvas-asset-check");

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
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

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

freshSandbox(SANDBOX_ROOT);
let child = null;
try {
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      JINGYIN_PORT_FALLBACK_LIMIT: "0",
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT,
      JINGYIN_NO_BROWSER: "1"
    }
  });
  installExitCleanup({ getChild: () => child, sandboxDir: SANDBOX_ROOT });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // —— 1) 上传：仍然回 data URL（不是 /api/canvas-asset/ 链接）
  const form = new FormData();
  form.append("image", tinyPng("canvas-a.png"), "canvas-a.png");
  form.append("image", tinyPng("canvas-b.png"), "canvas-b.png");
  const upload = await fetch(`http://127.0.0.1:${APP_PORT}/api/canvas-assets`, { method: "POST", body: form });
  const uploaded = await upload.json().catch(() => null);
  check("POST /api/canvas-assets 返回 200 + ok", upload.status === 200 && uploaded?.ok === true,
    `status=${upload.status} ok=${uploaded?.ok}`);
  check("两张图都回来了", Array.isArray(uploaded?.assets) && uploaded.assets.length === 2,
    `assets=${uploaded?.assets?.length}`);
  const urls = (uploaded?.assets || []).map((asset) => String(asset?.url || ""));
  check("资源地址是 data URL（前端不再需要服务端落盘）",
    urls.length === 2 && urls.every((url) => /^data:image\/png;base64,/.test(url)),
    urls.map((url) => url.slice(0, 24)).join(" | "));
  check("返回的 filename 为空（旧实现才会给出落盘文件名）",
    (uploaded?.assets || []).every((asset) => String(asset?.filename || "") === ""),
    (uploaded?.assets || []).map((asset) => asset?.filename).join(","));

  // —— 2) 沙盒里不应该出现落盘目录（旧实现会写 data/canvas-assets）
  const canvasDir = path.join(SANDBOX_ROOT, "data", "canvas-assets");
  const canvasFiles = existsSync(canvasDir) ? readdirSync(canvasDir) : [];
  check("没有把画布资源写进 data/canvas-assets（不可达的落盘实现确实删掉了）",
    !existsSync(canvasDir) || canvasFiles.length === 0,
    `目录存在=${existsSync(canvasDir)} 文件=${canvasFiles.length}`);

  // —— 3) 空上传仍然按原契约拒绝
  const empty = await fetch(`http://127.0.0.1:${APP_PORT}/api/canvas-assets`, { method: "POST", body: new FormData() });
  const emptyBody = await empty.json().catch(() => null);
  check("空上传回 400 missing_canvas_assets",
    empty.status === 400 && emptyBody?.message === "missing_canvas_assets",
    `status=${empty.status} message=${emptyBody?.message}`);

  // —— 4) GET 路由保留：不存在的文件回 404（不 500、不 405）
  const missing = await fetch(`http://127.0.0.1:${APP_PORT}/api/canvas-asset/does-not-exist.png`);
  const missingBody = await missing.json().catch(() => null);
  check("GET /api/canvas-asset/:filename 仍然挂在服务上（回 404 canvas_asset_not_found）",
    missing.status === 404 && missingBody?.message === "canvas_asset_not_found",
    `status=${missing.status} message=${missingBody?.message}`);

  // —— 5) 路径穿越仍然被挡（canvasAssetPath 的边界检查还在）
  const traversal = await fetch(`http://127.0.0.1:${APP_PORT}/api/canvas-asset/${encodeURIComponent("../data/history.json")}`);
  check("路径穿越请求不会读到 data 目录里的文件",
    traversal.status === 404 || traversal.status === 400,
    `status=${traversal.status}`);

  // —— 6) 真实用户 data 目录没有被写进画布资源
  const realCanvasDir = path.join(ROOT, "data", "canvas-assets");
  const realFiles = existsSync(realCanvasDir) ? readdirSync(realCanvasDir) : [];
  check("真实 data/canvas-assets 没有被测试写入",
    realFiles.length === 0,
    `文件=${realFiles.length}`);
} catch (error) {
  results.push({ name: "fatal", pass: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await stopChild(child);
}

const sandbox = await removeSandbox(SANDBOX_ROOT);
const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  sandboxRemoved: sandbox.removed,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
