/**
 * `yolo-bridge attach <workspaceId>` — the daemon loop.
 *
 * Calls `POST .../yolobridge/attach`, then holds `GET .../yolobridge/stream`
 * open: parses SSE frames (sse-frame-parser.ts), dispatches them
 * (frame-actions.ts), reconnects with backoff on disconnect
 * (reconnect.ts), and posts a heartbeat every ~10s while connected
 * (heartbeat.ts). All the pure logic lives in those sibling modules and is
 * unit tested there; this file is the network/process glue that wires
 * them together, plus a light structural test below driving it through a
 * fake in-memory SSE stream.
 *
 * Sleep/wake-aware resilience: see reconnect.ts's header comment — plain
 * bounded exponential backoff is implemented; true OS sleep/wake signal
 * detection is NOT, and is called out there and in the final report as a
 * deliberate scope cut.
 */

import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import * as readline from 'node:readline';
import { SseFrameParser } from './sse-frame-parser.js';
import { actionForFrame } from './frame-actions.js';
import { startHeartbeat, defaultTimers, type HeartbeatScheduler, type TimerImpl } from './heartbeat.js';
import { nextBackoffMs, type BackoffOptions } from './reconnect.js';
import { deliverPromptToLocalAgent, captureLocalAgentOutput } from './local-agent.js';
import * as apiClient from './api-client.js';
import { refreshAccessToken as refreshAccessTokenApi, type RefreshTokenResult } from './device-auth.js';
import {
  loadAuth,
  saveAuth,
  loadAttachment,
  saveAttachment,
  clearAttachment,
  type ConfigStoreIO,
  type StoredAuth,
} from './config-store.js';
import {
  recordConnectionEvent,
  resetConnectionState,
  type ConnectionEvent,
  type ConnectionState,
} from './connection-state.js';

/** Same shape as device-auth.ts's `refreshAccessToken` — injectable so tests
 * don't hit the network. Defaults to the real auth-service call. */
export type RefreshTokenFn = (
  authBaseUrl: string,
  refreshToken: string,
  fetchImpl?: apiClient.FetchImpl,
) => Promise<RefreshTokenResult>;

const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';
/** Refresh once the access token has less than this much validity left.
 * Production access tokens live 24h; 5min gives ample margin against a
 * slow/retried refresh call before the old token actually 401s. */
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60_000;
/** How often to re-check `shouldStop()`/a failed-refresh flag while an SSE
 * stream is open and blocked on `for await`. The server holds the stream
 * open indefinitely (keepalive pings only), so without an active poll here
 * a stop signal would never be noticed until the stream happened to end on
 * its own — which, by design, it doesn't. Small enough to be prompt,
 * cheap enough to not matter (a no-op comparison on every tick). */
const STOP_POLL_INTERVAL_MS = 250;

/**
 * Fraction of the SCOPED credential's lifetime to spend before renewing it
 * (card 07, docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md D1). At the server's 1h
 * TTL this renews ~45 minutes in.
 *
 * Deliberately BEFORE expiry, not after: the server's grace window for a
 * just-expired token is a SKEW allowance, not a refresh interval. Spending it
 * on the normal path would leave nothing in reserve for the cases it exists
 * for — a laptop that slept, a clock that drifted, a network outage that
 * happened to straddle the scheduled renewal. On the happy path the daemon
 * never presents an expired credential at all.
 *
 * Derived from the expiry the SERVER reported (`scopedTokenExpiresAt`), never
 * from a TTL constant duplicated here: this binary sits frozen on a laptop for
 * months and must follow whatever lifetime the server it is talking to today
 * actually issued.
 */
const SCOPED_REFRESH_AT_FRACTION = 0.75;

/**
 * The daemon's own copy of the server's `YOLOBRIDGE_REFRESH_MAX_EXPIRED_MS`
 * (15 minutes) — how long past expiry a renewal can still succeed.
 *
 * A copy, not an import: the two live on opposite sides of a frozen-binary
 * seam. It is used ONLY to decide when to stop retrying and tell the operator
 * to re-attach; the server is the authority on whether any given renewal is
 * accepted. A copy that drifted SHORT makes this daemon give up slightly early
 * (an honest re-attach), and one that drifted LONG makes it retry a few
 * doomed requests — neither can widen the server's actual window.
 */
const SCOPED_REFRESH_GRACE_MS = 15 * 60_000;

