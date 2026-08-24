/**
 * Pre-trusts the `yolo-studio` MCP server `local-mcp-config.ts` writes into
 * `.mcp.json`, by writing a companion project-scoped `.claude/settings.json`
 * entry in the same `yolo-bridge attach` spawn `cwd`.
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
 * Every other key in an existing `.claude/settings.json` (the user's own
 * permissions, hooks, etc.) is preserved untouched, same "only touch what we
 * own" discipline as the `.mcp.json` writer.
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

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
  return join(cwd, '.claude', 'settings.json');
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

export interface McpTrustWriteResult {
  ok: boolean;
  /** True only if `SERVER_NAME` was NOT already in `enabledMcpjsonServers`
   *  before this call -- i.e. we're the ones who added it. */
  addedServerEntry: boolean;
  /** True only if `TOOL_PATTERN` was NOT already in `permissions.allow`
   *  before this call. */
  addedPermissionEntry: boolean;
  /** True only if `.claude/settings.json` did NOT already exist on disk
   *  before this call (Codex review, 2026-08-24, round 6) -- needed at
   *  cleanup time: a pre-existing file that happened to already be `{}`
   *  looks identical, once our entries are removed, to one this module
   *  created from scratch. */
  createdFile: boolean;
}

/**
 * Adds the `yolo-studio` MCP-trust entries to `.claude/settings.json`.
 * Returns `ok: false` (does nothing further) if an existing settings file
 * can't be parsed, rather than overwriting a file the user hand-authored --
 * matches `writeLocalMcpConfig`'s own refusal behavior exactly.
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

  const enabled = new Set(asStringArray(settings.enabledMcpjsonServers));
  const addedServerEntry = !enabled.has(SERVER_NAME);
  enabled.add(SERVER_NAME);
  settings.enabledMcpjsonServers = [...enabled];

  const allow = new Set(asStringArray(permissionsObj.allow));
  const addedPermissionEntry = !allow.has(TOOL_PATTERN);
  allow.add(TOOL_PATTERN);
  permissionsObj.allow = [...allow];
  settings.permissions = permissionsObj;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { ok: true, addedServerEntry, addedPermissionEntry, createdFile };
}

/**
 * Removes only the `yolo-studio` entries THIS attach actually added
 * (`removeServerEntry`/`removePermissionEntry`, from `writeLocalMcpTrust`'s
 * own return) -- never touches any other server name, allow/deny rule,
 * hook, other top-level key, or an entry the operator had already granted
 * before this attach. Deletes `.claude/settings.json` only if `createdFile`
 * (also from `writeLocalMcpTrust`'s return) says THIS attachment is the one
 * that created it AND nothing else was ever added to it -- Codex review,
 * 2026-08-24, round 6: emptiness alone isn't proof of that (a pre-existing
 * `{}` looks identical once our entries are removed); a file with other
 * content, or one that already existed before this attach touched it, is
 * left in place, minus just what this attach added.
 */
export function removeLocalMcpTrust(
  cwd: string,
  opts: { removeServerEntry: boolean; removePermissionEntry: boolean; createdFile: boolean },
): void {
  const path = settingsPath(cwd);
  if (!existsSync(path)) return;
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch {
    return;
  }

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

  if (opts.createdFile && Object.keys(settings).length === 0) {
    unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
