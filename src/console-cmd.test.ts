/**
 * `yolo-bridge console`.
 *
 * Two properties carry the weight, and both fail SILENTLY when wrong: the client
 * must authenticate as the USER (never with the daemon's scoped token, which
 * must not leave the machine it was minted on), and it must pull the right
 * events out of the stream (a mismatched name or tile filter yields a console
 * that connects, accepts typing, and shows a blank screen forever).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConsoleTarget,
  extractOutputChunks,
  extractOutputFrames,
  reconcileSeed,
  createOutputReconciler,
  runConsole,
  createOrderedInputSender,
  INPUT_COALESCE_MS,
  MAX_INPUT_CHUNK,
  DEFAULT_DRAIN_TIMEOUT_MS,
} from './console-cmd.js';
import { saveAuth, saveAttachment, type ConfigStoreIO } from './config-store.js';

const ENV = { HOME: '/home/yolo' };

/** RIS. A raw replay assumes a clean screen; see TERMINAL_RESET in console-cmd. */
const RESET = '\u001bc';

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p: string) => files.get(p),
    writeFile: (p: string, c: string) => { files.set(p, c); },
    removeFile: (p: string) => { files.delete(p); },
  };
}

const AUTH = { accessToken: 'ACCOUNT-TOKEN', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 1e6 };

describe('resolveConsoleTarget — the credential is the whole design', () => {
  it('uses the ACCOUNT token, never the daemon scoped token', () => {
    // The scoped token is bound to the machine running the agent and is the
    // credential the scoped-credential work exists to confine. A console on a
    // different machine must not have it, must not need it, and the server
    // refuses it on the input route from the other side.
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({
      workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString(),
      scopedToken: 'SCOPED-DAEMON-TOKEN', scopedTokenExpiresAtMs: Date.now() + 1e6,
    }, ENV, io);

    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.cfg.accessToken, 'ACCOUNT-TOKEN');
    assert.notEqual(target.cfg.accessToken, 'SCOPED-DAEMON-TOKEN');
  });

  it('works with NO scoped token stored at all — it is genuinely not needed', () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(target.ok, true);
  });

  it('refuses when not logged in', () => {
    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io: fakeIO() });
    assert.equal(target.ok, false);
    if (target.ok) return;
    assert.equal(target.reason, 'not-logged-in');
    assert.match(target.message, /yolo-bridge login/);
  });

  it('names the remedy when there is nothing to connect to', () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(target.ok, false);
    if (target.ok) return;
    assert.equal(target.reason, 'no-target');
    assert.match(target.message, /--attachment/);
    assert.match(target.message, /Open in terminal/);
  });

  it('lets explicit arguments override the stored attachment', () => {
    // The whole use case is connecting to a machine you are NOT sitting at, so
    // the local attachment is a convenience default, never a constraint.
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'local-ws', tileId: 'local-t', attachmentId: 'local-att', attachedAt: new Date().toISOString() }, ENV, io);

    const target = resolveConsoleTarget({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      workspaceId: 'other-ws', attachmentId: 'other-att',
    });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.workspaceId, 'other-ws');
    assert.equal(target.attachmentId, 'other-att');
  });
});

describe('extractOutputChunks', () => {
  const frame = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

  it('pulls the PTY bytes out of a workspace event frame', () => {
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'hello' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), ['hello']);
  });

  it('ignores events of every other type', () => {
    const sse = frame({ type: 'workspace.updated', data: { tileId: 't1', data: 'nope' } })
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'yes' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), ['yes']);
  });

  it('filters by TILE — a workspace can host more than one bridged session', () => {
    // Without this a console renders another session's screen into this one.
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 'other', data: 'theirs' } })
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'mine' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), ['mine']);
  });

  it('takes everything when no tile is known, rather than showing nothing', () => {
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 'whatever', data: 'x' } });
    assert.deepEqual(extractOutputChunks(sse, undefined), ['x']);
  });

  it('survives keepalives and non-JSON frames without throwing', () => {
    const sse = ': keepalive\n\n' + 'data: not json\n\n'
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'ok' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), ['ok']);
  });

  it('preserves control bytes and ordering exactly', () => {
    // This is a terminal: reordering or dropping an escape sequence corrupts
    // the screen rather than degrading it.
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: '\x1b[2J' } })
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: '\x1b[H' } })
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'A' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), ['\x1b[2J', '\x1b[H', 'A']);
  });

  it('skips empty payloads rather than writing nothing repeatedly', () => {
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: '' } });
    assert.deepEqual(extractOutputChunks(sse, 't1'), []);
  });
});

describe('input coalescing', () => {
  it('is well under human inter-keystroke time', () => {
    // A POST per character would queue a fast typist's keystrokes behind each
    // other at ~80ms per round trip. Coalescing must not be so long that a
    // single deliberate keypress is delayed noticeably.
    assert.ok(INPUT_COALESCE_MS > 0);
    assert.ok(INPUT_COALESCE_MS < 50, 'must stay far below ~100ms typing cadence');
  });
});

describe('the stored tile belongs to the STORED attachment', () => {
  it('does not carry a local tileId onto a different attachment', () => {
    // Inheriting it is a blank-or-wrong screen with no error anywhere: the
    // subscription and the output filter would both name this machine's tile
    // while the operator asked for someone else's. (codex P1.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'local-ws', tileId: 'local-tile', attachmentId: 'local-att', attachedAt: new Date().toISOString() }, ENV, io);

    const target = resolveConsoleTarget({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      workspaceId: 'other-ws', attachmentId: 'other-att',
    });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.tileId, undefined, 'must be resolved from the server, not inherited');
  });

  it('still uses it when the attachment is genuinely the stored one', () => {
    // The convenience path must survive the fix — otherwise every local console
    // pays an extra round trip for a fact it already has.
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'local-ws', tileId: 'local-tile', attachmentId: 'local-att', attachedAt: new Date().toISOString() }, ENV, io);

    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.tileId, 'local-tile');
  });

  it('honours an explicit --tile over both', () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'local-ws', tileId: 'local-tile', attachmentId: 'local-att', attachedAt: new Date().toISOString() }, ENV, io);
    const target = resolveConsoleTarget({
      commonApiBaseUrl: 'https://api.example', env: ENV, io, tileId: 'explicit-tile',
    });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.tileId, 'explicit-tile');
  });
});

