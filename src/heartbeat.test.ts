import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startHeartbeat, type TimerImpl } from './heartbeat.js';

/** A fake timer that captures the interval callback so tests can invoke it
 * synchronously instead of sleeping for real. */
function fakeTimers(): TimerImpl & { tick(times?: number): void; intervals: Array<{ fn: () => void; ms: number }> } {
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  return {
    intervals,
    setInterval(fn, ms) {
      const entry = { fn, ms };
      intervals.push(entry);
      return entry;
    },
    clearInterval(handle) {
      const idx = intervals.indexOf(handle as { fn: () => void; ms: number });
      if (idx >= 0) intervals.splice(idx, 1);
    },
    tick(times = 1) {
      for (let i = 0; i < times; i++) {
        for (const entry of [...intervals]) entry.fn();
      }
    },
  };
}

describe('startHeartbeat', () => {
  it('schedules at the configured interval and calls send() on each tick', () => {
    const timers = fakeTimers();
    let calls = 0;
    startHeartbeat(async () => { calls++; }, () => {}, 10_000, timers);
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0]!.ms, 10_000);
    timers.tick(3);
    assert.equal(calls, 3);
  });

  it('does not send immediately on start — only on ticks', () => {
    const timers = fakeTimers();
    let calls = 0;
    startHeartbeat(async () => { calls++; }, () => {}, 10_000, timers);
    assert.equal(calls, 0);
  });

  it('routes a rejected send() to onError instead of throwing', async () => {
    const timers = fakeTimers();
    const errors: unknown[] = [];
    startHeartbeat(async () => { throw new Error('network blip'); }, (err) => errors.push(err), 10_000, timers);
    timers.tick(1);
    // send() rejection is async — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /network blip/);
  });

  it('stop() clears the interval so no further ticks fire', () => {
    const timers = fakeTimers();
    let calls = 0;
    const scheduler = startHeartbeat(async () => { calls++; }, () => {}, 10_000, timers);
    timers.tick(1);
    scheduler.stop();
    assert.equal(timers.intervals.length, 0);
    timers.tick(5); // no-op — nothing registered anymore
    assert.equal(calls, 1);
  });
});
