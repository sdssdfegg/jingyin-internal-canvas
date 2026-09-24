import type { JingyinRequest, JingyinResponse } from "./upstream-base";

export type NormalizedErrorCode =
  | "invalid_api_key"
  | "insufficient_quota"
  | "model_not_found"
  | "bad_request"
  | "upstream_timeout"
  | "upstream_rate_limited"
  | "upstream_unavailable"
  | "unknown_upstream_error";

export function normalizeErrorResponse(params: {
  request: JingyinRequest;
  upstream: string;
  status: number;
  code: NormalizedErrorCode;
  message: string;
  retryable: boolean;
  raw?: unknown;
}): JingyinResponse {
  return {
    status: params.status,
    upstream: params.upstream,
    requestId: params.request.requestId,
    headers: {
      "content-type": "application/json",
      "x-jingyin-request-id": params.request.requestId,
      "x-jingyin-upstream": params.upstream,
      "x-jingyin-retryable": String(params.retryable),
    },
    body: {
      error: {
        code: params.code,
        message: params.message,
        type: "jingyin_gateway_error",
        upstream: params.upstream,
        request_id: params.request.requestId,
      },
    },
  };
}

export function classifyHttpStatus(status: number): {
  code: NormalizedErrorCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { code: "invalid_api_key", retryable: false };
  }
  if (status === 402) {
    return { code: "insufficient_quota", retryable: false };
  }
  if (status === 404) {
    return { code: "model_not_found", retryable: false };
  }
  if (status === 408 || status === 504 || status === 524) {
    return { code: "upstream_timeout", retryable: true };
  }
  if (status === 429) {
    return { code: "upstream_rate_limited", retryable: true };
  }
  if (status >= 500) {
    return { code: "upstream_unavailable", retryable: true };
  }
  return { code: "bad_request", retryable: false };
}

