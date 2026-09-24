// 快捷生成 / 批量生成共用的模型、线路和能力来源。
//
// 唯一来源约定：
//   1. 模型 ID 一律使用 3.0 routing catalog 的 canonical ID（banana-2 / nano-banana-pro /
//      tt-image-2 / tt-image-2.5）。旧存档里的 nano-banana2 等旧 ID 只在读取时映射一次。
//   2. 线路白名单和「已下线线路」名单与服务端 server/channel-config.js 保持一致。
//   3. 能力限制（可传图片数量、单张大小、提示词长度、比例、尺寸、质量、背景）
//      一律从 `/api/config` 的 routing catalog capabilities 读取；目录未加载完成前
//      不许用默认值覆盖用户存档。

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

// 已下线旧线路：前端目录、服务端目录、服务端校验三处都必须拒绝。
export const FORBIDDEN_CHANNEL_IDS = Object.freeze([
  "WD-banana pro-特价",
  "MC-限时特惠",
  "XBS-default",
  "silent-pro-line-03",
  "silent-banana-line-01",
  "silent-tt2-line-08"
]);

const FORBIDDEN_CHANNEL_ID_SET = new Set(
  FORBIDDEN_CHANNEL_IDS.map((value) => String(value).trim().toLowerCase())
);

export function isForbiddenChannelId(value) {
  return FORBIDDEN_CHANNEL_ID_SET.has(String(value || "").trim().toLowerCase());
}

// 香蕉 2 只允许这两条线路（Subdirect / 云枢）。
// 香蕉 Pro 只允许这两条线路（Subdirect / Origin）。
export const MODEL_CHANNEL_ALLOWLIST = Object.freeze({
  "banana-2": Object.freeze([
    { id: "silent-banana-line-08", label: "Subdirect", price: 0.12 },
    { id: "silent-banana-line-07", label: "云枢", price: 0.12 }
  ]),
  "nano-banana-pro": Object.freeze([
    { id: "silent-pro-line-10", label: "Subdirect", price: 0.14 },
    { id: "silent-pro-line-09", label: "Origin", price: 0.16 }
  ])
});

// 目录未加载完成时的本地兜底能力表（与 server/channel-config.js 的 ROUTING_MODELS 对齐）。
// 只用于「目录还没回来」这一种情况；目录一旦加载完成，一律以目录为准。
export const FALLBACK_MODEL_CAPABILITIES = Object.freeze({
  "tt-image-2": Object.freeze({
    maxInputImages: 14,
    maxImageBytes: 16 * 1024 * 1024,
    maxPromptLength: 20000,
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    quality: ["auto", "low", "medium", "high"],
    backgrounds: [],
    versions: [],
    customSize: false
  }),
  "banana-2": Object.freeze({
    maxInputImages: 14,
    maxImageBytes: 16 * 1024 * 1024,
    maxPromptLength: 20000,
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    quality: ["auto", "low", "medium", "high"],
    backgrounds: [],
    versions: [],
    customSize: false
  }),
  "tt-image-2.5": Object.freeze({
    maxInputImages: 8,
    maxImageBytes: 16 * 1024 * 1024,
    maxPromptLength: 20000,
    ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"],
    sizes: ["auto", "1K", "2K", "4K"],
    quality: ["auto", "low", "medium", "high", "xhigh", "max"],
    backgrounds: ["opaque", "transparent", "auto"],
    versions: ["flare", "sunburst"],
    customSize: true
  }),
  "nano-banana-pro": Object.freeze({
    maxInputImages: 14,
    maxImageBytes: 16 * 1024 * 1024,
    maxPromptLength: 20000,
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    sizes: ["1K", "2K", "4K"],
    quality: ["auto", "low", "medium", "high"],
    backgrounds: [],
    versions: [],
    customSize: false
  })
});

export const FALLBACK_DEFAULT_CAPABILITY = FALLBACK_MODEL_CAPABILITIES["tt-image-2"];

export function canonicalModel(value, fallback = "tt-image-2") {
  const key = String(value || "").trim().toLowerCase();
  return LEGACY_MODEL_ALIASES[key] || fallback;
}

export function isBananaFamilyModel(value) {
  return /^(banana|nano-banana)/i.test(String(value || "").trim());
}

export function isBanana2Model(value) {
  return canonicalModel(value, "") === "banana-2";
}

export function isTtImageFamilyModel(value) {
  return /^tt-image/i.test(String(value || "").trim());
}

// 精确到 canonical 的 tt-image-2（旧 ID gpt-image / gpt-image-2 映射到它）。
// 局部回贴的 GPT 专用合成参数只给这一支，不要扩散到 tt-image-2.5。
export function isTtImage2Model(value) {
  return canonicalModel(value, "") === "tt-image-2";
}

function catalogModelEntry(model, catalog = null) {
  const canonical = canonicalModel(model);
  const list = Array.isArray(catalog?.models) ? catalog.models : null;
  if (!list) return null;
  return list.find((entry) => (
    entry
    && (
      entry.value === canonical
      || entry.id === canonical
      || canonicalModel(entry.value, "") === canonical
      || canonicalModel(entry.id, "") === canonical
    )
  )) || null;
}

