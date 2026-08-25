/**
 * Pre-trusts the `yolo-studio` MCP server `local-mcp-config.ts` writes into
 * `.mcp.json`, by writing a companion project-scoped
 * `.claude/settings.local.json` entry in the same `yolo-bridge attach`
 * spawn `cwd`.
 *
 * Without this, Claude Code shows "New MCP server found in this project:
 * yolo-studio" and every one of its tool calls requires manual approval --
 * defeating the point of `send_to_tile` reaching a session that then just
 * sits there waiting on an interactive prompt nobody's watching for.
 *
 * Two SEPARATE approval layers, both need covering (confirmed against
 * current Claude Code docs, not assumed):
 *   1. Server discovery/trust ("New MCP server found") -- `enabledMcpjsonServers`.
 *   2. Per-tool-call approval -- `permissions.allow` with an
 *      `mcp__<server>__<tool>` pattern (`*` wildcard for "every tool this
 *      server exposes"; Claude Code's own docs, matched independently
 *      against a Codex review finding 2026-08-24 -- see below).
 *
 * Deliberately narrow, same reasoning as `local-mcp-config.ts`: this adds
 * ONLY `enabledMcpjsonServers: ["yolo-studio"]` and
 * `permissions.allow: ["mcp__yolo-studio__*"]` -- never
 * `enableAllProjectMcpServers` (would trust future/unrelated MCP servers
 * too) and never `--dangerously-skip-permissions`-equivalent blanket rules.
 * Every other key in an existing settings file (the user's own permissions,
 * hooks, etc.) is preserved untouched, same "only touch what we own"
 * discipline as the `.mcp.json` writer.
 *
 * Targets `settings.local.json`, NOT the shared `settings.json` (Codex
 * review, 2026-08-24, round 14 — this repo's OWN root already has a
 * tracked `.claude/settings.json`): the shared file is meant to be
 * committed and shared across a team, but this grant is per-attach,
 * ephemeral daemon state — if written there, a spawned coding agent
 * running with YOLO-mode autonomy could commit/push it, and a SIGKILL or
 * reboot before cleanup would leave it in a file every OTHER checkout of
 * the repo inherits, auto-trusting a future `yolo-studio` server
 * definition with no prompt. `settings.local.json` is Claude Code's own
 * sanctioned personal/machine-local settings layer (merged with
 * `settings.json`), CONVENTIONALLY git-ignored.
 *
 * "Conventionally" is not "guaranteed" (Codex review, 2026-08-24, round 15):
 * that assumption doesn't hold universally, and disproved itself in the one
 * place it would matter most — this repo's OWN root ALREADY tracks
 * `.claude/settings.local.json` (verified with `git ls-files`, not assumed).
 * Trusting any specific filename's reputation is therefore the wrong check.
 * `writeLocalMcpTrust` now asks git directly (`git check-ignore`) whether
 * THIS path, in THIS `cwd`, is actually safe from being swept into a
 * commit, and refuses to write anything (falling back to `ok: false`,
 * the same degraded "manual approval required" path an unparseable file
 * already takes) if it isn't — never writing INTO a tracked-or-trackable
 * file is the only way to make the "never persisted where Git can see it"
 * guarantee actually hold, regardless of which filename convention this
 * particular checkout happens to follow.
 *
 * KNOWN GOTCHA, not fixable from here: project-scoped settings are ignored
 * in an UNTRUSTED folder until the user interactively trusts the workspace
 * once (Claude Code v2.1.196+). `yolo-bridge attach` spawns into the
 * directory the command itself was run from -- normally the user's own
 * long-lived working directory, already trusted from ordinary use, not a
 * fresh temp dir -- so this shouldn't bite in the common case, but a truly
 * first-ever `attach` in a brand-new directory would still see one manual
 * trust prompt before this takes effect.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { atomicWriteFileSync, unlinkWriteTarget, resolveWriteTarget } from './atomic-write.js';
import { randomUUID } from 'node:crypto';
import { riskyToCommit, ensureTempSiblingExcluded } from './git-safety.js';

/** Same identity as local-mcp-config.ts's SERVER_NAME -- kept as an
 *  independent constant (not imported) since these two modules are meant to
 *  be usable/testable independently of each other. */
const SERVER_NAME = 'yolo-studio';
// Shell-glob wildcard, NOT regex -- Claude Code's permission matching treats
// `*` as "any tool from this server" (docs.claude.com/en/docs/claude-code/
// permissions, "tool name wildcards"). A `.*` here (as this constant
// originally read) requires a literal dot before the wildcard, which no real
// `mcp__yolo-studio__<tool>` id has -- so it silently matched NOTHING, and
// pre-trust never actually worked: every tool call still prompted for manual
// approval. Found by Codex review (2026-08-24), confirmed independently
// against current docs before fixing (not just taken on faith).
const TOOL_PATTERN = `mcp__${SERVER_NAME}__*`;

function settingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}


function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new Error(`existing ${path} is not valid JSON`);
  }
  // Same refuse-rather-than-clobber fix as local-mcp-config.ts's
  // readConfig (Codex review, 2026-08-24) — a JSON array root passed the
  // old truthy-and-typeof-object check and would have been cast straight
  // into Record<string, unknown>.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Top-level marker key recording exactly which entries THIS module added,
 * so a LATER attach (after a crash) can tell "this is ours to reclaim" with
 * certainty instead of guessing (Codex review, 2026-08-24, round 7 —
 * mirrors `local-mcp-config.ts`'s `OWNERSHIP_MARKER`, same reasoning: a
 * content-only heuristic can't distinguish our own leftover state from the
 * operator's genuinely independent choice, since both look identical once
 * written). Claude Code's settings schema tolerates unrelated top-level
 * keys the same way `.mcp.json` does — this module already preserves the
 * operator's own such keys untouched.
 */
const OWNERSHIP_MARKER = '_yolobridge';

interface OwnershipMarker {
  /** Random per-`writeLocalMcpTrust`-call id (Codex review, 2026-08-24,
   *  round 8) -- lets `removeLocalMcpTrust` verify the marker currently on
   *  disk is still the EXACT one THIS attach wrote, not just "some marker
   *  claiming these booleans." Without this, two gaps existed: (1) an
   *  operator editing/removing the marker mid-session (while keeping the
   *  grants, meaning "I want to keep trusting this") would still have
   *  cleanup blindly act on booleans decided at attach time, deleting
   *  grants the operator just said to keep; (2) two attaches concurrently
   *  running against the same directory could each overwrite the other's
   *  marker, so whichever detaches first could delete grants the other
   *  attach's session still depends on. Requiring an exact id match at
   *  cleanup time makes both cases fail closed (refuse to touch anything)
   *  instead of destroying state that isn't provably this attach's own. */
  attachId?: string;
  enabledServerEntry?: boolean;
  permissionEntry?: boolean;
}

function readOwnershipMarker(settings: Record<string, unknown>): OwnershipMarker {
  const raw = settings[OWNERSHIP_MARKER];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as OwnershipMarker;
}

export interface McpTrustWriteResult {
  ok: boolean;
  /** True only if `SERVER_NAME` was NOT already in `enabledMcpjsonServers`
   *  before this call -- i.e. we're the ones who added it. */
  addedServerEntry: boolean;
  /** True only if `TOOL_PATTERN` was NOT already in `permissions.allow`
   *  before this call. */
  addedPermissionEntry: boolean;
  /** True only if `.claude/settings.local.json` did NOT already exist on disk
   *  before this call (Codex review, 2026-08-24, round 6) -- needed at
   *  cleanup time: a pre-existing file that happened to already be `{}`
   *  looks identical, once our entries are removed, to one this module
   *  created from scratch. */
  createdFile: boolean;
  /** Pass this straight through to `removeLocalMcpTrust`'s `opts.attachId`
   *  unchanged (Codex review, 2026-08-24, round 8) -- undefined when
   *  `ok: false` (nothing was written, nothing to reclaim later). */
  attachId?: string;
}

/**
 * Adds the `yolo-studio` MCP-trust entries to `.claude/settings.local.json`.
 * Returns `ok: false` (does nothing further) if an existing settings file
 * can't be parsed, rather than overwriting a file the user hand-authored --
 * matches `writeLocalMcpConfig`'s own refusal behavior exactly. Also
 * returns `ok: false` if `riskyToCommit` confirms this exact path is NOT
 * git-ignored inside a real repo at `cwd` (Codex review, 2026-08-24,
 * round 15) -- degrading to "every tool call needs manual approval" is
 * strictly preferable to writing an auto-trust grant somewhere a commit
 * could publish it.
 *
 * Tracks which entries it ACTUALLY inserted vs. which were already present
 * (Codex review, 2026-08-24): if the operator had already trusted this
 * server themselves before ever running `attach`, that's their own
 * standing choice, not something this attach owns -- `removeLocalMcpTrust`
 * must be told which entries to remove rather than unconditionally
 * stripping by value, or a detach would revoke trust the operator granted
 * independently.
 */
