import { PRIMARY_CHANNEL_API_BASE_URL, normalizeBaseUrl } from "./channel-config.js";

const JINGYIN_VIDEO_GATEWAY_BASE_URL = normalizeBaseUrl(process.env.JINGYIN_VIDEO_GATEWAY_BASE_URL || PRIMARY_CHANNEL_API_BASE_URL);
const ENABLE_GATEWAY_VIDEO = /^(1|true|on|yes)$/i.test(String(process.env.JINGYIN_ENABLE_GATEWAY_VIDEO || "0"));
export const JINGYIN_VIDEO_GATEWAY_CHANNEL_ID = "jingyin-gateway-video";
export const JINGYIN_VIDEO_GATEWAY_PROVIDER = "jingyin-gateway";

const VIDEO_DIMENSIONS = Object.freeze({
  "480p": {
    "16:9": { width: 864, height: 480 },
    "9:16": { width: 480, height: 864 },
    "1:1": { width: 480, height: 480 }
  },
  "720p": {
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "1:1": { width: 720, height: 720 }
  },
  "1080p": {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 }
  },
  "4k": {
    "16:9": { width: 3840, height: 2160 },
    "9:16": { width: 2160, height: 3840 },
    "1:1": { width: 2160, height: 2160 }
  }
});

export const VIDEO_MODELS = Object.freeze([
  {
    value: "seedance-2.0",
    label: "Seedance 2.0",
    provider: JINGYIN_VIDEO_GATEWAY_PROVIDER,
    endpointRole: "video-primary",
    billingUnit: "duration_tier",
    durations: [5, 10, 15],
    resolutions: ["480p", "720p", "1080p", "4k"],
    aspectRatios: ["9:16", "16:9", "1:1"],
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultAspectRatio: "9:16",
    promptPlaceholder: "高质量视频生成模型：支持图片、首尾帧、视频和音频参考，完整能力含 Standard、HD、Full HD、4K，可开关成品音频。",
    upstreamPricePerSecond: {},
    capabilities: {
      textToVideo: true,
      imageReference: "single-image-url-or-base64",
      outputAudioToggle: true
    }
  },
  {
    value: "seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    provider: JINGYIN_VIDEO_GATEWAY_PROVIDER,
    endpointRole: "video-primary",
    billingUnit: "duration_tier",
    durations: [5, 10, 15],
    resolutions: ["480p", "720p"],
    aspectRatios: ["9:16", "16:9", "1:1"],
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultAspectRatio: "9:16",
    promptPlaceholder: "快速视频生成模型：支持图片、首尾帧、视频和音频参考，提供 Standard、HD，可开关成品音频。",
    upstreamPricePerSecond: {},
    capabilities: {
      textToVideo: true,
      imageReference: "single-image-url-or-base64",
      outputAudioToggle: true
    }
  },
  {
    value: "seedance-2.5",
    label: "Seedance 2.5",
    provider: JINGYIN_VIDEO_GATEWAY_PROVIDER,
    endpointRole: "video-primary",
    billingUnit: "second",
    minDuration: 5,
    maxDuration: 30,
    resolutions: ["480p", "720p"],
    aspectRatios: ["9:16", "16:9", "1:1"],
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultAspectRatio: "9:16",
    promptPlaceholder: "长时有声视频生成：支持 5-30 秒、480P/720P，成品音频默认开启。网页端原生支持最多 30 张图片、10 个视频、10 段音频，总计最多 50 个参考。",
    upstreamPricePerSecond: {},
    capabilities: {
      textToVideo: true,
      imageReference: "multi-reference-later",
      outputAudioToggle: true
    }
  },
  {
    value: "seedance2-mini",
    label: "Seedance 2 Mini",
    provider: JINGYIN_VIDEO_GATEWAY_PROVIDER,
    endpointRole: "video-primary",
    billingUnit: "duration_tier",
    durations: [5, 10, 15],
    resolutions: ["480p", "720p"],
    aspectRatios: ["9:16", "16:9", "1:1"],
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultAspectRatio: "9:16",
    promptPlaceholder: "轻量视频生成模型：支持图片、首尾帧、视频和音频参考，提供 Standard、HD，可开关成品音频。",
    upstreamPricePerSecond: {},
    capabilities: {
      textToVideo: true,
      imageReference: "single-image-url-or-base64",
      outputAudioToggle: true
    }
  }
]);

function customerPricePerSecond(_model) {
  return {};
}

