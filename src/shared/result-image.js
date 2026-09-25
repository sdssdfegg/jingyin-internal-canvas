// 结果图「失效/缺图」的统一处理（快捷生成与批量生成共用）。
//
// 背景（P1 缺图自愈）：
//   结果卡片原来对"图片加载失败"完全没有处理 —— 预载失败后照样把坏地址塞给 <img>，
//   于是每次打开页面都会重复请求已经不存在的文件（404），或者回退到早已退役的上游域名（502），
//   用户看到的就是一张没有解释的空白卡片，而且永远不会自愈。
//
// 这里提供两件事：
//   1. 判读服务端标记的"归档文件已丢失"（`image.missing`），命中时**根本不发请求**；
//   2. 把"加载失败"翻译成人能看懂的原因，让卡片显示原因而不是空白。
//
// 注意：本模块只做判读与文案，不发起任何网络请求，也不修改持久化数据。

import { IMAGE_SOURCE_REASONS, classifyImageSource } from "./image-hosts.js";

/** 缺图/失效的原因码 → 用户可读文案。 */
export const RESULT_IMAGE_MISSING_REASONS = Object.freeze({
  archive_missing: "本地归档文件已丢失：这条记录保存时原图没有落到本机（或归档文件被移动/清理过）。",
  remote_expired: "远程原图链接已失效：结果图只在渠道服务器上存过临时链接，链接过期后无法再取回。",
  load_failed: "图片加载失败：归档文件可能已被移动或删除，远程链接也可能已经过期。",
  reference_missing: "参考图缩略图已丢失：不影响已生成的结果图，只是看不到当时的参考图。",
  // 统一地址校验（允许本地 /api、data:/blob: 与**任意 https 公网图床**；
  // 只挡非 https 与本地/内网地址——渠道成图在各自 CDN 上，不能按域名拦）
  [IMAGE_SOURCE_REASONS.BLOCKED_HOST]: "原图地址指向本机或内网，出于安全已停止加载。",
  [IMAGE_SOURCE_REASONS.BLOCKED_SCHEME]: "原图地址的协议不被允许（只允许 https，或本地归档），已停止加载。",
  [IMAGE_SOURCE_REASONS.BLOCKED_PROXY_TARGET]: "原图代理地址里的目标地址不合法，已停止加载。",
  [IMAGE_SOURCE_REASONS.NO_SOURCE]: "这条记录没有可用的图片地址。"
});

/** 默认文案（没有具体原因码时）。 */
export const RESULT_IMAGE_MISSING_FALLBACK = "这张结果的原图已失效，无法显示。";

/** 取可读原因文案。 */
export function resultImageMissingText(image) {
  const reason = String(image?.missingReason || image?.missing_reason || "").trim();
  return RESULT_IMAGE_MISSING_REASONS[reason] || RESULT_IMAGE_MISSING_FALLBACK;
}

/** 服务端是否已经把这条记录标成"归档文件已丢失"。 */
export function isResultImageMarkedMissing(image) {
  return Boolean(image?.missing || image?.imageMissing);
}

/**
 * 结果卡片该显示什么。
 *
 * @param {object} image 记录里的 `image` 对象
 * @param {(image: object) => string} sourceFromImage 取出地址的函数（快捷生成/批量生成各有一套）
 * @returns {{src: string, missing: boolean, reason: string}}
 *          `missing === true` 时 `src` 一定是空串 → 调用方**不要**渲染 <img>，
 *          这样既不会 404/502，也不会出现"空白卡片无解释"。
 */
export function resultImageCardState(image, sourceFromImage) {
  // 服务端已标记的归档缺失最具体，优先用它
  if (isResultImageMarkedMissing(image)) {
    return { src: "", missing: true, reason: resultImageMissingText(image) };
  }
  const src = typeof sourceFromImage === "function" ? sourceFromImage(image) : "";
  if (!src) {
    return { src: "", missing: true, reason: RESULT_IMAGE_MISSING_REASONS.archive_missing };
  }
  // 统一地址校验：非白名单的绝对地址（旧中转站、预签名临时链接等）直接判失效、不发请求
  const verdict = classifyImageSource(src);
  if (!verdict.allowed) {
    return {
      src: "",
      missing: true,
      reason: RESULT_IMAGE_MISSING_REASONS[verdict.reason] || RESULT_IMAGE_MISSING_FALLBACK
    };
  }
  return { src, missing: false, reason: "" };
}

/** 参考图缩略图是否允许加载（同一套白名单校验）。 */
export function isAllowedReferenceImage(reference, sourceFromReference) {
  const src = typeof sourceFromReference === "function" ? sourceFromReference(reference) : "";
  if (!src) return false;
  return classifyImageSource(src).allowed;
}

/**
 * 图片真的加载失败之后调用：返回要展示的原因。
 * 只用于把"经验性失败"翻译成文案，不改动持久化数据。
 */
export function brokenImageReason() {
  return RESULT_IMAGE_MISSING_REASONS.load_failed;
}
