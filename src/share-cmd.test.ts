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

describe('runShare — workspace binding', () => {
  const ENV2 = { HOME: '/home/yolo' };
  function fakeIO2(): any {
    const files = new Map<string, string>();
    return { files, readFile: (p: string) => files.get(p), writeFile: (p: string, c: string) => { files.set(p, c); }, removeFile: (p: string) => { files.delete(p); } };
  }
  const AUTH2 = { accessToken: 'acct', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 1e6 };

  it('refuses when the stored attachment moved to a DIFFERENT workspace, and sends nothing', async () => {
    // A second `yolo-bridge attach` rewrites the attachment on disk. A caller
    // that authorised against workspace A must not upload into workspace B.
    const io = fakeIO2();
    saveAuth(AUTH2, ENV2, io);
    saveAttachment({
      workspaceId: 'ws-NEW', tileId: 't', attachmentId: 'att', attachedAt: new Date().toISOString(),
      scopedToken: 'scoped', scopedTokenExpiresAtMs: Date.now() + 1e6,
    }, ENV2, io);

    let called = false;
    const res = await runShare('/tmp/whatever', {
      commonApiBaseUrl: 'https://api.example', env: ENV2, io,
      expectedWorkspaceId: 'ws-OLD',
      fetchImpl: (async () => { called = true; return new Response('', { status: 200 }); }) as any,
    });
    assert.equal(res.ok, false);
    assert.equal((res as any).reason, 'workspace-changed');
    assert.equal(called, false, 'nothing may be sent when the workspace changed under us');
  });

  it('proceeds when the workspace matches', async () => {
    const io = fakeIO2();
    saveAuth(AUTH2, ENV2, io);
    saveAttachment({
      workspaceId: 'ws-1', tileId: 't', attachmentId: 'att', attachedAt: new Date().toISOString(),
      scopedToken: 'scoped', scopedTokenExpiresAtMs: Date.now() + 1e6,
    }, ENV2, io);

    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      const res = await runShare(f, {
        commonApiBaseUrl: 'https://api.example', env: ENV2, io,
        expectedWorkspaceId: 'ws-1', write: () => {},
        fetchImpl: (async (url: any, init: any) => {
          const u = String(url);
          if (u.endsWith('/uploads')) return new Response(JSON.stringify({ assetId: 'a1', uploadUrl: 'https://r2.example/put', method: 'PUT', headers: {} }), { status: 201, headers: { 'Content-Type': 'application/json' } });
          if (u.startsWith('https://r2.example/')) { init?.body?.destroy?.(); return new Response('', { status: 200 }); }
          return new Response(JSON.stringify({ asset: { assetId: 'a1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }) as any,
      });
      assert.equal(res.ok, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is unbound when no expected workspace is given — the human command keeps full reach', async () => {
    const io = fakeIO2();
    saveAuth(AUTH2, ENV2, io);
    saveAttachment({
      workspaceId: 'ws-ANY', tileId: 't', attachmentId: 'att', attachedAt: new Date().toISOString(),
      scopedToken: 'scoped', scopedTokenExpiresAtMs: Date.now() + 1e6,
    }, ENV2, io);
    const res = await runShare('/tmp/definitely-not-here.mp4', {
      commonApiBaseUrl: 'https://api.example', env: ENV2, io, write: () => {},
    });
    // Gets past the workspace gate and fails on the missing FILE instead.
    assert.equal((res as any).reason, 'error');
    assert.match((res as any).message, /No such file/);
  });
});

describe('shareFile — delivering into another tile', () => {
  function fetchFor(calls: Array<{ url: string; init: any }>, deliverStatus = 200) {
    return async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.endsWith('/uploads')) {
        return new Response(JSON.stringify({ assetId: 'asset-9', uploadUrl: 'https://r2.example/put', method: 'PUT', headers: {} }),
          { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.startsWith('https://r2.example/')) { init?.body?.destroy?.(); return new Response('', { status: 200 }); }
      if (u.endsWith('/finalize')) {
        return new Response(JSON.stringify({ asset: { assetId: 'asset-9' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.endsWith('/deliver')) {
        return deliverStatus === 200
          ? new Response(JSON.stringify({ path: '.yolo-drops/asset-9-cut.mp4', size: 5, filename: 'cut.mp4' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ error: 'Session is not reachable', code: 'SESSION_NOT_FOUND' }), { status: deliverStatus, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('unexpected', { status: 500 });
    };
  }

  function withFile(fn: (f: string) => Promise<void>) {
    const dir = scratch();
    const f = path.join(dir, 'cut.mp4');
    writeFileSync(f, 'hello');
    return fn(f).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it('does NOT deliver when no target is given — the sibling behaviour is unchanged', async () => {
    await withFile(async (f) => {
      const calls: Array<{ url: string; init: any }> = [];
      const res = await shareFile(f, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
        workspaceId: 'ws1', attachmentId: 'att1',
        fetchImpl: fetchFor(calls) as unknown as typeof fetch, write: () => {},
      });
      assert.equal(res.deliveredPath, undefined);
      assert.equal(calls.filter((c) => c.url.endsWith('/deliver')).length, 0);
    });
  });

  it('delivers after finalize and returns the written path', async () => {
    await withFile(async (f) => {
      const calls: Array<{ url: string; init: any }> = [];
      const res = await shareFile(f, {
        cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
        workspaceId: 'ws1', attachmentId: 'att1', targetTileId: 'tile-2',
        fetchImpl: fetchFor(calls) as unknown as typeof fetch, write: () => {},
      });
      assert.equal(res.deliveredPath, '.yolo-drops/asset-9-cut.mp4');

      const deliver = calls.find((c) => c.url.endsWith('/deliver'))!;
      assert.deepEqual(JSON.parse(deliver.init.body), { assetId: 'asset-9', targetTileId: 'tile-2' });
      // Ordering matters: delivering before finalize would target an asset that
      // is still pending.
      const order = calls.map((c) => (c.url.endsWith('/finalize') ? 'finalize' : c.url.endsWith('/deliver') ? 'deliver' : 'other'));
      assert.ok(order.indexOf('finalize') < order.indexOf('deliver'));
    });
  });

  it('says the file IS in the workspace when only DELIVERY fails', async () => {
    // The upload already succeeded. Reporting a flat failure would invite a
    // re-upload of something that is already there.
    await withFile(async (f) => {
      const calls: Array<{ url: string; init: any }> = [];
      await assert.rejects(
        () => shareFile(f, {
          cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
          workspaceId: 'ws1', attachmentId: 'att1', targetTileId: 'tile-2',
          fetchImpl: fetchFor(calls, 409) as unknown as typeof fetch, write: () => {},
        }),
        (err: Error) => {
          assert.match(err.message, /asset-9/, 'name the asset that DID land');
          assert.match(err.message, /IS in the workspace/);
          assert.match(err.message, /retry the DELIVERY only/);
          assert.match(err.message, /yolo-bridge deliver asset-9 --to tile-2/,
            'and it must name a command that exists');
          return true;
        },
      );
      assert.equal(calls.filter((c) => c.url.endsWith('/uploads')).length, 1, 'no re-upload attempted');
    });
  });
});

describe('the delivery failure message names a command that EXISTS', () => {
  it('points at `yolo-bridge deliver <assetId> --to <tile>`, with the real asset id', async () => {
    // codex P2: the message previously said "retry the delivery rather than the
    // upload" when no entry point could do that — every path began with a fresh
    // presign, so the only available retry duplicated the asset.
    const dir = scratch();
    const f = path.join(dir, 'cut.mp4');
    writeFileSync(f, 'hello');
    try {
      const calls: Array<{ url: string; init: any }> = [];
      await assert.rejects(
        () => shareFile(f, {
          cfg: { commonApiBaseUrl: 'https://api.example', accessToken: 't' },
          workspaceId: 'ws1', attachmentId: 'att1', targetTileId: 'tile-2',
          write: () => {},
          fetchImpl: (async (url: any, init: any) => {
            const u = String(url);
            calls.push({ url: u, init });
            if (u.endsWith('/uploads')) return new Response(JSON.stringify({ assetId: 'asset-9', uploadUrl: 'https://r2.example/put', method: 'PUT', headers: {} }), { status: 201, headers: { 'Content-Type': 'application/json' } });
            if (u.startsWith('https://r2.example/')) { init?.body?.destroy?.(); return new Response('', { status: 200 }); }
            if (u.endsWith('/finalize')) return new Response(JSON.stringify({ asset: { assetId: 'asset-9' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
            return new Response(JSON.stringify({ error: 'Session is not reachable' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
          }) as any,
        }),
        (err: Error) => {
          assert.match(err.message, /yolo-bridge deliver asset-9 --to tile-2/,
            'the instruction must be a command the operator can actually run');
          return true;
        },
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
