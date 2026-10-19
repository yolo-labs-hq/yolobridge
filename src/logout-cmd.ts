/**
 * `yolo-bridge logout` — revoke this machine's login at auth-service, then
 * delete `~/.config/yolobridge/auth.json`.
 *
 * Revoking matters since 0.33.0: `auth.json` now holds a rolling 30-day
 * refresh token (docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md D8), so deleting the
 * file alone would leave a credential that keeps renewing anywhere a copy of
 * it exists — including in the memory of a running attach daemon.
 *
 * Order is revoke THEN delete. If the revocation cannot reach auth-service the
 * file is kept, so the operator can simply run `logout` again; deleting it
 * first would leave a still-live login with nothing on this machine able to
 * revoke it.
 *
 * Does not touch `attachment.json`: the workspace attachment runs on its own
 * workspace-scoped credential and is ended with `yolo-bridge detach`, which
 * needs that record to authenticate.
 */

import { ensureFreshAccountAuth, defaultAuthBaseUrl, rotateAccountAuth, type RefreshTokenFn } from './account-auth.js';
import { logoutSession, type FetchImpl, type LogoutResult } from './device-auth.js';
import { clearAuth, loadAttachment, loadAuth, type ConfigStoreIO } from './config-store.js';

export interface LogoutDeps {
  authBaseUrl?: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
  now?: () => number;
  refreshAccessToken?: RefreshTokenFn;
  /** Injectable auth-service logout call. Defaults to device-auth.ts's. */
  logoutSession?: (authBaseUrl: string, accessToken: string, fetchImpl?: FetchImpl) => Promise<LogoutResult>;
}

export type LogoutCmdResult =
  | {
      ok: true;
      /**
       * - `revoked`          — auth-service ended the sign-in; file deleted.
       * - `already-revoked`  — auth-service REFUSED the refresh token (401/403
       *                        from `/refresh`), i.e. its own verdict that the
       *                        login is dead; file deleted.
       * - `local-only`       — the file had no refresh token and an expired
       *                        access token, so nothing on THIS machine could
       *                        present the sign-in; file deleted, nothing revoked.
       * - `not-logged-in`    — there was no `auth.json`.
       */
      outcome: 'revoked' | 'already-revoked' | 'local-only' | 'not-logged-in';
      /** Set when this machine is still attached — logout does not detach. */
      attachedWorkspaceId?: string;
    }
  /** `auth.json` is KEPT. `retryable` is false when retrying cannot help. */
  | { ok: false; reason: 'revoke-failed'; message: string; retryable: boolean };

type Outcome = Extract<LogoutCmdResult, { ok: true }>['outcome'];

export async function runLogout(deps: LogoutDeps = {}): Promise<LogoutCmdResult> {
  const authBaseUrl = deps.authBaseUrl ?? defaultAuthBaseUrl(deps.env);
  const attachedWorkspaceId = loadAttachment(deps.env, deps.io)?.workspaceId;
  const done = (outcome: Outcome): LogoutCmdResult => {
    if (outcome !== 'not-logged-in') clearAuth(deps.env, deps.io);
    return { ok: true, outcome, ...(attachedWorkspaceId ? { attachedWorkspaceId } : {}) };
  };
  const keep = (message: string, retryable: boolean): LogoutCmdResult => ({ ok: false, reason: 'revoke-failed', message, retryable });
  const accountDeps = { ...deps, authBaseUrl };
  const revoke = deps.logoutSession ?? logoutSession;

  const stored = loadAuth(deps.env, deps.io);
  if (!stored) return done('not-logged-in');

  // `/logout` authenticates with the ACCESS token, so an expired one is renewed
  // first. The renewal continues the same lineage, which the logout then ends.
  const fresh = await ensureFreshAccountAuth(accountDeps);
  if (!fresh.ok) {
    if (fresh.reason === 'not-logged-in') return done('not-logged-in');
    if (!stored.refreshToken) return done('local-only');
    // Only auth-service refusing the refresh token proves the login is dead.
    // A 404 from a proxy or a garbled response proves nothing, so keep the
    // file rather than claim a logout that did not happen.
    return fresh.refused ? done('already-revoked') : keep(fresh.message, fresh.retryable);
  }

  let result = await revoke(authBaseUrl, fresh.auth.accessToken, deps.fetchImpl);
  if (result.status === 'unauthorized') {
    // The ACCESS token was rejected, but the sign-in may well be alive — this
    // 401 also covers clock skew, a lost session key and transient DB errors.
    // The refresh token is the durable credential, so ask it: a renewal that
    // succeeds gets a token to retry the logout with; one auth-service refuses
    // is the proof that nothing is left to revoke.
    if (!fresh.auth.refreshToken) return done('local-only');
    const renewed = await rotateAccountAuth(fresh.auth, accountDeps);
    if (!renewed.ok) return renewed.refused ? done('already-revoked') : keep(renewed.message, renewed.retryable);
    result = await revoke(authBaseUrl, renewed.auth.accessToken, deps.fetchImpl);
    if (result.status === 'unauthorized') {
      return keep(`auth-service rejected a freshly renewed token (${result.message})`, false);
    }
  }
  if (result.status === 'failed') return keep(result.message, result.retryable);
  return done('revoked');
}

export function formatLogout(result: Extract<LogoutCmdResult, { ok: true }>): string {
  const lines: string[] = [];
  switch (result.outcome) {
    case 'revoked':
      lines.push('Logged out. This machine\'s sign-in was revoked and its local credentials removed.');
      break;
    case 'already-revoked':
      lines.push('Logged out. The sign-in was already revoked; local credentials removed.');
      break;
    case 'local-only':
      lines.push(
        'Removed local credentials. They had expired and held no refresh token, so nothing could be '
          + 'revoked from this machine. To end every copy of an older login, use "Sign out everywhere" in the web app.',
      );
      break;
    case 'not-logged-in':
      lines.push('Not logged in.');
      break;
  }
  if (result.attachedWorkspaceId) {
    lines.push(
      `This machine is still attached to workspace ${result.attachedWorkspaceId}. `
        + 'Run `yolo-bridge detach` to end that session too.',
    );
  }
  return lines.join('\n');
}
