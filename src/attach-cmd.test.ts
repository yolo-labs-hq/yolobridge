import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runAttachDaemon, runAttachFromDisk, pickWorkspaceFromDisk, type RefreshTokenFn } from './attach-cmd.js';
import {
  loadAttachment,
  loadAuth,
  saveAuth,
  saveAttachment,
  type ConfigStoreIO,
  type StoredAuth,
} from './config-store.js';
import { getStatus, formatStatus } from './status-cmd.js';
import { loadConnectionState, type ConnectionEvent } from './connection-state.js';
import type { TimerImpl } from './heartbeat.js';

const ENV = { HOME: '/home/yolo' };
const AUTH: StoredAuth = { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 3600_000 };

/**
 * The attach response every fake server in this file returns.
 *
 * Card 09 made the workspace-scoped credential MANDATORY on both sides:
 * `api-client.attach` refuses a response without it, and the server's daemon
 * routes refuse a request without one. A fixture that omitted it would be
 * testing a shape the real system can no longer produce. The expiry is far
 * enough out that the 75%-of-lifetime renewal never fires inside a test that
 * isn't specifically driving a clock.
 */
const ATTACH_OK = {
  tileId: 'tile-1',
  attachmentId: 'a1',
  scopedToken: 'scoped-tok-1',
  scopedTokenExpiresAt: 4_102_444_800_000,
};

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => { files.set(p, contents); },
    removeFile: (p) => { files.delete(p); },
  };
}

function sseStreamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Like sseStreamResponse but deliberately never closes — mimics the real
 * server, which holds the SSE connection open indefinitely (keepalive
 * pings only). Used to prove the daemon doesn't rely on the stream ending
 * on its own to notice a stop signal / refresh failure. */
function neverEndingSseStreamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      // no close() — stream stays open forever, like the real one does.
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** Like sseStreamResponse but enqueues each byte chunk SEPARATELY instead of
 * as one blob — lets a test control exactly where the network "cuts" the
 * stream, including deliberately mid-multibyte-character, which a single
 * enqueue() can never reproduce. */
function sseStreamResponseChunked(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Fake TimerImpl that captures interval callbacks so tests can invoke
 * them synchronously instead of waiting on a real clock (same pattern as
 * heartbeat.test.ts's fakeTimers — attach-cmd.ts's stop-poll interval and
 * heartbeat both take this same injected TimerImpl). */
function fakeTimers(): TimerImpl & { tick(times?: number): void; intervals: Array<{ fn: () => void; ms: number }> } {
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const entry = { fn, ms };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle) {
      const idx = intervals.indexOf(handle as { fn: () => void; ms: number });
      if (idx >= 0) intervals.splice(idx, 1);
    },
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const entry of [...intervals]) entry.fn();
      }
    },
  };
}

/** Polls `cond` with short real waits (never a multi-second sleep) purely
 * to let already-scheduled microtasks/I/O callbacks in the daemon under
 * test settle before the test drives its next step — not exercising any
 * of the daemon's own sleep/backoff/reconnect timing. */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)),
  ]);
}

