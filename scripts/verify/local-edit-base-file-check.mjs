// 局部回贴「贴回底图 = 与选框同一张原图」验证（源码接线 + 真实浏览器，不打上游、不扣费）。
//
// 事故（2026-09-26 批量局部回贴 5 张全部错）：
//   原图 2334×3500，上传副本被压到长边 3072（2049×3072）；
//   选框/裁剪按 originalFile 坐标算，贴回底图却用了「上传副本优先」的 imageItemUploadFile()，
//   结果把 3500 空间的选框贴到 3072 画布上：输出 2049×3072、补丁放大约 1.14 倍并偏移。
//   文件证据：data/results 里同一批任务，第一张合成结果 2334×3500（正确），
//   后面 5 张合成结果全是 2049×3072（错误）。
//
// 覆盖：
//   源码级：裁剪源/预览/诊断快照/贴回底图都走 resolveLocalEditBaseFile（原图优先）；
//           贴回不再用 imageItemUploadFile；快捷生成侧同一份规则；
//           上传副本上限仍是 3072（探针里的反例尺寸与线上压缩结果对得上）
//   逻辑级：resolveLocalEditBaseFile 原图优先 / 取不到退回上传副本 / null 安全
//   浏览器：裁剪取原图坐标；贴回输出 = 原图尺寸；选框外像素 = 底图、选框内像素 = 补丁；
//           反例：错用上传副本当底图必然是 2049×3072（证明前几条断言抓得住事故）
//
// 关于实例：Vite 的 root 就是 server 的 rootDir（= JINGYIN_RELEASE_ROOT），所以不能带沙盒
// root（否则模块取不到）。这里用自己的端口 8812 + 独立 origin；data/ 是共享的，前后比对
// history.json 指纹。
//
// 用法：node scripts/verify/local-edit-base-file-check.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { installExitCleanup, stopChild } from "./lib/sandbox.mjs";
import { resolveLocalEditBaseFile } from "../../src/shared/local-edit-geometry.js";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8812;
const GEOMETRY_FILE = path.join(ROOT, "src", "shared", "local-edit-geometry.js");
const OUTFIT_FILE = path.join(ROOT, "src", "outfit-workflow.jsx");
const MAIN_FILE = path.join(ROOT, "src", "main.jsx");
const HISTORY_FILE = path.join(ROOT, "data", "history.json");
const CLI = path.join(process.env.LOCALAPPDATA || "", "Tabbit", "LocalAgent", "bin", "tabbit-cli.exe");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

// ---------------------------------------------------------------- 逻辑级
{
  const original = { tag: "original" };
  const upload = { tag: "upload" };
  check("原图优先：originalFile 与 file 都在时取 originalFile",
    resolveLocalEditBaseFile({ originalFile: original, file: upload }) === original,
    "originalFile first");
  check("只有上传副本时退回 file",
    resolveLocalEditBaseFile({ file: upload }) === upload,
    "fallback to file");
  check("两份都没有时返回 null（不抛异常）",
    resolveLocalEditBaseFile({}) === null && resolveLocalEditBaseFile(null) === null && resolveLocalEditBaseFile(undefined) === null,
    "null safe");
}

// ---------------------------------------------------------------- 源码级接线
const geometrySrc = readFileSync(GEOMETRY_FILE, "utf8");
const outfitSrc = readFileSync(OUTFIT_FILE, "utf8");
const mainSrc = readFileSync(MAIN_FILE, "utf8");

