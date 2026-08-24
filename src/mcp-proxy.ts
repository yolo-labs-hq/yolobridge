/**
 * Local MCP access for the attached agent (docs/YOLOBRIDGE_PLAN.md, "Local
 * MCP access for the attached agent"). Ports `containers/services/container-api/mcp-proxy.js`'s
 * mint-and-inject logic to run on the OPERATOR'S OWN MACHINE instead of
 * in-pod: a tiny HTTP server bound to `127.0.0.1` ONLY (never `0.0.0.0` — it
 * holds a real delegated token in memory), started on attach, that mints a
 * short-lived scoped MCP token via the same public `POST /v1/mcp/tokens`
 * endpoint pod agents already use, injects it into outgoing `tools/call`
 * requests exactly the way `mcp-proxy.js`'s `injectToken()` does, and
 * forwards to the real, already-public `yolo-studio-mcp` `/mcp` endpoint
 * (verified live 2026-08-24: `services.yolo.studio` / `services-staging.yolo.studio`,
 * both real `406`s to an unauthenticated MCP `initialize` call, not DNS
 * failures — see the plan doc for how this was confirmed instead of assumed).
 *
 * Scope is FULL, workspace-wide parity with a normal pod-hosted agent tile
 * (operator directive 2026-08-24: "the yolo-bridge tile is a first class
 * citizen and should have full access to a workspace" — supersedes the
 * narrower peer-tile-parity design this file started with). No `tileIds`
 * restriction, same as `mcp-token-broker.js`'s pod-side callers, which
 * mint an agent's `mcp.defaultScopes` unrestricted by default.
 *
 * The scope LIST isn't hardcoded here (that would drift from
 * `agents.json`, and this proxy has no access to that file — it runs on the
 * operator's own machine, not inside a pod). Instead it's fetched live from
 * the public, unauthenticated `GET /v1/mcp/scopes` — the full universe of
 * valid scope names — and the mint route's own `partitionAgentScopes`
 * silently drops whatever `agentId` (e.g. `claude`) isn't actually allowed
 * (Phase 8a F8.14; drop-not-reject, so requesting too much never errors, it
 * just narrows to the truth). This can only ever yield the SAME set the
 * bound agent's own registry entry would authorize for a pod, and stays
 * correct automatically as that registry changes — no client-side list to
 * keep in sync.
 *
 * Several scopes in that universe (`send_to_tile`, `read_tile_output`,
 * `remove_tile`, etc.) are `restricted`-exposure (`common-api/src/types/mcp.ts`),
 * which `McpAuthService.mintDelegatedToken` clamps to a 60s TTL regardless
 * of what `ttlSeconds` is requested (`RESTRICTED_SCOPE_TTL_SECONDS`) — same
 * as a pod agent's own full-scope mint, and handled the same way: refresh
 * well before that (see `REFRESH_BUFFER_MS`), plus a force-refresh-and-retry
 * backstop on a real HTTP 401 (mirroring `mcp-proxy.js:456-460`'s shape) AND
 * on the in-band UNAUTHORIZED shape this upstream actually uses in practice
 * (an expired token is reported as a normal 200 JSON-RPC tool result, not a
 * 401 — see `isUnauthorizedToolResult`'s doc comment for how this was found
 * and confirmed, not assumed).
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const DEFAULT_MCP_URL = 'https://services.yolo.studio';

export function mcpUrl(): string {
  return process.env.YOLOBRIDGE_MCP_URL || DEFAULT_MCP_URL;
}

// Requested as the max ordinary (non-restricted-exposure) TTL the mint route
// accepts; the server silently clamps to 60s anyway for this scope set
// (RESTRICTED_SCOPE_TTL_SECONDS) — requesting less than that would be a
// no-op, requesting more is harmless since the clamp always wins.
const REQUESTED_TTL_SECONDS = 300;
// Refresh well before the ACTUAL (clamped) 60s expiry, not before a naively
// assumed 300s one — a buffer sized for the default TTL would refresh AFTER
// this token already expired.
const REFRESH_BUFFER_MS = 15_000;
// Bounds the STARTUP mint only (Codex review, 2026-08-24): without this, a
// stalled scope-discovery or mint fetch would block `startMcpProxy` — and
// therefore `onAttached` — indefinitely, wedging `startLocalAgent` behind a
// best-effort enhancement that was supposed to degrade, not hang. Generous
// for a real round trip (2 sequential requests: scopes, then mint) but
// bounded; a caller that hits this still gets a working attach without MCP.
const STARTUP_MINT_TIMEOUT_MS = 15_000;

export type FetchImpl = typeof fetch;

export interface McpProxyOptions {
  /** common-api base URL (yolobridge's own apiUrl()) — where tokens are minted. */
  apiUrl: string;
  /** Live getter for the account access token (NOT a one-time snapshot) —
   *  the attach daemon proactively refreshes this roughly every 24h
   *  (Bug 2 in attach-cmd.ts's `ensureFreshToken`), and this proxy can
   *  outlive many of those refreshes over a long-running attachment.
   *  Called fresh on every mint; closing over a static token instead would
   *  401 forever once the original one expired (Codex review, 2026-08-24). */
  getAccessToken: () => string;
  workspaceId: string;
  /** The agent binary being spawned (e.g. 'claude', 'codex') — minted as-is;
   *  must be a registered agent with a spawnable binary (`isHttpMintableAgent`
   *  in common-api/src/services/agent-registry.ts) or the mint 400s. */
  agentId: string;
  fetchImpl?: FetchImpl;
  log?: (line: string) => void;
  /** Overrides `STARTUP_MINT_TIMEOUT_MS` — for tests only (a real caller
   *  should never need less than the default). */
  mintTimeoutMs?: number;
}

