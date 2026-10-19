import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canAutoRenew, ensureFreshAccountAuth, refreshFailureAdvice, type RefreshTokenFn } from './account-auth.js';
import { loadAuth, saveAuth, type ConfigStoreIO, type StoredAuth } from './config-store.js';

const ENV = { HOME: '/home/yolo' };
const T0 = 1_800_000_000_000;

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => { files.set(p, contents); },
    removeFile: (p) => { files.delete(p); },
  };
}

function stored(overrides: Partial<StoredAuth> = {}): StoredAuth {
  return { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAtMs: T0 + 3600_000, ...overrides };
}

const jwtFor = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;

const neverRefresh: RefreshTokenFn = async () => {
  throw new Error('refresh must not be called');
};

describe('ensureFreshAccountAuth', () => {
  it('reports not-logged-in when there is no auth.json', async () => {
    const result = await ensureFreshAccountAuth({ env: ENV, io: fakeIO(), refreshAccessToken: neverRefresh });
    assert.deepEqual(result, { ok: false, reason: 'not-logged-in' });
  });

  it('returns the stored token untouched while it is still valid', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await ensureFreshAccountAuth({ env: ENV, io, now: () => T0, refreshAccessToken: neverRefresh });
    assert.deepEqual(result, { ok: true, auth: stored() });
  });

  it('renews an expired token and persists the ROTATED pair, refresh token included', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const calls: Array<[string, string]> = [];
    const refreshAccessToken: RefreshTokenFn = async (url, rt) => {
      calls.push([url, rt]);
      return { status: 'ok', tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 86_400, expiresAtMs: T0 + 86_400_000 } };
    };
    const result = await ensureFreshAccountAuth({
      env: ENV,
      io,
      now: () => T0 + 2 * 3600_000,
      authBaseUrl: 'https://auth.example.com',
      refreshAccessToken,
    });
    const renewed = { accessToken: 'at-2', refreshToken: 'rt-2', tokenType: 'Bearer', expiresAtMs: T0 + 86_400_000 };
    assert.deepEqual(result, { ok: true, auth: renewed });
    assert.deepEqual(calls, [['https://auth.example.com', 'rt-1']]);
    assert.deepEqual(loadAuth(ENV, io), renewed);
  });

  it('renews inside the buffer, before the token actually expires', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    let called = false;
    const refreshAccessToken: RefreshTokenFn = async () => {
      called = true;
      return { status: 'ok', tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 1, expiresAtMs: T0 + 86_400_000 } };
    };
    await ensureFreshAccountAuth({ env: ENV, io, now: () => T0 + 3600_000 - 60_000, refreshAccessToken });
    assert.equal(called, true);
  });

  it('cannot renew without a stored refresh token, and says so without calling auth-service', async () => {
    const io = fakeIO();
    saveAuth(stored({ refreshToken: undefined }), ENV, io);
    const result = await ensureFreshAccountAuth({ env: ENV, io, now: () => T0 + 2 * 3600_000, refreshAccessToken: neverRefresh });
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === 'refresh-failed') assert.equal(result.retryable, false);
    else assert.fail('expected refresh-failed');
  });

  it('does not overwrite a NEWER login, or another account\'s, that landed during the rotation', async () => {
    for (const intruder of [
      stored({ accessToken: jwtFor('u1'), refreshToken: 'newer-rt', expiresAtMs: T0 + 2 * 86_400_000 }),
      stored({ accessToken: jwtFor('u2'), refreshToken: 'other-rt', expiresAtMs: T0 }),
    ]) {
      const io = fakeIO();
      saveAuth(stored({ accessToken: jwtFor('u1') }), ENV, io);
      const refreshAccessToken: RefreshTokenFn = async () => {
        saveAuth(intruder, ENV, io);
        return { status: 'ok', tokens: { accessToken: jwtFor('u1'), refreshToken: 'rt-2', expiresInSec: 1, expiresAtMs: T0 + 86_400_000 } };
      };
      const result = await ensureFreshAccountAuth({ env: ENV, io, now: () => T0 + 2 * 3600_000, refreshAccessToken });
      assert.equal(result.ok && result.auth.refreshToken, 'rt-2', 'the caller still gets a usable token');
      assert.equal(loadAuth(ENV, io)?.refreshToken, intruder.refreshToken);
    }
  });

  it('DOES overwrite an older same-account pair from a concurrent rotation it lost', async () => {
    // Otherwise a long-running daemon that lost one race would never persist
    // again, and its login would lapse with the stale copy on disk.
    const io = fakeIO();
    saveAuth(stored({ accessToken: jwtFor('u1') }), ENV, io);
    const refreshAccessToken: RefreshTokenFn = async () => {
      saveAuth(stored({ accessToken: jwtFor('u1'), refreshToken: 'race-rt', expiresAtMs: T0 + 3_600_000 * 20 }), ENV, io);
      return { status: 'ok', tokens: { accessToken: jwtFor('u1'), refreshToken: 'rt-2', expiresInSec: 1, expiresAtMs: T0 + 86_400_000 } };
    };
    await ensureFreshAccountAuth({ env: ENV, io, now: () => T0 + 2 * 3600_000, refreshAccessToken });
    assert.equal(loadAuth(ENV, io)?.refreshToken, 'rt-2');
  });

  it('keeps the stored login on a RETRYABLE failure', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await ensureFreshAccountAuth({
      env: ENV,
      io,
      now: () => T0 + 2 * 3600_000,
      refreshAccessToken: async () => ({ status: 'failed', message: 'fetch failed', retryable: true }),
    });
    assert.deepEqual(result, { ok: false, reason: 'refresh-failed', message: 'fetch failed', retryable: true });
    assert.deepEqual(loadAuth(ENV, io), stored());
  });
});

describe('refreshFailureAdvice', () => {
  it('sends a refused login back to `yolo-bridge login`, but not a network blip', () => {
    assert.match(refreshFailureAdvice({ message: 'Refresh token revoked', retryable: false }), /yolo-bridge login/);
    assert.doesNotMatch(refreshFailureAdvice({ message: 'fetch failed', retryable: true }), /yolo-bridge login/);
  });
});

describe('canAutoRenew', () => {
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  it('is false without a refresh token, or once its own expiry has passed', () => {
    assert.equal(canAutoRenew(stored({ refreshToken: undefined }), T0), false);
    assert.equal(canAutoRenew(stored({ refreshToken: jwt({ exp: T0 / 1000 - 1 }) }), T0), false);
    assert.equal(canAutoRenew(stored({ refreshToken: jwt({ exp: T0 / 1000 + 60 }) }), T0), true);
    assert.equal(canAutoRenew(stored({ refreshToken: 'opaque' }), T0), true, 'unknown expiry: let the server decide');
  });
});
