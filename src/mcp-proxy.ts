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
 * Scope is deliberately NARROW (operator-approved, not the full `studio.*`
 * surface an orchestrator-role tile might get): peer-tile parity only —
 * `send_to_tile`, `read_tile_output`, `list_tiles`, `get_workspace_context`
 * — bound to this attachment's own tileId. `send_to_tile`/`read_tile_output`
 * are `restricted`-exposure scopes (`common-api/src/types/mcp.ts`), which
 * `McpAuthService.mintDelegatedToken` clamps to a 60s TTL regardless of what
 * `ttlSeconds` is requested (`RESTRICTED_SCOPE_TTL_SECONDS`) — this is NOT
 * the 300s default a wider-scoped mint would get. `getToken()` below refreshes
 * proactively well before that (see `REFRESH_BUFFER_MS`), and the request
 * handler force-refreshes and retries once on a live 401 as a backstop —
 * mirroring `mcp-proxy.js:456-460`'s exact shape, not reinvented.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const DEFAULT_MCP_URL = 'https://services.yolo.studio';

export function mcpUrl(): string {
  return process.env.YOLOBRIDGE_MCP_URL || DEFAULT_MCP_URL;
}

/** Peer-tile parity — see this file's header comment for why not the full `studio.*` surface. */
export const NARROW_MCP_SCOPES = [
  'studio.send_to_tile',
  'studio.read_tile_output',
  'studio.list_tiles',
  'studio.get_workspace_context',
] as const;

// Requested as the max ordinary (non-restricted-exposure) TTL the mint route
// accepts; the server silently clamps to 60s anyway for this scope set
// (RESTRICTED_SCOPE_TTL_SECONDS) — requesting less than that would be a
// no-op, requesting more is harmless since the clamp always wins.
const REQUESTED_TTL_SECONDS = 300;
// Refresh well before the ACTUAL (clamped) 60s expiry, not before a naively
// assumed 300s one — a buffer sized for the default TTL would refresh AFTER
// this token already expired.
const REFRESH_BUFFER_MS = 15_000;

export type FetchImpl = typeof fetch;

export interface McpProxyOptions {
  /** common-api base URL (yolobridge's own apiUrl()) — where tokens are minted. */
  apiUrl: string;
  /** The account access token already in ~/.config/yolobridge/auth.json. */
  accessToken: string;
  workspaceId: string;
  /** This attachment's own tileId — the mint is bound to it (tileIds: [tileId]). */
  tileId: string;
  /** The agent binary being spawned (e.g. 'claude', 'codex') — minted as-is;
   *  must be a registered agent with a spawnable binary (`isHttpMintableAgent`
   *  in common-api/src/services/agent-registry.ts) or the mint 400s. */
  agentId: string;
  fetchImpl?: FetchImpl;
  log?: (line: string) => void;
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
 * Starts the local proxy. Returns `undefined` (never throws) if the FIRST
 * mint fails — MCP access is a best-effort enhancement on top of a tile
 * that already works without it (send_to_tile/read_tile_output into the
 * daemon's own PTY are unaffected either way), so a mint failure (e.g. an
 * unregistered --agent binary) must not abort the whole `attach`.
 */
export async function startMcpProxy(opts: McpProxyOptions): Promise<McpProxyHandle | undefined> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  let cached: MintResult | undefined;

  async function mint(): Promise<MintResult> {
    const res = await fetchImpl(`${opts.apiUrl.replace(/\/+$/, '')}/v1/mcp/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        agentId: opts.agentId,
        scopes: NARROW_MCP_SCOPES,
        tileIds: [opts.tileId],
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

  async function getToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAtMs - REFRESH_BUFFER_MS) return cached.token;
    cached = await mint();
    return cached.token;
  }

  async function forceRefresh(): Promise<string> {
    cached = await mint();
    return cached.token;
  }

  try {
    await getToken();
  } catch (err) {
    log(`yolo-bridge: local MCP access unavailable (${err instanceof Error ? err.message : String(err)}) — continuing without it.`);
    return undefined;
  }

  const upstream = mcpUrl().replace(/\/+$/, '');

  const server = http.createServer((req, res) => {
    handleRequest(req, res, upstream, getToken, forceRefresh, fetchImpl, log).catch((err) => {
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
        server.close(() => resolve());
        // close() waits for in-flight requests; this proxy has no persistent
        // connections to worry about (each MCP call is a plain request/response,
        // confirmed in the design doc — no SSE/session state here), so this
        // resolves promptly in practice.
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

async function forwardOnce(
  upstream: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  fetchImpl: FetchImpl,
): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetchImpl(`${upstream}/mcp`, { method, headers, body });
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

  let result = await forwardOnce(upstream, method, headers, forwardedBody, fetchImpl);

  // Retry once on 401, force-refreshing first — mirrors mcp-proxy.js's own
  // retry shape exactly (containers/services/container-api/mcp-proxy.js:456-460).
  if (method === 'POST' && result.status === 401 && body) {
    log('yolo-bridge: got 401 from MCP upstream, force-refreshing token');
    try {
      const refreshed = await forceRefresh();
      const reinjected = injectToken(body, refreshed);
      result = await forwardOnce(upstream, method, headers, reinjected, fetchImpl);
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