describe('detach wakes the blocked read', () => {
  /** A stream that never produces a byte — a quiet agent, which is the norm. */
  function silentStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({ start() { /* deliberately silent */ } });
  }

  function fakeStdin() {
    const listeners: Array<(c: Buffer | string) => void> = [];
    let raw = false;
    const stdin = {
      isTTY: true,
      setRawMode(v: boolean) { raw = v; return stdin; },
      resume() { return stdin; },
      pause() { return stdin; },
      setEncoding() { return stdin; },
      on(_e: string, fn: (c: Buffer | string) => void) { listeners.push(fn); return stdin; },
      off(_e: string, fn: (c: Buffer | string) => void) {
        const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); return stdin;
      },
      type(s: string) { for (const fn of [...listeners]) fn(s); },
      get rawMode() { return raw; },
    };
    return stdin;
  }

  it('returns immediately on Ctrl-P Ctrl-Q instead of waiting for output', async () => {
    // Without cancelling the reader, this hangs in `reader.read()` until the
    // next chunk or SSE heartbeat — up to ~30s of the operator's terminal stuck
    // in RAW MODE after they asked to leave. (codex P1.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(url).includes('/v1/events/stream')) {
        return new Response(silentStream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const stdin = fakeStdin();
    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: fetchImpl as never,
      stdin: stdin as never,
      stdout: { write: () => true },
    });

    // Let the subscribe + stream open settle, then send the chord.
    await new Promise((r) => setTimeout(r, 20));
    stdin.type('\x10');
    stdin.type('\x11');

    const raced = await Promise.race([
      done,
      new Promise((r) => setTimeout(() => r('HUNG'), 2000)),
    ]);
    assert.notEqual(raced, 'HUNG', 'detach must cancel the pending read, not wait for output');
    assert.deepEqual(raced, { ok: true, reason: 'detached' });
    assert.equal(stdin.rawMode, false, 'the terminal must be out of raw mode');
  });
});

describe('input ordering — a terminal cannot tolerate reordering', () => {
  it('never starts a send while the previous one is still in flight', async () => {
    // Two unawaited POSTs racing is not a dropped keystroke — it is `rm -rf`
    // arriving as `rm f-r`, or the halves of an escape sequence inverted.
    // The first send here resolves LAST, which is exactly the case that
    // reorders when sends are fired independently. (codex P1.)
    const delivered: string[] = [];
    let firstResolve: (() => void) | undefined;
    let n = 0;
    const sender = createOrderedInputSender({
      coalesceMs: 1,
      send: async (payload) => {
        n += 1;
        if (n === 1) {
          await new Promise<void>((r) => { firstResolve = r; });
        }
        delivered.push(payload);
      },
    });

    sender.push('a');
    await new Promise((r) => setTimeout(r, 10));   // 'a' is now in flight, hung
    sender.push('b');
    sender.push('c');
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(delivered, [], 'nothing may land while the first is hung');
    firstResolve!();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(delivered, ['a', 'bc'], 'strictly in order, later bytes coalesced');
    sender.dispose();
  });

  it('reports a failed send without wedging the ones after it', async () => {
    const delivered: string[] = [];
    const errors: unknown[] = [];
    let n = 0;
    const sender = createOrderedInputSender({
      coalesceMs: 1,
      onError: (e) => errors.push(e),
      send: async (payload) => {
        n += 1;
        if (n === 1) throw new Error('boom');
        delivered.push(payload);
      },
    });
    sender.push('x');
    await new Promise((r) => setTimeout(r, 15));
    sender.push('y');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(errors.length, 1);
    assert.deepEqual(delivered, ['y'], 'the channel must recover, not latch');
    sender.dispose();
  });

  it('sends nothing after dispose', async () => {
    const delivered: string[] = [];
    const sender = createOrderedInputSender({ coalesceMs: 1, send: async (p) => { delivered.push(p); } });
    sender.push('q');
    sender.dispose();
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(delivered, []);
  });
});

