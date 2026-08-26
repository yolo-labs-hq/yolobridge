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
 *
 * Requires a per-attach secret on every request (Codex review, 2026-08-24,
 * round 10): binding to `127.0.0.1` only keeps this off the local NETWORK,
 * but it does nothing against another process on the SAME host — a
 * different OS user, or a sandboxed process sharing the host's network
 * namespace, can still reach a loopback port and would otherwise get a
 * full-workspace-scoped delegated token minted on its behalf with zero
 * credential of its own. `startMcpProxy` generates a random secret and
 * hands it back in `McpProxyHandle.secret`.
 *
 * The secret is never written to disk and never appears in an argument
 * vector. As of 2026-08-26 the agent is configured entirely on its COMMAND
 * LINE (`agent-mcp-args.ts`) — no `.mcp.json` is written into the project
 * tree at all any more — and what that command line carries is a REFERENCE
 * to `SECRET_ENV_VAR`, never its value: a `${SECRET_ENV_VAR}` template
 * inside claude's inline `--mcp-config` JSON, and the variable's NAME via
 * codex's `bearer_token_env_var`. `cli.ts` sets the real secret on
 * `SECRET_ENV_VAR` in its OWN `process.env` right before spawning the local
 * agent, which inherits it. argv is world-readable (`ps`,
 * `/proc/<pid>/cmdline`) while `/proc/<pid>/environ` is owner-only, so the
 * actual value only ever exists in memory: this server's, the daemon's, and
 * the locally-spawned agent's.
 *
 * TWO request locations are accepted for it, because the two agents this
 * proxy serves have disjoint capabilities — see `providedSecrets` below.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

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
  /** The tile this daemon attached (the `tileId` from `attach`) — minted as
   *  the token's `callerTileId` self-identity claim so the spawned agent can
   *  tell which `studio_list_tiles` row is ITSELF instead of guessing. It is
   *  NOT a `tileIds` restriction (this proxy stays workspace-wide by design,
   *  see this file's header); it only marks that row `isCaller: true` and makes
   *  `studio_send_to_tile` refuse a prompt addressed back at this same tile —
   *  the exact self-dialogue loop a wrong guess produced. Optional: an older
   *  common-api simply ignores the field. */
  callerTileId?: string;
  fetchImpl?: FetchImpl;
  log?: (line: string) => void;
  /** Overrides `STARTUP_MINT_TIMEOUT_MS` — for tests only (a real caller
   *  should never need less than the default). */
  mintTimeoutMs?: number;
}

export interface McpProxyHandle {
  /** http://127.0.0.1:<port>/mcp — what to put in .mcp.json. */
  url: string;
  /** Per-attach random credential the caller (`.mcp.json`'s `headers`) must
   *  present as `SECRET_HEADER` on every request — see this module's header
   *  comment on why loopback binding alone isn't sufficient. */
  secret: string;
  stop(): Promise<void>;
}

/** Header Claude Code sends the per-attach secret in (Codex review,
 *  2026-08-24, round 10), from the `headers` map in the inline
 *  `--mcp-config` JSON. Exported so `agent-mcp-args.ts` builds the exact
 *  same key this file checks. Codex cannot send a custom header at all and
 *  uses `Authorization: Bearer` instead — see `providedSecrets`. */
export const SECRET_HEADER = 'x-yolobridge-proxy-secret';

/**
 * Env var the per-attach secret is exported under before the local agent is
 * spawned. Both agents are pointed at it by NAME, never by value:
 *   - claude receives the literal template `${YOLOBRIDGE_MCP_PROXY_SECRET}`
 *     as the `SECRET_HEADER` value inside its inline `--mcp-config` JSON,
 *     expanded by Claude Code's own `${VAR}` support at load time against
 *     ITS process env, inherited from this daemon (verified on the wire,
 *     2026-08-26 — a probe MCP server received the expanded value).
 *   - codex receives this string as `bearer_token_env_var` and reads the
 *     variable itself, sending `Authorization: Bearer <value>`.
 *
 * This daemon writes NO file into the project tree, so the secret cannot be
 * committed; and it puts no literal into argv, so it cannot be read out of
 * `ps` by another local user.
 */
export const SECRET_ENV_VAR = 'YOLOBRIDGE_MCP_PROXY_SECRET';

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
 *
 * `run()` keeps the controller registered for the caller's ENTIRE callback,
 * not just until `fetch()` itself resolves (Codex review, 2026-08-24,
 * round 14): `fetch()` resolves as soon as response HEADERS arrive, well
 * before the body is read. The original design removed the controller in a
 * `finally` right after that — if the upstream then stalled mid-BODY (e.g.
 * `res.json()`/`res.text()` never resolves), neither the startup mint
 * timeout nor `stop()` had a live controller left to abort, since it was
 * already untracked. Every caller must do its ENTIRE fetch-and-consume
 * inside the callback so the controller stays registered until the body is
 * fully read (or the whole thing is aborted).
 */
