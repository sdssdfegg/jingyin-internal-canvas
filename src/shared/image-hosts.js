// 图片地址校验（前端与服务端**共用同一份规则**，避免两处漂移）。
//
// 产品规则（2026-09-25 修订，按用户口径）：
//   生图 API：只允许官方中转 `https://api.jingyin.online`——防止别人拿本画板去用别人的 API。
//             这条由 server/channel-config.js 的 PRIMARY_CHANNEL_API_BASE_URL 管，**不在本模块**。
//   图片回传：**不限域名**。官方中转后面挂了 N 个渠道，每个渠道的成图在各自的 CDN 上，
//             实测出现过 leo.yunshuaiapi.com、tos.lingkeai.vip、api.luckfill.com 等。
//             所以这里只做两件事：
//               ① 必须是 https 绝对地址
//                  （挡已退役的 http 旧中转站、协议相对地址 //host/x、javascript:/file:/ftp: 等）
//               ② 主机不能是本地/内网地址（挡 SSRF：localhost、127.*、10.*、192.168.*、
//                  172.16-31.*、169.254.*、0.0.0.0、无点内网名、.local）
//
// 相对本地 API 地址（/api/...）与 data:/blob: 照旧放行。
// `/api/image-proxy?url=<原地址>` 必须**解开包装**再按上面两条判定——否则"以 /api/ 开头就放行"
// 会让不合规地址从代理漏过去（P1 实测的 3 个 502 就是这条路径）。
//
// 本模块是纯函数、无副作用；服务端 `server/index.js` 直接 import 它（发布时由 esbuild 内联进
// server bundle），所以前端与后端的判定永远一致。

/** 判定结果的原因码（文案在 result-image.js 里映射）。 */
export const IMAGE_SOURCE_REASONS = Object.freeze({
  NO_SOURCE: "no_source",
  BLOCKED_HOST: "blocked_host",
  BLOCKED_SCHEME: "blocked_scheme",
  BLOCKED_PROXY_TARGET: "blocked_proxy_target"
});

/**
 * 本地 / 内网 / 链路本地主机判定（前后端共用）。
 * 目的：SVG/图片地址可以被上游或历史数据带进来，挡住指向内网与云元数据的请求（SSRF）。
 */
export function isPrivateOrLocalHost(host) {
  const name = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!name) return true;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
  // 无点的名字基本是内网短名（public 域名至少有 一个点）
  if (!name.includes(".")) return true;
  if (name === "0.0.0.0") return true;
  if (/^127\./.test(name)) return true;
  if (/^10\./.test(name)) return true;
  if (/^192\.168\./.test(name)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true;
  if (/^169\.254\./.test(name)) return true;
  // IPv6：环回 / 链路本地 / 唯一本地地址
  if (name === "::1" || name === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(name)) return true;
  if (/^fe80:/.test(name)) return true;
  return false;
}

/**
 * 解开 `/api/image-proxy?url=<原始地址>`，取出被代理的真实地址。
 * 不是代理地址时返回空串。
 */
export function unwrapImageProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/api/image-proxy")) return "";
  const queryIndex = text.indexOf("?");
  if (queryIndex < 0) return "";
  for (const pair of text.slice(queryIndex + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== "url") continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1)).trim();
    } catch {
      return "";
    }
  }
  return "";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 远程图片地址是否可安全下载/展示（前端与服务端共用同一条判定）。
 * 规则：https 绝对地址 + 不带凭据 + 主机不是本地/内网。**不限域名**（见文件头说明）。
 */
export function isSafeRemoteImageUrl(value) {
  const text = String(value || "").trim();
  if (!/^https:\/\//i.test(text)) return false;
  // https://user:pass@host/x 这类带凭据的地址：代理会把凭据发给目标站，统一拒绝
  if (/^https:\/\/[^/@]*@/i.test(text)) return false;
  const host = hostOf(text);
  return Boolean(host) && !isPrivateOrLocalHost(host);
}

/**
 * 统一的图片地址判定。
 *
 * @param {string} value 待判定的地址（可能是远程地址、/api/... 或 data:/blob:）
 * @returns {{allowed: boolean, kind: string, reason: string, target: string}}
 *   kind: local | data | allowed-remote | proxy-remote | blocked
 */
export function classifyImageSource(value) {
  const text = String(value || "").trim();
  if (!text) return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.NO_SOURCE, target: "" };

  // 内联数据，无需请求
  if (/^data:/i.test(text) || /^blob:/i.test(text)) {
    return { allowed: true, kind: "data", reason: "", target: "" };
  }

  // 协议相对地址（//host/path）不是本地路径：浏览器会按 https 解析并请求外部主机。
  if (text.startsWith("//")) {
    return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_SCHEME, target: text };
  }

  // 相对本地 API 地址
  if (text.startsWith("/")) {
    const proxied = unwrapImageProxyUrl(text);
    if (proxied) {
      if (!/^https?:\/\//i.test(proxied)) {
        // 代理目标必须是绝对 http(s)；相对目标属于异常包装
        return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_PROXY_TARGET, target: proxied };
      }
      const inner = classifyImageSource(proxied);
      if (!inner.allowed) return { ...inner, kind: "blocked", target: proxied };
      return { allowed: true, kind: "proxy-remote", reason: "", target: proxied };
    }
    return { allowed: true, kind: "local", reason: "", target: "" };
  }

  // 绝对地址：必须是 https，且主机不能是本地/内网（域名不限——见文件头的原因）
  if (/^https?:\/\//i.test(text)) {
    if (!/^https:\/\//i.test(text)) {
      return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_SCHEME, target: text };
    }
    return isSafeRemoteImageUrl(text)
      ? { allowed: true, kind: "allowed-remote", reason: "", target: text }
      : { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_HOST, target: text };
  }

  // 其它协议（javascript:、file:、ftp: 等）一律拒绝
  return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_SCHEME, target: text };
}

/** 便捷判断。 */
export function isAllowedImageSource(value) {
  return classifyImageSource(value).allowed;
}
