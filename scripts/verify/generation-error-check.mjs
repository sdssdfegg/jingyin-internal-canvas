// 生图错误提示 + loading 清理验证（纯 node，不联网、不出图、不扣费）。
//
// 覆盖任务要求的 10 类错误，以及每种路径 loading 都能结束：
//   1. 网络连接失败      2. 请求超时        3. 用户取消
//   4. 模型或渠道不可用   5. 参数不支持/参数错误
//   6. 上传图片过大/格式不支持               7. 服务器返回错误
//   8. 响应缺少图片      9. 图片 URL 无效/结果下载失败
//  10. 未知错误
//
// 另外验证：
//   - 优先保留服务端真实原因（不会一律变成"生成失败"）
//   - 带上 requestId
//   - 不泄露 KEY / Authorization / 堆栈
//   - 不包含自动重试（分类器是纯函数，且不产生任何网络行为）
//
// 用法：node scripts/verify/generation-error-check.mjs
import {
  GENERATION_ERROR_KINDS,
  classifyGenerationError,
  describeEmptyResult,
  formatGenerationError,
  sanitizeErrorText
} from "../../src/shared/generation-errors.js";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

class FakeApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.payload = options.payload || null;
    this.requestId = options.requestId || "";
  }
}

const CASES = [
  {
    name: "1 网络连接失败",
    error: new TypeError("fetch failed"),
    context: { requestId: "req-net-1" },
    expectKind: GENERATION_ERROR_KINDS.NETWORK
  },
  {
    name: "1b 网络连接失败（ECONNREFUSED）",
    error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { cause: { code: "ECONNREFUSED" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.NETWORK
  },
  {
    name: "2 请求超时（504 channel_timeout）",
    error: new FakeApiError("生成超时，请重新生成。", { status: 504, payload: { error: "channel_timeout", requestId: "req-timeout-1" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.TIMEOUT
  },
  {
    name: "2b 请求超时（AbortError，非用户取消）",
    error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.TIMEOUT
  },
  {
    name: "3 用户取消",
    error: Object.assign(new Error("The user aborted a request."), { name: "AbortError" }),
    context: { cancelled: true },
    expectKind: GENERATION_ERROR_KINDS.CANCELLED
  },
  {
    name: "4 模型或渠道不可用（manual_channel_required）",
    error: new FakeApiError("manual_channel_required", { status: 400, payload: { error: "manual_channel_required", message: "manual_channel_required" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.CHANNEL_UNAVAILABLE
  },
  {
    name: "4b 模型或渠道不可用（model_not_found）",
    error: new FakeApiError("model not found", { status: 404, payload: { error: "model_not_found" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.CHANNEL_UNAVAILABLE
  },
  {
    name: "5 参数不支持/参数错误",
    error: new FakeApiError("unsupported aspect ratio 7:3", { status: 400, payload: { error: "invalid_request_error", message: "unsupported aspect ratio 7:3" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.INVALID_REQUEST
  },
  {
    name: "6 上传图片过大/格式不支持（413）",
    error: new FakeApiError("image too large: max 4MB", { status: 413, payload: { message: "image too large: max 4MB" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.UPLOAD_REJECTED
  },
  {
    name: "6b 上传格式不支持（415）",
    error: new FakeApiError("unsupported media type", { status: 415, payload: { message: "unsupported media type: image/heic" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.UPLOAD_REJECTED
  },
  {
    name: "7 服务器返回错误（502）",
    error: new FakeApiError("Bad gateway", { status: 502, payload: { message: "upstream 502" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.SERVER_ERROR
  },
  {
    name: "8 响应缺少图片",
    error: new Error("接口返回成功，但没有解析到图片"),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.MISSING_IMAGE
  },
  {
    name: "9 图片 URL 无效/结果下载失败",
    error: new Error("结果图下载失败：404 Not Found"),
    context: { phase: "result" },
    expectKind: GENERATION_ERROR_KINDS.IMAGE_URL_INVALID
  },
  {
    name: "10 未知错误",
    error: new Error("something inexplicable happened"),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.UNKNOWN
  },
  {
    name: "附加：鉴权失败（401）",
    error: new FakeApiError("Invalid token", { status: 401, payload: { error: "invalid_api_key", message: "Invalid token" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.AUTH
  },
  {
    name: "附加：余额不足（402）",
    error: new FakeApiError("quota not enough", { status: 402, payload: { message: "token quota is not enough, need quota: $0.12" } }),
    context: {},
    expectKind: GENERATION_ERROR_KINDS.QUOTA
  }
];

for (const item of CASES) {
  const info = classifyGenerationError(item.error, item.context);
  check(`${item.name} → ${item.expectKind}`, info.kind === item.expectKind, `got=${info.kind}`);
  check(`${item.name}：有可读种类文字 + 处理建议`, Boolean(info.label && info.advice), `${info.label} / ${info.advice}`);
  check(`${item.name}：settled=true（调用方可据此结束 loading）`, info.settled === true, `settled=${info.settled}`);
  const text = formatGenerationError(item.error, item.context);
  check(`${item.name}：最终文案不是笼统的「生成失败」`, !/^生成失败$/.test(text.trim()) && text.length > 4, text);
}

// requestId 透出
{
  const info = classifyGenerationError(new FakeApiError("boom", { status: 500, payload: { message: "boom", requestId: "req-abc-123" } }));
  check("requestId：从 payload 中取出并展示", info.requestId === "req-abc-123" && formatGenerationError(new FakeApiError("boom", { status: 500, payload: { message: "boom", requestId: "req-abc-123" } })).includes("req-abc-123"), `requestId=${info.requestId}`);
  const taskInfo = classifyGenerationError(new FakeApiError("boom", { status: 500, payload: { message: "boom", taskId: "task-xyz" } }));
  check("taskId：payload 只有 taskId 时也能带出", taskInfo.requestId === "task-xyz", `requestId=${taskInfo.requestId}`);
  const ctxInfo = classifyGenerationError(new Error("boom"), { requestId: "ctx-1" });
  check("requestId：context 传入也能带出", ctxInfo.requestId === "ctx-1", `requestId=${ctxInfo.requestId}`);
}

// 服务端真实原因优先保留
{
  const info = classifyGenerationError(new FakeApiError("上游明确说：参考图第2张识别失败", { status: 400, payload: { message: "上游明确说：参考图第2张识别失败" } }));
  check("真实原因优先：服务端文案进入最终结果", info.reason.includes("参考图第2张识别失败") && formatGenerationError(new FakeApiError("上游明确说：参考图第2张识别失败", { status: 400, payload: { message: "上游明确说：参考图第2张识别失败" } })).includes("参考图第2张识别失败"), info.reason);
}

// 空结果助手
{
  const empty = describeEmptyResult({ requestId: "req-empty", status: 200 });
  check("describeEmptyResult：归类为响应缺少图片", empty.kind === GENERATION_ERROR_KINDS.MISSING_IMAGE, empty.kind);
  check("describeEmptyResult：可读且带 requestId", /缺少图片/.test(formatGenerationError(empty)) && formatGenerationError(empty).includes("req-empty"), formatGenerationError(empty));
}

// 脱敏
{
  const leaked = "Authorization: Bearer sk-live-abcdefghijklmnop failed at Object.handler (/app/server.js:12:3)";
  const safe = sanitizeErrorText(leaked);
  check("脱敏：完整 KEY 不再出现", !safe.includes("sk-live-abcdefghijklmnop"), safe);
  check("脱敏：至少有一处被打码（Bearer *** 或 sk-***）", /\*\*\*/.test(safe), safe);
  check("脱敏：堆栈行被去掉", !/at Object\.handler/.test(safe), safe);

  const keyInMessage = "request failed with apiKey=sk-live-1234567890abcdef";
  const info = classifyGenerationError(new Error(keyInMessage), {});
  const text = formatGenerationError(new Error(keyInMessage), {});
  check("脱敏：错误文案里不出现完整 KEY", !text.includes("sk-live-1234567890abcdef") && !info.reason.includes("sk-live-1234567890abcdef"), text);

  const longText = "x".repeat(1000);
  check("脱敏：超长文本被截断", sanitizeErrorText(longText, 300).length <= 301, `len=${sanitizeErrorText(longText, 300).length}`);
}

// 无自动重试：分类器是纯函数，调用多次结果一致且不触发任何 IO
{
  const error = new TypeError("fetch failed");
  const first = JSON.stringify(classifyGenerationError(error, { requestId: "r1" }));
  const second = JSON.stringify(classifyGenerationError(error, { requestId: "r1" }));
  check("无副作用/无重试：多次分类结果一致", first === second, "两次数值相同");
  check("无自动重试：模块不导出任何重试/请求函数",
    typeof globalThis.fetch === "function" && !/retry/i.test(Object.keys(await import("../../src/shared/generation-errors.js")).join(",")),
    Object.keys(await import("../../src/shared/generation-errors.js")).join(","));
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  sampleTexts: CASES.map((item) => `${item.name} => ${formatGenerationError(item.error, item.context)}`),
  failures: failed
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