export function writeLocalMcpTrust(cwd: string): McpTrustWriteResult {
  const path = settingsPath(cwd);
  if (riskyToCommit(cwd, path)) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }
  // The DESTINATION is confirmed safe above, but `atomicWriteFileSync`'s own
  // `.tmp-*` temp sibling has a DIFFERENT literal name an exact-match
  // `.gitignore` entry doesn't cover (Codex review, 2026-08-24, round 25) —
  // see `ensureTempSiblingExcluded`'s own doc comment. Derived from
  // `resolveWriteTarget`, not the lexical path (Codex review, 2026-08-24,
  // round 27) — see local-mcp-config.ts's identical fix for why.
  ensureTempSiblingExcluded(cwd, `${basename(resolveWriteTarget(path))}.tmp-*`);
  const createdFile = !existsSync(path);
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }

  // Present-but-invalid is refused, same reasoning as local-mcp-config.ts's
  // matching fix (Codex review, 2026-08-24): `asStringArray` alone silently
  // treats a non-array value as `[]`, which would discard a malformed
  // `enabledMcpjsonServers`/`permissions.allow` (or a non-object
  // `permissions`) on write while still reporting success. Only genuinely
  // ABSENT fields default to empty.
  if ('enabledMcpjsonServers' in settings && !Array.isArray(settings.enabledMcpjsonServers)) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }
  if ('permissions' in settings && (settings.permissions === null || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }
  const permissionsObj = (settings.permissions ?? {}) as Record<string, unknown>;
  if ('allow' in permissionsObj && !Array.isArray(permissionsObj.allow)) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }
  // An array that's the right SHAPE can still hold the wrong ELEMENT types
  // (Codex review, 2026-08-24, round 19): the checks above only confirm
  // "this is an array," not "every element is a string" — `asStringArray`
  // below silently filters out anything else, so a non-string element
  // (e.g. `["real-server", 42]`) would be PERMANENTLY discarded from the
  // operator's own file the moment this module writes it back, despite
  // having nothing to do with what this module owns. Refused here for the
  // same reason a malformed shape is: present-but-invalid content is not
  // this module's to silently normalize away.
  if (Array.isArray(settings.enabledMcpjsonServers) && !settings.enabledMcpjsonServers.every((v) => typeof v === 'string')) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }
  if (Array.isArray(permissionsObj.allow) && !permissionsObj.allow.every((v) => typeof v === 'string')) {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false };
  }

  // Consulted BEFORE mutating anything below (Codex review, 2026-08-24,
  // round 7): if the entry is already present but OUR OWN marker from a
  // previous (possibly crashed) attach claims it, this is a reclaim, not a
  // fresh addition or a foreign one -- addedServerEntry/addedPermissionEntry
  // report `true` either way, since both mean "safe for cleanup to remove."
  const priorMarker = readOwnershipMarker(settings);

  const enabled = new Set(asStringArray(settings.enabledMcpjsonServers));
  const addedServerEntry = !enabled.has(SERVER_NAME) || priorMarker.enabledServerEntry === true;
  enabled.add(SERVER_NAME);
  settings.enabledMcpjsonServers = [...enabled];

  const allow = new Set(asStringArray(permissionsObj.allow));
  const addedPermissionEntry = !allow.has(TOOL_PATTERN) || priorMarker.permissionEntry === true;
  allow.add(TOOL_PATTERN);
  permissionsObj.allow = [...allow];
  settings.permissions = permissionsObj;

  const attachId = randomUUID();
  settings[OWNERSHIP_MARKER] = { attachId, enabledServerEntry: addedServerEntry, permissionEntry: addedPermissionEntry } satisfies OwnershipMarker;

  mkdirSync(dirname(path), { recursive: true });
  // Atomic (temp file + rename), not a direct overwrite (Codex review,
  // 2026-08-24, round 13): a direct `writeFileSync` on an EXISTING
  // `.claude/settings.local.json` truncates it before writing the new bytes, so
  // ENOSPC or a crash mid-write can leave the OPERATOR's settings
  // half-written — unrecoverable, and settings.local.json can carry far more than
  // just this module's own keys.
  atomicWriteFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, addedServerEntry, addedPermissionEntry, createdFile, attachId };
}

/**
 * Removes only the `yolo-studio` entries THIS attach actually added
 * (`removeServerEntry`/`removePermissionEntry`, from `writeLocalMcpTrust`'s
 * own return) -- never touches any other server name, allow/deny rule,
 * hook, other top-level key, or an entry the operator had already granted
 * before this attach. Deletes `.claude/settings.local.json` only if `createdFile`
 * (also from `writeLocalMcpTrust`'s return) says THIS attachment is the one
 * that created it AND nothing else was ever added to it -- Codex review,
 * 2026-08-24, round 6: emptiness alone isn't proof of that (a pre-existing
 * `{}` looks identical once our entries are removed); a file with other
 * content, or one that already existed before this attach touched it, is
 * left in place, minus just what this attach added.
 *
 * `opts.attachId` (from that same `writeLocalMcpTrust` call) must EXACTLY
 * match the marker CURRENTLY on disk, re-read here, before anything is
 * touched (Codex review, 2026-08-24, round 8) -- decisions captured at
 * write time can go stale by the time cleanup actually runs: the operator
 * may have edited or removed the marker mid-session (a signal to leave
 * their grants alone, not something a blind boolean-driven delete should
 * override), or a second concurrent attach in the same directory may have
 * overwritten it with its own. A mismatched or missing marker means this
 * attach can no longer prove the current state is provably its own, so it
 * fails closed and leaves everything untouched rather than risk deleting
 * something it doesn't actually own anymore.
 */
