/**
 * OAuth device-authorization flow client against auth-service
 * (`auth/src/routes/auth.routes.ts:145-146`, controller in
 * `auth/src/controllers/AuthController.ts` — `initiateDeviceFlow` /
 * `pollDeviceFlow`). Field names below were read directly off that
 * controller, not guessed or ported from yolomax (whose source is gone):
 *
 *   POST /api/v1/auth/device/code   → { device_code, user_code,
 *     verification_uri, verification_url, expires_in, interval }
 *   POST /api/v1/auth/device/token  body { device_code } →
 *     200 { access_token, refresh_token, token_type, expires_in, expires_at }
 *     4xx { error: { message, statusCode } } — `message` is one of
 *       'authorization_pending' | 'access_denied' | 'expired_token'
 *       | 'Invalid device code' | 'Invalid device code state'
 *
 * NOTE (was a discrepancy from docs/YOLOBRIDGE_PLAN.md, now resolved): the
 * `initiateDeviceFlow` controller returns a bare `verification_uri`
 * (`${FRONTEND_URL}/device`, no query string) — there is no code-prefill
 * parameter in the raw response, and no auth-service change was needed to
 * fix this. `webapp/app/device/page.tsx` already reads a `code` query
 * param and pre-fills its input from it (an existing convention this CLI
 * simply wasn't using yet). `login-cmd.ts` builds the pre-filled URL
 * client-side (`verificationUri` + `?code=<userCode>`) before opening the
 * browser — this module still hands back the bare `verificationUri`
 * unchanged; the prefill is entirely the caller's concern.
 */

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export interface DeviceTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresInSec: number;
  /** Epoch ms, as returned by the server (`Date.now() + expires_in * 1000`). */
  expiresAtMs: number;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'authorized'; tokens: DeviceTokens }
  | { status: 'error'; message: string };

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  /** Epoch ms — computed as `Date.now() + expires_in * 1000` (the /refresh
   * response, unlike device/token, carries no absolute expiry field). */
  expiresAtMs: number;
}

export type RefreshTokenResult =
  | { status: 'ok'; tokens: RefreshedTokens }
  /** `retryable`: the call never got a verdict (network error, 5xx, 429), so
   *  the refresh token may still be good and a later attempt can succeed.
   *  Absent/false means auth-service refused it. */
  | { status: 'failed'; message: string; retryable?: boolean };

export type FetchImpl = typeof fetch;

export class DeviceAuthError extends Error {}

const REFRESH_TIMEOUT_MS = 15_000;

function normalizeBase(authBaseUrl: string): string {
  return authBaseUrl.replace(/\/+$/, '');
}

export async function requestDeviceCode(
  authBaseUrl: string,
  fetchImpl: FetchImpl = fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchImpl(`${normalizeBase(authBaseUrl)}/api/v1/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await safeJson(res);
  if (!res.ok) {
    throw new DeviceAuthError(`device/code failed: ${res.status} ${extractErrorMessage(body)}`);
  }
  if (
    typeof body?.device_code !== 'string' ||
    typeof body?.user_code !== 'string' ||
    typeof body?.verification_uri !== 'string'
  ) {
    throw new DeviceAuthError('device/code returned an unexpected shape (missing device_code/user_code/verification_uri)');
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresInSec: typeof body.expires_in === 'number' ? body.expires_in : 600,
    intervalSec: typeof body.interval === 'number' ? body.interval : 5,
  };
}

export async function pollDeviceToken(
  authBaseUrl: string,
  deviceCode: string,
  fetchImpl: FetchImpl = fetch,
): Promise<PollResult> {
  const res = await fetchImpl(`${normalizeBase(authBaseUrl)}/api/v1/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const body = await safeJson(res);

  if (res.ok) {
    if (
      typeof body?.access_token !== 'string' ||
      typeof body?.refresh_token !== 'string' ||
      typeof body?.token_type !== 'string'
    ) {
      return { status: 'error', message: 'device/token returned 200 with an unexpected shape' };
    }
    const expiresInSec = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    const expiresAtMs = typeof body.expires_at === 'number' ? body.expires_at : Date.now() + expiresInSec * 1000;
    return {
      status: 'authorized',
      tokens: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        tokenType: body.token_type,
        expiresInSec,
        expiresAtMs,
      },
    };
  }

  const message = extractErrorMessage(body);
  if (message === 'authorization_pending') return { status: 'pending' };
  if (message === 'access_denied') return { status: 'denied' };
  if (message === 'expired_token') return { status: 'expired' };
  return { status: 'error', message: message || `device/token failed: ${res.status}` };
}

