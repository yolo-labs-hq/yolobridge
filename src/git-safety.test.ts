import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { riskyToCommit, ensureTempSiblingExcluded } from './git-safety.js';

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

  it('returns TRUE for a BROKEN symlink whose (healed) target is NOT itself ignored, even though the symlink path is (Codex review, 2026-08-24, round 25)', () => {
    // `resolveWriteTarget` now HEALS a broken symlink by resolving to its
    // (currently-missing) target lexically, rather than writing over the
    // symlink itself -- so the write's REAL destination is that target
    // path, and this check must follow it there, exactly like it already
    // does for a broken-but-resolvable symlink elsewhere in this file.
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(join(dir, 'does-not-exist.json'), linkPath);

    assert.equal(riskyToCommit(dir, linkPath), true, "the healed target isn't covered by the .gitignore entry naming only the symlink");
  });

  it('returns false for a BROKEN symlink whose healed target is ALSO ignored', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\ndoes-not-exist.json\n');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(join(dir, 'does-not-exist.json'), linkPath);

    assert.equal(riskyToCommit(dir, linkPath), false);
  });

  it('falls back to the symlink’s own path when a broken symlink’s target directory does not exist either (nothing to heal into)', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const linkPath = join(dir, '.mcp.json');
    symlinkSync(join(dir, 'no-such-subdir', 'does-not-exist.json'), linkPath);

    assert.equal(riskyToCommit(dir, linkPath), false, 'nothing to heal into, so this degrades to checking the symlink path itself, which IS ignored');
  });

  it('returns true when the PARENT DIRECTORY (not the final path itself) is a symlink resolving into a TRACKED location (Codex review, 2026-08-24, round 24)', () => {
    // Every normal fs call transparently follows an intermediate directory
    // symlink -- only the FINAL path segment's own symlink-ness (round 21)
    // was being resolved. `.claude` itself symlinked elsewhere is exactly
    // this shape: the file at the end of the path is a perfectly ordinary,
    // non-symlink file, but the directory it lives in is a symlink into a
    // TRACKED location `git check-ignore` on the lexical `.claude/...` path
    // alone would report as "beyond a symbolic link" (status 128, a safe
    // degrade for a genuinely out-of-repo target) even though the write
    // actually lands somewhere fully tracked.
    initGitRepo();
    mkdirSync(join(dir, 'real-claude'));
    const realTarget = join(dir, 'real-claude', 'settings.local.json');
    writeFileSync(realTarget, '{"tracked":true}');
    spawnSync('git', ['add', 'real-claude/settings.local.json'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    symlinkSync(join(dir, 'real-claude'), join(dir, '.claude'));

    const path = join(dir, '.claude', 'settings.local.json');
    assert.equal(riskyToCommit(dir, path), true, 'the TRACKED real target must make this risky even though the final path segment is not itself a symlink');
  });
});

describe('ensureTempSiblingExcluded', () => {
  it('makes an atomic-write temp sibling actually git-ignored, even though the destination’s own EXACT-match .gitignore entry does not cover it (Codex review, 2026-08-24, round 25)', () => {
    // `.gitignore .mcp.json` (a bare, non-wildcard pattern -- the common,
    // expected shape) matches ONLY that exact basename, never a suffixed
    // sibling like `.mcp.json.tmp-1234-abcd` -- confirmed empirically here,
    // not assumed, before and after calling the function under test.
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const tempSibling = join(dir, '.mcp.json.tmp-12345-deadbeef');
    writeFileSync(tempSibling, '{}');
    assert.equal(riskyToCommit(dir, tempSibling), true, 'sanity check: the temp sibling name is NOT covered before the fix runs');

    ensureTempSiblingExcluded(dir, dir, '.mcp.json.tmp-*');

    assert.equal(riskyToCommit(dir, tempSibling), false, 'the temp sibling must now be confirmed git-ignored');
  });

  it('is idempotent — calling it twice does not duplicate the exclude line', () => {
    initGitRepo();
    ensureTempSiblingExcluded(dir, dir, '.mcp.json.tmp-*');
    ensureTempSiblingExcluded(dir, dir, '.mcp.json.tmp-*');
    const excludeContent = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    const occurrences = excludeContent.split('\n').filter((line) => line.trim() === '/.mcp.json.tmp-*').length;
    assert.equal(occurrences, 1);
  });

  it('preserves any pre-existing content in .git/info/exclude', () => {
    initGitRepo();
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '# operator-authored line\nsome-other-pattern\n');

    ensureTempSiblingExcluded(dir, dir, '.mcp.json.tmp-*');

    const excludeContent = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(excludeContent.includes('# operator-authored line'));
    assert.ok(excludeContent.includes('some-other-pattern'));
    assert.ok(excludeContent.includes('/.mcp.json.tmp-*'));
  });

  it('is a silent no-op outside a git repo entirely', () => {
    assert.doesNotThrow(() => ensureTempSiblingExcluded(dir, dir, '.mcp.json.tmp-*'));
  });

  it('anchors the pattern to destDir — does not hide a same-shaped file in an unrelated sibling directory (Codex review, 2026-08-25, round 32)', () => {
    initGitRepo();
    mkdirSync(join(dir, 'packages', 'other-package'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const unrelatedTempFile = join(dir, 'packages', 'other-package', '.mcp.json.tmp-backup');
    writeFileSync(unrelatedTempFile, '{}');
    assert.equal(riskyToCommit(dir, unrelatedTempFile), true, 'sanity check: the unrelated file is not covered before the call');

    const ownedDir = join(dir, 'packages', 'my-package');
    mkdirSync(ownedDir, { recursive: true });
    ensureTempSiblingExcluded(dir, ownedDir, '.mcp.json.tmp-*');

    assert.equal(riskyToCommit(dir, unrelatedTempFile), true, 'a same-shaped file in a DIFFERENT directory must stay uncovered — a repo-wide bare-basename pattern would wrongly hide it');

    const excludeContent = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8');
    assert.ok(excludeContent.includes('/packages/my-package/.mcp.json.tmp-*'), 'the written pattern must be anchored to the owning directory, not a bare basename');
  });
});
