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
 */
import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function atomicWriteFileSync(path: string, content: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, path);
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
