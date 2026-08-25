import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadAuth,
  saveAuth,
  clearAuth,
  loadAttachment,
  saveAttachment,
  clearAttachment,
  clearStoredScopedToken,
  configDir,
  type ConfigStoreIO,
} from './config-store.js';

const AUTH_FILE = '/home/yolo/.config/yolobridge/auth.json';
const ATTACHMENT_FILE = '/home/yolo/.config/yolobridge/attachment.json';

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

  it('writes an absent refreshToken as an ABSENT KEY, never as an empty string (card 08)', () => {
    // Asserted on the RAW bytes, not on what `loadAuth` hands back: `""` would
    // survive every `typeof x === 'string'` check downstream and be presented
    // to auth-service as a credential.
    const io = fakeIO();
    saveAuth({ accessToken: 'a', tokenType: 'Bearer', expiresAtMs: 123 }, ENV, io);
    const raw = io.files.get(AUTH_FILE);
    assert.ok(raw, 'sanity: the auth file must actually have been written');
    assert.ok(!/refreshToken/.test(raw), `auth.json must not mention refreshToken at all, got: ${raw}`);
    assert.equal('refreshToken' in JSON.parse(raw), false);
    assert.deepEqual(loadAuth(ENV, io), { accessToken: 'a', tokenType: 'Bearer', expiresAtMs: 123 });
  });

  it('normalises an EMPTY refreshToken to absent rather than writing it through', () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'a', refreshToken: '', tokenType: 'Bearer', expiresAtMs: 123 }, ENV, io);
    const raw = io.files.get(AUTH_FILE)!;
    assert.ok(!/refreshToken/.test(raw), `an empty refresh token must not be persisted, got: ${raw}`);
    assert.equal(loadAuth(ENV, io)?.refreshToken, undefined);
  });

  it('still loads an auth.json written by an OLDER daemon, refresh token and all (forward-compat read)', () => {
    // The format change is one-directional on purpose: a file that predates
    // card 08 must keep working, or upgrading the daemon logs the operator out.
    const io = fakeIO();
    io.files.set(
      AUTH_FILE,
      JSON.stringify({ accessToken: 'old-at', refreshToken: 'old-rt', tokenType: 'Bearer', expiresAtMs: 999 }),
    );
    assert.deepEqual(loadAuth(ENV, io), {
      accessToken: 'old-at',
      refreshToken: 'old-rt',
      tokenType: 'Bearer',
      expiresAtMs: 999,
    });
  });

  it('treats a record with NO refreshToken as valid, not corrupt', () => {
    const io = fakeIO();
    io.files.set(AUTH_FILE, JSON.stringify({ accessToken: 'at', tokenType: 'Bearer', expiresAtMs: 999 }));
    const loaded = loadAuth(ENV, io);
    assert.equal(loaded?.accessToken, 'at');
    assert.equal(loaded?.refreshToken, undefined);
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

  it('round-trips the workspace-scoped credential alongside the attachment (card 08)', () => {
    const io = fakeIO();
    const attachment = {
      workspaceId: 'w1',
      tileId: 't1',
      attachmentId: 'a1',
      attachedAt: 'x',
      scopedToken: 'scoped-tok',
      scopedTokenExpiresAtMs: 1_700_000_000_000,
    };
    saveAttachment(attachment, ENV, io);
    assert.deepEqual(loadAttachment(ENV, io), attachment);
  });

  it('drops a HALF-pair scoped credential while keeping the attachment identity', () => {
    // A token with no expiry cannot be scheduled around, and an expiry with no
    // token is nothing — but the identity is still perfectly usable for detach.
    const io = fakeIO();
    io.files.set(
      ATTACHMENT_FILE,
      JSON.stringify({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x', scopedToken: 'half' }),
    );
    assert.deepEqual(loadAttachment(ENV, io), {
      workspaceId: 'w1',
      tileId: 't1',
      attachmentId: 'a1',
      attachedAt: 'x',
    });
  });

  it('clearStoredScopedToken strips the credential and leaves the identity behind', () => {
    const io = fakeIO();
    saveAttachment(
      {
        workspaceId: 'w1',
        tileId: 't1',
        attachmentId: 'a1',
        attachedAt: 'x',
        scopedToken: 'scoped-tok',
        scopedTokenExpiresAtMs: 1,
      },
      ENV,
      io,
    );
    clearStoredScopedToken(ENV, io);
    const raw = io.files.get(ATTACHMENT_FILE);
    assert.ok(raw, 'the attachment record itself must survive — the retry path needs it');
    assert.ok(!/scoped-tok/.test(raw), `the stored credential must be gone, got: ${raw}`);
    assert.deepEqual(loadAttachment(ENV, io), {
      workspaceId: 'w1',
      tileId: 't1',
      attachmentId: 'a1',
      attachedAt: 'x',
    });
  });

  it('clearStoredScopedToken never CREATES an attachment file when none exists', () => {
    const io = fakeIO();
    clearStoredScopedToken(ENV, io);
    assert.equal(io.files.has(ATTACHMENT_FILE), false);
  });

  it('clearAttachment removes the file', () => {
    const io = fakeIO();
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x' }, ENV, io);
    clearAttachment(ENV, io);
    assert.equal(loadAttachment(ENV, io), undefined);
  });
});