export interface McpProxyHandle {
  /** http://127.0.0.1:<port>/mcp — what to put in .mcp.json. */
  url: string;
  stop(): Promise<void>;
}

interface MintResult {
  token: string;
  expiresAtMs: number;
}

class TokenUnavailableError extends Error {}

/**
 * Tracks every outgoing fetch this proxy makes (mint, scope discovery, AND
 * every forwarded `tools/call`) in one `Set<AbortController>`, so `stop()`
 * (Codex review, 2026-08-24) can abort every in-flight request instead of
 * `server.close()` silently waiting out a stalled upstream — `cmdAttach`
 * awaits `stop()` before finishing cleanup, so an un-abortable hung fetch
 * there would hang the whole detach. `abortAll()` is also how the startup
 * mint's own timeout (`STARTUP_MINT_TIMEOUT_MS`) is enforced — same
 * mechanism, just triggered by a timer instead of shutdown.
 */
class RequestTracker {
  private readonly controllers = new Set<AbortController>();

  async fetch(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      this.controllers.delete(controller);
    }
  }

  abortAll(): void {
    for (const c of this.controllers) c.abort();
  }
}

/** Fetches the full universe of valid scope names from the public,
 *  unauthenticated `GET /v1/mcp/scopes` — see this file's header comment
 *  for why the mint request asks for all of them rather than a hardcoded
 *  subset (the mint route itself narrows to what `agentId` is actually
 *  allowed). */
async function fetchAllScopes(apiUrl: string, fetchImpl: FetchImpl, tracker: RequestTracker): Promise<string[]> {
  const res = await tracker.fetch(fetchImpl, `${apiUrl.replace(/\/+$/, '')}/v1/mcp/scopes`);
  if (!res.ok) throw new TokenUnavailableError(`scope discovery failed: HTTP ${res.status}`);
  const body = (await res.json()) as any;
  if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
    throw new TokenUnavailableError('scope discovery returned an unexpected shape');
  }
  return body.scopes as string[];
}

/** One cached, self-refreshing, workspace-wide token — scoped to whatever
 *  `agentId`'s registry entry actually allows out of the full scope
 *  universe (see this file's header comment). */