// catalog 是否已经加载完成（有 models 数组且非空）。
export function isRoutingCatalogReady(catalog = null) {
  return Boolean(catalog && Array.isArray(catalog.models) && catalog.models.length > 0);
}

/**
 * 能力限制统一出口。
 * catalog 优先（capabilities 字段），目录没加载完成时才回退到本地能力表。
 */
export function modelCapabilities(model, catalog = null) {
  const canonical = canonicalModel(model);
  const fallback = FALLBACK_MODEL_CAPABILITIES[canonical] || FALLBACK_DEFAULT_CAPABILITY;
  const entry = catalogModelEntry(canonical, catalog);
  const caps = entry?.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : (entry || {});
  const pickList = (...values) => {
    for (const value of values) {
      if (Array.isArray(value) && value.length) return [...value];
    }
    return null;
  };
  const ratios = pickList(caps.supportedAspectRatios, caps.ratios, entry?.ratios) || fallback.ratios;
  const sizes = pickList(caps.supportedSizes, caps.supportedResolutions, caps.sizes, entry?.sizes) || fallback.sizes;
  return {
    modelId: canonical,
    label: caps.displayLabel || entry?.label || "",
    fromCatalog: Boolean(entry),
    maxInputImages: Math.max(1, Number(caps.maxInputImages || entry?.maxInputImages || fallback.maxInputImages)),
    maxImageBytes: Math.max(0, Number(caps.maxImageBytes || entry?.maxImageBytes || fallback.maxImageBytes)),
    maxPromptLength: Math.max(1, Number(caps.maxPromptLength || entry?.maxPromptLength || fallback.maxPromptLength)),
    ratios,
    sizes,
    quality: pickList(caps.supportedQuality, caps.supportedQualities, caps.quality, entry?.quality) || fallback.quality,
    backgrounds: pickList(caps.supportedBackgroundModes, caps.backgrounds, entry?.backgrounds) || fallback.backgrounds,
    versions: pickList(caps.supportedVersions, caps.versions, entry?.versions) || fallback.versions,
    customSize: Boolean(caps.supportsCustomSize ?? entry?.customSize ?? fallback.customSize)
  };
}

function normalizeChannelRow(channel, model, priceOverride) {
  if (!channel || !channel.id) return null;
  if (isForbiddenChannelId(channel.id)) return null;
  const price = Number(
    priceOverride
    ?? channel.pricing?.[model]?.price
    ?? channel.price
    ?? 0
  );
  return {
    id: channel.id,
    label: String(channel.label || channel.id),
    price: Number.isFinite(price) ? price : 0,
    currency: channel.pricing?.[model]?.currency || channel.currency || "CNY"
  };
}

// 目录接口不可用（离线 / /api/config 失败）时的线路兜底表，
// 与 server/channel-config.js 的 ROUTING_CHANNELS 保持一致，且不含任何已下线线路。
// 目录一旦加载完成，一律以目录为准。
export const FALLBACK_MODEL_CHANNELS = Object.freeze({
  "tt-image-2": Object.freeze([
    { id: "silent-tt2-line-10", label: "云枢", price: 0.1 },
    { id: "silent-tt2-line-03", label: "XT-default", price: 0.1 },
    { id: "silent-tt2-line-04", label: "WD-image特价", price: 0.1 },
    { id: "silent-tt2-line-05", label: "ZYG-default", price: 0.1 },
    { id: "silent-tt2-line-06", label: "ZYG-svip", price: 0.1 },
    { id: "silent-tt2-line-07", label: "ZYG-vip", price: 0.1 },
    { id: "silent-tt2-line-11", label: "Origin", price: 0.1 },
    { id: "silent-tt2-line-12", label: "laoye", price: 0.1 },
    { id: "silent-tt2-line-01", label: "MC-TT-cf", price: 0.11 },
    { id: "silent-tt2-line-02", label: "XT2", price: 0.11 },
    { id: "silent-tt2-line-09", label: "速创", price: 0.11 }
  ]),
  "tt-image-2.5": Object.freeze([
    { id: "silent-tt25-line-01", label: "XT-image2-s", price: 0.1 },
    { id: "silent-tt25-line-02", label: "XT-特殊分组", price: 0.1 },
    { id: "silent-tt25-line-03", label: "XT-default", price: 0.1 },
    { id: "silent-tt25-line-05", label: "云枢", price: 0.1 },
    { id: "silent-tt25-line-06", label: "Origin", price: 0.1 },
    { id: "silent-tt25-line-04", label: "BR-default特价", price: 0.12 }
  ]),
  // 香蕉 2 / 香蕉 Pro 用白名单本身兜底，不在这里重复维护。
  "banana-2": MODEL_CHANNEL_ALLOWLIST["banana-2"],
  "nano-banana-pro": MODEL_CHANNEL_ALLOWLIST["nano-banana-pro"]
});

