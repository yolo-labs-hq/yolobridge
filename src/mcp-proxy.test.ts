/**
 * Unit tests for mcp-proxy.ts. The local HTTP server itself is exercised
 * for real (real loopback `fetch` calls to `127.0.0.1:<port>`, matching
 * this package's house rigor for anything that "looks tested" while being
 * untested at the mock boundary — see local-agent.test.ts's real
 * node-pty/bash test for the same principle) — only the upstream mint
 * endpoint and the "real" yolo-studio-mcp upstream are faked, via the
 * injected `fetchImpl`.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startMcpProxy, SECRET_HEADER, type McpProxyHandle } from './mcp-proxy.js';

const ORIGINAL_MCP_URL = process.env.YOLOBRIDGE_MCP_URL;
const FAKE_UPSTREAM = 'http://fake-upstream.test';

// A representative slice of the real universe GET /v1/mcp/scopes returns —
// doesn't need to be exhaustive, just needs more than one scope so tests can
// tell "the full list was requested" apart from "a hardcoded subset was".
const ALL_SCOPES = [
  'studio.list_tiles',
  'studio.get_workspace_context',
  'studio.send_to_tile',
  'studio.read_tile_output',
  'studio.remove_tile',
  'studio.create_agent_tile',
];

let handle: McpProxyHandle | undefined;

/** Every real loopback call in this file must present the per-attach
 *  secret (Codex review, 2026-08-24, round 10) or the proxy 401s before
 *  ever reaching `handleRequest` -- see the "Require authentication..."
 *  tests below for coverage of THAT gate itself. */
function authedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [SECRET_HEADER]: handle!.secret, ...extra };
}

afterEach(async () => {
  if (handle) await handle.stop();
  handle = undefined;
  if (ORIGINAL_MCP_URL === undefined) delete process.env.YOLOBRIDGE_MCP_URL;
  else process.env.YOLOBRIDGE_MCP_URL = ORIGINAL_MCP_URL;
});

function futureIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

