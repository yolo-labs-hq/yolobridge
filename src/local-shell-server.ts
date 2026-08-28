/**
 * A terminal on the operator's OWN machine, served over loopback.
 *
 * This is what "open terminal" in a YoloBridge tile connects to. The browser
 * talks to `127.0.0.1` directly, so a keystroke never leaves the machine that
 * is rendering it.
 *
 * WHY NOT THE CLOUD RELAY
 * -----------------------
 * The obvious implementation routes keystrokes browser → common-api → daemon.
 * Measured from a real operator machine that is ~200ms of echo latency, to type
 * into a shell running on the same laptop as the browser. SSH on a LAN is under
 * 5ms; 200ms is where characters visibly trail your fingers. Measured over this
 * path on that same machine: **p50 6.9ms, p95 8.0ms**, and that figure includes
 * bash actually executing the command, so the transport itself is a fraction of
 * it.
 *
 * ⚠️ THIS IS NOT THE AGENT'S PTY. `local-agent.ts` owns exactly one PTY — the
 * agent `attach` spawned — and Decision Q3 ("one tile per attach") keeps it a
 * singleton. This module spawns SEPARATE shells and is a Map, because "give me
 * a terminal" is a different request from "show me the agent". Mixing them
 * would mean every glance at a running agent shares a keyboard with it.
 *
 * WHY THREE BROWSER MECHANISMS ARE HANDLED, not one — each fails differently,
 * and getting any of them wrong looks identical to "browsers refuse loopback":
 *
 *   1. MIXED CONTENT — an https page loading http:// is normally blocked;
 *      loopback is exempt as a potentially-trustworthy origin.
 *   2. CORS — cross-origin, so an explicit allow-origin. Never `*`: that would
 *      let any page on the internet reach a shell on this machine.
 *   3. PRIVATE NETWORK ACCESS — Chrome preflights public→private and requires
 *      `Access-Control-Allow-Private-Network: true` in response.
 *
 * Verified against Chrome 140 at default security settings (spike, 2026-08-28):
 * a page on https://yolo.studio reached this successfully. Firefox 153 was
 * INCONCLUSIVE headless — the fetch hung rather than being refused, most likely
 * its Local Network Access prompt with nobody present to answer it. Which is
 * why the client must treat "no answer" as a timeout and fall back, never wait
 * forever.
 *
 * ⚠️ KNOWN GAP — RECONNECT FIDELITY FOR TUIs. The backlog is a byte TAIL, cut
 * at a parser-safe boundary. That is enough to resume a shell transcript, and
 * NOT enough to reconstruct a full-screen TUI that painted its layout once and
 * then emitted more than `BACKLOG_CHARS` of cursor-addressed updates: a viewer
 * reconnecting mid-session gets the updates without the screen they address,
 * and sticky modes set before the window are lost. The cloud path already
 * solved this properly — `local-agent.ts` keeps an `@xterm/headless` mirror and
 * serves a serialized screen plus a mode `prologue` — and `@xterm/headless` is
 * already a dependency here. Doing the same for these shells is the next slice;
 * it is called out rather than left to be discovered. (codex P2.)
 *
 * SECURITY, deliberately narrow because this hands out shells:
 *   · bound to 127.0.0.1 ONLY — never 0.0.0.0, so it is off the local network
 *     entirely (verified: a connect to the machine's own LAN IP is refused at
 *     the TCP level, not merely firewalled);
 *   · a random secret per daemon run, compared in constant time;
 *   · one explicit allowed origin;
 *   · sessions are capped and idle-reaped, so a forgotten tab cannot leave
 *     shells accumulating forever;
 *   · PTY bytes are NEVER logged. They are the operator's live screen and
 *     include whatever they type, passwords included.
 */

import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);

/** Minimal shape of the node-pty process this module needs. */
export interface ShellPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  readonly pid: number;
}

export type ShellSpawn = (opts: { cols: number; rows: number }) => ShellPty;

/** How much recent output a late-joining viewer replays. */
export const BACKLOG_CHARS = 64 * 1024;
/** Shells with no viewer for this long are killed. */
export const IDLE_REAP_MS = 5 * 60_000;
/** Hard cap on concurrent shells from one daemon. */
export const MAX_SESSIONS = 8;
/** Largest single input payload accepted. */
export const MAX_INPUT_CHARS = 8192;