describe('runAttachDaemon', () => {
  it('presents the SCOPED credential on every post-attach call, and the ACCOUNT token only on attach', async () => {
    // The whole point of the chain: after attach, a stolen laptop's credential
    // reaches one workspace's YoloBridge surface, not the whole account.
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: read-output\ndata: {"attachmentId":"a1","requestId":"r1"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    const seen: Array<{ path: string; auth: string }> = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      seen.push({ path: u.replace('https://api.example.com', ''), auth: String(init?.headers?.Authorization ?? '') });
      if (u.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1',
          attachmentId: 'a1',
          scopedToken: 'scoped-tok-1',
          scopedTokenExpiresAt: Date.now() + 3600_000,
        });
      }
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      captureOutput: async () => ({ output: 'screen', busy: false }),
    });
    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });

    // attach is the call that CREATES the scope, so it must run as the account.
    const attachCall = seen.find((r) => r.path.endsWith('/yolobridge/attach'));
    assert.equal(attachCall?.auth, 'Bearer at', 'attach must present the ACCOUNT token');

    // Everything afterwards must present the scoped one. Asserted on the header
    // actually sent, not on which variable the code referenced.
    const postAttach = seen.filter((r) => !r.path.endsWith('/yolobridge/attach'));
    assert.ok(postAttach.length >= 2, `expected post-attach calls, saw ${postAttach.length}`);
    for (const call of postAttach) {
      assert.equal(call.auth, 'Bearer scoped-tok-1', `${call.path} must present the SCOPED token, saw ${call.auth}`);
    }
  });

  it('KEEPS sending the scoped token after an ACCOUNT-token refresh (the shared-config trap)', async () => {
    // THE REGRESSION THIS CARD EXISTS TO PREVENT. `ensureFreshToken` rewrites the
    // account config IN PLACE on a ~24h cadence. If the scoped token were ever
    // assigned onto that same object, this tick would silently revert the daemon
    // to account-wide credentials with every other test still green.
    //
    // The refresh MUST happen after attach for this to test anything — an
    // expired-at-startup token refreshes before attach and never exercises the
    // trap. So: start with a healthy token, then advance the clock and tick the
    // heartbeat interval, exactly as the mid-stream-refresh test above does.
    const sse = 'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n';

    const heartbeatAuths: string[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const auth = String(init?.headers?.Authorization ?? '');
      if (u.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1', attachmentId: 'a1',
          scopedToken: 'scoped-tok-1', scopedTokenExpiresAt: 9_999_999_999_999,
        });
      }
      if (u.includes('/yolobridge/stream')) return neverEndingSseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) {
        // Heartbeats ride postEvent, not a /heartbeat path — capture by body type.
        try {
          if (JSON.parse(String(init?.body ?? '{}')).type === 'heartbeat') heartbeatAuths.push(auth);
        } catch { /* not JSON — not a heartbeat */ }
        return jsonResponse(200, { recorded: true });
      }
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    let clock = 1_000_000;
    const healthyAuth: StoredAuth = {
      accessToken: 'account-at-1', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAtMs: clock + 3600_000,
    };
    let refreshes = 0;
    const refreshAccessToken: RefreshTokenFn = async () => {
      refreshes++;
      return {
        status: 'ok',
        tokens: { accessToken: 'account-at-2', refreshToken: 'rt-2', expiresInSec: 3600, expiresAtMs: clock + 7200_000 },
      };
    };

    let stopFlag = false;
    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      authBaseUrl: 'https://auth.example.com',
      auth: healthyAuth,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      now: () => clock,
      refreshAccessToken,
      timers,
      shouldStop: () => stopFlag,
    });

    await waitUntil(() => timers.intervals.length >= 2);
    assert.equal(refreshes, 0, 'sanity: no refresh should have happened before attach');

    clock += 3600_000; // now inside the refresh buffer, so the next tick rotates the ACCOUNT token
    for (let i = 0; i < 20; i++) {
      timers.tick(1);
      await new Promise((r) => setTimeout(r, 5));
    }

    stopFlag = true;
    timers.tick(1);
    await withTimeout(resultPromise, 2000, 'runAttachDaemon after post-attach account refresh');

    // Both halves matter. Without the first, the loop below is vacuous.
    assert.ok(refreshes > 0, 'the ACCOUNT token must actually have been refreshed after attach');
    assert.ok(heartbeatAuths.length > 0, 'at least one heartbeat must have fired after the refresh');
    for (const auth of heartbeatAuths) {
      assert.equal(auth, 'Bearer scoped-tok-1',
        `a heartbeat after an account-token refresh must still carry the SCOPED token, saw ${auth}`);
    }
  });

  it('FAILS the attach when the server issues no scoped credential, instead of degrading to the account token', async () => {
    // Card 09, D6 — no backwards support. This used to degrade and run the
    // whole session on the account token. Boundary B refuses that token on
    // every post-attach route, so continuing would buy the daemon nothing but
    // a 403 on its first heartbeat, with no diagnosis anywhere. It stops here,
    // while the operator is still watching the terminal.
    const authsSeen: string[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      authsSeen.push(String(init?.headers?.Authorization ?? ''));
      if (u.endsWith('/yolobridge/attach')) {
        // A response with no scopedToken/scopedTokenExpiresAt at all.
        return jsonResponse(201, { tileId: 'tile-1', attachmentId: 'a1' });
      }
      throw new Error(`must not reach ${u} without a scoped credential`);
    }) as any;

    const events: ConnectionEvent[] = [];
    const io = fakeIO();
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      onConnectionEvent: (event) => events.push(event),
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'attach-failed');
      assert.match(result.message, /no workspace-scoped credential/i);
    }
    // It really did attempt the attach (and only the attach) — otherwise this
    // would pass just as well against a daemon that never made a request.
    assert.deepEqual(authsSeen, ['Bearer at'], `expected exactly one attach call, saw ${authsSeen.join(', ')}`);
    // Nothing was reported as a CONNECTION state: `degraded` there means the
    // link is struggling, and this session never had a link at all.
    assert.ok(!events.some((e) => e.state === 'degraded'), 'a credential failure is not a connection state');
  });

  it('attaches, delivers a prompt frame, and exits cleanly on a server-initiated detach', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: prompt\ndata: {"attachmentId":"a1","prompt":"hello there"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    const requests: string[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      requests.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const delivered: string[] = [];
    const logs: string[] = [];

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: (line) => logs.push(line),
      clearScreen: () => {},
      deliverPrompt: async (prompt) => { delivered.push(prompt); },
      captureOutput: async () => ({ output: 'unused', busy: false }),
      shouldStop: () => false,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(delivered, ['hello there']);
    assert.equal(loadAttachment(ENV, io), undefined, 'attachment record should be cleared after server-initiated detach');
    assert.ok(requests.some((r) => r.startsWith('POST') && r.includes('/yolobridge/attach')));
    assert.ok(requests.some((r) => r.includes('/yolobridge/stream?attachmentId=a1')));
  });

  it("does NOT clear the terminal on the SSE 'connected' frame -- clearScreen is handed to onAttached instead, for the caller to fire before spawning the agent (reverted design, Codex review, 2026-08-24)", async () => {
    // Original design cleared on 'connected', reasoning that the agent's
    // own PTY (started by cli.ts's onAttached, BEFORE this stream even
    // opens) would always render its first output later than that.
    // Codex correctly pointed out that assumption doesn't hold for a
    // fast-booting agent or a slow SSE connect -- clearing after the
    // agent has already painted wipes content it doesn't know to
    // repaint (the clear never goes through its PTY). runAttachDaemon
    // itself must never call clearScreen anymore; only onAttached's
    // caller decides when, deterministically, right before spawn.
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t2"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const calls: string[] = [];
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: (line) => calls.push(`log:${line}`),
      // 'connected' is now an out-of-band connection EVENT, not a log line
      // (see connection-state.ts) — same sanity signal, new channel.
      onConnectionEvent: (event) => calls.push(`conn:${event.state}`),
      clearScreen: () => calls.push('clear'),
      deliverPrompt: async () => {},
      captureOutput: async () => ({ output: 'unused', busy: false }),
      shouldStop: () => false,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.equal(calls.filter((c) => c === 'conn:connected').length, 2, 'sanity check: both connected frames were processed');
    assert.deepEqual(calls.filter((c) => c === 'clear'), [], 'runAttachDaemon must never call clearScreen itself');
  });

  it("hands a working clearScreen through to onAttached, which the caller can fire on its own schedule", async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const calls: string[] = [];
    await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => calls.push('clear'),
      deliverPrompt: async () => {},
      captureOutput: async () => ({ output: 'unused', busy: false }),
      shouldStop: () => false,
      onAttached: async ({ clearScreen }) => { clearScreen(); },
    });

    assert.deepEqual(calls, ['clear']);
  });

  it('calls onAttached exactly once, with the real tileId/attachmentId/accessToken/getAccessToken, before the stream ever opens', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    let onAttachedCalls = 0;
    let onAttachedInfo: unknown;
    let streamOpenedBeforeOnAttached = false;

    await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      deliverPrompt: async () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      shouldStop: () => false,
      onAttached: async (info) => {
        onAttachedCalls++;
        onAttachedInfo = info;
        if (calls.some((u) => u.includes('/yolobridge/stream'))) streamOpenedBeforeOnAttached = true;
      },
    });

    assert.equal(onAttachedCalls, 1);
    const { getAccessToken, clearScreen, ...rest } = onAttachedInfo as { getAccessToken: () => string; clearScreen: () => void; [k: string]: unknown };
    assert.deepEqual(rest, { tileId: 'tile-1', attachmentId: 'a1', workspaceId: 'w1', accessToken: 'at' });
    assert.equal(typeof getAccessToken, 'function');
    assert.equal(getAccessToken(), 'at', 'getAccessToken must read the CURRENT token, not just echo the snapshot');
    assert.equal(typeof clearScreen, 'function');
    assert.doesNotThrow(() => clearScreen());
    assert.equal(streamOpenedBeforeOnAttached, false, 'onAttached must fire before the SSE stream opens');
  });

  it('a throwing onAttached is logged and does not abort the attach', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const logs: string[] = [];
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: (line) => logs.push(line),
      clearScreen: () => {},
      deliverPrompt: async () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      shouldStop: () => false,
      onAttached: async () => { throw new Error('boom'); },
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.ok(logs.some((l) => l.includes('onAttached hook failed') && l.includes('boom')));
  });

  it('reassembles a multibyte UTF-8 character split across a network chunk boundary (Codex review, 2026-08-23)', async () => {
    // Regression guard: `chunk.toString('utf-8')` per chunk (the pre-fix
    // code) decodes each network chunk in isolation. If a multibyte UTF-8
    // character straddles a chunk boundary, each half decodes independently
    // to a replacement character (U+FFFD) on its own, corrupting the prompt
    // before it ever reaches JSON.parse. StringDecoder carries incomplete
    // trailing bytes over to the next write() call instead.
    const full =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: prompt\ndata: {"attachmentId":"a1","prompt":"say \u{1F680} now"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const bytes = new TextEncoder().encode(full);
    const marker = new TextEncoder().encode('\u{1F680}'); // the 4-byte rocket emoji

    let idx = -1;
    outer: for (let i = 0; i <= bytes.length - marker.length; i++) {
      for (let j = 0; j < marker.length; j++) {
        if (bytes[i + j] !== marker[j]) continue outer;
      }
      idx = i;
      break;
    }
    assert.ok(idx >= 0, 'sanity check: the emoji bytes must be findable in the encoded stream');
    const splitAt = idx + 2; // cut INSIDE the 4-byte sequence, not on its edge
    const chunk1 = bytes.slice(0, splitAt);
    const chunk2 = bytes.slice(splitAt);

    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponseChunked([chunk1, chunk2]);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const delivered: string[] = [];
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      deliverPrompt: async (prompt) => { delivered.push(prompt); },
      captureOutput: async () => ({ output: 'unused', busy: false }),
      shouldStop: () => false,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(delivered, ['say \u{1F680} now']);
  });

  it("treats a 404 from openStream as a terminal detach, not a retry-forever transient error (Codex review, 2026-08-24, round 4)", async () => {
    // Reproduces: attach succeeds and creates the tile/attachment, but by
    // the time this attempt calls GET .../stream, the attachment/workspace
    // no longer exists server-side (e.g. removed during onAttached's own
    // MCP-setup delay, which runs BEFORE the first openStream call).
    // Without the fix, this 404 fell into the SAME backoff-and-retry path
    // as a transient network error and looped forever, leaving whatever
    // onAttached already started (a spawned local agent, in cli.ts)
    // running with no way for the daemon to ever end on its own.
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return jsonResponse(404, { error: 'Attachment not found', code: 'NOT_FOUND' });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const result = await withTimeout(
      runAttachDaemon({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        auth: AUTH,
        env: ENV,
        io,
        fetchImpl,
        log: () => {},
        clearScreen: () => {},
        shouldStop: () => false,
      }),
      2000,
      'runAttachDaemon after a 404 from openStream',
    );

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.equal(loadAttachment(ENV, io), undefined, 'attachment record should be cleared, same as a real detached frame');
  });

  it('returns attach-failed without opening a stream when attach itself fails', async () => {
    const fetchImpl = (async (url: any) => {
      if (String(url).endsWith('/yolobridge/attach')) {
        return jsonResponse(403, { error: 'Workspace access denied', code: 'FORBIDDEN' });
      }
      throw new Error('should not reach the stream endpoint');
    }) as any;

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'attach-failed');
      assert.match(result.message, /Workspace access denied/);
    }
  });

  it('cleans up (server detach + local attachment.json) if a stop was already requested by the time attach succeeds, without ever opening a stream (Codex-found race)', async () => {
    // Reproduces: the local agent process this daemon spawns exits almost
    // immediately (or Ctrl+C lands) WHILE the initial refresh/attach network
    // round trip is still in flight. The caller's own onExit-triggered
    // detach runs too early — before this attachment exists anywhere — and
    // finds nothing to clean up. Without the fix, `apiClient.attach` still
    // creates the server-side attachment + tile, the `while
    // (!shouldStop())` loop exits on its first check having never opened a
    // stream, and the attachment just created is a permanent orphan.
    const requests: string[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${u}`);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (method === 'DELETE' && u.includes('/yolobridge/attach/a1')) return new Response(null, { status: 204 });
      if (u.includes('/yolobridge/stream')) throw new Error('must not open a stream once already stopped');
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      shouldStop: () => true, // already asked to stop before attach even started
    });

    assert.deepEqual(result, { ok: true, reason: 'stopped' });
    assert.ok(
      requests.some((r) => r.startsWith('DELETE') && r.includes('/yolobridge/attach/a1')),
      'must call server-side detach for the attachment it just created',
    );
    assert.equal(loadAttachment(ENV, io), undefined, 'local attachment.json must be cleared, not left orphaned');
  });

  it('does NOT invoke onAttached at all once a stop is already pending by the time the attach round trip completes (Codex review, 2026-08-24, round 25)', async () => {
    // `onAttached` can spend a real delay (minting MCP credentials,
    // starting a local proxy) -- checking `shouldStop()` only AFTER it runs
    // (the pre-round-25 behavior) still pays that whole cost for an
    // attachment already guaranteed to be torn down the moment it
    // returns, making a Ctrl+C that lands while the initial attach
    // request is still in flight feel like it did nothing for however
    // long that setup takes.
    let stopRequested = false;
    let onAttachedCalls = 0;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/yolobridge/attach')) {
        // Simulates Ctrl+C landing WHILE this exact request was in flight —
        // shouldStop() only starts reporting true once it resolves.
        stopRequested = true;
        return jsonResponse(201, ATTACH_OK);
      }
      if (method === 'DELETE' && u.includes('/yolobridge/attach/a1')) return new Response(null, { status: 204 });
      if (u.includes('/yolobridge/stream')) throw new Error('must not open a stream once already stopped');
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      shouldStop: () => stopRequested,
      onAttached: async () => { onAttachedCalls++; },
    });

    assert.deepEqual(result, { ok: true, reason: 'stopped' });
    assert.equal(onAttachedCalls, 0, 'onAttached must never run once a stop is already pending — not merely be interrupted mid-way through');
    assert.equal(loadAttachment(ENV, io), undefined, 'local attachment.json must still be cleared');
  });

  it('does NOT clear local attachment.json when the cleanup detach itself genuinely fails (Codex review, 2026-08-24, round 26)', async () => {
    // `apiClient.detach` already treats a 404 as success (idempotent), so
    // a THROW here means a genuine failure (network error, 5xx) -- the
    // server-side attachment is very likely still recorded. Clearing
    // attachment.json anyway would strand it: neither cli.ts's own
    // post-return retry (`if (stopRequested && !localAgentExited) { await
    // runDetach(...) }`) nor a manual `yolo-bridge detach` could find
    // anything to retry against, and the next `attach` would create a
    // SECOND server-side attachment/tile instead of ever cleaning up the
    // orphaned first one.
    let stopRequested = false;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/yolobridge/attach')) {
        stopRequested = true;
        return jsonResponse(201, ATTACH_OK);
      }
      if (method === 'DELETE' && u.includes('/yolobridge/attach/a1')) return new Response('boom', { status: 500 });
      if (u.includes('/yolobridge/stream')) throw new Error('must not open a stream once already stopped');
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      shouldStop: () => stopRequested,
    });

    assert.deepEqual(result, { ok: true, reason: 'stopped' });
    const stored = loadAttachment(ENV, io);
    assert.ok(stored, 'attachment.json must survive a failed cleanup detach so a later retry can find it');
    assert.equal(stored?.workspaceId, 'w1');
    assert.equal(stored?.tileId, 'tile-1');
    assert.equal(stored?.attachmentId, 'a1');
  });

  it('answers a read-output frame by posting a read-output-reply with the stub capture', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: read-output\ndata: {"attachmentId":"a1","requestId":"req-1"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    let replyBody: any;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        if (parsed.type === 'read-output-reply') replyBody = parsed;
        return jsonResponse(200, { recorded: true, resolved: true });
      }
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      captureOutput: async () => ({ output: 'stub output', busy: true }),
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(replyBody, { attachmentId: 'a1', type: 'read-output-reply', requestId: 'req-1', output: 'stub output', busy: true });
  });

  it('a stop signal during an active never-ending stream forces prompt exit instead of hanging forever (Bug 1)', async () => {
    const sse = 'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return neverEndingSseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    let stop = false;

    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      shouldStop: () => stop,
      timers,
    });

    // Let the daemon reach the 'connected' frame — that's when both the
    // heartbeat interval and the stop-poll interval (Bug 1's fix) get
    // registered on the fake timer. The stream itself never closes, so
    // without the fix nothing below would ever unblock the daemon.
    await waitUntil(() => timers.intervals.length >= 2);

    stop = true;
    timers.tick(1); // fires the stop-poll callback, which must destroy() the stream

    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after stop signal');
    assert.deepEqual(result, { ok: true, reason: 'stopped' });
  });
});

