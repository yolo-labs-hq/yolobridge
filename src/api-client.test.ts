import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { attach, listSelectableWorkspaces, YoloBridgeApiError, type ApiClientConfig } from './api-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CFG_BASE: Omit<ApiClientConfig, 'fetchImpl'> = {
  commonApiBaseUrl: 'https://api.example.com',
  accessToken: 'at',
};

describe('listSelectableWorkspaces', () => {
  it('GETs /v1/workspaces/selectable with a Bearer token and returns the id/name/status list', async () => {
    let seenUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (url: any, init?: any) => {
      seenUrl = String(url);
      seenHeaders = init?.headers;
      return jsonResponse(200, {
        workspaces: [
          { id: 'w1', name: 'My Workspace', status: 'running' },
          { id: 'w2', name: 'Paused One', status: 'paused' },
        ],
      });
    }) as any;

    const result = await listSelectableWorkspaces({ ...CFG_BASE, fetchImpl });

    assert.equal(seenUrl, 'https://api.example.com/v1/workspaces/selectable');
    assert.equal(seenHeaders?.Authorization, 'Bearer at');
    assert.deepEqual(result, [
      { id: 'w1', name: 'My Workspace', status: 'running' },
      { id: 'w2', name: 'Paused One', status: 'paused' },
    ]);
  });

  it('defaults a missing/non-string name to an empty string', async () => {
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [{ id: 'w1', status: 'creating' }] })) as any;
    const result = await listSelectableWorkspaces({ ...CFG_BASE, fetchImpl });
    assert.deepEqual(result, [{ id: 'w1', name: '', status: 'creating' }]);
  });

  it('throws YoloBridgeApiError on a non-ok response, carrying the parsed message/code', async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: 'Not authorized', code: 'UNAUTHENTICATED' })) as any;
    await assert.rejects(
      () => listSelectableWorkspaces({ ...CFG_BASE, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof YoloBridgeApiError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'UNAUTHENTICATED');
        assert.match(err.message, /Not authorized/);
        return true;
      },
    );
  });

  it('throws on a malformed body (workspaces not an array)', async () => {
    const fetchImpl = (async () => jsonResponse(200, { workspaces: 'nope' })) as any;
    await assert.rejects(
      () => listSelectableWorkspaces({ ...CFG_BASE, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof YoloBridgeApiError);
        assert.match(err.message, /unexpected shape/);
        return true;
      },
    );
  });

  it('throws on a malformed row (missing id/status)', async () => {
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [{ name: 'no id or status' }] })) as any;
    await assert.rejects(
      () => listSelectableWorkspaces({ ...CFG_BASE, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof YoloBridgeApiError);
        assert.match(err.message, /unexpected shape/);
        return true;
      },
    );
  });
});

describe('attach — host handshake', () => {
  it('POSTs hostLabel and the remoteHost facts the workspace tile renders as its session overview', async () => {
    let seenUrl: string | undefined;
    let seenBody: any;
    const fetchImpl = (async (url: any, init?: any) => {
      seenUrl = String(url);
      seenBody = JSON.parse(init.body);
      return jsonResponse(201, { tileId: 't1', attachmentId: 'a1', scopedToken: 's1', scopedTokenExpiresAt: 1_800_003_600_000 });
    }) as any;

    const result = await attach({ ...CFG_BASE, fetchImpl }, 'w1', 'my-laptop', {
      cwd: '/home/dev/proj',
      platform: 'linux',
      agent: 'claude',
    });

    assert.equal(seenUrl, 'https://api.example.com/v1/workspaces/w1/yolobridge/attach');
    assert.deepEqual(seenBody, {
      hostLabel: 'my-laptop',
      remoteHost: { cwd: '/home/dev/proj', platform: 'linux', agent: 'claude' },
    });
    assert.deepEqual(result, {
      tileId: 't1',
      attachmentId: 'a1',
      scopedToken: 's1',
      scopedTokenExpiresAt: 1_800_003_600_000,
    });
  });

  it('omits remoteHost entirely when it carries nothing — an empty object would be indistinguishable from an older daemon', async () => {
    let seenBody: any;
    const fetchImpl = (async (_url: any, init?: any) => {
      seenBody = JSON.parse(init.body);
      return jsonResponse(201, { tileId: 't1', attachmentId: 'a1', scopedToken: 's1', scopedTokenExpiresAt: 1_800_003_600_000 });
    }) as any;

    await attach({ ...CFG_BASE, fetchImpl }, 'w1', 'my-laptop', {});

    assert.deepEqual(seenBody, { hostLabel: 'my-laptop' });
  });

  it('still works with no host info at all (the pre-handshake call shape)', async () => {
    let seenBody: any;
    const fetchImpl = (async (_url: any, init?: any) => {
      seenBody = JSON.parse(init.body);
      return jsonResponse(201, { tileId: 't1', attachmentId: 'a1', scopedToken: 's1', scopedTokenExpiresAt: 1_800_003_600_000 });
    }) as any;

    await attach({ ...CFG_BASE, fetchImpl }, 'w1');

    assert.deepEqual(seenBody, {});
  });
});

describe('attach — the workspace-scoped credential is MANDATORY (card 09)', () => {
  it('returns the scoped pair verbatim when the server issues one', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonResponse(201, {
        tileId: 't1',
        attachmentId: 'a1',
        scopedToken: 'scoped.jwt',
        scopedTokenExpiresAt: 1_800_003_600_000,
      });
    }) as any;

    const result = await attach({ ...CFG_BASE, fetchImpl }, 'w1');
    assert.equal(called, 1, 'sanity: the request really was made');
    assert.equal(result.scopedToken, 'scoped.jwt');
    assert.equal(result.scopedTokenExpiresAt, 1_800_003_600_000);
  });

  it('THROWS on a 201 carrying no scoped credential at all — the old degrade path is gone', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonResponse(201, { tileId: 't1', attachmentId: 'a1' });
    }) as any;

    await assert.rejects(
      () => attach({ ...CFG_BASE, fetchImpl }, 'w1'),
      (err: unknown) => {
        assert.ok(err instanceof YoloBridgeApiError, `expected a YoloBridgeApiError, got ${String(err)}`);
        assert.match(err.message, /no workspace-scoped credential/i);
        return true;
      },
    );
    assert.equal(called, 1, 'sanity: it failed on the RESPONSE, not before sending the request');
  });

  it('THROWS on a half-pair (token, no expiry) — unschedulable is as useless as absent', async () => {
    const fetchImpl = (async () =>
      jsonResponse(201, { tileId: 't1', attachmentId: 'a1', scopedToken: 'scoped.jwt' })) as any;
    await assert.rejects(() => attach({ ...CFG_BASE, fetchImpl }, 'w1'), YoloBridgeApiError);
  });

  it('THROWS on a half-pair (expiry, no token)', async () => {
    const fetchImpl = (async () =>
      jsonResponse(201, { tileId: 't1', attachmentId: 'a1', scopedTokenExpiresAt: 1_800_003_600_000 })) as any;
    await assert.rejects(() => attach({ ...CFG_BASE, fetchImpl }, 'w1'), YoloBridgeApiError);
  });
});