describe('the account token is refreshed, not captured once', () => {
  const EXPIRED = { accessToken: 'STALE', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() - 1000 };

  function setup(auth: typeof EXPIRED) {
    const io = fakeIO();
    saveAuth(auth, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);
    return io;
  }

  it('refreshes BEFORE connecting and uses the new token on the wire', async () => {
    // A console that starts on an already-dead token fails every call while a
    // perfectly good refresh token sits on disk. (codex P1.)
    const io = setup(EXPIRED);
    const seen: string[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
      // The stream is recorded by URL: its credential travels in the query
      // string, because the events route reads req.query.token exclusively.
      seen.push(String(url).includes('/v1/events/stream')
        ? `stream ${String(url)}`
        : `api ${headers.get('Authorization') ?? '(none)'}`);
      if (String(url).includes('/v1/events/stream')) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: fetchImpl as never,
      refreshAccessTokenImpl: async () => ({
        status: 'ok',
        tokens: { accessToken: 'FRESH', refreshToken: 'rt2', expiresAtMs: Date.now() + 1e6 },
      }) as never,
      stdin: { isTTY: false, on: () => {}, off: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} } as never,
      stdout: { write: () => true },
    });
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(seen.some((s) => s.includes('Bearer FRESH')), `expected the refreshed token on the wire, saw: ${seen.join(' | ')}`);
    assert.ok(!seen.some((s) => s.includes('Bearer STALE')), 'the dead token must never be used');
    // The stream URL carries the token in the query string, not a header.
    assert.ok(seen.some((s) => s.startsWith('stream') && s.includes('token=FRESH')));

    // The rotated credential is persisted for the next command.
    const persisted = [...io.files.entries()].find(([k]) => k.endsWith('auth.json'))?.[1] ?? '';
    assert.match(persisted, /FRESH/, 'the rotated credential must survive for the next command');
    assert.match(persisted, /rt2/, 'and so must the rotated REFRESH token — reusing rt would 401 next time');
    void done;
  });

  it('says to log in when there is nothing to refresh with', async () => {
    const io = setup({ ...EXPIRED, refreshToken: undefined as never });
    const result = await runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async () => { throw new Error('must not reach the network'); }) as never,
      stdin: { isTTY: false, on: () => {}, off: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} } as never,
      stdout: { write: () => true },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /yolo-bridge login/);
  });

  it('does not refresh a token with plenty of life left', async () => {
    const io = setup({ ...EXPIRED, accessToken: 'GOOD', expiresAtMs: Date.now() + 60 * 60_000 });
    let refreshed = false;
    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => (String(url).includes('/v1/events/stream')
        ? new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))) as never,
      refreshAccessTokenImpl: (async () => { refreshed = true; throw new Error('should not be called'); }) as never,
      stdin: { isTTY: false, on: () => {}, off: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} } as never,
      stdout: { write: () => true },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(refreshed, false);
    void done;
  });
});

describe('a paste must not vanish at the server limit', () => {
  it('splits an oversized buffer into ordered chunks under the cap', async () => {
    // The route 413s anything over 8192 chars, and a rejected send cannot be
    // un-dropped — so an unsplit paste is lost WHOLESALE. (codex P1.)
    const sent: string[] = [];
    const sender = createOrderedInputSender({
      coalesceMs: 1,
      maxChunk: 10,
      send: async (p) => { sent.push(p); },
    });
    sender.push('0123456789abcdefghij!');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sent.every((c) => c.length <= 10), `every chunk must fit: ${sent.map((c) => c.length)}`);
    assert.equal(sent.join(''), '0123456789abcdefghij!', 'and reassemble byte-for-byte, in order');
    sender.dispose();
  });

  it('stays below the server cap by default', () => {
    // Strictly below, so the two constants can never be off by one.
    assert.ok(MAX_INPUT_CHUNK < 8192, 'must be under routes/yolobridge.ts 8192-char limit');
  });

  it('never splits a surrogate pair', async () => {
    // Half a surrogate is not a character; it would reach the agent as a
    // replacement byte nobody typed.
    const sent: string[] = [];
    const sender = createOrderedInputSender({
      coalesceMs: 1, maxChunk: 4, send: async (p) => { sent.push(p); },
    });
    sender.push('abc😀de');   // the emoji straddles the 4-unit boundary
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.join(''), 'abc😀de');
    for (const chunk of sent) {
      for (let i = 0; i < chunk.length; i++) {
        const u = chunk.charCodeAt(i);
        if (u >= 0xd800 && u <= 0xdbff) {
          const next = chunk.charCodeAt(i + 1);
          assert.ok(next >= 0xdc00 && next <= 0xdfff, `high surrogate with no low half: ${JSON.stringify(chunk)}`);
          i++;
        } else {
          assert.ok(!(u >= 0xdc00 && u <= 0xdfff), `orphan low surrogate: ${JSON.stringify(chunk)}`);
        }
      }
    }
    sender.dispose();
  });
});

describe('a failed mid-session refresh ends the console', () => {
  it('stops renewing and reports why instead of freezing', async () => {
    // Renewal swallows its errors, so continuing on a dead token means the
    // lease lapses and the screen simply stops updating — indistinguishable
    // from a hung agent. (codex P1.)
    const io = fakeIO();
    // Inside the refresh window from the start, so the first tick tries.
    saveAuth({ accessToken: 'A', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 1000 }, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    let refreshCalls = 0;
    const result = await runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => (String(url).includes('/v1/events/stream')
        ? new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
        // A tiny lease so the renewal tick fires quickly.
        : new Response(JSON.stringify({ leaseMs: 2000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as never,
      refreshAccessTokenImpl: (async () => {
        refreshCalls += 1;
        // The first call (pre-connect) succeeds but hands back a token that is
        // ALREADY inside the window, so the renewal tick tries again and fails.
        if (refreshCalls === 1) {
          return { status: 'ok', tokens: { accessToken: 'B', refreshToken: 'rt2', expiresAtMs: Date.now() + 1000 } };
        }
        return { status: 'failed', message: 'refresh token revoked' };
      }) as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: { isTTY: false, on: () => {}, off: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} } as never,
      stdout: { write: () => true },
    });

    assert.equal(result.ok, false, 'must not report a clean exit');
    if (result.ok) return;
    assert.match(result.message, /revoked|login/i);
  });
});

describe('the terminal survives a termination signal', () => {
  it('registers handlers, restores raw mode, and re-raises', async () => {
    // Without this an external `kill` leaves the operator's SHELL not echoing
    // until they blindly type `reset`. (codex P2.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const registered = new Map<string, () => void>();
    const killed: string[] = [];
    let raw = false;
    const stdin = {
      isTTY: true,
      setRawMode(v: boolean) { raw = v; },
      resume() {}, pause() {}, setEncoding() {}, on() {}, off() {},
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => (String(url).includes('/v1/events/stream')
        ? new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))) as never,
      signals: {
        on: (sig, fn) => { registered.set(sig, fn); },
        off: (sig) => { registered.delete(sig); },
        kill: (_pid, sig) => { killed.push(sig); },
      },
      stdin: stdin as never,
      stdout: { write: () => true },
    });
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(registered.has('SIGTERM'), 'SIGTERM must be handled');
    assert.ok(registered.has('SIGHUP'), 'SIGHUP must be handled');
    assert.ok(!registered.has('SIGINT'), 'SIGINT belongs to the AGENT — raw mode suppresses it here anyway');
    assert.equal(raw, true, 'precondition: the console put the terminal in raw mode');

    registered.get('SIGTERM')!();
    assert.equal(raw, false, 'raw mode must be off before the process dies');
    assert.deepEqual(killed, ['SIGTERM'], 'and the signal re-raised for an honest exit status');
    void done;
  });
});

