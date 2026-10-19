import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { requestDeviceCode, pollDeviceToken, refreshAccessToken, logoutSession, DeviceAuthError, type FetchImpl } from './device-auth.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fetchStub(handler: (url: string, init?: RequestInit) => Response): FetchImpl {
  return (async (url: any, init?: any) => handler(String(url), init)) as FetchImpl;
}

describe('requestDeviceCode', () => {
  it('parses the real auth-service device/code shape', async () => {
    const fetchImpl = fetchStub((url) => {
      assert.equal(url, 'https://auth.example.com/api/v1/auth/device/code');
      return jsonResponse(200, {
        device_code: 'dc-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://app.example.com/device',
        verification_url: 'https://app.example.com/device',
        expires_in: 600,
        interval: 5,
      });
    });
    const result = await requestDeviceCode('https://auth.example.com', fetchImpl);
    assert.deepEqual(result, {
      deviceCode: 'dc-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://app.example.com/device',
      expiresInSec: 600,
      intervalSec: 5,
    });
  });

  it('strips a trailing slash on the base URL', async () => {
    const fetchImpl = fetchStub((url) => {
      assert.equal(url, 'https://auth.example.com/api/v1/auth/device/code');
      return jsonResponse(200, { device_code: 'd', user_code: 'u', verification_uri: 'x' });
    });
    await requestDeviceCode('https://auth.example.com/', fetchImpl);
  });

  it('throws on an unexpected 200 shape', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(200, { nope: true }));
    await assert.rejects(() => requestDeviceCode('https://auth.example.com', fetchImpl), DeviceAuthError);
  });

  it('throws with the server message on a non-200', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(500, { error: { message: 'boom', statusCode: 500 } }));
    await assert.rejects(() => requestDeviceCode('https://auth.example.com', fetchImpl), /boom/);
  });
});

describe('pollDeviceToken', () => {
  it('maps authorization_pending (400) to status: pending', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(400, { error: { message: 'authorization_pending', statusCode: 400 } }));
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.deepEqual(result, { status: 'pending' });
  });

  it('maps access_denied (403) to status: denied', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(403, { error: { message: 'access_denied', statusCode: 403 } }));
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.deepEqual(result, { status: 'denied' });
  });

  it('maps expired_token (400) to status: expired', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(400, { error: { message: 'expired_token', statusCode: 400 } }));
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.deepEqual(result, { status: 'expired' });
  });

  it('parses a real authorized 200 response into camelCase tokens', async () => {
    const fetchImpl = fetchStub((url, init) => {
      assert.equal(JSON.parse(String(init?.body)).device_code, 'dc-1');
      return jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: 1_700_000_000_000,
      });
    });
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.deepEqual(result, {
      status: 'authorized',
      tokens: {
        accessToken: 'at',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        expiresInSec: 3600,
        expiresAtMs: 1_700_000_000_000,
      },
    });
  });

  it('falls back to Date.now()-derived expiresAtMs when expires_at is absent', async () => {
    const before = Date.now();
    const fetchImpl = fetchStub(() =>
      jsonResponse(200, { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 100 }),
    );
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.equal(result.status, 'authorized');
    if (result.status === 'authorized') {
      assert.ok(result.tokens.expiresAtMs >= before + 100_000);
    }
  });

  it('surfaces an unrecognized error message as status: error', async () => {
    const fetchImpl = fetchStub(() => jsonResponse(404, { error: { message: 'Invalid device code', statusCode: 404 } }));
    const result = await pollDeviceToken('https://auth.example.com', 'dc-1', fetchImpl);
    assert.deepEqual(result, { status: 'error', message: 'Invalid device code' });
  });
});

describe('refreshAccessToken', () => {
  it('reports a network failure as a RETRYABLE outcome instead of throwing', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as FetchImpl;
    const result = await refreshAccessToken('https://auth.example.com', 'rt', fetchImpl);
    assert.deepEqual(result, { status: 'failed', message: 'fetch failed', retryable: true });
  });

  it('gives up on an auth-service that never answers, as a RETRYABLE failure', async () => {
    const fetchImpl = ((_url: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      })) as unknown as FetchImpl;
    // AbortSignal.timeout's timer is unref'd; a real hung request keeps the
    // process alive through its open socket, so stand in for that here.
    const keepAlive = setInterval(() => {}, 1000);
    const result = await refreshAccessToken('https://auth.example.com', 'rt', fetchImpl, 20).finally(() => clearInterval(keepAlive));
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') assert.equal(result.retryable, true);
  });

  it('treats a 5xx as retryable and a 401 as a refusal', async () => {
    const down = await refreshAccessToken('https://auth.example.com', 'rt', fetchStub(() => jsonResponse(503, { error: { message: 'unavailable' } })));
    assert.deepEqual(down, { status: 'failed', message: 'unavailable', retryable: true });
    const refused = await refreshAccessToken('https://auth.example.com', 'rt', fetchStub(() => jsonResponse(401, { error: { message: 'Refresh token revoked' } })));
    assert.deepEqual(refused, { status: 'failed', message: 'Refresh token revoked', retryable: false });
  });

  it('parses the rotated pair', async () => {
    const fetchImpl = fetchStub((url, init) => {
      assert.equal(url, 'https://auth.example.com/api/v1/auth/refresh');
      assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: 'rt-1' });
      return jsonResponse(200, { tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 86_400 } });
    });
    const result = await refreshAccessToken('https://auth.example.com/', 'rt-1', fetchImpl);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.tokens.refreshToken, 'rt-2');
      assert.equal(result.tokens.expiresInSec, 86_400);
    }
  });
});

describe('logoutSession', () => {
  it('POSTs /logout with the access token as Bearer', async () => {
    const fetchImpl = fetchStub((url, init) => {
      assert.equal(url, 'https://auth.example.com/api/v1/auth/logout');
      assert.equal(init?.method, 'POST');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer at-1');
      return jsonResponse(200, { message: 'Logged out successfully' });
    });
    assert.deepEqual(await logoutSession('https://auth.example.com/', 'at-1', fetchImpl), { status: 'revoked' });
  });

  it('separates a 401 (nothing left to revoke) from a failure worth retrying', async () => {
    const unauthorized = await logoutSession('https://a', 'at', fetchStub(() => jsonResponse(401, { error: { message: 'Token revoked' } })));
    assert.deepEqual(unauthorized, { status: 'unauthorized', message: 'Token revoked' });
    const down = await logoutSession('https://a', 'at', fetchStub(() => jsonResponse(503, {})));
    assert.deepEqual(down, { status: 'failed', message: 'logout failed: 503' });
    const offline = await logoutSession('https://a', 'at', (async () => { throw new TypeError('fetch failed'); }) as unknown as FetchImpl);
    assert.deepEqual(offline, { status: 'failed', message: 'fetch failed' });
  });
});
