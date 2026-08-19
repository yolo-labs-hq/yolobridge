import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getStatus, formatStatus } from './status-cmd.js';
import { saveAuth, saveAttachment, type ConfigStoreIO } from './config-store.js';

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
});
