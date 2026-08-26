import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';

import { parseAttachArgs, resolveAttachHostInfo, resolveWorkspaceIdOrName } from './cli.js';

describe('parseAttachArgs', () => {
  it('plain workspaceId with no flags', () => {
    const result = parseAttachArgs(['w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('--label before the positional id', () => {
    const result = parseAttachArgs(['--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('positional id before --agent', () => {
    const result = parseAttachArgs(['w1', '--agent', 'codex']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: 'codex', agentId: undefined, fresh: false });
  });

  it('both flags in different order relative to the positional id', () => {
    const result = parseAttachArgs(['--agent', 'codex', '--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: 'codex', agentId: undefined, fresh: false });
  });

  it('--label with no id at all leaves workspaceId undefined (picker should trigger)', () => {
    const result = parseAttachArgs(['--label', 'laptop']);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: 'laptop', agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('no args at all leaves everything undefined (picker should trigger)', () => {
    const result = parseAttachArgs([]);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
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
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('--agent-id independent of --agent, for a binary whose registry identity differs (Codex review, 2026-08-24, round 4/5)', () => {
    const result = parseAttachArgs(['w1', '--agent', '/opt/bin/qwen', '--agent-id', 'qwen-code']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: '/opt/bin/qwen', agentId: 'qwen-code', fresh: false });
  });

  it('--agent-id alone, with no --agent (defaults the spawn binary elsewhere, only overrides the mint identity)', () => {
    const result = parseAttachArgs(['w1', '--agent-id', 'kiro']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: 'kiro', fresh: false });
  });

  it('a trailing --agent-id with no following value is rejected', () => {
    const result = parseAttachArgs(['w1', '--agent-id']);
    assert.deepEqual(result, { error: '--agent-id requires a value' });
  });

  it('--fresh sets the flag and, being a bare boolean, does not swallow the positional id', () => {
    // The whole hazard of adding a boolean to a parser built around
    // value-taking flags: `--fresh w1` must NOT consume `w1` as its value and
    // send the operator to the interactive picker.
    const result = parseAttachArgs(['--fresh', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: true });
  });

  it('--fresh combines with the value-taking flags in any order', () => {
    const result = parseAttachArgs(['w1', '--label', 'laptop', '--fresh', '--agent', 'codex']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: 'codex', agentId: undefined, fresh: true });
  });

  it('--fresh is false when absent, so the default is to resume', () => {
    const result = parseAttachArgs(['w1']);
    assert.equal('error' in result, false);
    assert.equal((result as { fresh?: boolean }).fresh, false);
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

describe('resolveAttachHostInfo', () => {
  const BASE = { hostname: 'dev-laptop', cwd: '/home/dev/proj', platform: 'linux', agent: 'claude' };

  it('defaults hostLabel to the machine hostname when --label was not given', () => {
    const result = resolveAttachHostInfo(BASE);
    assert.equal(result.hostLabel, 'dev-laptop');
  });

  it('lets an explicit --label win over the hostname', () => {
    const result = resolveAttachHostInfo({ ...BASE, label: 'workshop-pi' });
    assert.equal(result.hostLabel, 'workshop-pi');
  });

  it('falls back to the hostname for a whitespace-only label rather than naming the tile with blanks', () => {
    const result = resolveAttachHostInfo({ ...BASE, label: '   ' });
    assert.equal(result.hostLabel, 'dev-laptop');
  });

  it('leaves hostLabel undefined when there is neither a label nor a usable hostname', () => {
    const result = resolveAttachHostInfo({ ...BASE, hostname: '' });
    assert.equal(result.hostLabel, undefined);
  });

  it('reports exactly the three machine facts the tile shows — cwd, platform, agent — and nothing else', () => {
    const result = resolveAttachHostInfo(BASE);
    assert.deepEqual(result.remoteHost, { cwd: '/home/dev/proj', platform: 'linux', agent: 'claude' });
    // Guards the privacy boundary directly: adding an env dump, a username,
    // or a file listing here would fail this assertion, not slip through.
    assert.deepEqual(Object.keys(result.remoteHost).sort(), ['agent', 'cwd', 'platform']);
  });

  it('describes the REAL process when handed real values (no mocks — the actual call shape cli.ts uses)', () => {
    const result = resolveAttachHostInfo({
      hostname: hostname(),
      cwd: process.cwd(),
      platform: process.platform,
      agent: 'codex',
    });
    assert.equal(result.remoteHost.cwd, process.cwd());
    assert.equal(result.remoteHost.platform, process.platform);
    assert.equal(typeof result.hostLabel, 'string');
  });
});
