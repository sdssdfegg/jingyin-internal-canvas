import type { JingyinRequest, JingyinResponse, UpstreamAdapter } from "./upstream-base";
import { normalizeErrorResponse } from "./error-normalizer";
import { recordIssue } from "./issue-recorder";

const DEFAULT_TIMEOUT_MS = 30_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const MAX_FAIL_COUNT = 3;

export async function routeWithFailover(
  request: JingyinRequest,
  upstreams: UpstreamAdapter[],
): Promise<JingyinResponse> {
  const candidates = upstreams
    .filter((item) => item.canHandle(request))
    .filter((item) => item.health.enabled)
    .filter((item) => !item.health.circuitOpenUntil || item.health.circuitOpenUntil < Date.now())
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);

  if (candidates.length === 0) {
    return normalizeErrorResponse({
      request,
      upstream: "none",
      status: 503,
      code: "upstream_unavailable",
      message: `No available upstream for model: ${request.model}`,
      retryable: false,
    });
  }

  let lastError: JingyinResponse | undefined;

  for (const upstream of candidates) {
    const startedAt = Date.now();

    try {
      const init = await upstream.transformRequest(request);
      const response = await fetchWithTimeout(init.url, init, DEFAULT_TIMEOUT_MS);
      const normalized = await upstream.transformResponse(response, request);

      upstream.health.failCount = 0;
      upstream.health.lastLatencyMs = Date.now() - startedAt;

      if (normalized.status < 500 && normalized.status !== 429) {
        return normalized;
      }

      lastError = normalized;
      markFailure(upstream);
      await recordIssue({ request, upstream: upstream.id, response: normalized });
    } catch (error) {
      const normalized = upstream.normalizeError(error, request);
      lastError = normalized;
      markFailure(upstream);
      await recordIssue({ request, upstream: upstream.id, response: normalized });
    }
  }

  return (
    lastError ??
    normalizeErrorResponse({
      request,
      upstream: "none",
      status: 503,
      code: "upstream_unavailable",
      message: "All upstreams failed",
      retryable: true,
    })
  );
}

function markFailure(upstream: UpstreamAdapter): void {
  upstream.health.failCount += 1;
  if (upstream.health.failCount >= MAX_FAIL_COUNT) {
    upstream.health.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

