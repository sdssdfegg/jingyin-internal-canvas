// 批量换装「结构化意图 → 服务端最终提示词」的请求级钉桩（本地 mock 上游，不联网、不扣费）。
//
// 覆盖需求第十节的请求侧验证项：七种部位组合、上装层级三种文字、保持句只在未选部位出现、
// 三项全选没有多余保持句、旧开关字段不影响换装目标、自定义穿法真实进入上游请求、
// 图2事实只插所选部位、同一信息不重复、非法枚举 400、旧存档字段不影响请求、
// 其它 workflow 不带 outfitIntent 时仍只发用户原话。
//
// 用法：node scripts/verify/outfit-intent-request-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8888;
const APP_PORT = 8818;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "outfit-intent-request-check");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

let lastUpstreamPrompt = "";
let upstreamRequestCount = 0;

function extractPrompt(buffer, contentType) {
  const raw = buffer.toString("utf8");
  if (/application\/json/i.test(contentType || "")) {
    try {
      // multipart 会把换行序列化成 CRLF；断言统一按 LF 比较。
      return String(JSON.parse(raw).prompt || "").replace(/\r\n/g, "\n");
    } catch {
      return "";
    }
  }
  const match = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
  return match ? match[1].replace(/\r\n/g, "\n") : "";
}

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    upstreamRequestCount += 1;
    const buffer = Buffer.concat(chunks);
    const prompt = extractPrompt(buffer, req.headers["content-type"]);
    if (prompt) lastUpstreamPrompt = prompt;
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

