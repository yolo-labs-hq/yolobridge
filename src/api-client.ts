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
  /**
   * This daemon's own `@yolo-labs/yolobridge` version.
   *
   * ⚠️ IT IS A CAPABILITY SIGNAL, not decoration. The daemon binary FREEZES on
   * the operator's machine at install time while the server and the webapp
   * deploy continuously — the same mixed-fleet seam the pod/server rule
   * describes, with the same trap. A server that starts sending a frame an
   * older daemon does not recognise gets no error back: the daemon logs a
   * local `degraded` note and drops it, and the route still answers 200
   * because the stream is genuinely held. Without a reported version there is
   * NO server-visible fact that distinguishes "delivered and acted on" from
   * "delivered and ignored".
   *
   * Absent from every daemon older than the release that added it, which is
   * exactly why its absence must DEGRADE (warn, still offer) rather than
   * brick — the reader cannot tell an old daemon from a new one that predates
   * the field.
   */
  cliVersion?: string;
}

/**
 * `POST /v1/workspaces/:workspaceId/yolobridge/attach`.
 *
 * `scopedToken` / `scopedTokenExpiresAt` are the workspace-scoped daemon
 * credential common-api mints at attach
 * (`docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md`): a token confined to THIS
 * workspace's YoloBridge surface, which the post-attach calls
 * (`detach`/`openStream`/`postHeartbeat`/`postReadOutputReply`) use instead of
 * the full-account token. `scopedTokenExpiresAt` is absolute epoch-ms computed
 * server-side at mint, so the refresh schedule never requires decoding the JWT.
 *
 * REQUIRED since 0.7.0 (card 09, D6 — "no backwards support"). Both fields or
 * neither is still the rule; what changed is that "neither" is now an ERROR
 * rather than a degrade. This used to be optional to protect a daemon binary
 * frozen on a laptop against a common-api predating the mint — but Boundary B
 * now refuses an account token on every post-attach route, so a daemon that
 * attaches without a scoped credential cannot do anything afterwards. Accepting
 * the response would buy it exactly one successful call and then a 403 loop
 * with no diagnosis; failing here names the real problem at the one moment the
 * operator is still watching the terminal.
 *
 * Every other exported function's signature is unchanged: they still take "the
 * bearer token to send" via `ApiClientConfig`, and which token that is remains
 * the caller's decision.
 */
export async function attach(
  cfg: ApiClientConfig,
  workspaceId: string,
  hostLabel?: string,
  remoteHost?: RemoteHostInfo,
): Promise<{
  tileId: string;
  attachmentId: string;
  scopedToken: string;
  scopedTokenExpiresAt: number;
}> {
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
  // Both-or-neither, and "neither" is a failure (see the doc comment). A token
  // with no expiry cannot be renewed on time and an expiry with no token is
  // nothing, so a half-pair is refused by the same check — there is no shape
  // here that yields a usable-but-unschedulable credential.
  if (typeof body?.scopedToken !== 'string' || typeof body?.scopedTokenExpiresAt !== 'number') {
    throw new YoloBridgeApiError(
      'attach returned no workspace-scoped credential — this server cannot host a YoloBridge daemon',
      res.status,
    );
  }
  return {
    tileId: body.tileId,
    attachmentId: body.attachmentId,
    scopedToken: body.scopedToken as string,
    scopedTokenExpiresAt: body.scopedTokenExpiresAt as number,
  };
}

/**
 * `POST /v1/workspaces/:workspaceId/yolobridge/attach/:attachmentId/refresh` —
 * renew the workspace-scoped daemon credential (card 07,
 * docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md, D1).
 *
 * `cfg.accessToken` MUST be the scoped token being renewed: this endpoint
 * authenticates by the presented credential itself ("proof of recent prior
 * possession"), so the token IS the request's identity. There is no refresh
 * credential — deliberately. The daemon never holds a long-lived one, which is
 * the entire point of the scoping work: a stolen laptop yields a credential
 * that expires in an hour and can only be renewed while it is still fresh.
 *
 * The server accepts a token that has JUST expired, within a narrow grace
 * window (15 minutes server-side), so a clock skew or a short sleep across the
 * scheduled renewal recovers instead of forcing a re-attach. Past that, the
 * refusal is terminal and the remedy is `yolo-bridge attach`.
 *
 * Unlike `attach`, the response shape is validated STRICTLY: this call only
 * ever reaches a server that already issued a scoped token, so a reply missing
 * one is a genuine protocol disagreement, not an old-server degrade. Returning
 * a half-pair would leave the caller unable to schedule the next renewal.
 */
