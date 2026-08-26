/**
 * `yolo-bridge share <path>` — hand a LOCAL file up to the attached workspace
 * so the cloud orchestrator can see it.
 *
 * DIRECTION IS THE SECURITY MODEL. This is the only file path in the daemon,
 * and it runs because the operator (or their local agent) asked for THIS file.
 * There is no counterpart that lets the cloud name a path and have the daemon
 * read it — that would turn a cloud-side prompt injection into a read of the
 * operator's disk.
 *
 * Bytes go straight from this process to R2 via a presigned PUT. They do not
 * pass through common-api, so a large file is not bounded by any JSON body
 * limit, and the API never holds the operator's content.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  presignShare,
  finalizeShare,
  deliverShare,
  YoloBridgeApiError,
  type ApiClientConfig,
  type FetchImpl,
} from './api-client.js';
import { loadAuth, loadAttachment, type ConfigStoreIO } from './config-store.js';

/**
 * Mirrors common-api's `MAX_ASSET_BYTES`. The server is authoritative and
 * refuses over-cap uploads on its own; this copy exists so a 2 GB video fails
 * in a second with a readable message instead of after a long upload.
 *
 * If the server cap ever moves, the worst this stale copy produces is a local
 * refusal of something the server would have accepted — a clear message, not a
 * corrupt upload.
 */
export const MAX_SHARE_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
};

export function guessMimeType(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Raised for a condition the operator can act on. The CLI prints `.message`
 *  and exits non-zero — no stack trace, because none of these are bugs. */
export class ShareError extends Error {}

export interface LocalFileFacts {
  absolutePath: string;
  filename: string;
  size: number;
  mimeType: string;
}

/**
 * Everything decided from the local filesystem, BEFORE a single byte moves.
 *
 * Split out from the upload so the refusals are testable without a network,
 * and so an over-cap file costs a `stat`, not an upload.
 */
export async function inspectLocalFile(rawPath: string): Promise<LocalFileFacts> {
  const absolutePath = path.resolve(rawPath);

  let info;
  try {
    info = await stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new ShareError(`No such file: ${rawPath}`);
    if (code === 'EACCES') throw new ShareError(`Permission denied reading ${rawPath}`);
    throw new ShareError(`Could not read ${rawPath}: ${(err as Error).message}`);
  }

  if (info.isDirectory()) {
    throw new ShareError(`${rawPath} is a directory. Share a single file.`);
  }
  if (!info.isFile()) {
    throw new ShareError(`${rawPath} is not a regular file.`);
  }
  if (info.size > MAX_SHARE_BYTES) {
    // Name both numbers: "too large" without the cap leaves the operator
    // guessing how much to trim.
    throw new ShareError(
      `${path.basename(absolutePath)} is ${formatBytes(info.size)}, over the ${formatBytes(MAX_SHARE_BYTES)} limit for a shared file.`,
    );
  }

  return {
    absolutePath,
    // Only the BASENAME travels. The operator's directory layout is not the
    // cloud's business.
    filename: path.basename(absolutePath),
    size: info.size,
    mimeType: guessMimeType(absolutePath),
  };
}

export interface ShareDeps {
  cfg: ApiClientConfig;
  workspaceId: string;
  attachmentId: string;
  /** Also write the file into THIS tile's session pod, so the agent there can
   *  open it. Omit to leave the asset in the workspace only. */
  targetTileId?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Progress/status line sink. Defaults to stdout. */
  write?: (line: string) => void;
}

/**
 * Presign → PUT the bytes to R2 → finalize.
 *
 * The PUT streams from disk rather than buffering: a 100 MB file must not
 * become a 100 MB string in this process.
 */
export async function shareFile(rawPath: string, deps: ShareDeps): Promise<{ assetId: string; deliveredPath?: string }> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const file = await inspectLocalFile(rawPath);
  // One fetch for all three legs. Taking it from `deps` too means a caller can
  // inject it once instead of having to remember to put it on `cfg` as well.
  const cfg: ApiClientConfig = { ...deps.cfg, fetchImpl: deps.cfg.fetchImpl ?? (deps.fetchImpl as ApiClientConfig['fetchImpl']) };

  write(`Sharing ${file.filename} (${formatBytes(file.size)})…`);

  const presigned = await presignShare(cfg, deps.workspaceId, deps.attachmentId, {
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
  });

  const fetchImpl = (deps.fetchImpl ?? deps.cfg.fetchImpl ?? fetch) as typeof fetch;
  // Streamed from disk rather than buffered: a 100 MB file must not become a
  // 100 MB Buffer in this process. The stream is opened lazily, so it is held
  // in a variable and explicitly destroyed on every failure path — otherwise a
  // rejected or refused PUT leaks the descriptor.
  const body = createReadStream(file.absolutePath);
  // A read failure — the file deleted, truncated or unreadable mid-upload —
  // arrives as an 'error' EVENT, not a rejected promise. With no listener Node
  // escalates it to an uncaughtException and takes the process down, which for
  // a daemon sharing a file the operator just moved is a very poor trade.
  // Captured here and reported as an ordinary failure instead.
  let readError: Error | undefined;
  body.on('error', (err: Error) => { readError = err; });
  let put: Response;
  try {
    put = await fetchImpl(presigned.uploadUrl, {
      method: presigned.method || 'PUT',
      headers: { ...presigned.headers, 'Content-Length': String(file.size) },
      body: body as unknown as RequestInit['body'],
      // Node's fetch requires this for a stream body.
      duplex: 'half',
    } as RequestInit);
  } catch (err) {
    body.destroy();
    throw new ShareError(`Upload failed: ${(err as Error)?.message || 'network error'}`);
  }

  if (!put.ok) {
    body.destroy();
    // The presigned URL is short-lived and size-bound; both failure modes are
    // worth naming rather than surfacing a bare status.
    throw new ShareError(
      `Upload failed (HTTP ${put.status}). The link may have expired, or the file changed size while uploading. Try again.`,
    );
  }

  if (readError) {
    throw new ShareError(`Could not read ${file.filename} while uploading: ${readError.message}`);
  }

  const finalized = await finalizeShare(cfg, deps.workspaceId, deps.attachmentId, presigned.assetId);
  write(`Shared ${file.filename} → ${finalized.assetId}`);

  if (!deps.targetTileId) return finalized;

  // The upload has ALREADY SUCCEEDED. If delivery fails the file is genuinely
  // in the workspace, so say that rather than reporting a flat failure and
  // inviting a re-upload of something already there.
  try {
    const delivered = await deliverShare(
      cfg, deps.workspaceId, deps.attachmentId, finalized.assetId, deps.targetTileId,
    );
    write(`Delivered to ${deps.targetTileId} at ${delivered.path}`);
    return { ...finalized, deliveredPath: delivered.path };
  } catch (err) {
    const why = err instanceof YoloBridgeApiError ? err.message : (err as Error)?.message || 'unknown error';
    throw new ShareError(
      `${file.filename} was uploaded (asset ${finalized.assetId}) but could not be delivered to `
      + `${deps.targetTileId}: ${why}. The file IS in the workspace — retry the DELIVERY only, with `
      + `\`yolo-bridge deliver ${finalized.assetId} --to ${deps.targetTileId}\`, rather than sharing it again.`,
    );
  }
}