async function callGenerateOutfit({ taskId, payloadPatch = {}, model = "tt-image-2", channelId = "silent-tt2-line-11" }) {
  const payload = {
    taskId,
    apiKey: "sk-mock-not-real",
    model,
    channelId,
    dispatchMode: "manual",
    imageSize: "2K",
    aspectRatio: "3:4",
    prompt: "用户原话：按图2做一版干净的电商成片",
    workflowMode: "outfit",
    pageName: "批量换装",
    pairingMode: "fixed",
    garmentParts: { upper: true, lower: true, shoes: false },
    garmentComposition: "套装",
    garmentLengths: { upper: "knee", lower: "ankle" },
    masterFitLock: true,
    masterFitSpec: "旧的母版规格整段文本；旧的整段提示词；旧的整段提示词",
    referenceCount: 0,
    ...payloadPatch
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("image", tinyPng("model_1.png"), "model_1.png");
  form.append("image", tinyPng("clothing_1.png"), "clothing_1.png");
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate-outfit`, { method: "POST", body: form });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function intent(patch = {}) {
  return {
    parts: ["upper"],
    upperLayer: "single",
    wearing: { mode: "follow", values: {} },
    facts: {},
    factsSource: { mode: "none", sourceId: "", analyzedAt: 0 },
    ...patch
  };
}

async function promptFor(label, intentPatch, payloadPatch = {}) {
  lastUpstreamPrompt = "";
  const before = upstreamRequestCount;
  const res = await callGenerateOutfit({
    taskId: `intent-${label}`,
    payloadPatch: { outfitIntent: intent(intentPatch), ...payloadPatch }
  });
  if (res.status !== 200) return { ok: false, status: res.status, prompt: "", body: res.body, sent: upstreamRequestCount > before };
  return { ok: true, status: res.status, prompt: lastUpstreamPrompt, body: res.body, sent: upstreamRequestCount > before };
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

  // —— 1) 七种部位组合：目标句与保持句
  const combos = [
    { parts: ["upper"], target: "让图1模特穿着图2的上装。", keep: "图1的下装和鞋子保持不变。" },
    { parts: ["lower"], target: "让图1模特穿着图2的下装。", keep: "图1的上装和鞋子保持不变。" },
    { parts: ["shoes"], target: "让图1模特穿着图2的鞋子。", keep: "图1的上装和下装保持不变。" },
    { parts: ["upper", "lower"], target: "让图1模特穿着图2的上装和下装。", keep: "图1的鞋子保持不变。" },
    { parts: ["upper", "shoes"], target: "让图1模特穿着图2的上装和鞋子。", keep: "图1的下装保持不变。" },
    { parts: ["lower", "shoes"], target: "让图1模特穿着图2的下装和鞋子。", keep: "图1的上装保持不变。" },
    { parts: ["upper", "lower", "shoes"], target: "让图1模特穿着图2的上装、下装和鞋子。", keep: "" }
  ];
  for (const combo of combos) {
    const label = combo.parts.join("+");
    const result = await promptFor(label.replace(/\+/g, "-"), { parts: combo.parts, upperLayer: "single" });
    check(`请求成功（${label}）`, result.ok && result.sent, `status=${result.status} upstreamSent=${result.sent} msg=${result.body?.message || ""}`);
    check(`上游提示词含目标句（${label}）`, result.prompt.includes(combo.target), combo.target);
    if (combo.keep) {
      check(`上游提示词含保持句（${label}）`, result.prompt.includes(combo.keep), combo.keep);
    } else {
      check("三项全选时上游提示词没有保持句", !result.prompt.includes("保持不变"), result.prompt.slice(0, 120));
    }
  }

  // —— 2) 上装层级三种文字
  const layers = {
    inner: "让图1模特穿着图2的内搭。",
    outer: "让图1模特穿着图2的外套。",
    "inner-outer": "让图1模特穿着图2的内搭和外套。"
  };
  const layerPrompts = {};
  for (const [value, expected] of Object.entries(layers)) {
    const result = await promptFor(`layer-${value}`, { parts: ["upper"], upperLayer: value });
    layerPrompts[value] = result.prompt;
    check(`上装层级 ${value} 文字准确`, result.prompt.includes(expected), expected);
  }
  check("内搭/外套/内搭+外套三种上游文字互不相同",
    new Set(Object.values(layerPrompts)).size === 3);

  // —— 3) 需求里那条完整原文（内搭+外套、下装/鞋子保持）
  const requiredPrompt = layerPrompts["inner-outer"];
  check("『内搭+外套、下装不变、鞋子不变』完整原文正确",
    requiredPrompt.includes("让图1模特穿着图2的内搭和外套。\n图1的下装和鞋子保持不变。"),
    requiredPrompt.slice(0, 160));
  check("人物基准只出现一次",
    requiredPrompt.split("图1是唯一人物身份、人体结构和姿势基准，不改变图1人物的身份、骨骼和姿势。").length - 1 === 1);

  // —— 4) 旧开关字段不影响结构化换装目标（SKILL 开/关）
  const withLegacySkillOff = await promptFor("legacy-skill-off", { parts: ["upper"], upperLayer: "inner-outer" }, { skillRulesEnabled: false, smartIntervention: false });
  const withLegacySkillOn = await promptFor("legacy-skill-on", { parts: ["upper"], upperLayer: "inner-outer" }, { skillRulesEnabled: true, smartIntervention: false, garmentParts: ["upper"], garmentComposition: "upper-layer" });
  const targetOf = (prompt) => (prompt.match(/让图1模特[^\n]*/) || [""])[0];
  check("旧 SKILL 开关关闭时换装目标仍在",
    withLegacySkillOff.prompt.includes("让图1模特穿着图2的内搭和外套。"), targetOf(withLegacySkillOff.prompt));
  check("旧 SKILL 开关开与关，上游换装目标完全相同",
    targetOf(withLegacySkillOff.prompt) === targetOf(withLegacySkillOn.prompt) && targetOf(withLegacySkillOn.prompt) !== "",
    `${targetOf(withLegacySkillOff.prompt)} | ${targetOf(withLegacySkillOn.prompt)}`);

  // —— 5) 自定义穿法真实进入上游请求
  const custom = await promptFor("custom-wearing", {
    parts: ["upper", "lower"],
    upperLayer: "outer",
    facts: { closure: "门襟四颗扣子", hem: "衣摆外穿", sleeveState: "袖子放下" },
    wearing: {
      mode: "custom",
      values: { closure: "open", outerState: "half", hem: "front-half", sleeve: "forearm", collar: "stand", fit: "loose", waistband: "high", lowerHem: "cuffed" }
    }
  });
  [
    ["门襟全开", "扣合状态"],
    ["外套半敞开", "外套状态"],
    ["衣摆前侧半扎、后摆放出", "衣摆"],
    ["袖子推至前臂", "袖子"],
    ["衣领立起", "衣领"],
    ["版型宽松", "版型"],
    ["下装为高腰", "腰头"],
    ["裤脚挽边", "裤脚/裙摆"]
  ].forEach(([text, label]) => {
    check(`自定义${label}进入上游提示词`, custom.prompt.includes(text), text);
  });
  check("自定义穿法覆盖后图2事实不再重复扣合/衣摆/袖子",
    !custom.prompt.includes("门襟四颗扣子") && !custom.prompt.includes("衣摆外穿") && !custom.prompt.includes("袖子放下"),
    (custom.prompt.match(/【图2服装事实】\n([^\n]*)/) || [])[1] || "(无事实段)");
  check("『保持不变』在上游提示词里只出现一次", custom.prompt.split("保持不变").length - 1 === 1);

  // —— 6) 图2事实只插入所选部位
  const factsOnly = { category: "衬衫", color: "白色", lowerType: "直筒牛仔裤", shoeType: "白色运动鞋" };
  const upperOnly = await promptFor("facts-upper", { parts: ["upper"], upperLayer: "single", facts: factsOnly });
  check("只选上装时上游事实不含下装/鞋子",
    upperOnly.prompt.includes("衬衫") && !upperOnly.prompt.includes("直筒牛仔裤") && !upperOnly.prompt.includes("白色运动鞋"),
    (upperOnly.prompt.match(/【图2服装事实】\n([^\n]*)/) || [])[1] || "(无事实段)");
  const lowerOnly = await promptFor("facts-lower", { parts: ["lower"], upperLayer: "single", facts: factsOnly });
  check("只选下装时上游事实只含下装项",
    lowerOnly.prompt.includes("直筒牛仔裤") && !lowerOnly.prompt.includes("衬衫") && !lowerOnly.prompt.includes("白色运动鞋"),
    (lowerOnly.prompt.match(/【图2服装事实】\n([^\n]*)/) || [])[1] || "(无事实段)");
  check("没有事实时整段省略",
    !(await promptFor("facts-none", { parts: ["upper"], upperLayer: "single", facts: {} })).prompt.includes("【图2服装事实】"));

  // —— 7) 非法枚举 400
  const badCases = [
    { name: "非法部位", patch: { outfitIntent: intent({ parts: ["upper", "hat"] }) } },
    { name: "空部位", patch: { outfitIntent: intent({ parts: [] }) } },
    { name: "非法上装层级", patch: { outfitIntent: intent({ upperLayer: "大袄" }) } },
    { name: "非法穿法模式", patch: { outfitIntent: intent({ wearing: { mode: "随缘", values: {} } }) } },
    { name: "非法穿法取值", patch: { outfitIntent: intent({ wearing: { mode: "custom", values: { closure: "半扣" } } }) } }
  ];
  for (const item of badCases) {
    const res = await callGenerateOutfit({ taskId: `bad-${item.name}`, payloadPatch: item.patch });
    check(`${item.name} 返回 400 且带中文原因`,
      res.status === 400 && res.body?.error === "invalid_outfit_intent" && /不合法/.test(String(res.body?.message || "")),
      `status=${res.status} message=${res.body?.message || ""}`);
  }

  // —— 8) 旧存档字段 / 其它 workflow
  const legacy = await promptFor("legacy-fields", { parts: ["upper"], upperLayer: "single" });
  check("请求里带旧 garmentLengths / masterFitSpec 也不影响结果",
    legacy.ok && legacy.prompt.includes("让图1模特穿着图2的上装。"), `status=${legacy.status}`);

  lastUpstreamPrompt = "";
  const recolor = await callGenerateOutfit({
    taskId: "recolor-no-intent",
    model: "tt-image-2",
    payloadPatch: { workflowMode: "recolor", pageName: "批量改色", outfitIntent: undefined }
  });
  check("不带 outfitIntent 的其它 workflow 仍只发用户原话",
    recolor.status === 200 && lastUpstreamPrompt.trim() === "用户原话：按图2做一版干净的电商成片",
    `status=${recolor.status} prompt=${JSON.stringify(lastUpstreamPrompt.replace(/\r\n/g, "\n").slice(0, 80))}`);

  // —— 9) 同一信息不在三处重复
  const duplication = await promptFor("no-duplication", {
    parts: ["upper"],
    upperLayer: "inner-outer",
    facts: { category: "外套+内搭两层", closure: "门襟四颗扣子" },
    wearing: { mode: "follow", values: {} }
  });
  const baselineCount = duplication.prompt.split("图1是唯一人物身份、人体结构和姿势基准").length - 1;
  check("人物基准只有一处（上游提示词）", baselineCount === 1, String(baselineCount));
  check("用户原话只出现一次", duplication.prompt.split("用户原话：按图2做一版干净的电商成片").length - 1 === 1);
} catch (error) {
  results.push({ name: "fatal", pass: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await stopChild(child);
  mock.close();
}

const sandbox = await removeSandbox(SANDBOX_ROOT);
const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  upstreamRequestCount,
  sandboxRemoved: sandbox.removed,
  failures: failed.map((item) => ({ name: item.name, detail: item.detail }))
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
