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

import { startMcpProxy, mergeLocalWithRemoteFailure, SECRET_HEADER, type McpProxyHandle } from './mcp-proxy.js';

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
    assert.equal('callerTileId' in mintCalls[0], false, 'no self-identity claim unless the caller supplies one');

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

  it('mints the attached tileId as the callerTileId self-identity claim (so the spawned agent can tell which list_tiles row is itself)', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const mintCalls: any[] = [];
    const fetchImpl = makeFetch({
      mintCalls,
      upstream: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com',
      getAccessToken: () => 'at',
      workspaceId: 'w1',
      agentId: 'claude',
      callerTileId: 'yolobridge-1787680593278-ajmi',
      fetchImpl,
      log: () => {},
    });

    assert.equal(mintCalls.length, 1);
    assert.equal(mintCalls[0].callerTileId, 'yolobridge-1787680593278-ajmi');
    // Self-identity is not a restriction: the grant stays workspace-wide
    // (first-class-tile parity, this file's header).
    assert.equal('tileIds' in mintCalls[0], false);
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

  it('retries ONLY the unauthorized element of a mixed-result BATCH, never replaying an already-successful mutating call (Codex review, 2026-08-24, round 20)', async () => {
    // The previous fix (round 16, the test above) made the force-refresh
    // FIRE for a batch -- but it still resent the WHOLE original batch,
    // including any element that already succeeded. Many MCP tools are not
    // idempotent, so a mutating call earlier in the batch (id 1 here) would
    // execute a SECOND time purely because a LATER element (id 2) happened
    // to hit an expired token. This proves id 1 is never resent to the
    // upstream at all -- `mutateCount` would be 2 if it were.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    let mutateCount = 0;
    const forwardedIds: number[][] = [];
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: (init) => {
        forwardCount++;
        const bodyArr = JSON.parse(init.body);
        forwardedIds.push(bodyArr.map((m: any) => m.id));
        const responses = bodyArr.map((msg: any) => {
          const usedToken = msg.params.arguments._delegatedToken;
          if (msg.id === 1) {
            mutateCount++;
            return { jsonrpc: '2.0', id: 1, result: { mutated: mutateCount, usedToken } };
          }
          if (usedToken === 'tok-1') {
            return { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid delegated token', code: 'UNAUTHORIZED' }) }] } };
          }
          return { jsonrpc: '2.0', id: 2, result: { usedToken } };
        });
        return new Response(JSON.stringify(responses), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_tile_status', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } },
      ]),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any[];
    assert.equal(mintCount, 2, 'initial mint + one force-refresh');
    assert.equal(forwardCount, 2, 'initial forward + one PARTIAL retry');
    assert.deepEqual(forwardedIds, [[1, 2], [2]], 'the retry must resend ONLY the unauthorized element (id 2), not the whole original batch');
    assert.equal(mutateCount, 1, 'the mutating call (id 1) must never be sent to the upstream a second time');
    assert.deepEqual(body.find((r) => r.id === 1).result, { mutated: 1, usedToken: 'tok-1' }, "id 1's first, already-successful response must survive untouched in the merged output");
    assert.equal(body.find((r) => r.id === 2).result.usedToken, 'tok-2', "id 2's retried response must be the one returned to the caller");
  });

  it('does NOT promote a FAILED subset retry\'s own HTTP status onto the merged response (Codex review, 2026-08-24, round 26)', async () => {
    // The original response is ALWAYS a 200 on this code path (a
    // transport-level 401 takes the whole-body retry instead) -- if the
    // narrower SUBSET retry itself fails at the transport level (a genuine
    // upstream 500, not a network error, which throws and is caught
    // upstream of this branch entirely), the merged BODY already correctly
    // falls back to the original text (id 1's success survives, id 2 keeps
    // its original UNAUTHORIZED error unchanged) -- but blindly spreading
    // the retry's own 500 onto the outer response would tell the caller the
    // WHOLE batch failed, inviting a blind full retry that replays the
    // already-successful mutating call all over again.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    let mutateCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse(`tok-${mintCount}`); },
      upstream: (init) => {
        forwardCount++;
        if (forwardCount === 1) {
          const bodyArr = JSON.parse(init.body);
          const responses = bodyArr.map((msg: any) => {
            if (msg.id === 1) {
              mutateCount++;
              return { jsonrpc: '2.0', id: 1, result: { mutated: mutateCount } };
            }
            return { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid delegated token', code: 'UNAUTHORIZED' }) }] } };
          });
          return new Response(JSON.stringify(responses), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // The retry (id 2 only) fails at the transport level.
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_tile_status', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } },
      ]),
    });

    assert.equal(res.status, 200, 'the retry subset failing at the transport level must not make the WHOLE merged response look like a transport failure');
    const body = (await res.json()) as any[];
    assert.equal(mutateCount, 1, 'the mutating call must still never be sent to the upstream a second time');
    assert.deepEqual(body.find((r) => r.id === 1).result, { mutated: 1 }, "id 1's already-successful response must survive untouched");
    assert.equal(
      JSON.parse(body.find((r) => r.id === 2).result.content[0].text).code,
      'UNAUTHORIZED',
      'id 2 keeps its original UNAUTHORIZED result since the retry itself never actually landed',
    );
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

  it('accepts the SAME secret as an Authorization: Bearer token — the only form codex can send', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      upstream: () => {
        forwardCount++;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex', fetchImpl, log: () => {},
    });

    const res = await fetch(handle!.url, {
      method: 'POST',
      // Deliberately NO `SECRET_HEADER` at all: codex's MCP client has no
      // custom-header support whatsoever, so this is exactly the request
      // shape it produces from `bearer_token_env_var`.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${handle!.secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    // Paired "it actually happened" assertion: a 200 alone could come from
    // anywhere, so prove the request really was authenticated and forwarded.
    assert.equal(forwardCount, 1, 'an authenticated bearer request must reach the upstream');
    assert.deepEqual(JSON.parse(await res.text()), { jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('accepts a lowercase `bearer` scheme (RFC 7235 says the scheme is case-insensitive)', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); },
    });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex', fetchImpl, log: () => {},
    });
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `bearer ${handle!.secret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    assert.equal(forwardCount, 1);
  });

  it('rejects the WRONG secret in the bearer position too, without minting or forwarding', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let mintCount = 0;
    let forwardCount = 0;
    const fetchImpl = makeFetch({
      mintToken: () => { mintCount++; return mintResponse('tok-1'); },
      upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); },
    });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex', fetchImpl, log: () => {},
    });
    const startupMintCount = mintCount;

    // Both a same-length wrong value and a different-length one -- the
    // constant-time compare rejects on length before comparing, so the two
    // take different code paths and both must fail closed.
    // Flip one character: same length as the real secret, so this one gets
    // all the way to the constant-time compare rather than being rejected
    // by the length check.
    const wrongSameLength = (handle!.secret[0] === 'a' ? 'b' : 'a') + handle!.secret.slice(1);
    assert.equal(wrongSameLength.length, handle!.secret.length);
    assert.notEqual(wrongSameLength, handle!.secret);
    for (const wrong of [`${handle!.secret}-wrong`, wrongSameLength, '']) {
      const res = await fetch(handle!.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${wrong}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tiles', arguments: {} } }),
      });
      assert.equal(res.status, 401, `bearer "${wrong}" must be refused`);
    }
    assert.equal(mintCount, startupMintCount, 'no additional mint beyond the one at startup');
    assert.equal(forwardCount, 0, 'must never reach the upstream without a valid secret');
  });

  it('rejects an Authorization header that is not a Bearer scheme, even when it carries the right secret', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardCount = 0;
    const fetchImpl = makeFetch({ upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); } });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex', fetchImpl, log: () => {},
    });
    for (const value of [handle!.secret, `Basic ${handle!.secret}`, `Bearer${handle!.secret}`]) {
      const res = await fetch(handle!.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: value },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
      });
      assert.equal(res.status, 401, `Authorization: ${value} must be refused`);
    }
    assert.equal(forwardCount, 0);
  });

  it('a WRONG custom header does not become valid just because a correct bearer is also present (and vice versa)', async () => {
    // The two accepted locations must not be able to rescue each other into
    // a weaker check: each candidate goes through the same constant-time
    // compare, and one valid candidate is what authenticates -- so a request
    // carrying one good and one bad credential is accepted (the good one is
    // genuinely valid), while one carrying two bad ones is not.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    let forwardCount = 0;
    const fetchImpl = makeFetch({ upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); } });
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'claude', fetchImpl, log: () => {},
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });

    const bothWrong = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: 'nope', Authorization: 'Bearer nope' },
      body,
    });
    assert.equal(bothWrong.status, 401);
    assert.equal(forwardCount, 0, 'two wrong credentials must not add up to one right one');

    const oneRight = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: 'nope', Authorization: `Bearer ${handle!.secret}` },
      body,
    });
    assert.equal(oneRight.status, 200);
    assert.equal(forwardCount, 1);
  });

  it('a secret from a PRIOR proxy start does not authenticate a new one via the bearer path either', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex', fetchImpl: makeFetch({}), log: () => {},
    });
    const staleSecret = handle!.secret;
    await handle!.stop();

    let forwardCount = 0;
    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1', agentId: 'codex',
      fetchImpl: makeFetch({ upstream: () => { forwardCount++; return new Response('{}', { status: 200 }); } }), log: () => {},
    });
    assert.notEqual(handle!.secret, staleSecret);
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staleSecret}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
    });
    assert.equal(res.status, 401);
    assert.equal(forwardCount, 0);
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

describe('locally-served tools', () => {
  const LOCAL_TOOL = 'yolobridge_share_file';

  function localCtx(shared: string[]) {
    return {
      workspaceId: 'w1',
      implicitRoots: ['/project'],
      commonApiBaseUrl: 'https://api.example.com',
      checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
      shareImpl: (async (p: string) => { shared.push(p); return { ok: true, assetId: 'asset-7' }; }) as any,
    };
  }

  it('serves a local tool WITHOUT forwarding it or minting a cloud token for it', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const upstreamCalls: any[] = [];
    const mintCalls: any[] = [];
    const shared: string[] = [];
    const fetchImpl = makeFetch({
      mintCalls,
      upstream: (init) => {
        upstreamCalls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: localCtx(shared),
    });
    const mintsAfterStartup = mintCalls.length;

    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: LOCAL_TOOL, arguments: { path: '/project/link.mp4' } },
      }),
    });

    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.match(body.result.content[0].text, /asset-7/);

    // The operator's file must not become a cloud request.
    assert.deepEqual(upstreamCalls, [], 'a local tool call must never be forwarded');
    // ...nor cause a delegated cloud credential to be minted for it.
    assert.equal(mintCalls.length, mintsAfterStartup, 'no extra mint for a local-only call');
    // ...and the upload opened the RESOLVED path, not the one passed in.
    assert.deepEqual(shared, ['/project/real.mp4']);
  });

  it('advertises the local tool in tools/list alongside the forwarded cloud ones', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const fetchImpl = makeFetch({
      upstream: () => new Response(JSON.stringify({
        jsonrpc: '2.0', id: 5, result: { tools: [{ name: 'studio_list_tiles' }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: localCtx([]),
    });

    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    const names = ((await res.json()) as any).result.tools.map((t: any) => t.name);
    assert.ok(names.includes('studio_list_tiles'), 'cloud tools must survive augmentation');
    assert.ok(names.includes(LOCAL_TOOL));
  });

  it('stays a pure forwarder when no local tools are configured', async () => {
    // Omitting `localTools` must change nothing — an older attach path, or a
    // future caller that does not want them, keeps the previous behaviour.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const upstreamCalls: any[] = [];
    const fetchImpl = makeFetch({
      upstream: (init) => {
        upstreamCalls.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {},
    });
    await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: LOCAL_TOOL, arguments: { path: '/x' } },
      }),
    });
    assert.equal(upstreamCalls.length, 1, 'with no local tools configured it forwards like anything else');
  });
});

describe('locally-served tools — a MIXED batch keeps both halves', () => {
  it('forwards the cloud calls, answers the local one here, and returns both', async () => {
    // The batch path is where a half can silently vanish: answer locally and
    // forget to forward the rest, or forward and drop the local reply.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const upstreamCalls: any[] = [];
    const shared: string[] = [];
    const fetchImpl = makeFetch({
      upstream: (init) => {
        const sent = JSON.parse(init.body);
        upstreamCalls.push(sent);
        return new Response(JSON.stringify(
          (Array.isArray(sent) ? sent : [sent]).map((m: any) => ({ jsonrpc: '2.0', id: m.id, result: { ok: true } })),
        ), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {},
      localTools: {
        workspaceId: 'w1', implicitRoots: ['/project'],
        commonApiBaseUrl: 'https://api.example.com',
        checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
        shareImpl: (async (p: string) => { shared.push(p); return { ok: true, assetId: 'asset-9' }; }) as any,
      },
    });

    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yolobridge_share_file', arguments: { path: '/project/link.mp4' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_read_file' } },
      ]),
    });

    // The CLOUD half really went to the cloud, and only that half.
    assert.equal(upstreamCalls.length, 1);
    assert.deepEqual(upstreamCalls[0].map((m: any) => m.id), [1, 3], 'the local call must not be forwarded');

    // Both halves come back.
    const ids = ((await res.json()) as any[]).map((m) => m.id).sort();
    assert.deepEqual(ids, [1, 2, 3], 'neither half may be lost');
    assert.deepEqual(shared, ['/project/real.mp4']);
  });
});

describe('locally-served tools — failure paths must not leak or lose the local half', () => {
  function ctxFor(shared: string[]) {
    return {
      workspaceId: 'w1', implicitRoots: ['/project'],
      commonApiBaseUrl: 'https://api.example.com',
      checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
      shareImpl: (async (p: string) => { shared.push(p); return { ok: true, assetId: 'asset-7' }; }) as any,
    };
  }
  const mixedBatch = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yolobridge_share_file', arguments: { path: '/project/link.mp4' } } },
  ]);

  it('never re-forwards the local call on a 401 RETRY', async () => {
    // The retry path skips the interception, so it is the one place the local
    // call could reach the cloud despite everything above it.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const forwarded: any[] = [];
    let n = 0;
    const fetchImpl = makeFetch({
      upstream: (init) => {
        forwarded.push(JSON.parse(init.body));
        n++;
        if (n === 1) return new Response('unauthorized', { status: 401 });
        return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: ctxFor([]),
    });
    await fetch(handle!.url, {
      method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }), body: mixedBatch,
    });

    assert.ok(forwarded.length >= 2, 'expected an initial send and a retry');
    for (const sent of forwarded) {
      const names = (Array.isArray(sent) ? sent : [sent]).map((m: any) => m?.params?.name);
      assert.ok(!names.includes('yolobridge_share_file'),
        'the local call must never be forwarded, retry included');
    }
  });

  it('still returns the local result when the CLOUD half cannot be sent', () => {
    // Tested directly on the merge, not through a live proxy: reaching the
    // token-unavailable branch needs a cached token to expire mid-request, and
    // the first version of this test guarded on `if (!handle) return`, which
    // made it assert NOTHING whenever the scenario failed to set up. A test
    // that can silently skip its own subject is worse than no test.
    //
    // The property: the local half already uploaded a file, so its reply must
    // survive, and each un-forwardable id must be told explicitly rather than
    // left unanswered.
    const local = JSON.stringify([{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Shared as asset asset-7.' }] } }]);
    const pending = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } }]);

    const merged = JSON.parse(mergeLocalWithRemoteFailure(local, pending, 'MCP token unavailable'));
    const byId = new Map<any, any>(merged.map((m: any) => [m.id, m]));

    assert.ok(byId.get(2)?.result, 'the completed local upload must still be reported');
    assert.match(byId.get(2).result.content[0].text, /asset-7/);
    assert.ok(byId.get(1)?.error, 'the id we could not forward must get an explicit error');
    assert.match(byId.get(1).error.message, /token unavailable/);
  });
});

describe('locally-served tools — response rewriting is negotiated, not assumed', () => {
  function ctxFor(shared: string[]) {
    return {
      workspaceId: 'w1', implicitRoots: ['/project'],
      commonApiBaseUrl: 'https://api.example.com',
      checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
      shareImpl: (async (p: string) => { shared.push(p); return { ok: true, assetId: 'asset-7' }; }) as any,
    };
  }

  it('ALWAYS advertises both content types — narrowing them 406s the upstream', async () => {
    // Load-bearing. An earlier attempt asked for `application/json` only on
    // requests whose reply gets rewritten, to dodge SSE framing. The MCP SDK's
    // StreamableHTTPServerTransport returns 406 unless the client accepts BOTH
    // application/json and text/event-stream, so that would have broken tool
    // discovery outright rather than simplifying anything.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const accepts: string[] = [];
    const fetchImpl = makeFetch({
      upstream: (init) => {
        accepts.push(String(init.headers?.Accept ?? ''));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 5, result: { tools: [] } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: ctxFor([]),
    });
    await fetch(handle!.url, {
      method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });

    for (const a of accepts) {
      assert.match(a, /application\/json/);
      assert.match(a, /text\/event-stream/, 'both are required or the upstream 406s');
    }
  });

  it('augments a tools/list delivered as an SSE STREAM, not just as JSON', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const fetchImpl = makeFetch({
      upstream: () => new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 5, result: { tools: [{ name: 'studio_list_tiles' }] } })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: ctxFor([]),
    });
    const res = await fetch(handle!.url, {
      method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    const text = await res.text();
    assert.match(text, /^event: message/m, 'the client negotiated a stream; keep the framing');
    assert.match(text, /yolobridge_share_file/, 'the local tool must be discoverable over SSE too');
    assert.match(text, /studio_list_tiles/, 'cloud tools must survive');
  });

  it('keeps BOTH halves of a mixed batch when the cloud half arrives as SSE', async () => {
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const shared: string[] = [];
    const fetchImpl = makeFetch({
      upstream: () => new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: ctxFor(shared),
    });
    const res = await fetch(handle!.url, {
      method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yolobridge_share_file', arguments: { path: '/project/link.mp4' } } },
      ]),
    });
    const text = await res.text();
    // Both ids present, in whatever framing the upstream chose.
    assert.match(text, /"id":1/, 'the cloud half must not be discarded by an SSE reply');
    assert.match(text, /asset-7/, 'the local half must be reported');
    assert.deepEqual(shared, ['/project/real.mp4']);
  });

  it('answers 200 with the local result even when the cloud half errors', async () => {
    // The file is already uploaded. Propagating a 500 invites the client to
    // reject the response unread and retry — uploading it twice.
    process.env.YOLOBRIDGE_MCP_URL = FAKE_UPSTREAM;
    const shared: string[] = [];
    const fetchImpl = makeFetch({
      upstream: () => new Response('upstream exploded', { status: 500 }),
    });

    handle = await startMcpProxy({
      apiUrl: 'https://api.example.com', getAccessToken: () => 'at', workspaceId: 'w1',
      agentId: 'claude', fetchImpl, log: () => {}, localTools: ctxFor(shared),
    });

    const res = await fetch(handle!.url, {
      method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yolobridge_share_file', arguments: { path: '/project/link.mp4' } } },
      ]),
    });

    assert.equal(res.status, 200, 'a completed local upload must not be hidden behind a cloud 5xx');
    const body = (await res.json()) as any[];
    const byId = new Map<any, any>(body.map((m: any) => [m.id, m]));
    assert.match(byId.get(2).result.content[0].text, /asset-7/, 'the upload is reported');
    assert.ok(byId.get(1).error, 'the cloud id gets an explicit error rather than silence');
    assert.deepEqual(shared, ['/project/real.mp4']);
  });
});
