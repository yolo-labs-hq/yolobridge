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
 */

import { loadAuth, loadAttachment, type ConfigStoreIO } from './config-store.js';

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
  }
  return lines.join('\n');
}
