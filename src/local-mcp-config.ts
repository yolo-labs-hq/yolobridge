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
 * Sidecar file recording the proxy URL this module most recently wrote into
 * `yolo-studio`, kept OUTSIDE `.mcp.json` itself.
 *
 * Round 7-8 tracked ownership with a marker key (`_yolobridge: true`)
 * embedded directly in the `mcpServers.yolo-studio` entry. Codex review,
 * 2026-08-24, round 9, correctly flagged that as broken: Claude Code
 * (v2.0.21+) validates `mcpServers` entries strictly on some releases and
 * rejects unknown fields (anthropics/claude-code#10606) — this repo's own
 * pod-side writer (`containers/services/container-api/mcp-config-writer.js`)
 * already hit exactly this and solved it with an external sidecar rather
 * than an in-entry marker. This file now does the same, adapted to
 * `.mcp.json`'s project-scoped (not home-scoped) design: the entry this
 * module writes is a plain, spec-shaped `{ type: 'http', url }` with no
 * extra keys, so it can never trip strict validation, and ownership is
 * instead established by comparing the entry's `url` against the URL this
 * sidecar recorded us writing.
 */
function sidecarPath(cwd: string): string {
  return join(cwd, '.yolobridge-mcp-state.json');
}

interface SidecarState {
  proxyUrl?: string;
}

/** Best-effort read: a missing or corrupt sidecar just means "we don't know
 *  what we last wrote", which correctly makes `looksLikeOurOwnEntry` refuse
 *  to reclaim rather than guess — fail closed, same as everywhere else in
 *  this file. */
function readSidecar(cwd: string): SidecarState {
  const path = sidecarPath(cwd);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).proxyUrl === 'string') {
      return { proxyUrl: (parsed as Record<string, unknown>).proxyUrl as string };
    }
  } catch {
    // Corrupt sidecar — treated as absent above.
  }
  return {};
}

function writeSidecar(cwd: string, proxyUrl: string): void {
  writeFileSync(sidecarPath(cwd), JSON.stringify({ proxyUrl }, null, 2) + '\n', 'utf-8');
}

function deleteSidecar(cwd: string): void {
  const path = sidecarPath(cwd);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup; a leftover sidecar only ever makes the NEXT
      // write more conservative (it just won't match a differing URL), it
      // never causes an unsafe reclaim.
    }
  }
}

/** Matches ONLY the exact URL shape this module itself ever generates. */
const OWN_ENTRY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/mcp$/;

/**
 * True if an existing `yolo-studio` entry's `type`/`url` still exactly match
 * the URL the sidecar recorded us writing, AND that recorded URL still has
 * the loopback shape this module generates (Codex review, 2026-08-24,
 * round 8's "both signals required" reasoning still applies, now expressed
 * as sidecar-match + shape instead of marker + shape): the sidecar alone
 * isn't enough, because an operator can edit the entry's VALUE (point it
 * somewhere else entirely) WHILE an attachment is still running, without
 * knowing a sidecar exists — a sidecar-only check would then have the NEXT
 * attach overwrite that intentional edit as though it were stale daemon
 * state. Requiring the CURRENT entry to still equal the recorded URL closes
 * that gap: an edited entry no longer matches, so it's correctly left alone
 * even with a stale sidecar record.
 */
function looksLikeOurOwnEntry(value: unknown, recordedUrl: string | undefined): boolean {
  if (!recordedUrl || !OWN_ENTRY_URL_PATTERN.test(recordedUrl)) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'http' && v.url === recordedUrl;
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
  const recordedUrl = readSidecar(cwd).proxyUrl;
  if (SERVER_NAME in servers && !looksLikeOurOwnEntry(servers[SERVER_NAME], recordedUrl)) return { ok: false, createdFile: false };
  // Plain, spec-shaped entry — no ownership marker inside it (round 9): an
  // unknown field here is exactly what a strict-validating Claude Code
  // release rejects the whole server entry over.
  servers[SERVER_NAME] = { type: 'http', url: proxyUrl };
  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  writeSidecar(cwd, proxyUrl);
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
 *
 * The sidecar (round 9) is only ever deleted when it still records exactly
 * `expectedProxyUrl` — the same re-verify-before-touching discipline as the
 * `.mcp.json` entry itself, so a concurrent sibling attach that already
 * overwrote the sidecar with ITS OWN newer URL is never clobbered here.
 */
export function removeLocalMcpConfig(cwd: string, expectedProxyUrl: string, createdFile: boolean): void {
  const path = mcpJsonPath(cwd);
  if (!existsSync(path)) {
    if (readSidecar(cwd).proxyUrl === expectedProxyUrl) deleteSidecar(cwd);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    // Can't safely edit a file we can't parse — leave it alone.
    return;
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  const current = servers[SERVER_NAME] as { type?: unknown; url?: unknown } | undefined;
  const recordedUrl = readSidecar(cwd).proxyUrl;
  if (!current || current.type !== 'http' || current.url !== expectedProxyUrl || !looksLikeOurOwnEntry(current, recordedUrl)) return;
  delete servers[SERVER_NAME];

  const hasOtherServers = Object.keys(servers).length > 0;
  const otherTopLevelKeys = Object.keys(config).filter((k) => k !== 'mcpServers');

  if (createdFile && !hasOtherServers && otherTopLevelKeys.length === 0) {
    unlinkSync(path);
    if (recordedUrl === expectedProxyUrl) deleteSidecar(cwd);
    return;
  }

  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  if (recordedUrl === expectedProxyUrl) deleteSidecar(cwd);
}
