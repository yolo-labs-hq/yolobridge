/**
 * The approval list that bounds which paths the ATTACHED AGENT will send files
 * from.
 *
 * ⚠️ READ THIS BEFORE RELYING ON IT: THIS IS NOT A SECURITY BOUNDARY.
 *
 * The attached agent runs as the SAME OS USER as this CLI and normally has
 * shell access. It can therefore run `yolo-bridge allow /` itself, or simply
 * edit `approved-paths.json`. The principal this list constrains can rewrite
 * the list. No amount of care in the containment checks below changes that —
 * they are checks against a mistake, not against an adversary who is already
 * inside the same trust domain. (Found by codex review, gpt-5.6-sol, before
 * this had any consumer; an earlier version of this comment claimed a
 * "structural invariant" and was wrong.)
 *
 * The same reasoning cuts the other way and is why the feature is still worth
 * having: an agent with a PTY can already `curl -T` any readable file to any
 * host. Nothing here can stop a determined or injected agent from exfiltrating,
 * because it never needed our upload path to do it.
 *
 * WHAT THIS ACTUALLY BUYS, stated so nobody over-trusts it:
 *
 *   - It stops ACCIDENTS. An agent casually sending `~/.aws/credentials`
 *     because it seemed relevant is the common case, and this prevents it.
 *   - It keeps the credentialed path deliberate. Sending through OUR upload,
 *     with the operator's workspace credential, requires an explicit act rather
 *     than being the path of least resistance.
 *   - It is an AUDIT SURFACE. Approvals are visible in `yolo-bridge status`, so
 *     a grant that was widened — by the operator or by an agent — is legible
 *     rather than silent.
 *
 * WHAT IT DOES NOT BUY: protection against a cloud-originated prompt injection
 * that instructs the agent to widen the list first. If that threat is the one
 * that matters, the approval has to come from a channel the LOCAL AGENT cannot
 * reach — the operator approving in their own authenticated webapp session
 * would qualify, since an injected local agent cannot click it. That is a
 * different design, deliberately not this one, and it still would not stop
 * `curl`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { configDir, loadAttachment as loadAttachmentDefault, type ConfigStoreIO, defaultIO } from './config-store.js';

/** One approved root, remembered against the workspace it was approved for. */
export interface ApprovedPath {
  /** The path as RESOLVED at approval time (realpath), not as typed. */
  path: string;
  /** As the operator typed it, for display only. */
  raw: string;
  workspaceId: string;
  approvedAt: string;
}

export interface ApprovalFile {
  approvals: ApprovedPath[];
}

function approvalsPath(env: Record<string, string | undefined>): string {
  return path.join(configDir(env), 'approved-paths.json');
}

/** Filesystem facts this module needs, injectable so tests need no real disk. */
export interface PathResolver {
  /** Must follow symlinks. Returns undefined if the path does not exist. */
  realpath(p: string): string | undefined;
  isDirectory(p: string): boolean;
}

export const defaultResolver: PathResolver = {
  realpath(p: string): string | undefined {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  },
  isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * Is `candidate` inside `root`?
 *
 * ⚠️ BOTH SIDES MUST ALREADY BE REALPATHS. This function does no resolution —
 * that is the caller's job — because the containment check is worthless on
 * unresolved input: a symlink sitting inside an approved directory and pointing
 * at `~/.ssh/id_rsa` passes a naive `startsWith` every time.
 *
 * The separator is not decoration either. Without it an approval of
 * `/home/yolo/projA` also covers `/home/yolo/projA-secrets`.
 */
export function isWithinRoot(candidateRealpath: string, rootRealpath: string): boolean {
  if (candidateRealpath === rootRealpath) return true;
  const root = rootRealpath.endsWith(path.sep) ? rootRealpath : rootRealpath + path.sep;
  return candidateRealpath.startsWith(root);
}

export function loadApprovals(
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): ApprovedPath[] {
  const raw = io.readFile(approvalsPath(env));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ApprovalFile;
    if (!Array.isArray(parsed?.approvals)) return [];
    return parsed.approvals.filter(
      (a): a is ApprovedPath =>
        !!a && typeof a.path === 'string' && typeof a.workspaceId === 'string',
    );
  } catch {
    // A corrupt list must not be read as "everything is approved". Empty is the
    // safe reading, and the operator can re-add.
    return [];
  }
}