function scopesResponse(scopes: string[] = ALL_SCOPES): Response {
  return new Response(JSON.stringify({ scopes }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mintResponse(token: string, expiresInSec = 60): Response {
  return new Response(JSON.stringify({
    token,
    expiresAt: futureIso(expiresInSec),
    jti: 'jti-1',
    claims: { workspaceId: 'w1', userId: 'u1', agentId: 'claude', scopes: ALL_SCOPES },
  }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

/** A fetchImpl that answers /v1/mcp/scopes and /v1/mcp/tokens and routes
 *  anything else to the caller's own upstream handler. */
function makeFetch(opts: {
  mintCalls?: any[];
  scopesCallCount?: { n: number };
  mintToken?: (req: any) => Response;
  upstream?: (init: any) => Response;
}) {
  return (async (url: any, init?: any) => {
    const u = String(url);
    if (u.endsWith('/v1/mcp/scopes')) {
      if (opts.scopesCallCount) opts.scopesCallCount.n++;
      return scopesResponse();
    }
    if (u.endsWith('/v1/mcp/tokens')) {
      const req = JSON.parse(init.body);
      opts.mintCalls?.push(req);
      return opts.mintToken ? opts.mintToken(req) : mintResponse('tok-1');
    }
    if (u === `${FAKE_UPSTREAM}/mcp`) {
      return opts.upstream
        ? opts.upstream(init)
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as any;
}

describe('startMcpProxy', () => {
  it('binds to 127.0.0.1 only, discovers the full scope universe, mints workspace-wide (no tileIds), and injects the token into a forwarded tools/call', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const mintCalls: any[] = [];
    const forwardCalls: any[] = [];
    const fetchImpl = makeFetch({
      mintCalls,
      upstream: (init) => {
        forwardCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com',
      getAccessToken: () => 'account-tok',
      workspaceId: 'w1',
      agentId: 'claude',
      fetchImpl,
      log: () => {},
    });
    assert.ok(handle, 'proxy should start on a successful mint');
    assert.match(handle!.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    assert.equal(mintCalls.length, 1);
    assert.deepEqual(mintCalls[0].scopes, ALL_SCOPES, 'requests the full discovered scope universe, not a hardcoded subset');
    assert.equal('tileIds' in mintCalls[0], false, 'workspace-wide grant -- no tileIds restriction, first-class-tile parity');
    assert.equal(mintCalls[0].workspaceId, 'w1');
    assert.equal(mintCalls[0].agentId, 'claude');

    // A real loopback call to the local proxy.
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { jsonrpc: '2.0', id: 1, result: { ok: true } });

    assert.equal(forwardCalls.length, 1);
    assert.equal(forwardCalls[0].body.params.arguments._delegatedToken, 'tok-1');
  });

  it('does not inject a token into a non-tools/call request (e.g. initialize)', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardedBody: any;
    const fetchImpl = makeFetch({
      upstream: (init) => {
        forwardedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(forwardedBody._delegatedToken, undefined);
    assert.equal(forwardedBody.params._delegatedToken, undefined);
  });

  it("injects the token into a tools/call that omits params.arguments entirely (a zero-input tool -- Codex review, 2026-08-24, round 4)", async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardedBody: any;
    const fetchImpl = makeFetch({
      upstream: (init) => {
        forwardedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles' } }),
    });
    assert.equal(forwardedBody.params.arguments?._delegatedToken, 'tok-1');
  });

  it('force-refreshes and retries once on a 401 from upstream', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: (init) => {
        forwardCount++;
        const body = JSON.parse(init.body);
        if (body.params.arguments._delegatedToken === 'tok-1') {
          return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { usedToken: body.params.arguments._delegatedToken } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.result.usedToken, 'tok-2');
    assert.equal(mintCount, 2, 'initial mint + one force-refresh');
    assert.equal(forwardCount, 2, 'initial forward (401) + one retry');
  });

  it('force-refreshes and retries on an in-band UNAUTHORIZED tool result (HTTP 200, not 401) -- the real shape this upstream actually uses', async () => {
    // Regression guard for a real bug found live (2026-08-24): a thrown
    // McpToolError('Invalid delegated token', 'UNAUTHORIZED') comes back as
    // a normal 200 JSON-RPC result with the error embedded in
    // result.content[0].text -- confirmed empirically against the real
    // upstream with curl before this fix (see isUnauthorizedToolResult's
    // doc comment). The 401-based test above covers a status code that has
    // never actually been observed from this upstream in practice; this one
    // covers the shape that actually fires.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: (init) => {
        forwardCount++;
        const body = JSON.parse(init.body);
        if (body.params.arguments._delegatedToken === 'tok-1') {
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid delegated token', code: 'UNAUTHORIZED' }) }] },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { usedToken: body.params.arguments._delegatedToken } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.result.usedToken, 'tok-2');
    assert.equal(mintCount, 2, 'initial mint + one force-refresh');
    assert.equal(forwardCount, 2, 'initial forward (in-band UNAUTHORIZED) + one retry');
  });

  it('force-refreshes and retries on an in-band UNAUTHORIZED result inside a JSON-RPC BATCH response (Codex review, 2026-08-24, round 16)', async () => {
    // injectToken already handles a batched REQUEST (Array.isArray(parsed))
    // -- a batched RESPONSE is equally real coming back. The body here is a
    // JSON ARRAY of one or more responses, so `parsed?.result` (the
    // single-object shape the original check assumed) is undefined and the
    // in-band UNAUTHORIZED was invisible until this fix.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: (init) => {
        forwardCount++;
        const bodyArr = JSON.parse(init.body);
        const usedToken = bodyArr[0].params.arguments._delegatedToken;
        if (usedToken === 'tok-1') {
          return new Response(JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid delegated token', code: 'UNAUTHORIZED' }) }] } },
          ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          { jsonrpc: '2.0', id: 1, result: { usedToken } },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }]),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body[0].result.usedToken, 'tok-2');
    assert.equal(mintCount, 2, 'initial mint + one force-refresh');
    assert.equal(forwardCount, 2, 'initial forward (in-band UNAUTHORIZED in a batch) + one retry');
  });

  it('does NOT retry on a real tool error that happens to be HTTP 200 but is not UNAUTHORIZED (e.g. a legitimate FORBIDDEN scope error)', async () => {
    // The fix above must be specific to UNAUTHORIZED -- retrying a
    // FORBIDDEN (correctly-enforced, not-in-scope) call would just waste a
    // mint and get the identical FORBIDDEN response again.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: () => {
        forwardCount++;
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ error: "Scope 'studio.remove_tile' not granted", code: 'FORBIDDEN' }) }] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remove_tile', arguments: {} } }),
    });
    assert.equal(mintCount, 1, 'no force-refresh for a FORBIDDEN error');
    assert.equal(forwardCount, 1, 'no retry for a FORBIDDEN error');
  });

  it('caches the token across calls within the refresh buffer window (no re-mint per request)', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse('tok-1', 300); },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    for (let i = 0; i < 3; i++) {
      await fetch(handle!.url, {
        method: 'POST',
        headers: authedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
      });
    }
    assert.equal(mintCount, 1, 'a long-lived (300s) token should not be re-minted for every call');
  });

  it('returns undefined (never throws) when the initial mint fails, so attach is not aborted', async () => {
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/v1/mcp/scopes')) return scopesResponse();
      if (u.endsWith('/v1/mcp/tokens')) {
        return new Response(JSON.stringify({ error: 'Agent whatever is not registered' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    const logs: string[] = [];
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'whatever', fetchImpl, log: (l) => logs.push(l),
    });
    assert.equal(handle, undefined);
    assert.ok(logs.some((l) => l.includes('local MCP access unavailable')));
  });

  it('returns undefined (never throws) when scope discovery itself fails', async () => {
    const fetchImpl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/v1/mcp/scopes')) return new Response('nope', { status: 500 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    const logs: string[] = [];
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: (l) => logs.push(l),
    });
    assert.equal(handle, undefined);
    assert.ok(logs.some((l) => l.includes('local MCP access unavailable')));
  });

  it('a startup mint that never resolves is aborted by mintTimeoutMs, returning undefined instead of hanging forever (Codex review, 2026-08-24)', async () => {
    // A real `fetch` rejects with an AbortError once its signal fires --
    // this fetchImpl mirrors that instead of just ignoring the signal, so
    // the test actually proves startMcpProxy's own abort wiring works, not
    // just that it eventually gives up waiting on its own.
    const fetchImpl = (async (_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as any;

    const logs: string[] = [];
    const start = Date.now();
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude',
      fetchImpl, mintTimeoutMs: 20, log: (l) => logs.push(l),
    });
    assert.equal(handle, undefined);
    assert.ok(Date.now() - start < 2000, 'must resolve promptly via the short mintTimeoutMs, not hang');
    assert.ok(logs.some((l) => l.includes('local MCP access unavailable')));
  });

  it('a startup mint whose HEADERS arrive but whose BODY stalls is also aborted by mintTimeoutMs (Codex review, 2026-08-24, round 14)', async () => {
    // `fetch()` resolves as soon as response headers arrive, well before the
    // body is read. The original RequestTracker removed the controller from
    // its tracked set in a `finally` right after `fetch()` itself resolved --
    // if the upstream then stalled mid-BODY (this test's `json()` never
    // settles on its own), the controller was ALREADY untracked by the time
    // `abortAll()` ran at the timeout, so it had nothing left to abort and
    // `mint()`'s pending `res.json()` call hung forever. This test's `json()`
    // only ever settles via the abort signal, so it directly proves the
    // controller stays live through body consumption, not just headers.
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/v1/mcp/scopes')) return scopesResponse();
      if (u.endsWith('/v1/mcp/tokens')) {
        return {
          ok: true,
          status: 201,
          json: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    const logs: string[] = [];
    const start = Date.now();
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude',
      fetchImpl, mintTimeoutMs: 20, log: (l) => logs.push(l),
    });
    assert.equal(handle, undefined);
    assert.ok(Date.now() - start < 2000, 'must resolve promptly via the short mintTimeoutMs, not hang on a stalled body');
    assert.ok(logs.some((l) => l.includes('local MCP access unavailable')));
  });

  it('stop() aborts an in-flight forwarded request instead of waiting for it to finish (Codex review, 2026-08-24)', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardSignal: AbortSignal | undefined;
    // makeFetch's `upstream` hook returns a Response synchronously; the
    // forward call here needs to hang until aborted, so this test uses its
    // own fetchImpl instead of the shared helper.
    const hangingFetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/v1/mcp/scopes')) return scopesResponse();
      if (u.endsWith('/v1/mcp/tokens')) return mintResponse('tok-1');
      if (u === `${FAKE_UPSTREAM}/mcp`) {
        forwardSignal = init?.signal;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl: hangingFetchImpl, log: () => {},
    });
    assert.ok(handle);

    // Fire a tools/call and let it reach the (hanging) forward fetch, but
    // don't await the response yet.
    const callPromise = fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    await waitUntil(() => forwardSignal !== undefined);
    assert.equal(forwardSignal!.aborted, false, 'sanity check: not aborted yet');

    const stopStart = Date.now();
    await withTimeout(handle!.stop(), 2000, 'stop() while a forward request is in flight');
    assert.ok(Date.now() - stopStart < 2000, 'stop() must not wait out the hanging upstream request');
    assert.equal(forwardSignal!.aborted, true, 'stop() must abort the in-flight forwarded request');

    // The client-side fetch settles (with a transport error, since the
    // server tore down mid-request) rather than hanging forever either.
    await callPromise.catch(() => undefined);
  });

  it('stop() aborts a forwarded request whose HEADERS already arrived but whose BODY is still stalled (Codex review, 2026-08-24, round 14)', async () => {
    // Distinct from the test above: there, the forward fetch() call ITSELF
    // never resolves. Here it resolves immediately (headers "arrived") and
    // only the body read (`res.text()`) stalls -- exactly the gap the
    // original RequestTracker missed, since it released the controller as
    // soon as fetch() resolved, before forwardOnce ever got to `res.text()`.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardSignal: AbortSignal | undefined;
    const hangingBodyFetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/v1/mcp/scopes')) return scopesResponse();
      if (u.endsWith('/v1/mcp/tokens')) return mintResponse('tok-1');
      if (u === `${FAKE_UPSTREAM}/mcp`) {
        forwardSignal = init?.signal;
        return {
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          text: () => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl: hangingBodyFetchImpl, log: () => {},
    });
    assert.ok(handle);

    const callPromise = fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    await waitUntil(() => forwardSignal !== undefined);
    assert.equal(forwardSignal!.aborted, false, 'sanity check: not aborted yet');

    const stopStart = Date.now();
    await withTimeout(handle!.stop(), 2000, 'stop() while a forward request body-read is stalled');
    assert.ok(Date.now() - stopStart < 2000, 'stop() must not wait out the hanging body read');
    assert.equal(forwardSignal!.aborted, true, 'stop() must abort the request even though headers already arrived');

    await callPromise.catch(() => undefined);
  });
});

describe('proxy authentication (Codex review, 2026-08-24, round 10)', () => {
  // Loopback binding keeps this off the local NETWORK but does nothing
  // against another process on the SAME host -- these tests prove the
  // listener itself refuses an unauthenticated caller BEFORE any minting or
  // upstream forwarding happens, not just that a legitimate caller with the
  // secret still works (already covered above).
  it('rejects a request with no secret header at all, without minting or forwarding', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse('tok-1'); },
      upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); },
    });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const startupMintCount = mintCount;

    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 401);
    assert.equal(mintCount, startupMintCount, 'no additional mint beyond the one at startup');
    assert.equal(forwardCount, 0, 'must never reach the upstream without a valid secret');
  });

  it('rejects a request with the WRONG secret', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const fetchImpl = makeFetch({});
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: `${handle!.secret}-wrong` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 401);
  });

  it('issues a different secret on each proxy start', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl: makeFetch({}), log: () => {},
    });
    const firstSecret = handle!.secret;
    await handle!.stop();

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl: makeFetch({}), log: () => {},
    });
    assert.notEqual(handle!.secret, firstSecret, 'a secret from a prior attach must not authenticate a new one');
  });
});

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