export function gatewayVideoBaseUrl() {
  return JINGYIN_VIDEO_GATEWAY_BASE_URL;
}

export function isGatewayVideoEnabled() {
  return ENABLE_GATEWAY_VIDEO;
}

export function videoModelForValue(value) {
  return VIDEO_MODELS.find((model) => model.value === value) || VIDEO_MODELS[0];
}

function normalizeResolution(value, model) {
  const raw = String(value || model.defaultResolution || "720p").trim().toLowerCase();
  return model.resolutions.includes(raw) ? raw : model.defaultResolution;
}

function normalizeAspectRatio(value, model) {
  const raw = String(value || model.defaultAspectRatio || "9:16").trim();
  return model.aspectRatios.includes(raw) ? raw : model.defaultAspectRatio;
}

function normalizeDuration(value, model) {
  const duration = Number.parseInt(String(value || model.defaultDuration || 5), 10);
  if (!Number.isFinite(duration) || duration <= 0) return model.defaultDuration;
  if (model.billingUnit === "duration_tier") {
    return model.durations.includes(duration) ? duration : model.defaultDuration;
  }
  return Math.max(model.minDuration, Math.min(model.maxDuration, duration));
}

export function estimateVideoCost(modelValue, resolutionValue, durationValue) {
  const model = videoModelForValue(modelValue);
  const resolution = normalizeResolution(resolutionValue, model);
  const duration = normalizeDuration(durationValue, model);
  const pricePerSecond = Number(model.upstreamPricePerSecond?.[resolution]) || 0;
  return {
    model: model.value,
    resolution,
    duration,
    upstreamCost: Number((pricePerSecond * duration).toFixed(6)),
    pricePerSecond
  };
}

export function normalizeVideoGenerationRequest(input = {}) {
  const model = videoModelForValue(input.model);
  const prompt = String(input.prompt || "").trim();
  const resolution = normalizeResolution(input.resolution || input.size || input.videoSize, model);
  const aspectRatio = normalizeAspectRatio(input.aspectRatio || input.ratio, model);
  const duration = normalizeDuration(input.duration || input.seconds, model);
  const dimensions = VIDEO_DIMENSIONS[resolution]?.[aspectRatio] || VIDEO_DIMENSIONS[model.defaultResolution]?.[model.defaultAspectRatio];
  const image = String(input.image || input.imageUrl || "").trim();
  const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {};
  if (Object.prototype.hasOwnProperty.call(input, "outputAudio")) metadata.output_audio = Boolean(input.outputAudio);

  return {
    model: model.value,
    prompt,
    duration,
    resolution,
    aspectRatio,
    width: dimensions.width,
    height: dimensions.height,
    image,
    metadata,
    costEstimate: estimateVideoCost(model.value, resolution, duration),
    validationError: !prompt
      ? "missing_prompt"
      : model.billingUnit === "duration_tier" && !model.durations.includes(duration)
        ? "invalid_duration"
        : ""
  };
}

export function createGatewayVideoBody(params) {
  const body = {
    model: params.model,
    prompt: params.prompt,
    duration: params.duration,
    width: params.width,
    height: params.height,
    n: 1
  };
  if (params.image) body.image = params.image;
  if (params.metadata && Object.keys(params.metadata).length) body.metadata = params.metadata;
  return body;
}

export function publicVideoModels() {
  return VIDEO_MODELS.map((model) => ({
    value: model.value,
    label: model.label,
    billingUnit: model.billingUnit,
    durations: model.durations || [],
    minDuration: model.minDuration || null,
    maxDuration: model.maxDuration || null,
    resolutions: model.resolutions,
    aspectRatios: model.aspectRatios,
    defaultDuration: model.defaultDuration,
    defaultResolution: model.defaultResolution,
    defaultAspectRatio: model.defaultAspectRatio,
    capabilities: model.capabilities,
    promptPlaceholder: model.promptPlaceholder || "",
    priceUnit: "compute_per_second",
    customerPricePerSecond: customerPricePerSecond(model),
    enabled: isGatewayVideoEnabled(),
    costHidden: true
  }));
}

export function publicVideoPolicyConfig() {
  return {
    defaultProvider: "jingyin-gateway",
    enabled: isGatewayVideoEnabled(),
    requiresPrivateApiKey: false,
    upstreamPriceHiddenFromClient: true,
    customerPriceSource: "api.jingyin.online"
  };
}