function saveApprovals(
  approvals: ApprovedPath[],
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): void {
  io.writeFile(approvalsPath(env), `${JSON.stringify({ approvals } satisfies ApprovalFile, null, 2)}\n`);
}

export type ApproveResult =
  | { ok: true; approved: ApprovedPath; alreadyPresent: boolean }
  | { ok: false; message: string };

/**
 * Approve a path for one workspace.
 *
 * Resolved and existence-checked HERE rather than at send time, so the operator
 * finds out about a typo now instead of when a send mysteriously fails.
 */
export function approvePath(
  rawPath: string,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
  resolver: PathResolver = defaultResolver,
  now: () => Date = () => new Date(),
): ApproveResult {
  const resolved = resolver.realpath(path.resolve(rawPath));
  if (!resolved) {
    return { ok: false, message: `No such path: ${rawPath}` };
  }

  const existing = loadApprovals(env, io);
  if (existing.some((a) => a.workspaceId === workspaceId && a.path === resolved)) {
    return {
      ok: true,
      alreadyPresent: true,
      approved: existing.find((a) => a.workspaceId === workspaceId && a.path === resolved)!,
    };
  }

  const approved: ApprovedPath = {
    path: resolved,
    raw: rawPath,
    workspaceId,
    approvedAt: now().toISOString(),
  };
  saveApprovals([...existing, approved], env, io);
  return { ok: true, approved, alreadyPresent: false };
}

/** Remove one approval. Matches on the RESOLVED path, so removing by the same
 *  spelling the operator approved with works even through a symlink. */
export function revokePath(
  rawPath: string,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
  resolver: PathResolver = defaultResolver,
): { removed: number } {
  // Match on the RESOLVED path only. Matching the stored `raw` spelling as well
  // looked convenient and was data loss: approving `output` from two different
  // working directories stores two distinct resolved paths with the SAME raw
  // spelling, so revoking either removed both. (codex P2, gpt-5.6-sol.)
  //
  // Two candidates, because an approved directory may since have been deleted —
  // realpath then fails, and the operator must still be able to revoke the
  // dangling grant by its absolute path.
  const absolute = path.resolve(rawPath);
  const resolved = resolver.realpath(absolute);
  const before = loadApprovals(env, io);
  const after = before.filter((a) => {
    if (a.workspaceId !== workspaceId) return true;
    return !(a.path === absolute || (resolved !== undefined && a.path === resolved));
  });
  if (after.length !== before.length) saveApprovals(after, env, io);
  return { removed: before.length - after.length };
}

export function listApprovals(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
): ApprovedPath[] {
  return loadApprovals(env, io).filter((a) => a.workspaceId === workspaceId);
}

export interface ApprovalCheck {
  approved: boolean;
  /**
   * The CANONICAL path the caller must open.
   *
   * ⚠️ CONSUMERS MUST READ THIS, NOT THE PATH THEY PASSED IN. Checking one path
   * and then opening another is how symlink containment is defeated: an agent
   * can repoint an in-tree link between the check and the read, so a name that
   * resolved inside an approved root at check time resolves to `~/.ssh/id_rsa`
   * at open time. Opening the already-resolved target removes that window.
   *
   * This narrows the race rather than abolishing it — the file at this path can
   * still be swapped before the read — but it removes the link-swap vector the
   * containment check exists to stop. (codex P2, gpt-5.6-sol.)
   */
  resolvedPath?: string;
  /** The root that authorised it, for a message the agent can relay. */
  root?: string;
  reason?: string;
}

/**
 * May the AGENT send this path?
 *
 * A check against a MISTAKE, not against an adversary — see the module header.
 * The agent can rewrite the list this consults.
 *
 * `implicitRoots` is the daemon's own working directory: the project the agent
 * is already operating in, whose files it can read anyway. Everything else
 * needs an explicit `yolo-bridge allow`.
 *
 * Fails closed on anything it cannot resolve — a path that does not exist, or a
 * broken symlink, is not approved.
 */