export async function refreshScopedToken(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
): Promise<{ scopedToken: string; scopedTokenExpiresAt: number }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach/${encodeURIComponent(attachmentId)}/refresh`,
    { method: 'POST', headers: authHeaders(cfg) },
  );
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(`scoped credential refresh failed: ${message}`, res.status, code);
  }
  const body = (await res.json()) as any;
  if (typeof body?.scopedToken !== 'string' || typeof body?.scopedTokenExpiresAt !== 'number') {
    throw new YoloBridgeApiError('scoped credential refresh returned an unexpected shape', res.status);
  }
  return { scopedToken: body.scopedToken, scopedTokenExpiresAt: body.scopedTokenExpiresAt };
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

/**
 * `DELETE /v1/workspaces/:workspaceId/yolobridge/attach/:attachmentId`.
 *
 * `cfg.accessToken` must be the WORKSPACE-SCOPED credential, not the account
 * token: this is one of the daemon-only routes Boundary B guards, and an
 * account token is refused there with 403 YOLOBRIDGE_SCOPED_TOKEN_REQUIRED
 * (card 09). Both callers comply — the daemon's own cleanup path via
 * `scopedCfg()`, and standalone `yolo-bridge detach` via the credential
 * `attachment.json` persisted at attach.
 */
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

/**
 * The raw-replay half of a `read-output` reply (see frame-actions.ts's
 * `read-output` doc). Omitted entirely when the server asked for a plain
 * screen, or when there is no live PTY to take a seed from.
 */
export interface RawSeedReply {
  epoch: string;
  baseOffset: number;
  endOffset: number;
  data: string;
  truncated: boolean;
  /**
   * Sticky-mode escapes to write immediately before `data` — alternate screen,
   * scroll region, cursor visibility, wrap mode and SGR that the daemon's ring
   * has rolled past (local-agent.ts's `buildModePrologue`). Only ever sent
   * with `truncated: true`; an untruncated replay is self-contained.
   */
  prologue?: string;
}

export async function postReadOutputReply(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  requestId: string,
  output: string,
  busy: boolean,
  extra?: {
    /** The PTY's grid. The tile renders at EXACTLY this, never at its own
     *  pixel-derived size — see YoloBridgeTerminalView. */
    cols?: number;
    rows?: number;
    /** How many of `rows` carry content (local-agent.ts's `computeUsedRows`).
     *  A SCALE hint, not a geometry: the tile still renders `cols`×`rows`. */
    usedRows?: number;
    raw?: RawSeedReply;
    /**
     * Fingerprint of the daemon's own visible screen (local-agent.ts's
     * `screenDigest`). The viewer digests its rendered screen the same way and
     * re-seeds when the two disagree — a bounded-time correction for any
     * desync raw replay did not prevent. Cheap enough to send on every read.
     */
    screenDigest?: string;
  },
): Promise<boolean> {
  const body = await postEvent(cfg, workspaceId, {
    attachmentId,
    type: 'read-output-reply',
    requestId,
    output,
    busy,
    ...(extra?.cols && extra?.rows ? { cols: extra.cols, rows: extra.rows } : {}),
    ...(extra?.usedRows ? { usedRows: extra.usedRows } : {}),
    ...(extra?.raw
      ? {
          raw: extra.raw.data,
          epoch: extra.raw.epoch,
          baseOffset: extra.raw.baseOffset,
          endOffset: extra.raw.endOffset,
          truncated: extra.raw.truncated,
          ...(extra.raw.prologue ? { prologue: extra.raw.prologue } : {}),
        }
      : {}),
    ...(extra?.screenDigest ? { screenDigest: extra.screenDigest } : {}),
  });
  return Boolean(body?.resolved);
}

/**
 * `POST .../yolobridge/events {type:'output-chunk'}` — one batch of live PTY
 * output (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming").
 *
 * Sent ONLY while the server has an unexpired `output-stream-start` lease
 * outstanding, i.e. only while a browser is actually watching the tile. A
 * daemon with no viewer sends none of these at all — see attach-cmd.ts's
 * stream controller.
 *
 * Authenticated with the WORKSPACE-SCOPED credential like every other
 * post-attach call (Boundary B refuses an account token here), and the bytes
 * are relayed in memory by the server onto the workspace's own event stream —
 * never logged, never written to Mongo, never appended to the resumable event
 * buffer. This is the operator's live screen; it can contain anything they
 * typed.
 *
 * `droppedBytes` is how many bytes were SKIPPED immediately before `data`
 * (see output-stream.ts). Non-zero means the viewer must treat its screen as
 * unreliable and re-seed — it is not a diagnostic counter, it is part of the
 * protocol.
 */
export async function postOutputChunk(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  chunk: {
    streamId: string;
    seq: number;
    data: string;
    droppedBytes: number;
    /** PTY session identity + absolute byte position of `data[0]`. These are
     *  what let the viewer splice this chunk onto its seed exactly once; see
     *  output-stream.ts's `OutputBatch.startOffset`. */
    epoch?: string;
    startOffset?: number;
    /** The PTY's grid, restated per chunk so a viewer that joins mid-episode
     *  learns the geometry WITH its first chunk rather than after it. */
    cols?: number;
    rows?: number;
    /** How many of `rows` carry content right now. Restated per chunk for the
     *  same reason, and for a second one: it MOVES as the session produces
     *  output, so the viewer's scale would otherwise be stuck at seed time. */
    usedRows?: number;
  },
): Promise<boolean> {
  const body = await postEvent(cfg, workspaceId, {
    attachmentId,
    type: 'output-chunk',
    streamId: chunk.streamId,
    seq: chunk.seq,
    data: chunk.data,
    droppedBytes: chunk.droppedBytes,
    ...(chunk.epoch ? { epoch: chunk.epoch } : {}),
    ...(typeof chunk.startOffset === 'number' ? { startOffset: chunk.startOffset } : {}),
    ...(chunk.cols && chunk.rows ? { cols: chunk.cols, rows: chunk.rows } : {}),
    ...(chunk.usedRows ? { usedRows: chunk.usedRows } : {}),
  });
  return Boolean(body?.relayed);
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

export interface PresignedUpload {
  assetId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Phase 1 of a file share: ask common-api to reserve an asset and hand back a
 * presigned PUT.
 *
 * Note what is NOT sent: no path. Only the basename, the mime type and the
 * size. The operator's directory layout is not the cloud's business, and the
 * server has no use for it.
 *
 * The tile is chosen SERVER-side from the attachment — there is deliberately no
 * `tileId` parameter here, because a daemon does not get to pick.
 */
export async function presignShare(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  meta: { filename: string; mimeType: string; size: number },
): Promise<PresignedUpload> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach/${attachmentId}/uploads`,
    {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    },
  );
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(message, res.status, code);
  }
  return (await res.json()) as PresignedUpload;
}

