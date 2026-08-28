#!/usr/bin/env node
/**
 * SPIKE — throwaway. Delete this directory once the question is answered.
 *
 * ONE QUESTION: can a page served from https://yolo.studio talk to a server on
 * the operator's own 127.0.0.1?
 *
 * If yes, a terminal tile can connect DIRECTLY to the daemon and echo in <5ms,
 * which is what "ssh-like" actually means. If no, the only path left is the
 * cloud relay at ~200ms round trip — to type into a process running on the same
 * laptop as the browser — and the feature is not worth building.
 *
 * Three separate browser mechanisms have to allow this, and they fail
 * differently. The spike handles all three so that a failure means "browsers
 * won't do this", not "the spike forgot a header":
 *
 *   1. MIXED CONTENT. An https page loading http:// is normally blocked.
 *      Loopback is exempt as a "potentially trustworthy origin" in
 *      Chrome/Edge/Firefox. Safari is historically stricter — that is the
 *      real unknown and the reason this spike exists.
 *   2. CORS. Cross-origin, so the loopback server must return
 *      Access-Control-Allow-Origin for the calling page.
 *   3. PRIVATE NETWORK ACCESS. Chrome preflights a public→private request with
 *      `Access-Control-Request-Private-Network: true` and needs
 *      `Access-Control-Allow-Private-Network: true` back. Miss this and it
 *      fails for a fixable reason, and we would wrongly conclude it cannot work.
 *
 * Transport is SSE + POST rather than a WebSocket: no new dependency, and it
 * mirrors what the cloud path already does. Note the consequence — `EventSource`
 * cannot set headers, so the secret rides in the query string. That is the exact
 * constraint that broke the cloud SSE client earlier (`req.query.token`), so it
 * is worth meeting again here deliberately.
 *
 * SECURITY, because this spawns a real shell:
 *   · bound to 127.0.0.1 ONLY — never 0.0.0.0, so it is off the local network;
 *   · a random per-run secret, compared in constant time;
 *   · the allowed browser origin is explicit, not '*';
 *   · it exits on Ctrl+C and kills the shell with it.
 * It is still a shell on your machine reachable by anything that can read the
 * secret and reach loopback. Run it, answer the question, kill it.
 *
 *   node yolobridge/spike/loopback-terminal-spike.mjs
 *   node yolobridge/spike/loopback-terminal-spike.mjs --origin https://yolo.studio
 */
import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const originArg = process.argv.indexOf('--origin');
const ALLOWED_ORIGIN = originArg > -1 ? process.argv[originArg + 1] : 'https://yolo.studio';
const SECRET = randomBytes(24).toString('hex');

/** Constant-time compare that cannot throw on a length mismatch. */
function secretOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
const term = pty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env,
});

/** Ring of recent output, so a viewer that connects late sees something. */
let backlog = '';
const subscribers = new Set();
term.onData((data) => {
  backlog = (backlog + data).slice(-16_000);
  for (const res of subscribers) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
});
term.onExit(() => {
  for (const res of subscribers) res.end();
  console.log('\n[spike] shell exited');
  process.exit(0);
});

function cors(req, res) {
  const origin = req.headers.origin;
  // Explicit echo of an allowed origin — never '*', which would let any page
  // on the internet reach this shell.
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // ⚠️ Chrome's Private Network Access preflight. Without this the request is
  // refused before it ever reaches the handler, and the failure looks
  // identical to "browsers won't allow loopback at all".
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // The decisive probe: if this returns in the browser console, all three
  // mechanisms above allowed it and the feature is buildable.
  if (url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, shell, pid: term.pid, note: 'loopback reachable from this page' }));
    return;
  }

  if (!secretOk(url.searchParams.get('secret'))) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad or missing secret' }));
    return;
  }

  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (backlog) res.write(`data: ${JSON.stringify(backlog)}\n\n`);
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }

  if (url.pathname === '/input' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65_536) req.destroy(); });
    req.on('end', () => {
      try { term.write(JSON.parse(body).data ?? ''); } catch { /* ignore malformed */ }
      res.writeHead(204); res.end();
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  console.log(`
[spike] shell   : ${shell} (pid ${term.pid})
[spike] listening: ${base}   (127.0.0.1 only)
[spike] origin   : ${ALLOWED_ORIGIN}

──────────────────────────────────────────────────────────────────────
STEP 1 — open ${ALLOWED_ORIGIN} in the browser, open the devtools console,
         and paste this. It answers the whole question:

await (await fetch('${base}/ping')).json()

  ✓ prints { ok: true, ... }  → loopback works from an https page. BUILDABLE.
  ✗ throws / "blocked"        → copy the exact console error; that names which
                                of the three mechanisms refused.

──────────────────────────────────────────────────────────────────────
STEP 2 (only if step 1 worked) — a real terminal, end to end:

const es = new EventSource('${base}/stream?secret=${SECRET}');
es.onmessage = (e) => console.log(JSON.parse(e.data));
const type = (data) => fetch('${base}/input?secret=${SECRET}', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data }),
});
await type('echo hello from your laptop\\r');

  Output should appear in the console ESSENTIALLY INSTANTLY — that is the
  <5ms the cloud relay cannot reach.

──────────────────────────────────────────────────────────────────────
Ctrl+C here to stop the shell and the server.
`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { term.kill(); } catch {} server.close(); process.exit(0); });
}