describe('runAttachDaemon — connection state never enters the terminal output stream', () => {
  // Regression guard for the reported bug (2026-08-25): a brief, entirely
  // self-recovering connection drop garbled the Claude Code TUI. `attach`
  // spawns the local agent under a PTY whose output is piped to this
  // process's own `process.stdout` (local-agent.ts), and the daemon's
  // `log` defaults to that SAME stream — so `Stream error: …` /
  // `Reconnecting in 1000ms (attempt 1)...` were injected straight into a
  // frame the full-screen TUI believed it had drawn, and stayed corrupted
  // until it next happened to fully repaint.
  //
  // Anything a human would read as connection narration. The assertion is
  // deliberately on the SHAPE of the text rather than exact strings: the
  // bug is "human-readable connection status reaches the output stream at
  // all", so a reworded message must not be able to sneak past this.
  const CONNECTION_NARRATION =
    /stream (connected|error)|reconnect|disconnect|detached by server|heartbeat error|token refreshed|unrecognized frame/i;

  /** attach → one transient stream failure → a clean reconnect that then
   *  receives `detached`. Mirrors the report: the drop self-recovers. */
  function blipThenReconnectFetch(): { fetchImpl: any; streamCalls: () => number } {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    let streamCalls = 0;
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) {
        streamCalls += 1;
        // 502, not 404: a transient upstream blip, which is the case that
        // retries and recovers. (A 404 is the terminal "attachment is
        // gone" path, covered by its own test above.)
        if (streamCalls === 1) return jsonResponse(502, { error: 'Bad gateway' });
        return sseStreamResponse(sse);
      }
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;
    return { fetchImpl, streamCalls: () => streamCalls };
  }

  it('routes a drop + reconnect to the structured connection channel and writes nothing about it to the terminal', async () => {
    const { fetchImpl, streamCalls } = blipThenReconnectFetch();
    const logs: string[] = [];
    const events: ConnectionEvent[] = [];

    const result = await withTimeout(
      runAttachDaemon({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        auth: AUTH,
        env: ENV,
        io: fakeIO(),
        fetchImpl,
        log: (line) => logs.push(line),
        onConnectionEvent: (event) => events.push(event),
        clearScreen: () => {},
        deliverPrompt: async () => {},
        captureOutput: async () => ({ output: '', busy: false }),
        shouldStop: () => false,
        sleep: async () => {},
      }),
      2000,
      'runAttachDaemon across a transient stream drop',
    );

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.equal(streamCalls(), 2, 'sanity check: the daemon really did drop and reconnect');

    const offending = logs.filter((line) => CONNECTION_NARRATION.test(line));
    assert.deepEqual(
      offending,
      [],
      `connection state must never reach the output stream a TUI is rendering into, got: ${JSON.stringify(offending)}`,
    );

    // ...and it is NOT swallowed: the same information is there, structured.
    assert.deepEqual(
      events.map((e) => e.state),
      ['connecting', 'interrupted', 'reconnecting', 'connected', 'detached'],
    );
    const interrupted = events.find((e) => e.state === 'interrupted');
    assert.match(interrupted?.detail ?? '', /stream open failed/i);
    const reconnecting = events.find((e) => e.state === 'reconnecting');
    assert.equal(reconnecting?.attempt, 1);
    assert.equal(typeof reconnecting?.retryInMs, 'number');
    for (const event of events) {
      assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/, 'every connection event carries a timestamp');
    }
  });

  it('persists the drop through the DEFAULT channel (no injected sink) so `yolo-bridge status` can still report it', async () => {
    // The point of the fix is not "print less" — it is "print it somewhere
    // that is not the PTY". With nothing injected, the daemon must land the
    // same events in the on-disk record status-cmd.ts reads.
    const { fetchImpl } = blipThenReconnectFetch();
    const io = fakeIO();
    const logs: string[] = [];

    const result = await withTimeout(
      runAttachDaemon({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        auth: AUTH,
        env: ENV,
        io,
        fetchImpl,
        log: (line) => logs.push(line),
        clearScreen: () => {},
        deliverPrompt: async () => {},
        captureOutput: async () => ({ output: '', busy: false }),
        shouldStop: () => false,
        sleep: async () => {},
      }),
      2000,
      'runAttachDaemon across a transient stream drop (default connection channel)',
    );

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(logs.filter((line) => CONNECTION_NARRATION.test(line)), []);

    const stored = loadConnectionState(ENV, io);
    assert.ok(stored, 'the daemon must record connection state where the user can read it back');
    assert.equal(stored.attachmentId, 'a1');
    assert.equal(stored.current.state, 'detached');
    const history = stored.recent.map((e) => e.state);
    assert.deepEqual(history, ['connecting', 'interrupted', 'reconnecting', 'connected']);
  });
});