/**
 * Trim the replay buffer to a point a terminal can safely resume from.
 *
 * ⚠️ A NAIVE `slice(-N)` CORRUPTS THE SCREEN, and so does guessing. The backlog
 * is a raw PTY byte stream: an arbitrary cut can land inside a CSI, OSC or DCS
 * sequence, and a viewer that resumes there does not get a slightly-wrong
 * screen — it takes escape fragments as literal text, or applies half a mode
 * change, and stays wrong forever.
 *
 * ⚠️ AND LOOKING *FORWARD* FOR AN ESCAPE IS NOT ENOUGH — the first version of
 * this did exactly that and was wrong twice over: the introducer that put the
 * stream mid-sequence may sit BEFORE the cut where a forward scan cannot see
 * it, and a newline does not terminate an OSC string, so "cut at the next
 * newline" can land inside one. (codex P2.)
 *
 * So the parser state is actually tracked. `groundCutAt` walks a minimal VT
 * state machine and returns the first offset at or after `from` where the
 * stream is in GROUND state — no partial sequence, no partial surrogate.
 *
 * This is correct to scan from index 0 because of an invariant this function
 * maintains: **the backlog always begins in ground state**. Every trim cuts to
 * a ground offset, so the next scan starts from one.
 */
function groundCutAt(buf: string, from: number): number {
  type State = 'ground' | 'esc' | 'csi' | 'str';
  let state: State = 'ground';
  let i = 0;
  // Walk to `from`, tracking state; then keep walking until ground.
  while (i < buf.length) {
    if (i >= from && state === 'ground') {
      const code = buf.charCodeAt(i);
      // Never resume on the low half of a surrogate pair.
      if (!(code >= 0xdc00 && code <= 0xdfff)) return i;
    }
    const ch = buf[i];
    const code = buf.charCodeAt(i);
    switch (state) {
      case 'ground':
        if (code === 0x1b) state = 'esc';
        break;
      case 'esc':
        // `[` opens a CSI; `]`, `P`, `X`, `^`, `_` open string-terminated
        // sequences (OSC/DCS/SOS/PM/APC).
        if (ch === '[') state = 'csi';
        else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') state = 'str';
        // ⚠️ INTERMEDIATE BYTES (0x20-0x2F) DO NOT END THE SEQUENCE. `ESC ( B`
        // — a charset designation — is three bytes, and treating `(` as the
        // end marks the boundary before `B` as ground. Trimming there replays
        // a bare `B` as ordinary text and silently drops the charset switch,
        // which is precisely the "parser-safe boundary" this function promises
        // not to do. Per ECMA-48, stay in escape until a FINAL byte
        // (0x30-0x7E). (codex P2.)
        else if (code >= 0x20 && code <= 0x2f) { /* intermediate — still escaping */ }
        else state = 'ground';
        break;
      case 'csi':
        // Parameters and intermediates, terminated by a final byte 0x40-0x7E.
        if (code >= 0x40 && code <= 0x7e) state = 'ground';
        break;
      case 'str':
        // BEL, or ST (ESC \). A newline does NOT end these — which is exactly
        // what the previous newline shortcut got wrong.
        if (code === 0x07) state = 'ground';
        else if (code === 0x1b && buf[i + 1] === '\\') { state = 'ground'; i += 1; }
        break;
    }
    i += 1;
  }
  return buf.length;
}

/**
 * Drop the oldest bytes, cutting only at a resumable boundary.
 *
 * The cut only ever moves FORWARD, so it can never resurrect bytes that were
 * already meant to be gone.
 */
export function trimBacklog(buf: string, limit = BACKLOG_CHARS): string {
  if (buf.length <= limit) return buf;
  return buf.slice(groundCutAt(buf, buf.length - limit));
}

/**
 * One connected viewer, plus what it is doing about keeping up.
 *
 * ⚠️ A VIEWER THAT STOPS READING MUST NOT GROW THE DAEMON. `res.write()`
 * returns false once the socket buffer is full; ignoring that lets Node queue
 * every subsequent chunk with no bound, so a noisy command plus one stalled tab
 * exhausts the memory of the process that owns the operator's shells — and the
 * stalled viewer also blocks idle reaping, because it still counts as a viewer.
 * Output is DROPPED for a saturated viewer, not queued. (codex P1.)
 */
interface Viewer {
  res: http.ServerResponse;
  /** Socket buffer is full; writes are dropped until it drains. */
  saturated: boolean;
  /** Bytes discarded while saturated, reported once it recovers. */
  dropped: number;
}

interface Session {
  id: string;
  pty: ShellPty;
  backlog: string;
  viewers: Set<Viewer>;
  lastViewerAtMs: number;
  exited: boolean;
}

