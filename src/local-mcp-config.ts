/**
 * Writes/removes a PROJECT-scoped `.mcp.json` entry for the local MCP proxy
 * (mcp-proxy.ts) in the `yolo-bridge attach` spawn `cwd`.
 *
 * Deliberately NOT the user's global `~/.claude.json` — that's what
 * `containers/services/container-api/mcp-config-writer.js` writes to
 * in-pod, which is fine there because a pod is single-purpose and thrown
 * away. A laptop is not: writing into the global config would leak a
 * workspace-scoped MCP server into every unrelated Claude Code session the
 * user runs on their own machine. `.mcp.json` in the attach directory is
 * scoped to exactly that directory.
 *
 * Preserves any pre-existing `.mcp.json` content the same way the pod-side
 * writer's own header comment describes ("preserves user-added entries") —
 * adapted to a single project file rather than a global merge: only the key
 * this module owns (`SERVER_NAME`) is ever added or removed; every other
 * key in the file is left untouched.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Matches the pod-side writer's own server name (agents.json's
 *  `mcp.servers.yolo-studio` key) — same identity, different transport. */
const SERVER_NAME = 'yolo-studio';

function mcpJsonPath(cwd: string): string {
  return join(cwd, '.mcp.json');
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // Malformed existing file — do not clobber it silently by overwriting
    // with a fresh one; treat as unreadable and refuse to touch it (see
    // writeLocalMcpConfig's caller, which logs and skips on `false`).
    throw new Error(`existing ${path} is not valid JSON`);
  }
  // A valid-JSON, non-object root (an array, or a bare scalar like `null`/
  // a number/a string) is just as unsafe to treat as `{}` as malformed JSON
  // is (Codex review, 2026-08-24): `typeof [] === 'object'` passed the old
  // truthy-and-typeof-object check, so an array root would have been cast
  // straight into `Record<string, unknown>` — `config.mcpServers = ...`
  // then silently adds a property onto the operator's array, and the
  // JSON.stringify write below would replace their original array content
  // with an object. Same refuse-rather-than-clobber treatment as bad JSON.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`existing ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Marker key written into the `yolo-studio` entry itself so a LATER attach
 * can tell "we wrote this, safe to reclaim after a crash" apart from
 * "genuinely the operator's own config" with certainty, not a guess.
 *
 * Round 6 tried a URL-shape heuristic instead (loopback-looking URL = ours)
 * — Codex review, 2026-08-24, round 7 correctly pointed out a legitimate
 * hand-authored entry for LOCAL development can have that exact shape too
 * (`http://127.0.0.1:<port>/mcp` is a completely normal thing for a human
 * to point a real local MCP server at), so URL shape alone can't establish
 * ownership. An explicit marker can: no hand-authored entry has any reason
 * to carry this exact key, and Claude Code's MCP client only reads
 * `type`/`url`/etc. from a server entry — an extra unknown key is inert to
 * it, the same way `.mcp.json`'s own unrelated top-level keys already are.
 */
const OWNERSHIP_MARKER = '_yolobridge';

/** Matches ONLY the exact URL shape this module itself ever generates. */
const OWN_ENTRY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/mcp$/;

/**
 * True if an existing `yolo-studio` entry carries `OWNERSHIP_MARKER` AND
 * still has the exact shape this module writes — `type: 'http'` and a
 * loopback `url`. BOTH signals are required (Codex review, 2026-08-24,
 * round 8): the marker alone isn't enough, because an operator can edit
 * the entry's VALUE (point it somewhere else entirely) WHILE an attachment
 * is still running, without knowing to also strip the marker they don't
 * know exists — a marker-only check would then have the NEXT attach
 * overwrite that intentional edit as though it were stale daemon state.
 * Requiring the shape to STILL look loopback-generated closes that gap:
 * an edited entry no longer matches, so it's correctly left alone even
 * with a stale marker attached.
 */
function looksLikeOurOwnEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v[OWNERSHIP_MARKER] === true && v.type === 'http' && typeof v.url === 'string' && OWN_ENTRY_URL_PATTERN.test(v.url);
}

export interface McpConfigWriteResult {
  ok: boolean;
  /** True only if `.mcp.json` did NOT already exist on disk before this
   *  call (Codex review, 2026-08-24, round 6) — needed at cleanup time:
   *  a pre-existing file that HAPPENED to be empty (`{}` or
   *  `{"mcpServers":{}}`) looks identical, after our entry is removed
   *  again, to a file this module created from scratch. Without tracking
   *  which one actually happened, cleanup would delete a file the
   *  operator already had. */
  createdFile: boolean;
}

