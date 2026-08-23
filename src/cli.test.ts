import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAttachArgs, resolveWorkspaceIdOrName } from './cli.js';

describe('parseAttachArgs', () => {
  it('plain workspaceId with no flags', () => {
    const result = parseAttachArgs(['w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined });
  });

  it('--label before the positional id', () => {
    const result = parseAttachArgs(['--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: undefined });
  });

  it('positional id before --agent', () => {
    const result = parseAttachArgs(['w1', '--agent', 'codex']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: 'codex' });
  });

  it('both flags in different order relative to the positional id', () => {
    const result = parseAttachArgs(['--agent', 'codex', '--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: 'codex' });
  });

  it('--label with no id at all leaves workspaceId undefined (picker should trigger)', () => {
    const result = parseAttachArgs(['--label', 'laptop']);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: 'laptop', agentBin: undefined });
  });

  it('no args at all leaves everything undefined (picker should trigger)', () => {
    const result = parseAttachArgs([]);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: undefined, agentBin: undefined });
  });

  it('--label value that looks like a flag is rejected as a missing value, not consumed', () => {
    const result = parseAttachArgs(['--label', '--agent', 'codex']);
    assert.deepEqual(result, { error: '--label requires a value' });
  });

  it('a trailing flag with no following value is rejected', () => {
    const result = parseAttachArgs(['w1', '--label']);
    assert.deepEqual(result, { error: '--label requires a value' });
  });

  it('an unrecognized flag is a hard error, not silently misparsed', () => {
    const result = parseAttachArgs(['--bogus', 'w1']);
    assert.deepEqual(result, { error: "unrecognized option '--bogus'" });
  });

  it('only the first positional token is taken as the workspaceId', () => {
    const result = parseAttachArgs(['w1', 'w2']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined });
  });
});

describe('resolveWorkspaceIdOrName', () => {
  const OID = '665f00000000000000000001';
  const OID2 = '665f00000000000000000002';

  it('an id-shaped value is used as-is, with no lookup call at all', async () => {
    let called = false;
    const result = await resolveWorkspaceIdOrName(OID, { commonApiBaseUrl: 'http://x' }, async () => {
      called = true;
      return { ok: true, workspaces: [] };
    });
    assert.deepEqual(result, { ok: true, workspaceId: OID });
    assert.equal(called, false);
  });

  it('resolves a name to its id via a case-insensitive exact match', async () => {
    const result = await resolveWorkspaceIdOrName('Pong', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [{ id: OID, name: 'pong', status: 'creating' }],
    }));
    assert.deepEqual(result, { ok: true, workspaceId: OID });
  });

  it('a name with no match is a clear error, not a fallback to treating it as an id', async () => {
    const result = await resolveWorkspaceIdOrName('nope', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [{ id: OID, name: 'pong', status: 'creating' }],
    }));
    assert.deepEqual(result, {
      ok: false,
      message: 'no workspace named "nope" found (run `yolo-bridge workspaces` to see your workspaces)',
    });
  });

  it('a name matching multiple workspaces errors instead of silently picking the first', async () => {
    const result = await resolveWorkspaceIdOrName('dup', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [
        { id: OID, name: 'dup', status: 'running' },
        { id: OID2, name: 'dup', status: 'creating' },
      ],
    }));
    assert.deepEqual(result, {
      ok: false,
      message: `multiple workspaces are named "dup" — attach by id instead: ${OID} [running], ${OID2} [creating]`,
    });
  });

  it('propagates a lookup failure (e.g. not logged in) as its own error', async () => {
    const result = await resolveWorkspaceIdOrName('pong', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: false,
      reason: 'not-logged-in',
      message: 'Not logged in — run `yolo-bridge login` first.',
    }));
    assert.deepEqual(result, { ok: false, message: 'Not logged in — run `yolo-bridge login` first.' });
  });
});