check("共享模块导出 resolveLocalEditBaseFile 且规则是「原图优先」",
  /export function resolveLocalEditBaseFile\(item\)\s*\{[\s\S]{0,400}?return item\.originalFile \|\| item\.file \|\| null;/.test(geometrySrc),
  "src/shared/local-edit-geometry.js");

check("批量：选框裁剪用 resolveLocalEditBaseFile(imageItem)",
  /const originalFile = resolveLocalEditBaseFile\(imageItem\);/.test(outfitSrc),
  "cropOutfitLocalEditFile");
check("批量：局部回贴弹窗预览用 resolveLocalEditBaseFile(item)",
  /const originalFile = resolveLocalEditBaseFile\(item\);/.test(outfitSrc),
  "OutfitLocalEditModal");
check("批量：诊断快照用 resolveLocalEditBaseFile(task?.modelItem)",
  /localEditFileSnapshot\(resolveLocalEditBaseFile\(task\?\.modelItem\)\)/.test(outfitSrc),
  "localEditTaskBindingSnapshot");
check("批量：任务贴回底图用 resolveLocalEditBaseFile(task.modelItem)",
  /const originalFile = resolveLocalEditBaseFile\(task\.modelItem\);/.test(outfitSrc),
  "runSingleTask 贴回");
// 只盯「本地贴回合成」这一段：底图必须是原图，且这段**代码**里不能再出现上传副本取值。
// （先把注释剥掉，否则"不要用 imageItemUploadFile"这句注释本身会被当成违规。）
const pasteBlockRaw = /updateTaskRuntime\(task\.id, "本地贴回合成"([\s\S]{0,1500}?)composeOutfitLocalEditBlob\(/.exec(outfitSrc)?.[1] || "";
const pasteBlock = pasteBlockRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
check("批量：贴回底图不再用 imageItemUploadFile（上传副本优先）",
  pasteBlock.includes("resolveLocalEditBaseFile(task.modelItem)") && !pasteBlock.includes("imageItemUploadFile"),
  pasteBlockRaw ? "本地贴回合成段内检查" : "没找到「本地贴回合成」段");
check("批量：局部详情面板贴回底图同样走共享规则",
  /composeOutfitLocalEditBlob\(\s*\n\s*resolveLocalEditBaseFile\(selectedBase\),/.test(outfitSrc),
  "LocalDetailPanel");
check("批量：上传副本取值函数仍在，且真的用于上传（没有被误改）",
  /function imageItemUploadFile\(item\)\s*\{\s*return item\?\.file \|\| item\?\.originalFile \|\| null;\s*\}/.test(outfitSrc)
    && /form\.append\("image", modelUploadFile/.test(outfitSrc),
  "imageItemUploadFile 仍供上传使用");
check("扩图仍自洽（原图保护底图与扩图画布同一文件）",
  /prepareOutpaintUploadCanvas\(taskModelFile, taskAspectRatio\)/.test(outfitSrc)
    && /const taskModelFile = imageItemUploadFile\(task\.modelItem\);/.test(outfitSrc),
  "outpaint 未受影响");
check("快捷生成侧委托同一份规则（原图优先，裸 File 兜底）",
  /function quickReferenceOriginalFile\(item\)\s*\{[\s\S]{0,200}?return resolveLocalEditBaseFile\(item\) \|\| item;/.test(mainSrc),
  "src/main.jsx");
check("上传副本长边上限仍是 3072（探针反例尺寸与线上压缩一致）",
  /CHANNEL_UPLOAD_MAX_SIDE = 3072;/.test(outfitSrc) && /CHANNEL_UPLOAD_MAX_SIDE = 3072;/.test(mainSrc),
  "3072");

// ---------------------------------------------------------------- 浏览器
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

const hashOf = (file) => {
  try { return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) : "(不存在)"; }
  catch { return "(读不到)"; }
};

let child = null;
let facts = null;
let browserReason = "";
const historyBefore = hashOf(HISTORY_FILE);
try {
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PORT: String(APP_PORT), JINGYIN_PORT_FALLBACK_LIMIT: "0", JINGYIN_NO_BROWSER: "1" }
  });
  installExitCleanup({ getChild: () => child });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  if (!existsSync(CLI)) {
    browserReason = "tabbit-cli 不存在，跳过浏览器部分";
  } else {
    const program = `
await page.goto("http://127.0.0.1:${APP_PORT}/", {waitUntil: "domcontentloaded"});
await page.waitForTimeout(1500);
const facts = await page.evaluate(async () => {
  const mod = await import("/scripts/verify/local-edit-base-page.js?v=" + Date.now());
  return await mod.run();
});
return facts;
`;
    const stdout = await new Promise((resolve) => {
      const cli = spawn(CLI, [
        "nodejs",
        "--task", "V11 local edit base file check",
        "--request-id", `localeditbase-${process.pid}`,
        "--timeout-ms", "180000"
      ], { windowsHide: true });
      let buffer = "";
      cli.stdout.on("data", (chunk) => { buffer += String(chunk); });
      cli.stderr.on("data", (chunk) => { buffer += String(chunk); });
      cli.on("error", () => resolve(""));
      cli.on("close", () => resolve(buffer));
      try {
        cli.stdin.write(program);
        cli.stdin.end();
      } catch { /* ignore */ }
    });
    const start = stdout.indexOf('{"result"');
    if (start >= 0) {
      const tail = stdout.slice(start);
      for (let cut = tail.lastIndexOf("}"); cut > 0 && !facts; cut -= 1) {
        if (tail[cut] !== "}") continue;
        try { facts = JSON.parse(tail.slice(0, cut + 1))?.result?.value || null; } catch { /* 继续往前找 */ }
      }
    }
    if (!facts) browserReason = `浏览器回执无法解析（长度 ${stdout.length}）`;
  }
} catch (error) {
  browserReason = error instanceof Error ? error.message : String(error);
} finally {
  await stopChild(child);
}

if (facts) {
  check("浏览器：原图 2334×3500、上传副本 2049×3072（复刻事故输入）",
    facts.sourceSize?.width === 2334 && facts.sourceSize?.height === 3500
      && facts.uploadCopySize?.width === 2049 && facts.uploadCopySize?.height === 3072,
    `原图 ${facts.sourceSize?.width}×${facts.sourceSize?.height} 副本 ${facts.uploadCopySize?.width}×${facts.uploadCopySize?.height}`);
  check("浏览器：resolveLocalEditBaseFile 返回原图 / 缺原图才退回副本 / null 安全",
    facts.resolvedIsOriginal === true && facts.resolvedFallsBackToUpload === true && facts.resolvedNullSafe === true,
    `original=${facts.resolvedIsOriginal} fallback=${facts.resolvedFallsBackToUpload} nullSafe=${facts.resolvedNullSafe}`);
  check("浏览器：裁剪尺寸 == 选框尺寸（1200×1600）",
    facts.cropSize?.width === 1200 && facts.cropSize?.height === 1600,
    `${facts.cropSize?.width}×${facts.cropSize?.height}`);
  check("浏览器：裁剪内容取自原图坐标（不是上传副本坐标）",
    facts.cropPixelMatchesOriginal === true && facts.cropPixelMatchesUploadCopy === false,
    `原图命中=${facts.cropPixelMatchesOriginal} 副本命中=${facts.cropPixelMatchesUploadCopy}`);
  check("浏览器：贴回输出 == 原图尺寸（2334×3500，不是 2049×3072）",
    facts.composedEqualsOriginalSize === true,
    `${facts.composedSize?.width}×${facts.composedSize?.height}`);
  check("浏览器：选框外像素与底图逐点相同（贴回只改选框内）",
    facts.outsidePixelsMatchOriginal === true,
    "7 个选框外采样点");
  check("浏览器：选框内像素与补丁逐点相同（补丁没有被缩放/偏移）",
    facts.insidePixelsMatchPatch === true,
    "4 个选框内采样点");
  check("浏览器：反例——错用上传副本当底图必然是 2049×3072（断言有判别力）",
    facts.wrongBaseIsUploadCopySize === true && facts.wrongBaseDiffersFromOriginal === true,
    `错用副本 → ${facts.wrongBaseSize?.width}×${facts.wrongBaseSize?.height}`);
} else {
  check("浏览器探针未执行", false, browserReason || "未知原因");
}

const historyAfter = hashOf(HISTORY_FILE);
check("真实 data/history.json 未被本次验证改动", historyBefore === historyAfter,
  `before=${historyBefore} after=${historyAfter}`);

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  passed: results.length - failed.length,
  total: results.length,
  failed: failed.length,
  browser: facts ? "ran" : `skipped: ${browserReason}`,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