describe('joining seeds the screen before following it', () => {
  const seed = (over: Partial<{ raw: string; epoch: string; baseOffset: number; endOffset: number; prologue: string }> = {}) => ({
    raw: 'HELLO', epoch: 'e1', baseOffset: 0, endOffset: 5, ...over,
  });

  it('writes the current screen, not a blank one', () => {
    // An idle shell emits nothing, so a console consuming only FUTURE chunks
    // shows an empty terminal forever and reads as broken. (codex P1.)
    assert.equal(reconcileSeed(seed(), []), RESET + 'HELLO');
  });

  it('writes the prologue first, so a truncated replay lands on the right canvas', () => {
    // Those sticky modes — alt screen, scroll region, wrap — were set by an
    // escape older than the oldest retained byte. Without them the replay draws
    // on the wrong canvas from its first byte.
    assert.equal(reconcileSeed(seed({ prologue: '\x1b[?1049h' }), []), RESET + '\x1b[?1049hHELLO');
  });

  it('drops a held chunk the seed already contains', () => {
    // The seed and the tap overlap by construction; printing both duplicates
    // output, and in a terminal a duplicated escape sequence is not cosmetic.
    assert.equal(reconcileSeed(seed(), [{ data: 'LO', epoch: 'e1', startOffset: 3 }]), RESET + 'HELLO');
  });

  it('splices a chunk that straddles the seed boundary', () => {
    assert.equal(reconcileSeed(seed(), [{ data: 'LO WORLD', epoch: 'e1', startOffset: 3 }]), RESET + 'HELLO WORLD');
  });

  it('measures the overlap in UTF-8 BYTES, not code units', () => {
    // The daemon's offsets are byte offsets. Using String.length here
    // mis-slices every line an agent prints with box-drawing or emoji.
    const s = { raw: 'a😀', epoch: 'e1', baseOffset: 0, endOffset: 5 };   // 1 + 4 bytes
    assert.equal(reconcileSeed(s, [{ data: '😀b', epoch: 'e1', startOffset: 1 }]), RESET + 'a😀b');
  });

  it('does not splice a new epoch onto the old screen — it asks for a seed', () => {
    // A restarted PTY continues a screen this viewer has never had. Writing its
    // cursor-relative bytes onto the old one corrupts it permanently.
    const r = createOutputReconciler();
    assert.equal(r.applySeed(seed()), RESET + 'HELLO');
    const out = r.push({ data: 'FRESH', epoch: 'e2', startOffset: 0 });
    assert.match(out, /restarted/, 'the gap must be MARKED, never silent');
    assert.ok(!out.includes('FRESH'), 'and the bytes held, not spliced');
    assert.equal(r.takeReseedRequest(), 'new-epoch');
    assert.equal(r.applySeed({ raw: 'NEWSCREEN', epoch: 'e2', baseOffset: 0, endOffset: 9 }), RESET + 'NEWSCREEN');
  });

  it('still shows live output when no seed is available', () => {
    // A detached or briefly unreachable daemon 409s. Live output is better
    // than refusing to run.
    assert.equal(reconcileSeed(undefined, [{ data: 'later', epoch: 'e1', startOffset: 99 }]), 'later');
  });

  it('holds chunks until the seed lands, then replays them in order', () => {
    const r = createOutputReconciler();
    assert.equal(r.push({ data: 'X', epoch: 'e1', startOffset: 5 }), '', 'must not write before the seed');
    assert.equal(r.push({ data: 'Y', epoch: 'e1', startOffset: 6 }), '');
    assert.equal(r.applySeed(seed()), RESET + 'HELLOXY');
  });

  it('keeps trimming AFTER the seed, not only the held backlog', () => {
    // A chunk arriving just after the seed resolves can still overlap it.
    const r = createOutputReconciler();
    assert.equal(r.applySeed(seed()), RESET + 'HELLO');
    assert.equal(r.push({ data: 'LO!', epoch: 'e1', startOffset: 3 }), '!');
  });

  it('parses offsets off the wire — a frame without them is not silently dropped', () => {
    const frame = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    const sse = frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'a', epoch: 'e9', startOffset: 42 } })
      + frame({ type: 'yolobridge.output.chunk', data: { tileId: 't1', data: 'b' } });
    assert.deepEqual(extractOutputFrames(sse, 't1'), [
      { data: 'a', epoch: 'e9', startOffset: 42 },
      { data: 'b' },
    ]);
  });
});

