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
  return realTarget !== path && isConfirmedNotIgnored(cwd, realTarget);
}

function isConfirmedNotIgnored(cwd: string, path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', path], { cwd });
  return result.status === 1;
}
