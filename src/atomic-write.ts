/**
 * Writes `content` to `path` via a temp sibling file + atomic rename (Codex
 * review, 2026-08-24, round 13): a direct `writeFileSync` on an EXISTING
 * file truncates it before writing the new bytes, so a process crash,
 * ENOSPC, or any other failure mid-write can leave the file half-written or
 * empty — there is no way to recover the operator's original content from
 * that state, unlike every OTHER failure `local-mcp-config.ts` and
 * `local-mcp-trust.ts` already guard against (which all leave the ORIGINAL
 * file untouched on failure — see e.g. `readConfig`'s malformed-JSON
 * handling). `renameSync` within the same directory is atomic on POSIX
 * filesystems (a single inode-table update, no partial-rename state
 * observable by another process), so a reader always sees either the
 * complete old file or the complete new one, never a partial write.
 *
 * The temp name includes the PID and a random suffix so two attach
 * processes writing into the SAME project directory concurrently (a
 * scenario this codebase already guards against elsewhere — concurrent
 * sibling attach) never collide on the same temp path.
 *
 * Preserves the DESTINATION's existing permissions across the replacement
 * (Codex review, 2026-08-24, round 14): a brand-new temp file is created
 * with the process's default umask, and `renameSync` replaces the
 * destination's inode entirely — it does not carry over the ORIGINAL
 * file's mode. Without this, overwriting an EXISTING file that had been
 * deliberately tightened (`.mcp.json`'s 0600 from round 11) would silently
 * widen it back to whatever the umask gives (commonly 0644/0664) on every
 * subsequent write, quietly undoing that fix through this one. When `path`
 * doesn't exist yet, there is no permission to preserve — the new file
 * gets the process's normal default, same as any other file creation (a
 * caller that wants a specific mode on first create, like `.mcp.json`'s
 * 0600, chmods explicitly afterward, same as before this change).
 *
 * Writes THROUGH a symlink at `path` instead of over it (Codex review,
 * 2026-08-24, round 16): `renameSync` replaces whatever directory entry is
 * AT `path`, symlink or not — a caller with `.mcp.json` symlinked in from a
 * dotfiles manager (`stow`/`chezmoi`/a hand-made symlink) would have that
 * symlink permanently destroyed and replaced with a plain file on the
 * FIRST write, with no way back. Resolving to the real target first and
 * writing/renaming there instead leaves the symlink itself untouched,
 * still pointing at the same place. A broken symlink (target doesn't
 * exist) falls back to writing at `path` directly — the same "create a
 * plain file there" behavior this function already had before this fix,
 * not a new regression.
 */
import { writeFileSync, renameSync, unlinkSync, existsSync, statSync, chmodSync, lstatSync, realpathSync, readdirSync, readlinkSync } from 'node:fs';
import { dirname, basename, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Exported for `git-safety.ts` (Codex review, 2026-08-24, round 21): the
 *  git-ignore check must validate the SAME real target this function is
 *  about to write through, not just the (possibly symlinked) path the
 *  caller named — see that module's doc comment for the exact gap this
 *  closes.
 *
 *  Resolves a symlinked PARENT DIRECTORY too, not just `path`'s own final
 *  component (Codex review, 2026-08-24, round 24): `lstatSync(path)` only
 *  reports whether the FINAL path segment is a symlink — an intermediate
 *  ancestor directory (e.g. `.claude` itself symlinked elsewhere) is
 *  transparently followed by every normal fs call (`writeFileSync`,
 *  `renameSync`, ...) but was invisible to this function, which returned
 *  the untouched LEXICAL path. `git check-ignore` on that lexical path then
 *  fails with "is beyond a symbolic link" (status 128, the same code this
 *  module already treats as a safe degrade for "outside the repository
 *  entirely") — reporting safe while the actual write still traverses the
 *  symlink and can land in a TRACKED file the git-ignore check never
 *  actually validated. `realpathSync` on the PARENT resolves the whole
 *  ancestor chain in one call; the file's own possible symlink-ness (round
 *  16) is still resolved separately afterward, starting from that already-
 *  parent-resolved path. A parent that doesn't exist yet (nothing has been
 *  written here before) has no symlink layer to resolve either — falls
 *  back to the lexical path, same as before this fix, not a regression. */