export function checkPathApproved(
  rawPath: string,
  workspaceId: string,
  implicitRoots: string[] = [],
  env: Record<string, string | undefined> = process.env,
  io: ConfigStoreIO = defaultIO,
  resolver: PathResolver = defaultResolver,
): ApprovalCheck {
  const resolved = resolver.realpath(path.resolve(rawPath));
  if (!resolved) return { approved: false, reason: `No such file: ${rawPath}` };

  // Implicit roots are resolved too — the working directory can itself be
  // reached through a symlink.
  const roots: string[] = [];
  for (const r of implicitRoots) {
    const rr = resolver.realpath(path.resolve(r));
    if (rr) roots.push(rr);
  }
  for (const a of loadApprovals(env, io)) {
    if (a.workspaceId === workspaceId) roots.push(a.path);
  }

  for (const root of roots) {
    if (isWithinRoot(resolved, root)) return { approved: true, root, resolvedPath: resolved };
  }

  return {
    approved: false,
    reason:
      `${path.basename(resolved)} is outside every approved path for this workspace. `
      + 'Approve it from your own shell with `yolo-bridge allow <path>`.',
  };
}


/**
 * POSIX single-quoting for a path we print back as a COPYABLE command.
 *
 * Media directories routinely contain spaces (`~/My Footage/`), which alone
 * makes an unquoted suggestion wrong. The sharper reason is that a path is
 * attacker-influenceable in a way the operator would not expect — an agent can
 * create a directory — and an unquoted `;` in a line the operator copies runs.
 * Single quotes are literal in POSIX shells; the `'\''` dance closes, escapes
 * one quote, and reopens. (codex P2, gpt-5.6-sol.)
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ─── CLI surface ─────────────────────────────────────────────────────────────

export interface AllowDeps {
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  resolver?: PathResolver;
  /** Injectable so a test does not depend on the machine's real attachment. */
  loadAttachmentImpl?: (
    env?: Record<string, string | undefined>,
    io?: ConfigStoreIO,
  ) => { workspaceId: string } | undefined;
}

export type AllowResult =
  | { ok: true; lines: string[] }
  | { ok: false; reason: 'not-attached' | 'error'; message: string };

/**
 * `yolo-bridge allow` — add, list or remove an approved path.
 *
 * Requires an attachment, because an approval is scoped to ONE workspace. A
 * machine that attaches to several workspaces should not have a grant made for
 * one silently apply to the others.
 */
export function runAllow(args: string[], deps: AllowDeps = {}): AllowResult {
  const { env, io, resolver } = deps;
  const loadAttachmentFn = deps.loadAttachmentImpl
    ?? ((e?: Record<string, string | undefined>, i?: ConfigStoreIO) => loadAttachmentDefault(e, i));

  const attachment = loadAttachmentFn(env, io);
  if (!attachment) {
    return {
      ok: false,
      reason: 'not-attached',
      message: 'No active attachment — run `yolo-bridge attach` first. Approvals are scoped to one workspace.',
    };
  }
  const workspaceId = attachment.workspaceId;

  if (args.includes('--list') || args.length === 0) {
    const approvals = listApprovals(workspaceId, env, io);
    if (!approvals.length) {
      return {
        ok: true,
        lines: [
          'No approved paths for this workspace.',
          '',
          'The attached agent can send files from the daemon\'s working directory.',
          'To let it send from anywhere else:  yolo-bridge allow <path>',
        ],
      };
    }
    return {
      ok: true,
      lines: [
        `Approved paths (${approvals.length}) — the attached agent may send files from these:`,
        ...approvals.map((a) => `  ${a.path}${a.raw !== a.path ? `   (added as ${a.raw})` : ''}`),
      ],
    };
  }

  const removeIdx = args.indexOf('--remove');
  if (removeIdx !== -1) {
    const target = args[removeIdx + 1];
    if (!target) return { ok: false, reason: 'error', message: '`--remove` needs a path.' };
    const { removed } = revokePath(target, workspaceId, env, io, resolver);
    return removed
      ? { ok: true, lines: [`Removed ${removed} approval(s) for ${target}.`] }
      : { ok: false, reason: 'error', message: `${target} was not an approved path for this workspace.` };
  }

  const target = args.find((a) => !a.startsWith('-'));
  if (!target) return { ok: false, reason: 'error', message: 'A path is required.' };

  const result = approvePath(target, workspaceId, env, io, resolver);
  if (!result.ok) return { ok: false, reason: 'error', message: result.message };
  if (result.alreadyPresent) {
    return { ok: true, lines: [`Already approved: ${result.approved.path}`] };
  }
  return {
    ok: true,
    lines: [
      `Approved: ${result.approved.path}`,
      'The attached agent may now send files from here. Remove it with:',
      // The RESOLVED path, not what was typed: a relative spelling is ambiguous
      // across working directories, and pasting it later could revoke a
      // different grant than the one just made.
      `  yolo-bridge allow --remove ${shellQuote(result.approved.path)}`,
    ],
  };
}