export interface AttachDaemonDeps {
  workspaceId: string;
  commonApiBaseUrl: string;
  hostLabel?: string;
  /** Non-sensitive facts about this machine, sent once in the attach
   *  handshake so the workspace tile can show where the session is running
   *  (see api-client.ts's `RemoteHostInfo`). Optional and purely
   *  informational — nothing in this loop reads it back. */
  remoteHost?: apiClient.RemoteHostInfo;
  auth: StoredAuth;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: apiClient.FetchImpl;
  /** Returns true when the caller wants the loop to stop reconnecting (e.g. SIGINT). */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  backoffOpts?: Partial<BackoffOptions>;
  timers?: TimerImpl;
  /**
   * Human-readable output for the terminal. **Must never be used for
   * connection-state narration** — see `onConnectionEvent` below and
   * connection-state.ts's module header. Defaults to `process.stdout`,
   * which after `onAttached` spawns the local agent is the very stream that
   * agent's full-screen TUI is rendering into.
   */
  log?: (line: string) => void;
  /**
   * Out-of-band sink for connection-state transitions (connected, dropped,
   * reconnecting, token rotated, detached). **This is deliberately NOT
   * `log`**: the daemon shares `process.stdout` with the local agent's PTY,
   * so writing "Reconnecting in 1000ms…" as text corrupts whatever frame
   * the agent's TUI last painted — a transient blip the daemon recovers
   * from on its own still left the screen garbled until the next full
   * repaint (bug, 2026-08-25). Defaults to persisting the event into
   * `~/.config/yolobridge/connection.json`, which `yolo-bridge status`
   * renders; injectable so tests (and any future richer surface) can
   * observe the structured events directly.
   */
  onConnectionEvent?: (event: ConnectionEvent) => void;
  /** Called once, right when the SSE stream reports 'connected' — clears the
   *  terminal so the shell prompt / `Attached.` line don't linger once the
   *  locally-spawned agent's own UI takes over. Defaults to a real ANSI
   *  clear (`\x1b[2J\x1b[3J\x1b[H` — clear screen, clear scrollback, cursor
   *  home). Injectable so tests can assert it fired without touching a real
   *  terminal. */
  clearScreen?: () => void;
  deliverPrompt?: (prompt: string) => Promise<void>;
  captureOutput?: () => Promise<{ output: string; busy: boolean }>;
  /** auth-service base URL for token refresh. Defaults to
   * `YOLOBRIDGE_AUTH_URL` (same env var cli.ts's `authUrl()` reads) or the
   * production auth-service host. */
  authBaseUrl?: string;
  /** Injectable clock so expiry-proximity checks are testable without a
   * real wait. Defaults to `Date.now`. */
  now?: () => number;
  /** Refresh when less than this many ms of access-token validity remain. */
  refreshBufferMs?: number;
  /** Injectable auth-service refresh call. Defaults to device-auth.ts's
   * `refreshAccessToken` (the real `POST /api/v1/auth/refresh`). */
  refreshAccessToken?: RefreshTokenFn;
  /**
   * `--fresh`: skip the resume attempt entirely and always create a NEW
   * server-side attachment (and therefore a new tile).
   *
   * The escape hatch for the one thing resuming takes away — "give me a
   * clean one". With it set the daemon sends no refresh probe at all, so a
   * stored attachment is neither consulted nor disturbed; the ordinary
   * account-token attach path runs exactly as it did before resuming became
   * the default.
   */
  fresh?: boolean;
  /**
   * Fires once, right after `attach` succeeds (tileId/attachmentId now
   * exist) and before the SSE stream loop begins. This is the ONLY point
   * where the caller can act on a real tileId before the local agent spawns
   * — cli.ts uses it to start the local MCP proxy (mcp-proxy.ts) and write
   * `.mcp.json` before `startLocalAgent()`, since Claude Code reads that
   * file at process launch. Awaited; a throw here is treated as best-effort
   * (logged, does not abort the attach) since MCP access is an enhancement
   * on top of a tile that already works without it.
   */
  onAttached?: (info: {
    tileId: string;
    attachmentId: string;
    workspaceId: string;
    /** The CURRENT (possibly just-refreshed) account access token, at the
     *  moment `onAttached` fires — needed for the local MCP proxy's OWN
     *  first mint. */
    accessToken: string;
    /** Live getter for the account access token, reflecting this daemon's
     *  own in-progress `ensureFreshToken` refreshes (Bug 2) — NOT a snapshot
     *  like `accessToken` above. A long-running MCP proxy started here must
     *  call this on every mint, not close over the initial `accessToken`:
     *  the daemon rotates its token roughly every 24h and a proxy holding a
     *  stale one would 401 on every mint forever once that happens (Codex
     *  review, 2026-08-24). */
    getAccessToken: () => string;
    /** Clears the terminal (see this file's default `clearScreen` for the
     *  ANSI sequence). Exposed here rather than auto-fired on the SSE
     *  'connected' frame (the original design, reverted — Codex review,
     *  2026-08-24): `startLocalAgent` is called from `onAttached`, BEFORE
     *  the SSE stream even opens, so a fast-booting agent (or a slow SSE
     *  connect) can render its own first output before 'connected' ever
     *  arrives — clearing AFTER that point wipes content the agent already
     *  painted, and the agent has no idea it needs to repaint (the clear
     *  goes straight to this process's stdout, not through its PTY),
     *  leaving an apparently-blank session. The caller controls exactly
     *  when the agent is about to spawn; that is the only point that is
     *  deterministically BEFORE any agent output, regardless of either
     *  timing race. */
    clearScreen: () => void;
  }) => void | Promise<void>;
}