/** Phase 2: the bytes are in R2; ask the server to verify and seal the asset. */
export async function finalizeShare(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  assetId: string,
): Promise<{ assetId: string }> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach/${attachmentId}/uploads/${encodeURIComponent(assetId)}/finalize`,
    { method: 'POST', headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(message, res.status, code);
  }
  const body = (await res.json()) as { asset?: { assetId?: string } };
  return { assetId: body?.asset?.assetId ?? assetId };
}

export interface DeliveredAsset {
  /** Where the pod wrote it, e.g. `.yolo-drops/<assetId>-<filename>` — the path
   *  the target agent should be told to open. */
  path: string;
  size?: number;
  filename?: string;
}

/**
 * Phase 3, optional: write an already-shared asset into ANOTHER tile's session
 * pod, so the agent there can open it as a real file.
 *
 * Only DELIVERY crosses to another tile. The asset itself stays on this
 * attachment's tile — the server enforces that, and nothing here can ask
 * otherwise.
 */
export async function deliverShare(
  cfg: ApiClientConfig,
  workspaceId: string,
  attachmentId: string,
  assetId: string,
  targetTileId: string,
): Promise<DeliveredAsset> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${base(cfg)}/v1/workspaces/${workspaceId}/yolobridge/attach/${attachmentId}/deliver`,
    {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId, targetTileId }),
    },
  );
  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new YoloBridgeApiError(message, res.status, code);
  }
  return (await res.json()) as DeliveredAsset;
}
