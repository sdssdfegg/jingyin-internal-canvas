// 服装精修「结构化意图 → 服务端最终提示词」的请求级钉桩（本地 mock 上游，不联网、不扣费）。
//
// 覆盖需求第七节的请求侧验证项：
//   对称/衣摆/版型每个状态都进入真实 payload 与最终 prompt；默认不强制改动；
//   用户补充只出现一次；非法枚举 400；页面预览（同一编译器）与实际请求逐字一致；
//   同时回归检查批量换装的提示词没有被这次改动带坏。
//
// 用法：node scripts/verify/retouch-intent-request-check.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { compileRetouchPrompt, defaultRetouchIntent } from "../../src/shared/retouch-intent.js";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const MOCK_PORT = 8898;
const APP_PORT = 8838;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "retouch-intent-request-check");

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
    const prompt = extractPrompt(Buffer.concat(chunks), req.headers["content-type"]);
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

async function callGenerate(payloadPatch = {}, files = 1) {
  const payload = {
    taskId: `retouch-${Math.random().toString(36).slice(2, 8)}`,
    apiKey: "sk-mock-not-real",
    model: "tt-image-2",
    channelId: "silent-tt2-line-11",
    dispatchMode: "manual",
    imageSize: "2K",
    aspectRatio: "3:4",
    prompt: "",
    workflowMode: "white-refine",
    pageName: "精修",
    pairingMode: "fixed",
    referenceCount: 0,
    ...payloadPatch
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (let index = 0; index < files; index += 1) {
    form.append("image", tinyPng(`garment_${index + 1}.png`), `garment_${index + 1}.png`);
  }
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/generate-outfit`, { method: "POST", body: form });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function promptFor(payloadPatch = {}, files = 1) {
  lastUpstreamPrompt = "";
  const before = upstreamRequestCount;
  const res = await callGenerate(payloadPatch, files);
  if (res.status !== 200) return { ok: false, status: res.status, prompt: "", body: res.body, sent: upstreamRequestCount > before };
  return { ok: true, status: res.status, prompt: lastUpstreamPrompt, body: res.body, sent: upstreamRequestCount > before };
}

const intent = (patch = {}) => ({ ...defaultRetouchIntent(), ...patch });

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

  // —— 1) 每个选择都进入真实请求与最终提示词 ——
  // 2026-09-26（按用户要求）：提示词里只写"给模型的指令"，不写"关闭对称/跟随原图"这种状态说明。
  const allPrompts = [];
  const cases = [
    { name: "对称开启", patch: { symmetry: "on" }, needle: "把服装左右结构调成对称版型" },
    { name: "对称关闭", patch: { symmetry: "off" }, needle: "保留原图中真实的左右不对称细节，不要强行把服装做成对称。" },
    { name: "衣摆跟随原图（整行省略）", patch: { hemTreatment: "follow_original" }, absent: "衣摆" },
    { name: "衣摆平直", patch: { hemTreatment: "straight" }, needle: "把明显歪扭或摆放造成的衣摆、裙摆波浪拉平直" },
    { name: "衣摆自然波浪", patch: { hemTreatment: "natural_wave" }, needle: "衣摆或裙摆保持自然垂落的波浪" },
    { name: "版型跟随原图（不写版型词）", patch: { fit: "follow_original" }, absent: "版型" },
    { name: "版型直筒", patch: { fit: "straight" }, needle: "把服装版型修成直筒轮廓" },
    { name: "版型收腰", patch: { fit: "waisted" }, needle: "把服装版型修成收腰轮廓" },
    { name: "版型宽松", patch: { fit: "loose" }, needle: "把服装版型修成宽松轮廓" }
  ];
  for (const item of cases) {
    const result = await promptFor({ retouchIntent: intent(item.patch) });
    allPrompts.push(result.prompt);
    const ok = result.ok && (item.needle ? result.prompt.includes(item.needle) : true)
      && (item.absent ? !result.prompt.includes(item.absent) : true);
    check(`上游提示词含「${item.name}」`, ok, `${result.status} ${item.needle || item.absent}`);
  }
  check("上游提示词里不出现状态说明（关闭对称 / 开启服装对称 / 跟随原图 / 「对称：」「版型：」这类标签）",
    !/关闭对称|开启服装对称|跟随原图|对称：|衣摆或裙摆：|版型：/.test(allPrompts.join("\n")),
    allPrompts.join("\n").slice(0, 120));

  // —— 2) 默认状态不强制改动原服装 ——
  const defaultRequest = await promptFor({ retouchIntent: intent() });
  check("默认状态请求成功", defaultRequest.ok && defaultRequest.sent, `status=${defaultRequest.status}`);
  check("默认状态不出现任何主动改变指令",
    !/平直/.test(defaultRequest.prompt)
      && !/自然波浪/.test(defaultRequest.prompt)
      && !/直筒|收腰|宽松/.test(defaultRequest.prompt)
      && !/对称版型/.test(defaultRequest.prompt),
    defaultRequest.prompt.split("\n").slice(-2).join(" / "));
  check("默认状态只给「保留不对称、不要强行对称」这一条结构指令",
    /保留原图中真实的左右不对称细节，不要强行把服装做成对称。/.test(defaultRequest.prompt));
  check("默认状态仍包含八项固定精修要求",
    ["干净的服装白底精修图", "去除明显褶皱", "横平竖直", "不创新", "去掉衣架", "不偏色", "轮廓平滑"]
      .every((needle) => defaultRequest.prompt.includes(needle)));

  // —— 3) 页面显示的提示词 == 实际请求（生产路径：服务端原样转发前端编译结果） ——
  const previewIntent = intent({ symmetry: "on", hemTreatment: "straight", fit: "loose", customPrompt: "保留吊牌，背景纯白" });
  const productNote = "场景补充：不要加光斑";
  // 前端「通用白底精修提示词」框里的内容 = 共享编译器的输出（含用户补充）
  const preview = compileRetouchPrompt({ intent: previewIntent, productNote });
  const previewRequest = await promptFor({ retouchIntent: previewIntent, prompt: preview.prompt, productNote });
  check("页面显示的提示词与上游实际收到的提示词逐字一致（转发路径）",
    previewRequest.ok && previewRequest.prompt.trim() === preview.prompt.trim(),
    JSON.stringify({ previewHead: preview.prompt.slice(0, 60), upstreamHead: previewRequest.prompt.slice(0, 60) }));
  check("转发路径不再重复追加用户补充（只出现一次）",
    previewRequest.prompt.split("保留吊牌，背景纯白").length - 1 === 1
      && previewRequest.prompt.split(productNote).length - 1 === 1,
    String(previewRequest.prompt.split("保留吊牌，背景纯白").length - 1));
  check("转发路径不会重复追加换装/精修固定段",
    previewRequest.prompt.split("【服装精修目标】").length - 1 === 1
      && previewRequest.prompt.split("【清理与轮廓】").length - 1 === 1);

  // —— 3b) 兜底路径：客户端没给正文时，服务端用同一个编译器生成（结果必须一致） ——
  const fallbackRequest = await promptFor({ retouchIntent: previewIntent, prompt: "", productNote });
  check("没有客户端正文时服务端用同一编译器兜底，结果与页面预览一致",
    fallbackRequest.ok && fallbackRequest.prompt.trim() === preview.prompt.trim(),
    JSON.stringify({ fallbackHead: fallbackRequest.prompt.slice(0, 60) }));
  check("兜底路径里用户补充也只出现一次",
    fallbackRequest.prompt.split("保留吊牌，背景纯白").length - 1 === 1
      && fallbackRequest.prompt.split(productNote).length - 1 === 1);

  // —— 4) 手改内容被尊重；内置默认词不会被当成编译结果丢掉 ——
  const handEdited = "手改后的提示词：背景纯白，保留吊牌和吊牌线";
  const handEditedRequest = await promptFor({ retouchIntent: intent(), prompt: handEdited });
  check("在提示词框里手改的内容会被原样发出去",
    handEditedRequest.ok && handEditedRequest.prompt.trim() === handEdited,
    JSON.stringify(handEditedRequest.prompt.slice(0, 60)));

  // —— 5) 非法枚举 / 版本 → 400 ——
  const badCases = [
    { name: "非法对称", patch: { symmetry: "yes" } },
    { name: "非法衣摆", patch: { hemTreatment: "wavy" } },
    { name: "非法版型", patch: { fit: "huge" } },
    { name: "版本不支持", patch: { version: 99 } },
    { name: "用户补充不是文本", patch: { customPrompt: { text: "x" } } }
  ];
  for (const item of badCases) {
    const res = await callGenerate({ retouchIntent: intent(item.patch) });
    check(`${item.name} 返回 400 且带中文原因`,
      res.status === 400 && res.body?.error === "invalid_retouch_intent" && /不合法/.test(String(res.body?.message || "")),
      `status=${res.status} message=${res.body?.message || ""}`);
  }

  // —— 6) 非法请求不会把上游点着（校验必须排在扣费步骤之前） ——
  const beforeCount = upstreamRequestCount;
  await callGenerate({ retouchIntent: intent({ fit: "nope" }) });
  await callGenerate({ retouchIntent: intent({ symmetry: "nope" }) });
  check("非法枚举不会发起上游生图", upstreamRequestCount === beforeCount, `${beforeCount} → ${upstreamRequestCount}`);

  // —— 7) 回归：批量换装的提示词没有被这次改动带坏 ——
  const outfitRequest = await promptFor({
    workflowMode: "outfit",
    pageName: "换装",
    prompt: "",
    outfitIntent: {
      parts: ["upper"],
      upperLayer: "inner-outer",
      wearing: { mode: "follow", values: {} },
      facts: {},
      factsSource: { mode: "none", sourceId: "", analyzedAt: 0 }
    }
  }, 2);
  check("批量换装仍按 outfitIntent 编译（回归）",
    outfitRequest.ok && outfitRequest.prompt.includes("让图1模特穿着图2的内搭和外套。"),
    outfitRequest.prompt.split("\n")[0]);
  check("换装提示词里没有混入精修段落",
    !outfitRequest.prompt.includes("【服装精修目标】") && !outfitRequest.prompt.includes("【清理与轮廓】"));

  // —— 8) 没有 retouchIntent 的精修请求保持历史契约（只发用户原话） ——
  const legacy = await promptFor({ prompt: "用户原话：白底精修一下" });
  check("不带 retouchIntent 的精修请求仍只发用户原话（历史契约不变）",
    legacy.ok && legacy.prompt.trim() === "用户原话：白底精修一下",
    JSON.stringify(legacy.prompt.slice(0, 60)));
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