function makeTokenCache(
  apiUrl: string,
  getAccessToken: () => string,
  workspaceId: string,
  agentId: string,
  fetchImpl: FetchImpl,
  tracker: RequestTracker,
) {
  let cached: MintResult | undefined;

  async function mint(): Promise<MintResult> {
    const scopes = await fetchAllScopes(apiUrl, fetchImpl, tracker);
    const res = await tracker.fetch(fetchImpl, `${apiUrl.replace(/\/+$/, '')}/v1/mcp/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        agentId,
        scopes,
        ttlSeconds: REQUESTED_TTL_SECONDS,
      }),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as any;
        if (typeof body?.error === 'string') message = body.error;
      } catch {
        /* keep the HTTP-status fallback */
      }
      throw new TokenUnavailableError(`mint failed: ${message}`);
    }
    const body = (await res.json()) as any;
    if (typeof body?.token !== 'string' || typeof body?.expiresAt !== 'string') {
      throw new TokenUnavailableError('mint returned an unexpected shape');
    }
    return { token: body.token, expiresAtMs: new Date(body.expiresAt).getTime() };
  }

  return {
    async getToken(): Promise<string> {
      if (cached && Date.now() < cached.expiresAtMs - REFRESH_BUFFER_MS) return cached.token;
      cached = await mint();
      return cached.token;
    },
    async forceRefresh(): Promise<string> {
      cached = await mint();
      return cached.token;
    },
  };
}

/**
 * Starts the local proxy. Returns `undefined` (never throws) if the initial
 * mint fails — MCP access is a best-effort enhancement on top of a tile
 * that already works without it (send_to_tile/read_tile_output into the
 * daemon's own PTY are unaffected either way), so a mint failure (e.g. an
 * unregistered --agent binary) must not abort the whole `attach`.
 */
export async function startMcpProxy(opts: McpProxyOptions): Promise<McpProxyHandle | undefined> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tracker = new RequestTracker();

  const tokenCache = makeTokenCache(opts.apiUrl, opts.getAccessToken, opts.workspaceId, opts.agentId, fetchImpl, tracker);

  // Bounded (STARTUP_MINT_TIMEOUT_MS): a stalled scope-discovery/mint fetch
  // must not block `onAttached` from ever reaching `startLocalAgent`
  // (Codex review, 2026-08-24). `abortAll()` only affects requests in
  // flight AT the timeout — this timer is cleared as soon as the mint
  // settles either way, so it can never fire against the running proxy's
  // later request traffic.
  const startupTimeout = setTimeout(() => tracker.abortAll(), opts.mintTimeoutMs ?? STARTUP_MINT_TIMEOUT_MS);
  try {
    await tokenCache.getToken();
  } catch (err) {
    log(`yolo-bridge: local MCP access unavailable (${err instanceof Error ? err.message : String(err)}) — continuing without it.`);
    return undefined;
  } finally {
    clearTimeout(startupTimeout);
  }

  const upstream = mcpUrl().replace(/\/+$/, '');

  const server = http.createServer((req, res) => {
    handleRequest(req, res, upstream, tokenCache.getToken, tokenCache.forceRefresh, fetchImpl, tracker, log).catch((err) => {
      log(`yolo-bridge: local MCP proxy error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'local MCP proxy error' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 explicitly — never '0.0.0.0'/omitted (which node-pty's host
    // stack treats as "all interfaces"). This server holds a real delegated
    // token in memory; binding wider would expose it to the local network.
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  log(`yolo-bridge: local MCP access ready (${url}).`);

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        // Two separate reasons server.close() alone could hang (Codex
        // review, 2026-08-24; `cmdAttach` awaits `stop()` before finishing
        // its own cleanup, so either one hangs the whole detach):
        // 1. A stalled/slow fetch to `upstream` — abortAll() rejects it,
        //    which lets handleRequest's own catch send a response and end
        //    the local connection.
        // 2. Node's http server keeps a client's underlying socket open
        //    for keep-alive by default; close() only waits for connections
        //    to end NATURALLY (it does not itself close idle ones), so a
        //    client that doesn't proactively close its socket (real MCP
        //    clients keep HTTP connections alive) would otherwise still
        //    hang close() even after (1) ends the in-flight request/response.
        //    closeAllConnections() (Node >=18.2, this package requires
        //    >=20) force-closes every connection immediately.
        tracker.abortAll();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Injects `_delegatedToken` into a `tools/call` request's `params.arguments`
 *  — the exact shape `mcp-proxy.js`'s own `injectToken()` uses, not
 *  reinvented. Returns the body unchanged if it isn't a tools/call (or isn't
 *  valid JSON — the upstream can reject that on its own terms). */
function injectToken(rawBody: string, token: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (Array.isArray(parsed)) {
      let changed = false;
      for (const msg of parsed) {
        if (msg?.method === 'tools/call' && msg.params?.arguments) {
          msg.params.arguments._delegatedToken = token;
          changed = true;
        }
      }
      return changed ? JSON.stringify(parsed) : rawBody;
    }
    if (parsed?.method === 'tools/call' && parsed.params?.arguments) {
      parsed.params.arguments._delegatedToken = token;
      return JSON.stringify(parsed);
    }
    return rawBody;
  } catch {
    return rawBody;
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Detects an UNAUTHORIZED tool error IN-BAND, not via HTTP status.
 *
 * Real bug found live (2026-08-24): the MCP SDK reports a thrown tool error
 * (`McpToolError('Invalid delegated token', 'UNAUTHORIZED')`,
 * `yolo-studio-mcp/src/auth/token-validator.ts:55`) as a normal JSON-RPC
 * SUCCESS response -- HTTP 200, `result.content[0].text` holding the error
 * as a JSON string -- standard MCP behavior (tool execution errors are
 * in-band content, not a transport-level failure). Confirmed empirically
 * against the real upstream with a deliberately invalid token before fixing
 * this, not assumed: `curl` returned `HTTP 200` with
 * `{"result":{"content":[{"type":"text","text":"{\"error\":\"Invalid
 * delegated token\",\"code\":\"UNAUTHORIZED\"}"}]}, ...}`. The original
 * `result.status === 401` check below can therefore never fire for the
 * exact case it exists to catch -- a token that expired between mint and
 * use (the 60s `RESTRICTED_SCOPE_TTL_SECONDS` clamp this file's header
 * comment describes makes this a real, not theoretical, window). Parses
 * defensively (a malformed/unexpected shape is treated as "not this error",
 * never thrown) -- this must not become a new way to crash the proxy.
 */
function isUnauthorizedToolResult(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    const content = parsed?.result?.content;
    if (!Array.isArray(content)) return false;
    for (const item of content) {
      if (typeof item?.text !== 'string') continue;
      try {
        const inner = JSON.parse(item.text);
        if (inner?.code === 'UNAUTHORIZED') return true;
      } catch {
        // item.text wasn't JSON -- not this error shape, keep checking
        // other content items rather than guessing from a substring match
        // (a legitimate tool result could coincidentally contain the word).
      }
    }
  } catch {
    // Top-level body wasn't JSON at all -- not this error shape.
  }
  return false;
}

async function forwardOnce(
  upstream: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  fetchImpl: FetchImpl,
  tracker: RequestTracker,
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await tracker.fetch(fetchImpl, `${upstream}/mcp`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: string,
  getToken: () => Promise<string>,
  forceRefresh: () => Promise<string>,
  fetchImpl: FetchImpl,
  tracker: RequestTracker,
  log: (line: string) => void,
): Promise<void> {
  const method = req.method ?? 'POST';
  const body = method === 'POST' || method === 'DELETE' ? await readBody(req) : undefined;

  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' };
  const incomingContentType = req.headers['content-type'];
  if (typeof incomingContentType === 'string') headers['Content-Type'] = incomingContentType;
  else if (body) headers['Content-Type'] = 'application/json';

  let forwardedBody = body;
  if (method === 'POST' && body) {
    try {
      const token = await getToken();
      forwardedBody = injectToken(body, token);
    } catch (err) {
      log(`yolo-bridge: MCP token unavailable: ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP token unavailable', code: 'MCP_TOKEN_UNAVAILABLE', retryable: true }));
      return;
    }
  }

  let result = await forwardOnce(upstream, method, headers, forwardedBody, fetchImpl, tracker);

  // Retry once on 401, force-refreshing first — mirrors mcp-proxy.js's own
  // retry shape exactly (containers/services/container-api/mcp-proxy.js:456-460).
  // ALSO retry on a 200-with-in-band-UNAUTHORIZED (see
  // isUnauthorizedToolResult's doc comment) — a real 401 from this upstream
  // has never actually been observed; the in-band case is the one that
  // matters in practice.
  if (method === 'POST' && body && (result.status === 401 || isUnauthorizedToolResult(result.text))) {
    log(`yolo-bridge: MCP upstream reported an invalid/expired token (status ${result.status}), force-refreshing`);
    try {
      const refreshed = await forceRefresh();
      const reinjected = injectToken(body, refreshed);
      result = await forwardOnce(upstream, method, headers, reinjected, fetchImpl, tracker);
    } catch (err) {
      log(`yolo-bridge: MCP token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const outHeaders: Record<string, string> = {};
  const contentType = result.headers.get('content-type');
  if (contentType) outHeaders['Content-Type'] = contentType;
  res.writeHead(result.status, outHeaders);
  res.end(result.text);
}
