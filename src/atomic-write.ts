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
import { writeFileSync, renameSync, unlinkSync, existsSync, statSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function resolveWriteTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path;
  } catch {
    return path; // Doesn't exist yet — nothing to resolve.
  }
  try {
    return realpathSync(path);
  } catch {
    return path; // Broken symlink — write a plain file at `path` itself.
  }
}

export function atomicWriteFileSync(path: string, content: string): void {
  const targetPath = resolveWriteTarget(path);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    let existingMode: number | undefined;
    try {
      existingMode = statSync(targetPath).mode & 0o777;
    } catch {
      // `targetPath` doesn't exist yet — nothing to preserve.
    }
    if (existingMode !== undefined) chmodSync(tmpPath, existingMode);
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
