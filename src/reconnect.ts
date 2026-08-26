/**
 * Reconnect backoff for the attach daemon's SSE stream.
 *
 * Plan calls for "sleep/wake-aware" resilience (docs/YOLOBRIDGE_PLAN.md,
 * Architecture → Auth / CLI daemon section). What's implemented: plain
 * exponential backoff with a cap and jitter, which recovers naturally
 * after a laptop sleep/wake — the stream just looks like a very long
 * disconnect, and the next scheduled attempt reconnects it. What's NOT
 * implemented: an actual OS-level sleep/wake signal (e.g. macOS
 * `powermetrics`/IOKit notifications, a wall-clock-jump detector that
 * resets backoff to zero) that would let the daemon reconnect *the
 * instant* the machine wakes rather than waiting out whatever backoff
 * step it was on when the lid closed. Flagged in the final report as a
 * deliberate scope cut, not an oversight — true sleep/wake detection is
 * platform-specific plumbing with no shared Node API across macOS/Linux/
 * Windows, and a bounded backoff (cap below) already keeps the worst case
 * to a single missed heartbeat window's multiple, not indefinite.
 *
 * This module also owns the OTHER half of the reconnect policy — see
 * `isFatalCredentialRefusal` at the bottom: whether to reconnect AT ALL. The
 * two belong together, because a backoff schedule that is never allowed to
 * terminate is not resilience, it is a loop (operator report, 2026-08-26).
 */

import { YoloBridgeApiError } from './api-client.js';

export interface BackoffOptions {
  /** Base delay for attempt 1. */
  baseMs: number;
  /** Hard cap — never wait longer than this between attempts. */
  maxMs: number;
  /** Multiplier applied per attempt (2 = doubling). */
  factor: number;
  /**
   * Jitter fraction in [0,1): the actual delay is uniformly randomized
   * within `±jitter * delay` of the computed exponential value, to avoid a
   * thundering-herd reconnect if many daemons drop at once (e.g. a
   * common-api rolling deploy). Injectable RNG for deterministic tests.
   */
  jitter: number;
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
  random: Math.random,
};

/**
 * `attempt` is 1-indexed (the first reconnect attempt after a drop).
 * Pure function — no timers, no I/O — so the exponential/cap/jitter math
 * is fully testable without waiting on a real clock.
 */
export function nextBackoffMs(attempt: number, opts: Partial<BackoffOptions> = {}): number {
  const { baseMs, maxMs, factor, jitter, random } = { ...DEFAULT_BACKOFF, ...opts };
  const raw = baseMs * Math.pow(factor, Math.max(0, attempt - 1));
  const capped = Math.min(raw, maxMs);
  if (jitter <= 0) return capped;
  const jitterRange = capped * jitter;
  // random() in [0,1) → offset in [-jitterRange, +jitterRange)
  const offset = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + offset));
}

/**
 * PERMANENT credential refusals — the failures no amount of backoff can fix.
 *
 * **The bug this exists for (operator report, 2026-08-26).** A daemon whose
 * attachment had been detached server-side — or an OLD binary that cannot send
 * the workspace-scoped claim at all — got `403 YOLOBRIDGE_SCOPED_TOKEN_REQUIRED`
 * from `GET .../stream` on every single attempt, and the reconnect loop fed it
 * straight into `nextBackoffMs` as if it were a dropped wifi packet:
 * "Reconnecting in 4542ms (attempt 3)… (attempt 4)… (attempt 5)… 28576ms
 * (attempt 6)…", climbing to the cap and staying there for as long as the
 * operator left it running. The refusal is a statement about the CREDENTIAL,
 * not about the link — the identical request one minute later is refused
 * identically — so retrying it produces nothing but noise, and the noise hides
 * the one thing the operator actually needs to act on.
 *
 * Both boundary codes are terminal, for the same underlying reason
 * (`common-api/src/middleware/yolobridge-token-boundary.ts`):
 *   - `YOLOBRIDGE_SCOPED_TOKEN_REQUIRED` — the request carried no attachment
 *     claim at all. Either this daemon predates the scoped-credential mint, or
 *     the attachment it was scoped to is gone. Neither heals by waiting.
 *   - `YOLOBRIDGE_TOKEN_FORBIDDEN` — the claim is genuine but names a different
 *     attachment (or workspace) than the route does. A token cannot re-scope
 *     itself, so this too is the same answer forever.
 *
 * Deliberately NARROW, and that narrowness is the point. Everything else keeps
 * the backoff it always had: a 5xx is an upstream blip, a network error is a
 * network error, a timeout is a timeout — all genuinely transient, all worth
 * retrying. (A 404 already has its own terminal handling: the attachment is
 * gone, so the daemon exits SUCCESSFULLY as detached — attach-cmd.ts's
 * `sawGone`.) Turning "any failure" fatal here would trade a loop that never
 * ends for a daemon that dies on the first hiccup, which is the worse bug of
 * the two.
 */
export const FATAL_CREDENTIAL_REFUSAL_CODES: readonly string[] = [
  'YOLOBRIDGE_SCOPED_TOKEN_REQUIRED',
  'YOLOBRIDGE_TOKEN_FORBIDDEN',
];

/**
 * Both halves must hold — the status AND the code.
 *
 * A bare 403 carrying no recognised code is NOT fatal: a proxy, a WAF, or some
 * future unrelated refusal can produce one, and a daemon inferring "permanent"
 * from a status alone is exactly how a transient turns into a needless exit.
 * The status check is load-bearing in the other direction too: these codes mean
 * "permanently refused" only when the boundary middleware is what said so.
 */
export function isFatalCredentialRefusal(err: unknown): err is YoloBridgeApiError {
  return (
    err instanceof YoloBridgeApiError &&
    err.status === 403 &&
    typeof err.code === 'string' &&
    FATAL_CREDENTIAL_REFUSAL_CODES.includes(err.code)
  );
}

/**
 * The operator-facing line for a fatal refusal.
 *
 * Two jobs. First, be LEGIBLE: a bare `403` tells a human nothing, so the
 * server's own sentence — which names the remedies — is carried through
 * verbatim, with the status/code appended for a bug report rather than
 * substituted for the prose.
 *
 * Second, say the part the SERVER cannot. The server has no client version, so
 * its message has to hedge across both causes (an old binary that cannot send
 * the claim, and a current one whose attachment was revoked). This side knows
 * one more fact — that a live daemon just had a credential refused mid-session
 * — and can state plainly that this daemon is finished either way, which is the
 * bit the endless "Reconnecting in 28576ms" never admitted.
 */
export function fatalCredentialRefusalMessage(err: YoloBridgeApiError): string {
  return (
    `${err.message} (HTTP ${err.status}${err.code ? ` ${err.code}` : ''}). `
    + "This machine's YoloBridge credential is permanently refused — reconnecting cannot fix it, "
    + 'so the daemon is stopping. Upgrade yolo-bridge, then run `yolo-bridge attach` again.'
  );
}
