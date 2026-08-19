import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runListWorkspaces, formatWorkspacesTable } from './workspaces-cmd.js';
import { saveAuth, type ConfigStoreIO } from './config-store.js';

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

describe('runListWorkspaces', () => {
  it('fails fast when not logged in', async () => {
    const result = await runListWorkspaces({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io: fakeIO() });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not-logged-in');
  });

  it('returns the selectable workspace list on success', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 3600_000 }, ENV, io);
    const fetchImpl = (async (url: any) => {
      assert.equal(String(url), 'https://api.example.com/v1/workspaces/selectable');
      return jsonResponse(200, { workspaces: [{ id: 'w1', name: 'Alpha', status: 'running' }] });
    }) as any;

    const result = await runListWorkspaces({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.deepEqual(result, { ok: true, workspaces: [{ id: 'w1', name: 'Alpha', status: 'running' }] });
  });

  it('surfaces an api-client error as reason "error"', async () => {
    const io = fakeIO();
    saveAuth({ accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 3600_000 }, ENV, io);
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as any;

    const result = await runListWorkspaces({ commonApiBaseUrl: 'https://api.example.com', env: ENV, io, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'error');
      assert.match(result.message, /boom/);
    }
  });
});

describe('formatWorkspacesTable', () => {
  it('prints a clear message for an empty list', () => {
    assert.equal(formatWorkspacesTable([]), 'No workspaces found.');
  });

  it('renders an aligned id/name/status table, falling back to "(unnamed)"', () => {
    const table = formatWorkspacesTable([
      { id: 'w1', name: 'Alpha', status: 'running' },
      { id: 'workspace-2', name: '', status: 'paused' },
    ]);
    const lines = table.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ID\s+NAME\s+STATUS$/);
    assert.match(lines[1], /^w1\s+Alpha\s+running$/);
    assert.match(lines[2], /^workspace-2\s+\(unnamed\)\s+paused$/);
  });
});
