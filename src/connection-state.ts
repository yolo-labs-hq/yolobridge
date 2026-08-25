/**
 * Out-of-band connection-state channel for the `yolo-bridge attach` daemon.
 *
 * **Why this module exists (bug, 2026-08-25).** `attach` spawns the user's
 * local coding agent under a real PTY and pipes that PTY straight to this
 * process's own `process.stdout` (`local-agent.ts`'s module header), so from
 * the moment `startLocalAgent` runs the terminal belongs to a full-screen
 * TUI that owns the alternate screen buffer and repaints on its own
 * schedule. The daemon's own `log()` defaults to `process.stdout.write` —
 * the SAME stream — so every connection-state line it emitted from inside
 * the reconnect loop (`Stream error: …`, `Reconnecting in 1000ms
 * (attempt 1)...`, `Stream connected.`) was injected into the middle of a
 * frame the TUI believed it had drawn. The result is a garbled/overlapping
 * display that persists until the agent happens to do a full repaint: a
 * transient wifi blip the daemon recovers from entirely on its own still
 * trashed the user's screen.
 *
 * Writing the same text to `process.stderr` instead is NOT a fix: in an
 * interactive session both file descriptors point at the same tty, so the
 * bytes land in exactly the same place.
 *
 * The fix is to stop putting human-readable status into a stream a TUI is
 * actively rendering to, and route it to a channel that has nothing to do
 * with the terminal. That channel is this file: a small JSON record under
 * the daemon's existing config dir (`~/.config/yolobridge/`, alongside
 * `auth.json`/`attachment.json`) holding the current connection state plus
 * a bounded tail of recent transitions, written through the same injectable
 * `ConfigStoreIO` every other piece of local state already uses.
 *
 * The information is deliberately NOT dropped — it is surfaced two ways:
 *   - locally, by `yolo-bridge status` (status-cmd.ts), which reads this
 *     record and renders the current state plus recent transitions;
 *   - in the workspace, by the tile's own status: yolobridge tile status is
 *     derived server-side from `lastHeartbeatAt` (docs/YOLOBRIDGE_PLAN.md's
 *     "Status derivation" — ≤30s `running`, ≤90s `paused`, older
 *     `stopped`), so a real drop already degrades the tile without the
 *     daemon having to narrate it into the PTY.
 *
 * Scoped to one attachment (`attachmentId`): a record left over from a
 * previous attach is ignored rather than shown as if it described the
 * current one, which avoids needing a cleanup call at every teardown site.
 */

import * as path from 'node:path';
import { defaultIO, configDir, type ConfigStoreIO } from './config-store.js';

/**
 * Connection lifecycle as the daemon observes it.
 *   connecting   — attached, no SSE stream established yet.
 *   connected    — the stream is open and the daemon is heartbeating.
 *   degraded     — still connected, but an individual call/frame failed
 *                  (a heartbeat POST, a read-output reply, an unknown frame).
 *   interrupted  — the stream dropped or errored.
 *   reconnecting — backoff scheduled; `attempt`/`retryInMs` say which.
 *   refreshed    — the account access token was rotated mid-session.
 *   detached     — the server ended the attachment; the daemon is done.
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'interrupted'
  | 'reconnecting'
  | 'refreshed'
  | 'detached';

export interface ConnectionEvent {
  state: ConnectionState;
  /** ISO-8601 timestamp, stamped from the daemon's injectable clock. */
  at: string;
  /** Underlying message, when there is one (error text, frame name). */
  detail?: string;
  /** Reconnect attempt number — `reconnecting` only. */
  attempt?: number;
  /** Backoff delay before the next attempt, ms — `reconnecting` only. */
  retryInMs?: number;
}

export interface StoredConnectionState {
  /** Which attachment this record describes. A record whose id doesn't
   *  match the current `attachment.json` is stale and is ignored. */
  attachmentId: string;
  current: ConnectionEvent;
  /** Bounded tail of prior transitions, oldest first. Bounded so a daemon
   *  running for weeks on a flaky link can't grow this file without limit. */
  recent: ConnectionEvent[];
}

/** How many prior transitions to keep. Enough to show "it blipped three
 *  times in the last minute" without turning this into a log file. */
export const MAX_RECENT_EVENTS = 20;

function connectionPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'connection.json');
}

export function loadConnectionState(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): StoredConnectionState | undefined {
  const raw = io.readFile(connectionPath(env));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConnectionState>;
    if (
      typeof parsed.attachmentId === 'string' &&
      parsed.current !== undefined &&
      typeof parsed.current.state === 'string' &&
      typeof parsed.current.at === 'string'
    ) {
      return {
        attachmentId: parsed.attachmentId,
        current: parsed.current,
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts a fresh record for `attachmentId`. Called once, right after the
 * attach succeeds, so `status` never renders a previous attach's history as
 * if it belonged to the live one.
 */
export function resetConnectionState(
  attachmentId: string,
  event: ConnectionEvent,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  writeState({ attachmentId, current: event, recent: [] }, env, io);
}

/**
 * Appends `event` as the new current state, rolling the previous one into
 * the bounded `recent` tail. A record belonging to a different attachment
 * is replaced rather than appended to.
 */
export function recordConnectionEvent(
  attachmentId: string,
  event: ConnectionEvent,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  const existing = loadConnectionState(env, io);
  if (!existing || existing.attachmentId !== attachmentId) {
    writeState({ attachmentId, current: event, recent: [] }, env, io);
    return;
  }
  const recent = [...existing.recent, existing.current].slice(-MAX_RECENT_EVENTS);
  writeState({ attachmentId, current: event, recent }, env, io);
}

function writeState(
  state: StoredConnectionState,
  env: Record<string, string | undefined>,
  io: ConfigStoreIO,
): void {
  io.writeFile(connectionPath(env), `${JSON.stringify(state, null, 2)}\n`);
}

/** One-line human rendering, used by `yolo-bridge status`. */
export function formatConnectionEvent(event: ConnectionEvent): string {
  const parts: string[] = [event.state];
  if (event.state === 'reconnecting' && typeof event.attempt === 'number') {
    parts.push(
      `(attempt ${event.attempt}${typeof event.retryInMs === 'number' ? `, retrying in ${event.retryInMs}ms` : ''})`,
    );
  }
  parts.push(`at ${event.at}`);
  if (event.detail) parts.push(`— ${event.detail}`);
  return parts.join(' ');
}
