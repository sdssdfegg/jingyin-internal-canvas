import type { JingyinRequest, UpstreamAdapter } from "../upstream-base";
import { classifyHttpStatus, normalizeErrorResponse } from "../error-normalizer";

const UPSTREAM_BASE_URL = process.env.VIDEO_BASE_URL ?? "";
const UPSTREAM_API_KEY = process.env.VIDEO_API_KEY ?? "";

export const videoAdapter: UpstreamAdapter = {
  id: "video-pool",
  displayName: "视频模型池",
  priority: 30,
  weight: 60,
  supportedModels: [
    "sora2",
    "sora2-pro",
    "veo31",
    "veo31-ref",
    "veo31-fast",
    "kling-o3",
    "kling3",
    "grok-imagine-video-1.5-preview",
  ],
  health: {
    enabled: true,
    failCount: 0,
  },

  canHandle(request) {
    return request.kind === "video" || this.supportedModels.includes(request.model);
  },

  async transformRequest(request) {
    return {
      url: `${UPSTREAM_BASE_URL}/v1/chat/completions`,
      method: "POST",
      headers: {
        "authorization": `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        "x-jingyin-request-id": request.requestId,
      },
      body: JSON.stringify(normalizeVideoBody(request.body)),
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
        message: extractMessage(body) || "Video upstream failed",
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

function normalizeVideoBody(body: unknown): unknown {
  const input = body as Record<string, unknown>;

  return {
    ...input,
    duration: input.duration ?? 8,
    aspect_ratio: input.aspect_ratio ?? "16:9",
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

