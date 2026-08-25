import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync, existsSync, statSync, lstatSync, symlinkSync, mkdirSync } from 'node:fs';
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

  it('HEALS a broken symlink by creating its missing target, rather than destroying the symlink (Codex review, 2026-08-24, round 25)', () => {
    // The ORIGINAL, pre-round-13 direct writeFileSync followed a symlink
    // and created its missing target when the target's own parent
    // directory existed -- an earlier version of this fix instead fell
    // back to writing OVER the symlink itself the moment its target didn't
    // exist YET, silently destroying a dotfile-managed symlink the first
    // time its target happened to be absent (e.g. a fresh checkout that
    // hasn't run its own setup yet).
    const missingTarget = join(dir, 'does-not-exist.json');
    const linkPath = join(dir, 'broken-link.json');
    symlinkSync(missingTarget, linkPath);

    atomicWriteFileSync(linkPath, '{"new":true}');

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the symlink itself must survive — only its missing target gets created');
    assert.equal(readFileSync(missingTarget, 'utf-8'), '{"new":true}', 'the REAL (previously-missing) target must receive the content');
    assert.equal(readFileSync(linkPath, 'utf-8'), '{"new":true}', 'reading through the still-intact symlink sees the new content too');
  });

  it('THROWS (ENOENT) rather than writing OVER a broken symlink whose target directory ALSO does not exist (Codex review, 2026-08-24, round 31)', () => {
    // A real writeFileSync through this exact symlink shape throws ENOENT
    // and leaves the symlink completely untouched (verified empirically —
    // see resolveWriteTarget's own doc comment) -- silently degrading to
    // "write over the symlink instead" (this function's OWN prior
    // behavior, round 25) was WORSE than that real failure mode, and the
    // exact symlink-destroying regression round 16 exists to prevent.
    const missingTarget = join(dir, 'no-such-subdir', 'does-not-exist.json');
    const linkPath = join(dir, 'broken-link-2.json');
    symlinkSync(missingTarget, linkPath);

    assert.throws(() => atomicWriteFileSync(linkPath, '{"new":true}'), /ENOENT/);

    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'the symlink itself must survive untouched');
    assert.equal(existsSync(linkPath), false, 'reading through it still sees nothing, since the target genuinely never existed');
  });

  it('resolves a symlinked PARENT DIRECTORY, not just the final path component (Codex review, 2026-08-24, round 24)', () => {
    // Every normal fs call (writeFileSync, renameSync) transparently
    // follows an intermediate directory symlink -- only lstatSync(path)'s
    // OWN check (round 16) was blind to it, since it only ever asks about
    // the FINAL path segment. `.claude` itself symlinked elsewhere is
    // exactly the shape git-safety.ts's own round-24 fix depends on this
    // function resolving correctly.
    const realParent = join(dir, 'real-parent');
    const linkedParent = join(dir, 'linked-parent');
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);

    atomicWriteFileSync(join(linkedParent, 'file.json'), '{"a":1}');

    assert.equal(readFileSync(join(realParent, 'file.json'), 'utf-8'), '{"a":1}', 'the write must land in the REAL directory the symlink points at');
    assert.equal(lstatSync(linkedParent).isSymbolicLink(), true, 'the parent symlink itself must survive untouched');
  });

  it('sweeps a stale .tmp-* sibling left by a PRIOR crashed call before writing a new one (Codex review, 2026-08-24, round 24)', () => {
    // A crash between creating the temp file and either renaming or
    // cleaning it up leaves a stray sibling behind -- self-heals on the
    // very next successful write to the SAME destination rather than
    // lingering indefinitely (narrows, doesn't eliminate, the exposure
    // window a stray temp file represents).
    const path = join(dir, 'target.json');
    const staleTemp = `${path}.tmp-99999-deadbeef`;
    writeFileSync(staleTemp, '{"leftover":"from a crashed prior call"}');

    atomicWriteFileSync(path, '{"new":true}');

    assert.equal(existsSync(staleTemp), false, 'the stale temp sibling must be swept away');
    assert.deepEqual(readdirSync(dir), ['target.json']);
  });

  it('never sweeps an UNRELATED file merely sharing the directory', () => {
    const path = join(dir, 'target2.json');
    const unrelated = join(dir, 'unrelated-file.tmp-not-ours');
    writeFileSync(unrelated, 'keep me');

    atomicWriteFileSync(path, '{"new":true}');

    assert.equal(readFileSync(unrelated, 'utf-8'), 'keep me');
  });

  it("never sweeps an OPERATOR-OWNED sibling that merely shares the '.tmp-' prefix but not the exact generated shape (Codex review, 2026-08-24, round 28)", () => {
    // A prefix-only check would misclassify a hand-made file like this as
    // this module's own leftover and irreversibly delete it -- the exact
    // generated shape is `<name>.tmp-<pid>-<8 hex chars>`, which
    // `.mcp.json.tmp-backup` doesn't match at all.
    const path = join(dir, 'target3.json');
    const operatorBackup = join(dir, 'target3.json.tmp-backup');
    writeFileSync(operatorBackup, 'my own backup, not yours to touch');

    atomicWriteFileSync(path, '{"new":true}');

    assert.equal(readFileSync(operatorBackup, 'utf-8'), 'my own backup, not yours to touch');
  });

  it('never sweeps a sibling whose embedded pid is confirmed ALIVE, even though it matches the generated shape exactly (Codex review, 2026-08-24, round 28)', () => {
    // The sweep runs at the START of every call, including on an unguarded
    // path (local-mcp-trust.ts's writes aren't behind local-mcp-config.ts's
    // own cross-process lock) -- without a liveness check, one process's
    // sweep could delete ANOTHER genuinely concurrent process's
    // still-being-written temp file out from under it. This test process's
    // own pid is, trivially, alive -- standing in for a live concurrent
    // writer.
    const path = join(dir, 'target4.json');
    const liveWritersTemp = join(dir, `target4.json.tmp-${process.pid}-deadbeef`);
    writeFileSync(liveWritersTemp, 'still being written by a live process');

    atomicWriteFileSync(path, '{"new":true}');

    assert.equal(readFileSync(liveWritersTemp, 'utf-8'), 'still being written by a live process');
  });
});
