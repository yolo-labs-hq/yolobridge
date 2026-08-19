/**
 * `yolo-bridge login` — device-authorization flow against auth-service
 * (see device-auth.ts for the exact wire contract). Orchestration only;
 * the HTTP shapes live in device-auth.ts so they can be unit tested
 * independent of this polling loop.
 */

import { requestDeviceCode, pollDeviceToken, type FetchImpl } from './device-auth.js';
import { openBrowserBestEffort } from './browser-open.js';
import { saveAuth, type ConfigStoreIO } from './config-store.js';

export interface LoginDeps {
  authBaseUrl: string;
  fetchImpl?: FetchImpl;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  /** Injectable so tests don't sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so tests can assert on it instead of a real browser popping up. */
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
}

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'expired' | 'error'; message: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLogin(deps: LoginDeps): Promise<LoginResult> {
  const { authBaseUrl, fetchImpl, env, io } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const openBrowser = deps.openBrowser ?? openBrowserBestEffort;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const code = await requestDeviceCode(authBaseUrl, fetchImpl);

  log('To finish logging in, open this URL in your browser:');
  log(`  ${code.verificationUri}`);
  log('and enter this code when prompted:');
  log(`  ${code.userCode}`);
  log('');
  log('Waiting for approval...');
  openBrowser(code.verificationUri);

  const deadline = Date.now() + code.expiresInSec * 1000;
  const intervalMs = Math.max(1, code.intervalSec) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await pollDeviceToken(authBaseUrl, code.deviceCode, fetchImpl);
    if (poll.status === 'pending') continue;
    if (poll.status === 'denied') {
      return { ok: false, reason: 'denied', message: 'Login was denied.' };
    }
    if (poll.status === 'expired') {
      return { ok: false, reason: 'expired', message: 'Device code expired before login was completed.' };
    }
    if (poll.status === 'error') {
      return { ok: false, reason: 'error', message: poll.message };
    }
    saveAuth(
      {
        accessToken: poll.tokens.accessToken,
        refreshToken: poll.tokens.refreshToken,
        tokenType: poll.tokens.tokenType,
        expiresAtMs: poll.tokens.expiresAtMs,
      },
      env,
      io,
    );
    log('Logged in.');
    return { ok: true };
  }

  return { ok: false, reason: 'expired', message: 'Device code expired before login was completed.' };
}