/**
 * Adds the `yolo-studio` entry pointing at the local proxy. `ok: false`
 * (does nothing further) if an existing `.mcp.json` can't be parsed, OR if
 * a `yolo-studio` entry is ALREADY there and does NOT look like our own
 * (Codex review, 2026-08-24): a hand-authored entry with that name is the
 * user's own config, not ours to overwrite — and `removeLocalMcpConfig`
 * only ever deletes a value that still matches what was written, so
 * overwriting a genuinely foreign entry here would mean detach later
 * deletes the user's own entry, not just reverts ours. An entry that DOES
 * look like ours (round 6: `looksLikeOurOwnEntry`) is instead treated as a
 * stale leftover from an attachment that exited uncleanly (SIGKILL, crash,
 * reboot — never reached its own `removeLocalMcpConfig` call) and is
 * safely overwritten with the current proxy's URL; refusing unconditionally
 * here would otherwise brick local MCP access on every subsequent attach
 * until the operator manually edited the file.
 */
export function writeLocalMcpConfig(cwd: string, proxyUrl: string): McpConfigWriteResult {
  const path = mcpJsonPath(cwd);
  const createdFile = !existsSync(path);
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    return { ok: false, createdFile: false };
  }
  // `config.mcpServers` gets the SAME root-validation treatment as the file
  // itself (Codex review, 2026-08-24): the old `typeof === 'object'` check
  // also accepts an array (assigning SERVER_NAME onto it is then silently
  // dropped by JSON.stringify -- this would have returned `true` while
  // writing nothing), and silently replaced a PRIMITIVE mcpServers value
  // (e.g. a string) with a fresh `{}`, discarding it. Present-but-invalid
  // is refused, same as an invalid root; only ABSENT defaults to `{}`.
  if ('mcpServers' in config && (config.mcpServers === null || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    return { ok: false, createdFile: false };
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (SERVER_NAME in servers && !looksLikeOurOwnEntry(servers[SERVER_NAME])) return { ok: false, createdFile: false };
  servers[SERVER_NAME] = { type: 'http', url: proxyUrl, [OWNERSHIP_MARKER]: true };
  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { ok: true, createdFile };
}

/**
 * Removes exactly the `yolo-studio` entry this module added — but ONLY if
 * its value still matches exactly what `writeLocalMcpConfig` wrote
 * (`expectedProxyUrl`, the same one passed to that call) — Codex review,
 * 2026-08-24, round 5: over a long-running attachment, the operator (or
 * another `claude mcp add`/hand edit) could replace that entry with
 * something else entirely; blind deletion keyed only on "did WE create
 * this key originally" would destroy that newer, unrelated edit too. A
 * changed value is left completely alone, matching an unparseable file's
 * treatment — this function only ever removes the EXACT thing it added.
 *
 * If that leaves `.mcp.json` with no `mcpServers` entries and nothing else
 * in the file, deletes the file entirely — but ONLY when `createdFile`
 * (from `writeLocalMcpConfig`'s own return) says THIS attachment is the one
 * that created it. Codex review, 2026-08-24, round 6: emptiness alone isn't
 * proof of that — a repo that already had an empty `.mcp.json` or
 * `{"mcpServers":{}}` looks identical, once our entry is removed, to one
 * this module created from scratch, and unlinking it would delete a file
 * the operator already had. When it's empty but NOT ours to delete, the
 * (now-empty-of-our-stuff) config is written back instead, same as any
 * other "file had other content" case.
 */
export function removeLocalMcpConfig(cwd: string, expectedProxyUrl: string, createdFile: boolean): void {
  const path = mcpJsonPath(cwd);
  if (!existsSync(path)) return;
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    // Can't safely edit a file we can't parse — leave it alone.
    return;
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  const current = servers[SERVER_NAME] as { type?: unknown; url?: unknown } | undefined;
  if (!current || current.type !== 'http' || current.url !== expectedProxyUrl || !looksLikeOurOwnEntry(current)) return;
  delete servers[SERVER_NAME];

  const hasOtherServers = Object.keys(servers).length > 0;
  const otherTopLevelKeys = Object.keys(config).filter((k) => k !== 'mcpServers');

  if (createdFile && !hasOtherServers && otherTopLevelKeys.length === 0) {
    unlinkSync(path);
    return;
  }

  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
