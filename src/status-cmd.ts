/**
 * `yolo-bridge status` — prints current login/attach state.
 *
 * This reads persisted local state only (config-store.ts), not a live
 * process: `attach` runs its daemon loop in the foreground of whatever
 * process invoked it, and `status` is typically run from a different
 * terminal. So this reports "what does this machine believe" (logged in
 * as of token expiry X, last attached to workspace Y at time Z) — it
 * cannot see whether that attach process is still alive right now
 * (connected vs. mid-backoff vs. crashed). A future iteration could add
 * a pidfile / lockfile next to attachment.json to close that gap; not
 * implemented here — flagged as a known limitation, not silently glossed
 * over.
 *
 * Partially narrowed since (2026-08-25): the daemon now records every
 * connection transition to `connection.json` (connection-state.ts) instead
 * of narrating it into the terminal the local agent's TUI is rendering
 * into, and this command renders that record. That still isn't liveness —
 * a crashed daemon leaves its last transition frozen on disk, so
 * `Connection: connected` means "the last thing it managed to record",
 * not "it is connected right now" — but a drop/reconnect blip is no
 * longer invisible just because it can't be printed to the screen.
 */

import { loadAuth, loadAttachment, type ConfigStoreIO } from './config-store.js';
import { loadConnectionState, formatConnectionEvent, type ConnectionEvent } from './connection-state.js';

export interface StatusDeps {
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  now?: () => number;
}

export interface StatusReport {
  loggedIn: boolean;
  tokenExpiresAtMs?: number;
  tokenExpired?: boolean;
  attached: boolean;
  workspaceId?: string;
  tileId?: string;
  attachmentId?: string;
  attachedAt?: string;
  /**
   * Last connection transition the running `attach` daemon recorded for
   * THIS attachment (connection-state.ts). This is the out-of-band home
   * for drop/reconnect notifications that used to be written as text into
   * the terminal the local agent's TUI is rendering into — see that
   * module's header. Absent when nothing has been recorded, or when the
   * record belongs to an older attachment.
   */
  connection?: ConnectionEvent;
  /** Bounded tail of prior transitions, oldest first. */
  connectionHistory?: ConnectionEvent[];
}

export function getStatus(deps: StatusDeps = {}): StatusReport {
  const now = deps.now ?? Date.now;
  const auth = loadAuth(deps.env, deps.io);
  const attachment = loadAttachment(deps.env, deps.io);

  const report: StatusReport = {
    loggedIn: Boolean(auth),
    attached: Boolean(attachment),
  };
  if (auth) {
    report.tokenExpiresAtMs = auth.expiresAtMs;
    report.tokenExpired = auth.expiresAtMs <= now();
  }
  if (attachment) {
    report.workspaceId = attachment.workspaceId;
    report.tileId = attachment.tileId;
    report.attachmentId = attachment.attachmentId;
    report.attachedAt = attachment.attachedAt;

    const connection = loadConnectionState(deps.env, deps.io);
    // Only report a record that belongs to the CURRENT attachment — a
    // leftover from a previous attach describes a connection that no
    // longer exists and would be actively misleading here.
    if (connection && connection.attachmentId === attachment.attachmentId) {
      report.connection = connection.current;
      report.connectionHistory = connection.recent;
    }
  }
  return report;
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  if (!report.loggedIn) {
    lines.push('Logged in: no (run `yolo-bridge login`)');
  } else {
    lines.push(
      `Logged in: yes${report.tokenExpired ? ' (access token expired — log in again)' : ` (token expires ${new Date(report.tokenExpiresAtMs!).toISOString()})`}`,
    );
  }
  if (!report.attached) {
    lines.push('Attached: no');
  } else {
    lines.push(
      `Attached: yes — workspace=${report.workspaceId} tile=${report.tileId} attachmentId=${report.attachmentId} since=${report.attachedAt}`,
    );
    lines.push('(local file only — does not confirm the attach daemon process is still running/connected)');
    if (report.connection) {
      lines.push(`Connection: ${formatConnectionEvent(report.connection)}`);
      const history = report.connectionHistory ?? [];
      if (history.length > 0) {
        // Newest first — a reconnect blip is easiest to read as "what just
        // happened", not "what happened when this attach started".
        lines.push('Recent connection events (newest first):');
        for (const event of [...history].reverse()) {
          lines.push(`  ${formatConnectionEvent(event)}`);
        }
      }
    }
  }
  return lines.join('\n');
}
