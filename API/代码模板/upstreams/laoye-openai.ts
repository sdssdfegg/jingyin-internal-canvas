import type { JingyinRequest, JingyinResponse, UpstreamAdapter } from "../upstream-base";
import { classifyHttpStatus, normalizeErrorResponse } from "../error-normalizer";

const UPSTREAM_BASE_URL = process.env.LAOYE_OPENAI_BASE_URL ?? "";
const UPSTREAM_API_KEY = process.env.LAOYE_OPENAI_API_KEY ?? "";

export const laoyeOpenAIAdapter: UpstreamAdapter = {
  id: "laoye-openai",
  displayName: "老夜的渠道",
  priority: 10,
  weight: 100,
  supportedModels: ["gpt-5.5"],
  health: {
    enabled: true,
    failCount: 0,
  },

  canHandle(request) {
    return this.supportedModels.includes(request.model);
  },

  async transformRequest(request) {
    return {
      url: `${UPSTREAM_BASE_URL}${request.path}`,
      method: "POST",
      headers: {
        "authorization": `Bearer ${UPSTREAM_API_KEY}`,
        "content-type": "application/json",
        "x-jingyin-request-id": request.requestId,
      },
      body: JSON.stringify(request.body),
    };
  },

  async transformResponse(response, request): Promise<JingyinResponse> {
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
        message: extractMessage(body) || `Upstream ${this.id} failed`,
      });
    }

    return {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
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