export interface LocalShellServerHandle {
  /** `http://127.0.0.1:<port>` — what the browser connects to. */
  readonly url: string;
  readonly port: number;
  /** The bound address. MUST be `127.0.0.1`; exposed so a test can pin it. */
  readonly host: string;
  /** Per-run secret. Never persisted; see the daemon's reporting path. */
  readonly secret: string;
  readonly sessionCount: number;
  close(): Promise<void>;
}

export interface LocalShellServerOptions {
  /** The single browser origin allowed to reach this. */
  allowedOrigin: string;
  /** Injectable so tests need no real PTY. */
  spawnShell?: ShellSpawn;
  /** Injectable clock for the idle reaper. */
  now?: () => number;
  idleReapMs?: number;
  maxSessions?: number;
}

function defaultSpawn(): ShellSpawn {
  const pty = require('node-pty');
  return ({ cols, rows }) => pty.spawn(
    process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
    [],
    { name: 'xterm-256color', cols, rows, cwd: process.env.HOME, env: process.env },
  ) as ShellPty;
}

/**
 * Constant-time secret comparison that cannot throw on a length mismatch.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and a thrown
 * comparison is both a crash and a length oracle. The length check short-
 * circuits first, which leaks only the length — already visible from the URL.
 */
export function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function startLocalShellServer(
  opts: LocalShellServerOptions,
): Promise<LocalShellServerHandle> {
  const allowedOrigin = opts.allowedOrigin;
  const spawnShell = opts.spawnShell ?? defaultSpawn();
  const now = opts.now ?? Date.now;
  const idleReapMs = opts.idleReapMs ?? IDLE_REAP_MS;
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const secret = randomBytes(24).toString('hex');
  const sessions = new Map<string, Session>();

  const killSession = (s: Session) => {
    // ⚠️ RE-ENTRANT. `kill()` may fire `onExit` SYNCHRONOUSLY — the interface
    // permits it and real PTYs do it — which calls straight back in here.
    // Without this guard the second entry kills again, recursing until the
    // stack blows. Checked BEFORE the flag is set, not after. (codex P2.)
    if (s.exited) return;
    s.exited = true;
    for (const v of s.viewers) { try { v.res.end(); } catch { /* already gone */ } }
    s.viewers.clear();
    try { s.pty.kill(); } catch { /* already dead */ }
    sessions.delete(s.id);
  };

  /**
   * Send one chunk to one viewer, dropping rather than queueing when it is
   * behind. See `Viewer` for why.
   *
   * The loss is REPORTED when the socket recovers — a viewer that silently
   * skipped output would render a screen that is wrong with no indication,
   * which is worse than a visible gap. Same discipline as the cloud path's
   * `droppedBytes`.
   */
  const writeToViewer = (session: Session, v: Viewer, data: string) => {
    if (v.saturated) { v.dropped += data.length; return; }
    let ok = false;
    try { ok = v.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { return; }
    if (ok) return;
    v.saturated = true;
    v.res.once('drain', () => {
      v.saturated = false;
      if (v.dropped > 0) {
        const n = v.dropped;
        v.dropped = 0;
        // Marked inline, where the gap actually happened.
        try {
          v.res.write(`data: ${JSON.stringify(`\r\n\u001b[33m── ${n} bytes skipped — viewer fell behind ──\u001b[0m\r\n`)}\n\n`);
        } catch { /* gone */ }
      }
      // Re-seed from the retained tail so the screen is coherent again rather
      // than resuming mid-stream after a hole.
      try { v.res.write(`data: ${JSON.stringify(session.backlog)}\n\n`); } catch { /* gone */ }
    });
  };

  const reaper = setInterval(() => {
    const t = now();
    for (const s of [...sessions.values()]) {
      // ⚠️ Only reap shells nobody is watching. A viewer that is merely quiet
      // is still a viewer — killing on output-silence would take out an idle
      // shell the operator is about to type into.
      if (s.viewers.size === 0 && t - s.lastViewerAtMs > idleReapMs) killSession(s);
    }
  }, Math.max(1000, Math.floor(idleReapMs / 4)));
  (reaper as { unref?: () => void }).unref?.();

  /** CORS + Private Network Access. See this file's header for why all three. */
  const applyCors = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.headers.origin === allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // Liveness probe. Deliberately UNAUTHENTICATED and content-free: it exists
    // so a viewer can discover whether this machine is the one running the
    // daemon before it has any reason to hold a secret. It reveals only that
    // something is listening, which the TCP connect already revealed.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'yolo-bridge-local-shell' }));
      return;
    }

    if (!secretMatches(url.searchParams.get('secret'), secret)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (url.pathname === '/open' && req.method === 'POST') {
      if (sessions.size >= maxSessions) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `at most ${maxSessions} local terminals` }));
        return;
      }
      const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 100));
      const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 30));
      const id = randomBytes(9).toString('hex');
      let pty: ShellPty;
      try {
        pty = spawnShell({ cols, rows });
      } catch (err) {
        // ⚠️ A THROW HERE WOULD KILL THE WHOLE DAEMON. This runs inside the
        // HTTP request callback, so an unhandled exception takes the process
        // down — and with it the agent PTY and every other live terminal —
        // because one `$SHELL` pointed at a missing binary. Report it and
        // leave everything else running. (codex P2.)
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'could not start a shell',
          detail: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      const session: Session = { id, pty, backlog: '', viewers: new Set(), lastViewerAtMs: now(), exited: false };
      // ⚠️ REGISTER FIRST, SUBSCRIBE SECOND. A short-lived shell can fire
      // `onExit` the instant the callback is attached — before `sessions.set`
      // would have run. `killSession` would then delete nothing, and the
      // already-dead session would be inserted afterwards, unreachable (404 on
      // every request) yet still holding a slot against the session cap, and
      // unremovable because `killSession` returns early once `exited` is set.
      // A slow leak of the one resource that is capped. (codex P1.)
      sessions.set(id, session);
      pty.onData((data) => {
        // ⚠️ NEVER LOG THIS. It is the operator's live screen.
        session.backlog = trimBacklog(session.backlog + data);
        for (const viewer of session.viewers) writeToViewer(session, viewer, data);
      });
      pty.onExit(() => { killSession(session); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: id, cols, rows }));
      return;
    }

    const session = sessions.get(url.searchParams.get('session') ?? '');
    if (!session || session.exited) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no such session' }));
      return;
    }

    if (url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // ⚠️ FLUSH THE HEADERS IMMEDIATELY. Node holds them until the first
      // write, so a stream opened on a shell that has not printed anything yet
      // never sends its response head at all — and the client's `fetch` hangs
      // waiting for it, indefinitely. A fresh shell is exactly that case.
      //
      // An SSE comment is the standard way to do this: legal, ignored by
      // EventSource, and it doubles as a "connected" signal the client can use
      // to distinguish "attached and quiet" from "never got there".
      res.write(': connected\n\n');

      // Replay next, so a reconnecting viewer sees the screen rather than
      // waiting for the next keypress to produce output.
      if (session.backlog) res.write(`data: ${JSON.stringify(session.backlog)}\n\n`);
      const viewer: Viewer = { res, saturated: false, dropped: 0 };
      session.viewers.add(viewer);
      session.lastViewerAtMs = now();
      req.on('close', () => {
        session.viewers.delete(viewer);
        session.lastViewerAtMs = now();
      });
      return;
    }

    if (url.pathname === '/input' && req.method === 'POST') {
      // ⚠️ COLLECT BYTES, DECODE ONCE. `body += chunk` decodes each Buffer
      // independently, so a multibyte character split across a TCP chunk
      // boundary becomes two replacement characters — silently corrupting
      // pasted or typed Unicode, depending on how the network happened to
      // fragment it. (codex P2.)
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        // Bounded before parsing: an unbounded body is a memory DoS on a
        // process that owns the operator's shells.
        if (size > MAX_INPUT_CHARS * 4) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))?.data;
          if (typeof data === 'string' && data.length <= MAX_INPUT_CHARS) session.pty.write(data);
        } catch { /* malformed body is not worth an error page */ }
        res.writeHead(204); res.end();
      });
      return;
    }

    if (url.pathname === '/resize' && req.method === 'POST') {
      const cols = Number(url.searchParams.get('cols'));
      const rows = Number(url.searchParams.get('rows'));
      if (Number.isFinite(cols) && Number.isFinite(rows)) {
        try { session.pty.resize(Math.max(20, Math.min(500, cols)), Math.max(5, Math.min(200, rows))); } catch { /* raced exit */ }
      }
      res.writeHead(204); res.end();
      return;
    }

    if (url.pathname === '/close' && req.method === 'POST') {
      killSession(session);
      res.writeHead(204); res.end();
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // ⚠️ 127.0.0.1 EXPLICITLY. Omitting the host, or using '0.0.0.0', would put
    // a shell on the local network.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    host: addr.address,
    secret,
    get sessionCount() { return sessions.size; },
    async close() {
      clearInterval(reaper);
      for (const s of [...sessions.values()]) killSession(s);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // ⚠️ REQUIRED, not belt-and-braces. `server.close()` waits for open
        // connections, and an SSE stream never ends on its own — that is the
        // whole point of it. Without this, closing the daemon with a terminal
        // open hangs forever instead of exiting.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
