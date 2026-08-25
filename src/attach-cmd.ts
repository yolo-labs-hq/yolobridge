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
import { loadAuth, saveAuth, saveAttachment, clearAttachment, type ConfigStoreIO, type StoredAuth } from './config-store.js';

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
  log?: (line: string) => void;
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

  const cfg: apiClient.ApiClientConfig = { commonApiBaseUrl, accessToken: auth.accessToken, fetchImpl };
  let currentAuth: StoredAuth = auth;

  /**
   * Proactive refresh (Bug 2 fix): checked before opening/reopening the
   * stream and on every heartbeat tick while connected, so the daemon
   * rotates its access token well before the 24h production expiry
   * instead of degrading into a silent zombie that just starts 401ing.
   * Updates both the in-memory `cfg`/`currentAuth` used by every
   * subsequent API call in this process AND the on-disk auth.json (via
   * `saveAuth`) so a later `status`/restart also sees the fresh token.
   */
  async function ensureFreshToken(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (now() < currentAuth.expiresAtMs - refreshBufferMs) return { ok: true };
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
    cfg.accessToken = currentAuth.accessToken;
    saveAuth(currentAuth, env, io);
    log('Access token refreshed.');
    return { ok: true };
  }

  // Cover the case where the daemon is (re)started against a token that's
  // already within the refresh buffer of expiry (e.g. `attach` run right
  // after a long-down period) — refresh before the very first network
  // call, not just before subsequent reconnects.
  const initialRefresh = await ensureFreshToken();
  if (!initialRefresh.ok) {
    log(`Token refresh failed: ${initialRefresh.message}`);
    log('Run `yolo-bridge login` again.');
    return { ok: false, reason: 'refresh-failed', message: initialRefresh.message };
  }

  let attachmentId: string;
  let tileId: string;
  try {
    const result = await apiClient.attach(cfg, workspaceId, hostLabel, remoteHost);
    attachmentId = result.attachmentId;
    tileId = result.tileId;
  } catch (err) {
    return { ok: false, reason: 'attach-failed', message: err instanceof Error ? err.message : String(err) };
  }

  saveAttachment({ workspaceId, tileId, attachmentId, attachedAt: new Date().toISOString() }, env, io);
  log(`Attached. tileId=${tileId} attachmentId=${attachmentId}`);

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
      await apiClient.detach(cfg, workspaceId, attachmentId);
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

  try {
    while (!shouldStop()) {
      const preStreamRefresh = await ensureFreshToken();
      if (!preStreamRefresh.ok) {
        refreshFailed = preStreamRefresh;
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
        const res = await apiClient.openStream(cfg, workspaceId, attachmentId);
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
          if (shouldStop() || refreshFailed) {
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
                  log('Stream connected.');
                  heartbeat?.stop();
                  heartbeat = startHeartbeat(
                    async () => {
                      const refreshCheck = await ensureFreshToken();
                      if (!refreshCheck.ok) {
                        refreshFailed = refreshCheck;
                        return;
                      }
                      await apiClient.postHeartbeat(cfg, workspaceId, attachmentId);
                    },
                    (err) => log(`heartbeat error: ${err instanceof Error ? err.message : String(err)}`),
                    undefined,
                    deps.timers,
                  );
                  // Send one immediately so status isn't stale for the first ~10s.
                  apiClient.postHeartbeat(cfg, workspaceId, attachmentId).catch((err) =>
                    log(`initial heartbeat error: ${err instanceof Error ? err.message : String(err)}`),
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
                    .postReadOutputReply(cfg, workspaceId, attachmentId, action.requestId, captured.output, captured.busy)
                    .catch((err) => log(`read-output reply failed: ${err instanceof Error ? err.message : String(err)}`));
                  break;
                }
                case 'detached':
                  log('Detached by server.');
                  sawDetached = true;
                  break;
                case 'unknown':
                  log(`Unrecognized frame type: ${action.event}`);
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
        log(`Stream error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof apiClient.YoloBridgeApiError && err.status === 404) sawGone = true;
      }

      heartbeat?.stop();
      heartbeat = undefined;

      if (sawDetached || sawGone) {
        clearAttachment(env, io);
        return { ok: true, reason: 'detached-by-server' };
      }
      if (refreshFailed) break;
      if (shouldStop()) break;

      attempt += 1;
      const delay = nextBackoffMs(attempt, deps.backoffOpts);
      log(`Reconnecting in ${delay}ms (attempt ${attempt})...`);
      await sleep(delay);
    }
  } finally {
    heartbeat?.stop();
  }

  if (refreshFailed) {
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
