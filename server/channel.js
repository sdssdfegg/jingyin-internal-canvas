import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import {
  CHANNEL_IMAGE_SIZES,
  CHANNEL_MODELS,
  FORBIDDEN_CHANNEL_IDS,
  isForbiddenChannelId,
  routingChannelForModel,
  routingModelCapabilities,
  routingModelFor,
  validateModelCapabilities
} from "./channel-config.js";

export { CHANNEL_MODELS, normalizeBaseUrl } from "./channel-config.js";

const OPENAI_GPT_IMAGE_MODEL = "gpt-image-1";
const ENABLE_OPENAI_GPT_IMAGE_VARIANT = /^(1|true|on|yes)$/i.test(String(process.env.JINGYIN_ENABLE_OPENAI_IMAGE_VARIANT || ""));
const ENABLE_IMAGE_COMPAT_VARIANTS = /^(1|true|on|yes)$/i.test(String(process.env.JINGYIN_ENABLE_IMAGE_COMPAT_VARIANTS || ""));

// 旧存档模型 ID -> 3.0 routing catalog 的 canonical ID。
// 旧存档可以读，但新请求不允许继续把旧 ID 发出去。
export const LEGACY_MODEL_ALIASES = Object.freeze({
  "nano-banana2": "banana-2",
  "nano-banana-2": "banana-2",
  "nano-banana": "banana-2",
  "banana2": "banana-2",
  "banana-2": "banana-2",
  "nano-banana-pro": "nano-banana-pro",
  "banana-pro": "nano-banana-pro",
  "gpt-image": "tt-image-2",
  "gpt-image-2": "tt-image-2",
  "tt-image-2": "tt-image-2",
  "tt-image-2.5": "tt-image-2.5",
  "tt-image-2-5": "tt-image-2.5"
});

export function canonicalChannelModel(value) {
  const key = String(value || "").trim().toLowerCase();
  return LEGACY_MODEL_ALIASES[key] || "";
}

// 中文注释：提高 GPT 图片模型默认质量，优先缓解批量换装、快捷生成和批量姿态里人物头脸发糊。
const OPENAI_IMAGE_QUALITY_BY_SIZE = {
  "1K": "medium",
  "2K": "high",
  "4K": "high"
};
const LONG_EDGE_BY_IMAGE_SIZE = {
  "1K": 1024,
  "2K": 2304,
  "4K": 4096
};

export function channelImagePath(hasImages) {
  return hasImages ? "/images/edits" : "/images/generations";
}

function ratioParts(aspectRatio) {
  const [w, h] = String(aspectRatio || "")
    .split(":")
    .map((value) => Number.parseFloat(value));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { w: 1, h: 1 };
  }
  return { w, h };
}

function exactImageSize(aspectRatio, imageSize) {
  const edge = LONG_EDGE_BY_IMAGE_SIZE[imageSize] || LONG_EDGE_BY_IMAGE_SIZE["2K"];
  const { w, h } = ratioParts(aspectRatio);
  if (Math.abs(w - h) < 0.01) return { width: edge, height: edge };
  if (w > h) return { width: edge, height: Math.max(1, Math.round(edge * h / w)) };
  return { width: Math.max(1, Math.round(edge * w / h)), height: edge };
}

function exactImageSizeText(aspectRatio, imageSize) {
  const { width, height } = exactImageSize(aspectRatio, imageSize);
  return `${width}x${height}`;
}

function isBananaModel(model) {
  // canonical ID 是 banana-2 / nano-banana-pro；旧存档 nano-banana2 / nano-banana 也归到同一族。
  return /^(banana|nano-banana)/i.test(String(model || ""));
}

async function appendUploadFile(form, fieldName, file, fallbackName = "reference.png") {
  if (!file?.buffer && !file?.path) return;
  const type = file.mimetype || "application/octet-stream";
  const blob = file.path
    ? await openAsBlob(file.path, { type })
    : new Blob([file.buffer], { type });
  form.append(fieldName, blob, basename(file.originalname || fallbackName));
}

