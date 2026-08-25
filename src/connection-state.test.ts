import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadConnectionState,
  recordConnectionEvent,
  resetConnectionState,
  formatConnectionEvent,
  MAX_RECENT_EVENTS,
  type ConnectionEvent,
} from './connection-state.js';
import type { ConfigStoreIO } from './config-store.js';

const ENV = { HOME: '/home/yolo' };

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => { files.set(p, contents); },
    removeFile: (p) => { files.delete(p); },
  };
}

function event(state: ConnectionEvent['state'], at = '2026-08-25T00:00:00.000Z'): ConnectionEvent {
  return { state, at };
}

describe('connection-state', () => {
  it('returns undefined when nothing has been recorded', () => {
    assert.equal(loadConnectionState(ENV, fakeIO()), undefined);
  });

  it('rolls the previous current state into a bounded recent tail', () => {
    const io = fakeIO();
    resetConnectionState('a1', event('connecting'), ENV, io);
    recordConnectionEvent('a1', event('connected'), ENV, io);
    recordConnectionEvent('a1', event('interrupted'), ENV, io);
    recordConnectionEvent('a1', event('reconnecting'), ENV, io);

    const stored = loadConnectionState(ENV, io);
    assert.equal(stored?.current.state, 'reconnecting');
    assert.deepEqual(stored?.recent.map((e) => e.state), ['connecting', 'connected', 'interrupted']);
  });

  it('caps the recent tail so a long-running daemon on a flaky link cannot grow the file without limit', () => {
    const io = fakeIO();
    resetConnectionState('a1', event('connecting'), ENV, io);
    for (let i = 0; i < MAX_RECENT_EVENTS + 10; i++) {
      recordConnectionEvent('a1', event(i % 2 === 0 ? 'interrupted' : 'connected'), ENV, io);
    }
    const stored = loadConnectionState(ENV, io);
    assert.equal(stored?.recent.length, MAX_RECENT_EVENTS);
  });

  it('starts a fresh record when the attachment id changes, rather than appending to a stale one', () => {
    const io = fakeIO();
    resetConnectionState('a1', event('connecting'), ENV, io);
    recordConnectionEvent('a1', event('interrupted'), ENV, io);
    recordConnectionEvent('a2', event('connected'), ENV, io);

    const stored = loadConnectionState(ENV, io);
    assert.equal(stored?.attachmentId, 'a2');
    assert.deepEqual(stored?.recent, []);
  });

  it('ignores a corrupt record instead of throwing at the caller', () => {
    const io = fakeIO();
    io.writeFile('/home/yolo/.config/yolobridge/connection.json', '{not json');
    assert.equal(loadConnectionState(ENV, io), undefined);
  });

  it('renders a reconnect attempt with its backoff for `yolo-bridge status`', () => {
    const text = formatConnectionEvent({
      state: 'reconnecting',
      at: '2026-08-25T00:00:00.000Z',
      attempt: 3,
      retryInMs: 4000,
    });
    assert.match(text, /reconnecting/);
    assert.match(text, /attempt 3/);
    assert.match(text, /4000ms/);
  });

  it('renders an interruption with its underlying detail', () => {
    const text = formatConnectionEvent({
      state: 'interrupted',
      at: '2026-08-25T00:00:00.000Z',
      detail: 'stream open failed: Bad gateway',
    });
    assert.match(text, /interrupted/);
    assert.match(text, /Bad gateway/);
  });
});
