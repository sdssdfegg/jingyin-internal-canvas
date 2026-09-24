// 图片地址白名单校验（前端唯一出口）。
//
// 规则（按产品要求）：
//   允许：① 相对本地 API 地址（/api/...，含经 /api/image-proxy 包装且目标合规的）
//        ② data: / blob:
//        ③ https://api.jingyin.online 上的绝对地址
//   其它绝对地址（已退役的旧中转站、预签名 S3 临时链接等）一律判定为**失效**，
//   卡片只显示原因，**不发起任何请求**（既不会 404，也不会 502）。
//
// 为什么必须解开 /api/image-proxy：结果是远程图时，前端会把地址包装成
//   /api/image-proxy?url=<原地址>
// 如果只看"以 /api/ 开头就放行"，旧域名的请求就会从代理这里漏过去（P1 实测的 3 个 502 就是这条路径）。
//
// 本模块是纯函数、无副作用，服务端也用同一套判断（服务端从自己的渠道配置推导允许的主机）。

/** 允许的远程图片主机（小写）。只放行当前官方中转站。 */
export const ALLOWED_IMAGE_HOSTS = Object.freeze(["api.jingyin.online"]);

/** 判定结果的原因码（文案在 result-image.js 里映射）。 */
export const IMAGE_SOURCE_REASONS = Object.freeze({
  NO_SOURCE: "no_source",
  BLOCKED_HOST: "blocked_host",
  BLOCKED_SCHEME: "blocked_scheme",
  BLOCKED_PROXY_TARGET: "blocked_proxy_target"
});

/** 主机是否在白名单内（大小写不敏感，忽略端口）。 */
export function isAllowedImageHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return ALLOWED_IMAGE_HOSTS.includes(normalized);
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
 * 统一的图片地址判定。
 *
 * @param {string} value 待判定的地址（可能是远程地址、/api/... 或 data:/blob:）
 * @returns {{allowed: boolean, kind: string, reason: string, target: string}}
 *   kind: local | data | allowed-remote | proxy-local | proxy-remote | blocked
 */
export function classifyImageSource(value) {
  const text = String(value || "").trim();
  if (!text) return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.NO_SOURCE, target: "" };

  // ② 内联数据，无需请求
  if (/^data:/i.test(text) || /^blob:/i.test(text)) {
    return { allowed: true, kind: "data", reason: "", target: "" };
  }

  // 协议相对地址（//host/path）不是本地路径：浏览器会按 https 解析并请求外部主机。
  // 必须先拦掉，否则会绕过白名单（这个漏洞是被 image-host-allowlist-check 抓出来的）。
  if (text.startsWith("//")) {
    return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_SCHEME, target: text };
  }

  // ① 相对本地 API 地址
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

  // ③ 绝对地址：只允许白名单主机，且必须是 https
  if (/^https?:\/\//i.test(text)) {
    if (!/^https:\/\//i.test(text)) {
      return { allowed: false, kind: "blocked", reason: IMAGE_SOURCE_REASONS.BLOCKED_SCHEME, target: text };
    }
    return isAllowedImageHost(hostOf(text))
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
