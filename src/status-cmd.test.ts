import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getStatus, formatStatus } from './status-cmd.js';
import { saveAuth, saveAttachment, type ConfigStoreIO } from './config-store.js';
import { resetConnectionState, recordConnectionEvent } from './connection-state.js';

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

describe('getStatus', () => {
  it('reports logged-out, not-attached with nothing stored', () => {
    const report = getStatus({ env: ENV, io: fakeIO() });
    assert.deepEqual(report, { loggedIn: false, attached: false });
  });

  it('reports logged-in + attached with both stored', () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 2_000 }, ENV, io);
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: '2026-08-19T00:00:00.000Z' }, ENV, io);
    const report = getStatus({ env: ENV, io, now: () => 1_000 });
    assert.equal(report.loggedIn, true);
    assert.equal(report.tokenExpired, false);
    assert.equal(report.attached, true);
    assert.equal(report.workspaceId, 'w1');
  });

  it('surfaces the connection state the attach daemon recorded out-of-band', () => {
    // The other half of the TUI-clobbering fix: the daemon no longer prints
    // drop/reconnect notifications into the terminal, so this command is
    // where a user reads them back instead.
    const io = fakeIO();
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x' }, ENV, io);
    resetConnectionState('a1', { state: 'connecting', at: '2026-08-25T00:00:00.000Z' }, ENV, io);
    recordConnectionEvent('a1', { state: 'connected', at: '2026-08-25T00:00:01.000Z' }, ENV, io);
    recordConnectionEvent(
      'a1',
      { state: 'interrupted', at: '2026-08-25T00:00:02.000Z', detail: 'stream open failed: Bad gateway' },
      ENV,
      io,
    );

    const report = getStatus({ env: ENV, io });
    assert.equal(report.connection?.state, 'interrupted');
    assert.deepEqual(report.connectionHistory?.map((e) => e.state), ['connecting', 'connected']);
  });

  it('ignores a connection record left over from a previous attachment', () => {
    const io = fakeIO();
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a2', attachedAt: 'x' }, ENV, io);
    resetConnectionState('a1', { state: 'interrupted', at: '2026-08-25T00:00:00.000Z' }, ENV, io);

    const report = getStatus({ env: ENV, io });
    assert.equal(report.connection, undefined);
  });

  it('flags an expired token', () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 500 }, ENV, io);
    const report = getStatus({ env: ENV, io, now: () => 1_000 });
    assert.equal(report.tokenExpired, true);
  });
});

describe('formatStatus', () => {
  it('renders a human-readable not-logged-in report', () => {
    const text = formatStatus({ loggedIn: false, attached: false });
    assert.match(text, /Logged in: no/);
    assert.match(text, /Attached: no/);
  });

  it('renders an attached report with the local-state caveat', () => {
    const text = formatStatus({
      loggedIn: true,
      tokenExpiresAtMs: 2_000,
      tokenExpired: false,
      attached: true,
      workspaceId: 'w1',
      tileId: 't1',
      attachmentId: 'a1',
      attachedAt: 'x',
    });
    assert.match(text, /workspace=w1/);
    assert.match(text, /does not confirm/);
  });

  it('renders the recorded connection state and its recent transitions', () => {
    const text = formatStatus({
      loggedIn: true,
      tokenExpiresAtMs: 2_000,
      tokenExpired: false,
      attached: true,
      workspaceId: 'w1',
      tileId: 't1',
      attachmentId: 'a1',
      attachedAt: 'x',
      connection: { state: 'connected', at: '2026-08-25T00:00:03.000Z' },
      connectionHistory: [
        { state: 'connecting', at: '2026-08-25T00:00:00.000Z' },
        { state: 'interrupted', at: '2026-08-25T00:00:01.000Z', detail: 'stream open failed: Bad gateway' },
        { state: 'reconnecting', at: '2026-08-25T00:00:02.000Z', attempt: 1, retryInMs: 1000 },
      ],
    });
    assert.match(text, /Connection: connected/);
    assert.match(text, /interrupted .*Bad gateway/);
    assert.match(text, /reconnecting \(attempt 1, retrying in 1000ms\)/);
  });
});
