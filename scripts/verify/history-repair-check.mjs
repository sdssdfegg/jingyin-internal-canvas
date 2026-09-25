// P1 缺图自愈验证：失效历史引用的检测、标记、自愈与显式清理（本地沙箱，不联网、不扣费）。
//
// 覆盖：
//   1. GET /api/history 会把"归档文件已丢失"的条目标记出来（missing + missingReason），且**不删除任何条目**
//   2. 标记会落盘（下次打开不用重新算），且是**幂等**的：结论没变就不再写盘
//   3. 归档文件重新出现时，旧标记会被清掉（真正的"自愈"）
//   4. POST /api/history/repair 默认只标记不删除；只有显式 dropMissing:true 才清理
//   5. 第一次修复前会留 data/history.pre-repair-backup.json，可回退
//   6. 只删记录、不删磁盘上的图片文件
//   7. 沙箱之外的真实用户数据不受任何影响
//
// 用法：node scripts/verify/history-repair-check.mjs
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { freshSandbox, installExitCleanup, removeSandbox, stopChild } from "./lib/sandbox.mjs";

const ROOT = process.cwd();
const NODE = path.join(ROOT, "runtime", "node", "node.exe");
const APP_PORT = 8801;
// 每次运行用唯一沙箱目录：上一轮如果因为服务端句柄没释放而删不干净，
// 残留的 missing_1.png 会让"这个文件不存在"的种子失效（这个坑真实踩过）。
const SANDBOX_ROOT = path.join(
  ROOT,
  ".codex-artifacts",
  `history-repair-check-${Date.now().toString(36)}-${process.pid}`
);
const SANDBOX_DATA = path.join(SANDBOX_ROOT, "data");
const SANDBOX_IMAGES = path.join(SANDBOX_DATA, "history-images");
const SANDBOX_REFERENCES = path.join(SANDBOX_DATA, "reference-assets");
const SANDBOX_HISTORY = path.join(SANDBOX_DATA, "history.json");
const SANDBOX_BACKUP = path.join(SANDBOX_DATA, "history.pre-repair-backup.json");
const REAL_HISTORY = path.join(ROOT, "data", "history.json");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const log = (file) => (existsSync(file) ? sha256(file) : "");

