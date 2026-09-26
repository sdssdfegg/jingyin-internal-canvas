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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { installExitCleanup, stopChild } from "./lib/sandbox.mjs";
import {
  formatPixelSize,
  localPasteSizeReport,
  resolveLocalEditBaseFile
} from "../../src/shared/local-edit-geometry.js";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8812;
const GEOMETRY_FILE = path.join(ROOT, "src", "shared", "local-edit-geometry.js");
const OUTFIT_FILE = path.join(ROOT, "src", "outfit-workflow.jsx");
const MAIN_FILE = path.join(ROOT, "src", "main.jsx");
const SERVER_FILE = path.join(ROOT, "server", "index.js");
const STYLES_FILE = path.join(ROOT, "src", "styles.css");
const EMBEDDED_STYLES_FILE = path.join(ROOT, "src", "outfit-workflow.css");
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

// ---------------------------------------------------------------- 尺寸对账单（用户口径：给多少尺寸 → 返回多少尺寸）
{
  check("formatPixelSize 输出 W×H，缺值返回空串",
    formatPixelSize(2334, 3500) === "2334×3500" && formatPixelSize(0, 100) === "" && formatPixelSize(undefined, undefined) === "",
    `${formatPixelSize(2334, 3500)} / ${formatPixelSize(0, 100) || "(空)"}`);
  const ok = localPasteSizeReport({
    base: { width: 2334, height: 3500 },
    rect: { x: 295, y: 1317, width: 1637, height: 2183 },
    output: { width: 2334, height: 3500 }
  });
  check("对账单：底图/选框/输出尺寸齐全且判定同尺寸",
    ok.base === "2334×3500" && ok.rect === "1637×2183" && ok.rectAt === "295,1317" && ok.output === "2334×3500" && ok.matches === true,
    JSON.stringify(ok));
  const bad = localPasteSizeReport({
    base: { width: 2334, height: 3500 },
    rect: { x: 295, y: 1317, width: 1637, height: 2183 },
    output: { width: 2049, height: 3072 }
  });
  check("对账单：输出与底图不一致时必须判为不通过（事故签名）",
    bad.matches === false && bad.base === "2334×3500" && bad.output === "2049×3072",
    JSON.stringify(bad));
  const withCopy = localPasteSizeReport({
    base: { width: 5350, height: 8021 },
    uploadCopy: { width: 2049, height: 3072 },
    rect: { x: 100, y: 200, width: 1200, height: 1600 },
    output: { width: 5350, height: 8021 }
  });
  check("对账单：能同时给出上传副本尺寸（解释 3072 与 8021 的差别）",
    withCopy.uploadCopy === "2049×3072" && withCopy.base === "5350×8021" && withCopy.matches === true,
    JSON.stringify(withCopy));
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

// 尺寸可见性接线：用户口径是"我给的图多少尺寸，返回的就是多少尺寸"，
// 所以"底图尺寸 / 输出尺寸"必须在界面上和任务日志里都能看到，不用靠肉眼猜。
const serverSrc = readFileSync(SERVER_FILE, "utf8");
const stylesSrc = readFileSync(STYLES_FILE, "utf8");
const embeddedStylesSrc = readFileSync(EMBEDDED_STYLES_FILE, "utf8");

check("批量：贴回后发出尺寸对账单诊断事件（client-generation-local-paste-composed）",
  /stage: "client-generation-local-paste-composed"/.test(outfitSrc)
    && /localPaste: localPasteSizes/.test(outfitSrc)
    && /const localPasteSizes = localPasteSizeReport\(\{/.test(outfitSrc),
  "runSingleTask 贴回");
check("批量：贴回尺寸异常时会明确报事件（而不是静默）",
  /if \(!localPasteSizes\.matches\) \{[\s\S]{0,200}?addEvent\("贴回尺寸异常"/.test(outfitSrc),
  "matches=false 分支");
check("批量：局部回贴弹窗标题显示底图尺寸与「输出同尺寸」",
  /底图 \{baseSizeText \|\| "读取中…"\} · 生成后贴回同一坐标，输出同尺寸/.test(outfitSrc),
  "OutfitLocalEditModal");
check("批量：选框与当前底图尺寸不一致时给出偏移警告",
  /const staleRect = Boolean\(/.test(outfitSrc) && /className="quickLocalEditWarning" role="alert"/.test(outfitSrc),
  "staleRect");
check("批量：图1缩略图同时显示局部选框尺寸与局部回贴底图尺寸",
  /thumbSizeRef\.current\.get\(item\.id\)/.test(outfitSrc)
    && /局部 \$\{formatPixelSize\(item\.localEdit\.cropRect\.width, item\.localEdit\.cropRect\.height\)\} · 底图 \$\{formatPixelSize\(item\.localEdit\.sourceWidth, item\.localEdit\.sourceHeight\)\}/.test(outfitSrc)
    && /上传 \$\{formatPixelSize\(thumbSizeRef\.current\.get\(item\.id\)\.width/.test(outfitSrc),
  "UploadZone thumbMeta");
check("快捷：局部回贴弹窗同样显示底图尺寸与偏移警告",
  /const baseSizeText = formatPixelSize\(imageSize\.width, imageSize\.height\)/.test(mainSrc)
    && /className="quickLocalEditWarning" role="alert"/.test(mainSrc)
    && /const staleRect = Boolean\(/.test(mainSrc),
  "QuickLocalEditModal");
check("服务端：把该事件写进任务日志（标题 + 底图/输出尺寸 + 一致性）",
  /"client-generation-local-paste-composed": "局部回贴贴回合成完成"/.test(serverSrc)
    && /贴回底图尺寸：\$\{localPaste\.base\}/.test(serverSrc)
    && /贴回输出尺寸：\$\{localPaste\.output\}/.test(serverSrc)
    && /尺寸一致性：\$\{localPaste\.matches \? "输出与底图同尺寸" : "输出与底图不一致（异常，请反馈）"\}/.test(serverSrc),
  "server/index.js");
check("偏移警告样式在两个主题里都有定义",
  /\.quickLocalEditWarning \{/.test(stylesSrc) && /\.outfitWorkflowEmbedded \.quickLocalEditWarning \{/.test(embeddedStylesSrc),
  "styles.css + outfit-workflow.css");

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

/**
 * 端到端验证"贴回尺寸会写进任务日志"：
 * 往自建实例发一条 `client-generation-local-paste-composed`，再读回它的任务日志文本。
 * 用的是写入当天 logs/tasks/<date>/ 的临时文件，验证完删掉（不留测试垃圾）。
 */
async function verifyTaskLogWiring() {
  const requestId = `task_1_verify-localpaste-${process.pid}`;
  const folder = new Date();
  const dateKey = `${folder.getFullYear()}-${String(folder.getMonth() + 1).padStart(2, "0")}-${String(folder.getDate()).padStart(2, "0")}`;
  const logFile = path.join(ROOT, "logs", "tasks", dateKey, `${requestId}.txt`);
  try {
    const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/client-diagnostic-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        stage: "client-generation-local-paste-composed",
        endpoint: "/api/generate-outfit",
        method: "COMPOSE",
        ok: true,
        detail: {
          taskId: requestId,
          baseName: "JY_4.jpg",
          localPaste: {
            base: "5350×8021",
            rect: "1637×2183",
            rectAt: "295,1317",
            output: "5350×8021",
            matches: true
          }
        }
      })
    });
    if (!response.ok) throw new Error(`诊断事件写入失败 HTTP ${response.status}`);
    let text = "";
    for (let attempt = 0; attempt < 20 && !text; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    }
    check("端到端：贴回尺寸诊断会写进任务日志（标题 + 四个尺寸 + 一致性）",
      /局部回贴贴回合成完成/.test(text)
        && /贴回底图尺寸：5350×8021/.test(text)
        && /选框尺寸：1637×2183 @ \(295,1317\)/.test(text)
        && /贴回输出尺寸：5350×8021/.test(text)
        && /尺寸一致性：输出与底图同尺寸/.test(text),
      text ? "logs/tasks 临时日志已核对" : "任务日志未生成");
  } catch (error) {
    check("端到端：贴回尺寸诊断会写进任务日志（标题 + 四个尺寸 + 一致性）", false, error instanceof Error ? error.message : String(error));
  } finally {
    // 清理要用显式 unlinkSync：这台机器上 fs.rmSync 对工作区路径是静默空操作
    // （见 scripts/verify/lib/sandbox.mjs 的说明）。
    try { if (existsSync(logFile)) unlinkSync(logFile); } catch { /* 清理失败不影响结论 */ }
    check("端到端：临时任务日志已清理（不留测试垃圾）", !existsSync(logFile), path.relative(ROOT, logFile));
  }
}

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

  // 端到端：真的发一条贴回尺寸诊断给服务端，确认它被写进任务日志
  // （界面上看得到尺寸，日志里也要留痕，才能复核"给多少→返回多少"）。
  await verifyTaskLogWiring();

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
