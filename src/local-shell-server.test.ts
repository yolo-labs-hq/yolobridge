/**
 * This module hands out SHELLS on the operator's machine, so most of what
 * matters here is refusal: who is turned away, and what is never exposed.
 * Every test is paired with the concrete thing it prevents.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startLocalShellServer,
  secretMatches,
  trimBacklog,
  type LocalShellServerHandle,
  type ShellPty,
} from './local-shell-server.js';

const ORIGIN = 'https://yolo.studio';

/** A fake PTY: echoes what it is given, so a test can prove bytes flowed. */
function fakeShell() {
  const created: FakePty[] = [];
  class FakePty implements ShellPty {
    written: string[] = [];
    resizes: Array<{ cols: number; rows: number }> = [];
    killed = false;
    pid = 4242;
    private dataCbs: Array<(d: string) => void> = [];
    private exitCbs: Array<() => void> = [];
    constructor(public cols: number, public rows: number) { created.push(this); }
    write(data: string) { this.written.push(data); this.emit(`echo:${data}`); }
    resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); }
    kill() { this.killed = true; for (const cb of this.exitCbs) cb(); }
    onData(cb: (d: string) => void) { this.dataCbs.push(cb); }
    onExit(cb: () => void) { this.exitCbs.push(cb); }
    emit(d: string) { for (const cb of this.dataCbs) cb(d); }
  }
  return {
    created,
    spawn: ({ cols, rows }: { cols: number; rows: number }) => new FakePty(cols, rows) as ShellPty,
  };
}


/**
 * Read from an SSE stream until `want` appears, or give up.
 *
 * ⚠️ NOT "assert on the first chunk". The server flushes a `: connected`
 * comment first — deliberately, because Node holds response headers until the
 * first write and a shell that has not printed yet would otherwise leave the
 * client's `fetch` hanging forever. So the payload is never the first read.
 */