describe('a discontinuity re-seeds instead of corrupting the screen', () => {
  const base = { raw: 'HELLO', epoch: 'e1', baseOffset: 0, endOffset: 5 };

  it('detects a HOLE — bytes starting past where we are', () => {
    // Dropped under the daemon's rate cap, or a relay frame that never
    // arrived. Splicing across it leaves cursor-relative output permanently
    // misaligned. (codex P1.)
    const r = createOutputReconciler();
    r.applySeed(base);
    const out = r.push({ data: 'LATER', epoch: 'e1', startOffset: 500 });
    assert.match(out, /skipped/);
    assert.ok(!out.includes('LATER'));
    assert.equal(r.takeReseedRequest(), 'lost-output');
  });

  it('holds everything after the gap until the new seed lands, then replays it', () => {
    const r = createOutputReconciler();
    r.applySeed(base);
    r.push({ data: 'A', epoch: 'e1', startOffset: 500 });          // the gap
    assert.equal(r.push({ data: 'B', epoch: 'e1', startOffset: 501 }), '', 'still held');
    const out = r.applySeed({ raw: 'SEED', epoch: 'e1', baseOffset: 0, endOffset: 500 });
    assert.equal(out, RESET + 'SEEDAB');
  });

  it('clears the request once read, so one gap does not re-seed forever', () => {
    const r = createOutputReconciler();
    r.applySeed(base);
    r.push({ data: 'X', epoch: 'e1', startOffset: 900 });
    assert.equal(r.takeReseedRequest(), 'lost-output');
    assert.equal(r.takeReseedRequest(), undefined);
  });

  it('does not ask for a seed on ordinary contiguous output', () => {
    // The expensive path must not fire on the normal case.
    const r = createOutputReconciler();
    r.applySeed(base);
    assert.equal(r.push({ data: ' WORLD', epoch: 'e1', startOffset: 5 }), ' WORLD');
    assert.equal(r.takeReseedRequest(), undefined);
  });

  it('does not ask for a seed on a pure overlap', () => {
    const r = createOutputReconciler();
    r.applySeed(base);
    assert.equal(r.push({ data: 'LO', epoch: 'e1', startOffset: 3 }), '');
    assert.equal(r.takeReseedRequest(), undefined);
  });

  it('bounds what it holds when a seed never lands', () => {
    // A sleeping laptop must not grow this process without limit.
    const r = createOutputReconciler();
    for (let i = 0; i < 400; i++) r.push({ data: 'x'.repeat(4096), epoch: 'e1', startOffset: i * 4096 });
    const out = r.applySeed(undefined);
    assert.ok(out.length <= 512 * 1024 + 4096, `held buffer is unbounded: ${out.length}`);
    assert.ok(out.length > 0, 'and it keeps the RECENT bytes rather than nothing');
  });

  it('keeps holding when the backlog itself contains a second discontinuity', () => {
    // Draining the backlog can trip another reseed partway through; the chunks
    // after that point must not be written blind.
    const r = createOutputReconciler();
    r.push({ data: '<PRE>', epoch: 'e1', startOffset: 5 });
    r.push({ data: '<GAP>', epoch: 'e2', startOffset: 0 });
    r.push({ data: '<POST>', epoch: 'e2', startOffset: 5 });
    const out = r.applySeed(base);
    assert.ok(out.includes('<PRE>'), 'pre-gap bytes still apply');
    assert.ok(!out.includes('<GAP>'), 'the chunk that tripped the gap must be held');
    assert.ok(!out.includes('<POST>'), 'and so must everything after it');
    assert.equal(r.takeReseedRequest(), 'new-epoch');
    // The held pair replays once a seed for the NEW epoch lands.
    assert.equal(
      r.applySeed({ raw: '', epoch: 'e2', baseOffset: 0, endOffset: 0 }),
      RESET + '<GAP><POST>',
    );
  });
});

describe('teardown does not eat the last keystroke', () => {
  it('drains what is queued, and refuses anything new', async () => {
    // A command typed and then followed straight away by the detach chord sits
    // inside the coalescing window; disposing alone drops it silently while
    // the operator watched themselves type it. (codex P2.)
    const sent: string[] = [];
    const sender = createOrderedInputSender({ coalesceMs: 50, send: async (p) => { sent.push(p); } });
    sender.push('deploy\r');
    await sender.drain();
    assert.deepEqual(sent, ['deploy\r'], 'the queued bytes must reach the agent');
    sender.push('too-late');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(sent, ['deploy\r'], 'but nothing new is accepted after drain');
  });

  it('also drains bytes stuck behind an in-flight request', async () => {
    let release: (() => void) | undefined;
    const sent: string[] = [];
    let n = 0;
    const sender = createOrderedInputSender({
      coalesceMs: 1,
      send: async (p) => {
        n += 1;
        if (n === 1) await new Promise<void>((r) => { release = r; });
        sent.push(p);
      },
    });
    sender.push('first');
    await new Promise((r) => setTimeout(r, 10));   // 'first' in flight
    sender.push('second');
    const drained = sender.drain();
    release!();
    await drained;
    assert.deepEqual(sent, ['first', 'second']);
  });

  it('drain terminates even with nothing queued', async () => {
    const sender = createOrderedInputSender({ coalesceMs: 1, send: async () => {} });
    await sender.drain();   // must not hang
  });
});

