import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OutputStreamBuffer,
  splitByUtf8Bytes,
  DEFAULT_MAX_BATCH_BYTES,
} from './output-stream.js';

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

describe('splitByUtf8Bytes', () => {
  it('returns the whole string when it already fits', () => {
    assert.deepEqual(splitByUtf8Bytes('hello', 10), { head: 'hello', tail: '' });
  });

  it('cuts ASCII exactly at the byte boundary', () => {
    assert.deepEqual(splitByUtf8Bytes('abcdef', 3), { head: 'abc', tail: 'def' });
  });

  it('never splits a multibyte character in half', () => {
    // 'é' is 2 bytes. Asking for 1 byte must yield an EMPTY head rather than
    // half a character — a lone half decodes to U+FFFD on the far side and is
    // corrupt forever, where deferring it to the next batch is lossless.
    const { head, tail } = splitByUtf8Bytes('é', 1);
    assert.equal(head, '');
    assert.equal(tail, 'é');
  });

  it('never splits a surrogate pair (astral characters survive a cut)', () => {
    // A rocket is 4 UTF-8 bytes and TWO UTF-16 code units. A naive
    // `slice(0, n)` at n=1 would emit a lone high surrogate.
    const s = '🚀🚀';
    const { head, tail } = splitByUtf8Bytes(s, 5);
    assert.equal(head, '🚀', 'must stop at the code-point boundary, not mid-pair');
    assert.equal(tail, '🚀');
    assert.equal(head + tail, s, 'the two halves must recombine to the original');
  });

  it('handles a mixed ASCII/multibyte string losslessly', () => {
    const s = 'ok ✓ done 🚀 end';
    for (let n = 0; n <= bytes(s) + 2; n++) {
      const { head, tail } = splitByUtf8Bytes(s, n);
      assert.equal(head + tail, s, `n=${n} must be lossless`);
      assert.ok(bytes(head) <= n, `n=${n} head must not exceed the cap`);
    }
  });
});

describe('OutputStreamBuffer', () => {
  it('returns null when there is nothing to send', () => {
    const buf = new OutputStreamBuffer();
    assert.equal(buf.drain(), null);
  });

  it('relays small output verbatim with no gap', () => {
    const buf = new OutputStreamBuffer();
    buf.push('hello ');
    buf.push('world');
    assert.deepEqual(buf.drain(), { data: 'hello world', droppedBytes: 0 });
    assert.equal(buf.drain(), null, 'a drained buffer has nothing left');
  });

  it('caps ONE batch at maxBatchBytes and keeps the remainder queued', () => {
    const buf = new OutputStreamBuffer({ maxBatchBytes: 4, maxBytesPerSecond: 1_000_000 });
    buf.push('abcdefgh');
    assert.deepEqual(buf.drain(), { data: 'abcd', droppedBytes: 0 });
    assert.deepEqual(buf.drain(), { data: 'efgh', droppedBytes: 0 });
  });

  it('drops the OLDEST bytes when the backlog overflows, and REPORTS the gap', () => {
    // The newest bytes are what is on the operator's screen right now, so an
    // overflow must sacrifice history, not the present.
    const buf = new OutputStreamBuffer({
      maxQueueBytes: 8,
      maxBatchBytes: 1024,
      maxBytesPerSecond: 1_000_000,
    });
    buf.push('AAAA');
    buf.push('BBBB');
    buf.push('CCCC'); // pushes 4 bytes over the cap
    const batch = buf.drain();
    assert.ok(batch, 'expected a batch');
    assert.equal(batch!.data, 'BBBBCCCC', 'kept the newest, dropped the oldest');
    assert.equal(batch!.droppedBytes, 4, 'the drop must be reported, never silent');
  });

  it('trims a single oversized chunk from its front rather than growing unbounded', () => {
    const buf = new OutputStreamBuffer({
      maxQueueBytes: 10,
      maxBatchBytes: 1024,
      maxBytesPerSecond: 1_000_000,
    });
    buf.push('x'.repeat(100));
    assert.equal(buf.queuedBytes, 10, 'the queue must never exceed its cap');
    const batch = buf.drain()!;
    assert.equal(batch.data, 'x'.repeat(10));
    assert.equal(batch.droppedBytes, 90);
  });

  it('holds the rate cap over time, and only the cap gets through', () => {
    // THE LOAD-BEARING ASSERTION for volume control: a producer that vastly
    // outruns the cap must not be able to push more than the cap's worth of
    // bytes across the wire, no matter how many drains it gets.
    let clock = 0;
    const perSecond = 1000;
    const buf = new OutputStreamBuffer({
      maxBytesPerSecond: perSecond,
      maxBatchBytes: 10_000,
      maxQueueBytes: 10_000,
      now: () => clock,
    });

    let relayed = 0;
    let dropped = 0;
    // 2 simulated seconds, a drain every 100ms, 5 KiB pushed per drain.
    for (let tick = 0; tick < 20; tick++) {
      clock += 100;
      buf.push('z'.repeat(5000));
      const batch = buf.drain();
      if (batch) {
        relayed += bytes(batch.data);
        dropped += batch.droppedBytes;
      }
    }

    // Bucket starts full (one second of burst) and refills for 2 simulated
    // seconds — so at most 3 seconds' worth may ever have been relayed.
    assert.ok(relayed <= perSecond * 3, `relayed ${relayed} exceeded the 3s ceiling`);
    assert.ok(relayed >= perSecond, `relayed ${relayed} — the cap must not stall the stream entirely`);
    assert.ok(dropped > 0, 'a producer this far over the cap must produce a REPORTED gap');
    assert.ok(
      relayed + dropped + buf.queuedBytes <= 20 * 5000,
      'accounting must not invent bytes',
    );
  });

  it('reports a POST-failure gap on the NEXT batch instead of reordering the stream', () => {
    const buf = new OutputStreamBuffer({ maxBytesPerSecond: 1_000_000 });
    buf.push('first');
    const first = buf.drain()!;
    buf.noteDropped(bytes(first.data)); // the POST failed
    buf.push('second');
    assert.deepEqual(buf.drain(), { data: 'second', droppedBytes: 5 });
  });

  it('emits a gap-only batch when there is nothing left to carry it', () => {
    const buf = new OutputStreamBuffer({ maxBytesPerSecond: 1_000_000 });
    buf.noteDropped(42);
    assert.deepEqual(buf.drain(), { data: '', droppedBytes: 42 });
    assert.equal(buf.drain(), null, 'a reported gap is not re-reported');
  });

  it('reset() forgets queued bytes AND the pending gap', () => {
    // Those bytes belong to a streamId that no longer exists — carrying them
    // into the next episode would splice one screen into another.
    const buf = new OutputStreamBuffer();
    buf.push('stale');
    buf.noteDropped(10);
    buf.reset();
    assert.equal(buf.queuedBytes, 0);
    assert.equal(buf.pendingDroppedBytes, 0);
    assert.equal(buf.drain(), null);
  });

  it('defaults keep a realistic agent burst intact (no gap on ordinary output)', () => {
    const buf = new OutputStreamBuffer();
    // ~8 KiB, comfortably inside every default bound.
    buf.push('the agent is thinking out loud. '.repeat(256));
    const batch = buf.drain()!;
    assert.equal(batch.droppedBytes, 0);
    assert.ok(bytes(batch.data) <= DEFAULT_MAX_BATCH_BYTES);
  });
});
