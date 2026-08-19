import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextBackoffMs } from './reconnect.js';

// random: () => 0.5 puts the jitter offset exactly at 0 (midpoint of [-1,1)*range).
const NO_JITTER_RANDOM = () => 0.5;

describe('nextBackoffMs', () => {
  it('doubles per attempt with no jitter', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0, random: NO_JITTER_RANDOM };
    assert.equal(nextBackoffMs(1, opts), 1000);
    assert.equal(nextBackoffMs(2, opts), 2000);
    assert.equal(nextBackoffMs(3, opts), 4000);
    assert.equal(nextBackoffMs(4, opts), 8000);
  });

  it('caps at maxMs', () => {
    const opts = { baseMs: 1000, maxMs: 5000, factor: 2, jitter: 0, random: NO_JITTER_RANDOM };
    assert.equal(nextBackoffMs(10, opts), 5000);
  });

  it('treats attempt <= 1 as the base delay', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0, random: NO_JITTER_RANDOM };
    assert.equal(nextBackoffMs(0, opts), 1000);
    assert.equal(nextBackoffMs(1, opts), 1000);
  });

  it('applies jitter within the configured fraction', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.5, random: () => 1 }; // max positive offset
    // capped = 1000, jitterRange = 500, offset = (1*2-1)*500 = 500 → 1500
    assert.equal(nextBackoffMs(1, opts), 1500);
  });

  it('never returns a negative delay even with jitter pushing below zero', () => {
    const opts = { baseMs: 100, maxMs: 60_000, factor: 2, jitter: 2, random: () => 0 }; // max negative offset
    assert.ok(nextBackoffMs(1, opts) >= 0);
  });

  it('is deterministic for a fixed random() implementation', () => {
    const opts = { baseMs: 1000, maxMs: 60_000, factor: 2, jitter: 0.2, random: () => 0.25 };
    const a = nextBackoffMs(3, opts);
    const b = nextBackoffMs(3, opts);
    assert.equal(a, b);
  });
});
