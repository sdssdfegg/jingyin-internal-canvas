export type JingyinApiKind =
  | "chat"
  | "responses"
  | "image_generation"
  | "image_edit"
  | "video"
  | "audio";

export interface JingyinRequest {
  kind: JingyinApiKind;
  path: string;
  model: string;
  headers: Record<string, string>;
  body: unknown;
  files?: Array<{
    field: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }>;
  requestId: string;
}

export interface JingyinResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  upstream: string;
  requestId: string;
}

export interface UpstreamHealth {
  enabled: boolean;
  lastLatencyMs?: number;
  failCount: number;
  circuitOpenUntil?: number;
}

export interface UpstreamAdapter {
  id: string;
  displayName: string;
  priority: number;
  weight: number;
  supportedModels: string[];
  health: UpstreamHealth;

  canHandle(request: JingyinRequest): boolean;
  transformRequest(request: JingyinRequest): Promise<RequestInit & { url: string }>;
  transformResponse(response: Response, request: JingyinRequest): Promise<JingyinResponse>;
  normalizeError(error: unknown, request: JingyinRequest): JingyinResponse;
}

