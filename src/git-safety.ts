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

/**
 * True only when `git check-ignore` DEFINITIVELY confirms `path` is NOT
 * ignored inside a real git repo at `cwd` (exit code 1) — i.e. a `git add
 * -A` could actually pick it up. Empirically verified exit codes (not
 * assumed): 0 = ignored (safe), 1 = not ignored (risky), 128 = `cwd` isn't
 * a git repo at all (safe — nothing can ever commit it). Any OTHER outcome
 * (git missing, a weird error) is also treated as safe: this function's
 * only job is to catch a CONFIRMED risk, not to require positive proof of
 * safety, matching both callers' existing philosophy that this state is a
 * best-effort enhancement, not something worth hard-failing an attach over.
 */
export function riskyToCommit(cwd: string, path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', path], { cwd });
  return result.status === 1;
}
