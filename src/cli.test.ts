import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAttachArgs } from './cli.js';

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