describe('a gap found while draining the backlog is not forgotten', () => {
  it('leaves a reseed request the caller can see after applySeed', async () => {
    // The stream loop already checked these chunks when they arrived, so if
    // nothing looks again the reconciler stays unseeded and holds every later
    // byte forever — a console frozen with no error. (codex P1.)
    const r = createOutputReconciler();
    r.push({ data: 'held', epoch: 'e2', startOffset: 0 });
    r.applySeed({ raw: 'S', epoch: 'e1', baseOffset: 0, endOffset: 1 });
    assert.equal(r.takeReseedRequest(), 'new-epoch', 'the drain-discovered gap must be reported');
  });

  it('the console re-seeds off that request rather than freezing', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    let seedCalls = 0;
    const out: string[] = [];
    const encoder = new TextEncoder();
    const frame = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

    const fetchImpl = async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u.includes('/v1/events/stream')) {
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            // Arrives while the FIRST seed request is still in flight, and is
            // from a different epoch — so the gap is discovered by the drain.
            c.enqueue(encoder.encode(frame({
              type: 'yolobridge.output.chunk',
              data: { tileId: 't1', data: 'NEWPTY', epoch: 'e2', startOffset: 0 },
            })));
          },
        }), { status: 200 });
      }
      if (u.includes('/output?mode=raw')) {
        seedCalls += 1;
        // First seed is the OLD epoch; the second is the new one.
        const body = seedCalls === 1
          ? { raw: 'OLD', epoch: 'e1', baseOffset: 0, endOffset: 3 }
          : { raw: 'NEWSCREEN', epoch: 'e2', baseOffset: 0, endOffset: 9 };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: fetchImpl as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: { isTTY: false, on: () => {}, off: () => {}, resume: () => {}, pause: () => {}, setEncoding: () => {} } as never,
      stdout: { write: (s: string) => { out.push(s); return true; } },
    });
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(seedCalls >= 2, `the drain-discovered gap must trigger a second seed (saw ${seedCalls})`);
    assert.ok(out.join('').includes('NEWSCREEN'), 'and the new screen must actually reach the terminal');
    void done;
  });
});

describe('teardown holds nothing hostage', () => {
  const idleStream = () => new ReadableStream<Uint8Array>({ start() {} });

  function fakeTTY() {
    const listeners: Array<(c: Buffer | string) => void> = [];
    let raw = false;
    const stdin = {
      isTTY: true,
      setRawMode(v: boolean) { raw = v; },
      resume() {}, pause() {}, setEncoding() {},
      on(_e: string, fn: (c: Buffer | string) => void) { listeners.push(fn); },
      off(_e: string, fn: (c: Buffer | string) => void) {
        const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
      },
      type(s: string) { for (const fn of [...listeners]) fn(s); },
      get rawMode() { return raw; },
      get listenerCount() { return listeners.length; },
    };
    return stdin;
  }

  function baseDeps(io: ReturnType<typeof fakeIO>, fetchImpl: unknown, stdin: unknown) {
    return {
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: fetchImpl as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: stdin as never,
      stdout: { write: () => true },
    };
  }

  it('detaches promptly even while the seed request is stalled', async () => {
    // Awaiting the seed on the way out put terminal restoration behind a
    // request with no bound — raw mode for its whole duration. (codex P1.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const stdin = fakeTTY();
    const done = runConsole(baseDeps(io, async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/v1/events/stream')) return new Response(idleStream(), { status: 200 });
      // The seed NEVER answers.
      if (u.includes('/output?mode=raw')) return new Promise<Response>(() => {});
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, stdin));

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(stdin.rawMode, true, 'precondition: raw mode is on');
    stdin.type('\x10');
    stdin.type('\x11');

    const raced = await Promise.race([done, new Promise((r) => setTimeout(() => r('HUNG'), 2000))]);
    assert.notEqual(raced, 'HUNG', 'a stalled seed must not hold the terminal in raw mode');
    assert.equal(stdin.rawMode, false);
  });

  it('cleans up input even when the output stream throws', async () => {
    // A rejected read jumps straight to catch; cleaning up at the end of the
    // happy path would leave a timer able to fire afterwards. (codex P2.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const stdin = fakeTTY();
    const failing = new ReadableStream<Uint8Array>({
      start(c) { c.error(new Error('relay died')); },
    });
    const result = await runConsole(baseDeps(io, async (url: string | URL) => (String(url).includes('/v1/events/stream')
      ? new Response(failing, { status: 200 })
      : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })), stdin));

    assert.equal(result.ok, false);
    assert.equal(stdin.rawMode, false, 'the terminal is restored on the error path too');
    assert.equal(stdin.listenerCount, 0, 'and stdin is unhooked, so nothing can be sent afterwards');
  });

  it('never delivers a keystroke after it has reported failure', async () => {
    // The real hazard of cleaning up only on the happy path: a rejected read
    // jumps to catch, and the coalescing timer fires afterwards — typing into
    // the operator's shell after they were handed it back. (codex P2.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const inputsAt: number[] = [];
    let resolvedAt = Infinity;
    const stdin = fakeTTY();
    let errorStream!: ReadableStreamDefaultController<Uint8Array>;
    const failing = new ReadableStream<Uint8Array>({ start(c) { errorStream = c; } });

    const done = runConsole(baseDeps(io, async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/v1/events/stream')) return new Response(failing, { status: 200 });
      if (u.includes('/input')) { inputsAt.push(Date.now()); }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, stdin));

    await new Promise((r) => setTimeout(r, 30));
    stdin.type('x');                 // queued inside the coalescing window
    errorStream.error(new Error('relay died'));
    await done;
    resolvedAt = Date.now();
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(
      inputsAt.every((t) => t <= resolvedAt),
      'a send fired after the console returned — cleanup did not run on the error path',
    );
  });
});

describe('drain has no silent data cap', () => {
  it('delivers a paste far larger than any fixed iteration count', async () => {
    // A fixed 64-round loop at MAX_INPUT_CHUNK per round quietly discarded
    // everything past ~256KiB. The operator watched themselves paste it.
    // (codex P2.)
    const sent: string[] = [];
    const sender = createOrderedInputSender({
      coalesceMs: 1, maxChunk: 64, send: async (p) => { sent.push(p); },
    });
    const paste = 'z'.repeat(64 * 200);   // 200 chunks — well past any cap
    sender.push(paste);
    await sender.drain();
    sender.dispose();
    assert.equal(sent.join(''), paste, 'every byte must arrive');
    assert.ok(sent.length >= 200, `expected ~200 chunks, sent ${sent.length}`);
  });

  it('terminates even when every send fails', async () => {
    // Progress comes from consuming `pending`, not from the send succeeding.
    const errors: unknown[] = [];
    const sender = createOrderedInputSender({
      coalesceMs: 1, maxChunk: 4,
      onError: (e) => errors.push(e),
      send: async () => { throw new Error('nope'); },
    });
    sender.push('x'.repeat(400));
    const raced = await Promise.race([
      sender.drain().then(() => 'done'),
      new Promise((r) => setTimeout(() => r('HUNG'), 3000)),
    ]);
    assert.equal(raced, 'done');
    assert.ok(errors.length >= 100, `every failure is reported: ${errors.length}`);
    sender.dispose();
  });
});