export type AttachDaemonResult =
  | { ok: true; reason: 'detached-by-server' | 'stopped' }
  | { ok: false; reason: 'attach-failed' | 'refresh-failed'; message: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runAttachDaemon(deps: AttachDaemonDeps): Promise<AttachDaemonResult> {
  const {
    workspaceId,
    commonApiBaseUrl,
    hostLabel,
    remoteHost,
    auth,
    env,
    io,
    fetchImpl,
  } = deps;
  const shouldStop = deps.shouldStop ?? (() => false);
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clearScreen = deps.clearScreen ?? (() => process.stdout.write('\x1b[2J\x1b[3J\x1b[H'));
  const deliverPrompt = deps.deliverPrompt ?? deliverPromptToLocalAgent;
  const captureOutput = deps.captureOutput ?? captureLocalAgentOutput;
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? Date.now;
  const refreshBufferMs = deps.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS;
  const authBaseUrl = deps.authBaseUrl ?? process.env.YOLOBRIDGE_AUTH_URL ?? DEFAULT_AUTH_URL;
  const doRefresh = deps.refreshAccessToken ?? refreshAccessTokenApi;

  /**
   * THE ACCOUNT identity. Full-account bearer from `yolo-bridge login`, and the
   * ONLY thing `ensureFreshToken` may write to. Used for exactly one call —
   * `attach` — because that call is what CREATES the scope; there is nothing
   * narrower to present until it returns.
   */
  const accountCfg: apiClient.ApiClientConfig = { commonApiBaseUrl, accessToken: auth.accessToken, fetchImpl };
  let currentAuth: StoredAuth = auth;

  /**
   * THE ATTACHMENT identity — the workspace-scoped credential common-api mints
   * at attach (docs/YOLOBRIDGE_SCOPED_CREDENTIAL_PLAN.md). Every post-attach
   * call presents this instead of the account token, so a stolen laptop yields
   * a credential confined to ONE workspace's YoloBridge surface.
   */
  const scopedCredential: { token?: string; expiresAtMs?: number; refreshAtMs?: number } = {};

  /**
   * Write `auth.json` back, NEVER with the account refresh token (cards 08+09).
   *
   * The access token expires on its own; the REFRESH token is the durable key
   * to the whole account, and this daemon does not need it on disk to do its
   * job. Once `attach` has exchanged it for a workspace-scoped credential the
   * daemon's entire YoloBridge traffic runs on that instead, so a leaked
   * `auth.json` should be worth at worst a self-expiring access token.
   *
   * UNCONDITIONAL since 0.7.0. Card 08 made the drop conditional on a scoped
   * token being in hand, to protect the DEGRADED path — a common-api predating
   * the mint, where `scopedCfg()` fell back to the account token and the daemon
   * ran the whole session on it. Boundary B deleted that path: an account token
   * is now refused on every post-attach route, so there is no session left for
   * the refresh token to be load-bearing in, and `runAttachDaemon` fails at
   * attach rather than continuing without a scoped credential.
   *
   * ONE CONSEQUENCE, ACCEPTED AND NOT HIDDEN: the pre-attach
   * `ensureFreshToken()` call also writes through here, so a rotation that
   * happens moments BEFORE a failed attach drops the refresh token without an
   * exchange ever completing. The operator keeps a ~24h access token and must
   * `yolo-bridge login` again after that. Narrow (it needs a near-expiry token
   * AND a failing attach in the same run) and it errs toward less crown-jewel
   * material on disk, which is the direction this work exists to push.
   *
   * Every `auth.json` write in this file goes through here rather than calling
   * `saveAuth` directly, so an account rotation cannot quietly re-persist the
   * very token the attach exchange just dropped.
   */
  function persistAccountAuth(): void {
    saveAuth({ ...currentAuth, refreshToken: undefined }, env, io);
  }

  /**
   * Record a freshly-issued scoped credential and schedule its renewal.
   *
   * `refreshAtMs` is computed from THIS moment plus 75% of the remaining
   * lifetime the server just advertised, so a credential handed over already
   * part-used (a slow attach round trip, a clock a little ahead) still renews
   * with margin rather than at a fixed offset from an issue time this daemon
   * never observed. A non-positive remaining lifetime schedules the renewal
   * immediately rather than in the past.
   */
  function rememberScopedCredential(token: string, expiresAtMs: number): void {
    const at = now();
    const remaining = Math.max(0, expiresAtMs - at);
    scopedCredential.token = token;
    scopedCredential.expiresAtMs = expiresAtMs;
    scopedCredential.refreshAtMs = at + Math.floor(remaining * SCOPED_REFRESH_AT_FRACTION);
  }

  /**
   * Deliberately a FACTORY over a separate holder, not a second mutable config
   * object.
   *
   * The trap this avoids: `ensureFreshToken` refreshes the ACCOUNT token on a
   * ~24h cadence and writes `accountCfg.accessToken` in place. Had the scoped
   * token been assigned onto that same object, the next refresh tick would
   * silently overwrite it and the daemon would quietly revert to sending the
   * account token — with every test still green. Because the scoped value lives
   * in its own holder that `ensureFreshToken` has no reference to, the revert
   * is structurally impossible rather than merely avoided.
   *
   * NO ACCOUNT FALLBACK, since 0.7.0 (card 09). It used to read
   * `?? currentAuth.accessToken` so a daemon talking to a common-api predating
   * the mint could still work. Boundary B refuses an account token on every
   * route this config is used for, so the fallback can no longer produce a
   * working call — it can only convert one legible failure at attach into an
   * unexplained 403 on every heartbeat for the rest of the session. The daemon
   * stops at attach instead (see the `scopedCredential.token` check below), so
   * by the time anything calls this a scoped token is always in hand; the throw
   * is a structural backstop for a future caller that reorders that, not a
   * reachable path today.
   */
  function scopedCfg(): apiClient.ApiClientConfig {
    const accessToken = scopedCredential.token;
    if (!accessToken) {
      throw new Error('internal: scopedCfg() called before a workspace-scoped credential was obtained');
    }
    return { commonApiBaseUrl, accessToken, fetchImpl };
  }

  // Declared up here (rather than at their first assignment below) purely
  // so `noteConnection` can close over `attachmentId` without a temporal-
  // dead-zone throw: the very first `ensureFreshToken()` call runs before
  // the attach round trip has produced one.
  let attachmentId = '';
  let tileId = '';
  let attachedAt = '';

  /**
   * Write `attachment.json`, INCLUDING the current scoped credential (card 08).
   *
   * The credential is persisted so a daemon that dies and is restarted while
   * its scoped token is still renewable resumes THIS attachment rather than
   * needing a fresh one. That is not a convenience: this card also drops the
   * account refresh token, so once the account access token expires there is
   * nothing else left on the machine to authenticate a new `attach` with — the
   * stored scoped token is the only way a long-lived daemon survives its own
   * restart without sending the operator back to `yolo-bridge login`.
   *
   * Same file, same writer, same 0600 posture as before — no new file and no
   * new mode. Called at attach and again after every renewal, so a restart
   * resumes from the CURRENT credential rather than the one attach happened to
   * hand out hours ago.
   */
  function persistAttachment(): void {
    saveAttachment(
      {
        workspaceId,
        tileId,
        attachmentId,
        attachedAt,
        ...(scopedCredential.token && scopedCredential.expiresAtMs !== undefined
          ? { scopedToken: scopedCredential.token, scopedTokenExpiresAtMs: scopedCredential.expiresAtMs }
          : {}),
      },
      env,
      io,
    );
  }

  /**
   * The out-of-band connection-state sink (see `AttachDaemonDeps.onConnectionEvent`).
   * The default persists to `~/.config/yolobridge/connection.json`; a
   * `connecting` event starts a fresh per-attachment record so `status`
   * never shows a previous attach's history as if it were this one's.
   */
  const emitConnectionEvent: (event: ConnectionEvent) => void =
    deps.onConnectionEvent ??
    ((event: ConnectionEvent) => {
      if (!attachmentId) return;
      if (event.state === 'connecting') resetConnectionState(attachmentId, event, env, io);
      else recordConnectionEvent(attachmentId, event, env, io);
    });

  function noteConnection(state: ConnectionState, extra: Omit<ConnectionEvent, 'state' | 'at'> = {}): void {
    try {
      emitConnectionEvent({ state, at: new Date(now()).toISOString(), ...extra });
    } catch {
      // This channel is diagnostics. A read-only config dir or a full disk
      // must not take down an otherwise-working attach — and must NOT fall
      // back to stdout, which is precisely the bug this replaced.
    }
  }

  /**
   * Proactive refresh (Bug 2 fix): checked before opening/reopening the
   * stream and on every heartbeat tick while connected, so the daemon
   * rotates its access token well before the 24h production expiry
   * instead of degrading into a silent zombie that just starts 401ing.
   * Updates the in-memory `accountCfg`/`currentAuth` used by `attach` AND the
   * on-disk auth.json (via `saveAuth`) so a later `status`/restart also sees
   * the fresh token. It must NEVER write the scoped credential — see
   * `scopedCfg` for why that separation is load-bearing.
   */
  async function ensureFreshToken(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (now() < currentAuth.expiresAtMs - refreshBufferMs) return { ok: true };
    // No refresh token: either this daemon dropped it after its own scoped
    // attach exchange (card 08) and is now running from a restart, or the
    // operator's `auth.json` predates login. Either way there is nothing to
    // refresh WITH — report it as an outcome rather than handing `undefined`
    // to auth-service and getting back an unexplained 400.
    if (!currentAuth.refreshToken) {
      return {
        ok: false,
        message: 'the account access token has expired and no refresh token is stored on this machine',
      };
    }
    const result = await doRefresh(authBaseUrl, currentAuth.refreshToken, fetchImpl);
    if (result.status !== 'ok') {
      return { ok: false, message: result.message };
    }
    currentAuth = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      tokenType: currentAuth.tokenType,
      expiresAtMs: result.tokens.expiresAtMs,
    };
    accountCfg.accessToken = currentAuth.accessToken;
    persistAccountAuth();
    // Out-of-band, not `log`: this fires on a ~24h cadence from inside the
    // heartbeat tick, i.e. while the local agent's TUI owns the terminal.
    noteConnection('refreshed');
    return { ok: true };
  }

  /**
   * Latched once the account refresh has failed on the SCOPED path, so the
   * heartbeat tick doesn't retry a call that cannot start working again.
   */
  let accountRefreshAbandoned = false;

  /**
   * `ensureFreshToken`, downgraded from fatal to best-effort.
   *
   * Nothing in this daemon's YoloBridge traffic uses the account token past
   * attach, so killing a perfectly healthy session because it could not be
   * rotated would be a self-inflicted brick. The rotation is kept running — it
   * is not dead code: `onAttached` hands `getAccessToken` to the local MCP
   * proxy, whose delegated-token mints are still account-authenticated (see
   * mcp-proxy.ts) — but a failure DEGRADES that one enhancement rather than
   * ending the session, and latches so the heartbeat tick stops retrying a call
   * that cannot start working again.
   *
   * Card 08 classified this failure by whether a scoped credential existed,
   * because on the degraded path the account token WAS the daemon's credential
   * and a failed refresh had to be terminal. Card 09 removed that path
   * entirely: `runAttachDaemon` never reaches this loop without a scoped
   * credential, so the classification had exactly one branch left.
   *
   * Deliberately silent when it degrades. `noteConnection('degraded')` means
   * "the LINK is struggling" and, being the last event recorded, would leave
   * `yolo-bridge status` reporting a healthy session as degraded for the rest
   * of its life. The one consumer, MCP minting, already reports its own
   * failures, and best-effort MCP is its documented contract.
   */
  async function ensureFreshAccountToken(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (accountRefreshAbandoned) return { ok: true };
    const outcome = await ensureFreshToken();
    if (outcome.ok) return outcome;
    accountRefreshAbandoned = true;
    return { ok: true };
  }

  type ScopedRefreshOutcome = { ok: true } | { ok: false; message: string };

  /**
   * SINGLE-FLIGHT guard for the renewal below.
   *
   * The heartbeat scheduler fires on a plain interval and does NOT wait for
   * the previous tick's async work to finish, so a renewal that takes longer
   * than one tick would otherwise be started again by the next one. Two
   * concurrent renewals are not merely wasteful: they can resolve out of
   * order, and the loser would overwrite the live credential with the older of
   * the two tokens — a bug that only ever appears on a slow network, and one
   * whose symptom (heartbeats 401ing a few minutes later) points nowhere near
   * here. Overlapping callers await the SAME renewal instead.
   */
  let scopedRefreshInFlight: Promise<ScopedRefreshOutcome> | undefined;

  /**
   * Latched terminal outcome. Once a credential is unrenewable it never
   * becomes renewable again, so every later caller gets the same answer
   * without another doomed round trip — which matters because the heartbeat
   * interval keeps firing for the fraction of a second between the failure
   * and the stream loop actually unwinding.
   */
  let scopedRefreshTerminal: { ok: false; message: string } | undefined;

  /**
   * Renew the WORKSPACE-SCOPED credential before it expires (card 07).
   *
   * Checked in the same two places `ensureFreshToken` is — before opening or
   * reopening the stream, and on every heartbeat tick while connected — so no
   * new timer is introduced and the whole thing is driven by the already-
   * injected `timers`/`now` seams. At a 10s heartbeat the renewal lands within
   * ~10s of its scheduled moment, which against a 15-minute grace window is
   * noise.
   *
   * Returns `{ ok: false }` ONLY when the situation is terminal — the grace
   * window has closed, or the server said the attachment is gone. A transient
   * failure while the credential is still renewable returns `ok` and simply
   * lets the next tick try again (`refreshAtMs` is left where it was, so the
   * retry is immediate rather than deferred another 45 minutes).
   */
  function ensureFreshScopedToken(): Promise<ScopedRefreshOutcome> {
    if (scopedRefreshTerminal) return Promise.resolve(scopedRefreshTerminal);
    // Unreachable in this loop — `rememberScopedCredential` sets all three
    // fields together and the daemon refuses to start without them (card 09).
    // Kept as the type-level narrowing `scopedCredential.refreshAtMs` needs
    // below, not as a live degrade branch.
    if (!scopedCredential.token || scopedCredential.refreshAtMs === undefined) {
      return Promise.resolve({ ok: true });
    }
    if (now() < scopedCredential.refreshAtMs) return Promise.resolve({ ok: true });
    if (scopedRefreshInFlight) return scopedRefreshInFlight;

    const attempt = renewScopedCredential();
    scopedRefreshInFlight = attempt;
    // `renewScopedCredential` never rejects (it converts every failure into an
    // outcome), so one settle handler is enough. Cleared only if this attempt
    // is still the current one, so a later attempt is never dropped by an
    // earlier one's completion.
    void attempt.then(() => {
      if (scopedRefreshInFlight === attempt) scopedRefreshInFlight = undefined;
    });
    return attempt;
  }

  async function renewScopedCredential(): Promise<ScopedRefreshOutcome> {
    try {
      const renewed = await apiClient.refreshScopedToken(scopedCfg(), workspaceId, attachmentId);
      rememberScopedCredential(renewed.scopedToken, renewed.scopedTokenExpiresAt);
      // Persist the RENEWED credential, not just the one attach issued: a
      // restart hours into a session must resume from a token the server will
      // still accept.
      persistAttachment();
      // Same out-of-band channel the account rotation uses, for the same
      // reason: this fires mid-session, while the local agent's TUI owns the
      // terminal.
      noteConnection('refreshed', { detail: 'workspace-scoped credential renewed' });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 403 means the SERVER has ended this attachment (detached, or the
      // workspace is gone). Retrying cannot help and waiting out the grace
      // window only delays the truth.
      const attachmentGone = err instanceof apiClient.YoloBridgeApiError && err.status === 403;
      const expiresAtMs = scopedCredential.expiresAtMs ?? 0;
      const windowBlown = now() >= expiresAtMs + SCOPED_REFRESH_GRACE_MS;
      if (attachmentGone || windowBlown) {
        scopedRefreshTerminal = {
          ok: false,
          message:
            'YoloBridge session credential could not be renewed '
            + `(${message}). Run \`yolo-bridge attach\` again to reconnect this machine.`,
        };
        return scopedRefreshTerminal;
      }
      // Still renewable. `degraded` is exactly what this vocabulary means by
      // "still connected, but an individual call failed" — the same state a
      // failed heartbeat POST records — and it is transient by construction:
      // the next tick either succeeds (→ `refreshed`) or the window closes
      // (→ the terminal `interrupted` below). It is NOT used for the terminal
      // failure, which would otherwise leave `yolo-bridge status` reporting a
      // healthy session as degraded.
      noteConnection('degraded', { detail: `scoped credential refresh failed: ${message}` });
      return { ok: true };
    }
  }

  /**
   * RESUME an existing attachment from its persisted scoped credential
   * (card 08), instead of creating a second one.
   *
   * **LIVENESS decides, not the account token's health** (D7). Card 08 gated
   * this on the account refresh having failed, which meant a daemon restarting
   * with a healthy account token ignored a perfectly good stored attachment and
   * called `attach` again — a SECOND server-side attachment and a second tile.
   * The first stops heartbeating and is reaped, but the operator is left
   * looking at a duplicate. Account-token health says nothing about whether the
   * attachment is still alive, so it was never the right question.
   *
   * The probe is card 07's own renewal route
   * (`POST .../yolobridge/attach/:attachmentId/refresh`). That route re-reads
   * live attachment state on every call and 403s a detached one, so it is
   * simultaneously the liveness check AND the source of a fresh credential —
   * there is deliberately no second probe to drift out of agreement with it.
   *
   * A failure of ANY kind (403 detached, 401 past the renewal window, a
   * network error) is not fatal here: it just means there is nothing to
   * resume, and the ordinary attach path below runs. The server, not this
   * binary's copy of the window, is the authority on which it was.
   */
  let resumed = false;
  if (!deps.fresh) {
    const stored = loadAttachment(env, io);
    if (
      stored &&
      stored.workspaceId === workspaceId &&
      stored.scopedToken !== undefined &&
      stored.scopedTokenExpiresAtMs !== undefined
    ) {
      try {
        // A one-off config rather than `scopedCfg()`: the stored token is not
        // adopted as THE credential until the server has confirmed it is
        // still good, so a failed probe leaves the daemon's own state
        // untouched and the fall-through is a clean ordinary attach.
        const renewed = await apiClient.refreshScopedToken(
          { commonApiBaseUrl, accessToken: stored.scopedToken, fetchImpl },
          workspaceId,
          stored.attachmentId,
        );
        attachmentId = stored.attachmentId;
        tileId = stored.tileId;
        attachedAt = stored.attachedAt;
        rememberScopedCredential(renewed.scopedToken, renewed.scopedTokenExpiresAt);
        resumed = true;
      } catch (err) {
        // Pre-spawn, so `log` is safe here (nothing owns the terminal yet) —
        // and worth saying out loud: the operator is about to get a NEW tile
        // where they may have expected the old one back.
        const message = err instanceof Error ? err.message : String(err);
        log(`Stored attachment is no longer resumable (${message}) — attaching fresh.`);
      }
    }
  }

  if (!resumed) {
    // ONLY the attach path needs the account credential — attach is the call
    // that creates the scope, and nothing after it presents an account token.
    // Keeping this refresh inside the branch is the ordering win D7 exists
    // for: a daemon whose account token expired days ago, but whose
    // attachment is still live, resumes above and never reaches this line.
    // (It also still covers the original reason it existed: an `attach` run
    // right after a long-down period, against a token already inside the
    // refresh buffer, rotates before the very first network call.)
    const initialRefresh = await ensureFreshToken();
    if (!initialRefresh.ok) {
      log(`Token refresh failed: ${initialRefresh.message}`);
      log('Run `yolo-bridge login` again.');
      return { ok: false, reason: 'refresh-failed', message: initialRefresh.message };
    }
    try {
      const result = await apiClient.attach(accountCfg, workspaceId, hostLabel, remoteHost);
      attachmentId = result.attachmentId;
      tileId = result.tileId;
      attachedAt = new Date().toISOString();
      // `api-client.attach` now REQUIRES the scoped pair and throws on its
      // absence (card 09), so this is a plain read rather than the narrowing
      // the optional shape used to need. A server that issues no credential
      // lands in the catch below, as an attach failure with its own message.
      rememberScopedCredential(result.scopedToken, result.scopedTokenExpiresAt);
    } catch (err) {
      return { ok: false, reason: 'attach-failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Belt and braces for the property everything after this point depends on:
  // BOTH routes into this line (a fresh attach, and the resume branch above)
  // set the scoped credential or fail, so this cannot fire today. It exists so
  // that if a third route is ever added, the daemon stops HERE — with a message
  // an operator can act on, while they are still watching the terminal — rather
  // than proceeding to 403 on every daemon call for the rest of the session.
  if (!scopedCredential.token) {
    const message =
      'this attach produced no workspace-scoped credential, so the daemon has nothing '
      + 'the YoloBridge routes will accept';
    log(message);
    return { ok: false, reason: 'attach-failed', message };
  }

  persistAttachment();
  // THE EXCHANGE IS COMPLETE — drop the durable account credential from disk
  // (card 08). Ordered after `persistAttachment` so the machine is never
  // momentarily left with neither credential persisted: a crash between the two
  // writes would otherwise leave a daemon that can neither resume nor re-attach.
  // `persistAccountAuth` is what makes this conditional on a scoped token
  // actually being in hand; see its comment for why unconditional would brick
  // the degraded path.
  persistAccountAuth();
  // Safe on stdout: this is still BEFORE `onAttached` spawns the local
  // agent, so nothing owns the screen yet (and the caller's `clearScreen()`
  // wipes it moments later anyway).
  log(`${resumed ? 'Resumed' : 'Attached'}. tileId=${tileId} attachmentId=${attachmentId}`);
  noteConnection('connecting');

  // Codex-found race: if something already asked us to stop WHILE the
  // initial refresh/attach network round trip above was in flight (e.g. the
  // local agent process this daemon spawns exits almost immediately), the
  // caller's own onExit-triggered best-effort detach ran too early — before
  // this attachment existed anywhere — and found nothing to clean up. The
  // `while (!shouldStop())` loop below would otherwise exit on its very
  // first check having never opened a stream, returning `{ ok: true,
  // reason: 'stopped' }` with the attachment just created above left as a
  // permanent orphan (the CLI's own post-return cleanup skips it too, since
  // it believes the onExit path already handled detaching). Catch it here,
  // right after this call is the one that created it, so there's exactly
  // one place responsible for cleaning up what it made.
  //
  // Checked BEFORE `onAttached`, not just after (Codex review, 2026-08-24,
  // round 25): `onAttached` can spend a real, possibly-many-second delay
  // minting MCP credentials and starting a local proxy — running all of
  // that for an attachment that's already guaranteed to be torn down the
  // moment it returns makes a Ctrl+C feel like it did nothing for however
  // long that setup takes. This check alone doesn't replace the one AFTER
  // `onAttached` below — a stop can just as easily arrive WHILE that hook
  // is still running, not only before it starts.
  if (shouldStop()) {
    return detachAndReportStopped();
  }

  if (deps.onAttached) {
    try {
      await deps.onAttached({
        tileId, attachmentId, workspaceId,
        accessToken: currentAuth.accessToken,
        getAccessToken: () => currentAuth.accessToken,
        clearScreen,
      });
    } catch (err) {
      log(`onAttached hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (shouldStop()) {
    return detachAndReportStopped();
  }

  async function detachAndReportStopped(): Promise<AttachDaemonResult> {
    try {
      await apiClient.detach(scopedCfg(), workspaceId, attachmentId);
    } catch (err) {
      // Only clear `attachment.json` on a SUCCESSFUL (or already-gone —
      // `apiClient.detach` itself treats a 404 as success) detach, not on
      // a genuine failure (Codex review, 2026-08-24, round 26) — mirrors
      // `runDetach`'s own established pattern. Clearing it unconditionally
      // would strand the server-side attachment permanently: the caller's
      // own post-return retry (`cli.ts`'s `if (stopRequested &&
      // !localAgentExited) { await runDetach(...) }`) and a manual `yolo-
      // bridge detach` both rely on `attachment.json` to know what to
      // retry against, and the next `attach` would then create a SECOND
      // server-side attachment/tile instead of ever cleaning up the first.
      log(`Cleanup detach failed: ${err instanceof Error ? err.message : String(err)}`);
      // The record stays (see above) and so does the CREDENTIAL. Card 08 cleared
      // it here on the reasoning that the retry authenticated with the account
      // token — card 09's Boundary B made that false, and `runDetach` now
      // accepts only the scoped credential. Clearing it would leave the retry
      // this comment describes unable to authenticate at all, stranding a live
      // server-side attachment and duplicating the tile on the next attach.
      // (Codex review, gpt-5.6-sol, 2026-08-25.)
      return { ok: true, reason: 'stopped' };
    }
    clearAttachment(env, io);
    return { ok: true, reason: 'stopped' };
  }

  let heartbeat: HeartbeatScheduler | undefined;
  let attempt = 0;
  /** Set when a proactive refresh (see ensureFreshToken) fails while a
   * stream is open — picked up right after the current for-await unwinds
   * (forced via the stop-poll below) so the daemon stops instead of
   * looping forever reconnecting with a dead token. */
  let refreshFailed: { message: string } | undefined;
  /** The same, for the WORKSPACE-SCOPED credential: set when its renewal
   * window has closed (or the server ended the attachment), so the daemon
   * stops instead of streaming on with a credential that is about to start
   * 401ing every heartbeat. Kept separate from `refreshFailed` because the
   * two have different remedies — `yolo-bridge login` vs `yolo-bridge attach`
   * — and different reporting rules: the account failure is the daemon's exit
   * message and may use stdout, this one fires mid-session while the local
   * agent's TUI owns the terminal and must not. */
  let scopedRefreshFailed: { message: string } | undefined;

  try {
    while (!shouldStop()) {
      const preStreamRefresh = await ensureFreshAccountToken();
      if (!preStreamRefresh.ok) {
        refreshFailed = preStreamRefresh;
        break;
      }
      // Also before every (re)connect, not only on the heartbeat tick: a long
      // backoff with no stream open is exactly when a scoped credential can
      // cross its renewal point unnoticed.
      const preStreamScopedRefresh = await ensureFreshScopedToken();
      if (!preStreamScopedRefresh.ok) {
        scopedRefreshFailed = preStreamScopedRefresh;
        break;
      }

      let sawDetached = false;
      /** Set when the SSE stream itself (or any other call in this attempt)
       *  404s -- the attachment/workspace no longer exists server-side
       *  (Codex review, 2026-08-24, round 4). Without this, a 404 fell
       *  through to the SAME backoff-and-retry path as a transient network
       *  error and looped FOREVER: `onAttached` now runs a bounded but real
       *  MCP-setup delay (up to STARTUP_MINT_TIMEOUT_MS) BEFORE the first
       *  `openStream` call, wide enough for the tile to be removed/detached
       *  server-side in that window with no stream open yet to receive the
       *  `detached` frame that would normally end this loop cleanly. */
      let sawGone = false;
      try {
        const res = await apiClient.openStream(scopedCfg(), workspaceId, attachmentId);
        attempt = 0; // reset backoff on a successful connect

        const parser = new SseFrameParser();
        const nodeStream = Readable.fromWeb(res.body as any);
        // Codex review (2026-08-23, fourth pass): a per-chunk
        // `chunk.toString('utf-8')` decodes each network chunk in
        // isolation — if a multibyte UTF-8 character (e.g. in a
        // non-ASCII prompt) straddles a chunk boundary, each half decodes
        // independently to a replacement character (U+FFFD), corrupting
        // the prompt before it ever reaches JSON parsing or the PTY.
        // `StringDecoder` carries incomplete trailing bytes over to the
        // next `write()` call, so a split character reassembles correctly
        // regardless of where the network happened to cut the chunk. Scoped
        // per-connection (declared here, not outside the `while` loop) —
        // a new connection can't continue a byte sequence from a previous
        // one, so fresh decoder state per attempt is correct, matching the
        // per-connection `parser` right above.
        const decoder = new StringDecoder('utf-8');

        // Bug 1 fix: the server holds this stream open indefinitely
        // (keepalive pings only), so `for await` below never completes on
        // its own — `shouldStop()` being poll-based (not push-based; see
        // cli.ts's SIGINT/SIGTERM handler) means it must be actively
        // polled independent of whether/when the next chunk arrives, and
        // acted on by tearing the stream down, or a signal during an
        // active stream is never actually noticed. Same mechanism also
        // unblocks a mid-stream proactive-refresh failure (`refreshFailed`
        // above) instead of riding out the connection to its next natural
        // event.
        const stopPollHandle = timers.setInterval(() => {
          if (shouldStop() || refreshFailed || scopedRefreshFailed) {
            nodeStream.destroy();
          }
        }, STOP_POLL_INTERVAL_MS);

        try {
          for await (const chunk of nodeStream) {
            const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
            for (const frame of parser.push(text)) {
              const action = actionForFrame(frame);
              switch (action.kind) {
                case 'connected':
                  // Deliberately NOT clearing here (reverted -- Codex
                  // review, 2026-08-24). The original reasoning was "the
                  // agent's own PTY was already started by cli.ts before
                  // this stream even began connecting, but its first
                  // rendered output consistently lands after this point in
                  // practice" -- that held for a cold Claude Code boot but
                  // not in general: a fast-booting `--agent`, or a slow SSE
                  // connect, can render BEFORE 'connected' ever arrives,
                  // and clearing after that wipes content straight off this
                  // process's stdout (not through the agent's PTY, which
                  // has no idea it needs to repaint) -- an apparently-blank
                  // session, not a clean one. `onAttached`'s `clearScreen`
                  // (see AttachDaemonDeps) now fires deterministically
                  // right before `startLocalAgent`, the one moment
                  // guaranteed to be before any agent output regardless of
                  // either timing race.
                  // Out-of-band (was `log('Stream connected.')`): by this
                  // point `onAttached` has spawned the local agent, whose
                  // PTY is piped to this same stdout — a status line here
                  // lands in the middle of the TUI's frame.
                  noteConnection('connected');
                  heartbeat?.stop();
                  heartbeat = startHeartbeat(
                    async () => {
                      const refreshCheck = await ensureFreshAccountToken();
                      if (!refreshCheck.ok) {
                        refreshFailed = refreshCheck;
                        return;
                      }
                      // Renew the scoped credential BEFORE the heartbeat that
                      // would use it, so a tick that crosses the renewal point
                      // heartbeats with the new token rather than spending one
                      // more tick on the old one.
                      const scopedCheck = await ensureFreshScopedToken();
                      if (!scopedCheck.ok) {
                        scopedRefreshFailed = scopedCheck;
                        return;
                      }
                      await apiClient.postHeartbeat(scopedCfg(), workspaceId, attachmentId);
                    },
                    (err) =>
                      noteConnection('degraded', {
                        detail: `heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
                      }),
                    undefined,
                    deps.timers,
                  );
                  // Send one immediately so status isn't stale for the first ~10s.
                  apiClient.postHeartbeat(scopedCfg(), workspaceId, attachmentId).catch((err) =>
                    noteConnection('degraded', {
                      detail: `initial heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                  );
                  break;
                case 'ping':
                  break;
                case 'prompt':
                  await deliverPrompt(action.prompt);
                  break;
                case 'read-output': {
                  const captured = await captureOutput();
                  await apiClient
                    .postReadOutputReply(scopedCfg(), workspaceId, attachmentId, action.requestId, captured.output, captured.busy)
                    .catch((err) =>
                      noteConnection('degraded', {
                        detail: `read-output reply failed: ${err instanceof Error ? err.message : String(err)}`,
                      }),
                    );
                  break;
                }
                case 'detached':
                  noteConnection('detached');
                  sawDetached = true;
                  break;
                case 'unknown':
                  noteConnection('degraded', { detail: `unrecognized frame type: ${action.event}` });
                  break;
              }
              if (sawDetached) break;
            }
            if (sawDetached) break;
          }
        } finally {
          timers.clearInterval(stopPollHandle);
        }
      } catch (err) {
        // The reported bug's primary symptom: this is the transient-drop
        // path, and it used to write straight into the agent's PTY stream.
        noteConnection('interrupted', { detail: err instanceof Error ? err.message : String(err) });
        if (err instanceof apiClient.YoloBridgeApiError && err.status === 404) sawGone = true;
      }

      heartbeat?.stop();
      heartbeat = undefined;

      if (sawDetached || sawGone) {
        clearAttachment(env, io);
        return { ok: true, reason: 'detached-by-server' };
      }
      if (refreshFailed || scopedRefreshFailed) break;
      if (shouldStop()) break;

      attempt += 1;
      const delay = nextBackoffMs(attempt, deps.backoffOpts);
      noteConnection('reconnecting', { attempt, retryInMs: delay });
      await sleep(delay);
    }
  } finally {
    heartbeat?.stop();
  }

  if (scopedRefreshFailed) {
    // OUT-OF-BAND ONLY — no `log()` here, unlike the account-token path below.
    // That path is reached from the daemon's own pre-attach startup or as its
    // terminal exit line; this one fires from inside a live session, where the
    // local agent's PTY is piped to this process's stdout and any human-
    // readable line lands in the middle of a frame its TUI believes it drew
    // (connection-state.ts's module header). `interrupted` is the honest
    // state: the session is ending abnormally — deliberately not `degraded`,
    // which means the LINK is struggling and would make `yolo-bridge status`
    // misreport a healthy session. The remedy travels two ways regardless: in
    // the `detail` here, and as the returned `message`, which cli.ts prints on
    // STDERR after the PTY is already gone.
    noteConnection('interrupted', { detail: scopedRefreshFailed.message });
    // `refresh-failed` (not a new reason) on purpose: cli.ts keys off it to run
    // the best-effort `runDetach()` cleanup that stops a stale attachment being
    // left behind, which is exactly what should happen here too.
    return { ok: false, reason: 'refresh-failed', message: scopedRefreshFailed.message };
  }

  if (refreshFailed) {
    noteConnection('interrupted', { detail: `token refresh failed: ${refreshFailed.message}` });
    // Still on stdout, deliberately: this is the terminal EXIT message for
    // a daemon that is about to return and let cli.ts kill the local PTY.
    // Unlike the reconnect narration above, there is no frame left to
    // corrupt, and the alternative is an unexplained silent exit.
    log(`Token refresh failed: ${refreshFailed.message}`);
    log('Run `yolo-bridge login` again.');
    return { ok: false, reason: 'refresh-failed', message: refreshFailed.message };
  }

  return { ok: true, reason: 'stopped' };
}

/** Convenience wrapper: loads auth from disk first (used by cli.ts). */
export async function runAttachFromDisk(
  opts: Omit<AttachDaemonDeps, 'auth'>,
): Promise<AttachDaemonResult | { ok: false; reason: 'not-logged-in' }> {
  const auth = loadAuth(opts.env, opts.io);
  if (!auth) return { ok: false, reason: 'not-logged-in' };
  return runAttachDaemon({ ...opts, auth });
}

/**
 * Interactive workspace picker for `yolo-bridge attach` when it's run with
 * no positional workspaceId (--help previously documented it as required;
 * this is an ADDED path, the explicit-ID call site is unchanged). Fetches
 * the caller's own `GET .../workspaces/selectable` list, prints a numbered
 * menu, and reads one line of input for the selection.
 *
 * `prompt` is the injection point that keeps this testable without a real
 * TTY: it defaults to a real `node:readline` prompt over process
 * stdin/stdout, but tests pass a fake that returns a canned answer —
 * same shape as this file's other injected IO (`fetchImpl`, `log`, `io`).
 */
export interface PickWorkspaceDeps {
  commonApiBaseUrl: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: apiClient.FetchImpl;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export type PickWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'not-logged-in' }
  | { ok: false; reason: 'list-failed'; message: string }
  | { ok: false; reason: 'no-workspaces' }
  | { ok: false; reason: 'no-selection' };

function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function pickWorkspaceFromDisk(deps: PickWorkspaceDeps): Promise<PickWorkspaceResult> {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const prompt = deps.prompt ?? defaultPrompt;
  const cfg: apiClient.ApiClientConfig = {
    commonApiBaseUrl: deps.commonApiBaseUrl,
    accessToken: auth.accessToken,
    fetchImpl: deps.fetchImpl,
  };

  let workspaces: apiClient.SelectableWorkspace[];
  try {
    workspaces = await apiClient.listSelectableWorkspaces(cfg);
  } catch (err) {
    return { ok: false, reason: 'list-failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (workspaces.length === 0) return { ok: false, reason: 'no-workspaces' };

  log('Select a workspace to attach:');
  workspaces.forEach((ws, i) => {
    log(`  ${i + 1}. ${ws.name || '(unnamed)'} [${ws.status}]  ${ws.id}`);
  });

  const answer = (await prompt('Enter a number: ')).trim();
  const index = Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > workspaces.length) {
    return { ok: false, reason: 'no-selection' };
  }
  return { ok: true, workspaceId: workspaces[index - 1].id };
}
