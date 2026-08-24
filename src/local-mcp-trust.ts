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
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error(`existing ${path} is not valid JSON`);
  }
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
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch {
    return { ok: false, addedServerEntry: false, addedPermissionEntry: false };
  }

  const enabled = new Set(asStringArray(settings.enabledMcpjsonServers));
  const addedServerEntry = !enabled.has(SERVER_NAME);
  enabled.add(SERVER_NAME);
  settings.enabledMcpjsonServers = [...enabled];

  const permissions = (settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {}) as Record<string, unknown>;
  const allow = new Set(asStringArray(permissions.allow));
  const addedPermissionEntry = !allow.has(TOOL_PATTERN);
  allow.add(TOOL_PATTERN);
  permissions.allow = [...allow];
  settings.permissions = permissions;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { ok: true, addedServerEntry, addedPermissionEntry };
}

/**
 * Removes only the `yolo-studio` entries THIS attach actually added
 * (`removeServerEntry`/`removePermissionEntry`, from `writeLocalMcpTrust`'s
 * own return) -- never touches any other server name, allow/deny rule,
 * hook, other top-level key, or an entry the operator had already granted
 * before this attach. Deletes `.claude/settings.json` (and its directory,
 * if now empty) only if we created it from scratch and nothing else was
 * ever added to it; a file with any other content is left in place, minus
 * just what this attach added.
 */
export function removeLocalMcpTrust(
  cwd: string,
  opts: { removeServerEntry: boolean; removePermissionEntry: boolean },
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

  if (Object.keys(settings).length === 0) {
    unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}