export function normalizeImageRequest(input) {
  const requestedModel = String(input.model || "").trim();
  // 旧存档（nano-banana2 / gpt-image …）只在这里做一次别名归一化，
  // 之后全链路只出现 3.0 routing catalog 的 canonical ID。
  const canonicalModel = canonicalChannelModel(requestedModel);
  const model = routingModelFor(canonicalModel)
    ? canonicalModel
    : (routingModelFor(requestedModel) ? requestedModel : "tt-image-2");
  const modelConfig = CHANNEL_MODELS.find((item) => item.value === model);
  const modelSizes = Array.isArray(modelConfig.sizes) && modelConfig.sizes.length ? modelConfig.sizes : CHANNEL_IMAGE_SIZES;
  const imageSize = modelSizes.includes(String(input.imageSize || "").toUpperCase()) ? String(input.imageSize).toUpperCase() : modelSizes[0];
  const aspectRatio = modelConfig.ratios.includes(input.aspectRatio) ? input.aspectRatio : modelConfig.ratios[0];
  const qualityList = Array.isArray(modelConfig.quality) ? modelConfig.quality : [];
  const requestedQuality = String(input.quality || "").trim().toLowerCase();
  const backgroundList = Array.isArray(modelConfig.backgrounds) ? modelConfig.backgrounds : [];
  const requestedBackground = String(input.background || input.backgroundMode || "").trim().toLowerCase();
  const versionList = Array.isArray(modelConfig.versions) ? modelConfig.versions : [];
  const requestedVersion = String(input.version || input.modelVersion || "").trim().toLowerCase();
  // 与 3.0 对齐：只有声明了扩展参数的模型（当前目录里是 tt-image-2.5）才会带上
  // version / quality / background 的默认值（flare / auto / opaque，
  // 见 3.0 static/ecommerce/channel-selector.js 的 TT25_DEFAULTS 与
  // main.py tt25_upstream_fields）。其它模型只在客户端显式传入且该模型允许时才带 quality。
  const extendedParamModel = backgroundList.length > 0 || versionList.length > 0;
  const quality = qualityList.includes(requestedQuality)
    ? requestedQuality
    : (extendedParamModel && qualityList.includes("auto") ? "auto" : "");
  const background = backgroundList.includes(requestedBackground)
    ? requestedBackground
    : (backgroundList.includes("opaque") ? "opaque" : "");
  const version = versionList.includes(requestedVersion)
    ? requestedVersion
    : (versionList.includes("flare") ? "flare" : "");
  const n = Math.max(1, Math.min(12, Number.parseInt(input.n, 10) || 1));
  const source = ["quickgen", "detail-main", "reference-remix", "infinite-canvas", "outfit"].includes(input.source)
    ? input.source
    : "";
  const workflowMode = String(input.workflowMode || "").trim();
  const maxPromptLength = Number(modelConfig.maxPromptLength || 20000);
  const rawPrompt = String(input.prompt || "").trim();
  // 提示词上限来自 routing catalog 的 capabilities；超限直接按目录上限截断，
  // 保证发给中转站的请求永远不超出当前模型能力。
  const prompt = rawPrompt.length > maxPromptLength ? rawPrompt.slice(0, maxPromptLength) : rawPrompt;
  // 2026-09-25：香蕉 Pro 的参考图改用 3.0 已验证的 JSON + image_urls 通道，
  // 客户端会把压缩到 1536 长边的 JPEG data URL 放进 referenceDataUrl 字段。
  const referenceDataUrls = (Array.isArray(input.referenceDataUrls)
    ? input.referenceDataUrls
    : Array.isArray(input.referenceDataUrl)
      ? input.referenceDataUrl
      : input.referenceDataUrl
        ? [input.referenceDataUrl]
        : [])
    .map((value) => String(value || "").trim())
    .filter((value) => /^data:image\//i.test(value))
    .slice(0, 12);

  return {
    model,
    prompt,
    promptTruncated: rawPrompt.length > maxPromptLength,
    imageSize,
    aspectRatio,
    quality,
    background,
    version,
    n,
    source,
    workflowMode,
    dispatchMode: "manual",
    manualModel: model,
    channelId: String(input.channelId || input.channel_id || "").trim(),
    referenceDataUrls,
    maxInputImages: Number(modelConfig.maxInputImages || 1),
    maxImageBytes: Number(modelConfig.maxImageBytes || 0),
    maxPromptLength
  };
}

// 服务端最终校验：模型 + 渠道 + 能力上限，任何一条不过都直接拒绝，不依赖前端。
export function validateImageRouting(params) {
  const requestedModel = String(params?.model || "").trim();
  const model = routingModelFor(requestedModel);
  if (!model) {
    return {
      ok: false,
      code: "unknown_model",
      message: `当前模型未接入 3.0 渠道目录：${requestedModel || "(空)"}`
    };
  }
  const channelId = String(params?.channelId || "").trim();
  // 旧线路：即使前端被绕过，服务端也直接拒绝。
  if (isForbiddenChannelId(channelId)) {
    return {
      ok: false,
      code: "forbidden_channel",
      message: `旧线路已下线，请重新选择当前模型的可用线路（${FORBIDDEN_CHANNEL_IDS.join(" / ")} 不再可用）`
    };
  }
  if (!channelId) {
    return { ok: false, code: "missing_channel", message: "请选择当前模型的可用渠道" };
  }
  const channel = routingChannelForModel(model.value, channelId);
  if (!channel) {
    return {
      ok: false,
      code: "channel_model_mismatch",
      message: "所选渠道不支持当前模型"
    };
  }
  if (String(params?.dispatchMode || "manual").trim().toLowerCase() !== "manual") {
    return { ok: false, code: "invalid_dispatch_mode", message: "只支持手动选择线路（dispatchMode=manual）" };
  }
  return { ok: true, channel };
}

export function validateImageCapabilities(params, files = []) {
  const capability = validateModelCapabilities(params?.model, {
    imageSize: params?.imageSize,
    aspectRatio: params?.aspectRatio,
    quality: params?.quality,
    background: params?.background,
    version: params?.version,
    prompt: params?.prompt,
    imageCount: Array.isArray(files) ? files.length : 0,
    files
  });
  return capability;
}

export function modelCapabilitySummary(model) {
  const capabilities = routingModelCapabilities(model);
  if (!capabilities) return null;
  return {
    modelId: capabilities.modelId,
    maxInputImages: capabilities.maxInputImages,
    maxPromptLength: capabilities.maxPromptLength,
    maxImageBytes: capabilities.maxImageBytes,
    supportedSizes: capabilities.supportedSizes,
    supportedAspectRatios: capabilities.supportedAspectRatios,
    supportedQuality: capabilities.supportedQuality,
    supportedBackgroundModes: capabilities.supportedBackgroundModes
  };
}

// 只有当前模型 capabilities 允许的 quality / background / version 才会写进上游请求体，
// 避免把上游不认识的参数发过去。
function appendCapabilityFields(target, params) {
  if (params.quality) target.quality = params.quality;
  if (params.background) target.background = params.background;
  if (params.version) target.version = params.version;
  return target;
}

/**
 * 把"静音中转站按线路路由"必须的字段写进上游请求体。
 *
 * 2026-09-25 修复（证据见 API 问题记录与本轮日志）：
 *   3.0 的 `main.py:13404-13423 add_lk888_route_fields()` 对**所有**模型都会附带
 *     `dispatchMode` / `channelId` / `manualModel`（TT 2.5 另走 tt25_upstream_fields），
 *     并且同时用于 JSON 体（`json=add_lk888_route_fields({...})` @13447）和
 *     multipart 表单（`data=add_lk888_route_fields({...})` @13483）。
 *     `main.py:2367` 的注释写明了原因：
 *       「中转站的按线路计费只能靠请求体里的 channelId 识别线路，所以线路必须显式发出去」。
 *
 *   V11 原来一个都没发。后果在 logs/generation.jsonl 里有实测：
 *     - banana-2 / tt-image-2（目录里 price_first + manual 双模式）→ 上游自己兜底，200；
 *     - nano-banana-pro（目录里 routes 只有 manual、defaultRoute=manual）→ 上游 400
 *       `manual_channel_required`，2.2~4.5 秒就失败（4 次点击全部如此）。
 *
 * 刻意**不发** `cropAspectRatio`：3.0 用它表示"局部裁剪框的比例"，而 V11 的局部选框
 * 本轮已改成自由矩形（见交付报告），把生成比例塞进 cropAspectRatio 会让上游按比例
 * 重新裁切我们刚裁好的局部图。`outputAspectRatio` / `outputSize` 只是把我们本来就在发的
 * `aspect_ratio` / `image_size` 再声明一次，不引入新的几何语义，所以照 3.0 一起发。
 */
function appendRoutingFields(target, params) {
  if (params.dispatchMode) target.dispatchMode = params.dispatchMode;
  if (params.channelId) target.channelId = params.channelId;
  if (params.manualModel) target.manualModel = params.manualModel;
  if (params.aspectRatio) target.outputAspectRatio = params.aspectRatio;
  if (params.imageSize) target.outputSize = params.imageSize;
  return target;
}

export function buildTextImageBody(params, format = "legacy") {
  const body = {
    model: params.model,
    prompt: params.prompt,
    n: params.n
  };
  appendRoutingFields(body, params);
  appendCapabilityFields(body, params);
  if (format === "size") {
    body.size = exactImageSizeText(params.aspectRatio, params.imageSize);
    return body;
  }
  if (format === "pixel-image-size") {
    body.image_size = exactImageSizeText(params.aspectRatio, params.imageSize);
    body.aspect_ratio = params.aspectRatio;
    return body;
  }
  body.image_size = params.imageSize;
  body.aspect_ratio = params.aspectRatio;
  return body;
}

export async function buildEditImageForm(params, files, format = "legacy") {
  const form = new FormData();
  form.set("model", params.model);
  form.set("prompt", params.prompt);
  form.set("n", String(params.n));
  if (format === "size") {
    form.set("size", exactImageSizeText(params.aspectRatio, params.imageSize));
  } else if (format === "pixel-image-size") {
    form.set("image_size", exactImageSizeText(params.aspectRatio, params.imageSize));
    form.set("aspect_ratio", params.aspectRatio);
  } else {
    form.set("image_size", params.imageSize);
    form.set("aspect_ratio", params.aspectRatio);
  }
  if (params.quality) form.set("quality", params.quality);
  if (params.background) form.set("background", params.background);
  if (params.version) form.set("version", params.version);
  // 线路路由字段：multipart 表单也要带，否则手动线路（香蕉 Pro）在上游认不出来。
  if (params.dispatchMode) form.set("dispatchMode", params.dispatchMode);
  if (params.channelId) form.set("channelId", params.channelId);
  if (params.manualModel) form.set("manualModel", params.manualModel);
  if (params.aspectRatio) form.set("outputAspectRatio", params.aspectRatio);
  if (params.imageSize) form.set("outputSize", params.imageSize);
  for (const file of files) {
    await appendUploadFile(form, "image", file, "reference.png");
  }
  await appendUploadFile(form, "mask", params.maskFile, "mask.png");

  return form;
}

function imageOrientation(aspectRatio) {
  const { w, h } = ratioParts(aspectRatio);
  if (Math.abs(w - h) < 0.01) return "square";
  return w > h ? "landscape" : "portrait";
}

function openAiImageSize(aspectRatio) {
  const orientation = imageOrientation(aspectRatio);
  if (orientation === "portrait") return "1024x1536";
  if (orientation === "landscape") return "1536x1024";
  return "1024x1024";
}

function buildOpenAiTextImageBody(params) {
  const body = {
    model: OPENAI_GPT_IMAGE_MODEL,
    prompt: params.prompt,
    size: openAiImageSize(params.aspectRatio),
    quality: OPENAI_IMAGE_QUALITY_BY_SIZE[params.imageSize] || "medium",
    n: params.n
  };
  return body;
}

async function buildOpenAiEditImageForm(params, files) {
  const form = new FormData();
  form.set("model", OPENAI_GPT_IMAGE_MODEL);
  form.set("prompt", params.prompt);
  form.set("size", openAiImageSize(params.aspectRatio));
  form.set("quality", OPENAI_IMAGE_QUALITY_BY_SIZE[params.imageSize] || "medium");
  form.set("n", String(params.n));
  for (const file of files) {
    await appendUploadFile(form, "image", file, "reference.png");
  }
  await appendUploadFile(form, "mask", params.maskFile, "mask.png");

  return form;
}

export function buildImageRequestVariants(params, files) {
  const hasImages = files.length > 0;
  const variants = [];

  // ---------------------------------------------------------------------
  // 2026-09-25 香蕉 Pro 参考图通道修复
  //
  // 现象（logs/generation.jsonl，用户真实请求）：
  //   选 silent-pro-line-10，2 张参考图（无蒙版）→ V11 走 multipart
  //   POST https://api.jingyin.online/v1/images/edits → 等 302 秒后
  //   连接被上游丢掉（upstreamError: "fetch failed"），渠道侧完全没有收到生图。
  //
  // 3.0 的做法（main.py:13428-13454）：**带参考图但无蒙版**的请求走
  //   `gen_url` = /v1/images/generations，并且用 JSON 体里的 `image_urls`
  //   （data URL）传参考图，而不是 multipart 文件。原文注释写明：
  //     「中转站的计费表达式只解析 JSON 请求体。multipart/form-data 里的
  //       channelId / version 一律读不到……已受控实测：同一条线路，JSON 提交
  //       扣 0.1200，multipart 提交扣 0.0978。故带参考图（无蒙版）的请求改走
  //       JSON + image_urls —— 实测参考图被正常使用且线路价生效。」
  //
  // 所以这里对 nano-banana-pro 采用同一条已验证通道；其它模型（banana-2 / tt-image-2
  // 等）在 multipart 下本来就能被上游兜底路由，保持原样不动。
  // 只发 1 个 variant，不产生隐藏重试。
  // ---------------------------------------------------------------------
  const referenceDataUrls = Array.isArray(params.referenceDataUrls) ? params.referenceDataUrls : [];
  if (params.model === "nano-banana-pro" && hasImages && !params.maskFile && referenceDataUrls.length > 0) {
    variants.push({
      id: "jingyin-json-image-urls",
      model: params.model,
      requestFormat: "jingyin-generations-json-image-urls",
      path: "/images/generations",
      protocol: "json",
      headers: { "Content-Type": "application/json" },
      createBody: () => JSON.stringify({
        ...buildTextImageBody(params, "legacy"),
        image_urls: referenceDataUrls
      })
    });
    return variants;
  }

  const addJingyinVariant = (variantParams, suffix, requestFormatSuffix, format) => {
    variants.push({
      id: `jingyin-channel${suffix}`,
      model: variantParams.model,
      requestFormat: `jingyin-image-size-aspect-ratio${requestFormatSuffix}`,
      path: channelImagePath(hasImages),
      protocol: hasImages ? "multipart" : "json",
      headers: hasImages ? {} : { "Content-Type": "application/json" },
      createBody: () => hasImages ? buildEditImageForm(variantParams, files, format) : JSON.stringify(buildTextImageBody(variantParams, format))
    });
  };
  const addOpenAiVariant = (variantParams, suffix = "", requestFormatSuffix = "") => {
    variants.push({
      id: `openai-gpt-image-1${suffix}`,
      model: OPENAI_GPT_IMAGE_MODEL,
      requestFormat: `openai-size-quality${requestFormatSuffix}`,
      path: channelImagePath(hasImages),
      protocol: hasImages ? "multipart" : "json",
      headers: hasImages ? {} : { "Content-Type": "application/json" },
      createBody: () => hasImages ? buildOpenAiEditImageForm(variantParams, files) : JSON.stringify(buildOpenAiTextImageBody(variantParams))
    });
  };

  const orderedFormats = isBananaModel(params.model)
    ? [
        { suffix: "", requestFormatSuffix: "", format: "legacy" },
        { suffix: "-pixel", requestFormatSuffix: "-pixel", format: "pixel-image-size" },
        { suffix: "-size", requestFormatSuffix: "-size", format: "size" }
      ]
    : [
        { suffix: "-size", requestFormatSuffix: "-size", format: "size" },
        { suffix: "-pixel", requestFormatSuffix: "-pixel", format: "pixel-image-size" },
        { suffix: "", requestFormatSuffix: "", format: "legacy" }
      ];

  const forceCompatFormats = isBananaModel(params.model) && params.workflowMode === "random-background";
  const activeFormats = ENABLE_IMAGE_COMPAT_VARIANTS || forceCompatFormats ? orderedFormats : orderedFormats.slice(0, 1);
  for (const item of activeFormats) {
    addJingyinVariant(params, item.suffix, item.requestFormatSuffix, item.format);
  }

  if (params.model === "tt-image-2" && ENABLE_OPENAI_GPT_IMAGE_VARIANT) {
    addOpenAiVariant(params);
  }

  return variants;
}

export function extractImagesFromResponse(payload) {
  const images = [];
  const pushImage = (item) => {
    if (!item || typeof item !== "object") return;
    if (typeof item.url === "string" && item.url.trim()) {
      images.push({ type: "url", value: item.url.trim() });
      return;
    }
    if (typeof item.b64_json === "string" && item.b64_json.trim()) {
      images.push({ type: "b64_json", value: item.b64_json.trim() });
      return;
    }
    if (typeof item.image_url === "string" && item.image_url.trim()) {
      images.push({ type: "url", value: item.image_url.trim() });
    }
  };

  if (Array.isArray(payload?.data)) {
    payload.data.forEach(pushImage);
  }
  if (Array.isArray(payload?.images)) {
    payload.images.forEach((value) => {
      if (typeof value === "string") images.push({ type: value.startsWith("http") ? "url" : "b64_json", value });
      else pushImage(value);
    });
  }
  pushImage(payload);

  return images;
}

export function summarizeResponse(payload) {
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  return {
    keys: Object.keys(payload).slice(0, 12),
    dataCount: Array.isArray(payload.data) ? payload.data.length : 0,
    imageCount: extractImagesFromResponse(payload).length
  };
}