/**
 * `POST /api/v1/auth/refresh` — used to rotate the stored account token
 * before it expires (see account-auth.ts). Field names read
 * directly off `auth/src/controllers/AuthController.ts:995` (`refreshToken`)
 * and `auth/src/services/TokenService.ts`'s `TokenPair` interface — NOTE
 * this is a *different* shape from the device-flow endpoints above:
 *
 *   request  body { refresh_token }                              (snake_case)
 *   response 200  { tokens: { accessToken, refreshToken,
 *                             expiresIn } }                       (camelCase,
 *     no token_type, no absolute expiry — this route hands back the same
 *     `TokenPair` shape `res.json({ tokens })` serializes with no
 *     case-conversion middleware in front of it)
 *   4xx  { error: { message, statusCode } } — same errorHandler as the
 *     device-flow routes, so `extractErrorMessage` below is reused as-is.
 *
 * Unauthenticated (no `authenticate` middleware on this route) — the
 * refresh token in the body is the credential.
 */
export async function refreshAccessToken(
  authBaseUrl: string,
  refreshToken: string,
  fetchImpl: FetchImpl = fetch,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<RefreshTokenResult> {
  let res: Response;
  let body: any;
  try {
    res = await fetchImpl(`${normalizeBase(authBaseUrl)}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      // Bounded: the daemon renews from inside a live session, and an
      // auth-service that accepts the connection but never answers must not
      // pin that renewal (and the MCP mints waiting on it) for minutes.
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await safeJson(res);
  } catch (err) {
    // A network failure is not a verdict on the token. Reported as an outcome
    // rather than thrown so callers on the daemon's heartbeat path can retry
    // instead of unwinding the whole attach loop.
    return { status: 'failed', message: err instanceof Error ? err.message : String(err), retryable: true };
  }
  if (!res.ok) {
    return {
      status: 'failed',
      message: extractErrorMessage(body) || `refresh failed: ${res.status}`,
      retryable: res.status >= 500 || res.status === 429,
    };
  }
  const tokens = body?.tokens;
  if (
    typeof tokens?.accessToken !== 'string' ||
    typeof tokens?.refreshToken !== 'string' ||
    typeof tokens?.expiresIn !== 'number'
  ) {
    return { status: 'failed', message: 'refresh returned an unexpected shape (missing tokens.accessToken/refreshToken/expiresIn)' };
  }
  return {
    status: 'ok',
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSec: tokens.expiresIn,
      expiresAtMs: Date.now() + tokens.expiresIn * 1000,
    },
  };
}

export type LogoutResult =
  | { status: 'revoked' }
  /** 401: auth-service no longer accepts this access token (already signed
   *  out, or expired). Nothing is left for it to revoke. */
  | { status: 'unauthorized'; message: string }
  | { status: 'failed'; message: string };

/**
 * `POST /api/v1/auth/logout` — ends the sign-in this access token belongs to
 * (`AuthController.logout`). auth-service revokes the session's whole LINEAGE,
 * so every refresh token rotated from the original device login dies with it,
 * including one a running daemon holds in memory. Only that one sign-in: the
 * browser and workspace pods keep theirs (`/logout-all` is the account-wide
 * route, deliberately not used here).
 */
export async function logoutSession(
  authBaseUrl: string,
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
  timeoutMs: number = REFRESH_TIMEOUT_MS,
): Promise<LogoutResult> {
  let res: Response;
  let body: any;
  try {
    res = await fetchImpl(`${normalizeBase(authBaseUrl)}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await safeJson(res);
  } catch (err) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) return { status: 'revoked' };
  const message = extractErrorMessage(body) || `logout failed: ${res.status}`;
  if (res.status === 401) return { status: 'unauthorized', message };
  return { status: 'failed', message };
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** auth-service's errorHandler shape is `{ error: { message, statusCode } }`. */
function extractErrorMessage(body: any): string {
  if (typeof body?.error?.message === 'string') return body.error.message;
  if (typeof body?.error === 'string') return body.error;
  return '';
}