describe('teardown returns the shell even when input cannot be delivered', () => {
  it('gives up on a send that never settles, and says how much was lost', async () => {
    // No bound at all means the operator presses the detach chord, gets their
    // terminal restored, and then never gets their SHELL back. (codex P2.)
    const sender = createOrderedInputSender({
      coalesceMs: 1,
      send: () => new Promise(() => {}),      // never settles
    });
    sender.push('abcdefgh');
    await new Promise((r) => setTimeout(r, 10));   // one chunk in flight
    sender.push('ijkl');

    const started = Date.now();
    const report = await sender.drain(150);
    const elapsed = Date.now() - started;
    sender.dispose();

    assert.ok(elapsed < 2000, `drain must not wait forever (waited ${elapsed}ms)`);
    assert.equal(report.undelivered, 4, 'and must report the bytes that never left');
  });

  it('reports nothing lost on a healthy link', async () => {
    const sender = createOrderedInputSender({ coalesceMs: 1, send: async () => {} });
    sender.push('hello');
    const report = await sender.drain(1000);
    assert.equal(report.undelivered, 0);
    sender.dispose();
  });

  it('the timeout is generous enough not to truncate real typing', () => {
    assert.ok(DEFAULT_DRAIN_TIMEOUT_MS >= 1000, 'must not clip a slow-but-working link');
  });

  it('the console itself returns while an input POST hangs', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const listeners: Array<(c: string) => void> = [];
    let raw = false;
    const stdin = {
      isTTY: true,
      setRawMode(v: boolean) { raw = v; },
      resume() {}, pause() {}, setEncoding() {},
      on(_e: string, fn: (c: string) => void) { listeners.push(fn); },
      off(_e: string, fn: (c: string) => void) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      type(s: string) { for (const fn of [...listeners]) fn(s); },
      get rawMode() { return raw; },
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v1/events/stream')) return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
        if (u.includes('/input')) return new Promise<Response>(() => {});   // hangs forever
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: stdin as never,
      stdout: { write: () => true },
    });

    await new Promise((r) => setTimeout(r, 30));
    stdin.type('whoami\r');
    await new Promise((r) => setTimeout(r, 20));
    stdin.type('\x10'); stdin.type('\x11');

    const raced = await Promise.race([done, new Promise((r) => setTimeout(() => r('HUNG'), 8000))]);
    assert.notEqual(raced, 'HUNG', 'a wedged input POST must not keep the process alive');
    assert.equal(raw, false);
  });
});

describe('stored identifiers are a matched set', () => {
  const storeLocal = (io: ReturnType<typeof fakeIO>) => {
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'local-ws', tileId: 'local-tile', attachmentId: 'local-att', attachedAt: new Date().toISOString() }, ENV, io);
  };

  it('refuses to pair a named workspace with this machine\'s attachment', () => {
    // Otherwise `yolo-bridge console other-ws` goes looking for a LOCAL
    // attachment inside someone else's workspace. (codex P2.)
    const io = fakeIO();
    storeLocal(io);
    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io, workspaceId: 'other-ws' });
    assert.equal(target.ok, false);
    if (target.ok) return;
    assert.equal(target.reason, 'no-target');
    assert.match(target.message, /--attachment/);
  });

  it('still uses the pair when the named workspace IS the stored one', () => {
    const io = fakeIO();
    storeLocal(io);
    const target = resolveConsoleTarget({ commonApiBaseUrl: 'https://api.example', env: ENV, io, workspaceId: 'local-ws' });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.attachmentId, 'local-att');
    assert.equal(target.tileId, 'local-tile');
  });

  it('accepts an explicit attachment in any workspace', () => {
    const io = fakeIO();
    storeLocal(io);
    const target = resolveConsoleTarget({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      workspaceId: 'other-ws', attachmentId: 'other-att',
    });
    assert.equal(target.ok, true);
    if (!target.ok) return;
    assert.equal(target.workspaceId, 'other-ws');
    assert.equal(target.attachmentId, 'other-att');
    assert.equal(target.tileId, undefined);
  });
});

describe('a stalled unsubscribe does not keep the process alive', () => {
  it('lets go of teardown even when the API never answers', async () => {
    // `fetch` has no timeout of its own; awaiting it left the terminal
    // restored and the shell prompt never returned. (codex P2.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const listeners: Array<(c: string) => void> = [];
    const stdin = {
      isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
      on(_e: string, fn: (c: string) => void) { listeners.push(fn); },
      off(_e: string, fn: (c: string) => void) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      type(s: string) { for (const fn of [...listeners]) fn(s); },
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v1/events/stream')) return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
        if (u.includes('/output/unsubscribe')) return new Promise<Response>(() => {});   // never answers
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: stdin as never,
      stdout: { write: () => true },
    });

    await new Promise((r) => setTimeout(r, 30));
    stdin.type('\x10'); stdin.type('\x11');

    const raced = await Promise.race([done, new Promise((r) => setTimeout(() => r('HUNG'), 6000))]);
    assert.notEqual(raced, 'HUNG', 'a best-effort cleanup must be genuinely best-effort');
  });
});