/** Turn an API error into something the operator can act on. */
export function describeShareFailure(err: unknown): string {
  if (err instanceof ShareError) return err.message;
  if (err instanceof YoloBridgeApiError) {
    if (err.code === 'PAYLOAD_TOO_LARGE') return err.message;
    if (err.code === 'STORAGE_NOT_CONFIGURED') return 'File sharing is not available on this server.';
    if (err.code === 'WORKSPACE_LIMIT_REACHED' || err.code === 'LIMIT_REACHED') return err.message;
    if (err.status === 403) return 'This daemon is not attached to that workspace any more. Re-run `yolo-bridge attach`.';
    return err.message;
  }
  return (err as Error)?.message || 'Share failed.';
}


export interface ShareCommandDeps {
  commonApiBaseUrl: string;
  /** Deliver into this tile's pod after uploading. */
  targetTileId?: string;
  /**
   * Refuse unless the stored attachment is for THIS workspace.
   *
   * The attachment is reloaded from disk on every call (so a rotated scoped
   * token is always current), which means it can also have been REPLACED — a
   * second `yolo-bridge attach` to a different workspace rewrites it. A caller
   * that authorised something against one workspace must not then upload into
   * another. (codex P2, gpt-5.6-sol.)
   *
   * Omitted by the human-typed `share` command, whose authority is the current
   * attachment whatever it is.
   */
  expectedWorkspaceId?: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
  write?: (line: string) => void;
}

export type ShareResult =
  | { ok: true; assetId: string; deliveredPath?: string }
  | { ok: false; reason: 'not-logged-in' | 'not-attached' | 'no-scoped-credential' | 'workspace-changed' | 'error'; message: string };

/**
 * The disk-backed entry point, mirroring `runDetach`.
 *
 * `share` and a running `yolo-bridge attach` are two SEPARATE processes, so
 * this reads the attachment identity and its workspace-scoped credential from
 * the config store rather than from daemon memory — the same credential the
 * running daemon uses, and the only one the upload routes accept (Boundary B).
 */
/**
 * The preconditions every daemon-credentialed command shares: logged in,
 * attached, attached to the EXPECTED workspace, and holding a scoped token.
 *
 * Factored out so `runShare` and `runDeliver` cannot drift apart on which
 * checks they perform or what they say when one fails.
 */
