import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runDetach } from './detach-cmd.js';
import { saveAuth, saveAttachment, loadAttachment, type ConfigStoreIO } from './config-store.js';

const ATTACHMENT_FILE = '/home/yolo/.config/yolobridge/attachment.json';

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('runDetach', () => {
  it('calls DELETE with the stored attachment and clears local state', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1 }, ENV, io);
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x' }, ENV, io);

    let sawDelete = false;
    const fetchImpl = (async (url: any, init?: any) => {
      if (String(url).endsWith('/v1/workspaces/w1/yolobridge/attach/a1') && init?.method === 'DELETE') {
        sawDelete = true;
        return new Response(null, { status: 204 });
      }
      throw new Error('unexpected request');
    }) as any;

    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.deepEqual(result, { ok: true });
    assert.equal(sawDelete, true);
    assert.equal(loadAttachment(ENV, io), undefined);
  });

  it('fails fast when not logged in', async () => {
    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io: fakeIO() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not-logged-in');
  });

  it('fails fast when there is no local attachment record', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1 }, ENV, io);
    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not-attached');
  });

  it('leaves NO stored scoped token behind on a successful detach (card 08)', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1 }, ENV, io);
    saveAttachment(
      {
        workspaceId: 'w1',
        tileId: 't1',
        attachmentId: 'a1',
        attachedAt: 'x',
        scopedToken: 'scoped-tok',
        scopedTokenExpiresAtMs: 2,
      },
      ENV,
      io,
    );
    let sawDelete = false;
    const fetchImpl = (async () => {
      sawDelete = true;
      return new Response(null, { status: 204 });
    }) as any;

    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.deepEqual(result, { ok: true });
    assert.equal(sawDelete, true, 'sanity: the DELETE must actually have been attempted');
    assert.equal(
      [...io.files.values()].some((contents) => contents.includes('scoped-tok')),
      false,
      'the scoped credential must not survive a detach anywhere in the config dir',
    );
  });

  it('strips the stored scoped token even when the DELETE itself FAILS, while keeping the record for the retry (card 08)', async () => {
    // The load-bearing half. On success `clearAttachment` removes the whole
    // file, so a success-path assertion would pass even with the strip deleted.
    // On failure the record is deliberately KEPT — so this is the only path
    // where stripping the credential is the thing doing the work.
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1 }, ENV, io);
    saveAttachment(
      {
        workspaceId: 'w1',
        tileId: 't1',
        attachmentId: 'a1',
        attachedAt: 'x',
        scopedToken: 'scoped-tok',
        scopedTokenExpiresAtMs: 2,
      },
      ENV,
      io,
    );
    let sawDelete = false;
    const fetchImpl = (async () => {
      sawDelete = true;
      return jsonResponse(500, { error: 'upstream exploded' });
    }) as any;

    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(sawDelete, true, 'sanity: the DELETE must actually have been attempted and failed');

    const raw = io.files.get(ATTACHMENT_FILE);
    assert.ok(raw, 'the attachment record must survive a failed detach — the retry path needs it');
    assert.ok(!raw.includes('scoped-tok'), `the scoped credential must be gone, got: ${raw}`);
    const stored = loadAttachment(ENV, io);
    assert.equal(stored?.attachmentId, 'a1', 'the identity must survive so the detach can be retried');
    assert.equal(stored?.scopedToken, undefined);
  });

  it('treats a 404 (already detached server-side) as success', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: 1 }, ENV, io);
    saveAttachment({ workspaceId: 'w1', tileId: 't1', attachmentId: 'a1', attachedAt: 'x' }, ENV, io);
    const fetchImpl = (async () => jsonResponse(404, { error: 'Attachment not found', code: 'NOT_FOUND' })) as any;
    const result = await runDetach({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.deepEqual(result, { ok: true });
    assert.equal(loadAttachment(ENV, io), undefined);
  });
});