function seedSandbox() {
  // 中途抛错时的兜底清理；正常路径在文件末尾显式收尾（要等进程真的退出）。
  installExitCleanup({ getChild: () => child, sandboxDir: SANDBOX_ROOT });
  // freshSandbox 是「真删 + 重建」：工作区路径上的 rmSync 会静默无效，
  // 残留的 missing_1.png 会让"这个文件不存在"的种子失效（这个坑真实踩过）。
  freshSandbox(SANDBOX_ROOT);
  mkdirSync(SANDBOX_IMAGES, { recursive: true });
  // 只有 healthy_1 的归档文件真实存在
  writeFileSync(path.join(SANDBOX_IMAGES, "healthy_1.png"), PNG);
  mkdirSync(SANDBOX_REFERENCES, { recursive: true });
  // 参考图：只有 missing_1_ref_1 的缩略图还在
  writeFileSync(path.join(SANDBOX_REFERENCES, "keep_ref.png"), PNG);
  const entries = [
    {
      id: "healthy_1",
      image: { type: "url", value: "/api/history-image/healthy_1.png", archiveFile: "healthy_1.png", localUrl: "/api/history-image/healthy_1.png" },
      prompt: "健康记录",
      modelLabel: "香蕉 2",
      imageSize: "2K",
      aspectRatio: "3:4",
      referenceCount: 0,
      generationMs: 1000,
      createdAt: 1790000000000
    },
    {
      id: "missing_1",
      image: { type: "url", value: "/api/history-image/missing_1.png", archiveFile: "missing_1.png", localUrl: "/api/history-image/missing_1.png", sourceUrl: "http://api.luckfill.com/v1/images/generated/gone.png" },
      // 参考图：一张归档还在，一张归档已丢失（都算"失效历史引用"）
      references: [
        { id: "missing_1_ref_1", name: "keep.png", role: "reference", index: 0, archiveFile: "keep_ref.png", localUrl: "/api/reference-asset/keep_ref.png" },
        { id: "missing_1_ref_2", name: "gone.png", role: "reference", index: 1, archiveFile: "gone_ref.png", localUrl: "/api/reference-asset/gone_ref.png" }
      ],
      referenceCount: 2,
      prompt: "归档丢失（有 archiveFile）",
      modelLabel: "香蕉 2",
      imageSize: "2K",
      aspectRatio: "3:4",
      generationMs: 2000,
      createdAt: 1790000000001
    },
    {
      id: "missing_2",
      image: { type: "url", value: "/api/history-image/missing_2.png", localUrl: "/api/history-image/missing_2.png" },
      prompt: "归档丢失（只有 localUrl）",
      modelLabel: "TT Image 2",
      imageSize: "2K",
      aspectRatio: "3:4",
      referenceCount: 0,
      generationMs: 3000,
      createdAt: 1790000000002
    }
  ];
  writeFileSync(SANDBOX_HISTORY, JSON.stringify(entries, null, 2), "utf8");
  return entries;
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

async function getHistory() {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/history`);
  return { status: res.status, body: await res.json() };
}

async function repair(body = {}) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/history/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

const realHistoryBefore = log(REAL_HISTORY);
const seeded = seedSandbox();

let child = null;
try {
  child = spawn(NODE, [path.join("server", "index.js")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      JINGYIN_PORT_FALLBACK_LIMIT: "0",
      JINGYIN_RELEASE_ROOT: SANDBOX_ROOT
    }
  });
  if (!(await waitForHealth(APP_PORT))) throw new Error("V11 测试实例未起来");

  // ---- 1) 首次读取：标记 + 落盘 + 不删除
  const first = await getHistory();
  const firstById = new Map((first.body.results || []).map((item) => [item.id, item]));
  check("GET /api/history 返回 200", first.status === 200, `status=${first.status}`);
  check("没有删除任何条目（3 条都还在）", (first.body.results || []).length === 3, `count=${(first.body.results || []).length}`);
  check("有 archiveFile 且文件丢失 → 标记 missing",
    firstById.get("missing_1")?.image?.missing === true && firstById.get("missing_1")?.image?.missingReason === "archive_missing",
    JSON.stringify(firstById.get("missing_1")?.image || {}).slice(0, 160));
  check("只有 localUrl 且文件丢失 → 标记 missing",
    firstById.get("missing_2")?.image?.missing === true && firstById.get("missing_2")?.image?.missingReason === "archive_missing",
    JSON.stringify(firstById.get("missing_2")?.image || {}).slice(0, 160));
  check("健康记录**没有**被误标", !firstById.get("healthy_1")?.image?.missing, JSON.stringify(firstById.get("healthy_1")?.image || {}).slice(0, 160));
  check("响应带完整性摘要 (missing=2)", first.body.integrity?.missing === 2, JSON.stringify(first.body.integrity || {}));

  // ---- 1b) 参考图缩略图的失效标记（同样是失效历史引用）
  const refHost = firstById.get("missing_1")?.references || [];
  const keepRef = refHost.find((reference) => reference.id === "missing_1_ref_1");
  const goneRef = refHost.find((reference) => reference.id === "missing_1_ref_2");
  check("参考图缩略图：归档还在的**不**标记",
    keepRef && !keepRef.missing,
    JSON.stringify(keepRef || {}));
  check("参考图缩略图：归档丢失的标记 reference_missing",
    goneRef && goneRef.missing === true && goneRef.missingReason === "reference_missing",
    JSON.stringify(goneRef || {}));
  // 关键：标记必须写进磁盘，否则下次读取又变回"未标记"
  //（normalizeReferenceAsset 曾经是字段白名单，会把 missing 丢掉 —— 这个 bug 就是这条断言抓出来的）
  {
    const persisted = JSON.parse(readFileSync(SANDBOX_HISTORY, "utf8"));
    const persistedRefs = persisted.find((item) => item.id === "missing_1")?.references || [];
    check("参考图失效标记已落盘（不被字段白名单丢掉）",
      persistedRefs.some((reference) => reference.id === "missing_1_ref_2" && reference.missing === true),
      JSON.stringify(persistedRefs.map((r) => ({ id: r.id, missing: r.missing }))));
  }
  check("标记已落盘到 history.json",
    JSON.parse(readFileSync(SANDBOX_HISTORY, "utf8")).filter((item) => item.image?.missing === true).length === 2,
    "磁盘上的 missing 条目数应为 2");
  check("第一次修复前生成了 pre-repair 备份，且含全部 3 条",
    existsSync(SANDBOX_BACKUP) && JSON.parse(readFileSync(SANDBOX_BACKUP, "utf8")).length === 3,
    existsSync(SANDBOX_BACKUP) ? `backup entries=${JSON.parse(readFileSync(SANDBOX_BACKUP, "utf8")).length}` : "备份不存在");

  // ---- 2) 幂等：结论没变就不再写盘
  const afterFirst = log(SANDBOX_HISTORY);
  const second = await getHistory();
  check("二次读取仍然报 missing=2", second.body.integrity?.missing === 2, JSON.stringify(second.body.integrity || {}));
  check("幂等：二次读取没有重复写盘",
    log(SANDBOX_HISTORY) === afterFirst,
    `before=${afterFirst.slice(0, 12)} after=${log(SANDBOX_HISTORY).slice(0, 12)}`);

  // ---- 3) 真正的自愈：文件回来了 → 标记清掉
  writeFileSync(path.join(SANDBOX_IMAGES, "missing_1.png"), PNG);
  const healed = await getHistory();
  const healedById = new Map((healed.body.results || []).map((item) => [item.id, item]));
  check("归档文件恢复后，旧标记被清除（自愈）",
    !healedById.get("missing_1")?.image?.missing && !healedById.get("missing_1")?.image?.missingReason,
    JSON.stringify(healedById.get("missing_1")?.image || {}).slice(0, 160));
  check("自愈后只剩 1 条失效（missing_2）", healed.body.integrity?.missing === 1, JSON.stringify(healed.body.integrity || {}));
  check("自愈结果也落盘",
    JSON.parse(readFileSync(SANDBOX_HISTORY, "utf8")).filter((item) => item.image?.missing === true).length === 1,
    "磁盘上的 missing 条目数应为 1");

  // ---- 4) repair 默认只标记、不删除
  const repairMarkOnly = await repair({ dropMissing: false });
  check("repair(dropMissing:false) 不删除任何条目",
    repairMarkOnly.body.dropped === 0 && repairMarkOnly.body.remaining === 3,
    JSON.stringify({ dropped: repairMarkOnly.body.dropped, remaining: repairMarkOnly.body.remaining }));
  check("repair 报告缺失 1 条", repairMarkOnly.body.missing === 1, JSON.stringify(repairMarkOnly.body));

  // ---- 5) repair(dropMissing:true) 才清理，且只清失效的
  const repairDrop = await repair({ dropMissing: true });
  check("repair(dropMissing:true) 只删除失效条目",
    repairDrop.body.dropped === 1 && repairDrop.body.remaining === 2,
    JSON.stringify({ dropped: repairDrop.body.dropped, remaining: repairDrop.body.remaining }));
  const finalIds = JSON.parse(readFileSync(SANDBOX_HISTORY, "utf8")).map((item) => item.id);
  check("健康记录与已自愈记录都保留",
    finalIds.includes("healthy_1") && finalIds.includes("missing_1") && !finalIds.includes("missing_2"),
    finalIds.join(","));

  // ---- 6) 只删记录，不删磁盘图片
  check("清理记录时**没有**删除磁盘上的图片文件",
    existsSync(path.join(SANDBOX_IMAGES, "healthy_1.png")) && existsSync(path.join(SANDBOX_IMAGES, "missing_1.png")),
    "healthy_1.png 与 missing_1.png 都应仍在");

  // ---- 7) 前端展示契约：标记 missing 时不给 src（因此不会发请求）
  const resultImage = await import("../../src/shared/result-image.js");
  const marked = resultImage.resultImageCardState({ missing: true, missingReason: "archive_missing" }, () => "/api/history-image/x.png");
  check("共享模块：已标记 missing → src 为空（客户端不会发请求）",
    marked.missing === true && marked.src === "" && /归档文件已丢失/.test(marked.reason),
    JSON.stringify(marked));
  const healthy = resultImage.resultImageCardState({ localUrl: "/api/history-image/ok.png" }, (image) => image.localUrl);
  check("共享模块：正常记录 → 返回 src 且不标记",
    healthy.missing === false && healthy.src === "/api/history-image/ok.png",
    JSON.stringify(healthy));
  const noSrc = resultImage.resultImageCardState({ type: "url", value: "" }, () => "");
  check("共享模块：拿不到任何地址 → 归为缺图并给出原因",
    noSrc.missing === true && noSrc.src === "" && Boolean(noSrc.reason),
    JSON.stringify(noSrc));
  check("共享模块：参考图失效原因有专属文案",
    /参考图缩略图已丢失/.test(resultImage.resultImageMissingText({ missingReason: "reference_missing" })),
    resultImage.resultImageMissingText({ missingReason: "reference_missing" }));
} catch (error) {
  results.push({ name: "fatal", pass: false, detail: error instanceof Error ? error.message : String(error) });
} finally {
  await stopChild(child);
}

await new Promise((resolve) => setTimeout(resolve, 500));

// ---- 8) 真实用户数据没被动过
check("沙箱之外的真实 data/history.json 未被改动",
  log(REAL_HISTORY) === realHistoryBefore,
  `before=${realHistoryBefore.slice(0, 12)} after=${log(REAL_HISTORY).slice(0, 12)}`);

const sandboxRemoved = await removeSandbox(SANDBOX_ROOT);

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  sandboxRemoved,
  seededEntries: seeded.length,
  results
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
