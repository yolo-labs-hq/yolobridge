import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runLogout, formatLogout, type LogoutDeps } from './logout-cmd.js';
import { loadAuth, saveAuth, saveAttachment, type ConfigStoreIO, type StoredAuth } from './config-store.js';
import type { LogoutResult } from './device-auth.js';

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

function deps(io: ConfigStoreIO, extra: Partial<LogoutDeps> = {}): LogoutDeps {
  return {
    env: ENV,
    io,
    authBaseUrl: 'https://auth.example.com',
    now: () => T0,
    refreshAccessToken: async () => { throw new Error('refresh must not be called'); },
    ...extra,
  };
}

describe('runLogout', () => {
  it('revokes the sign-in with the stored access token, THEN deletes auth.json', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const calls: Array<[string, string]> = [];
    const result = await runLogout(deps(io, {
      logoutSession: async (url, token) => {
        calls.push([url, token]);
        assert.ok(loadAuth(ENV, io), 'the file must still exist while the revocation is in flight');
        return { status: 'revoked' };
      },
    }));
    assert.deepEqual(result, { ok: true, outcome: 'revoked' });
    assert.deepEqual(calls, [['https://auth.example.com', 'at-1']]);
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('renews an EXPIRED access token first, since /logout needs a valid one', async () => {
    const io = fakeIO();
    saveAuth(stored({ expiresAtMs: T0 - 1 }), ENV, io);
    let presented: string | undefined;
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({
        status: 'ok',
        tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 86_400, expiresAtMs: T0 + 86_400_000 },
      }),
      logoutSession: async (_url, token) => { presented = token; return { status: 'revoked' }; },
    }));
    assert.deepEqual(result, { ok: true, outcome: 'revoked' });
    assert.equal(presented, 'at-2');
    assert.equal(loadAuth(ENV, io), undefined, 'the renewed pair must not survive the logout');
  });

  it('KEEPS auth.json when auth-service cannot be reached, so the operator can retry', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await runLogout(deps(io, {
      logoutSession: async (): Promise<LogoutResult> => ({ status: 'failed', message: 'fetch failed', retryable: true }),
    }));
    assert.deepEqual(result, { ok: false, reason: 'revoke-failed', message: 'fetch failed', retryable: true });
    assert.deepEqual(loadAuth(ENV, io), stored());
  });

  it('keeps auth.json when the pre-logout renewal hits a network error', async () => {
    const io = fakeIO();
    saveAuth(stored({ expiresAtMs: T0 - 1 }), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({ status: 'failed', message: 'fetch failed', retryable: true }),
      logoutSession: async () => { throw new Error('must not be called'); },
    }));
    assert.equal(result.ok, false);
    assert.ok(loadAuth(ENV, io));
  });

  it('a 401 from /logout is NOT proof of revocation: it renews and retries the logout once', async () => {
    // e.g. clock skew — the access token looked fresh locally but the server
    // rejected it — while the refresh lineage is still perfectly live.
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const presented: string[] = [];
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({
        status: 'ok',
        tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 86_400, expiresAtMs: T0 + 86_400_000 },
      }),
      logoutSession: async (_url, token) => {
        presented.push(token);
        return token === 'at-1' ? { status: 'unauthorized', message: 'Invalid token' } : { status: 'revoked' };
      },
    }));
    assert.deepEqual(result, { ok: true, outcome: 'revoked' });
    assert.deepEqual(presented, ['at-1', 'at-2']);
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('after a 401, only auth-service REFUSING the refresh token counts as already revoked', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({ status: 'failed', message: 'Refresh token revoked', refused: true }),
      logoutSession: async () => ({ status: 'unauthorized', message: 'Invalid token' }),
    }));
    assert.deepEqual(result, { ok: true, outcome: 'already-revoked' });
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('after a 401, a renewal that reaches no verdict KEEPS the file', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({ status: 'failed', message: 'fetch failed', retryable: true }),
      logoutSession: async () => ({ status: 'unauthorized', message: 'Invalid token' }),
    }));
    assert.deepEqual(result, { ok: false, reason: 'revoke-failed', message: 'fetch failed', retryable: true });
    assert.ok(loadAuth(ENV, io));
  });

  it('a renewed token that is STILL rejected keeps the file and says retrying will not help', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({
        status: 'ok',
        tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 86_400, expiresAtMs: T0 + 86_400_000 },
      }),
      logoutSession: async () => ({ status: 'unauthorized', message: 'Invalid token' }),
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.retryable, false);
    assert.ok(loadAuth(ENV, io));
  });

  it('an expired token whose renewal is REFUSED counts as already revoked', async () => {
    const io = fakeIO();
    saveAuth(stored({ expiresAtMs: T0 - 1 }), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({ status: 'failed', message: 'Refresh token revoked', refused: true }),
      logoutSession: async () => { throw new Error('must not be called'); },
    }));
    assert.deepEqual(result, { ok: true, outcome: 'already-revoked' });
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('a non-refusal renewal failure (proxy 404, garbled 200) keeps the file instead of claiming a logout', async () => {
    const io = fakeIO();
    saveAuth(stored({ expiresAtMs: T0 - 1 }), ENV, io);
    const result = await runLogout(deps(io, {
      refreshAccessToken: async () => ({ status: 'failed', message: 'refresh failed: 404' }),
      logoutSession: async () => { throw new Error('must not be called'); },
    }));
    assert.equal(result.ok, false);
    assert.ok(loadAuth(ENV, io));
  });

  it('a permanent /logout failure (4xx) is reported as not worth retrying', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    const result = await runLogout(deps(io, {
      logoutSession: async () => ({ status: 'failed', message: 'logout-needs-session', retryable: false }),
    }));
    assert.deepEqual(result, { ok: false, reason: 'revoke-failed', message: 'logout-needs-session', retryable: false });
    assert.ok(loadAuth(ENV, io));
  });

  it('with an expired token and no refresh token, removes the file locally and points at Sign out everywhere', async () => {
    const io = fakeIO();
    saveAuth(stored({ expiresAtMs: T0 - 1, refreshToken: undefined }), ENV, io);
    const result = await runLogout(deps(io, { logoutSession: async () => { throw new Error('must not be called'); } }));
    assert.deepEqual(result, { ok: true, outcome: 'local-only' });
    assert.equal(loadAuth(ENV, io), undefined);
    assert.match(formatLogout(result as Extract<typeof result, { ok: true }>), /Sign out everywhere/);
  });

  it('is a no-op success when not logged in', async () => {
    const result = await runLogout(deps(fakeIO(), { logoutSession: async () => { throw new Error('must not be called'); } }));
    assert.deepEqual(result, { ok: true, outcome: 'not-logged-in' });
  });

  it('leaves the attachment alone and tells the operator it is still attached', async () => {
    const io = fakeIO();
    saveAuth(stored(), ENV, io);
    saveAttachment(
      { workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x', scopedToken: 's', scopedTokenExpiresAtMs: T0 + 1 },
      ENV,
      io,
    );
    const result = await runLogout(deps(io, { logoutSession: async () => ({ status: 'revoked' }) }));
    assert.deepEqual(result, { ok: true, outcome: 'revoked', attachedWorkspaceId: 'w1' });
    assert.ok([...io.files.keys()].some((k) => k.endsWith('attachment.json')), '`detach` still needs this record');
    assert.match(formatLogout(result as Extract<typeof result, { ok: true }>), /yolo-bridge detach/);
  });
});