function resolveShareIdentity(deps: ShareCommandDeps):
  | { ok: true; cfg: ApiClientConfig; workspaceId: string; attachmentId: string }
  | { ok: false; reason: 'not-logged-in' | 'not-attached' | 'no-scoped-credential' | 'workspace-changed'; message: string } {
  if (!loadAuth(deps.env, deps.io)) {
    return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };
  }
  const attachment = loadAttachment(deps.env, deps.io);
  if (!attachment) {
    return { ok: false, reason: 'not-attached', message: 'No active attachment — run `yolo-bridge attach` first.' };
  }
  if (deps.expectedWorkspaceId && attachment.workspaceId !== deps.expectedWorkspaceId) {
    return {
      ok: false,
      reason: 'workspace-changed',
      message:
        'This machine is now attached to a different workspace than the one this request was '
        + 'authorised against. Nothing was sent. Re-run `yolo-bridge attach` or retry.',
    };
  }
  if (!attachment.scopedToken) {
    return {
      ok: false,
      reason: 'no-scoped-credential',
      message:
        'No workspace-scoped credential is stored for this attachment, so files cannot be shared '
        + 'from this machine. Run `yolo-bridge attach` to reconnect.',
    };
  }
  return {
    ok: true,
    cfg: { commonApiBaseUrl: deps.commonApiBaseUrl, accessToken: attachment.scopedToken, fetchImpl: deps.fetchImpl },
    workspaceId: attachment.workspaceId,
    attachmentId: attachment.attachmentId,
  };
}

export async function runShare(rawPath: string, deps: ShareCommandDeps): Promise<ShareResult> {
  // Same precondition ordering as detach: `auth.json` is what makes this a
  // set-up machine, and its absence has a far better remedy to offer than a
  // 403 would.
  if (!loadAuth(deps.env, deps.io)) {
    return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };
  }

  const attachment = loadAttachment(deps.env, deps.io);
  if (!attachment) {
    return { ok: false, reason: 'not-attached', message: 'No active attachment — run `yolo-bridge attach` first.' };
  }

  if (deps.expectedWorkspaceId && attachment.workspaceId !== deps.expectedWorkspaceId) {
    return {
      ok: false,
      reason: 'workspace-changed',
      message:
        'This machine is now attached to a different workspace than the one this request was '
        + 'authorised against. Nothing was sent. Re-run `yolo-bridge attach` or retry.',
    };
  }

  const scopedToken = attachment.scopedToken;
  if (!scopedToken) {
    // Nothing on this machine can mint one for an existing attachment, so say
    // so plainly rather than sending an account token to be refused.
    return {
      ok: false,
      reason: 'no-scoped-credential',
      message:
        'No workspace-scoped credential is stored for this attachment, so files cannot be shared '
        + 'from this machine. Run `yolo-bridge attach` to reconnect.',
    };
  }

  const cfg: ApiClientConfig = {
    commonApiBaseUrl: deps.commonApiBaseUrl,
    accessToken: scopedToken,
    fetchImpl: deps.fetchImpl,
  };

  try {
    const { assetId, deliveredPath } = await shareFile(rawPath, {
      cfg,
      workspaceId: attachment.workspaceId,
      attachmentId: attachment.attachmentId,
      targetTileId: deps.targetTileId,
      fetchImpl: deps.fetchImpl as typeof fetch | undefined,
      write: deps.write,
    });
    return { ok: true, assetId, ...(deliveredPath ? { deliveredPath } : {}) };
  } catch (err) {
    return { ok: false, reason: 'error', message: describeShareFailure(err) };
  }
}


export type DeliverResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'not-logged-in' | 'not-attached' | 'no-scoped-credential' | 'workspace-changed' | 'error'; message: string };

/**
 * Deliver an ALREADY-SHARED asset into a tile's session, without re-uploading.
 *
 * WHY THIS EXISTS: `shareFile` tells the operator, after a delivery failure,
 * that the file IS in the workspace and to retry the delivery rather than the
 * upload. That instruction was false until this existed — every entry point
 * began with a fresh presign, so the only available "retry" duplicated the
 * asset. (codex P2, gpt-5.6-sol.) An error message must name a recovery the
 * caller can actually perform.
 */
export async function runDeliver(
  assetId: string,
  targetTileId: string,
  deps: ShareCommandDeps,
): Promise<DeliverResult> {
  const preflight = await resolveShareIdentity(deps);
  if (!preflight.ok) return preflight;

  try {
    const delivered = await deliverShare(
      preflight.cfg, preflight.workspaceId, preflight.attachmentId, assetId, targetTileId,
    );
    return { ok: true, path: delivered.path };
  } catch (err) {
    return { ok: false, reason: 'error', message: describeShareFailure(err) };
  }
}