describe('runAttachDaemon — access-token refresh (Bug 2)', () => {
  it('proactively refreshes before expiry, updating both the in-memory client and the persisted auth.json', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    const authHeadersSeen: string[] = [];
    let attachAuth: string | undefined;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (auth) authHeadersSeen.push(auth);
      if (u.endsWith('/yolobridge/attach')) { attachAuth = auth; return jsonResponse(201, ATTACH_OK); }
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const almostExpiredAuth: StoredAuth = {
      accessToken: 'stale-at',
      refreshToken: 'rt-1',
      tokenType: 'Bearer',
      expiresAtMs: 1_000_000, // way in the "past" relative to the fixed clock below
    };
    const io = fakeIO();
    saveAuth(almostExpiredAuth, ENV, io);

    let refreshCalls = 0;
    const refreshAccessToken: RefreshTokenFn = async (authBaseUrl, refreshToken) => {
      refreshCalls++;
      assert.equal(authBaseUrl, 'https://auth.example.com');
      assert.equal(refreshToken, 'rt-1');
      return {
        status: 'ok',
        tokens: { accessToken: 'fresh-at', refreshToken: 'rt-2', expiresInSec: 3600, expiresAtMs: 1_000_000 + 3600_000 },
      };
    };

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      authBaseUrl: 'https://auth.example.com',
      auth: almostExpiredAuth,
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      now: () => 1_000_000,
      refreshAccessToken,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.equal(refreshCalls, 1, 'refresh should fire once before the stream was opened');
    // ATTACH — the one call that is still an account action — must present the
    // freshly rotated account token, never the stale one.
    assert.equal(attachAuth, 'Bearer fresh-at', `the attach call must use the rotated token, saw ${attachAuth}`);
    // Everything AFTER attach must present the workspace-scoped credential.
    // (This assertion used to read "every call uses fresh-at" and passed only
    // because the fixture returned no scoped token, i.e. it was silently
    // pinning the degrade path card 09 deleted.)
    const postAttach = authHeadersSeen.filter((h) => h !== attachAuth);
    assert.ok(postAttach.length > 0, 'sanity: there must BE post-attach calls to check');
    assert.ok(
      postAttach.every((h) => h === 'Bearer scoped-tok-1'),
      `every post-attach call must use the scoped credential, saw: ${postAttach.join(', ')}`,
    );
    assert.deepEqual(loadAuth(ENV, io), {
      accessToken: 'fresh-at',
      // The rotated REFRESH token is not written back: card 09 made
      // `persistAccountAuth`'s drop unconditional.
      tokenType: 'Bearer',
      expiresAtMs: 1_000_000 + 3600_000,
    });
  });

  it("onAttached's getAccessToken reflects a LATER mid-stream refresh, not just the token at attach time (Codex review, 2026-08-24)", async () => {
    // Regression guard: onAttached fires once, early, with a snapshot
    // `accessToken` — a caller (mcp-proxy.ts) that captured that string
    // directly instead of calling getAccessToken() on every use would 401
    // forever once this daemon's own proactive refresh rotated the token
    // out from under it. getAccessToken must read the CURRENT value.
    const sse = 'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return neverEndingSseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    let clock = 1_000_000;
    const freshAuth: StoredAuth = { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAtMs: clock + 3600_000 };
    const refreshAccessToken: RefreshTokenFn = async () => ({
      status: 'ok',
      tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresInSec: 3600, expiresAtMs: clock + 7200_000 },
    });

    let capturedGetAccessToken: (() => string) | undefined;
    let stopFlag = false;
    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: freshAuth,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      now: () => clock,
      refreshAccessToken,
      timers,
      shouldStop: () => stopFlag,
      onAttached: async ({ getAccessToken }) => { capturedGetAccessToken = getAccessToken; },
    });

    await waitUntil(() => capturedGetAccessToken !== undefined);
    assert.equal(capturedGetAccessToken!(), 'at-1', 'sanity check: reads the original token before any refresh');

    await waitUntil(() => timers.intervals.length >= 2);
    clock += 3600_000; // now within the refresh buffer of expiry
    for (let i = 0; i < 20; i++) {
      timers.tick(1);
      await new Promise((r) => setTimeout(r, 5));
    }

    assert.equal(capturedGetAccessToken!(), 'at-2', 'getAccessToken must reflect the refreshed token, not the attach-time snapshot');

    stopFlag = true;
    timers.tick(1); // fires the stop-poll callback, which must destroy() the stream
    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after mid-stream refresh + stop');
    assert.deepEqual(result, { ok: true, reason: 'stopped' });
  });

  it('does not refresh when the access token still has plenty of validity left', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    let refreshCalls = 0;
    const refreshAccessToken: RefreshTokenFn = async () => {
      refreshCalls++;
      return { status: 'ok', tokens: { accessToken: 'x', refreshToken: 'y', expiresInSec: 3600, expiresAtMs: 0 } };
    };

    const freshAuth: StoredAuth = { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1_000_000 };
    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: freshAuth,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      now: () => 1_000_000 - 3600_000, // an hour of validity left, buffer is 5 min
      refreshAccessToken,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.equal(refreshCalls, 0);
  });

  it('when the refresh itself fails, stops cleanly with an actionable message instead of looping on a dead token', async () => {
    const sse = 'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n';
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return neverEndingSseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    const logs: string[] = [];
    const refreshAccessToken: RefreshTokenFn = async () => ({
      status: 'failed',
      message: 'refresh_token_expired',
    });

    const almostExpiredAuth: StoredAuth = {
      accessToken: 'stale-at',
      refreshToken: 'dead-rt',
      tokenType: 'Bearer',
      expiresAtMs: 1_000_000,
    };

    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: almostExpiredAuth,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: (line) => logs.push(line),
      clearScreen: () => {},
      now: () => 1_000_000,
      refreshAccessToken,
      timers,
    });

    // The pre-stream refresh check fails immediately here (token is
    // already past the buffer at the fixed clock value), before any
    // stream is even opened, so no stop-poll ticking is needed for this
    // path — but the test still bounds the wait so a regression that
    // makes it spin/hang fails loudly instead of hanging the suite.
    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after refresh failure');

    assert.deepEqual(result, { ok: false, reason: 'refresh-failed', message: 'refresh_token_expired' });
    assert.ok(
      logs.some((l) => l.includes('refresh_token_expired')),
      `expected a log line surfacing the refresh failure, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((l) => l.includes('yolo-bridge login')),
      `expected an actionable "run yolo-bridge login again" log line, got: ${JSON.stringify(logs)}`,
    );
  });

  it('a refresh failure mid-stream does NOT stop the daemon any more — the scoped session outlives the account token', async () => {
    // THIS TEST'S ASSERTION IS DELIBERATELY THE INVERSE OF WHAT IT USED TO BE.
    // It once required a mid-stream account-refresh failure to end the daemon
    // with `refresh-failed`, and it passed for the wrong reason: its attach
    // fixture returned no scoped credential, so the daemon was on the DEGRADED
    // path, where the account token really was its only credential. Card 08
    // downgraded that failure to best-effort on the scoped path; card 09
    // deleted the degraded path outright, which is what finally exposed the
    // fixture. The full behaviour (heartbeats continuing on the scoped token,
    // the retry latching, nothing reported as `degraded`) is pinned against a
    // REAL config dir by the card-08 suite below; what is kept here is the one
    // fact this block is about — the daemon does not exit.
    const stream = controllableSseResponse('event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n');
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, ATTACH_OK);
      if (u.includes('/yolobridge/stream')) return stream.response;
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    let clock = 1_000_000;
    const freshAuth: StoredAuth = { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', expiresAtMs: clock + 3600_000 };
    let refreshAttempts = 0;
    const refreshAccessToken: RefreshTokenFn = async () => {
      refreshAttempts += 1;
      return { status: 'failed', message: 'invalid_grant' };
    };

    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: freshAuth,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      clearScreen: () => {},
      now: () => clock,
      refreshAccessToken,
      timers,
    });

    await waitUntil(() => timers.intervals.length >= 2); // connected: heartbeat + stop-poll
    clock += 3600_000; // now inside the refresh buffer — the rotation will be attempted and fail
    await tickUntil(timers, () => refreshAttempts > 0);
    assert.ok(refreshAttempts > 0, 'sanity: the account rotation really was attempted and really failed');

    // Still streaming: the only thing that ends it is the server saying so.
    stream.push('event: detached\ndata: {"attachmentId":"a1"}\n\n');
    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after mid-stream refresh failure');
    assert.deepEqual(
      result,
      { ok: true, reason: 'detached-by-server' },
      'the daemon must end on the server detach, never on a failed account rotation',
    );
  });
});

/** An SSE response the test drives frame by frame: unlike
 *  `neverEndingSseStreamResponse` it stays open AND lets the test push more
 *  frames later, which is what a "the session keeps streaming ACROSS a
 *  credential renewal" assertion needs — the renewal has to happen while the
 *  same connection is still live. */
function controllableSseResponse(initial = ''): {
  response: Response;
  push(text: string): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (initial) c.enqueue(encoder.encode(initial));
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
  };
}

/** Drives the injected timers repeatedly with a short real yield between
 *  passes, so the async work a tick kicks off (the refresh POST, the
 *  heartbeat POST) has room to settle — same pattern the account-refresh
 *  tests above use — and stops as soon as `until` is satisfied. */
async function tickUntil(
  timers: ReturnType<typeof fakeTimers>,
  until: () => boolean,
  passes = 40,
): Promise<void> {
  for (let i = 0; i < passes && !until(); i++) {
    timers.tick(1);
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!until()) throw new Error('tickUntil: condition never became true');
}

/** Unconditional timer passes. Needed after a terminal failure is triggered:
 *  the daemon tears the open stream down from its own stop-poll INTERVAL, so
 *  with injected timers nothing happens until the test keeps ticking. */
async function drainTicks(timers: ReturnType<typeof fakeTimers>, passes = 20): Promise<void> {
  for (let i = 0; i < passes; i++) {
    timers.tick(1);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('runAttachDaemon — scoped-credential refresh (card 07)', () => {
  const CONNECTION_NARRATION =
    /stream (connected|error)|reconnect|disconnect|detached by server|heartbeat error|token refreshed|unrecognized frame|credential/i;

  const TTL_MS = 3600_000;
  const T0 = 1_800_000_000_000;
  /** Far enough out that the ACCOUNT-token refresh never fires and cannot be
   *  mistaken for the scoped one under test. */
  const LONG_LIVED_AUTH: StoredAuth = {
    accessToken: 'account-at',
    refreshToken: 'account-rt',
    tokenType: 'Bearer',
    expiresAtMs: T0 + 30 * 24 * 3600_000,
  };

  it('renews the scoped credential mid-session and keeps streaming on the SAME connection', async () => {
    let clock = T0;
    const seen: Array<{ path: string; auth: string }> = [];
    let streamCalls = 0;
    let refreshCalls = 0;
    const stream = controllableSseResponse(
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n',
    );

    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const path = u.replace('https://api.example.com', '');
      seen.push({ path, auth: String(init?.headers?.Authorization ?? '') });
      if (path.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1',
          attachmentId: 'a1',
          scopedToken: 'scoped-1',
          scopedTokenExpiresAt: clock + TTL_MS,
        });
      }
      if (path.includes('/refresh')) {
        refreshCalls += 1;
        return jsonResponse(200, { scopedToken: 'scoped-2', scopedTokenExpiresAt: clock + TTL_MS });
      }
      if (path.includes('/yolobridge/stream')) {
        streamCalls += 1;
        return stream.response;
      }
      if (path.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    const logs: string[] = [];
    const events: ConnectionEvent[] = [];

    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: LONG_LIVED_AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: (line) => logs.push(line),
      onConnectionEvent: (event) => events.push(event),
      clearScreen: () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      now: () => clock,
      timers,
    });

    await waitUntil(() => timers.intervals.length >= 2); // stop-poll + heartbeat

    // Before the renewal point: heartbeats ride the ORIGINAL scoped token.
    await tickUntil(timers, () => seen.some((c) => c.path.endsWith('/yolobridge/events')));
    const beforeRefresh = seen.filter((c) => c.path.endsWith('/yolobridge/events'));
    assert.ok(beforeRefresh.length > 0, 'sanity: at least one heartbeat before the renewal');
    for (const call of beforeRefresh) {
      assert.equal(call.auth, 'Bearer scoped-1', 'pre-renewal calls must use the original scoped token');
    }
    assert.equal(refreshCalls, 0, 'must NOT renew before 75% of the TTL has elapsed');

    // Cross the 75%-of-TTL renewal point.
    clock = T0 + Math.floor(TTL_MS * 0.75) + 1;
    await tickUntil(timers, () => refreshCalls > 0);

    const refreshCall = seen.find((c) => c.path.includes('/refresh'));
    assert.ok(refreshCall, 'the daemon must have called the refresh route');
    assert.equal(
      refreshCall.path,
      '/v1/workspaces/w1/yolobridge/attach/a1/refresh',
      'refresh must target this workspace + attachment',
    );
    assert.equal(
      refreshCall.auth,
      'Bearer scoped-1',
      'the renewal presents the SCOPED token itself — never the account token',
    );
    assert.ok(
      !seen.some((c) => c.path.includes('/refresh') && c.auth === `Bearer ${LONG_LIVED_AUTH.accessToken}`),
      'the account token must never reach the refresh route',
    );

    // ...and everything after it rides the RENEWED token.
    const refreshIdx = seen.findIndex((c) => c.path.includes('/refresh'));
    await tickUntil(
      timers,
      () => seen.slice(refreshIdx + 1).some((c) => c.path.endsWith('/yolobridge/events')),
    );
    const afterRefresh = seen.slice(refreshIdx + 1).filter((c) => c.path.endsWith('/yolobridge/events'));
    assert.ok(afterRefresh.length > 0, 'sanity: the daemon really did keep heartbeating after the renewal');
    for (const call of afterRefresh) {
      assert.equal(call.auth, 'Bearer scoped-2', 'post-renewal calls must use the RENEWED scoped token');
    }

    // The renewal happened INSIDE one live connection: no reconnect, no
    // re-attach. This is the property the card asks for.
    assert.equal(streamCalls, 1, 'the session must survive the renewal on the same stream');
    assert.equal(
      seen.filter((c) => c.path.endsWith('/yolobridge/attach')).length,
      1,
      'renewing must never re-attach',
    );

    // The stream is still live and still delivering frames.
    stream.push('event: detached\ndata: {"attachmentId":"a1"}\n\n');
    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon across a scoped-credential renewal');
    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });

    // Reported out-of-band, never into the stream the agent's TUI owns.
    assert.deepEqual(logs.filter((l) => CONNECTION_NARRATION.test(l)), []);
    const refreshed = events.filter((e) => e.state === 'refreshed');
    assert.ok(refreshed.length > 0, 'the renewal must be visible on the structured channel');
    assert.match(refreshed[0].detail ?? '', /workspace-scoped credential renewed/);
  });

  it('stops with a re-attach remedy — out of band — once the renewal window has closed', async () => {
    let clock = T0;
    let refreshCalls = 0;
    const stream = controllableSseResponse(
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n',
    );
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1',
          attachmentId: 'a1',
          scopedToken: 'scoped-1',
          scopedTokenExpiresAt: clock + TTL_MS,
        });
      }
      if (u.includes('/refresh')) {
        refreshCalls += 1;
        return jsonResponse(401, {
          error: 'Scoped credential could not be verified or is too old to renew',
          code: 'UNAUTHENTICATED',
        });
      }
      if (u.includes('/yolobridge/stream')) return stream.response;
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    const logs: string[] = [];
    const events: ConnectionEvent[] = [];

    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: LONG_LIVED_AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: (line) => logs.push(line),
      onConnectionEvent: (event) => events.push(event),
      clearScreen: () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      now: () => clock,
      timers,
      sleep: async () => {},
    });

    await waitUntil(() => timers.intervals.length >= 2);

    // Past expiry AND past the 15-minute grace: no renewal can succeed.
    clock = T0 + TTL_MS + 15 * 60_000 + 1;
    await tickUntil(timers, () => refreshCalls > 0);
    await drainTicks(timers);

    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after a blown renewal window');
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'refresh-failed');
    assert.match((result as { message: string }).message, /yolo-bridge attach/);

    // THE POINT: the operator-facing remedy never touches the output stream
    // the local agent's TUI is rendering into.
    assert.deepEqual(
      logs.filter((l) => CONNECTION_NARRATION.test(l) || /yolo-bridge attach/.test(l)),
      [],
      `the re-attach remedy must not reach stdout, got: ${JSON.stringify(logs)}`,
    );
    const interrupted = events.filter((e) => e.state === 'interrupted');
    assert.ok(interrupted.length > 0, 'the failure must be reported on the structured channel');
    assert.ok(
      interrupted.some((e) => /yolo-bridge attach/.test(e.detail ?? '')),
      `expected the remedy in an interrupted event, got: ${JSON.stringify(events)}`,
    );
    // Never `degraded` for the TERMINAL failure — that state means the LINK is
    // struggling, and using it here would make `yolo-bridge status` misreport
    // the session.
    assert.ok(
      !events.some((e) => e.state === 'degraded' && /yolo-bridge attach/.test(e.detail ?? '')),
      'the terminal failure must not be recorded as `degraded`',
    );
  });

  it('treats a 403 (attachment detached server-side) as terminal even INSIDE the window', async () => {
    let clock = T0;
    let refreshCalls = 0;
    const stream = controllableSseResponse(
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n',
    );
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1',
          attachmentId: 'a1',
          scopedToken: 'scoped-1',
          scopedTokenExpiresAt: clock + TTL_MS,
        });
      }
      if (u.includes('/refresh')) {
        refreshCalls += 1;
        return jsonResponse(403, {
          error: 'This YoloBridge attachment is no longer active — run `yolo-bridge attach` again',
          code: 'FORBIDDEN',
        });
      }
      if (u.includes('/yolobridge/stream')) return stream.response;
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    const events: ConnectionEvent[] = [];
    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: LONG_LIVED_AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      onConnectionEvent: (event) => events.push(event),
      clearScreen: () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      now: () => clock,
      timers,
      sleep: async () => {},
    });

    await waitUntil(() => timers.intervals.length >= 2);
    // Renewal point reached, but the credential is still VALID for another
    // ~15 minutes — only the server-side 403 makes this terminal.
    clock = T0 + Math.floor(TTL_MS * 0.75) + 1;
    await tickUntil(timers, () => refreshCalls > 0);
    await drainTicks(timers);

    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after a 403 renewal');
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /yolo-bridge attach/);
    assert.equal(refreshCalls, 1, 'a 403 must not be retried');
  });

  it('rides out a TRANSIENT renewal failure while the credential is still renewable', async () => {
    let clock = T0;
    let refreshCalls = 0;
    const seen: Array<{ path: string; auth: string }> = [];
    const stream = controllableSseResponse(
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n',
    );
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      const path = u.replace('https://api.example.com', '');
      seen.push({ path, auth: String(init?.headers?.Authorization ?? '') });
      if (path.endsWith('/yolobridge/attach')) {
        return jsonResponse(201, {
          tileId: 'tile-1',
          attachmentId: 'a1',
          scopedToken: 'scoped-1',
          scopedTokenExpiresAt: clock + TTL_MS,
        });
      }
      if (path.includes('/refresh')) {
        refreshCalls += 1;
        // One 502 (an upstream blip), then success.
        if (refreshCalls === 1) return jsonResponse(502, { error: 'Bad gateway' });
        return jsonResponse(200, { scopedToken: 'scoped-2', scopedTokenExpiresAt: clock + TTL_MS });
      }
      if (path.includes('/yolobridge/stream')) return stream.response;
      if (path.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const timers = fakeTimers();
    const events: ConnectionEvent[] = [];
    const resultPromise = runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: LONG_LIVED_AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      onConnectionEvent: (event) => events.push(event),
      clearScreen: () => {},
      captureOutput: async () => ({ output: '', busy: false }),
      now: () => clock,
      timers,
      sleep: async () => {},
    });

    await waitUntil(() => timers.intervals.length >= 2);
    clock = T0 + Math.floor(TTL_MS * 0.75) + 1;
    await tickUntil(timers, () => refreshCalls >= 2);

    // The blip was recorded as `degraded` (an individual call failed) and the
    // daemon carried on rather than ending the session.
    const degraded = events.filter((e) => e.state === 'degraded');
    assert.ok(degraded.length > 0, 'the transient failure must be visible somewhere');
    assert.ok(
      degraded.some((e) => /scoped credential refresh failed/.test(e.detail ?? '')),
      `expected a degraded event naming the refresh blip, got: ${JSON.stringify(events)}`,
    );
    assert.ok(
      events.some((e) => e.state === 'refreshed'),
      'the retry must have eventually succeeded',
    );

    await tickUntil(
      timers,
      () => seen.some((c) => c.path.endsWith('/yolobridge/events') && c.auth === 'Bearer scoped-2'),
    );

    stream.push('event: detached\ndata: {"attachmentId":"a1"}\n\n');
    const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon after a transient renewal failure');
    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
  });
});

describe('pickWorkspaceFromDisk', () => {
  it('fails fast when not logged in, without ever calling the fake prompt', async () => {
    const io = fakeIO();
    let promptCalled = false;
    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      prompt: async () => { promptCalled = true; return '1'; },
    });
    assert.deepEqual(result, { ok: false, reason: 'not-logged-in' });
    assert.equal(promptCalled, false);
  });

  it('lists selectable workspaces, prompts, and resolves the chosen index to a workspaceId', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async (url: any) => {
      assert.equal(String(url), 'https://api.example.com/v1/workspaces/selectable');
      return jsonResponse(200, {
        workspaces: [
          { id: 'w1', name: 'Alpha', status: 'running' },
          { id: 'w2', name: 'Beta', status: 'paused' },
        ],
      });
    }) as any;

    const logs: string[] = [];
    const questions: string[] = [];
    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: (line) => logs.push(line),
      prompt: async (q) => { questions.push(q); return '2'; },
    });

    assert.deepEqual(result, { ok: true, workspaceId: 'w2' });
    assert.equal(questions.length, 1);
    assert.ok(logs.some((l) => l.includes('Alpha') && l.includes('running') && l.includes('w1')));
    assert.ok(logs.some((l) => l.includes('Beta') && l.includes('paused') && l.includes('w2')));
  });

  it('reports no-workspaces without prompting when the list is empty', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [] })) as any;
    let promptCalled = false;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => { promptCalled = true; return '1'; },
    });

    assert.deepEqual(result, { ok: false, reason: 'no-workspaces' });
    assert.equal(promptCalled, false);
  });

  it('rejects an out-of-range or non-numeric selection as no-selection', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [{ id: 'w1', name: 'Alpha', status: 'running' }] })) as any;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => 'not-a-number',
    });

    assert.deepEqual(result, { ok: false, reason: 'no-selection' });
  });

  it('surfaces a list failure as list-failed with the underlying message', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as any;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => '1',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'list-failed');
      assert.match((result as any).message, /boom/);
    }
  });
});

/**
 * Card 08 — the account refresh token stops surviving the attach exchange, and
 * the workspace-scoped credential starts surviving a daemon restart.
 *
 * These tests use the REAL filesystem (a throwaway HOME per test, no injected
 * `io`) rather than the in-memory `fakeIO` the suite uses elsewhere, because
 * the property under test is literally "what is left in the file on disk". A
 * stub that agrees with the code about what was written proves nothing about
 * what a leaked `~/.config/yolobridge/auth.json` would be worth.
 */
describe('runAttachDaemon — account refresh token is not persisted past the attach exchange (card 08)', () => {
  const T0 = 1_800_000_000_000;
  const DAY_MS = 24 * 3600_000;
  const CONNECTED = 'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n';
  const DETACHED = 'event: detached\ndata: {"attachmentId":"a1"}\n\n';

  function realHome(): {
    env: { HOME: string };
    authFile: string;
    attachmentFile: string;
    connectionFile: string;
    cleanup(): void;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolobridge-card08-'));
    const cfg = path.join(dir, '.config', 'yolobridge');
    return {
      env: { HOME: dir },
      authFile: path.join(cfg, 'auth.json'),
      attachmentFile: path.join(cfg, 'attachment.json'),
      connectionFile: path.join(cfg, 'connection.json'),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('drops the account refresh token from the REAL auth.json once a scoped credential is in hand', async () => {
    const home = realHome();
    try {
      saveAuth(
        { accessToken: 'account-at', refreshToken: 'account-rt', tokenType: 'Bearer', expiresAtMs: T0 + 30 * DAY_MS },
        home.env,
      );
      assert.ok(
        fs.readFileSync(home.authFile, 'utf-8').includes('account-rt'),
        'sanity: the refresh token really is on disk before the attach',
      );

      const fetchImpl = (async (url: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          return jsonResponse(201, {
            tileId: 'tile-1',
            attachmentId: 'a1',
            scopedToken: 'scoped-tok-1',
            scopedTokenExpiresAt: T0 + 3600_000,
          });
        }
        if (u.includes('/yolobridge/stream')) return sseStreamResponse(CONNECTED + DETACHED);
        if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      const result = await runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        log: () => {},
        clearScreen: () => {},
        now: () => T0,
      });
      assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });

      const raw = fs.readFileSync(home.authFile, 'utf-8');
      assert.ok(raw.includes('account-at'), `sanity: this is the real auth.json we are reading, got: ${raw}`);
      assert.ok(!raw.includes('account-rt'), `the durable account key must be gone from disk, got: ${raw}`);
      assert.equal('refreshToken' in JSON.parse(raw), false, 'the field must be ABSENT, not empty');
      assert.equal(loadAuth(home.env)?.refreshToken, undefined);
    } finally {
      home.cleanup();
    }
  });

  it('drops the refresh token UNCONDITIONALLY now the degraded path is gone, and an unscoped attach fails rather than running on it (card 09)', async () => {
    // Card 08 kept the refresh token whenever no scoped credential arrived,
    // because `scopedCfg()` fell back to the account token and the daemon ran
    // the entire session on it. Card 09 deleted that fallback AND made the
    // server refuse the account token on every daemon route, so there is no
    // session left for the refresh token to keep alive. Both halves are
    // asserted here — the attach failing, and the disk no longer holding the
    // durable account key afterwards.
    const home = realHome();
    try {
      saveAuth(
        // Near expiry, so the pre-attach `ensureFreshToken()` really rotates
        // and really writes `auth.json` back through `persistAccountAuth` —
        // which is the write this test is about. A far-future expiry would
        // skip the write entirely and the assertion below would prove nothing.
        { accessToken: 'account-at-1', refreshToken: 'account-rt-1', tokenType: 'Bearer', expiresAtMs: T0 + 1000 },
        home.env,
      );
      assert.ok(
        fs.readFileSync(home.authFile, 'utf-8').includes('account-rt-1'),
        'sanity: the refresh token really is on disk before the attach',
      );

      const attachAuths: string[] = [];
      const fetchImpl = (async (url: any, init?: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          attachAuths.push(String(init?.headers?.Authorization ?? ''));
          // No scopedToken/scopedTokenExpiresAt: a common-api predating the mint.
          return jsonResponse(201, { tileId: 'tile-1', attachmentId: 'a1' });
        }
        throw new Error(`must not reach ${u} without a scoped credential`);
      }) as any;

      const refreshedWith: string[] = [];
      const refreshAccessToken: RefreshTokenFn = async (_authUrl, refreshToken) => {
        refreshedWith.push(refreshToken);
        return {
          status: 'ok',
          tokens: {
            accessToken: 'account-at-2',
            refreshToken: 'account-rt-2',
            expiresInSec: 86_400,
            expiresAtMs: T0 + DAY_MS,
          },
        };
      };

      const result = await runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        refreshAccessToken,
        log: () => {},
        clearScreen: () => {},
        now: () => T0,
      });

      assert.equal(result.ok, false, 'an attach with no scoped credential must not report success');
      if (!result.ok) assert.equal(result.reason, 'attach-failed');
      assert.deepEqual(refreshedWith, ['account-rt-1'], 'sanity: the pre-attach rotation really ran');
      assert.deepEqual(attachAuths, ['Bearer account-at-2'], 'sanity: the attach really was attempted, with the rotated token');

      const raw = fs.readFileSync(home.authFile, 'utf-8');
      assert.ok(raw.includes('account-at-2'), `sanity: this is the real auth.json we are reading, got: ${raw}`);
      assert.equal(
        'refreshToken' in JSON.parse(raw),
        false,
        `the drop is unconditional now — the durable account key must be ABSENT, got: ${raw}`,
      );
    } finally {
      home.cleanup();
    }
  });

  it('an ACCOUNT rotation mid-session never re-persists the refresh token on the scoped path', async () => {
    // The account token keeps rotating (the local MCP proxy still mints with
    // it), but from a copy that lives only in this process's memory. Nothing
    // may write it back to disk.
    const home = realHome();
    try {
      let clock = T0;
      saveAuth(
        { accessToken: 'account-at-1', refreshToken: 'account-rt-1', tokenType: 'Bearer', expiresAtMs: T0 + 3600_000 },
        home.env,
      );

      const stream = controllableSseResponse(CONNECTED);
      const fetchImpl = (async (url: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          return jsonResponse(201, {
            tileId: 'tile-1',
            attachmentId: 'a1',
            scopedToken: 'scoped-tok-1',
            scopedTokenExpiresAt: T0 + 30 * DAY_MS,
          });
        }
        if (u.includes('/yolobridge/stream')) return stream.response;
        if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      const refreshedWith: string[] = [];
      const refreshAccessToken: RefreshTokenFn = async (_authUrl, refreshToken) => {
        refreshedWith.push(refreshToken);
        return {
          status: 'ok',
          tokens: {
            accessToken: 'account-at-2',
            refreshToken: 'account-rt-2',
            expiresInSec: 86_400,
            expiresAtMs: clock + DAY_MS,
          },
        };
      };

      const timers = fakeTimers();
      const resultPromise = runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        refreshAccessToken,
        log: () => {},
        clearScreen: () => {},
        now: () => clock,
        timers,
      });

      await waitUntil(() => timers.intervals.length >= 2);
      clock = T0 + 3600_000; // inside the refresh buffer → the next tick rotates
      await tickUntil(timers, () => refreshedWith.length > 0);

      // Both halves: the rotation really happened (from the in-memory copy)...
      assert.deepEqual(
        refreshedWith,
        ['account-rt-1'],
        'the daemon must still be able to rotate from the copy it kept in memory',
      );
      // ...and it did not leak back onto disk.
      const raw = fs.readFileSync(home.authFile, 'utf-8');
      assert.ok(raw.includes('account-at-2'), `sanity: the rotation was persisted at all, got: ${raw}`);
      assert.ok(!raw.includes('account-rt-2'), `a rotation must not re-persist the refresh token, got: ${raw}`);
      assert.ok(!raw.includes('account-rt-1'), `nor the original one, got: ${raw}`);

      stream.push(DETACHED);
      const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon across an account rotation');
      assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    } finally {
      home.cleanup();
    }
  });

  it('a SCOPED session survives an account-token refresh failure instead of ending, and stops retrying it', async () => {
    // Once scoped, the account token is not this daemon's credential for any
    // YoloBridge call. Ending a healthy session because it could not be rotated
    // would be a self-inflicted brick — the exact failure mode that makes the
    // drop conditional in the first place.
    const home = realHome();
    try {
      let clock = T0;
      saveAuth(
        { accessToken: 'account-at-1', refreshToken: 'account-rt-1', tokenType: 'Bearer', expiresAtMs: T0 + 3600_000 },
        home.env,
      );

      const heartbeatAuths: string[] = [];
      const stream = controllableSseResponse(CONNECTED);
      const fetchImpl = (async (url: any, init?: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          return jsonResponse(201, {
            tileId: 'tile-1',
            attachmentId: 'a1',
            scopedToken: 'scoped-tok-1',
            scopedTokenExpiresAt: T0 + 30 * DAY_MS,
          });
        }
        if (u.includes('/yolobridge/stream')) return stream.response;
        if (u.endsWith('/yolobridge/events')) {
          heartbeatAuths.push(String(init?.headers?.Authorization ?? ''));
          return jsonResponse(200, { recorded: true });
        }
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      let refreshAttempts = 0;
      const refreshAccessToken: RefreshTokenFn = async () => {
        refreshAttempts += 1;
        return { status: 'failed', message: 'auth-service said no' };
      };

      const timers = fakeTimers();
      const events: ConnectionEvent[] = [];
      const resultPromise = runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        refreshAccessToken,
        log: () => {},
        clearScreen: () => {},
        onConnectionEvent: (e) => events.push(e),
        now: () => clock,
        timers,
      });

      await waitUntil(() => timers.intervals.length >= 2);
      clock = T0 + 3600_000; // the account token is now unrotatable
      await tickUntil(timers, () => refreshAttempts > 0);
      const heartbeatsAtFailure = heartbeatAuths.length;
      await tickUntil(timers, () => heartbeatAuths.length > heartbeatsAtFailure);

      assert.ok(refreshAttempts > 0, 'sanity: the account refresh really was attempted and really failed');
      assert.equal(refreshAttempts, 1, 'a failure that cannot recover must not be retried on every tick');
      assert.ok(
        heartbeatAuths.slice(heartbeatsAtFailure).every((a) => a === 'Bearer scoped-tok-1'),
        `the session must keep heartbeating on the scoped token, saw ${heartbeatAuths.join(', ')}`,
      );
      assert.ok(
        !events.some((e) => e.state === 'degraded'),
        'an expected-by-design account rotation failure must not leave `status` reporting a healthy session as degraded',
      );

      stream.push(DETACHED);
      const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon across a failed account rotation');
      assert.deepEqual(
        result,
        { ok: true, reason: 'detached-by-server' },
        'the daemon must end on the server detach, NOT on refresh-failed',
      );
    } finally {
      home.cleanup();
    }
  });

  it('persists the scoped credential — and each RENEWAL of it — into the 0600 attachment record', async () => {
    const home = realHome();
    try {
      let clock = T0;
      const TTL_MS = 3600_000;
      saveAuth(
        { accessToken: 'account-at', refreshToken: 'account-rt', tokenType: 'Bearer', expiresAtMs: T0 + 30 * DAY_MS },
        home.env,
      );

      let refreshCalls = 0;
      const stream = controllableSseResponse(CONNECTED);
      const fetchImpl = (async (url: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          return jsonResponse(201, {
            tileId: 'tile-1',
            attachmentId: 'a1',
            scopedToken: 'scoped-1',
            scopedTokenExpiresAt: clock + TTL_MS,
          });
        }
        if (u.includes('/refresh')) {
          refreshCalls += 1;
          return jsonResponse(200, { scopedToken: 'scoped-2', scopedTokenExpiresAt: clock + TTL_MS });
        }
        if (u.includes('/yolobridge/stream')) return stream.response;
        if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      const timers = fakeTimers();
      const resultPromise = runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        log: () => {},
        clearScreen: () => {},
        now: () => clock,
        timers,
      });

      await waitUntil(() => timers.intervals.length >= 2);

      const atAttach = loadAttachment(home.env);
      assert.equal(atAttach?.scopedToken, 'scoped-1', 'the minted credential must be on disk for a restart to resume from');
      assert.equal(atAttach?.scopedTokenExpiresAtMs, T0 + TTL_MS, 'without the expiry a restart cannot schedule around it');
      assert.equal(atAttach?.attachmentId, 'a1');
      // Same file, same posture as before this card — no new mode invented.
      assert.equal(fs.statSync(home.attachmentFile).mode & 0o777, 0o600);

      clock = T0 + Math.floor(TTL_MS * 0.75) + 1;
      await tickUntil(timers, () => refreshCalls > 0);
      assert.equal(
        loadAttachment(home.env)?.scopedToken,
        'scoped-2',
        'a restart hours in must resume from the RENEWED credential, not the one attach happened to issue',
      );

      stream.push(DETACHED);
      const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon across a persisted renewal');
      assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
      assert.equal(loadAttachment(home.env), undefined, 'a clean detach must take the stored credential with it');
    } finally {
      home.cleanup();
    }
  });

  it('RESUMES from the stored scoped credential — no re-attach, no re-login — when the account token is gone', async () => {
    // The situation this card creates on purpose: a daemon that ran for days,
    // whose account access token expired on day one and whose refresh token is
    // deliberately no longer on disk. Its restart has no account credential at
    // all — but the workspace-scoped one it still holds is exactly the
    // credential the attachment's own routes want.
    const home = realHome();
    try {
      const clock = T0;
      // Post-card-08 auth.json: expired access token, NO refresh token.
      saveAuth({ accessToken: 'stale-account-at', tokenType: 'Bearer', expiresAtMs: clock - 1000 }, home.env);
      // A scoped token that expired 5 minutes ago — inside card 07's 15-minute
      // renewal window, so the server will still renew it.
      saveAttachment(
        {
          workspaceId: 'w1',
          tileId: 'tile-1',
          attachmentId: 'a1',
          attachedAt: '2026-08-25T00:00:00.000Z',
          scopedToken: 'stored-scoped',
          scopedTokenExpiresAtMs: clock - 5 * 60_000,
        },
        home.env,
      );

      const seen: Array<{ path: string; auth: string }> = [];
      const stream = controllableSseResponse(CONNECTED);
      const fetchImpl = (async (url: any, init?: any) => {
        const u = String(url);
        const p = u.replace('https://api.example.com', '');
        seen.push({ path: p, auth: String(init?.headers?.Authorization ?? '') });
        if (p.endsWith('/yolobridge/attach')) throw new Error('a resume must NEVER create a second attachment');
        if (p.includes('/refresh')) {
          return jsonResponse(200, { scopedToken: 'renewed-scoped', scopedTokenExpiresAt: clock + 3600_000 });
        }
        if (p.includes('/yolobridge/stream')) return stream.response;
        if (p.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      let accountRefreshCalls = 0;
      const refreshAccessToken: RefreshTokenFn = async () => {
        accountRefreshCalls += 1;
        return { status: 'failed', message: 'should never be called — there is no refresh token' };
      };

      const timers = fakeTimers();
      const logs: string[] = [];
      const resultPromise = runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        refreshAccessToken,
        log: (line) => logs.push(line),
        clearScreen: () => {},
        now: () => clock,
        timers,
      });

      await waitUntil(() => timers.intervals.length >= 2);
      await tickUntil(timers, () => seen.some((c) => c.path.endsWith('/yolobridge/events')));

      assert.equal(
        seen.filter((c) => c.path.endsWith('/yolobridge/attach')).length,
        0,
        'the resumed daemon must not have re-attached',
      );
      assert.equal(accountRefreshCalls, 0, 'with no refresh token stored there is nothing to call auth-service with');

      const renewal = seen.find((c) => c.path.includes('/refresh'));
      assert.ok(renewal, 'the resumed daemon must renew the credential it picked up off disk');
      assert.equal(renewal.auth, 'Bearer stored-scoped', 'the renewal proves possession of the STORED token');

      const streamCall = seen.find((c) => c.path.includes('/yolobridge/stream'));
      assert.equal(streamCall?.auth, 'Bearer renewed-scoped', 'the resumed stream must ride the renewed credential');
      const heartbeats = seen.filter((c) => c.path.endsWith('/yolobridge/events'));
      assert.ok(heartbeats.length > 0, 'sanity: the resumed session really is live');
      for (const hb of heartbeats) assert.equal(hb.auth, 'Bearer renewed-scoped');

      assert.ok(
        logs.some((l) => /^Resumed\./.test(l)),
        `the operator should be told this resumed rather than attached, saw: ${logs.join(' | ')}`,
      );
      assert.ok(
        !logs.some((l) => /yolo-bridge login/.test(l)),
        `resuming must not send the operator back to login, saw: ${logs.join(' | ')}`,
      );

      stream.push(DETACHED);
      const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon resuming from disk');
      assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    } finally {
      home.cleanup();
    }
  });

  it('a stored attachment the server will not renew AND a dead account token ends in the login remedy, not a stack trace', async () => {
    // Card 10 changed what happens here. The probe (card 07's refresh route)
    // is now the liveness check, so a credential the server refuses is simply
    // "nothing to resume" and the daemon falls through to the ordinary attach
    // path — where, with an expired account access token and no refresh token
    // on disk, there is genuinely nothing left but `yolo-bridge login`. That
    // is the honest remedy: card 07's `yolo-bridge attach` advice would have
    // sent the operator to a command that cannot authenticate either.
    const home = realHome();
    try {
      const clock = T0;
      saveAuth({ accessToken: 'stale-account-at', tokenType: 'Bearer', expiresAtMs: clock - 1000 }, home.env);
      // Expired 30 minutes ago — past the 15-minute grace window.
      saveAttachment(
        {
          workspaceId: 'w1',
          tileId: 'tile-1',
          attachmentId: 'a1',
          attachedAt: '2026-08-25T00:00:00.000Z',
          scopedToken: 'long-dead-scoped',
          scopedTokenExpiresAtMs: clock - 30 * 60_000,
        },
        home.env,
      );

      let streamCalls = 0;
      let probeCalls = 0;
      let attachCalls = 0;
      const fetchImpl = (async (url: any) => {
        const u = String(url);
        if (u.includes('/refresh')) {
          probeCalls += 1;
          return jsonResponse(401, { error: 'token too old to renew' });
        }
        if (u.endsWith('/yolobridge/attach')) {
          attachCalls += 1;
          return jsonResponse(201, ATTACH_OK);
        }
        if (u.includes('/yolobridge/stream')) {
          streamCalls += 1;
          return sseStreamResponse(CONNECTED);
        }
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      const logs: string[] = [];
      const events: ConnectionEvent[] = [];
      const result = await withTimeout(
        runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          onConnectionEvent: (e) => events.push(e),
          now: () => clock,
          timers: fakeTimers(),
        }),
        2000,
        'runAttachDaemon past the renewal window with no account credential',
      );

      // "It actually happened": the probe really was sent, exactly once, and
      // it is what decided there was nothing to resume.
      assert.equal(probeCalls, 1, 'liveness must be probed exactly once, and a refusal must not be retried');
      assert.equal(result.ok, false);
      assert.equal((result as any).reason, 'refresh-failed');
      assert.match(
        (result as any).message,
        /no refresh token is stored on this machine/,
        'with no account credential left, the honest remedy is login',
      );
      assert.ok(
        logs.some((l) => /Run `yolo-bridge login` again/.test(l)),
        `the operator must be told what to do, saw: ${logs.join(' | ')}`,
      );
      assert.equal(attachCalls, 0, 'an attach with no usable account token must not even be tried');
      assert.equal(streamCalls, 0, 'nothing was attached, so nothing may open a stream');
    } finally {
      home.cleanup();
    }
  });

  it('never writes the scoped token to the terminal, the connection record, or `yolo-bridge status`', async () => {
    const home = realHome();
    try {
      let clock = T0;
      const TTL_MS = 3600_000;
      const SECRET = 'scoped-SECRET-do-not-log';
      const RENEWED_SECRET = 'renewed-SECRET-do-not-log';
      saveAuth(
        { accessToken: 'account-at', refreshToken: 'account-rt', tokenType: 'Bearer', expiresAtMs: T0 + 30 * DAY_MS },
        home.env,
      );

      let refreshCalls = 0;
      const stream = controllableSseResponse(CONNECTED);
      const fetchImpl = (async (url: any) => {
        const u = String(url);
        if (u.endsWith('/yolobridge/attach')) {
          return jsonResponse(201, {
            tileId: 'tile-1',
            attachmentId: 'a1',
            scopedToken: SECRET,
            scopedTokenExpiresAt: clock + TTL_MS,
          });
        }
        if (u.includes('/refresh')) {
          refreshCalls += 1;
          return jsonResponse(200, { scopedToken: RENEWED_SECRET, scopedTokenExpiresAt: clock + TTL_MS });
        }
        if (u.includes('/yolobridge/stream')) return stream.response;
        if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
        throw new Error(`unexpected request: ${u}`);
      }) as any;

      const timers = fakeTimers();
      const logs: string[] = [];
      // No `onConnectionEvent`: this test wants the DEFAULT sink, i.e. the real
      // connection.json a `yolo-bridge status` would read back.
      const resultPromise = runAttachFromDisk({
        workspaceId: 'w1',
        commonApiBaseUrl: 'https://api.example.com',
        env: home.env,
        fetchImpl,
        log: (line) => logs.push(line),
        clearScreen: () => {},
        now: () => clock,
        timers,
      });

      await waitUntil(() => timers.intervals.length >= 2);
      clock = T0 + Math.floor(TTL_MS * 0.75) + 1;
      await tickUntil(timers, () => refreshCalls > 0);

      // Non-vacuous: there IS output, and there IS a connection record.
      assert.ok(logs.length > 0, 'sanity: the daemon did write to the terminal');
      assert.ok(fs.existsSync(home.connectionFile), 'sanity: the connection record was written');
      const connectionRaw = fs.readFileSync(home.connectionFile, 'utf-8');
      assert.match(connectionRaw, /a1/, 'sanity: the connection record really is about this attachment');

      for (const secret of [SECRET, RENEWED_SECRET]) {
        assert.ok(!logs.join('\n').includes(secret), `the scoped token must never be logged, saw: ${logs.join(' | ')}`);
        assert.ok(!connectionRaw.includes(secret), 'the scoped token must never reach connection.json');
      }

      // ...and `yolo-bridge status`, which renders the attachment record that
      // legitimately DOES store it, must not print it either.
      const status = formatStatus(getStatus({ env: home.env, now: () => clock }));
      assert.match(status, /attachmentId=a1/, 'sanity: status really did read this attachment');
      for (const secret of [SECRET, RENEWED_SECRET]) {
        assert.ok(!status.includes(secret), `\`yolo-bridge status\` must not print the credential, got: ${status}`);
      }

      stream.push(DETACHED);
      const result = await withTimeout(resultPromise, 2000, 'runAttachDaemon under credential-logging scrutiny');
      assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    } finally {
      home.cleanup();
    }
  });

  /**
   * Card 10 — LIVENESS, not the account token's health, decides whether a
   * restart resumes.
   *
   * Card 08's gate was `!initialRefresh.ok`, so only a daemon whose ACCOUNT
   * token had died ever resumed. A daemon restarting with a healthy account
   * token ignored a perfectly good stored attachment and attached again,
   * leaving the operator with a duplicate tile. These tests pin the request
   * COUNTS — the returned ids alone would still look right while a second
   * attachment was quietly created.
   */
  describe('resume is the default, gated on server-confirmed liveness (card 10)', () => {
    const HEALTHY_AUTH = {
      accessToken: 'account-at',
      refreshToken: 'account-rt',
      tokenType: 'Bearer' as const,
      expiresAtMs: T0 + 30 * DAY_MS,
    };
    const LIVE_STORED = {
      workspaceId: 'w1',
      tileId: 'tile-1',
      attachmentId: 'a1',
      attachedAt: '2026-08-25T00:00:00.000Z',
      scopedToken: 'stored-scoped',
      scopedTokenExpiresAtMs: T0 + 1800_000,
    };

    /** One fake server for all of these: counts every call by kind so a test
     *  can assert what did NOT happen as well as what did. */
    function server(opts: {
      stream: { response: Response };
      refresh: () => Response;
      attach?: () => Response;
    }) {
      const counts = { attach: 0, refresh: 0, stream: 0, events: 0 };
      const seen: Array<{ path: string; auth: string }> = [];
      const fetchImpl = (async (url: any, init?: any) => {
        const u = String(url);
        const path = u.replace('https://api.example.com', '');
        seen.push({ path, auth: String(init?.headers?.Authorization ?? '') });
        if (path.includes('/refresh')) {
          counts.refresh += 1;
          return opts.refresh();
        }
        if (path.endsWith('/yolobridge/attach')) {
          counts.attach += 1;
          if (!opts.attach) throw new Error('this test forbids attach');
          return opts.attach();
        }
        if (path.includes('/yolobridge/stream')) {
          counts.stream += 1;
          return opts.stream.response;
        }
        if (path.endsWith('/yolobridge/events')) {
          counts.events += 1;
          return jsonResponse(200, { recorded: true });
        }
        throw new Error(`unexpected request: ${u}`);
      }) as any;
      return { counts, seen, fetchImpl };
    }

    it('a HEALTHY account token + a live stored attachment resumes it — ZERO attach requests', async () => {
      const home = realHome();
      try {
        const clock = T0;
        saveAuth(HEALTHY_AUTH, home.env);
        saveAttachment(LIVE_STORED, home.env);

        const stream = controllableSseResponse(CONNECTED);
        // No `attach` handler at all: reaching it throws, and the counter
        // below proves it was never even approached.
        const { counts, seen, fetchImpl } = server({
          stream,
          refresh: () => jsonResponse(200, { scopedToken: 'renewed-scoped', scopedTokenExpiresAt: clock + 3600_000 }),
        });

        const timers = fakeTimers();
        const logs: string[] = [];
        const resultPromise = runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          now: () => clock,
          timers,
        });

        await waitUntil(() => timers.intervals.length >= 2);
        await tickUntil(timers, () => counts.events > 0);

        // THE defect this card fixes, asserted as a COUNT: a healthy account
        // token must not create a second server-side attachment.
        assert.equal(counts.attach, 0, 'a healthy account token must not cause a duplicate attach');
        assert.equal(counts.refresh, 1, 'liveness is probed exactly once, via card 07’s refresh route');
        assert.ok(counts.events > 0, 'sanity: the resumed session really is live');

        const probe = seen.find((c) => c.path.includes('/refresh'));
        assert.equal(probe?.auth, 'Bearer stored-scoped', 'the probe proves possession of the STORED credential');
        assert.equal(
          probe?.path,
          '/v1/workspaces/w1/yolobridge/attach/a1/refresh',
          'the probe must address the STORED attachment',
        );

        const streamCall = seen.find((c) => c.path.includes('/yolobridge/stream'));
        assert.equal(streamCall?.auth, 'Bearer renewed-scoped', 'the resumed stream rides the credential the probe returned');

        assert.ok(
          logs.some((l) => l === 'Resumed. tileId=tile-1 attachmentId=a1'),
          `the SAME tile/attachment must be adopted, saw: ${logs.join(' | ')}`,
        );
        const onDisk = loadAttachment(home.env);
        assert.equal(onDisk?.attachmentId, 'a1');
        assert.equal(onDisk?.tileId, 'tile-1');
        assert.equal(onDisk?.scopedToken, 'renewed-scoped', 'the resumed daemon persists the credential it is actually using');

        stream.push(DETACHED);
        assert.deepEqual(
          await withTimeout(resultPromise, 2000, 'runAttachDaemon resuming on a healthy account token'),
          { ok: true, reason: 'detached-by-server' },
        );
      } finally {
        home.cleanup();
      }
    });

    it('a stored attachment the server has DETACHED (probe 403s) falls through to EXACTLY ONE new attach', async () => {
      const home = realHome();
      try {
        const clock = T0;
        saveAuth(HEALTHY_AUTH, home.env);
        saveAttachment(LIVE_STORED, home.env);

        const stream = controllableSseResponse('event: connected\ndata: {"attachmentId":"a2","workspaceId":"w1","timestamp":"t"}\n\n');
        const { counts, fetchImpl } = server({
          stream,
          refresh: () =>
            jsonResponse(403, {
              error: 'This YoloBridge attachment is no longer active — run `yolo-bridge attach` again',
              code: 'FORBIDDEN',
            }),
          attach: () =>
            jsonResponse(201, {
              tileId: 'tile-2',
              attachmentId: 'a2',
              scopedToken: 'fresh-scoped',
              scopedTokenExpiresAt: clock + 3600_000,
            }),
        });

        const timers = fakeTimers();
        const logs: string[] = [];
        const resultPromise = runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          now: () => clock,
          timers,
        });

        await waitUntil(() => timers.intervals.length >= 2);
        await tickUntil(timers, () => counts.events > 0);

        assert.equal(counts.refresh, 1, 'the dead attachment is probed once and not retried');
        assert.equal(counts.attach, 1, 'EXACTLY one replacement attachment — not zero, not two');
        assert.ok(counts.events > 0, 'sanity: the replacement session really is live');
        assert.ok(
          logs.some((l) => l === 'Attached. tileId=tile-2 attachmentId=a2'),
          `the operator gets the NEW tile, saw: ${logs.join(' | ')}`,
        );
        assert.ok(
          logs.some((l) => /no longer resumable/.test(l)),
          `the fall-through must be explained, saw: ${logs.join(' | ')}`,
        );
        assert.equal(loadAttachment(home.env)?.attachmentId, 'a2', 'the stored record must follow the live attachment');

        stream.push('event: detached\ndata: {"attachmentId":"a2"}\n\n');
        assert.deepEqual(
          await withTimeout(resultPromise, 2000, 'runAttachDaemon after a detached-attachment fall-through'),
          { ok: true, reason: 'detached-by-server' },
        );
      } finally {
        home.cleanup();
      }
    });

    it('with NO stored attachment the ordinary path is unchanged — one attach, no probe', async () => {
      const home = realHome();
      try {
        const clock = T0;
        saveAuth(HEALTHY_AUTH, home.env);
        assert.equal(loadAttachment(home.env), undefined, 'sanity: nothing to resume from');

        const stream = controllableSseResponse(CONNECTED);
        const { counts, fetchImpl } = server({
          stream,
          refresh: () => {
            throw new Error('there is nothing stored to probe');
          },
          attach: () => jsonResponse(201, ATTACH_OK),
        });

        const timers = fakeTimers();
        const logs: string[] = [];
        const resultPromise = runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          now: () => clock,
          timers,
        });

        await waitUntil(() => timers.intervals.length >= 2);
        await tickUntil(timers, () => counts.events > 0);

        assert.equal(counts.refresh, 0, 'no stored credential means no probe to send');
        assert.equal(counts.attach, 1);
        assert.ok(
          logs.some((l) => l === 'Attached. tileId=tile-1 attachmentId=a1'),
          `saw: ${logs.join(' | ')}`,
        );

        stream.push(DETACHED);
        assert.deepEqual(
          await withTimeout(resultPromise, 2000, 'runAttachDaemon with nothing to resume'),
          { ok: true, reason: 'detached-by-server' },
        );
      } finally {
        home.cleanup();
      }
    });

    it('an account token the auth-service REFUSES still resumes — the ordering win', async () => {
      // `ensureFreshToken` used to run first and be fatal. It is now only on
      // the attach path, so a daemon whose account credential is unusable but
      // whose attachment is live comes back cleanly. Without this the whole
      // point of persisting the scoped credential regresses silently.
      const home = realHome();
      try {
        const clock = T0;
        // Expired access token, and a refresh token the auth-service rejects.
        saveAuth(
          { accessToken: 'dead-at', refreshToken: 'revoked-rt', tokenType: 'Bearer', expiresAtMs: clock - 1000 },
          home.env,
        );
        saveAttachment(LIVE_STORED, home.env);

        let accountRefreshCalls = 0;
        const refreshAccessToken: RefreshTokenFn = async () => {
          accountRefreshCalls += 1;
          return { status: 'failed', message: 'refresh token revoked' };
        };

        const stream = controllableSseResponse(CONNECTED);
        const { counts, fetchImpl } = server({
          stream,
          refresh: () => jsonResponse(200, { scopedToken: 'renewed-scoped', scopedTokenExpiresAt: clock + 3600_000 }),
        });

        const timers = fakeTimers();
        const logs: string[] = [];
        const resultPromise = runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          refreshAccessToken,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          now: () => clock,
          timers,
        });

        await waitUntil(() => timers.intervals.length >= 2);
        await tickUntil(timers, () => counts.events > 0);

        assert.equal(counts.attach, 0, 'the resume must not need an account credential at all');
        assert.equal(counts.refresh, 1);
        assert.ok(counts.events > 0, 'sanity: the session really is live despite the dead account token');
        // "It actually happened": the account rotation WAS attempted (from the
        // stream loop, where it is best-effort) and failed — and the session
        // survived it. If this were zero the test would prove nothing about
        // `ensureFreshToken` no longer being fatal.
        assert.ok(accountRefreshCalls > 0, 'the account rotation must have been attempted and failed');
        assert.ok(
          !logs.some((l) => /yolo-bridge login/.test(l)),
          `a live attachment must not send the operator back to login, saw: ${logs.join(' | ')}`,
        );

        stream.push(DETACHED);
        assert.deepEqual(
          await withTimeout(resultPromise, 2000, 'runAttachDaemon resuming past a refused account refresh'),
          { ok: true, reason: 'detached-by-server' },
        );
      } finally {
        home.cleanup();
      }
    });

    it('--fresh creates a new attachment even when the stored one is live, and sends NO probe', async () => {
      const home = realHome();
      try {
        const clock = T0;
        saveAuth(HEALTHY_AUTH, home.env);
        saveAttachment(LIVE_STORED, home.env);

        const stream = controllableSseResponse('event: connected\ndata: {"attachmentId":"a2","workspaceId":"w1","timestamp":"t"}\n\n');
        const { counts, fetchImpl } = server({
          stream,
          refresh: () => {
            throw new Error('--fresh must never probe the stored attachment');
          },
          attach: () =>
            jsonResponse(201, {
              tileId: 'tile-2',
              attachmentId: 'a2',
              scopedToken: 'fresh-scoped',
              scopedTokenExpiresAt: clock + 3600_000,
            }),
        });

        const timers = fakeTimers();
        const logs: string[] = [];
        const resultPromise = runAttachFromDisk({
          workspaceId: 'w1',
          commonApiBaseUrl: 'https://api.example.com',
          env: home.env,
          fetchImpl,
          fresh: true,
          log: (line) => logs.push(line),
          clearScreen: () => {},
          now: () => clock,
          timers,
        });

        await waitUntil(() => timers.intervals.length >= 2);
        await tickUntil(timers, () => counts.events > 0);

        assert.equal(counts.refresh, 0, '--fresh must not send a liveness probe at all');
        assert.equal(counts.attach, 1, '--fresh always creates a new attachment');
        assert.ok(
          logs.some((l) => l === 'Attached. tileId=tile-2 attachmentId=a2'),
          `saw: ${logs.join(' | ')}`,
        );
        assert.equal(loadAttachment(home.env)?.attachmentId, 'a2');

        stream.push('event: detached\ndata: {"attachmentId":"a2"}\n\n');
        assert.deepEqual(
          await withTimeout(resultPromise, 2000, 'runAttachDaemon under --fresh'),
          { ok: true, reason: 'detached-by-server' },
        );
      } finally {
        home.cleanup();
      }
    });
  });
});
