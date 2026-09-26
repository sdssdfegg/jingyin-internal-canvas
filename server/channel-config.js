import {
  API_GATEWAY_MODULES,
  gatewayEnvBaseUrl,
  gatewayPriority
} from "./features/api-gateway/gateway-registry.js";

export const CHANNEL_POLICY = Object.freeze({
  defaultChannel: "jingyin-gateway",
  priceSource: "jingyin-gateway",
  customerKeyMode: "per-user-gateway-key",
  exposeUpstreamChannels: false,
  exposeUpstreamPrices: false,
  clientDirectFallbackEnabled: false
});

export const CHANNEL_IMAGE_SIZES = Object.freeze(["1K", "2K", "4K"]);

// 已下线的旧线路：必须从前端目录、服务端目录和服务端校验里同时移除/拒绝。
// 只隐藏下拉框不够——用户手动构造旧 channelId 时服务端也必须拒绝。
// 前三个是 3.0 目录里的**展示名**，后三个是同一批线路在 3.0 目录里的真实 publicId。
export const FORBIDDEN_CHANNEL_IDS = Object.freeze([
  "WD-banana pro-特价",
  "MC-限时特惠",
  "XBS-default",
  "silent-pro-line-03",
  "silent-banana-line-01",
  "silent-tt2-line-08",
  // 2026-09-25：TT Image 2（2.0）的「WD-image特价」下线。
  // 按上面的规则：目录里删掉，同时把它 3.0 展示名与 publicId 都记进拒绝名单。
  "WD-image特价",
  "silent-tt2-line-04"
]);

const FORBIDDEN_CHANNEL_ID_SET = new Set(
  FORBIDDEN_CHANNEL_IDS.map((value) => String(value).trim().toLowerCase())
);

export function isForbiddenChannelId(value) {
  return FORBIDDEN_CHANNEL_ID_SET.has(String(value || "").trim().toLowerCase());
}

// 能力字段说明（唯一来源 = 本目录，前端与服务端都读这里）：
//   supportedSizes / supportedResolutions / supportedAspectRatios / supportedQuality /
//   supportedVersions / supportedBackgroundModes / supportsCustomSize / maxInputImages
//     —— 与 3.0 main.py `TEST2_MODEL_CAPABILITIES` 逐字对齐。
//   maxPromptLength / maxImageBytes
//     —— 3.0 routing catalog **没有**这两个字段（已核对 main.py 2394-2490），
//        V11 在 catalog 里补齐为能力字段，前后端统一按它执行。
//        maxPromptLength 取 3.0 `ONLINE_IMAGE_PROMPT_MAX_LENGTH` 默认值 20000；
//        maxImageBytes 取 16MB（V11 本地上传/本地裁剪回贴链路的实际上限，
//        上游更严格的 10MB 由中转适配器在转发前压缩，见
//        API/问题记录/2026-08-26-LK888参考图超过10MB被上游拒绝.md）。
export const DEFAULT_MAX_PROMPT_LENGTH = 20000;
export const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// 与 3.0 `/api/ecommerce/routing` 对齐的客户可见模型目录。
// 线路 ID 是静音中转适配器的 publicId，不能替换成本地自造 ID。
const ROUTING_CHANNELS = Object.freeze([
  // 2026-09-26：TT Image 2（2.0）与 TT Image 2.5（2.5）都把 Origin 排到第一位。
  // 数组顺序 = 前端菜单顺序；第一条同时也是"用户没选过线路时"的默认线路
  // （channelForModel / convergeSettingsForModel 都取 channels[0]）。
  // 2.0 的 Origin 与其它 2.0 线路同价（0.10），所以改默认线路不影响价格口径。
  { id: "silent-tt2-line-11", label: "Origin", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-10", label: "云枢", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-03", label: "XT-default", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-05", label: "ZYG-default", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-06", label: "ZYG-svip", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-07", label: "ZYG-vip", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-12", label: "laoye", price: 0.10, model: "tt-image-2" },
  { id: "silent-tt2-line-01", label: "MC-TT-cf", price: 0.11, model: "tt-image-2" },
  { id: "silent-tt2-line-02", label: "XT2", price: 0.11, model: "tt-image-2" },
  { id: "silent-tt2-line-09", label: "速创", price: 0.11, model: "tt-image-2" },
  { id: "silent-tt25-line-06", label: "Origin", price: 0.10, model: "tt-image-2.5" },
  { id: "silent-tt25-line-01", label: "XT-image2-s", price: 0.10, model: "tt-image-2.5" },
  { id: "silent-tt25-line-02", label: "XT-特殊分组", price: 0.10, model: "tt-image-2.5" },
  { id: "silent-tt25-line-03", label: "XT-default", price: 0.10, model: "tt-image-2.5" },
  { id: "silent-tt25-line-05", label: "云枢", price: 0.10, model: "tt-image-2.5" },
  { id: "silent-tt25-line-04", label: "BR-default特价", price: 0.12, model: "tt-image-2.5" },
  // 香蕉 2：仅展示用户指定的三条线路，顺序固定 Subdirect → 云枢 → Origin，三条统一 ¥0.12/张。
  // 数组顺序就是前端菜单顺序（channelsForModel 按白名单顺序输出），不要重排。
  // `silent-banana-line-09` 是 Origin 香蕉 2 的客户端 channelId：它必须由静音中转站
  // 适配器侧先登记成一条 Origin 线路（上游 model=nano-banana-2）才会真正生效；
  // 本地源码只负责把这条线路发出去，不把任何上游 KEY 放进客户端。
  { id: "silent-banana-line-08", label: "Subdirect", price: 0.12, model: "banana-2" },
  { id: "silent-banana-line-07", label: "云枢", price: 0.12, model: "banana-2" },
  { id: "silent-banana-line-09", label: "Origin", price: 0.12, model: "banana-2" },
  // 香蕉 Pro：仅展示用户指定的两条线路。
  { id: "silent-pro-line-10", label: "Subdirect", price: 0.14, model: "nano-banana-pro" },
  { id: "silent-pro-line-09", label: "Origin", price: 0.16, model: "nano-banana-pro" }
]);