export function removeLocalMcpTrust(
  cwd: string,
  opts: { removeServerEntry: boolean; removePermissionEntry: boolean; createdFile: boolean; attachId?: string },
): void {
  const path = settingsPath(cwd);
  if (!existsSync(path)) return;
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch {
    return;
  }

  const currentMarker = readOwnershipMarker(settings);
  const stillOurs = opts.attachId !== undefined && currentMarker.attachId === opts.attachId;
  // A mismatched/missing marker means this call can no longer prove the
  // current state is provably its own (edited/removed mid-session, or
  // clobbered by a concurrent attach) -- touch NOTHING, not even a
  // reformatting rewrite of otherwise-unchanged content.
  if (!stillOurs) return;

  // Present-but-invalid is refused, same as the write path (Codex review,
  // 2026-08-24, round 22): the content checks below only catch a
  // WRONG-SHAPE ARRAY (a non-string element) -- they never fire when the
  // value isn't an array AT ALL (hand-edited to a string/number, or
  // `permissions` itself replaced with a non-object). `asStringArray`
  // silently coerces any non-array to `[]`, so `enabled.length > 0` would
  // be false below and this function would `delete` the operator's field
  // entirely -- exactly the "cleanup destroys something it doesn't
  // provably still own" failure this function's own doc comment exists to
  // prevent. Only genuinely ABSENT fields are left to default to empty.
  if ('enabledMcpjsonServers' in settings && !Array.isArray(settings.enabledMcpjsonServers)) return;
  if ('permissions' in settings && (settings.permissions === null || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) return;
  const permissionsForShapeCheck = (settings.permissions ?? {}) as Record<string, unknown>;
  if ('allow' in permissionsForShapeCheck && !Array.isArray(permissionsForShapeCheck.allow)) return;

  // Same refuse-rather-than-silently-normalize check as the write path
  // (Codex review, 2026-08-24, round 19): the operator could have
  // hand-edited a non-string element into one of these arrays between
  // attach and detach; `asStringArray` below would otherwise drop it
  // permanently the moment this function writes the file back.
  if (Array.isArray(settings.enabledMcpjsonServers) && !settings.enabledMcpjsonServers.every((v) => typeof v === 'string')) return;
  if (
    settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions) &&
    Array.isArray((settings.permissions as Record<string, unknown>).allow) &&
    !((settings.permissions as Record<string, unknown>).allow as unknown[]).every((v) => typeof v === 'string')
  ) return;

  if (opts.removeServerEntry) {
    const enabled = asStringArray(settings.enabledMcpjsonServers).filter((s) => s !== SERVER_NAME);
    if (enabled.length > 0) settings.enabledMcpjsonServers = enabled;
    else delete settings.enabledMcpjsonServers;
  }

  const permissions = (settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : undefined) as Record<string, unknown> | undefined;
  if (permissions && opts.removePermissionEntry) {
    const allow = asStringArray(permissions.allow).filter((p) => p !== TOOL_PATTERN);
    if (allow.length > 0) permissions.allow = allow;
    else delete permissions.allow;
    if (Object.keys(permissions).length > 0) settings.permissions = permissions;
    else delete settings.permissions;
  }

  // Never leave the ownership marker behind — it's internal bookkeeping,
  // not something the operator should see lingering in their settings once
  // this attach is done with it (Codex review, 2026-08-24, round 7).
  delete settings[OWNERSHIP_MARKER];

  if (opts.createdFile && Object.keys(settings).length === 0) {
    // `unlinkWriteTarget`, not a bare `unlinkSync(path)` (Codex review,
    // 2026-08-24, round 26) — same reasoning as local-mcp-config.ts's
    // identical fix: `path` can be a symlink `atomicWriteFileSync` healed.
    unlinkWriteTarget(path);
    return;
  }
  // Atomic — see the doc comment on the equivalent write in
  // `writeLocalMcpTrust` (Codex review, 2026-08-24, round 13).
  atomicWriteFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
