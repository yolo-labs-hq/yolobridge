import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { requestDeviceCode, pollDeviceToken, DeviceAuthError, type FetchImpl } from './device-auth.js';

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