/**
 * 当前模型的可用线路（含价格）。
 * - 旧线路在任何分支都不会出现。
 * - 香蕉 2 / 香蕉 Pro 只允许白名单里的那两条线路。
 * - 目录不可用时回退到本地兜底表，保证请求始终能带上合法 channelId。
 */
export function channelsForModel(model, catalog = null) {
  const canonical = canonicalModel(model);
  const configured = Array.isArray(catalog?.channels)
    ? catalog.channels
      .filter((channel) => {
        if (!channel || channel.status === "DISABLED") return false;
        const supported = Array.isArray(channel.supportedModels) ? channel.supportedModels : null;
        if (supported && supported.length) {
          return supported.some((value) => canonicalModel(value, "") === canonical);
        }
        return canonicalModel(channel.model, "") === canonical;
      })
      .map((channel) => normalizeChannelRow(channel, canonical))
      .filter(Boolean)
    : [];
  const allowlist = MODEL_CHANNEL_ALLOWLIST[canonical];
  if (allowlist) {
    const allowed = new Map(allowlist.map((channel) => [channel.id, channel]));
    const source = configured.length ? configured : allowlist;
    return source
      .map((channel) => allowed.get(channel.id) || null)
      .filter(Boolean)
      .map((channel) => ({ ...channel, price: Number(channel.price || 0) }));
  }
  if (configured.length) return configured;
  return (FALLBACK_MODEL_CHANNELS[canonical] || [])
    .filter((channel) => !isForbiddenChannelId(channel.id))
    .map((channel) => ({ ...channel, currency: "CNY" }));
}

export function defaultChannelForModel(model, catalog = null) {
  return channelsForModel(model, catalog)[0]?.id || "";
}

export function channelForModel(model, channelId, catalog = null) {
  const channels = channelsForModel(model, catalog);
  const requested = String(channelId || "").trim();
  if (requested && !isForbiddenChannelId(requested)) {
    const matched = channels.find((channel) => channel.id === requested);
    if (matched) return matched;
  }
  return channels[0] || null;
}

/**
 * 请求路由字段：model / channelId / dispatchMode。
 * 任何情况下都返回 canonical model，且 channelId 一定落在当前模型的合法线路里。
 */
export function routingFields(model, channelId, catalog = null) {
  const canonical = canonicalModel(model);
  const channel = channelForModel(canonical, channelId, catalog);
  return { model: canonical, channelId: channel?.id || "", dispatchMode: "manual" };
}

export function channelPriceLabel(channel) {
  if (!channel) return "";
  const price = Number(channel.price || 0);
  return price > 0 ? `¥${price.toFixed(2)}/张` : "价格待定";
}

/**
 * 切换模型 / 目录加载完成后收敛设置。
 * 只收敛：图片数量、比例、尺寸、质量、背景、版本。
 * - 不改用户原始提示词（提示词长度只在提交前按 capabilities 截断，且超限会提示）
 * - 不改模型、渠道
 * - preserveChannel=false 时才允许把非法 channelId 收敛到当前模型的第一条合法线路
 */
export function convergeSettingsForModel(settings = {}, catalog = null, options = {}) {
  const next = { ...settings };
  const canonical = canonicalModel(next.model);
  next.model = canonical;
  next.dispatchMode = "manual";
  const caps = modelCapabilities(canonical, catalog);

  if (!caps.ratios.includes(next.aspectRatio)) next.aspectRatio = caps.ratios[0];
  if (!caps.sizes.includes(next.imageSize)) next.imageSize = caps.sizes.includes("2K") ? "2K" : caps.sizes[0];

  const requestedCount = Number.parseInt(next.n, 10) || 1;
  next.n = Math.max(1, Math.min(requestedCount, caps.maxInputImages));

  if (caps.quality.length) {
    const quality = String(next.quality || "").trim().toLowerCase();
    next.quality = caps.quality.includes(quality) ? quality : "";
  } else {
    next.quality = "";
  }
  if (caps.backgrounds.length) {
    const background = String(next.background || "").trim().toLowerCase();
    next.background = caps.backgrounds.includes(background) ? background : "";
  } else {
    next.background = "";
  }
  if (caps.versions.length) {
    const version = String(next.version || "").trim().toLowerCase();
    next.version = caps.versions.includes(version) ? version : "";
  } else {
    next.version = "";
  }

  if (options.preserveChannel !== true) {
    next.channelId = channelForModel(canonical, next.channelId, catalog)?.id || "";
  }
  return next;
}

/**
 * 提示词按当前模型 capabilities 截断。
 * 返回截断后的文本和一个截断标记，调用方据此提示用户。
 */
export function clampPromptForModel(prompt, model, catalog = null) {
  const text = String(prompt || "");
  const caps = modelCapabilities(model, catalog);
  if (text.length <= caps.maxPromptLength) return { prompt: text, truncated: false, maxPromptLength: caps.maxPromptLength };
  return { prompt: text.slice(0, caps.maxPromptLength), truncated: true, maxPromptLength: caps.maxPromptLength };
}
