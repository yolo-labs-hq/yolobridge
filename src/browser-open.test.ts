import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { openBrowserBestEffort, type SpawnImpl } from './browser-open.js';

describe('openBrowserBestEffort', () => {
  it('does not crash the process when the spawned opener emits an async error event (e.g. ENOENT — missing xdg-open on a headless box)', () => {
    // Codex review (2026-08-23, fourth pass): a missing opener binary
    // doesn't throw synchronously from spawn() — it emits `error` on a
    // LATER tick, which the caller's surrounding try/catch cannot see. An
    // EventEmitter `error` event with no listener throws and crashes the
    // process. This test proves the fix: emitting `error` here must not
    // throw out of this synchronous call, and must not produce an uncaught
    // exception on this process.
    let uncaught: unknown;
    const onUncaught = (err: unknown) => { uncaught = err; };
    process.on('uncaughtException', onUncaught);

    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = () => fakeChild;
    const spawnImpl: SpawnImpl = () => fakeChild;

    try {
      // Must not throw synchronously...
      assert.doesNotThrow(() => openBrowserBestEffort('https://example.com/device', spawnImpl));
      // ...and the child's async error (the real-world ENOENT case) must be
      // swallowed, not crash the process.
      fakeChild.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }

    assert.equal(uncaught, undefined, 'the async spawn error must not become an uncaught exception');
  });

  it('still spawns the platform-appropriate opener and unrefs it (unchanged behavior)', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let unrefed = false;
    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = () => { unrefed = true; return fakeChild; };
    const spawnImpl: SpawnImpl = (command, args) => {
      calls.push({ command, args });
      return fakeChild;
    };

    openBrowserBestEffort('https://example.com/device', spawnImpl);

    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.args.includes('https://example.com/device'));
    assert.equal(unrefed, true);
  });
});
