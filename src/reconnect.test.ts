import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextBackoffMs,
  isFatalCredentialRefusal,
  fatalCredentialRefusalMessage,
  FATAL_CREDENTIAL_REFUSAL_CODES,
} from './reconnect.js';
import { YoloBridgeApiError } from './api-client.js';

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

describe('isFatalCredentialRefusal', () => {
  it('lists at least the two boundary codes — an empty list would silently make nothing fatal', () => {
    // The whole classification hangs off this array. If it were ever emptied
    // (or renamed out from under a `.includes`), every test below that asserts
    // "not fatal" would still pass while the bug came straight back.
    assert.ok(FATAL_CREDENTIAL_REFUSAL_CODES.length >= 2, 'the fatal-code list must not be empty');
    assert.ok(FATAL_CREDENTIAL_REFUSAL_CODES.includes('YOLOBRIDGE_SCOPED_TOKEN_REQUIRED'));
    assert.ok(FATAL_CREDENTIAL_REFUSAL_CODES.includes('YOLOBRIDGE_TOKEN_FORBIDDEN'));
  });

  it('is true for every listed code at 403', () => {
    let checked = 0;
    for (const code of FATAL_CREDENTIAL_REFUSAL_CODES) {
      checked += 1;
      assert.equal(
        isFatalCredentialRefusal(new YoloBridgeApiError('stream open failed: nope', 403, code)),
        true,
        `${code} at 403 must be fatal`,
      );
    }
    assert.equal(checked, FATAL_CREDENTIAL_REFUSAL_CODES.length);
    assert.ok(checked > 0, 'the loop must actually have run');
  });

  it('is false for the SAME codes at a non-403 status', () => {
    // These codes mean "permanently refused" only when the boundary middleware
    // is the thing that said so.
    for (const code of FATAL_CREDENTIAL_REFUSAL_CODES) {
      assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('x', 500, code)), false);
      assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('x', 404, code)), false);
    }
  });

  it('is false for a 403 with an unrecognised code, or no code at all', () => {
    assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('x', 403, 'FORBIDDEN')), false);
    assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('x', 403)), false);
  });

  it('is false for the genuinely transient failures backoff exists for', () => {
    assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('bad gateway', 502)), false);
    assert.equal(isFatalCredentialRefusal(new YoloBridgeApiError('server error', 500)), false);
    assert.equal(isFatalCredentialRefusal(new Error('fetch failed: ECONNRESET')), false);
    assert.equal(isFatalCredentialRefusal('403 YOLOBRIDGE_SCOPED_TOKEN_REQUIRED'), false);
    assert.equal(isFatalCredentialRefusal(undefined), false);
  });
});

describe('fatalCredentialRefusalMessage', () => {
  it('carries the server prose, the status AND code, and BOTH remedies', () => {
    const message = fatalCredentialRefusalMessage(
      new YoloBridgeApiError(
        'stream open failed: This YoloBridge route requires a workspace-scoped daemon credential.',
        403,
        'YOLOBRIDGE_SCOPED_TOKEN_REQUIRED',
      ),
    );
    // Legible, not a bare status code.
    assert.match(message, /This YoloBridge route requires a workspace-scoped daemon credential/);
    assert.match(message, /HTTP 403 YOLOBRIDGE_SCOPED_TOKEN_REQUIRED/);
    // Says the thing the endless "Reconnecting in 28576ms" never admitted.
    assert.match(message, /reconnecting cannot fix it/i);
    // Both remedies, because neither alone covers both causes.
    assert.match(message, /Upgrade yolo-bridge/i);
    assert.match(message, /yolo-bridge attach/);
  });
});