async function readUntil(res: Response, want: RegExp, timeoutMs = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) =>
          setTimeout(() => r({ done: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (next.done && !next.value) break;
      seen += decoder.decode(next.value, { stream: true });
      if (want.test(seen)) return seen;
    }
    return seen;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

let server: LocalShellServerHandle;
let shells: ReturnType<typeof fakeShell>;

before(async () => {
  shells = fakeShell();
  server = await startLocalShellServer({ allowedOrigin: ORIGIN, spawnShell: shells.spawn });
});
after(async () => { await server?.close(); });

const url = (path: string, qs = '') => `${server.url}${path}?secret=${server.secret}${qs}`;

async function openSession(): Promise<string> {
  const res = await fetch(url('/open', '&cols=90&rows=24'), { method: 'POST' });
  assert.equal(res.status, 200);
  return (await res.json() as { sessionId: string }).sessionId;
}

describe('who is refused', () => {
  it('rejects a missing or wrong secret on every privileged route', async () => {
    for (const path of ['/open', '/stream', '/input', '/resize', '/close']) {
      const none = await fetch(`${server.url}${path}`, { method: 'POST' });
      assert.equal(none.status, 403, `${path} with no secret`);
      const wrong = await fetch(`${server.url}${path}?secret=deadbeef`, { method: 'POST' });
      assert.equal(wrong.status, 403, `${path} with a wrong secret`);
    }
  });

  it('compares the secret in constant time and does not throw on a length mismatch', () => {
    // `timingSafeEqual` throws when lengths differ — a crash AND a length
    // oracle. The guard must short-circuit, not blow up.
    assert.equal(secretMatches('short', 'a-much-longer-secret'), false);
    assert.equal(secretMatches(undefined, 'x'), false);
    assert.equal(secretMatches(12345, 'x'), false);
    assert.equal(secretMatches('same', 'same'), true);
  });

  it('refuses a session id it never issued', async () => {
    const res = await fetch(url('/input', '&session=made-up'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

describe('the browser mechanisms that gate loopback', () => {
  it('answers a Private Network Access preflight', async () => {
    // ⚠️ Chrome preflights public→private and REQUIRES this header. Without it
    // the request is refused before reaching any handler, and the failure looks
    // exactly like "browsers do not allow loopback at all".
    const res = await fetch(`${server.url}/health`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  });

  it('allows exactly ONE origin, never a wildcard', async () => {
    // `*` would let any page on the internet reach a shell on this machine.
    const res = await fetch(`${server.url}/health`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  });

  it('does not hand an allow-origin to a DIFFERENT origin', async () => {
    const res = await fetch(`${server.url}/health`, {
      method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('serves /health without a secret, and it reveals nothing', async () => {
    // It exists so a viewer can ask "is the daemon on THIS machine?" before it
    // has any reason to hold a secret. It must not leak more than the TCP
    // connect already did.
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'service']);
  });
});

describe('running a shell', () => {
  it('spawns at the requested grid and streams its output', async () => {
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];
    assert.equal(spawned.cols, 90);
    assert.equal(spawned.rows, 24);

    const res = await fetch(url('/stream', `&session=${id}`));
    assert.equal(res.status, 200);
    const seen = readUntil(res, /echo:ls/);

    await fetch(url('/input', `&session=${id}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'ls\r' }),
    });
    assert.match(await seen, /echo:ls/);
    assert.deepEqual(spawned.written, ['ls\r']);
  });

  it('replays the backlog so a late viewer sees the screen', async () => {
    // Without this, reconnecting shows a blank terminal until the next
    // keypress — indistinguishable from a broken connection.
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];
    spawned.emit('already on screen');

    const res = await fetch(url('/stream', `&session=${id}`));
    assert.match(await readUntil(res, /already on screen/), /already on screen/);
  });

  it('caps a single input payload', async () => {
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];
    await fetch(url('/input', `&session=${id}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(9000) }),
    });
    assert.deepEqual(spawned.written, [], 'an over-cap payload must not reach the PTY');
  });

  it('forwards a resize', async () => {
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];
    await fetch(url('/resize', `&session=${id}&cols=120&rows=40`), { method: 'POST' });
    assert.deepEqual(spawned.resizes, [{ cols: 120, rows: 40 }]);
  });

  it('kills the shell on close', async () => {
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];
    await fetch(url('/close', `&session=${id}`), { method: 'POST' });
    assert.equal(spawned.killed, true);
    const after = await fetch(url('/input', `&session=${id}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x' }),
    });
    assert.equal(after.status, 404, 'a closed session must not be reachable');
  });
});

describe('bounds', () => {
  it('caps concurrent shells', async () => {
    // A forgotten tab, or a loop, must not be able to fill the machine with
    // shells.
    const small = await startLocalShellServer({
      allowedOrigin: ORIGIN, spawnShell: fakeShell().spawn, maxSessions: 2,
    });
    try {
      const u = (p: string) => `${small.url}${p}?secret=${small.secret}`;
      assert.equal((await fetch(u('/open'), { method: 'POST' })).status, 200);
      assert.equal((await fetch(u('/open'), { method: 'POST' })).status, 200);
      assert.equal((await fetch(u('/open'), { method: 'POST' })).status, 429);
    } finally {
      await small.close();
    }
  });

  it('reaps a shell nobody is watching, and spares one that has a viewer', async () => {
    let clock = 1_000_000;
    const s = await startLocalShellServer({
      allowedOrigin: ORIGIN, spawnShell: fakeShell().spawn, now: () => clock, idleReapMs: 40,
    });
    try {
      const u = (p: string, qs = '') => `${s.url}${p}?secret=${s.secret}${qs}`;
      const watched = (await (await fetch(u('/open'), { method: 'POST' })).json() as { sessionId: string }).sessionId;
      await fetch(u('/open'), { method: 'POST' });   // unwatched
      assert.equal(s.sessionCount, 2);

      // Hold a viewer on the first. A viewer that is merely QUIET is still a
      // viewer — reaping on output-silence would kill an idle shell the
      // operator is about to type into.
      const stream = await fetch(u('/stream', `&session=${watched}`));
      const reader = stream.body!.getReader();
      void reader.read();   // hold the connection open; never resolves further

      clock += 10_000;
      await new Promise((r) => setTimeout(r, 1400));
      assert.equal(s.sessionCount, 1, 'the unwatched shell should be gone, the watched one kept');
      await reader.cancel();
    } finally {
      await s.close();
    }
  });

  it('closing the server kills every shell it owns', async () => {
    const own = fakeShell();
    const s = await startLocalShellServer({ allowedOrigin: ORIGIN, spawnShell: own.spawn });
    await fetch(`${s.url}/open?secret=${s.secret}`, { method: 'POST' });
    await s.close();
    assert.ok(own.created.every((p) => p.killed), 'no shell may outlive the daemon');
  });
});

describe('it is off the network entirely', () => {
  it('binds 127.0.0.1 and nothing else', async () => {
    // ⚠️ THE most important property in this module: it hands out SHELLS.
    // Binding '0.0.0.0' (or omitting the host, which is the same thing) would
    // put an interactive shell on every interface this machine has. Pinned
    // deterministically rather than left to a manual check.
    assert.equal(server.host, '127.0.0.1');
  });

  it("refuses a connection on this machine's own LAN address", async () => {
    // The behavioural half. `server.host` says what we ASKED for; this proves
    // what the kernel actually did — a TCP-level refusal, not a firewall.
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;

    if (!external) {
      // Say so rather than passing quietly: a skipped assertion that looks
      // green is how a security property stops being checked.
      assert.ok(true, 'no non-loopback IPv4 on this host — behavioural check not possible here');
      return;
    }

    const net = await import('node:net');
    const refused = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: external, port: server.port, timeout: 2000 });
      sock.on('connect', () => { sock.destroy(); resolve(false); });
      sock.on('error', () => { sock.destroy(); resolve(true); });
      sock.on('timeout', () => { sock.destroy(); resolve(true); });
    });
    assert.equal(refused, true, `a shell was reachable on ${external}:${server.port}`);
  });
});

describe('failures must not take the daemon down with them', () => {
  it('reports a failed shell spawn instead of crashing the process', async () => {
    // ⚠️ This runs inside the HTTP request callback: an unhandled throw kills
    // the whole bridge -- the agent PTY and every other terminal -- because one
    // $SHELL pointed at a missing binary. (codex P2.)
    const s = await startLocalShellServer({
      allowedOrigin: ORIGIN,
      spawnShell: () => { throw new Error('ENOENT: no such file or directory'); },
    });
    try {
      const res = await fetch(`${s.url}/open?secret=${s.secret}`, { method: 'POST' });
      assert.equal(res.status, 500);
      const body = await res.json() as { error: string; detail: string };
      assert.match(body.error, /could not start a shell/);
      assert.match(body.detail, /ENOENT/);
      // Still alive and serving afterwards -- that is the whole point.
      assert.equal((await fetch(`${s.url}/health`)).status, 200);
    } finally {
      await s.close();
    }
  });

  it('kills a session exactly once even when kill() fires onExit synchronously', async () => {
    // ⚠️ A synchronous onExit re-enters killSession, which kills again, which
    // re-enters... until the stack blows. The interface permits it and real
    // PTYs do it. (codex P2.)
    let kills = 0;
    const s = await startLocalShellServer({
      allowedOrigin: ORIGIN,
      spawnShell: () => {
        const exitCbs: Array<() => void> = [];
        return {
          pid: 7, write() {}, resize() {},
          onData() {}, onExit(cb: () => void) { exitCbs.push(cb); },
          kill() { kills += 1; for (const cb of exitCbs) cb(); },
        };
      },
    });
    try {
      const opened = await (await fetch(`${s.url}/open?secret=${s.secret}`, { method: 'POST' })).json() as { sessionId: string };
      const res = await fetch(`${s.url}/close?secret=${s.secret}&session=${opened.sessionId}`, { method: 'POST' });
      assert.equal(res.status, 204);
      assert.equal(kills, 1, `kill() ran ${kills} times -- killSession re-entered`);
      assert.equal(s.sessionCount, 0);
    } finally {
      await s.close();
    }
  });
});

describe('the replay is trimmed at a resumable boundary', () => {
  it('keeps a short buffer untouched', () => {
    assert.equal(trimBacklog('hello', 100), 'hello');
  });

  it('never starts on the low half of a surrogate pair', () => {
    // Half a surrogate is not a character; the viewer renders a replacement
    // glyph nobody printed.
    const buf = 'x'.repeat(10) + '\u{1F600}' + 'y'.repeat(10);
    for (let limit = 4; limit < buf.length; limit++) {
      const out = trimBacklog(buf, limit);
      const first = out.charCodeAt(0);
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `limit ${limit} started on a low surrogate`);
    }
  });

  it('prefers a line boundary when one is near the cut', () => {
    // A newline is the one place a terminal stream is reliably re-enterable.
    const buf = 'old stuff\nkept line one\nkept line two\n';
    const out = trimBacklog(buf, 25);
    assert.ok(!out.startsWith('d stuff'), 'cut mid-word instead of at a line');
    assert.ok(buf.endsWith(out), 'trim must only ever remove a PREFIX');
  });

  it('never resumes inside a CSI sequence', () => {
    // Resuming mid-CSI makes the viewer read parameters as literal text.
    const buf = 'A'.repeat(40) + "\u001b[38;5;196m" + 'B'.repeat(40);
    for (let limit = 5; limit < buf.length; limit++) {
      const out = trimBacklog(buf, limit);
      assert.ok(buf.endsWith(out), `limit ${limit}: trim must only remove a prefix`);
      assert.ok(!/^[0-9;]*m/.test(out), `limit ${limit}: resumed inside a CSI -> ${JSON.stringify(out.slice(0, 12))}`);
    }
  });

  it('never resumes inside an OSC string, even though it contains a newline', () => {
    // ⚠️ THE CASE THE NEWLINE SHORTCUT GOT WRONG. A newline does NOT terminate
    // an OSC; cutting at one lands inside the string, and the viewer then
    // treats the rest of the title payload as terminal commands. (codex P2.)
    const osc = "\u001b]0;a title with a \nnewline inside it\u0007";
    const buf = 'A'.repeat(40) + osc + 'B'.repeat(40);
    for (let limit = 5; limit < buf.length; limit++) {
      const out = trimBacklog(buf, limit);
      assert.ok(buf.endsWith(out), `limit ${limit}: prefix-only`);
      assert.ok(!out.startsWith('newline inside it'), `limit ${limit}: cut inside the OSC at its newline`);
      assert.ok(!/^[0-9];a title/.test(out), `limit ${limit}: cut inside the OSC`);
    }
  });

  it('sees an introducer that sits BEFORE the cut', () => {
    // ⚠️ The original bug: scanning FORWARD from the cut cannot see the ESC
    // that put the stream mid-sequence, so it happily resumed inside one.
    const buf = "\u001b]0;" + 'x'.repeat(200) + "\u0007" + 'tail';
    const out = trimBacklog(buf, 100);
    assert.ok(buf.endsWith(out), 'prefix-only');
    assert.ok(!out.startsWith('x'), 'resumed inside the OSC payload');
    assert.equal(out, 'tail');
  });

  it('only ever discards MORE, never resurrects dropped bytes', () => {
    // Moving the cut forward is safe; moving it backward would replay bytes
    // the viewer was never meant to see again.
    const buf = 'z'.repeat(500);
    const out = trimBacklog(buf, 100);
    assert.ok(out.length <= 100);
    assert.ok(buf.endsWith(out));
  });
});

describe('a multibyte character split across TCP chunks', () => {
  it('survives, instead of decoding into replacement characters', async () => {
    // ⚠️ `body += chunk` decodes each Buffer INDEPENDENTLY, so a character
    // whose bytes land either side of a chunk boundary becomes two U+FFFD.
    // Whether that happens depends on how the network fragmented the request,
    // which is exactly the kind of bug that shows up once, in someone else's
    // paste, and never reproduces. (codex P2.)
    const id = await openSession();
    const spawned = shells.created[shells.created.length - 1];

    const payload = Buffer.from(JSON.stringify({ data: 'caf\u00e9 \u2014 \u{1F600}' }), 'utf-8');
    // Split at a byte that is guaranteed to be INSIDE a multibyte sequence:
    // one past the first lead byte above 0x7f.
    let splitAt = payload.findIndex((b) => b > 0x7f) + 1;
    assert.ok(splitAt > 1 && splitAt < payload.length, 'fixture must actually straddle a character');

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(payload.subarray(0, splitAt)));
        // A tick between chunks, so they really do arrive as separate reads.
        setTimeout(() => { c.enqueue(new Uint8Array(payload.subarray(splitAt))); c.close(); }, 10);
      },
    });

    const res = await fetch(url('/input', `&session=${id}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Node requires this for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    assert.equal(res.status, 204);

    assert.deepEqual(spawned.written, ['caf\u00e9 \u2014 \u{1F600}']);
    assert.ok(!spawned.written.join('').includes('\ufffd'), 'a replacement character reached the PTY');
  });
});

describe('a viewer that stops reading', () => {
  it('drops output instead of queueing it without bound', async () => {
    // ⚠️ `res.write()` returns false when the socket buffer fills. Ignoring it
    // lets Node queue every later chunk with NO bound, so one stalled tab plus
    // a noisy command exhausts the memory of the process that owns the
    // operator's shells. (codex P1.)
    const own = fakeShell();
    const s = await startLocalShellServer({ allowedOrigin: ORIGIN, spawnShell: own.spawn });
    try {
      const u = (p: string, q = '') => `${s.url}${p}?secret=${s.secret}${q}`;
      const id = (await (await fetch(u('/open'), { method: 'POST' })).json() as { sessionId: string }).sessionId;
      const spawned = own.created[own.created.length - 1];

      // Open a stream and NEVER read from it, so the socket backs up.
      const res = await fetch(u('/stream', `&session=${id}`));
      const reader = res.body!.getReader();

      const before = process.memoryUsage().heapUsed;
      // ~40MB of output at a viewer that is not consuming. If it were queued,
      // this is where the daemon dies.
      const megabyte = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 40; i++) spawned.emit(megabyte);
      await new Promise((r) => setTimeout(r, 250));
      const grew = process.memoryUsage().heapUsed - before;

      assert.ok(grew < 40 * 1024 * 1024, `heap grew ${Math.round(grew / 1e6)}MB — output was queued, not dropped`);
      // And the daemon is still healthy afterwards.
      assert.equal((await fetch(`${s.url}/health`)).status, 200);
      await reader.cancel().catch(() => {});
    } finally {
      await s.close();
    }
  });
});

describe('a shell that dies the instant it is created', () => {
  it('does not leave a phantom holding a slot against the session cap', async () => {
    // ⚠️ If onExit fires before `sessions.set` had run, killSession deletes
    // nothing and the dead session is inserted AFTERWARDS — unreachable (404
    // on every request) yet still counted against the cap, and unremovable
    // because killSession returns early once `exited` is set. A slow leak of
    // the one resource that is bounded. (codex P1.)
    const s = await startLocalShellServer({
      allowedOrigin: ORIGIN,
      maxSessions: 2,
      spawnShell: () => ({
        pid: 9, write() {}, resize() {}, kill() {},
        onData() {},
        // Fires the moment it is subscribed — the race, made deterministic.
        onExit(cb: () => void) { cb(); },
      }),
    });
    try {
      const u = (p: string) => `${s.url}${p}?secret=${s.secret}`;
      for (let i = 0; i < 5; i++) {
        const res = await fetch(u('/open'), { method: 'POST' });
        assert.equal(res.status, 200, `open #${i + 1} should still be allowed`);
      }
      assert.equal(s.sessionCount, 0, 'every instantly-dead shell must be gone, not banked');
    } finally {
      await s.close();
    }
  });
});

describe('ESC intermediate bytes', () => {
  it('does not treat an intermediate as the end of the sequence', () => {
    // ⚠️ `ESC ( B` (charset designation) is THREE bytes. Treating `(` as the
    // end marks the boundary before `B` as ground, so a trim there replays a
    // bare "B" as ordinary text and silently drops the charset switch.
    // (codex P2.)
    const buf = 'A'.repeat(40) + "\u001b(" + 'B' + 'C'.repeat(40);
    for (let limit = 5; limit < buf.length; limit++) {
      const out = trimBacklog(buf, limit);
      assert.ok(buf.endsWith(out), `limit ${limit}: prefix-only`);
      assert.ok(!out.startsWith('B'), `limit ${limit}: resumed on the FINAL byte of an escape`);
    }
  });
});
