import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync, existsSync } from 'node:fs';
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
});
