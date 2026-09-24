// 批量生成「SKILL / 服装规则默认关闭」验证（本地 mock 上游，不联网、不扣费、不出图）。
//
// 为什么要在 HTTP 层验证：
//   只在单测里调 buildOutfitPrompt 只能证明函数本身；这里让 V11 真的收一次
//   `/api/generate-outfit`，然后**从 mock 上游的请求体里把最终 prompt 抠出来**，
//   证明「服务端真正发给模型的提示词」不含任何自动规则，且用户原始提示词原样保留。
//
// 覆盖：
//   1. 不带 batchSkillRules（= 前端默认关闭）→ 最终 prompt 只有用户文字
//   2. 显式 batchSkillRules=false → 同上
//   3. 显式 batchSkillRules=true → 规则回来（证明规则常量没有被删除，可恢复）
//   4. 三种情况都不改 model / channelId / dispatchMode / imageSize / aspectRatio
//
// 用法：node scripts/verify/batch-skill-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8893;
const APP_PORT = 8794;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "batch-skill-check");

// 用户自己写的提示词：必须逐字保留。
const USER_PROMPT = "把图2的连衣裙穿到图1模特身上，保持模特姿势。";
// 只有 SKILL 打开时才会出现的规则块标题（来自 prompts/server/outfit-skill.js）。
const RULE_MARKERS = [
  "【批量生成换装 Skill】",
  "【图2迁移范围】",
  "【服装长度落点】",
  "【模型适配】",
  "【服装类别】",
  "【前端提示词】"
];
const RULE_KEYWORDS = [
  "袖子状态按图2实际穿法执行",
  "服装颜色校准以图2原服装为准",
  "电商成片需要服装干净平整",
  "以图1为人物姿势和构图基准"
];

const captured = [];
let upstreamStatus = 200;

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const buffer = Buffer.concat(chunks);
    const contentType = String(req.headers["content-type"] || "");
    const record = { url: req.url, method: req.method, protocol: "", fields: {}, json: null, prompt: "" };
    if (/multipart\/form-data/i.test(contentType)) {
      record.protocol = "multipart";
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
      const raw = buffer.toString("latin1");
      for (const part of raw.split(`--${boundary}`)) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const headerText = part.slice(0, headerEnd);
        const nameMatch = /name="([^"]*)"/i.exec(headerText);
        if (!nameMatch) continue;
        if (/filename="/i.test(headerText)) continue;
        const bodyStart = headerEnd + 4;
        const bodyEnd = part.lastIndexOf("\r\n");
        if (bodyEnd < bodyStart) continue;
        // 结构按 latin1 切，但字段值要还原成 UTF-8，否则中文提示词会变成乱码。
        record.fields[nameMatch[1]] = Buffer.from(part.slice(bodyStart, bodyEnd), "latin1").toString("utf8");
      }
      record.prompt = record.fields.prompt || "";
    } else {
      record.protocol = "json";
      try { record.json = JSON.parse(buffer.toString("utf8")); } catch { record.json = {}; }
      record.prompt = String(record.json?.prompt || "");
    }
    captured.push(record);

    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
    if (upstreamStatus !== 200) {
      res.end(JSON.stringify({ error: { message: "mock upstream rejected", type: "server_error" } }));
      return;
    }
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

