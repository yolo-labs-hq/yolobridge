/**
 * `yolo-bridge share <path>` — the local half.
 *
 * The refusals matter more than the happy path here. An over-cap or missing
 * file must fail from a `stat`, BEFORE any bytes move: the operator's
 * alternative is watching a 2 GB upload run to completion and then be rejected.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, truncateSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveAuth, saveAttachment, type ConfigStoreIO } from './config-store.js';

import {
  inspectLocalFile,
  shareFile,
  runShare,
  guessMimeType,
  formatBytes,
  ShareError,
  MAX_SHARE_BYTES,
} from './share-cmd.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'yb-share-'));
}

/** A sparse file of an exact size, without writing that many bytes. */
function sparseFile(dir: string, name: string, size: number): string {
  const p = path.join(dir, name);
  closeSync(openSync(p, 'w'));
  truncateSync(p, size);
  return p;
}

describe('inspectLocalFile — refusals happen before any upload', () => {
  it('names the file when it does not exist', async () => {
    const dir = scratch();
    try {
      await assert.rejects(
        () => inspectLocalFile(path.join(dir, 'nope.mp4')),
        (err: Error) => err instanceof ShareError && /No such file/.test(err.message),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a directory with a usable instruction', async () => {
    const dir = scratch();
    try {
      mkdirSync(path.join(dir, 'clips'));
      await assert.rejects(
        () => inspectLocalFile(path.join(dir, 'clips')),
        (err: Error) => err instanceof ShareError && /is a directory/.test(err.message),
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an over-cap file and names BOTH the size and the cap', async () => {
    const dir = scratch();
    try {
      const big = sparseFile(dir, 'master.mov', MAX_SHARE_BYTES + 1);
      await assert.rejects(
        () => inspectLocalFile(big),
        (err: Error) => {
          assert.ok(err instanceof ShareError);
          // "too large" without the cap leaves the operator guessing.
          assert.match(err.message, /100\.0 MB/);
          assert.match(err.message, /master\.mov/);
          return true;
        },
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts a file exactly AT the cap — the boundary is inclusive', async () => {
    const dir = scratch();
    try {
      const atCap = sparseFile(dir, 'exact.bin', MAX_SHARE_BYTES);
      const facts = await inspectLocalFile(atCap);
      assert.equal(facts.size, MAX_SHARE_BYTES);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('sends only the BASENAME — the local directory layout never leaves the machine', async () => {
    const dir = scratch();
    try {
      const nested = path.join(dir, 'Clients', 'SecretProject');
      mkdirSync(nested, { recursive: true });
      const f = path.join(nested, 'cut.mp4');
      writeFileSync(f, 'x');
      const facts = await inspectLocalFile(f);
      assert.equal(facts.filename, 'cut.mp4');
      assert.ok(!facts.filename.includes('SecretProject'));
      assert.ok(!facts.filename.includes(path.sep));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('guessMimeType', () => {
  it('maps the formats a video workflow actually produces', () => {
    assert.equal(guessMimeType('a.mp4'), 'video/mp4');
    assert.equal(guessMimeType('a.MOV'), 'video/quicktime');
    assert.equal(guessMimeType('a.png'), 'image/png');
  });
  it('falls back to octet-stream rather than guessing wrong', () => {
    assert.equal(guessMimeType('a.wat'), 'application/octet-stream');
    assert.equal(guessMimeType('noextension'), 'application/octet-stream');
  });
});

describe('formatBytes', () => {
  it('scales so the refusal message is readable', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(MAX_SHARE_BYTES), '100.0 MB');
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  });
});

describe('shareFile — presign, PUT, finalize', () => {
  function fakeFetch(calls: Array<{ url: string; init: any }>) {
    return async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith('/uploads')) {
        return new Response(JSON.stringify({
          assetId: 'asset-9', uploadUrl: 'https://r2.example/put?sig=1',
          method: 'PUT', headers: { 'Content-Type': 'video/mp4' },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.startsWith('https://r2.example/')) {
        // A real fetch consumes the stream body; the fake must too, or the
        // lazy read starts after the test has removed its temp dir.
        init?.body?.destroy?.();
        return new Response('', { status: 200 });
      }
      if (u.endsWith('/finalize')) {
        return new Response(JSON.stringify({ asset: { assetId: 'asset-9' } }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 500 });
    };
  }

  it('PUTs the bytes straight to R2 — they never transit common-api', async () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'hello');
      const calls: Array<{ url: string; init: any }> = [];
      const lines: string[] = [];

      const res = await shareFile(f, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 'scoped-tok' },
        workspaceId: 'ws1', attachmentId: 'att1',
        fetchImpl: fakeFetch(calls) as unknown as typeof fetch,
        write: (l) => lines.push(l),
      });

      assert.equal(res.assetId, 'asset-9');
      assert.equal(calls.length, 3, 'presign, PUT, finalize');
      assert.match(calls[0]!.url, /\/yolobridge\/attach\/att1\/uploads$/);
      // The upload target is R2, not the API host.
      assert.ok(calls[1]!.url.startsWith('https://r2.example/'));
      assert.ok(!calls[1]!.url.includes('api.example'));
      assert.match(calls[2]!.url, /\/uploads\/asset-9\/finalize$/);
      assert.ok(lines.some((l) => l.includes('asset-9')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('presigns with the basename and never a tileId — the server picks the tile', async () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'hello');
      const calls: Array<{ url: string; init: any }> = [];
      await shareFile(f, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
        workspaceId: 'ws1', attachmentId: 'att1',
        fetchImpl: fakeFetch(calls) as unknown as typeof fetch,
        write: () => {},
      });
      const body = JSON.parse(calls[0]!.init.body);
      assert.deepEqual(body, { filename: 'cut.mp4', mimeType: 'video/mp4', size: 5 });
      assert.ok(!('tileId' in body), 'a daemon does not get to choose the tile');
      assert.ok(!('path' in body));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries the SCOPED token on the API calls but not on the R2 PUT', async () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'hello');
      const calls: Array<{ url: string; init: any }> = [];
      await shareFile(f, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 'scoped-tok' },
        workspaceId: 'ws1', attachmentId: 'att1',
        fetchImpl: fakeFetch(calls) as unknown as typeof fetch,
        write: () => {},
      });
      assert.equal(calls[0]!.init.headers.Authorization, 'Bearer scoped-tok');
      // The presigned URL carries its own auth; sending ours to a third party
      // would leak the credential.
      assert.ok(!('Authorization' in (calls[1]!.init.headers ?? {})));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not upload at all when the local check refuses', async () => {
    const dir = scratch();
    try {
      const big = sparseFile(dir, 'master.mov', MAX_SHARE_BYTES + 1);
      const calls: Array<{ url: string; init: any }> = [];
      await assert.rejects(() => shareFile(big, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
        workspaceId: 'ws1', attachmentId: 'att1',
        fetchImpl: fakeFetch(calls) as unknown as typeof fetch,
        write: () => {},
      }));
      assert.equal(calls.length, 0, 'refused before any network call');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('runShare — preconditions read from disk', () => {
  const ENV = { HOME: '/home/yolo' };
  function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      readFile: (p: string) => files.get(p),
      writeFile: (p: string, contents: string) => { files.set(p, contents); },
      removeFile: (p: string) => { files.delete(p); },
    };
  }
  const AUTH = { accessToken: 'acct', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 1e6 };

  it('refuses when not logged in, and says how to fix it', async () => {
    const res = await runShare('./x.mp4', { commonApiBaseUrl: 'https://api.example', env: ENV, io: fakeIO() });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, 'not-logged-in');
    assert.match((res as any).message, /yolo-bridge login/);
  });

  it('refuses when there is no attachment', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const res = await runShare('./x.mp4', { commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, 'not-attached');
    assert.match((res as any).message, /yolo-bridge attach/);
  });

  it('refuses when the attachment has no SCOPED credential, rather than sending an account token to be 403d', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({ workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString() }, ENV, io);
    const res = await runShare('./x.mp4', { commonApiBaseUrl: 'https://api.example', env: ENV, io });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, 'no-scoped-credential');
    assert.match((res as any).message, /yolo-bridge attach/);
  });

  it('presents the SCOPED token, not the account token, once everything is in place', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    saveAttachment({
      workspaceId: 'ws1', tileId: 't1', attachmentId: 'att1', attachedAt: new Date().toISOString(),
      scopedToken: 'scoped-tok', scopedTokenExpiresAtMs: Date.now() + 1e6,
    }, ENV, io);

    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'hello');
      const seen: string[] = [];
      const res = await runShare(f, {
        commonApiBaseUrl: 'https://api.example', env: ENV, io,
        write: () => {},
        fetchImpl: (async (url: any, init: any) => {
          const u = String(url);
          if (init?.headers?.Authorization) seen.push(init.headers.Authorization);
          if (u.endsWith('/uploads')) {
            return new Response(JSON.stringify({ assetId: 'a1', uploadUrl: 'https://r2.example/put', method: 'PUT', headers: {} }),
              { status: 201, headers: { 'Content-Type': 'application/json' } });
          }
          if (u.startsWith('https://r2.example/')) { init?.body?.destroy?.(); return new Response('', { status: 200 }); }
          return new Response(JSON.stringify({ asset: { assetId: 'a1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }) as any,
      });
      assert.equal(res.ok, true);
      assert.ok(seen.length > 0);
      for (const h of seen) {
        assert.equal(h, 'Bearer scoped-tok');
        assert.notEqual(h, 'Bearer acct');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
