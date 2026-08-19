import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listSelectableWorkspaces, YoloBridgeApiError, type ApiClientConfig } from './api-client.js';

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