export const ROUTING_MODELS = Object.freeze([
  {
    value: "tt-image-2",
    label: "TT Image 2",
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    maxInputImages: 14,
    quality: ["auto", "low", "medium", "high"],
    maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES
  },
  {
    value: "tt-image-2.5",
    label: "TT Image 2.5",
    ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"],
    sizes: ["auto", "1K", "2K", "4K"],
    maxInputImages: 8,
    quality: ["auto", "low", "medium", "high", "xhigh", "max"],
    versions: ["flare", "sunburst"],
    backgrounds: ["opaque", "transparent", "auto"],
    customSize: true,
    maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES
  },
  {
    value: "banana-2",
    label: "纳米香蕉 2",
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    maxInputImages: 14,
    quality: ["auto", "low", "medium", "high"],
    maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES
  },
  {
    value: "nano-banana-pro",
    label: "纳米香蕉 Pro",
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    sizes: ["1K", "2K", "4K"],
    maxInputImages: 14,
    quality: ["auto", "low", "medium", "high"],
    maxPromptLength: DEFAULT_MAX_PROMPT_LENGTH,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES
  }
]);

export function routingModelFor(value) {
  return ROUTING_MODELS.find((model) => model.value === String(value || "").trim()) || null;
}

export function routingChannelsForModel(model) {
  return ROUTING_CHANNELS.filter((channel) => channel.model === String(model || "").trim());
}

export function routingChannelForModel(model, channelId) {
  const requested = String(channelId || "").trim();
  // 旧线路一律拒绝，即使它曾经属于当前模型。
  if (isForbiddenChannelId(requested)) return null;
  return routingChannelsForModel(model).find((channel) => channel.id === requested) || null;
}

// 前端目录：旧线路不进入任何一条输出，dropdown / DOM 里旧渠道名数量必须是 0。
export function publicRoutingChannels() {
  return ROUTING_CHANNELS.filter((channel) => !isForbiddenChannelId(channel.id));
}

