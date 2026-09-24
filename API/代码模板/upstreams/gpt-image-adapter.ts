import type { JingyinRequest, UpstreamAdapter } from "../upstream-base";
import { classifyHttpStatus, normalizeErrorResponse } from "../error-normalizer";

const UPSTREAM_BASE_URL = process.env.GPT_IMAGE_BASE_URL ?? "";
const UPSTREAM_API_KEY = process.env.GPT_IMAGE_API_KEY ?? "";

export const gptImageAdapter: UpstreamAdapter = {
  id: "gpt-image",
  displayName: "GPT Image / 图片池渠道",
  priority: 20,
  weight: 80,
  supportedModels: ["gpt-image", "nano-banana-pro", "nano-banana", "nano-banana2"],
  health: {
    enabled: true,
    failCount: 0,
  },

  canHandle(request) {
    return request.kind === "image_generation" || request.kind === "image_edit";
  },

  async transformRequest(request) {
    if (request.kind === "image_edit") {
      return buildMultipartImageEditRequest(request);
    }

    return {
      url: `${UPSTREAM_BASE_URL}/v1/images/generations`,
      method: "POST",
      headers: {
        "authorization": `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        "x-jingyin-request-id": request.requestId,
      },
      body: JSON.stringify(mapImageBody(request.body)),
    };
  },

  async transformResponse(response, request) {
    const text = await response.text();
    const body = safeJson(text);

    if (!response.ok) {
      const classified = classifyHttpStatus(response.status);
      return normalizeErrorResponse({
        request,
        upstream: this.id,
        status: response.status,
        code: classified.code,
        retryable: classified.retryable,
        message: extractMessage(body) || "Image upstream failed",
      });
    }

    return {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "x-jingyin-upstream": this.id,
        "x-jingyin-request-id": request.requestId,
      },
      body,
      upstream: this.id,
      requestId: request.requestId,
    };
  },

  normalizeError(error, request) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return normalizeErrorResponse({
      request,
      upstream: this.id,
      status: isAbort ? 504 : 502,
      code: isAbort ? "upstream_timeout" : "upstream_unavailable",
      retryable: true,
      message: error instanceof Error ? error.message : String(error),
    });
  },
};

function mapImageBody(body: unknown): unknown {
  const input = body as Record<string, unknown>;
  return {
    ...input,
    image_size: input.image_size ?? "1K",
    aspect_ratio: input.aspect_ratio ?? "1:1",
  };
}

function buildMultipartImageEditRequest(request: JingyinRequest): RequestInit & { url: string } {
  const form = new FormData();
  const body = request.body as Record<string, string>;

  for (const [key, value] of Object.entries(body)) {
    form.append(key, value);
  }

  for (const file of request.files ?? []) {
    // 关键规则：字段名重复使用 image，不要写 image[]。
    form.append("image", new Blob([file.buffer], { type: file.mimeType }), file.filename);
  }

  return {
    url: `${UPSTREAM_BASE_URL}/v1/images/edits`,
    method: "POST",
    headers: {
      "authorization": `Bearer ${UPSTREAM_API_KEY}`,
      "x-jingyin-request-id": request.requestId,
    },
    body: form,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const error = (body as { error?: { message?: string } }).error;
  return error?.message ?? "";
}

