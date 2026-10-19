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

import { ensureFreshAccountAuth, defaultAuthBaseUrl, type RefreshTokenFn } from './account-auth.js';
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
       * - `already-revoked`  — auth-service had already refused it; file deleted.
       * - `local-only`       — nothing usable to present (expired access token,
       *                        no refresh token); file deleted, nothing revoked.
       * - `not-logged-in`    — there was no `auth.json`.
       */
      outcome: 'revoked' | 'already-revoked' | 'local-only' | 'not-logged-in';
      /** Set when this machine is still attached — logout does not detach. */
      attachedWorkspaceId?: string;
    }
  | { ok: false; reason: 'revoke-failed'; message: string };

export async function runLogout(deps: LogoutDeps = {}): Promise<LogoutCmdResult> {
  const authBaseUrl = deps.authBaseUrl ?? defaultAuthBaseUrl(deps.env);
  const attachedWorkspaceId = loadAttachment(deps.env, deps.io)?.workspaceId;
  const withAttachment = attachedWorkspaceId ? { attachedWorkspaceId } : {};

  const stored = loadAuth(deps.env, deps.io);
  if (!stored) return { ok: true, outcome: 'not-logged-in', ...withAttachment };

  // `/logout` authenticates with the ACCESS token, so an expired one is renewed
  // first. The renewal continues the same lineage, which the logout then ends.
  const fresh = await ensureFreshAccountAuth({ ...deps, authBaseUrl });
  if (!fresh.ok) {
    if (fresh.reason === 'not-logged-in') return { ok: true, outcome: 'not-logged-in', ...withAttachment };
    if (fresh.retryable) {
      return { ok: false, reason: 'revoke-failed', message: fresh.message };
    }
    // Refused outright, or there was never a refresh token to renew with.
    clearAuth(deps.env, deps.io);
    return { ok: true, outcome: stored.refreshToken ? 'already-revoked' : 'local-only', ...withAttachment };
  }

  const revoke = deps.logoutSession ?? logoutSession;
  const result = await revoke(authBaseUrl, fresh.auth.accessToken, deps.fetchImpl);
  if (result.status === 'failed') return { ok: false, reason: 'revoke-failed', message: result.message };
  clearAuth(deps.env, deps.io);
  return { ok: true, outcome: result.status === 'revoked' ? 'revoked' : 'already-revoked', ...withAttachment };
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
      lines.push('Removed local credentials. The stored login had expired, so there was nothing left to revoke.');
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
