// 「最近生图变快」只读取证：从现有日志里把各阶段耗时拆开（不做任何付费生图）。
//
// 只读 logs/generation.jsonl，按真实上游（排除 127.0.0.1 的 mock 记录）分桶统计：
//   - 服务端总耗时 totalMs / 上游等待 channelWaitMs / 解析 parseMs
//   - 客户端显示耗时 displayMs（client-result-display-ready）
//   - 按模型 + 协议（multipart/json）+ 请求格式分组，便于判断"变快"发生在哪一段
// 同时列出所有 >=60 秒的慢请求及其 failureReason，作为"慢/无结果"那段时间的样本。
//
// 用法：node scripts/verify/speed-investigation.mjs
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const LOG = path.join(process.cwd(), "logs", "generation.jsonl");
if (!existsSync(LOG)) {
  console.log(JSON.stringify({ ok: false, error: "logs/generation.jsonl 不存在", evidence: "insufficient" }, null, 2));
  process.exit(0);
}

const lines = readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean);
const entries = [];
for (const line of lines) {
  try {
    entries.push(JSON.parse(line));
  } catch { /* 跳过坏行 */ }
}

// mock 记录识别：不能只看单条记录里有没有 127.0.0.1 —— 同一次 mock 请求的
// "upstream-api-images-ready" 记录本身不带 url，只能靠 requestId 关联起来一起排除。
const mockRequestIds = new Set();
for (const entry of entries) {
  const text = JSON.stringify(entry);
  if (/127\.0\.0\.1:88\d\d|127\.0\.0\.1:889\d|img\.invalid\.localhost/.test(text) || /mock upstream/.test(text)) {
    if (entry.requestId) mockRequestIds.add(entry.requestId);
  }
}
function isMock(entry) {
  if (entry.requestId && mockRequestIds.has(entry.requestId)) return true;
  const text = JSON.stringify(entry);
  return /127\.0\.0\.1:88\d\d|127\.0\.0\.1:889\d|img\.invalid\.localhost/.test(text) || /mock upstream/.test(text);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function hourBucket(iso) {
  return String(iso || "").slice(0, 13); // YYYY-MM-DDTHH
}

const real = entries.filter((entry) => !isMock(entry));

// ---- 1) 真实生图请求：成功/失败 + 阶段耗时
// 注意：请求记录（stage=forward-api-images-request）没有 timing；
// 带 timing 的是**响应**记录（成功那条没有 stage 字段）和失败记录（stage=api-images-channel-error）。
// 所以阶段统计统一用"带 timing.totalMs 的记录"。
const forwarded = real.filter((entry) => entry.stage === "forward-api-images-request");
// 每次请求只保留一条带 url 的完成记录：
//   - 成功 = 响应记录（有 url + timing）
//   - 失败 = api-images-channel-error（有 url + timing）
// "upstream-api-images-ready" 是同一次请求的另一条记录，重复计入会把中位数拉低。
const completions = real.filter((entry) => (
  entry.url
  && entry.timing
  && Number.isFinite(Number(entry.timing.totalMs))
  && (entry.ok === true || entry.stage === "api-images-channel-error")
));
const succeeded = completions.filter((entry) => entry.ok === true);
const channelErrors = completions.filter((entry) => entry.ok === false);
const clientErrors = real.filter((entry) => entry.stage === "client-generation-error");
const submits = real.filter((entry) => entry.stage === "client-generation-submit");
const displayReady = real.filter((entry) => entry.stage === "client-result-display-ready");

// ---- 2) 按时间桶聚合每个阶段
const buckets = new Map();
for (const entry of completions) {
  const bucket = hourBucket(entry.time);
  if (!buckets.has(bucket)) {
    buckets.set(bucket, {
      bucket,
      requests: 0,
      ok: 0,
      failed: 0,
      totalMs: [],
      channelWaitMs: [],
      parseMs: [],
      models: new Set(),
      protocols: new Set(),
      formats: new Set()
    });
  }
  const item = buckets.get(bucket);
  item.requests += 1;
  if (entry.ok === true) item.ok += 1;
  else item.failed += 1;
  const timing = entry.timing || {};
  if (Number.isFinite(Number(timing.totalMs))) item.totalMs.push(Number(timing.totalMs));
  if (Number.isFinite(Number(timing.channelWaitMs))) item.channelWaitMs.push(Number(timing.channelWaitMs));
  if (Number.isFinite(Number(timing.parseMs))) item.parseMs.push(Number(timing.parseMs));
  if (entry.model) item.models.add(entry.model);
  if (entry.protocol) item.protocols.add(entry.protocol);
  if (entry.requestFormat) item.formats.add(entry.requestFormat);
}

const bucketRows = [...buckets.values()]
  .sort((a, b) => a.bucket.localeCompare(b.bucket))
  .map((item) => ({
    bucket: item.bucket,
    requests: item.requests,
    ok: item.ok,
    failed: item.failed,
    totalMedianMs: median(item.totalMs),
    totalMaxMs: item.totalMs.length ? Math.max(...item.totalMs) : null,
    channelWaitMedianMs: median(item.channelWaitMs),
    parseMedianMs: median(item.parseMs),
    // 本地开销 = 总耗时 - 上游等待（含组装、上传、解析）
    localMedianMs: item.totalMs.length && item.channelWaitMs.length
      ? Math.max(0, (median(item.totalMs) || 0) - (median(item.channelWaitMs) || 0))
      : null,
    models: [...item.models],
    protocols: [...item.protocols],
    formats: [...item.formats]
  }));

// ---- 3) 慢请求样本（>=60s）与失败样本
const slow = completions
  .filter((entry) => Number(entry.timing?.totalMs) >= 60000)
  .map((entry) => ({
    time: entry.time,
    ok: entry.ok === true,
    stage: entry.stage || "image-response",
    model: entry.model,
    protocol: entry.protocol,
    requestFormat: entry.requestFormat,
    totalMs: entry.timing?.totalMs,
    channelWaitMs: entry.timing?.channelWaitMs,
    failureReason: entry.failureReason || "",
    upstreamError: String(entry.upstreamError || "").slice(0, 60)
  }));

// ---- 4) 客户端显示耗时
const displayByBucket = new Map();
for (const entry of displayReady) {
  const bucket = hourBucket(entry.time);
  if (!displayByBucket.has(bucket)) displayByBucket.set(bucket, []);
  const ms = Number(entry.detail?.displayMs ?? entry.durationMs);
  if (Number.isFinite(ms)) displayByBucket.get(bucket).push(ms);
}

// ---- 5) 结论所需的关键对比：Pro 的 multipart 时期 vs JSON 时期
function statsFor(filterFn) {
  const list = completions.filter(filterFn);
  const totals = list.map((entry) => Number(entry.timing?.totalMs)).filter(Number.isFinite);
  const waits = list.map((entry) => Number(entry.timing?.channelWaitMs)).filter(Number.isFinite);
  const local = list
    .map((entry) => Number(entry.timing?.totalMs) - Number(entry.timing?.channelWaitMs))
    .filter(Number.isFinite);
  return {
    requests: list.length,
    ok: list.filter((entry) => entry.ok === true).length,
    failed: list.filter((entry) => entry.ok === false).length,
    totalMedianMs: median(totals),
    totalMinMs: totals.length ? Math.min(...totals) : null,
    totalMaxMs: totals.length ? Math.max(...totals) : null,
    channelWaitMedianMs: median(waits),
    localMedianMs: median(local),
    slowOver60s: totals.filter((value) => value >= 60000).length
  };
}

const proMultipart = statsFor((entry) => entry.model === "nano-banana-pro" && entry.protocol === "multipart");
const proJson = statsFor((entry) => entry.model === "nano-banana-pro" && entry.protocol === "json");
const controlMultipart = statsFor((entry) => entry.model !== "nano-banana-pro" && entry.protocol === "multipart");

console.log(JSON.stringify({
  source: path.relative(process.cwd(), LOG),
  logLines: lines.length,
  parsed: entries.length,
  realEntries: real.length,
  mockEntriesExcluded: entries.length - real.length,
  counts: {
    submits: submits.length,
    requests: forwarded.length,
    completions: completions.length,
    succeeded: succeeded.length,
    channelErrors: channelErrors.length,
    clientErrors: clientErrors.length,
    displayReady: displayReady.length
  },
  timeRange: {
    first: entries[0]?.time || "",
    last: entries[entries.length - 1]?.time || ""
  },
  stageBreakdownByHour: bucketRows,
  clientDisplayMedianByHour: [...displayByBucket.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, values]) => ({ bucket, samples: values.length, displayMedianMs: median(values) })),
  comparison: {
    proMultipart,
    proJson,
    controlMultipart
  },
  slowRequestsOver60s: slow
}, null, 2));
