/**
 * Shared by `local-mcp-trust.ts` and `local-mcp-config.ts`: both write
 * per-attach, machine-local state into a project file that MANY real
 * projects intentionally track in Git (`.claude/settings.local.json` and
 * `.mcp.json` respectively — this repo's own root tracks BOTH, confirmed
 * with `git ls-files`/`git cat-file`, not assumed). A spawned coding agent
 * running with YOLO-mode autonomy can `git add -A && commit` at any point
 * while attached, publishing that ephemeral state to every collaborator;
 * `chmod`/cleanup-on-detach only ever touch the WORKING TREE, never a
 * commit already made. Extracted once both writers needed the identical
 * check (Codex review, 2026-08-24, rounds 15 and 16).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { resolveWriteTarget } from './atomic-write.js';

/**
 * True only when `git check-ignore` DEFINITIVELY confirms `path` is NOT
 * ignored inside a real git repo at `cwd` (exit code 1) — i.e. a `git add
 * -A` could actually pick it up. Empirically verified exit codes (not
 * assumed): 0 = ignored (safe), 1 = not ignored (risky), 128 = `cwd` isn't
 * a git repo at all (safe — nothing can ever commit it; also the exact
 * code git reports for a path OUTSIDE the repository entirely, e.g. a
 * symlink resolving somewhere `git add -A` from `cwd` could never reach
 * anyway — verified with a real `git check-ignore` against `/etc/passwd`,
 * not assumed). Any OTHER outcome (git missing, a weird error) is also
 * treated as safe: this function's only job is to catch a CONFIRMED risk,
 * not to require positive proof of safety, matching both callers' existing
 * philosophy that this state is a best-effort enhancement, not something
 * worth hard-failing an attach over.
 *
 * Also checks the REAL, symlink-resolved target, not just `path` itself
 * (Codex review, 2026-08-24, round 21): `atomicWriteFileSync` follows a
 * symlink at `path` and writes through it (round 16), so an ignored
 * SYMLINK pointing at a TRACKED file elsewhere in the same repo would pass
 * the check on `path` alone while every subsequent write actually lands in
 * the tracked target — exactly what this guard exists to prevent, defeated
 * by a resolution neither caller was checking. Verified empirically (not
 * assumed): an ignored symlink to a tracked in-repo file reports
 * `check-ignore` status 0 for the link itself but status 1 for its
 * resolved target. Uses the SAME resolution `atomicWriteFileSync` itself
 * performs, so this check can never diverge from what actually gets
 * written to.
 */
export function riskyToCommit(cwd: string, path: string): boolean {
  if (isConfirmedNotIgnored(cwd, path)) return true;
  const realTarget = resolveWriteTarget(path);
  // `null` (Codex review, 2026-08-24, round 31) means `atomicWriteFileSync`
  // would THROW rather than write anything through this symlink at all —
  // nothing will be created, so there's nothing for a future commit to
  // pick up either.
  if (realTarget === null) return false;
  return realTarget !== path && isConfirmedNotIgnored(cwd, realTarget);
}

function isConfirmedNotIgnored(cwd: string, path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', path], { cwd });
  return result.status === 1;
}

/**
 * Idempotently adds a LOCAL-ONLY exclude pattern — `.git/info/exclude`, the
 * git-native mechanism for machine-specific excludes that are never shared
 * via `.gitignore` — covering an ephemeral sibling this module's callers
 * create next to a destination path (Codex review, 2026-08-24, round 25;
 * generalized to an explicit `pattern` in round 28 — see below).
 *
 * `riskyToCommit` validates the DESTINATION path, but a sibling this code
 * itself creates (`atomicWriteFileSync`'s `<name>.tmp-<pid>-<hex>`, or
 * `acquireConfigLock`'s `<lock>`/`<lock>.claim-*`/`<lock>.reclaim-*`) has a
 * DIFFERENT literal name — an operator's typical EXACT-match `.gitignore`
 * entry for `.mcp.json` (the common, expected shape — verified empirically,
 * round 15) does NOT also cover a suffixed sibling. A crash in the narrow
 * window between creating one of these and either renaming/unlinking it or
 * cleaning it up on the next call would leave an untracked-but-not-ignored
 * copy of live local state sitting in the working tree, ready for a
 * spawned YOLO-mode agent's next `git add -A && commit` to publish — and
 * even OUTSIDE a crash, a concurrently-running agent can `git add -A` at
 * any moment while one of these briefly exists mid-operation.
 *
 * Refusing the write outright whenever a sibling name isn't covered was
 * considered and rejected: an exact-match `.gitignore` pattern NEVER covers
 * a suffixed sibling, so that would break local MCP configuration for
 * every correctly-configured repo, not just a misconfigured one. Making the
 * name actually covered — once, per repo, via the same mechanism
 * `.gitignore` itself uses under the hood — closes the gap without that
 * regression.
 *
 * `pattern` is the LITERAL exclude-file line to add (a plain name, or a
 * `*`-glob — round 28 generalized this from always appending `.tmp-*` onto
 * a passed-in basename, since `acquireConfigLock`'s own siblings don't fit
 * that one fixed shape).
 *
 * Best-effort and silent on any failure (no `.git` dir, a worktree/
 * submodule shape `git rev-parse` can't resolve cleanly, a read-only
 * `.git`): degrades to "only the destination's own git-ignore status is
 * checked," exactly the pre-round-25 behavior — never blocks the write
 * itself over this.
 */
export function ensureTempSiblingExcluded(cwd: string, pattern: string): void {
  try {
    const gitDirResult = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' });
    if (gitDirResult.status !== 0) return;
    const gitDir = gitDirResult.stdout.trim();
    if (!gitDir) return;
    const excludePath = join(isAbsolute(gitDir) ? gitDir : join(cwd, gitDir), 'info', 'exclude');
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : '';
    if (existing.split('\n').some((line) => line.trim() === pattern)) return; // Already present.
    mkdirSync(dirname(excludePath), { recursive: true });
    const withTrailingNewline = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    writeFileSync(excludePath, `${withTrailingNewline}${pattern}\n`);
  } catch {
    // Best-effort — see doc comment above.
  }
}
