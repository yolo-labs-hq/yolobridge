/**
 * Heartbeat scheduler: `POST /events {type:'heartbeat'}` every ~10s while
 * attached (docs/YOLOBRIDGE_PLAN.md build-order step 5; matches Phase 4's
 * 30s/90s `running`→`paused`→`stopped` staleness thresholds with margin —
 * `common-api/src/services/yolobridge-service.ts`'s `deriveTileStatus`).
 *
 * Timer functions are injectable so tests drive the schedule manually
 * (call the captured callback directly) instead of sleeping for real.
 */

export interface TimerImpl {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const defaultTimers: TimerImpl = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export const HEARTBEAT_INTERVAL_MS = 10_000;

export interface HeartbeatScheduler {
  stop(): void;
}

/**
 * `send` is called once immediately is NOT done here — callers send an
 * initial heartbeat themselves right after a successful `connected` frame
 * so "attached but daemon never sent one" isn't a visible gap; this
 * scheduler only owns the recurring tick. Errors thrown by `send` are
 * swallowed with `onError` (a single failed heartbeat POST — e.g. a
 * transient network blip — should not crash the daemon loop; the next
 * tick just tries again).
 */
export function startHeartbeat(
  send: () => Promise<void>,
  onError: (err: unknown) => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  timers: TimerImpl = defaultTimers,
): HeartbeatScheduler {
  const handle = timers.setInterval(() => {
    send().catch(onError);
  }, intervalMs);
  return {
    stop: () => timers.clearInterval(handle),
  };
}
