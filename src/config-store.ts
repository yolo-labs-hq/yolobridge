/**
 * Local on-disk state for the YoloBridge daemon: the device-flow auth
 * tokens from `yolo-bridge login`, and the current attachment record from
 * `yolo-bridge attach`. Config dir choice (docs/YOLOBRIDGE_PLAN.md's
 * historical §1.1 already named this location for the superseded design;
 * kept for this build too): `~/.config/yolobridge/`.
 *
 *   ~/.config/yolobridge/auth.json        — device-flow token pair
 *   ~/.config/yolobridge/attachment.json  — current workspace attachment
 *
 * Both files are written with mode 0600 (best-effort — not enforced on
 * every platform) since `auth.json` holds a live Bearer-equivalent
 * credential. Follows the same injectable-I/O pattern as
 * `packages/yolo-cli/src/auth-context.ts` (`ReadFileImpl`) so callers can
 * unit test against an in-memory stub instead of the real filesystem.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredAuth {
  accessToken: string;
  /**
   * The durable half of the login: auth-service's 30-day, rotate-on-use
   * refresh token. Persisted (0600) and rewritten on every rotation so the
   * ~24h access token renews itself (account-auth.ts) — see
   * docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md D8.
   *
   * Optional on the read path: 0.6.0–0.32.x daemons wrote `auth.json` WITHOUT
   * it after attaching (D5, since reversed), and such a file must still load —
   * it just cannot renew, so the operator logs in once more.
   */
  refreshToken?: string;
  tokenType: string;
  /** Absolute epoch-ms expiry of `accessToken`, computed at save time. */
  expiresAtMs: number;
}

export interface StoredAttachment {
  workspaceId: string;
  tileId: string;
  attachmentId: string;
  attachedAt: string;
  /**
   * The workspace-scoped daemon credential minted at attach (card 07's
   * renewal target), persisted so a daemon that restarts while it is still
   * renewable RESUMES this attachment instead of needing a full re-`attach` —
   * so the operator gets the same tile back rather than a duplicate.
   *
   * Both fields or neither (mirrors `api-client.ts`'s `attach`): a token whose
   * expiry is unknown cannot be scheduled around, and an expiry with no token
   * is nothing. Absent entirely on the degraded path, where the server issued
   * no scoped credential.
   */
  scopedToken?: string;
  /** Absolute epoch-ms expiry of `scopedToken`, as reported by the server. */
  scopedTokenExpiresAtMs?: number;
}

/** Minimal FS surface this module needs — injectable for tests. */
export interface ConfigStoreIO {
  readFile(filePath: string): string | undefined;
  writeFile(filePath: string, contents: string): void;
  removeFile(filePath: string): void;
}

export const defaultIO: ConfigStoreIO = {
  readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  },
  writeFile(filePath: string, contents: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
  },
  removeFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone — fine */
    }
  },
};

export function configDir(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME || os.homedir();
  return path.join(home, '.config', 'yolobridge');
}

function authPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'auth.json');
}

function attachmentPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'attachment.json');
}

export function loadAuth(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): StoredAuth | undefined {
  const raw = io.readFile(authPath(env));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (
      typeof parsed.accessToken === 'string' &&
      // Absent is VALID (the scoped path deliberately drops it); present must
      // still be a string. A malformed value is treated as absent rather than
      // as a corrupt file: the access token half is what this record is for,
      // and refusing to load it would log the operator out over a field the
      // daemon may not even need.
      (parsed.refreshToken === undefined || typeof parsed.refreshToken === 'string') &&
      typeof parsed.tokenType === 'string' &&
      typeof parsed.expiresAtMs === 'number'
    ) {
      const { accessToken, refreshToken, tokenType, expiresAtMs } = parsed;
      return {
        accessToken,
        tokenType,
        expiresAtMs,
        ...(refreshToken ? { refreshToken } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes `auth.json`. A missing (or empty) `refreshToken` is written out as an
 * ABSENT KEY, never as `""`.
 *
 * Normalised here rather than left to callers on purpose: an empty string is a
 * value that every `typeof x === 'string'` check downstream accepts, so it
 * would sail through the loader and be handed to auth-service's refresh
 * endpoint as a credential, turning "we deliberately dropped this" into an
 * unexplained 401. Absent is the honest encoding of absent.
 */
export function saveAuth(
  auth: StoredAuth,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  const record: StoredAuth = {
    accessToken: auth.accessToken,
    ...(auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    tokenType: auth.tokenType,
    expiresAtMs: auth.expiresAtMs,
  };
  io.writeFile(authPath(env), `${JSON.stringify(record, null, 2)}\n`);
}

export function clearAuth(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.removeFile(authPath(env));
}

export function loadAttachment(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): StoredAttachment | undefined {
  const raw = io.readFile(attachmentPath(env));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAttachment>;
    if (
      typeof parsed.workspaceId === 'string' &&
      typeof parsed.tileId === 'string' &&
      typeof parsed.attachmentId === 'string' &&
      typeof parsed.attachedAt === 'string'
    ) {
      const { workspaceId, tileId, attachmentId, attachedAt } = parsed;
      // Both-or-neither. A half-pair is dropped rather than rejecting the whole
      // record: the attachment IDENTITY is still perfectly good (detach and the
      // status display need only that), and the daemon simply falls back to a
      // fresh attach instead of resuming.
      const scoped =
        typeof parsed.scopedToken === 'string' && typeof parsed.scopedTokenExpiresAtMs === 'number'
          ? { scopedToken: parsed.scopedToken, scopedTokenExpiresAtMs: parsed.scopedTokenExpiresAtMs }
          : {};
      return { workspaceId, tileId, attachmentId, attachedAt, ...scoped };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveAttachment(
  attachment: StoredAttachment,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.writeFile(attachmentPath(env), `${JSON.stringify(attachment, null, 2)}\n`);
}

/**
 * Strips the workspace-scoped credential from `attachment.json`, leaving the
 * attachment identity behind.
 *
 * Distinct from `clearAttachment` because the two answer different questions.
 * `detach` clears the whole record on success — but on FAILURE it deliberately
 * keeps it, so the retry path (`cli.ts`, or a manual `yolo-bridge detach`)
 * knows what to retry against. The stored credential has no such second use:
 * the server refuses it the moment the attachment stops being live, so leaving
 * it on disk is residue that can only ever be leaked, never spent. No-ops when
 * there is nothing stored, and never creates a file.
 */
export function clearStoredScopedToken(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  const attachment = loadAttachment(env, io);
  if (!attachment || attachment.scopedToken === undefined) return;
  const { scopedToken: _dropped, scopedTokenExpiresAtMs: _droppedExpiry, ...rest } = attachment;
  saveAttachment(rest, env, io);
}

export function clearAttachment(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.removeFile(attachmentPath(env));
}