export function routingModelCapabilities(model) {
  const item = routingModelFor(model);
  if (!item) return null;
  return {
    modelId: item.value,
    displayLabel: item.label,
    supportedSizes: item.sizes,
    supportedResolutions: item.sizes,
    supportedAspectRatios: item.ratios,
    supportedQuality: item.quality,
    supportedQualities: item.quality,
    supportedVersions: item.versions,
    supportedBackgroundModes: item.backgrounds,
    supportsCustomSize: Boolean(item.customSize),
    maxInputImages: item.maxInputImages,
    maxPromptLength: item.maxPromptLength,
    maxImageBytes: item.maxImageBytes,
    routes: { manual: "ACTIVE" },
    defaultRoute: "manual",
    verified: true
  };
}

// 服务端最终校验：任何字段都必须落在当前模型的 capabilities 内。
export function validateModelCapabilities(model, input = {}) {
  const item = routingModelFor(model);
  if (!item) return { ok: false, code: "unknown_model", message: "当前模型未接入 3.0 渠道目录" };

  const imageSize = String(input.imageSize ?? "").trim().toUpperCase();
  if (imageSize && !item.sizes.map((value) => value.toUpperCase()).includes(imageSize)) {
    return { ok: false, code: "unsupported_image_size", message: `${item.label} 不支持 ${imageSize} 尺寸` };
  }
  const aspectRatio = String(input.aspectRatio ?? "").trim();
  if (aspectRatio && !item.ratios.includes(aspectRatio)) {
    return { ok: false, code: "unsupported_aspect_ratio", message: `${item.label} 不支持 ${aspectRatio} 比例` };
  }
  const quality = String(input.quality ?? "").trim().toLowerCase();
  if (quality && item.quality && !item.quality.includes(quality)) {
    return { ok: false, code: "unsupported_quality", message: `${item.label} 不支持 ${quality} 画质` };
  }
  const background = String(input.background ?? "").trim().toLowerCase();
  if (background && (!item.backgrounds || !item.backgrounds.includes(background))) {
    return { ok: false, code: "unsupported_background", message: `${item.label} 不支持 ${background} 背景` };
  }
  const version = String(input.version ?? "").trim().toLowerCase();
  if (version && (!item.versions || !item.versions.includes(version))) {
    return { ok: false, code: "unsupported_version", message: `${item.label} 不支持 ${version} 版本` };
  }
  const promptLength = String(input.prompt ?? "").length;
  if (promptLength > item.maxPromptLength) {
    return {
      ok: false,
      code: "prompt_too_long",
      message: `${item.label} 提示词最多 ${item.maxPromptLength} 字，当前 ${promptLength} 字`
    };
  }
  const imageCount = Number(input.imageCount || 0);
  if (imageCount > item.maxInputImages) {
    return {
      ok: false,
      code: "too_many_images",
      message: `${item.label} 最多上传 ${item.maxInputImages} 张图片，当前 ${imageCount} 张`
    };
  }
  const oversized = (Array.isArray(input.files) ? input.files : [])
    .find((file) => Number(file?.size || 0) > item.maxImageBytes);
  if (oversized) {
    const limitMb = Math.round(item.maxImageBytes / 1024 / 1024);
    return {
      ok: false,
      code: "image_too_large",
      message: `${item.label} 单张图片不能超过 ${limitMb}MB：${oversized.originalname || "未命名图片"}`
    };
  }
  return { ok: true, model: item };
}


export function publicRoutingCatalog() {
  const channels = publicRoutingChannels();
  return {
    dispatchModes: [{ id: "manual", label: "手动选择渠道", status: "ACTIVE", manual: true }],
    models: ROUTING_MODELS.map((model) => ({
      id: model.value,
      label: model.label,
      status: "ACTIVE",
      capabilities: routingModelCapabilities(model.value)
    })),
    channels: channels.map((channel) => ({
      id: channel.id,
      label: channel.label,
      status: "ACTIVE",
      manual: true,
      public: true,
      supportedModels: [channel.model],
      pricing: { [channel.model]: { price: channel.price, currency: "CNY", unit: "image" } }
    })),
    pricing: {
      currency: "CNY",
      unit: "image",
      models: Object.fromEntries(ROUTING_MODELS.map((model) => {
        const line = channels.find((channel) => channel.model === model.value);
        return [model.value, { price: line?.price || 0, currency: "CNY", unit: "image" }];
      }))
    },
    priceVersion: "v11-3.0-routing-2026-09-24"
  };
}