export function resolveWriteTarget(path: string): string {
  let realDir: string;
  try {
    realDir = realpathSync(dirname(path));
  } catch {
    realDir = dirname(path); // Parent doesn't exist yet — nothing to resolve.
  }
  const parentResolvedPath = join(realDir, basename(path));
  try {
    if (!lstatSync(parentResolvedPath).isSymbolicLink()) return parentResolvedPath;
  } catch {
    return parentResolvedPath; // Doesn't exist yet — nothing further to resolve.
  }
  try {
    return realpathSync(parentResolvedPath);
  } catch {
    // Broken symlink (its target doesn't exist YET) — resolve the link
    // LEXICALLY via `readlinkSync` instead of giving up and writing over
    // the symlink itself (Codex review, 2026-08-24, round 25): the
    // ORIGINAL, pre-round-13 direct `writeFileSync` followed a symlink and
    // CREATED its missing target when the target's own parent directory
    // existed — falling back to `parentResolvedPath` here instead means
    // the subsequent `renameSync` REPLACES the symlink itself with a plain
    // file, destroying it — the exact regression round 16 exists to
    // prevent, just for this one sub-case (a target that's merely ABSENT,
    // not a symlink pointing nowhere sensible at all). A relative link
    // target is resolved against the symlink's OWN directory, matching
    // `readlink`'s documented semantics.
    try {
      const linkTarget = readlinkSync(parentResolvedPath);
      const healedTarget = isAbsolute(linkTarget) ? linkTarget : join(dirname(parentResolvedPath), linkTarget);
      // Only "heal" it if the intended target's OWN parent directory
      // exists — the same constraint a plain `writeFileSync` would have
      // been bound by too (it can't create a file in a directory that
      // doesn't exist either). Otherwise fall through to the same
      // write-over-the-symlink degrade as any other unresolvable case.
      if (existsSync(dirname(healedTarget))) return healedTarget;
    } catch {
      // `readlinkSync` failing means `parentResolvedPath` isn't actually a
      // symlink after all (raced since the `lstatSync` check above) — fall
      // through to the same degrade.
    }
    return parentResolvedPath;
  }
}

/**
 * Deletes the file DATA at `path` without ever deleting a symlink the
 * operator placed there (Codex review, 2026-08-24, round 26): a full
 * cleanup delete (`createdFile && now empty`, in both `local-mcp-config.ts`
 * and `local-mcp-trust.ts`) previously always `unlinkSync(path)`'d the
 * LEXICAL path. For a broken symlink `atomicWriteFileSync` healed (round
 * 25), that path IS the symlink itself — `createdFile` was computed from
 * `!existsSync(path)`, which is true for exactly this case since the
 * broken symlink's target didn't exist yet — so this would delete the
 * operator's OWN symlink and leave the newly-created (now orphaned) target
 * behind, destroying something this module never owned: the exact
 * regression round 25 exists to prevent, just on the CLEANUP side instead
 * of the write side. Resolves through the SAME symlink-following logic
 * `atomicWriteFileSync` itself uses before deleting, so cleanup can never
 * diverge from what the write actually touched. A plain, non-symlink path
 * (the common case) is unaffected — this degrades to a bare `unlinkSync`.
 */
