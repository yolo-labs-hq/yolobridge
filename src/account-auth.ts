/**
 * Keeps the ACCOUNT credential from `yolo-bridge login` alive across days.
 *
 * auth-service issues a ~24h access token and a 30-day refresh token that
 * ROTATES on every use (`auth/src/services/TokenService.ts`'s
 * `refreshAccessToken` deletes the presented one's record and mints a new
 * pair; a spent token is only still accepted via its Redis-loss "recovery
 * mode", which nothing here should rely on). So the
 * login stays good indefinitely as long as something renews it at least once
 * a month and writes the rotated pair back — which is what this module does,
 * for every command that presents the account token (attach, the workspace
 * picker, `yolo-bridge workspaces`).
 *
 * Before 0.33.0 the attach daemon deliberately dropped the refresh token from
 * `auth.json` after its first attach (docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md
 * D5), which turned every login into a one-day login: the next `attach`, the
 * picker and `workspaces` all failed with "log in again" once the access token
 * ran out. D8 in that doc records the reversal.
 */

import { refreshAccessToken as refreshAccessTokenApi, type FetchImpl, type RefreshTokenResult } from './device-auth.js';
import { loadAuth, saveAuth, type ConfigStoreIO, type StoredAuth } from './config-store.js';

/** Same shape as device-auth.ts's `refreshAccessToken` — injectable so tests
 * don't hit the network. Defaults to the real auth-service call. */
export type RefreshTokenFn = (
  authBaseUrl: string,
  refreshToken: string,
  fetchImpl?: FetchImpl,
) => Promise<RefreshTokenResult>;

export const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';

/** Refresh once the access token has less than this much validity left.
 * Production access tokens live 24h; 5min gives ample margin against a
 * slow/retried refresh call before the old token actually 401s. */
export const DEFAULT_REFRESH_BUFFER_MS = 5 * 60_000;

export function defaultAuthBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.YOLOBRIDGE_AUTH_URL || DEFAULT_AUTH_URL;
}

export interface AccountAuthDeps {
  authBaseUrl?: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
  now?: () => number;
  refreshBufferMs?: number;
  refreshAccessToken?: RefreshTokenFn;
}

export type RotateAccountAuthResult =
  | { ok: true; auth: StoredAuth }
  /** `retryable`: auth-service was unreachable or erroring, so the stored
   *  login may still be good — distinct from a refusal, which needs a new
   *  `yolo-bridge login`. */
  | { ok: false; message: string; retryable: boolean };

export function needsRefresh(auth: StoredAuth, now: number, refreshBufferMs = DEFAULT_REFRESH_BUFFER_MS): boolean {
  return now >= auth.expiresAtMs - refreshBufferMs;
}

/** Unverified JWT claims — for local decisions only (whose login is this,
 *  has it lapsed), never for trust. Undefined for anything not JWT-shaped. */
function jwtClaims(token: string | undefined): { sub?: unknown; exp?: unknown } | undefined {
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** False only when both tokens name a subject and the subjects differ. */
export function sameAccount(a: StoredAuth, b: StoredAuth): boolean {
  const subA = jwtClaims(a.accessToken)?.sub;
  const subB = jwtClaims(b.accessToken)?.sub;
  return subA === undefined || subB === undefined || subA === subB;
}

/**
 * Whether the stored login can still renew itself: a refresh token is present
 * and, when its expiry is readable, has not passed.
 */
export function canAutoRenew(auth: StoredAuth, now: number): boolean {
  if (!auth.refreshToken) return false;
  const exp = jwtClaims(auth.refreshToken)?.exp;
  return typeof exp !== 'number' || exp * 1000 > now;
}

/**
 * Spend `current.refreshToken` for a new pair and persist it — refresh token
 * INCLUDED, since the one just presented is no longer the live one.
 *
 * The write is guarded against `auth.json` changing underneath this caller. It
 * lands if the file still holds the refresh token just spent, or holds an
 * OLDER pair for the same account (another process won a concurrent rotation;
 * ours is the newer, and skipping the write would leave a long-running daemon
 * never persisting again). It does NOT land if the file was deleted — that is
 * a local logout, not to be undone — or now holds another account's login or a
 * newer one. The caller still gets the new pair to use in memory.
 */
export async function rotateAccountAuth(current: StoredAuth, deps: AccountAuthDeps = {}): Promise<RotateAccountAuthResult> {
  if (!current.refreshToken) {
    return {
      ok: false,
      retryable: false,
      message: 'the account access token has expired and no refresh token is stored on this machine',
    };
  }
  const doRefresh = deps.refreshAccessToken ?? refreshAccessTokenApi;
  const result = await doRefresh(deps.authBaseUrl ?? defaultAuthBaseUrl(deps.env), current.refreshToken, deps.fetchImpl);
  if (result.status !== 'ok') {
    return { ok: false, message: result.message, retryable: result.retryable === true };
  }
  const auth: StoredAuth = {
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    tokenType: current.tokenType,
    expiresAtMs: result.tokens.expiresAtMs,
  };
  const onDisk = loadAuth(deps.env, deps.io);
  if (
    onDisk &&
    (onDisk.refreshToken === current.refreshToken || (sameAccount(onDisk, auth) && onDisk.expiresAtMs < auth.expiresAtMs))
  ) {
    try {
      saveAuth(auth, deps.env, deps.io);
    } catch {
      // The presented refresh token is already spent; throwing here would
      // discard its only successor. Hand the pair back for in-memory use and
      // let the next rotation try the write again.
    }
  }
  return { ok: true, auth };
}

export type FreshAccountAuthResult =
  | { ok: true; auth: StoredAuth }
  | { ok: false; reason: 'not-logged-in' }
  | { ok: false; reason: 'refresh-failed'; message: string; retryable: boolean };

/**
 * Load `auth.json` and return a usable account credential, renewing it first
 * when it is expired or about to be. For one-shot commands; the attach daemon
 * keeps its own in-memory copy and calls `rotateAccountAuth` directly.
 */
export async function ensureFreshAccountAuth(deps: AccountAuthDeps = {}): Promise<FreshAccountAuthResult> {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) return { ok: false, reason: 'not-logged-in' };
  const now = deps.now ?? Date.now;
  if (!needsRefresh(auth, now(), deps.refreshBufferMs)) return { ok: true, auth };
  const rotated = await rotateAccountAuth(auth, deps);
  if (!rotated.ok) return { ok: false, reason: 'refresh-failed', message: rotated.message, retryable: rotated.retryable };
  return rotated;
}

/** One-line operator remedy for a failed renewal. */
export function refreshFailureAdvice(failure: { message: string; retryable: boolean }): string {
  return failure.retryable
    ? `Could not renew your YoloBridge login (${failure.message}). Check your connection and try again.`
    : `Your YoloBridge login could not be renewed (${failure.message}). Run \`yolo-bridge login\` again.`;
}
