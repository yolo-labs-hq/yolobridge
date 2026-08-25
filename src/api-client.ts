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

/**
 * Self-reported, non-sensitive facts about THIS machine, sent once in the
 * attach handshake so the workspace tile can show where the attached
 * session is actually running (docs/YOLOBRIDGE_PLAN.md, "Tile session
 * overview"). Mirrors common-api's `YoloBridgeRemoteHost`, which reads
 * exactly these three keys and ignores anything else.
 *
 * Intentionally minimal: the working directory the operator launched the
 * daemon from, the OS platform string, and which agent binary this attach
 * drives. No environment variables, no directory contents, no username or
 * account detail — the daemon reports what the tile needs to identify the
 * session, and nothing more about the machine it runs on.
 */
export interface RemoteHostInfo {
  cwd?: string;
  platform?: string;
  agent?: string;
}

export async function attach(
  cfg: ApiClientConfig,
  workspaceId: string,
  hostLabel?: string,
  remoteHost?: RemoteHostInfo,
): Promise<{ tileId: string; attachmentId: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(hostLabel ? { hostLabel } : {}),
      ...(remoteHost && Object.values(remoteHost).some(Boolean) ? { remoteHost } : {}),
    }),
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

export interface SelectableWorkspace {
  id: string;
  name: string;
  status: string;
}

/**
 * `GET /v1/workspaces/selectable` — slim `{id,name,status}` list of the
 * caller's own non-terminated, non-ephemeral workspaces (capped at 500
 * server-side), authenticated the same `flexibleAuth` tier as every other
 * call in this file. There's no membership/role model in this codebase —
 * a user's workspaces are strictly `{ userId: <them> }` — so this is a
 * single owner-scoped list, not a "workspaces I can see" query.
 * (`common-api/src/routes/workspaces.ts`, `WorkspaceService.listSelectable`.)
 */
export async function listSelectableWorkspaces(cfg: ApiClientConfig): Promise<SelectableWorkspace[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${base(cfg)}/v1/workspaces/selectable`, {
    method: 'GET',
    headers: authHeaders(cfg),
  });
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`list workspaces failed: ${message}`, res.status, code);
  }
  const body = (await res.json()) as any;
  if (!Array.isArray(body?.workspaces)) {
    throw new YoloBridgeApiError('list workspaces returned an unexpected shape', res.status);
  }
  const workspaces: SelectableWorkspace[] = [];
  for (const w of body.workspaces) {
    if (typeof w?.id !== 'string' || typeof w?.status !== 'string') {
      throw new YoloBridgeApiError('list workspaces returned an unexpected shape', res.status);
    }
    workspaces.push({ id: w.id, name: typeof w.name === 'string' ? w.name : '', status: w.status });
  }
  return workspaces;
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
