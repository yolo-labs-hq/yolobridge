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

import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Narrowed to what this module actually calls — injectable so a test can
 * force a real async `error` event (e.g. spawning a binary that doesn't
 * exist) without depending on the test environment's actual opener binaries
 * being present or absent. */
export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export function openBrowserBestEffort(url: string, spawnImpl: SpawnImpl = realSpawn): void {
  try {
    const platform = process.platform;
    let child: ChildProcess;
    if (platform === 'darwin') {
      child = spawnImpl('open', [url], { stdio: 'ignore', detached: true });
    } else if (platform === 'win32') {
      child = spawnImpl('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, shell: true });
    } else {
      child = spawnImpl('xdg-open', [url], { stdio: 'ignore', detached: true });
    }
    // Codex review (2026-08-23, fourth pass): a missing opener binary (no
    // `xdg-open` on a minimal/headless Linux box, the common case this
    // helper is meant to degrade gracefully on) doesn't throw SYNCHRONOUSLY
    // — spawn() returns a child and emits `error` (e.g. ENOENT) on a later
    // tick, which this surrounding try/catch cannot catch. An EventEmitter
    // `error` event with no listener throws and crashes the process, so
    // login was crashing instead of degrading to "copy this URL" as
    // intended. Register the listener BEFORE unref() so it's in place for
    // that later tick.
    child.on('error', () => {
      // Best-effort only — the caller always prints the URL, so a failed
      // spawn (no DISPLAY, missing xdg-open, headless box) is a non-event.
    });
    child.unref();
  } catch {
    // Best-effort only — the caller always prints the URL, so a failed
    // spawn (no DISPLAY, missing xdg-open, headless box) is a non-event.
  }
}