export const CHANNEL_MODELS = Object.freeze(ROUTING_MODELS.map((model) => ({
  value: model.value,
  label: model.label,
  ratios: model.ratios,
  sizes: model.sizes,
  maxInputImages: model.maxInputImages,
  maxPromptLength: model.maxPromptLength,
  maxImageBytes: model.maxImageBytes,
  quality: model.quality,
  versions: model.versions,
  backgrounds: model.backgrounds,
  customSize: model.customSize,
  defaultChannel: CHANNEL_POLICY.defaultChannel,
  priceSource: CHANNEL_POLICY.priceSource,
  visiblePrice: {},
  enabled: true,
  internalOnly: false
})));

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return raw.endsWith("/v1") ? raw : `${raw}/v1`;
}

const ACTIVE_GATEWAY_MODULES = API_GATEWAY_MODULES
  .filter((gateway) => gateway && gateway.enabled !== false)
  .map((gateway, index) => ({
    ...gateway,
    priority: gatewayPriority(gateway, index),
    baseUrl: normalizeBaseUrl(gatewayEnvBaseUrl(gateway))
  }))
  .filter((gateway) => gateway.baseUrl)
  .sort((left, right) => left.priority - right.priority);

const JINGYIN_GATEWAY_BASE_URL = ACTIVE_GATEWAY_MODULES[0]?.baseUrl
  || normalizeBaseUrl("https://api.jingyin.online/v1");

export const CHANNEL_ENDPOINTS = Object.freeze(
  (ACTIVE_GATEWAY_MODULES.length ? ACTIVE_GATEWAY_MODULES : [{
    id: "jingyin-gateway",
    label: "静音中转站",
    role: "primary",
    priority: 1,
    baseUrl: JINGYIN_GATEWAY_BASE_URL,
    public: false,
    billingMode: "gateway",
    billingChannelId: "jingyin-gateway",
    upstreamApiKey: "",
    modelAliases: {}
  }]).map((gateway) => ({
    id: gateway.id,
    label: gateway.label,
    role: gateway.role || "primary",
    priority: gateway.priority || 1,
    baseUrl: gateway.baseUrl,
    public: Boolean(gateway.public),
    billingMode: gateway.billingMode || "gateway",
    billingChannelId: gateway.billingChannelId || gateway.id,
    upstreamApiKey: "",
    imageModels: CHANNEL_MODELS.map((model) => model.value),
    modelAliases: gateway.modelAliases || {}
  }))
);

const ACTIVE_CHANNEL_ENDPOINTS = CHANNEL_ENDPOINTS;

export const PRIMARY_CHANNEL_API_BASE_URL = JINGYIN_GATEWAY_BASE_URL;
export const LOCKED_CHANNEL_API_BASE_URLS = ACTIVE_CHANNEL_ENDPOINTS.map((endpoint) => endpoint.baseUrl);

function primaryChannelId() {
  return ACTIVE_CHANNEL_ENDPOINTS[0]?.id || CHANNEL_POLICY.defaultChannel;
}

export function isLockedChannelBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return LOCKED_CHANNEL_API_BASE_URLS.includes(normalized);
}

export function buildChannelBaseCandidates(preferredBaseUrl = "") {
  const normalizedPreferred = normalizeBaseUrl(preferredBaseUrl);
  return [
    isLockedChannelBaseUrl(normalizedPreferred) ? normalizedPreferred : "",
    ...LOCKED_CHANNEL_API_BASE_URLS
  ].filter((value, index, all) => value && all.indexOf(value) === index);
}

