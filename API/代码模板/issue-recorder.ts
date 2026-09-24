import type { JingyinRequest, JingyinResponse } from "./upstream-base";

export async function recordIssue(params: {
  request: JingyinRequest;
  upstream: string;
  response: JingyinResponse;
}): Promise<void> {
  const issue = {
    time: new Date().toISOString(),
    requestId: params.request.requestId,
    path: params.request.path,
    model: params.request.model,
    kind: params.request.kind,
    upstream: params.upstream,
    status: params.response.status,
    error: extractErrorMessage(params.response.body),
  };

  // 这里接入你自己的日志系统、数据库或 Markdown 生成器。
  // 重点是不要记录 Authorization、API Key、图片原文件、用户隐私信息。
  console.warn("[jingyin-api-issue]", JSON.stringify(issue));
}

function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return String(body ?? "");
  const maybeError = body as { error?: { message?: string; code?: string } };
  return [maybeError.error?.code, maybeError.error?.message].filter(Boolean).join(": ");
}

