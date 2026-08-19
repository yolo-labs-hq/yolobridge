import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadAuth,
  saveAuth,
  clearAuth,
  loadAttachment,
  saveAttachment,
  clearAttachment,
  configDir,
  type ConfigStoreIO,
} from './config-store.js';

const ENV = { HOME: '/home/yolo' };

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => {
      files.set(p, contents);
    },
    removeFile: (p) => {
      files.delete(p);
    },
  };
}

describe('configDir', () => {
  it('lives under ~/.config/yolobridge', () => {
    assert.equal(configDir(ENV), '/home/yolo/.config/yolobridge');
  });
});

describe('auth store', () => {
  it('round-trips a saved token pair', () => {
    const io = fakeIO();
    const auth = { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAtMs: 123 };
    saveAuth(auth, ENV, io);
    assert.deepEqual(loadAuth(ENV, io), auth);
    assert.equal(io.files.has('/home/yolo/.config/yolobridge/auth.json'), true);
  });

  it('returns undefined when nothing is stored', () => {
    assert.equal(loadAuth(ENV, fakeIO()), undefined);
  });

  it('returns undefined for corrupt JSON rather than throwing', () => {
    const io = fakeIO();
    io.files.set('/home/yolo/.config/yolobridge/auth.json', '{not json');
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('returns undefined for a partially-shaped record (missing field)', () => {
    const io = fakeIO();
    io.files.set('/home/yolo/.config/yolobridge/auth.json', JSON.stringify({ accessToken: 'a' }));
    assert.equal(loadAuth(ENV, io), undefined);
  });

  it('clearAuth removes the file', () => {
    const io = fakeIO();
    const auth = { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAtMs: 123 };
    saveAuth(auth, ENV, io);
    clearAuth(ENV, io);
    assert.equal(loadAuth(ENV, io), undefined);
  });
});

describe('attachment store', () => {
  it('round-trips a saved attachment', () => {
    const io = fakeIO();
    const attachment = { workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: '2026-08-19T00:00:00.000Z' };
    saveAttachment(attachment, ENV, io);
    assert.deepEqual(loadAttachment(ENV, io), attachment);
  });

  it('clearAttachment removes the file', () => {
    const io = fakeIO();
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x' }, ENV, io);
    clearAttachment(ENV, io);
    assert.equal(loadAttachment(ENV, io), undefined);
  });
});