export function buildImageChannelBaseCandidates(_model, preferredBaseUrl = "") {
  return buildChannelBaseCandidates(preferredBaseUrl || PRIMARY_CHANNEL_API_BASE_URL);
}

export function channelEndpointForBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return CHANNEL_ENDPOINTS.find((endpoint) => endpoint.baseUrl === normalized) || null;
}

export function upstreamModelForChannel(baseUrl, model) {
  const endpoint = channelEndpointForBaseUrl(baseUrl);
  return endpoint?.modelAliases?.[model] || model;
}

export function apiKeyForChannel(_baseUrl, fallbackApiKey = "") {
  return fallbackApiKey;
}

export function apiKeyHeadersForChannel(_baseUrl, apiKey = "") {
  const credential = String(apiKey || "").trim();
  if (!credential) return {};
  return {
    Authorization: /^Bearer\s+/i.test(credential) ? credential : `Bearer ${credential}`
  };
}

export function channelLogFields(baseUrl, baseIndex = 0, candidateCount = 0) {
  const endpoint = channelEndpointForBaseUrl(baseUrl);
  const attempt = Number.isFinite(baseIndex) ? baseIndex + 1 : 0;
  return {
    channelId: endpoint?.id || "jingyin-gateway",
    channelLabel: endpoint?.label || "静音中转站",
    channelRole: endpoint?.role || "primary",
    channelPublic: Boolean(endpoint?.public),
    channelPriority: endpoint?.priority || attempt,
    channelIsFallback: attempt > 1,
    channelBaseUrl: normalizeBaseUrl(baseUrl),
    channelAttempt: attempt,
    channelCandidateCount: Number.isFinite(candidateCount) ? candidateCount : 0
  };
}

export function publicChannelGateways() {
  return ACTIVE_CHANNEL_ENDPOINTS.map((endpoint, index) => ({
    id: endpoint.id,
    label: endpoint.label,
    role: endpoint.role,
    priority: endpoint.priority || index + 1,
    baseUrl: endpoint.baseUrl,
    billingMode: endpoint.billingMode,
    billingChannelId: endpoint.billingChannelId,
    imageModels: endpoint.imageModels,
    isPrimary: index === 0
  }));
}

export function publicChannelPolicyConfig() {
  return {
    defaultChannel: primaryChannelId(),
    priceSource: primaryChannelId(),
    customerKeyMode: CHANNEL_POLICY.customerKeyMode,
    exposeUpstreamChannels: CHANNEL_POLICY.exposeUpstreamChannels,
    exposeUpstreamPrices: CHANNEL_POLICY.exposeUpstreamPrices,
    clientDirectFallbackEnabled: CHANNEL_POLICY.clientDirectFallbackEnabled,
    activeEndpointCount: ACTIVE_CHANNEL_ENDPOINTS.length,
    gateways: publicChannelGateways(),
    primaryEndpoint: {
      id: ACTIVE_CHANNEL_ENDPOINTS[0]?.id || "jingyin-gateway",
      label: ACTIVE_CHANNEL_ENDPOINTS[0]?.label || "静音中转站",
      role: ACTIVE_CHANNEL_ENDPOINTS[0]?.role || "primary",
      baseUrl: PRIMARY_CHANNEL_API_BASE_URL
    }
  };
}

export function publicChannelModels() {
  return CHANNEL_MODELS.filter((model) => model.enabled).map((model) => ({
    value: model.value,
    label: model.label,
    ratios: model.ratios,
    sizes: model.sizes,
    maxInputImages: model.maxInputImages,
    maxPromptLength: model.maxPromptLength,
    maxImageBytes: model.maxImageBytes,
    quality: model.quality,
    versions: model.versions,
    backgrounds: model.backgrounds,
    customSize: Boolean(model.customSize),
    channels: routingChannelsForModel(model.value).filter((channel) => !isForbiddenChannelId(channel.id)),
    defaultChannel: primaryChannelId(),
    priceSource: primaryChannelId(),
    visiblePrice: model.visiblePrice,
    enabled: model.enabled,
    internalOnly: model.internalOnly
  }));
}

export { ROUTING_CHANNELS };

