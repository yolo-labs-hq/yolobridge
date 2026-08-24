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

import { startMcpProxy, type McpProxyHandle } from './mcp-proxy.js';

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
      accessToken: 'account-tok',
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
      headers: { 'Content-Type': 'application/json' },
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(forwardedBody._delegatedToken, undefined);
    assert.equal(forwardedBody.params._delegatedToken, undefined);
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.result.usedToken, 'tok-2');
    assert.equal(mintCount, 2, 'initial mint + one force-refresh');
    assert.equal(forwardCount, 2, 'initial forward (in-band UNAUTHORIZED) + one retry');
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    for (let i = 0; i < 3; i++) {
      await fetch(handle!.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'whatever', fetchImpl, log: (l) => logs.push(l),
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
      apiUrl: 'https://api.example.com', accessToken: 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: (l) => logs.push(l),
    });
    assert.equal(handle, undefined);
    assert.ok(logs.some((l) => l.includes('local MCP access unavailable')));
  });
});
