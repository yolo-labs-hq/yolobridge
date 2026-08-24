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
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Malformed existing file — do not clobber it silently by overwriting
    // with a fresh one; treat as unreadable and refuse to touch it (see
    // writeLocalMcpConfig's caller, which logs and skips on `false`).
    throw new Error(`existing ${path} is not valid JSON`);
  }
}

/**
 * Adds/updates the `yolo-studio` entry pointing at the local proxy. Returns
 * `false` (does nothing further) if an existing `.mcp.json` can't be parsed,
 * rather than overwriting a file the user may have hand-authored.
 */
export function writeLocalMcpConfig(cwd: string, proxyUrl: string): boolean {
  const path = mcpJsonPath(cwd);
  let config: Record<string, unknown>;
  try {
    config = readConfig(path);
  } catch {
    return false;
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  servers[SERVER_NAME] = { type: 'http', url: proxyUrl };
  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * Removes exactly the `yolo-studio` entry this module added. If that leaves
 * `.mcp.json` with no `mcpServers` entries and nothing else in the file
 * (i.e. we created it from scratch), deletes the file entirely rather than
 * leaving an empty shell behind. A file that had OTHER content (either other
 * server entries, or other top-level keys) is left in place with just the
 * one entry removed.
 */
export function removeLocalMcpConfig(cwd: string): void {
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
  delete servers[SERVER_NAME];

  const hasOtherServers = Object.keys(servers).length > 0;
  const otherTopLevelKeys = Object.keys(config).filter((k) => k !== 'mcpServers');

  if (!hasOtherServers && otherTopLevelKeys.length === 0) {
    unlinkSync(path);
    return;
  }

  config.mcpServers = servers;
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
