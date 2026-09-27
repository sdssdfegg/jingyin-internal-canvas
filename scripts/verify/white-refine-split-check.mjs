// 精修页「结果图中线剪裁成两张」验证。
//
// 覆盖：
//   1. 中线位置算法与 3.0（main.py 的 white_refine_split_save_result_bytes）完全一致：
//      middle = clamp(floor(宽/2), 1, 宽-1)，太小/奇偶/极端宽度都不出错；
//   2. 开关默认打开、只认 "0" 为关闭（3.0 的 localStorage 口径）；
//   3. 前端接线：只在精修页渲染开关、只在精修任务成功后触发、按"任务自己的 workflowMode"判断、
//      两张半图走同一个保存接口且不塞子目录；
//   4. 服务端保存链路（本地实例 + 沙盒目录）：两张半图确实落盘成两个文件。
//
// 用法：node scripts/verify/white-refine-split-check.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  SPLIT_HALVES_STORAGE_KEY,
  readSplitHalvesEnabled,
  splitHalvesBounds,
  splitHalvesFileName,
  writeSplitHalvesEnabled
} from "../../src/shared/image-split.js";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8828;
const SANDBOX_ROOT = path.join(ROOT, ".codex-artifacts", "white-refine-split-check");
const CLIENT = path.join(ROOT, "src", "outfit-workflow.jsx");
const CSS = path.join(ROOT, "src", "features", "outfit", "white-refine-split.css");
const SERVER = path.join(ROOT, "server", "index.js");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

const { readFileSync } = await import("node:fs");
const clientSource = readFileSync(CLIENT, "utf8");
const cssSource = readFileSync(CSS, "utf8");
const serverSource = readFileSync(SERVER, "utf8");

// ---------- 1) 中线算法（3.0 同口径） ----------
check("宽 2000 → 中线 1000，左 1000 / 右 1000",
  JSON.stringify(splitHalvesBounds(2000)) === JSON.stringify({
    width: 2000,
    middle: 1000,
    left: { x: 0, y: 0, width: 1000 },
    right: { x: 1000, y: 0, width: 1000 }
  }),
  JSON.stringify(splitHalvesBounds(2000)));
const odd = splitHalvesBounds(2049);
check("奇数宽 2049 → 中线 1024，左 1024 / 右 1025（不丢像素）",
  odd?.middle === 1024 && odd.left.width === 1024 && odd.right.width === 1025,
  JSON.stringify(odd));
check("左右宽度加起来等于原宽", [2, 3, 17, 1024, 4096].every((w) => {
  const b = splitHalvesBounds(w);
  return b && b.left.width + b.right.width === w;
}));
check("宽 2 → 中线 1（最窄可用）", splitHalvesBounds(2)?.middle === 1, JSON.stringify(splitHalvesBounds(2)));
check("宽 1 / 0 / NaN → 无法裁切（返回 null）",
  splitHalvesBounds(1) === null && splitHalvesBounds(0) === null && splitHalvesBounds(Number.NaN) === null);

// ---------- 2) 开关默认开、只认 "0" 为关 ----------
const fakeStorage = (initial) => {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map)
  };
};
const empty = fakeStorage();
check("没存过 → 默认打开（3.0 口径）", readSplitHalvesEnabled(empty) === true);
check("存过 \"0\" → 关闭", readSplitHalvesEnabled(fakeStorage({ [SPLIT_HALVES_STORAGE_KEY]: "0" })) === false);
check("存过 \"1\" → 打开", readSplitHalvesEnabled(fakeStorage({ [SPLIT_HALVES_STORAGE_KEY]: "1" })) === true);
const writeTarget = fakeStorage();
writeSplitHalvesEnabled(false, writeTarget);
check("写开关 → 落成 \"0\"", writeTarget.dump()[SPLIT_HALVES_STORAGE_KEY] === "0", JSON.stringify(writeTarget.dump()));
writeSplitHalvesEnabled(true, writeTarget);
check("再打开 → 落成 \"1\"", writeTarget.dump()[SPLIT_HALVES_STORAGE_KEY] === "1");
check("storage 读取抛错时不崩（隐私模式）",
  readSplitHalvesEnabled({ getItem() { throw new Error("denied"); } }) === true);
