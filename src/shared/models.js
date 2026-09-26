// 目录未加载完成 / 接口不可用时的本地兜底模型表。
// 真实能力以 `/api/config` 的 routing catalog capabilities 为准
// （见 src/shared/routing.js 的 modelCapabilities）。
// 顺序与 server/channel-config.js 的 ROUTING_MODELS 一致：2.0 → 2.5 → 香蕉 2 → 香蕉 Pro。
// 注意：这里只用于"目录还没回来"和局部回贴弹窗的静态列表；正常运行时模型顺序以
// `/api/config` 返回的目录为准（那份顺序才是用户看到的顺序）。
export const DEFAULT_MODELS = [
  {
    value: "tt-image-2",
    label: "TT Image 2",
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    quality: ["auto", "low", "medium", "high"],
    maxInputImages: 14,
    maxPromptLength: 20000,
    maxImageBytes: 16 * 1024 * 1024
  },
  {
    value: "tt-image-2.5",
    label: "TT Image 2.5",
    ratios: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"],
    sizes: ["auto", "1K", "2K", "4K"],
    quality: ["auto", "low", "medium", "high", "xhigh", "max"],
    maxInputImages: 8,
    maxPromptLength: 20000,
    maxImageBytes: 16 * 1024 * 1024
  },
  {
    value: "banana-2",
    label: "纳米香蕉 2",
    ratios: ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"],
    sizes: ["1K", "2K"],
    quality: ["auto", "low", "medium", "high"],
    maxInputImages: 14,
    maxPromptLength: 20000,
    maxImageBytes: 16 * 1024 * 1024
  },
  {
    value: "nano-banana-pro",
    label: "纳米香蕉 Pro",
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    sizes: ["1K", "2K", "4K"],
    quality: ["auto", "low", "medium", "high"],
    maxInputImages: 14,
    maxPromptLength: 20000,
    maxImageBytes: 16 * 1024 * 1024
  }
];

// 仅保留给历史代码兼容；新代码请用 modelCapabilities(model).sizes。
export const IMAGE_SIZES = ["1K", "2K", "4K"];

export function imageSourceFromResult(image) {
  if (!image) return "";
  if (image.localUrl) return image.localUrl;
  if (image.type === "url") return image.value;
  if (image.type === "b64_json") {
    const value = String(image.value || "");
    if (value.startsWith("data:")) return value;
    return `data:${image.mimeType || image.archiveMime || "image/png"};base64,${value}`;
  }
  return "";
}
