/**
 * Thin HTTP client for the daemon-facing YoloBridge surface
 * (`common-api/src/routes/yolobridge.ts`, mounted under
 * `/v1/workspaces/:workspaceId/yolobridge`). Shapes here are read
 * directly off that route file + `yolobridge-service.ts`, not guessed.
 */

export type FetchImpl = typeof fetch;

export class YoloBridgeApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'YoloBridgeApiError';
  }
}

export interface ApiClientConfig {
  commonApiBaseUrl: string;
  accessToken: string;
  fetchImpl?: FetchImpl;
}

function base(cfg: ApiClientConfig): string {
  return cfg.commonApiBaseUrl.replace(/\/+$/, '');
}

function authHeaders(cfg: ApiClientConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.accessToken}` };
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = (await res.json()) as any;
    return { message: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`, code: body?.code };
  } catch {
    return { message: `HTTP ${res.status}` };
  }
}

export async function attach(
  cfg: ApiClientConfig,
  workspaceId: string,
  hostLabel?: string,
): Promise<{ tileId: string; attachmentId: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(hostLabel ? { hostLabel } : {}),
  });
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`attach failed: ${message}`, res.status, code);
  }
  const body = (await res.json()) as any;
  if (typeof body?.tileId !== 'string' || typeof body?.attachmentId !== 'string') {
    throw new YoloBridgeApiError('attach returned an unexpected shape', res.status);
  }
  return { tileId: body.tileId, attachmentId: body.attachmentId };
}

export async function detach(cfg: ApiClientConfig, workspaceId: string, attachmentId: string): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach/${attachmentId}`, {
    method: 'DELETE',
    headers: authHeaders(cfg),
  });
  // 204 on success; a 404 (already detached) is treated as success too —
  // detach is idempotent from the CLI's point of view.
  if (!res.ok && res.status !== 404) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`detach failed: ${message}`, res.status, code);
  }
}

/** Opens the raw `GET /stream` connection. Caller owns reading/parsing `res.body`. */
export async function openStream(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
): Promise<Response> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/stream?attachmentId=${encodeURIComponent(attachmentId)}`;
  const res = await fetchImpl(url, { method: 'GET', headers: { ...authHeaders(cfg), Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`stream open failed: ${message}`, res.status, code);
  }
  return res;
}

export async function postHeartbeat(cfg: ApiClientConfig, workspaceId: string, attachmentId: string): Promise<boolean> {
  const body = await postEvent(cfg, workspaceId, { attachmentId, type: 'heartbeat' });
  return Boolean(body?.recorded);
}

export async function postReadOutputReply(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  requestId: string,
  output: string,
  busy: boolean,
): Promise<boolean> {
  const body = await postEvent(cfg, workspaceId, {
    attachmentId,
    type: 'read-output-reply',
    requestId,
    output,
    busy,
  });
  return Boolean(body?.resolved);
}

async function postEvent(cfg: ApiClientConfig, workspaceId: string, payload: Record<string, unknown>): Promise<any> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/events`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`events (${payload.type}) failed: ${message}`, res.status, code);
  }
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
