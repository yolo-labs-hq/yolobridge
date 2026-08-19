/**
 * Best-effort "open the verification URL in a browser" helper.
 *
 * JUDGMENT CALL (plan says either is fine, "your call, note which you
 * picked"): no `open`/`opener` npm dependency added. Shelling out to the
 * platform's own opener (`open` on macOS, `xdg-open` on Linux, `start` via
 * `cmd` on Windows) covers the common case with zero new dependency
 * surface, and login always prints the URL + code clearly regardless of
 * whether the spawn succeeds — headless/SSH sessions (a real case for a
 * CLI daemon meant to run on a dev box) degrade to "copy this URL"
 * automatically, no separate code path needed.
 */

import { spawn } from 'node:child_process';

export function openBrowserBestEffort(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, shell: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // Best-effort only — the caller always prints the URL, so a failed
    // spawn (no DISPLAY, missing xdg-open, headless box) is a non-event.
  }
}