export function unlinkWriteTarget(path: string): void {
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = resolveWriteTarget(path);
  } catch {
    // Race: `path` vanished before this lstat — fall through to the
    // original `path` (unlinkSync then simply no-ops/throws ENOENT, same
    // as before this fix).
  }
  unlinkSync(target);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mirrors `local-mcp-config.ts`'s own `isPidAlive` (kept as an independent
 *  copy — see that module's own doc comment on why these stay separately
 *  usable/testable): `process.kill(pid, 0)` sends no actual signal, just
 *  probes. ESRCH = no such process (dead); EPERM = exists but no
 *  permission to signal (still alive); anything else fails closed as
 *  "alive," since this function's only job is to catch a CONFIRMED-dead
 *  writer, never to guess one into existence. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort removal of a temp sibling THIS function itself could have
 * left behind from a PRIOR call that crashed between creating it and
 * either renaming or cleaning it up (Codex review, 2026-08-24, round 24) —
 * see the temp-file-permissions doc comment on `atomicWriteFileSync` for
 * the exposure this narrows.
 *
 * Matches the EXACT generated shape (`<name>.tmp-<pid>-<8 hex chars>`), not
 * a bare prefix (Codex review, 2026-08-24, round 28): a prefix-only check
 * would misclassify an OPERATOR-OWNED sibling that merely happens to start
 * the same way (e.g. a hand-made `.mcp.json.tmp-backup`) as this module's
 * own leftover and irreversibly delete it.
 *
 * Also extracts the embedded pid from a shape-matching name and skips it
 * when that pid is still ALIVE (round 28): this same sweep runs at the
 * start of every `atomicWriteFileSync` call, including one from a
 * GENUINELY CONCURRENT writer to the same destination on an unguarded path
 * (`local-mcp-trust.ts`'s writes aren't behind `local-mcp-config.ts`'s own
 * cross-process lock) — without this, one process's sweep could delete
 * ANOTHER process's still-being-written temp file out from under it.
 */
function sweepStaleTempSiblings(targetPath: string): void {
  const dir = dirname(targetPath);
  const pattern = new RegExp(`^${escapeRegExp(basename(targetPath))}\\.tmp-(\\d+)-[0-9a-f]{8}$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Directory doesn't exist (nothing written here yet) — nothing to sweep.
  }
  for (const name of entries) {
    const match = pattern.exec(name);
    if (!match) continue;
    const writerPid = Number(match[1]);
    if (Number.isInteger(writerPid) && writerPid >= 1 && isPidAlive(writerPid)) continue; // Still being written by a live process — never touch it.
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Best-effort — a leftover temp file is only ever a tighter-than-this-
      // call's-own risk window, never a correctness problem for THIS write.
    }
  }
}

export function atomicWriteFileSync(path: string, content: string): void {
  const targetPath = resolveWriteTarget(path);
  // Clears out anything a PRIOR crashed call left behind before adding a
  // new one — see `sweepStaleTempSiblings`'s own doc comment.
  sweepStaleTempSiblings(targetPath);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    // Owner-only from the moment of CREATION (Codex review, 2026-08-24,
    // round 24), not after a separate chmod below: `writeFileSync`'s
    // default mode (subject to the process umask, commonly 0644/0664) would
    // otherwise leave a window — between this call returning and the
    // `chmodSync` a few lines down — where a crash or SIGKILL leaves a
    // WORLD-READABLE copy of the full new content (which, for an EXISTING
    // destination being overwritten, is the operator's complete file, not
    // just this module's own fragment) sitting on disk under a temp name
    // `riskyToCommit` never validated on its own.
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    let existingMode: number | undefined;
    try {
      existingMode = statSync(targetPath).mode & 0o777;
    } catch {
      // `targetPath` doesn't exist yet — nothing to preserve.
    }
    if (existingMode !== undefined) {
      chmodSync(tmpPath, existingMode);
    } else {
      // No prior file to preserve permissions from — widen back to the
      // process's NORMAL default (umask-derived) mode right before the
      // rename, matching a plain `writeFileSync` with no explicit mode
      // (same behavior this module already guaranteed pre-round-24 — see
      // the "brand-new file" test below). The 0600 above only needs to
      // hold DURING the write itself to close the crash-exposure window;
      // a caller that never asked for owner-only on a brand-new file (e.g.
      // `local-mcp-trust.ts`'s `settings.local.json`, which has no explicit
      // chmod of its own) must not have that silently imposed on it as a
      // side effect of this fix.
      chmodSync(tmpPath, 0o666 & ~process.umask());
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort: don't leave a stray temp file behind on failure.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort.
      }
    }
    throw err;
  }
}
