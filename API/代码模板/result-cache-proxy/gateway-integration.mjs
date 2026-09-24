const IMAGE_URL_KEYS = new Set([
  "url",
  "image_url",
  "imageUrl",
  "output_url",
  "result_url",
  "origin_image_url"
]);

export async function rewriteImageUrls(payload, registerImageUrl) {
  const copy = structuredClone(payload);
  await walk(copy, async (parent, key, value) => {
    if (!looksLikeImageUrl(value)) return;
    if (!IMAGE_URL_KEYS.has(key) && !/image|url/i.test(key)) return;
    parent[key] = await registerImageUrl(value);
  });
  return copy;
}

async function walk(value, visitor) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") {
        await visitor(value, String(index), item);
      } else {
        await walk(item, visitor);
      }
    }
    return;
  }

  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      await visitor(value, key, item);
    } else {
      await walk(item, visitor);
    }
  }
}

function looksLikeImageUrl(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return /\.(png|jpg|jpeg|webp|gif|bmp|avif)(?:$|\?)/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

export async function registerWithCacheProxy(originUrl, options) {
  const response = await fetch(`${options.cacheProxyBaseUrl}/cache/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${options.internalToken}`
    },
    body: JSON.stringify({
      url: originUrl,
      task_id: options.taskId || "",
      file_id: options.fileId || "",
      wait_ms: options.waitMs || 0
    })
  });

  if (!response.ok) return originUrl;
  const result = await response.json();
  return result.image_url || originUrl;
}