/** 调一次 /api/generate-outfit，返回 {status, body, upstream}。 */
async function callGenerateOutfit({ batchSkillRules }) {
  const payload = {
    taskId: `batch-skill-${batchSkillRules === undefined ? "default" : batchSkillRules}`,
    apiKey: "sk-mock-not-real",
    model: "banana-2",
    channelId: "silent-banana-line-08",
    dispatchMode: "manual",
    imageSize: "2K",
    aspectRatio: "3:4",
    prompt: USER_PROMPT,
    workflowMode: "outfit",
    pageName: "批量AI换装",
    pairingMode: "fixed",
    garmentParts: { upper: "single-upper", lower: "" },
    garmentComposition: "single-upper",
    garmentLengths: { upper: "", lower: "" },
    referenceCount: 0,
    deferAutoSave: true
  };
  if (batchSkillRules !== undefined) payload.batchSkillRules = batchSkillRules;

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("image", tinyPng("model_1.png"), "model_1.png");
  form.append("image", tinyPng("clothing_1.png"), "clothing_1.png");

  const before = captured.length;
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate-outfit`, { method: "POST", body: form });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const ups = captured.slice(before);
  // 同一个网关还会承载「智能文本 / 质检」这类辅助调用，最终生图请求只认 /images/ 路径。
  const imageUps = ups.filter((item) => /\/images\//.test(String(item.url || "")));
  return {
    status: res.status,
    ok: Boolean(body?.ok),
    message: body?.message || body?.error || "",
    upstreamCount: imageUps.length,
    upstreamTotal: ups.length,
    upstream: imageUps[0] || null
  };
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

function ruleHits(prompt) {
  const markers = RULE_MARKERS.filter((marker) => String(prompt).includes(marker));
  const keywords = RULE_KEYWORDS.filter((keyword) => String(prompt).includes(keyword));
  return { markers, keywords };
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
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // ---- 1) 默认（前端本轮默认关闭）
  const defaultRun = await callGenerateOutfit({});
  const defaultPrompt = defaultRun.upstream?.prompt || "";
  const defaultHits = ruleHits(defaultPrompt);
  check("默认（不传 batchSkillRules）请求真的发出去了", defaultRun.upstreamCount === 1 && defaultRun.status === 200, `status=${defaultRun.status} ups=${defaultRun.upstreamCount} msg=${defaultRun.message}`);
  check("默认：最终 prompt 完全等于用户提示词", defaultPrompt.trim() === USER_PROMPT, `prompt=${JSON.stringify(defaultPrompt.slice(0, 120))}`);
  check("默认：不含任何自动规则块标题", defaultHits.markers.length === 0, `命中=${defaultHits.markers.join("|")}`);
  check("默认：不含任何服装规则正文", defaultHits.keywords.length === 0, `命中=${defaultHits.keywords.join("|")}`);

  // ---- 2) 显式关闭
  const offRun = await callGenerateOutfit({ batchSkillRules: false });
  const offPrompt = offRun.upstream?.prompt || "";
  const offHits = ruleHits(offPrompt);
  check("显式 false：最终 prompt 完全等于用户提示词", offPrompt.trim() === USER_PROMPT, `prompt=${JSON.stringify(offPrompt.slice(0, 120))}`);
  check("显式 false：不含任何自动规则", offHits.markers.length === 0 && offHits.keywords.length === 0, `markers=${offHits.markers.join("|")} keywords=${offHits.keywords.join("|")}`);

  // ---- 3) 显式打开（证明规则还在、可恢复）
  const onRun = await callGenerateOutfit({ batchSkillRules: true });
  const onPrompt = onRun.upstream?.prompt || "";
  const onHits = ruleHits(onPrompt);
  check("显式 true：规则块回来了（常量未删除、可恢复）", onHits.markers.length > 0 && onHits.keywords.length > 0, `markers=${onHits.markers.join("|")}`);
  check("显式 true：用户原始提示词仍然包含在最终 prompt 里", onPrompt.includes(USER_PROMPT), `len=${onPrompt.length}`);
  check("显式 true：最终 prompt 明显长于关闭时", onPrompt.length > offPrompt.length + 200, `on=${onPrompt.length} off=${offPrompt.length}`);

  // ---- 4) 其它请求字段不受影响
  const fieldsOf = (up) => {
    if (!up) return {};
    const source = up.protocol === "json" ? (up.json || {}) : (up.fields || {});
    return {
      model: source.model || "",
      channelId: source.channelId || "",
      dispatchMode: source.dispatchMode || "",
      imageSize: source.imageSize || source.outputSize || "",
      aspectRatio: source.aspectRatio || source.outputAspectRatio || "",
      fileCount: up.protocol === "json" ? (Array.isArray(source.image_urls) ? source.image_urls.length : 0) : Object.keys(up.fields || {}).length
    };
  };
  const f0 = fieldsOf(defaultRun.upstream);
  const f1 = fieldsOf(offRun.upstream);
  const f2 = fieldsOf(onRun.upstream);
  check(
    "开关不影响 model / channelId / dispatchMode / imageSize / aspectRatio",
    f0.model === f1.model && f1.model === f2.model
      && f0.channelId === "silent-banana-line-08" && f1.channelId === f0.channelId && f2.channelId === f0.channelId
      && f0.dispatchMode === "manual" && f1.dispatchMode === "manual" && f2.dispatchMode === "manual"
      && f0.imageSize === "2K" && f2.imageSize === "2K"
      && f0.aspectRatio === "3:4" && f2.aspectRatio === "3:4",
    JSON.stringify({ f0, f1, f2 })
  );

  results.push({
    name: "SAMPLE",
    pass: true,
    detail: JSON.stringify({
      offPromptStart: offPrompt.slice(0, 80),
      onPromptStart: onPrompt.slice(0, 80),
      offLength: offPrompt.length,
      onLength: onPrompt.length
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
await new Promise((resolve) => setTimeout(resolve, 400));
let sandboxRemoved = false;
for (let attempt = 0; attempt < 4 && !sandboxRemoved; attempt += 1) {
  try { rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  sandboxRemoved = !existsSync(SANDBOX_ROOT);
  if (!sandboxRemoved) await new Promise((resolve) => setTimeout(resolve, 500));
}
// 用户 data 目录必须没有被写进任何测试产物
const userHistoryImages = path.join(ROOT, "data", "history-images");
const userMockResidue = existsSync(userHistoryImages)
  ? readdirSync(userHistoryImages).filter((name) => {
    try { return readFileSync(path.join(userHistoryImages, name)).length < 1024; } catch { return false; }
  }).length
  : 0;

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length - 1,
  passed: results.length - 1 - failed.filter((item) => item.name !== "SAMPLE").length,
  failed: failed.filter((item) => item.name !== "SAMPLE").length,
  sandboxRemoved,
  userMockResidue,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