check("localStorage 键名与 3.0 完全一致",
  SPLIT_HALVES_STORAGE_KEY === "jingyin-white-refine-split-halves-v1", SPLIT_HALVES_STORAGE_KEY);
check("半图文件名带左右标识且是 PNG",
  splitHalvesFileName("左", "26-16.png") === "26-16-左.png"
    && splitHalvesFileName("右", "") === "右.png",
  `${splitHalvesFileName("左", "26-16.png")} / ${splitHalvesFileName("右", "")}`);

// ---------- 3) 前端接线 ----------
check("开关只在精修页渲染（isWhiteRefineWorkflow）",
  /\{isWhiteRefineWorkflow && renderSplitHalvesStrip\(\)\}/.test(clientSource));
check("裁切只在精修任务成功后触发",
  /if \(taskIsWhiteRefine && splitHalves\) \{/.test(clientSource));
check("用任务自己的 workflowMode 判断（切页不会误裁）",
  /const taskIsWhiteRefine = taskWorkflowMode === "white-refine";/.test(clientSource));
check("两张半图走同一个保存接口、不塞子目录",
  /await saveProcessedImageToFolder\(file, ""\)/.test(clientSource));
check("裁切失败不吞错（有失败提示与事件）",
  /裁切失败：/.test(clientSource) && /addEvent\("精修裁切失败"/.test(clientSource));
check("开关按钮是 3.0 的绿色滑块结构（裁剪 + i > b）",
  /<span>裁剪<\/span>\s*<i><b \/><\/i>/.test(clientSource));
check("CSS 与 3.0 同款：滑块位移 20px、开启色 #49c85b",
  /translate\(20px\)/.test(cssSource) && /#49c85b/.test(cssSource));
check("服务端已有保存整理后图片的接口（半图复用同一条链路）",
  /app\.post\("\/api\/save-processed-image"/.test(serverSource));

// ---------- 4) 服务端保存链路：两张半图真的落盘 ----------
function tinyPng() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
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

freshSandbox(SANDBOX_ROOT);
const saveDir = path.join(SANDBOX_ROOT, "save");
// 保存目录必须是已存在的目录，否则服务端会回落到默认目录（normalizeUsableSaveDirectory 的口径）。
mkdirSync(saveDir, { recursive: true });
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

  const saved = [];
  for (const label of ["左", "右"]) {
    const form = new FormData();
    form.append("directory", saveDir);
    form.append("subfolder", "");
    form.append("image", new File([tinyPng()], splitHalvesFileName(label, "26-16.png"), { type: "image/png" }));
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/save-processed-image`, { method: "POST", body: form });
    const payload = await res.json().catch(() => null);
    saved.push({ status: res.status, payload });
  }
  const files = existsSync(saveDir) ? readdirSync(saveDir).sort() : [];
  check("两张半图都保存成功（HTTP 200 + ok）",
    saved.every((item) => item.status === 200 && item.payload?.ok === true),
    JSON.stringify(saved.map((item) => ({ status: item.status, ok: item.payload?.ok, message: item.payload?.message }))));
  check("保存目录里真的有 2 个文件", files.length === 2, files.join(","));
  check("两张半图直接落在保存目录根目录（服务端返回同一 directory）",
    saved.every((item) => item.payload?.directory === saveDir),
    JSON.stringify(saved.map((item) => item.payload?.directory)));
  check("按 V11 的日期序号命名（26-N.png），互不覆盖",
    files.length === 2 && new Set(files).size === 2 && files.every((name) => /^\d{2}-\d+\.png$/.test(name)),
    files.join(","));
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
  failures: failed.map((item) => ({ name: item.name, detail: item.detail }))
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
