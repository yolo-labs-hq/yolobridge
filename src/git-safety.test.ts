import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { riskyToCommit } from './git-safety.js';

/** Real `git init` in `dir` -- see local-mcp-trust.test.ts's identical
 *  helper for why this must be the real thing, not a mock: `git
 *  check-ignore`'s exact exit-code semantics are what this module's
 *  correctness rests on, and a hand-rolled mock could silently drift from
 *  what real git actually does. */
function initGitRepo(): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

let dir: string;
let xdgConfigDir: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-git-safety-test-'));
  // Isolates `git check-ignore` from THIS machine's own global excludes --
  // see local-mcp-trust.test.ts's identical setup for the empirically-found
  // reason (a real dev machine commonly gitignores dotfiles globally, which
  // would make a "not ignored" test here pass for the wrong reason).
  xdgConfigDir = mkdtempSync(join(tmpdir(), 'yolo-bridge-xdg-config-test-'));
  process.env.XDG_CONFIG_HOME = xdgConfigDir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(xdgConfigDir, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

describe('riskyToCommit', () => {
  it('returns true for a plain, git-tracked (not ignored) path inside a real repo', () => {
    initGitRepo();
    const path = join(dir, 'tracked.json');
    writeFileSync(path, '{}');
    assert.equal(riskyToCommit(dir, path), true);
  });

  it('returns false for a plain path confirmed git-ignored inside a real repo', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), 'ignored.json\n');
    const path = join(dir, 'ignored.json');
    writeFileSync(path, '{}');
    assert.equal(riskyToCommit(dir, path), false);
  });

  it('returns false outside a git repo entirely (nothing can ever commit it)', () => {
    const path = join(dir, 'whatever.json');
    assert.equal(riskyToCommit(dir, path), false);
  });

  it('returns true when an IGNORED symlink resolves to a TRACKED file elsewhere in the same repo (Codex review, 2026-08-24, round 21)', () => {
    // The exact gap Codex found: `atomicWriteFileSync` follows a symlink at
    // `path` and writes through it (round 16), so checking only the
    // symlink's OWN ignore status lets an ephemeral write land in a TRACKED
    // file the moment the symlink itself happens to be ignored -- a
    // spawned YOLO-mode agent's next `git add -A && commit` would then
    // publish it, defeating this whole guard. Verified empirically (see
    // git-safety.ts's own updated doc comment) before writing this test:
    // the symlink path alone reports git-ignored status 0, while its
    // resolved, TRACKED target reports status 1.
    initGitRepo();
    mkdirSync(join(dir, 'shared'));
    const realTarget = join(dir, 'shared', 'real.json');
    writeFileSync(realTarget, '{"tracked":true}');
    spawnSync('git', ['add', 'shared/real.json'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(realTarget, linkPath);

    assert.equal(riskyToCommit(dir, linkPath), true, 'the TRACKED real target must make this risky, even though the symlink itself is ignored');
  });

  it('returns false when an ignored symlink resolves to a target that is ALSO ignored', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\nreal-target.json\n');
    const realTarget = join(dir, 'real-target.json');
    writeFileSync(realTarget, '{}');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(realTarget, linkPath);

    assert.equal(riskyToCommit(dir, linkPath), false);
  });

  it('returns false for a BROKEN symlink at an ignored path (nothing exists to resolve to)', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(join(dir, 'does-not-exist.json'), linkPath);

    assert.equal(riskyToCommit(dir, linkPath), false);
  });
});
