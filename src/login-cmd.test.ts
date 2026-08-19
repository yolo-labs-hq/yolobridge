import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runLogin } from './login-cmd.js';
import { loadAuth, type ConfigStoreIO } from './config-store.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => { files.set(p, contents); },
    removeFile: (p) => { files.delete(p); },
  };
}

const ENV = { HOME: '/home/yolo' };
const noopSleep = async () => {};

describe('runLogin', () => {
  it('polls through authorization_pending then saves tokens on success', async () => {
    let pollCount = 0;
    const fetchImpl = (async (url: any) => {
      if (String(url).endsWith('/device/code')) {
        return jsonResponse(200, {
          device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://x/device', expires_in: 600, interval: 5,
        });
      }
      pollCount++;
      if (pollCount < 3) return jsonResponse(400, { error: { message: 'authorization_pending', statusCode: 400 } });
      return jsonResponse(200, {
        access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, expires_at: 999,
      });
    }) as any;

    const io = fakeIO();
    const opened: string[] = [];
    const logs: string[] = [];
    const result = await runLogin({
      authBaseUrl: 'https://auth.example.com',
      fetchImpl,
      env: ENV,
      io,
      sleep: noopSleep,
      openBrowser: (url) => opened.push(url),
      log: (line) => logs.push(line),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(pollCount, 3);
    assert.deepEqual(opened, ['https://x/device']);
    assert.deepEqual(loadAuth(ENV, io), { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 999 });
    assert.ok(logs.some((l) => l.includes('ABCD')));
  });

  it('returns denied without saving tokens', async () => {
    const fetchImpl = (async (url: any) => {
      if (String(url).endsWith('/device/code')) {
        return jsonResponse(200, { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://x/device', expires_in: 600, interval: 5 });
      }
      return jsonResponse(403, { error: { message: 'access_denied', statusCode: 403 } });
    }) as any;
    const io = fakeIO();
    const result = await runLogin({ authBaseUrl: 'https://auth.example.com', fetchImpl, env: ENV, io, sleep: noopSleep, openBrowser: () => {}, log: () => {} });
    assert.deepEqual(result, { ok: false, reason: 'denied', message: 'Login was denied.' });
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('returns expired once the device code deadline passes without approval', async () => {
    const fetchImpl = (async (url: any) => {
      if (String(url).endsWith('/device/code')) {
        // 1-second expiry, 1-second interval — the loop's `Date.now() <
        // deadline` check will fail on the very first iteration with our
        // noop sleep (no real time passes), so we simulate the passage of
        // time by returning `expired_token` on poll instead of relying on
        // wall clock.
        return jsonResponse(200, { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://x/device', expires_in: 600, interval: 5 });
      }
      return jsonResponse(400, { error: { message: 'expired_token', statusCode: 400 } });
    }) as any;
    const io = fakeIO();
    const result = await runLogin({ authBaseUrl: 'https://auth.example.com', fetchImpl, env: ENV, io, sleep: noopSleep, openBrowser: () => {}, log: () => {} });
    assert.deepEqual(result, { ok: false, reason: 'expired', message: 'Device code expired before login was completed.' });
  });
});
