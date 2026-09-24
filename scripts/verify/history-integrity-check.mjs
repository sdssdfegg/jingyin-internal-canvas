// 历史/结果引用完整性检查（只读，不修改任何数据）。
//
// 为什么要有它：V11 会把「历史记录」持久化到 data/history.json 与浏览器 IndexedDB，
// 但没有任何机制发现"记录还在、图片文件已经没了"的情况。这类脏记录会让结果卡片
// 每次打开页面都去请求一个不存在的文件（404），或者回退到早已退役的旧中转站域名（502），
// 用户看到的就是无法解释的空白卡片。
//
// 本脚本把这种不一致**变成可检测的**：
//   - 退出码 0：没有失效引用
//   - 退出码 1：存在失效引用（输出清单，便于清理）
//
// 用法：node scripts/verify/history-integrity-check.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const DIRS = {
  history: path.join(DATA, "history-images"),
  reference: path.join(DATA, "reference-assets"),
  canvas: path.join(DATA, "canvas-assets"),
  result: path.join(DATA, "results")
};

/** 把 localUrl 反解成磁盘路径；返回 null 表示这条记录不是本地文件。 */
function localPathFromUrl(localUrl) {
  const url = String(localUrl || "");
  const map = [
    ["/api/history-image/", DIRS.history],
    ["/api/reference-asset/", DIRS.reference],
    ["/api/canvas-asset/", DIRS.canvas],
    ["/api/result/", DIRS.result]
  ];
  for (const [prefix, dir] of map) {
    if (!url.startsWith(prefix)) continue;
    let name = url.slice(prefix.length);
    try { name = decodeURIComponent(name); } catch { /* 保留原样 */ }
    // 只取文件名，避免 ../ 之类的路径片段影响判断
    return path.join(dir, path.basename(name));
  }
  return null;
}

const issues = [];
const summary = {
  historyEntries: 0,
  checkedLocalFiles: 0,
  checkedReferences: 0,
  missingArchives: 0,
  missingReferences: 0,
  remoteOnlyImages: 0,
  // P1 之后：失效引用有两种状态 —— 已被服务端标记（自愈生效，属已知状态）
  // 与尚未标记（说明自愈没生效，才是真问题）。
  markedStale: 0,
  unmarkedStale: 0,
  staleRemoteHosts: []
};

const historyFile = path.join(DATA, "history.json");
if (!existsSync(historyFile)) {
  console.log(JSON.stringify({
    ok: true,
    note: "还没有 data/history.json，跳过检查",
    issues: []
  }, null, 2));
  process.exit(0);
}

let history;
try {
  history = JSON.parse(readFileSync(historyFile, "utf8"));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: `data/history.json 解析失败：${error.message}`,
    issues: [{ type: "history_json_unparsable", detail: String(error.message) }]
  }, null, 2));
  process.exit(1);
}
if (!Array.isArray(history)) {
  console.log(JSON.stringify({ ok: false, error: "data/history.json 不是数组", issues: [] }, null, 2));
  process.exit(1);
}

summary.historyEntries = history.length;

/** P1 之后：失效引用是否已被服务端标记（标记过就是自愈生效，不再算"新问题"）。 */
function recordStale(entry) {
  const marked = entry.marked === true;
  if (marked) summary.markedStale += 1;
  else summary.unmarkedStale += 1;
  issues.push(entry);
}

for (const item of history) {
  const image = item.image || {};

  // 1) 主图：优先看归档文件，其次看 localUrl 指向的本地文件
  const archiveFile = String(image.archiveFile || "");
  if (archiveFile) {
    summary.checkedLocalFiles += 1;
    const target = path.join(DIRS.history, path.basename(archiveFile));
    if (!existsSync(target)) {
      summary.missingArchives += 1;
      recordStale({
        type: "missing_archive",
        id: item.id,
        model: item.modelLabel || "",
        file: archiveFile,
        marked: image.missing === true,
        // 关键：归档丢了以后前端会去请求 sourceUrl，若那是退役域名就会 502
        fallbackRemote: String(image.sourceUrl || image.value || "").slice(0, 120),
        fix: "删除该历史条目，或把归档文件恢复回 data/history-images/"
      });
    }
  } else if (image.localUrl) {
    const target = localPathFromUrl(image.localUrl);
    if (target) {
      summary.checkedLocalFiles += 1;
      if (!existsSync(target)) {
        summary.missingArchives += 1;
        recordStale({
          type: "missing_local_file",
          id: item.id,
          file: path.basename(target),
          marked: image.missing === true,
          fix: "删除该历史条目，或恢复对应文件"
        });
      }
    } else if (String(image.type) === "url" && /^https?:\/\//i.test(String(image.value || ""))) {
      summary.remoteOnlyImages += 1;
      issues.push({
        type: "remote_only_image",
        id: item.id,
        remote: String(image.value).slice(0, 120),
        fix: "该结果只有远程地址、没有本地归档；上游链接失效后会显示坏图。建议重新生成或补做本地归档"
      });
    }
  }

  // 2) 参考图缩略图
  const references = Array.isArray(item.references) ? item.references : [];
  for (const reference of references) {
    const name = String(reference.archiveFile || "");
    if (!name) continue;
    summary.checkedReferences += 1;
    if (!existsSync(path.join(DIRS.reference, path.basename(name)))) {
      summary.missingReferences += 1;
      recordStale({
        type: "missing_reference_asset",
        id: item.id,
        referenceId: reference.id || "",
        file: name,
        marked: reference.missing === true,
        fix: "参考图缩略图已丢失；不影响已有成片，可选择忽略或删除该条目"
      });
    }
  }
}

// 顺带统计失效远程域名，便于判断是不是"旧中转站退役"这一类问题
const hostCounts = new Map();
for (const item of history) {
  const urls = [item.image?.sourceUrl, item.image?.value].filter((value) => typeof value === "string" && /^https?:\/\//i.test(value));
  for (const url of urls) {
    try {
      const host = new URL(url).host;
      hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    } catch { /* 忽略 */ }
  }
}
summary.staleRemoteHosts = [...hostCounts.entries()].map(([host, count]) => ({ host, count }));

// P1 之后判定标准变了：
//   失效引用**已被服务端标记**（image/reference.missing=true）→ 自愈已生效，属已知状态，不算失败；
//   失效引用**尚未标记** → 说明标注逻辑没跑到，才是需要处理的问题。
const ok = summary.unmarkedStale === 0 && summary.remoteOnlyImages === 0;
console.log(JSON.stringify({
  ok,
  note: ok
    ? (summary.markedStale > 0
      ? `没有未处理的失效引用；另有 ${summary.markedStale} 处已被标记（界面会显示"原图已失效"并可清理）`
      : "历史引用完整：没有指向不存在文件的记录")
    : "发现未标记的失效引用：标注逻辑可能没生效，请检查 GET /api/history 的标记与前端展示",
  summary,
  issueCount: issues.length,
  unmarkedCount: summary.unmarkedStale,
  issues: issues.slice(0, 50)
}, null, 2));

if (!ok) process.exitCode = 1;
