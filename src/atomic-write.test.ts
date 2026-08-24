import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync, existsSync, statSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync } from './atomic-write.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-atomic-write-test-'));
});
afterEach(() => {
  chmodSync(dir, 0o755); // undo any test's own restriction so cleanup can succeed
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('creates a new file with the given content', () => {
    const path = join(dir, 'new.json');
    atomicWriteFileSync(path, '{"a":1}');
    assert.equal(readFileSync(path, 'utf-8'), '{"a":1}');
  });

  it('replaces an existing file’s content in full', () => {
    const path = join(dir, 'existing.json');
    writeFileSync(path, '{"old":true}');
    atomicWriteFileSync(path, '{"new":true}');
    assert.equal(readFileSync(path, 'utf-8'), '{"new":true}');
  });

  it('leaves no stray temp file behind after a successful write', () => {
    const path = join(dir, 'clean.json');
    atomicWriteFileSync(path, '{}');
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['clean.json']);
  });

  it('does NOT touch the existing file’s content when the write fails (Codex review, 2026-08-24, round 13)', () => {
    // A direct writeFileSync on an EXISTING file truncates it before writing
    // the new bytes -- ENOSPC or a crash mid-write leaves it half-written,
    // unrecoverable. The atomic (temp file + rename) approach never opens
    // the ORIGINAL path for writing at all, so a failure writing the temp
    // file leaves the original completely untouched. Forces the failure
    // with a read-only directory (real fs permission enforcement), which
    // blocks creating the temp file.
    const path = join(dir, 'protected.json');
    writeFileSync(path, '{"original":true}');
    chmodSync(dir, 0o555);
    try {
      assert.throws(() => atomicWriteFileSync(path, '{"new":true}'));
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(readFileSync(path, 'utf-8'), '{"original":true}');
  });

  it('does not leave a stray temp file behind after a failed write', () => {
    const path = join(dir, 'protected2.json');
    writeFileSync(path, '{"original":true}');
    chmodSync(dir, 0o555);
    try {
      assert.throws(() => atomicWriteFileSync(path, '{"new":true}'));
    } finally {
      chmodSync(dir, 0o755);
    }
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['protected2.json']);
  });

  it('uses distinct temp paths for concurrent writers into the same directory (no collision)', () => {
    // Two attach processes writing into the SAME project directory is a
    // real scenario this codebase already guards against elsewhere
    // (concurrent sibling attach) -- the per-write random suffix means two
    // overlapping writes never race on the same temp path.
    const pathA = join(dir, 'a.json');
    const pathB = join(dir, 'b.json');
    atomicWriteFileSync(pathA, '{"a":1}');
    atomicWriteFileSync(pathB, '{"b":2}');
    assert.equal(readFileSync(pathA, 'utf-8'), '{"a":1}');
    assert.equal(readFileSync(pathB, 'utf-8'), '{"b":2}');
    assert.equal(existsSync(pathA), true);
    assert.equal(existsSync(pathB), true);
  });

  it("preserves the destination's existing permissions across the replacement (Codex review, 2026-08-24, round 14)", () => {
    // A brand-new temp file gets the process's default umask; renameSync
    // replaces the destination's inode entirely, so without explicitly
    // carrying the ORIGINAL mode over, a file deliberately tightened to
    // 0600 (e.g. local-mcp-config.ts's .mcp.json) would silently widen back
    // to the umask default on every subsequent atomic write.
    const path = join(dir, 'tightened.json');
    writeFileSync(path, '{"old":true}');
    chmodSync(path, 0o600);
    atomicWriteFileSync(path, '{"new":true}');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf-8'), '{"new":true}');
  });

  it('gives a brand-new file the normal default mode, not something artificially restrictive', () => {
    const path = join(dir, 'fresh.json');
    atomicWriteFileSync(path, '{}');
    // No prior file to preserve permissions from -- behaves like any other
    // freshly-created file (subject to the process umask), matching a plain
    // writeFileSync's own create-time behavior.
    const mode = statSync(path).mode & 0o777;
    assert.notEqual(mode, 0, 'sanity check: a real mode was set');
  });

  it('writes THROUGH a symlink instead of destroying it (Codex review, 2026-08-24, round 16)', () => {
    // A dotfiles manager (stow/chezmoi/a hand-made symlink) can legitimately
    // symlink .mcp.json or .claude/settings.local.json elsewhere. renameSync
    // replaces whatever directory entry is at `path` -- symlink or not --
    // so without resolving first, the FIRST atomic write would permanently
    // replace the symlink with a plain file.
    const realFile = join(dir, 'real-target.json');
    const linkPath = join(dir, 'linked.json');
    writeFileSync(realFile, '{"old":true}');
    symlinkSync(realFile, linkPath);

    atomicWriteFileSync(linkPath, '{"new":true}');

    assert.ok(lstatSync(linkPath).isSymbolicLink(), 'the symlink itself must survive the write');
    assert.equal(readFileSync(realFile, 'utf-8'), '{"new":true}', 'the REAL underlying file must receive the new content');
    assert.equal(readFileSync(linkPath, 'utf-8'), '{"new":true}', 'reading through the (still-intact) symlink sees the new content too');
  });

  it('preserves the REAL target’s permissions when writing through a symlink, not the symlink’s own', () => {
    const realFile = join(dir, 'real-tightened.json');
    const linkPath = join(dir, 'linked-tightened.json');
    writeFileSync(realFile, '{"old":true}');
    chmodSync(realFile, 0o600);
    symlinkSync(realFile, linkPath);

    atomicWriteFileSync(linkPath, '{"new":true}');

    assert.equal(statSync(realFile).mode & 0o777, 0o600);
  });

  it('replaces a BROKEN symlink with a plain file, same as before this fix (not a new regression)', () => {
    const missingTarget = join(dir, 'does-not-exist.json');
    const linkPath = join(dir, 'broken-link.json');
    symlinkSync(missingTarget, linkPath);

    atomicWriteFileSync(linkPath, '{"new":true}');

    assert.equal(lstatSync(linkPath).isSymbolicLink(), false, 'a broken symlink target has nowhere to write through');
    assert.equal(readFileSync(linkPath, 'utf-8'), '{"new":true}');
  });
});
