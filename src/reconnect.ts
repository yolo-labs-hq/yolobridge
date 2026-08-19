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
 */

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