class RequestTracker {
  private readonly controllers = new Set<AbortController>();

  async run<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await body(controller.signal);
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
  return tracker.run(async (signal) => {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/v1/mcp/scopes`, { signal });
    if (!res.ok) throw new TokenUnavailableError(`scope discovery failed: HTTP ${res.status}`);
    const body = (await res.json()) as any;
    if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
      throw new TokenUnavailableError('scope discovery returned an unexpected shape');
    }
    return body.scopes as string[];
  });
}

/** One cached, self-refreshing, workspace-wide token — scoped to whatever
 *  `agentId`'s registry entry actually allows out of the full scope
 *  universe (see this file's header comment). */
function makeTokenCache(
  apiUrl: string,
  getAccessToken: () => string,
  workspaceId: string,
  agentId: string,
  callerTileId: string | undefined,
  fetchImpl: FetchImpl,
  tracker: RequestTracker,
) {
  let cached: MintResult | undefined;

  async function mint(): Promise<MintResult> {
    const scopes = await fetchAllScopes(apiUrl, fetchImpl, tracker);
    return tracker.run(async (signal) => {
      const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/v1/mcp/tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          agentId,
          scopes,
          ...(callerTileId ? { callerTileId } : {}),
          ttlSeconds: REQUESTED_TTL_SECONDS,
        }),
        signal,
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
    });
  }

  // Coalesces concurrent mints into ONE in-flight request (Codex review,
  // 2026-08-24, round 6): agents commonly issue several tool calls at
  // once, and without this every one of them that happened to observe an
  // expired/near-expiry cache independently kicked off its own
  // scope-discovery + mint round trip — a recurring burst against the
  // mint endpoint that could trigger throttling, not just wasted work.
  // `forceRefresh` shares the same gate: if a 401-triggered refresh
  // overlaps a plain getToken() mint already in flight, they both just
  // want "a fresh token," so reusing that one request is correct, not a
  // shortcut.
  let pendingMint: Promise<MintResult> | undefined;
  function mintOnce(): Promise<MintResult> {
    if (!pendingMint) {
      pendingMint = mint().finally(() => { pendingMint = undefined; });
    }
    return pendingMint;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && Date.now() < cached.expiresAtMs - REFRESH_BUFFER_MS) return cached.token;
      cached = await mintOnce();
      return cached.token;
    },
    async forceRefresh(): Promise<string> {
      cached = await mintOnce();
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

  const tokenCache = makeTokenCache(opts.apiUrl, opts.getAccessToken, opts.workspaceId, opts.agentId, opts.callerTileId, fetchImpl, tracker);

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
  const secret = randomBytes(32).toString('hex');

  const server = http.createServer((req, res) => {
    if (!hasValidSecret(req, secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing or invalid proxy credential' }));
      return;
    }
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
    secret,
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
/** Injects `_delegatedToken` into one `tools/call` message, creating
 *  `params.arguments` first if it's absent (Codex review, 2026-08-24,
 *  round 4) -- MCP allows a zero-input tool's call to omit `arguments`
 *  entirely, and the original `msg.params?.arguments` truthiness check
 *  skipped injection for exactly that shape, so any zero-input tool always
 *  reached the upstream with no token and came back UNAUTHORIZED. Mutates
 *  and returns true if this message needed the token, so callers can tell
 *  whether anything actually changed. */
function injectTokenIntoMessage(msg: any, token: string): boolean {
  if (msg?.method !== 'tools/call' || typeof msg.params !== 'object' || msg.params === null) return false;
  if (typeof msg.params.arguments !== 'object' || msg.params.arguments === null) msg.params.arguments = {};
  msg.params.arguments._delegatedToken = token;
  return true;
}

function injectToken(rawBody: string, token: string): string {
  try {
    const parsed = JSON.parse(rawBody);
    if (Array.isArray(parsed)) {
      let changed = false;
      for (const msg of parsed) {
        if (injectTokenIntoMessage(msg, token)) changed = true;
      }
      return changed ? JSON.stringify(parsed) : rawBody;
    }
    return injectTokenIntoMessage(parsed, token) ? JSON.stringify(parsed) : rawBody;
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
 *
 * Also checks a JSON-RPC BATCH response, not just a single object (Codex
 * review, 2026-08-24, round 16): `injectToken` above already handles a
 * batched REQUEST (`Array.isArray(parsed)`), so a batched RESPONSE is
 * equally real on the way back. Without this, a batch containing an
 * UNAUTHORIZED result was invisible to this check (`parsed?.result` is
 * `undefined` on an array), so the force-refresh-and-retry never fired --
 * every batched call kept failing with the same stale token until the
 * cache's own `REFRESH_BUFFER_MS`-driven expiry eventually caught up on
 * its own, not on the first sign of trouble.
 */
function isUnauthorizedResponseItem(response: any): boolean {
  const content = response?.result?.content;
  if (!Array.isArray(content)) return false;
  for (const item of content) {
    if (typeof item?.text !== 'string') continue;
    try {
      const inner = JSON.parse(item.text);
      if (inner?.code === 'UNAUTHORIZED') return true;
    } catch {
      // item.text wasn't JSON -- not this error shape, keep checking other
      // content items rather than guessing from a substring match (a
      // legitimate tool result could coincidentally contain the word).
    }
  }
  return false;
}

function isUnauthorizedToolResult(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    const responses = Array.isArray(parsed) ? parsed : [parsed];
    return responses.some(isUnauthorizedResponseItem);
  } catch {
    // Top-level body wasn't JSON at all -- not this error shape.
    return false;
  }
}

/**
 * Picks out only the batch elements that need a retry, instead of replaying
 * the WHOLE original batch (Codex review, 2026-08-24, round 20): a JSON-RPC
 * batch with a short-lived token can come back 200-with-mixed-results --
 * some calls already succeeded, one or more failed in-band UNAUTHORIZED
 * because the token expired partway through. The previous retry resent the
 * entire original body, including the already-successful calls; many MCP
 * tools are not idempotent, so a mutating call earlier in the batch would
 * execute a SECOND time. Matches request/response pairs by JSON-RPC `id`
 * (batch elements needing a response always carry one; bare notifications
 * never appear in the response array either, so they're naturally excluded
 * from both sides).
 *
 * Returns `null` when there's nothing to partition -- a non-batch request,
 * an unparseable/non-array response, or a batch where nothing came back
 * UNAUTHORIZED -- so the caller falls back to its existing whole-body retry,
 * which is already correct and minimal for a single (non-batch) request.
 */
function buildUnauthorizedRetryBatch(
  requestBody: string,
  responseText: string,
): { requestSubset: string; ids: Set<string | number> } | null {
  let requestParsed: any;
  let responseParsed: any;
  try {
    requestParsed = JSON.parse(requestBody);
    responseParsed = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (!Array.isArray(requestParsed) || !Array.isArray(responseParsed)) return null;

  const unauthorizedIds = new Set<string | number>();
  for (const response of responseParsed) {
    if (response?.id === undefined || response?.id === null) continue;
    if (isUnauthorizedResponseItem(response)) unauthorizedIds.add(response.id);
  }
  if (unauthorizedIds.size === 0) return null;

  const requestSubset = requestParsed.filter((msg: any) => msg?.id !== undefined && msg?.id !== null && unauthorizedIds.has(msg.id));
  if (requestSubset.length === 0) return null;

  return { requestSubset: JSON.stringify(requestSubset), ids: unauthorizedIds };
}

/**
 * Splices a retried subset's responses back into their original positions
 * in the first attempt's batch response, leaving every already-successful
 * element exactly as it came back the first time. Falls back to the ORIGINAL
 * response text on any parse failure -- this only ever runs after a retry
 * that itself only fires for a confirmed-parseable batch (`buildUnauthorized
 * RetryBatch` already validated both shapes), so a failure here means
 * something unexpected changed between the two parses; discarding the
 * (already-good) first response in that case would be strictly worse than
 * keeping it.
 */
function mergeRetryResponses(originalResponseText: string, retryResponseText: string, retriedIds: Set<string | number>): string {
  try {
    const original = JSON.parse(originalResponseText);
    if (!Array.isArray(original)) return originalResponseText;
    const retryParsed = JSON.parse(retryResponseText);
    const retryArray = Array.isArray(retryParsed) ? retryParsed : [retryParsed];
    const retryById = new Map<string | number, any>();
    for (const r of retryArray) {
      if (r?.id !== undefined && r?.id !== null) retryById.set(r.id, r);
    }
    const merged = original.map((r: any) => (r?.id !== undefined && retriedIds.has(r.id) && retryById.has(r.id) ? retryById.get(r.id) : r));
    return JSON.stringify(merged);
  } catch {
    return originalResponseText;
  }
}

async function forwardOnce(
  upstream: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  fetchImpl: FetchImpl,
  tracker: RequestTracker,
): Promise<{ status: number; headers: Headers; text: string }> {
  return tracker.run(async (signal) => {
    const res = await fetchImpl(`${upstream}/mcp`, { method, headers, body, signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  });
}

/** Constant-time string comparison — wrong-length or mismatched both fail
 *  closed. `timingSafeEqual` throws on a length mismatch rather than
 *  returning false, so length is checked first.
 *
 *  The ONE comparison both accepted credential locations below go through
 *  (2026-08-26): two hand-rolled compares would be free to drift apart in
 *  strictness (one timing-safe, one `===`; one length-checked, one not),
 *  which is exactly the divergence a second auth path invites. */
function secretsMatch(provided: string, secret: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf-8');
  const secretBuf = Buffer.from(secret, 'utf-8');
  if (providedBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(providedBuf, secretBuf);
}

/**
 * Every location this request could be carrying the per-attach secret in.
 *
 * TWO of them, because the two agents this proxy serves cannot both use the
 * same one (2026-08-26):
 *   1. `SECRET_HEADER` (`x-yolobridge-proxy-secret`) — what Claude Code
 *      sends, from the `headers` map in the inline `--mcp-config` JSON.
 *   2. `Authorization: Bearer <secret>` — what Codex sends. Codex's MCP
 *      client has exactly one credential mechanism,
 *      `bearer_token_env_var`, reported by `codex mcp list` as
 *      "Auth: Bearer token"; it has NO custom-header support at all, so
 *      without accepting the bearer form there is no way to authenticate a
 *      Codex client to this proxy.
 *
 * Both are the SAME credential, checked by the SAME `secretsMatch` — this
 * is a second transport for one secret, not a second, weaker credential.
 * Anything unparseable (no `Bearer ` prefix, an array-valued header from a
 * duplicated header line) simply contributes no candidate and therefore
 * cannot authenticate.
 */
function providedSecrets(req: http.IncomingMessage): string[] {
  const candidates: string[] = [];
  const headerValue = req.headers[SECRET_HEADER];
  if (typeof headerValue === 'string') candidates.push(headerValue);
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    // Scheme match is case-insensitive per RFC 7235; the token itself is
    // taken verbatim (no trim of the token) so a mangled value fails the
    // constant-time compare rather than being silently "repaired" into a
    // match.
    const match = /^bearer +(.*)$/i.exec(authorization);
    if (match) candidates.push(match[1]);
  }
  return candidates;
}

/** Accepts the per-attach secret from EITHER location (see
 *  `providedSecrets`) — missing, wrong-length, or mismatched all fail
 *  closed, identically for both. */
function hasValidSecret(req: http.IncomingMessage, secret: string): boolean {
  let valid = false;
  // Deliberately NOT `.some()` (which short-circuits): every candidate is
  // compared, so the number of constant-time compares performed does not
  // depend on WHICH location happened to carry a matching value.
  for (const candidate of providedSecrets(req)) {
    if (secretsMatch(candidate, secret)) valid = true;
  }
  return valid;
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
      // A transport-level 401 means nothing in the request was ever applied
      // (the upstream rejected it before running any tool), so retrying the
      // whole original body is correct and minimal there. Only an in-band
      // 200-with-mixed-results batch (Codex review, 2026-08-24, round 20)
      // needs the narrower partial-batch retry below -- see
      // `buildUnauthorizedRetryBatch`'s doc comment.
      const retryBatch = result.status === 401 ? null : buildUnauthorizedRetryBatch(body, result.text);
      if (retryBatch) {
        const reinjected = injectToken(retryBatch.requestSubset, refreshed);
        const retryResult = await forwardOnce(upstream, method, headers, reinjected, fetchImpl, tracker);
        const mergedText = mergeRetryResponses(result.text, retryResult.text, retryBatch.ids);
        // Only adopt the SUBSET retry's own status/headers when it actually
        // succeeded at the transport level (Codex review, 2026-08-24, round
        // 26): the trigger for this whole branch guarantees the ORIGINAL
        // response was a 200 (a transport-level 401 takes the whole-body
        // retry path above instead), so a retry that itself comes back
        // non-2xx (a genuine upstream 500, not a network error -- that
        // throws and is caught below, leaving `result` untouched) must not
        // promote its OWN failure status onto the merged response. The body
        // already correctly falls back to the ORIGINAL (still-successful-
        // for-the-other-elements) text in that case; overwriting the status
        // too would tell the caller the WHOLE batch failed and invite a
        // blind full retry that double-mutates the already-successful
        // elements — exactly what this partial-retry logic exists to
        // prevent, just via the status code instead of the body this time.
        result = retryResult.status >= 200 && retryResult.status < 300
          ? { ...retryResult, text: mergedText }
          : { ...result, text: mergedText };
      } else {
        const reinjected = injectToken(body, refreshed);
        result = await forwardOnce(upstream, method, headers, reinjected, fetchImpl, tracker);
      }
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
