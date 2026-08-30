import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveAgentBinary, type BinaryProbeFs } from './resolve-agent-binary.js';

/** A fake filesystem: `files` maps an absolute path to whether it is executable. */
function fakeFs(files: Record<string, 'exec' | 'noexec' | 'dir'>): BinaryProbeFs {
  return {
    statSync(p: string) {
      const kind = files[p];
      if (!kind) throw new Error('ENOENT');
      return { isFile: () => kind !== 'dir', isDirectory: () => kind === 'dir' };
    },
    accessSync(p: string) {
      if (files[p] !== 'exec') throw new Error('EACCES');
    },
    constants: { X_OK: 1 },
  };
}

const PATH_ENV = { PATH: ['/usr/bin', '/opt/homebrew/bin', '/Users/j/.local/bin'].join(path.delimiter) };

describe('finding the agent binary', () => {
  it('returns the first PATH hit, in PATH order', () => {
    const io = fakeFs({ '/opt/homebrew/bin/claude': 'exec', '/Users/j/.local/bin/claude': 'exec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.path, '/opt/homebrew/bin/claude');
  });

  it('takes an explicit path at its word, without searching PATH', () => {
    const io = fakeFs({ [path.resolve('/custom/claude')]: 'exec' });
    const r = resolveAgentBinary('/custom/claude', { PATH: '' }, io);
    assert.equal(r.ok, true);
  });
});

describe('the message an operator actually reads', () => {
  it('names the MISSING BINARY, not just that something failed', () => {
    // The whole point: node-pty says only `posix_spawnp failed.`
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'not-found');
    assert.match(r.ok === false ? r.message : '', /claude/);
  });

  it('warns that a shell alias or function is not spawnable', () => {
    // ⚠️ The macOS trap. `claude` working when typed argues nothing is wrong,
    // so a bare "not found" gets answered with "but it IS installed".
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /alias or function/);
    assert.match(r.ok === false ? r.message : '', /type -a claude/);
  });

  it('offers the escape hatch when it cannot be found', () => {
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /--agent/);
    assert.match(r.ok === false ? r.message : '', /YOLOBRIDGE_AGENT_BIN/);
  });

  it('distinguishes NOT EXECUTABLE from missing, and says chmod', () => {
    // A different fault with a different fix — collapsing them into "not
    // found" sends the operator to reinstall something already present.
    const io = fakeFs({ '/opt/homebrew/bin/claude': 'noexec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok === false && r.reason, 'not-executable');
    assert.match(r.ok === false ? r.message : '', /chmod \+x/);
    assert.match(r.ok === false ? r.message : '', /opt\/homebrew\/bin\/claude/);
  });

  it('reports an EMPTY PATH as its own fault, not as "not found"', () => {
    const r = resolveAgentBinary('claude', { PATH: '' }, fakeFs({}));
    assert.equal(r.ok === false && r.reason, 'no-path');
    assert.match(r.ok === false ? r.message : '', /PATH is empty/);
  });

  it('says how many directories it searched, so "it IS installed" is checkable', () => {
    const r = resolveAgentBinary('claude', PATH_ENV, fakeFs({}));
    assert.match(r.ok === false ? r.message : '', /searched 3 directories/);
  });
});

describe('things that must not be mistaken for a binary', () => {
  it('does not accept a DIRECTORY named like the binary', () => {
    const io = fakeFs({ '/usr/bin/claude': 'dir' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'not-found');
  });

  it('skips a non-executable hit and keeps searching for a real one', () => {
    // PATH order matters: an earlier unusable entry must not mask a later
    // working install, or the operator is told to chmod something irrelevant.
    const io = fakeFs({ '/usr/bin/claude': 'noexec', '/opt/homebrew/bin/claude': 'exec' });
    const r = resolveAgentBinary('claude', PATH_ENV, io);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.path, '/opt/homebrew/bin/claude');
  });

  it('ignores empty PATH segments rather than probing the cwd', () => {
    // A trailing ':' means "current directory" to some shells; spawning a
    // binary from wherever the operator happens to be is not a behaviour to
    // inherit by accident.
    const io = fakeFs({ [path.join('', 'claude')]: 'exec' });
    const r = resolveAgentBinary('claude', { PATH: '/usr/bin:' }, io);
    assert.equal(r.ok, false);
  });
});
