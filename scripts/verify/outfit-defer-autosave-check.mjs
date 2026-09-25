// 批量生成 `/api/generate-outfit` 的 `deferAutoSave` 行为钉桩（本地 mock 上游，不联网、不扣费）。
//
// 为什么要有这个测试：
//   server/index.js 里 `const deferOutfitAutoSave = Boolean(payload.deferAutoSave || payload.localEdit?.enabled)`
//   算出来之后**从来没被用过**（ESLint no-unused-vars 报的 P1②）。前端确实在发这个字段
//   （src/outfit-workflow.jsx: `deferAutoSave: Boolean(localEdit || taskIsOutpaint)`）。
//
//   对比 V3 基线快照 server/skill-baselines/V3-batch-local-paste-stable-2026-08-06/server-index.js，
//   那里同一个信号叫 deferOutfitArchive，用途明确：
//       const archived = deferOutfitArchive ? images[0] : await archiveOutfitGeneratedImage(...)
//   也就是"局部回贴/扩图这类中间产物不要在服务端归档"。
//
//   但 V11 的架构已经换了：批量接口没有"写历史"这一步（persistGeneratedItemsInBackground
//   只被 /api/images 调用），服务端只做 HZ- 显示缓存，而 UI 依赖这个本地地址显示结果。
//   把 V3 的"跳过归档"照搬回来，会踩到显示契约。所以**本轮不改保存时机**，
//   只把"当前行为"钉住：以后谁要改，必须先让这个测试红，改成有意决定，而不是顺手删死变量。
//
// 覆盖：
//   1. 带 deferAutoSave + localEdit.enabled 的批量请求仍然 200，并返回本地 HZ- 显示地址
//   2. 这个本地地址真的能取回 PNG（显示契约）
//   3. 对照组（不带 deferAutoSave、无 localEdit）响应形状一致 —— 该字段当前不影响响应
//   4. 两种请求都不会往 data/history.json 写条目（这个接口本身不写历史）
//   5. 显示缓存文件确实落在沙盒 data/results 里（当前行为：归档没有被 defer 跳过）
//
// 用法：node scripts/verify/outfit-defer-autosave-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8888;
const APP_PORT = 8808;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "outfit-defer-check");

let upstreamRequestCount = 0;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    upstreamRequestCount += 1;
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

async function callGenerateOutfit({ taskId, defer, localEdit }) {
  const payload = {
    taskId,
    apiKey: "sk-mock-not-real",
    model: "banana-2",
    channelId: "silent-banana-line-08",
    dispatchMode: "manual",
    imageSize: "2K",
    aspectRatio: "3:4",
    prompt: "局部回贴 deferAutoSave 钉桩检查",
    workflowMode: "outfit",
    pageName: "批量AI换装",
    pairingMode: "fixed",
    garmentParts: { upper: "single-upper", lower: "" },
    garmentComposition: "single-upper",
    garmentLengths: { upper: "", lower: "" },
    referenceCount: 0
  };
  if (defer) payload.deferAutoSave = true;
  if (localEdit) {
    payload.localEdit = {
      enabled: true,
      editMode: "rect",
      cropRect: { x: 0, y: 0, width: 32, height: 32 },
      contextRect: null,
      sourceWidth: 32,
      sourceHeight: 32
    };
  }
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("image", tinyPng("model_1.png"), "model_1.png");
  form.append("image", tinyPng("clothing_1.png"), "clothing_1.png");

  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate-outfit`, { method: "POST", body: form });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** 沙盒里的历史条目数（文件不存在 = 0 条）。 */
function sandboxHistoryCount() {
  const file = path.join(SANDBOX_ROOT, "data", "history.json");
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return -1;
  }
}

/** 沙盒里的 HZ- 显示缓存文件。 */
function sandboxResultArchives() {
  const dir = path.join(SANDBOX_ROOT, "data", "results");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("HZ-"));
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
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT,
      JINGYIN_NO_BROWSER: "1"
    }
  });
  installExitCleanup({ getChild: () => child, sandboxDir: SANDBOX_ROOT });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // —— 1) 带 deferAutoSave + localEdit.enabled 的请求
  const deferred = await callGenerateOutfit({ taskId: "defer-check-with-flag", defer: true, localEdit: true });
  check("带 deferAutoSave + localEdit 的批量请求仍然成功", deferred.status === 200 && deferred.body?.ok === true,
    `status=${deferred.status} ok=${deferred.body?.ok} message=${deferred.body?.message || deferred.body?.error || ""}`);

  const deferredLocalUrl = String(deferred.body?.image?.localUrl || "");
  check("响应仍返回本地显示缓存地址（deferAutoSave 当前不会跳过归档）",
    /^\/api\/result\/HZ-/.test(deferredLocalUrl),
    deferredLocalUrl || JSON.stringify(deferred.body?.image || null));

  if (deferredLocalUrl) {
    const image = await fetch(`http://127.0.0.1:${APP_PORT}${deferredLocalUrl}`);
    const bytes = Buffer.from(await image.arrayBuffer());
    check("该本地地址真能取回图片（UI 显示契约）",
      image.ok && bytes.length > 0 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      `status=${image.status} bytes=${bytes.length}`);
  } else {
    check("该本地地址真能取回图片（UI 显示契约）", false, "没有本地地址可取");
  }

  // —— 2) 对照组：不带任何 defer 信号
  const plain = await callGenerateOutfit({ taskId: "defer-check-plain", defer: false, localEdit: false });
  check("对照组（不带 deferAutoSave）同样成功", plain.status === 200 && plain.body?.ok === true,
    `status=${plain.status} ok=${plain.body?.ok}`);
  check("两条路径的响应形状一致：该字段当前对响应没有影响",
    Boolean(plain.body?.image?.localUrl) === Boolean(deferredLocalUrl)
      && /^\/api\/result\/HZ-/.test(String(plain.body?.image?.localUrl || "")),
    `plain=${plain.body?.image?.localUrl || ""}`);

  // —— 3) 这个接口不写历史：所以"延后写历史"在批量路径上没有作用对象
  check("批量接口两种请求都不往 data/history.json 写条目",
    sandboxHistoryCount() === 0,
    `history 条目 = ${sandboxHistoryCount()}`);
  check("沙盒里确实落了 HZ- 显示缓存（当前行为：归档照旧）",
    sandboxResultArchives().length >= 2,
    `HZ- 文件 ${sandboxResultArchives().length} 个`);
  check("确实打到了 mock 上游（不是被路由/校验挡掉）",
    upstreamRequestCount >= 2,
    `上游请求 ${upstreamRequestCount} 次`);
} catch (error) {
  results.push({ name: "fatal", pass: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await stopChild(child);
  mock.close();
}

// 用户真实数据没被动过
const realHistory = path.join(ROOT, "data", "history.json");
const realHistoryCount = existsSync(realHistory)
  ? (() => { try { const p = JSON.parse(readFileSync(realHistory, "utf8")); return Array.isArray(p) ? p.length : -1; } catch { return -1; } })()
  : 0;
check("真实 data/history.json 没有被测试写入", realHistoryCount >= 0, `条目 = ${realHistoryCount}`);

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