describe('a renewal cannot outlive teardown', () => {
  it('never re-subscribes after the unsubscribe has gone out', async () => {
    // Clearing the interval does not stop a callback already running. A
    // renewal landing after teardown recreates the subscription and leaves the
    // daemon streaming to nobody until that fresh lease expires. (codex P2.)
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);

    const calls: string[] = [];
    let releaseRenewal: (() => void) | undefined;
    let subscribeCount = 0;

    const listeners: Array<(c: string) => void> = [];
    const stdin = {
      isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
      on(_e: string, fn: (c: string) => void) { listeners.push(fn); },
      off(_e: string, fn: (c: string) => void) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      type(s: string) { for (const fn of [...listeners]) fn(s); },
    };

    const done = runConsole({
      commonApiBaseUrl: 'https://api.example', env: ENV, io,
      fetchImpl: (async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/v1/events/stream')) {
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
        }
        if (u.includes('/output/subscribe')) {
          subscribeCount += 1;
          // The SECOND subscribe is the renewal: hold it open across the detach.
          if (subscribeCount === 2) await new Promise<void>((r) => { releaseRenewal = r; });
          calls.push('subscribe');
          // A short lease so the renewal tick fires quickly.
          return new Response(JSON.stringify({ leaseMs: 2000 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.includes('/output/unsubscribe')) { calls.push('unsubscribe'); }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as never,
      signals: { on: () => {}, off: () => {}, kill: () => {} },
      stdin: stdin as never,
      stdout: { write: () => true },
    });

    // Wait for the renewal tick (lease 2000ms → every ~1000ms) to be in flight.
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(releaseRenewal, 'precondition: a renewal is in flight');

    stdin.type('\x10'); stdin.type('\x11');
    await new Promise((r) => setTimeout(r, 20));
    releaseRenewal!();
    await done;
    await new Promise((r) => setTimeout(r, 100));

    const last = calls.lastIndexOf('unsubscribe');
    assert.ok(last >= 0, `teardown must unsubscribe: ${calls.join(',')}`);
    assert.ok(
      !calls.slice(last + 1).includes('subscribe'),
      `a renewal re-subscribed after teardown: ${calls.join(',')}`,
    );
  });
});

describe('a seedless start still detects discontinuities', () => {
  it('bootstraps the position from the first offset-bearing chunk', () => {
    // Otherwise a recoverable seed failure silently disables corruption
    // detection for the whole session. (codex P2.)
    const r = createOutputReconciler();
    assert.equal(r.applySeed(undefined), '', 'no seed available');
    assert.equal(r.push({ data: 'abc', epoch: 'e1', startOffset: 10 }), 'abc');
    assert.equal(r.takeReseedRequest(), undefined, 'the first chunk is not itself a gap');

    // Now a hole, which must be caught even though we never had a seed.
    const out = r.push({ data: 'zzz', epoch: 'e1', startOffset: 900 });
    assert.match(out, /skipped/);
    assert.equal(r.takeReseedRequest(), 'lost-output');
  });

  it('and detects a restarted PTY after a seedless start', () => {
    const r = createOutputReconciler();
    r.applySeed(undefined);
    r.push({ data: 'abc', epoch: 'e1', startOffset: 0 });
    const out = r.push({ data: 'new', epoch: 'e2', startOffset: 0 });
    assert.match(out, /restarted/);
    assert.equal(r.takeReseedRequest(), 'new-epoch');
  });

  it('still follows contiguous output after bootstrapping', () => {
    const r = createOutputReconciler();
    r.applySeed(undefined);
    r.push({ data: 'ab', epoch: 'e1', startOffset: 0 });
    assert.equal(r.push({ data: 'cd', epoch: 'e1', startOffset: 2 }), 'cd');
    assert.equal(r.push({ data: 'cd', epoch: 'e1', startOffset: 2 }), '', 'and still trims a repeat');
    assert.equal(r.takeReseedRequest(), undefined);
  });

  it('does not choke on a daemon that sends no offsets at all', () => {
    // An older daemon predates raw seeding. It must still work, just without
    // discontinuity detection — degrade, never brick.
    const r = createOutputReconciler();
    r.applySeed(undefined);
    assert.equal(r.push({ data: 'x' }), 'x');
    assert.equal(r.push({ data: 'y' }), 'y');
    assert.equal(r.takeReseedRequest(), undefined);
  });
});

describe('a replay lands on a clean screen', () => {
  it('resets the terminal before the seed, and before the prologue', () => {
    // A replay's newlines and cursor moves are relative. Written onto the
    // console's own banner — or onto the PREVIOUS rendering during a resync —
    // it lands shifted, and the resync doubles the screen it meant to repair.
    // (codex P1.)
    const out = reconcileSeed({ raw: 'S', epoch: 'e1', baseOffset: 0, endOffset: 1, prologue: '\x1b[?1049h' }, []);
    assert.ok(out.startsWith(RESET), 'the reset must come first of all');
    assert.equal(out.indexOf(RESET), out.lastIndexOf(RESET), 'exactly once');
    assert.ok(out.indexOf('\x1b[?1049h') < out.indexOf('S'), 'prologue still precedes the replay');
  });

  it('resets again on every RESYNC, not only the first seed', () => {
    const r = createOutputReconciler();
    r.applySeed({ raw: 'FIRST', epoch: 'e1', baseOffset: 0, endOffset: 5 });
    r.push({ data: 'z', epoch: 'e2', startOffset: 0 });     // discontinuity
    const out = r.applySeed({ raw: 'SECOND', epoch: 'e2', baseOffset: 0, endOffset: 6 });
    assert.ok(out.startsWith(RESET), 'the resync must clear what it is replacing');
  });

  it('does NOT reset when there is no replay to write', () => {
    // Clearing the screen with nothing to put back would destroy output the
    // operator can still read.
    assert.equal(reconcileSeed(undefined, [{ data: 'live' }]), 'live');
  });
});
