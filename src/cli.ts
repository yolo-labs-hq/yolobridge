#!/usr/bin/env node
/**
 * `yolo-bridge` — YoloBridge local daemon CLI (docs/YOLOBRIDGE_PLAN.md,
 * Implementation Plan → build-order step 5).
 *
 * Subcommands:
 *   yolo-bridge login                 — device-authorization flow (login-cmd.ts)
 *   yolo-bridge workspaces            — list selectable workspaces (workspaces-cmd.ts)
 *   yolo-bridge attach [workspaceId]  — attach + hold the SSE stream (attach-cmd.ts)
 *                                        (omit the id for an interactive picker)
 *   yolo-bridge detach                — DELETE the current attachment (detach-cmd.ts)
 *   yolo-bridge status                — print local login/attach state (status-cmd.ts)
 *
 * Base URLs default to this repo's real hostnames (CLAUDE.md → Project
 * Overview): common-api `https://api.yolo.studio`, auth-service
 * `https://auth.yololabs.ai`. Override with YOLOBRIDGE_API_URL /
 * YOLOBRIDGE_AUTH_URL for local dev against a different environment.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';

import { runLogin } from './login-cmd.js';
import { runAttachFromDisk, pickWorkspaceFromDisk } from './attach-cmd.js';
import { runDetach } from './detach-cmd.js';
import type { RemoteHostInfo } from './api-client.js';
import { getStatus, formatStatus } from './status-cmd.js';
import { startLocalAgent, stopLocalAgent, DEFAULT_AGENT_BIN } from './local-agent.js';
import { runListWorkspaces, formatWorkspacesTable, type ListWorkspacesResult } from './workspaces-cmd.js';
import { startMcpProxy, mcpUrl, SECRET_ENV_VAR, type McpProxyHandle } from './mcp-proxy.js';
import { writeLocalMcpConfig, removeLocalMcpConfig } from './local-mcp-config.js';
import { writeLocalMcpTrust, removeLocalMcpTrust } from './local-mcp-trust.js';

const DEFAULT_API_URL = 'https://api.yolo.studio';
const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';

function apiUrl(): string {
  return process.env.YOLOBRIDGE_API_URL || DEFAULT_API_URL;
}

function authUrl(): string {
  return process.env.YOLOBRIDGE_AUTH_URL || DEFAULT_AUTH_URL;
}

// Mongo ObjectId shape: 24 hex chars. A workspace name could theoretically
// collide with this (unlikely, but possible), in which case the id-shaped
// value wins — same tradeoff the rest of this codebase's id-or-slug lookups
// make, and matches user expectation: someone who types a raw id wants that
// exact workspace, not a name lookup that happens to match the same string.
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Resolves an `attach` positional argument that may be a raw workspace id OR
 * a workspace NAME. An id-shaped value is used as-is (no network round trip
 * — unchanged behavior for every existing caller). Anything else is treated
 * as a name and resolved via the same `GET .../workspaces/selectable` list
 * `yolo-bridge workspaces` and the interactive picker already use — a
 * case-insensitive exact match. Zero or multiple matches is a clear error
 * (never a silent first-match guess); multiple matches lists the candidate
 * ids so the caller can disambiguate with the id form instead.
 */
export async function resolveWorkspaceIdOrName(
  value: string,
  deps: { commonApiBaseUrl: string },
  // Injectable for tests (same convention as attach-cmd.ts's RefreshTokenFn)
  // — avoids mocking module-level network calls to exercise the pure
  // matching/error logic below.
  listWorkspacesFn: (deps: { commonApiBaseUrl: string }) => Promise<ListWorkspacesResult> = runListWorkspaces,
): Promise<{ ok: true; workspaceId: string } | { ok: false; message: string }> {
  if (OBJECT_ID_RE.test(value)) return { ok: true, workspaceId: value };

  const listed = await listWorkspacesFn({ commonApiBaseUrl: deps.commonApiBaseUrl });
  if (!listed.ok) {
    return { ok: false, message: listed.message };
  }
  const needle = value.toLowerCase();
  const matches = listed.workspaces.filter((w) => (w.name || '').toLowerCase() === needle);
  if (matches.length === 0) {
    return {
      ok: false,
      message: `no workspace named "${value}" found (run \`yolo-bridge workspaces\` to see your workspaces)`,
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((w) => `${w.id} [${w.status}]`).join(', ');
    return { ok: false, message: `multiple workspaces are named "${value}" — attach by id instead: ${candidates}` };
  }
  return { ok: true, workspaceId: matches[0]!.id };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: yolo-bridge <command> [args]',
      '',
      'Commands:',
      '  login                  Device-authorization login against auth-service.',
      '  workspaces             List your own workspaces (id, name, status) that can be attached to.',
      '  attach [workspace]     Attach this machine to a workspace and hold the daemon loop open.',
      '                         Accepts either a raw workspace id or its NAME (case-insensitive',
      '                         exact match against `yolo-bridge workspaces`); an ambiguous or',
      '                         unmatched name errors instead of guessing. Omit it entirely to pick',
      '                         interactively from `yolo-bridge workspaces`.',
      '    [--label <name>]     Operator-facing host label (reported to the workspace).',
      '    [--agent <binary>]   Local coding-agent binary to spawn (default: $YOLOBRIDGE_AGENT_BIN or "claude").',
      '    [--agent-id <id>]    Registry identity for local MCP access, if different from --agent',
      '                         (e.g. a raw executable path, or an agent whose binary name differs',
      '                         from its registry id like qwen-code/qwen). Defaults to --agent.',
      '  detach                 Detach the current workspace attachment.',
      '  status                 Print local login/attach state.',
      '  --help                 Print this help.',
      '',
      `API base:   ${apiUrl()} (override: YOLOBRIDGE_API_URL)`,
      `Auth base:  ${authUrl()} (override: YOLOBRIDGE_AUTH_URL)`,
      `MCP base:   ${mcpUrl()} (override: YOLOBRIDGE_MCP_URL)`,
      `Agent bin:  ${DEFAULT_AGENT_BIN} (override: --agent or YOLOBRIDGE_AGENT_BIN)`,
      '',
    ].join('\n'),
  );
}

async function cmdLogin(): Promise<number> {
  const result = await runLogin({ authBaseUrl: authUrl() });
  if (result.ok) return 0;
  process.stderr.write(`yolo-bridge login: ${result.message}\n`);
  return 1;
}

export interface AttachArgs {
  workspaceId?: string;
  hostLabel?: string;
  agentBin?: string;
  agentId?: string;
}

export interface AttachArgsError {
  error: string;
}

/**
 * Parses `attach`'s argv into its recognized `--label <name>` / `--agent
 * <binary>` / `--agent-id <registryId>` flag pairs plus a leftover
 * positional workspaceId — consuming each flag's value together with the
 * flag itself *before* deciding what's left over for the positional, so
 * e.g. `attach --label laptop` doesn't mistake "laptop" for a workspace id
 * (it should still fall through to the interactive picker). An unrecognized
 * `--something` is a hard error rather than being silently swallowed as
 * some other flag's value.
 *
 * `--agent-id` exists because `--agent` names the literal spawn command
 * (whatever `startLocalAgent` execs), which is NOT always the same string
 * as the mint route's registry `agentId` (Codex review, 2026-08-24, round
 * 4/5): a raw executable path (`--agent /opt/bin/claude`) 400s as
 * unregistered, and some registered agents' own binary differs from their
 * registry id (`qwen-code`'s binary is `qwen`, `kiro`'s is `kiro-cli`).
 * yolobridge has no local copy of `agents.json` to resolve this itself (it
 * runs on the operator's own machine, not in a pod) — asserting it
 * explicitly is the honest fix, not guessing. Defaults to `agentBin` when
 * omitted, which is correct for every agent whose registry id equals its
 * binary name (the common case: `claude`, `codex`, ...).
 */
export function parseAttachArgs(args: string[]): AttachArgs | AttachArgsError {
  let workspaceId: string | undefined;
  let hostLabel: string | undefined;
  let agentBin: string | undefined;
  let agentId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label' || a === '--agent' || a === '--agent-id') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${a} requires a value` };
      }
      if (a === '--label') hostLabel = value;
      else if (a === '--agent') agentBin = value;
      else agentId = value;
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      return { error: `unrecognized option '${a}'` };
    }
    if (workspaceId === undefined) {
      workspaceId = a;
    }
  }
  return { workspaceId, hostLabel, agentBin, agentId };
}

/**
 * Everything the attach handshake tells the workspace about this machine,
 * resolved from already-known values — pure, so it's unit-testable without
 * touching a real `os`/`process` (the caller passes the real ones in).
 *
 * Two things happen here:
 *
 *  - **`hostLabel` gains a default.** It was previously set ONLY by an
 *    explicit `--label`, so the overwhelmingly common `yolo-bridge attach`
 *    with no flags produced a tile named a bare "YoloBridge" with nothing
 *    identifying WHICH machine had attached — actively confusing for an
 *    operator running a daemon on more than one. The machine's own hostname
 *    is the obvious default and is already what `--label` is usually set to
 *    by hand. An explicit `--label` still wins.
 *  - **`remoteHost` is assembled**: the launch directory, the OS platform
 *    string, and which agent binary this attach drives.
 *
 * What is deliberately NOT collected, and should not be added without its
 * own consent story: environment variables, anything listing the contents
 * of `cwd`, the OS username or any other account identity, network
 * addresses, or installed-software inventory. This is the operator's own
 * machine being described back to the operator; it is not a survey of it.
 */
export function resolveAttachHostInfo(input: {
  label?: string;
  hostname: string;
  cwd: string;
  platform: string;
  agent: string;
}): { hostLabel: string | undefined; remoteHost: RemoteHostInfo } {
  const label = input.label?.trim();
  return {
    hostLabel: label || input.hostname.trim() || undefined,
    remoteHost: {
      cwd: input.cwd,
      platform: input.platform,
      agent: input.agent,
    },
  };
}

async function cmdAttach(args: string[]): Promise<number> {
  // Printed unconditionally, first thing, regardless of how the rest of
  // this command goes — a self-diagnosing fix for a real, repeated support
  // cost (2026-08-24): every one of that day's "Invalid delegated token" /
  // wrong-workspace confusions traced back to ONE of these three URLs being
  // stale in the caller's shell (e.g. YOLOBRIDGE_MCP_URL added to a .bashrc
  // AFTER the terminal in use had already sourced it), with nothing in the
  // command's own output making that visible until well after the fact.
  process.stdout.write(`yolo-bridge: API base ${apiUrl()} · Auth base ${authUrl()} · MCP base ${mcpUrl()}\n`);

  const parsed = parseAttachArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`yolo-bridge attach: ${parsed.error}\n`);
    process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>] [--agent-id <registryId>]\n');
    return 64;
  }
  let workspaceId = parsed.workspaceId;
  const hostLabel = parsed.hostLabel;
  const agentBin = parsed.agentBin;
  // The mint route's registry identity, NOT necessarily the same string as
  // the spawn command above (see parseAttachArgs's doc comment). Falls back
  // to agentBin (then DEFAULT_AGENT_BIN) for the common case where they
  // match, which is every built-in agent this daemon has been used with so
  // far (claude, codex).
  const resolvedAgentId = parsed.agentId ?? agentBin ?? DEFAULT_AGENT_BIN;
  if (workspaceId) {
    const resolved = await resolveWorkspaceIdOrName(workspaceId, { commonApiBaseUrl: apiUrl() });
    if (!resolved.ok) {
      process.stderr.write(`yolo-bridge attach: ${resolved.message}\n`);
      return 64;
    }
    workspaceId = resolved.workspaceId;
  }
  if (!workspaceId) {
    // No positional id — fall back to an interactive picker over the
    // caller's own `GET .../workspaces/selectable` list instead of just
    // failing (nobody has a raw workspace ObjectId memorized).
    const pick = await pickWorkspaceFromDisk({ commonApiBaseUrl: apiUrl() });
    if (!pick.ok) {
      switch (pick.reason) {
        case 'not-logged-in':
          process.stderr.write('yolo-bridge attach: not logged in — run `yolo-bridge login` first.\n');
          break;
        case 'no-workspaces':
          process.stderr.write('yolo-bridge attach: no workspaces found for your account.\n');
          break;
        case 'no-selection':
          process.stderr.write('yolo-bridge attach: no workspace selected.\n');
          break;
        case 'list-failed':
          process.stderr.write(`yolo-bridge attach: ${pick.message}\n`);
          break;
      }
      process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>] [--agent-id <registryId>]\n');
      return 64;
    }
    workspaceId = pick.workspaceId;
  }

  let stopRequested = false;
  let localAgentExited = false;
  const onSignal = () => {
    if (stopRequested) return;
    stopRequested = true;
    process.stdout.write('\nyolo-bridge: caught interrupt, detaching...\n');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const spawnCwd = process.cwd();
  // Everything the workspace tile shows about WHERE this session runs, all
  // resolved here in one place (see resolveAttachHostInfo's doc comment for
  // what is and isn't collected).
  const attachHostInfo = resolveAttachHostInfo({
    label: hostLabel,
    hostname: hostname(),
    cwd: spawnCwd,
    platform: process.platform,
    agent: resolvedAgentId,
  });
  let mcpProxyHandle: McpProxyHandle | undefined;
  let mcpConfigCleanup: { expectedProxyUrl: string; createdFile: boolean } | undefined;
  let mcpTrustRemoval: { removeServerEntry: boolean; removePermissionEntry: boolean; createdFile: boolean; attachId?: string } | undefined;

  let result: Awaited<ReturnType<typeof runAttachFromDisk>>;
  try {
    result = await runAttachFromDisk({
      workspaceId,
      commonApiBaseUrl: apiUrl(),
      hostLabel: attachHostInfo.hostLabel,
      remoteHost: attachHostInfo.remoteHost,
      shouldStop: () => stopRequested,
      // Fires once the real tileId exists (docs/YOLOBRIDGE_PLAN.md's "Local
      // MCP access" section) — starts the local MCP proxy and writes
      // `.mcp.json` BEFORE spawning the local agent, since Claude Code reads
      // that file at process launch. A proxy-start failure is logged and
      // skipped, not fatal — MCP access is an enhancement on a tile that
      // already works without it (send_to_tile/read_tile_output are
      // unaffected either way).
      onAttached: async ({ getAccessToken, clearScreen }) => {
        // Isolated from `startLocalAgent` below on purpose (Codex review,
        // 2026-08-24): `startMcpProxy` itself never throws, but
        // `writeLocalMcpConfig`/`writeLocalMcpTrust` do plain synchronous
        // `fs` writes (e.g. a read-only `spawnCwd` throws EACCES) — without
        // this try/catch, that exception propagates out of the WHOLE
        // `onAttached` callback (`runAttachDaemon`'s own best-effort wrapper
        // only logs it), and `startLocalAgent` — later in this same
        // callback — never runs. That leaves a daemon holding a live
        // attachment + SSE stream with no local PTY to ever receive a
        // prompt. MCP access is an enhancement on a tile that already works
        // without it; the local agent spawning is not optional.
        try {
          mcpProxyHandle = await startMcpProxy({
            apiUrl: apiUrl(),
            getAccessToken,
            workspaceId,
            agentId: resolvedAgentId,
            log: (line) => process.stdout.write(`${line}\n`),
          });
          // `.mcp.json` + `.claude/settings.json` are Claude Code-specific
          // conventions — Codex reads `~/.codex/config.toml`'s
          // `[mcp_servers.*]` instead (`containers/services/container-api/
          // mcp-config-writer.js:5-7`). Writing Claude's files for a
          // non-Claude `--agent` would silently configure nothing that
          // binary ever reads (Codex review, 2026-08-24) — the proxy still
          // starts (harmless, agent-agnostic), but only Claude gets it
          // wired in until a Codex-format writer exists.
          //
          // Keyed on `resolvedAgentId`, NOT `agentBin`/`resolvedAgentBin`
          // (Codex review, round 5): `--agent-id` exists precisely to assert
          // "this really is claude" even when spawned via a nonstandard path
          // or name (`--agent /opt/bin/claude --agent-id claude`) — keying
          // this decision on the raw spawn string instead would mint
          // successfully but still skip writing the config a real Claude
          // Code process would actually read.
          if (mcpProxyHandle && resolvedAgentId !== 'claude') {
            // A non-claude agent never reads `.mcp.json`/`${SECRET_ENV_VAR}`
            // at all, so exporting the secret here is harmless (nothing
            // ever consumes it) — kept for that case only; see below for
            // why the claude case is NOT unconditional.
            process.env[SECRET_ENV_VAR] = mcpProxyHandle.secret;
            process.stdout.write(`yolo-bridge: local MCP auto-config is only implemented for claude (resolved agent id "${resolvedAgentId}") — the proxy is running at ${mcpProxyHandle.url} but nothing points the local agent at it.\n`);
          } else if (mcpProxyHandle) {
            const configResult = writeLocalMcpConfig(spawnCwd, mcpProxyHandle.url);
            if (!configResult.ok) {
              // Deliberately does NOT export `${SECRET_ENV_VAR}` here (Codex
              // review, 2026-08-24, round 29): the most common refusal
              // reason is a SIBLING attach in the same directory that
              // already owns the shared `.mcp.json` entry — `.mcp.json`
              // still points at THAT sibling's proxy URL, unrelated to
              // this process's own secret. Exporting our own secret anyway
              // used to make this session's Claude authenticate against
              // the sibling's proxy with the WRONG secret — a consistent,
              // confusing 401 on every MCP tool call, not the "left
              // unconfigured" degrade this log line describes. Leaving the
              // var unset doesn't fully fix that (Claude still sees the
              // sibling's entry either way — `.mcp.json` is shared, not
              // per-process), but it stops actively contributing a
              // guaranteed-wrong credential to an entry this process
              // doesn't own.
              process.stdout.write(`yolo-bridge: could not configure local MCP access (${spawnCwd}/.mcp.json is unparseable, already has its own "yolo-studio" entry — possibly from a live sibling attach in this same directory — or would not be safe from a future commit) — leaving it as-is rather than overwrite/dirty it.\n`);
            } else {
              // Exported on THIS process's env, before `startLocalAgent`
              // spawns the local agent below (which inherits it) — the
              // actual secret never touches `.mcp.json` itself (Codex
              // review, 2026-08-24, round 12: that file is a
              // `${SECRET_ENV_VAR}` template Claude Code expands against its
              // own inherited env at load time). Set ONLY after confirming
              // THIS process actually owns the `.mcp.json` entry it points
              // at — see the refusal branch above for why setting it
              // unconditionally was wrong.
              process.env[SECRET_ENV_VAR] = mcpProxyHandle.secret;
              mcpConfigCleanup = { expectedProxyUrl: mcpProxyHandle.url, createdFile: configResult.createdFile };
              // Pre-trusts ONLY the yolo-studio server (server-discovery trust +
              // its own tool-call approvals) so Claude Code doesn't sit on an
              // interactive "New MCP server found" / per-tool-call prompt with
              // nobody watching. Best-effort: a failure here still leaves the
              // MCP server configured and usable, just with the normal
              // approval prompts, so it's logged rather than fatal.
              const trustResult = writeLocalMcpTrust(spawnCwd);
              if (!trustResult.ok) {
                process.stdout.write(`yolo-bridge: could not pre-trust the local MCP server (${spawnCwd}/.claude/settings.local.json is unparseable, or would not be safe from a future commit) — MCP tool calls will need manual approval.\n`);
              } else {
                // Only remove on cleanup what THIS attach actually inserted —
                // an entry the operator already had (added_*Entry: false)
                // was their own standing trust grant, not ours to revoke.
                mcpTrustRemoval = {
                  removeServerEntry: trustResult.addedServerEntry,
                  removePermissionEntry: trustResult.addedPermissionEntry,
                  createdFile: trustResult.createdFile,
                  attachId: trustResult.attachId,
                };
              }
            }
          }
        } catch (err) {
          process.stdout.write(`yolo-bridge: local MCP setup failed (${err instanceof Error ? err.message : String(err)}) — continuing without it.\n`);
        }
  
        // A stop signal (Ctrl+C) can arrive while this callback was still
        // awaiting the MCP-setup block above — `runAttachDaemon` only checks
        // `shouldStop()` again after `onAttached` RETURNS, so without this
        // check a cancellation mid-setup would still spawn a brand-new PTY
        // process just to kill it moments later (Codex review, 2026-08-24).
        if (stopRequested) return;
  
        // Clears the terminal right before the agent's own UI takes over —
        // NOT on the SSE 'connected' frame (reverted design, see
        // attach-cmd.ts's `onAttached` doc comment for why: this is the one
        // moment guaranteed to be before any agent output, regardless of how
        // fast the agent boots or how slow the SSE connect is).
        clearScreen();
  
        // Spawns the local coding agent under a real PTY — this is what
        // launches the user's local session (see docs/YOLOBRIDGE_PLAN.md's
        // "⚠ Not yet functional" section). The PTY's output streams live to
        // this process's own stdout and this process's stdin is piped into
        // the PTY, so the terminal running `attach` is a live view onto the
        // exact session remote prompts land in.
        //
        // Deliberately OUTSIDE the MCP-setup try/catch above and in its own
        // (Codex review, 2026-08-24): an unspawnable agent (missing/
        // non-executable binary — node-pty's `spawn()` throws synchronously,
        // ENOENT) must not be swallowed by `runAttachDaemon`'s own
        // best-effort `onAttached` wrapper, which only logs and continues —
        // that would leave a live, apparently-connected tile with no PTY,
        // waiting forever with nothing able to receive a prompt. Mirrors the
        // real `onExit` handler below: stop + detach immediately rather than
        // let the daemon loop ride out the full heartbeat-staleness window.
        try {
          startLocalAgent({
            agentBin,
            cwd: spawnCwd,
            onExit: ({ exitCode, signal }) => {
              localAgentExited = true;
              stopRequested = true;
              process.stdout.write(
                `\nyolo-bridge: local agent exited (code=${exitCode}${signal ? `, signal=${signal}` : ''}), detaching...\n`,
              );
              // Fire-and-forget: don't wait on the SSE loop to unwind on its own
              // (it only re-checks shouldStop() at loop boundaries) to report the
              // status change — tell the server immediately so the tile flips to
              // `stopped` right away instead of riding out the heartbeat
              // staleness window (~90s, Decision Q2). The daemon loop below still
              // exits promptly too, via `shouldStop`.
              runDetach({ commonApiBaseUrl: apiUrl() }).catch(() => undefined);
            },
          });
        } catch (err) {
          localAgentExited = true;
          stopRequested = true;
          process.stdout.write(
            `\nyolo-bridge: failed to start the local agent (${err instanceof Error ? err.message : String(err)}), detaching...\n`,
          );
          runDetach({ commonApiBaseUrl: apiUrl() }).catch(() => undefined);
        }
      },
    });
  } finally {
    // Codex review, 2026-08-24, round 17: this whole block used to run
    // unconditionally AFTER the `await` above, which only happens if
    // `runAttachFromDisk` actually RESOLVES. If it instead throws (e.g. a
    // reconnect-time fetch inside the daemon loop rejects in a way its own
    // internal handling doesn't catch), the exception skips straight past
    // ALL of this — signal listeners stay attached, the local PTY and the
    // MCP proxy's HTTP server both stay alive, and neither local nor
    // server-side state ever gets cleaned up. `main()`'s own top-level
    // `.catch()` only sets `process.exitCode`, which does NOT force an
    // exit — with the PTY/HTTP server still referenced, the process's
    // event loop has no reason to ever end on its own, leaving the CLI
    // hung indefinitely with a stale attachment and a live local proxy. A
    // `finally` runs this cleanup on EITHER outcome, resolve or reject.
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);

    // Whatever ended the attach loop — local Ctrl+C, a server-initiated
    // `detached` frame, or the agent process exiting on its own — also ends
    // the PTY session `attach` spawned. Safe no-op if it already exited.
    stopLocalAgent();
    // Same "nothing left running detached" discipline for the local MCP
    // proxy: stop the server (drops the delegated token from memory) and
    // remove the .mcp.json entry we added, if we added one. Each step is
    // wrapped individually (Codex review, 2026-08-24, round 12): the removal
    // helpers' own `writeFileSync`/`unlinkSync` calls are unguarded, and an
    // exception from any one of them — a permission change or a full disk
    // mid-session — would otherwise propagate out of this whole cleanup
    // sequence and skip the SERVER-side detach below entirely, leaving the
    // tile live on the server even though the local process is exiting. Local
    // cleanup is best-effort; the server detach is not.
    if (mcpProxyHandle) {
      try {
        await mcpProxyHandle.stop();
      } catch (err) {
        process.stdout.write(`yolo-bridge: local MCP proxy shutdown failed (${err instanceof Error ? err.message : String(err)}).\n`);
      }
    }
    if (mcpTrustRemoval) {
      try {
        removeLocalMcpTrust(spawnCwd, mcpTrustRemoval);
      } catch (err) {
        process.stdout.write(`yolo-bridge: local MCP trust cleanup failed (${err instanceof Error ? err.message : String(err)}).\n`);
      }
    }
    // removeLocalMcpConfig only deletes the entry if its CURRENT value still
    // matches the exact URL captured in mcpConfigCleanup, and only unlinks
    // the whole file if THIS attachment is the one that created it
    // (createdFile) -- an undefined mcpConfigCleanup (nothing was ever
    // successfully written) correctly skips the call.
    if (mcpConfigCleanup) {
      try {
        removeLocalMcpConfig(spawnCwd, mcpConfigCleanup.expectedProxyUrl, mcpConfigCleanup.createdFile);
      } catch (err) {
        process.stdout.write(`yolo-bridge: local MCP config cleanup failed (${err instanceof Error ? err.message : String(err)}).\n`);
      }
    }
  }

  if (!result.ok) {
    if (result.reason === 'not-logged-in') {
      process.stderr.write('yolo-bridge attach: not logged in — run `yolo-bridge login` first.\n');
    } else {
      process.stderr.write(`yolo-bridge attach: ${result.message}\n`);
    }
    // Codex-found gap: `refresh-failed` can fire on a RECONNECT cycle, well
    // after the initial `apiClient.attach` created the server-side
    // attachment and saved attachment.json — this early return used to skip
    // the runDetach() cleanup below (guarded on `result.ok`), leaving a
    // permanent stale attachment behind (the tile never flips to `stopped`,
    // and a later `attach` piles on a second one instead of replacing it).
    // Best-effort and safe even when `refresh-failed` happened on the VERY
    // FIRST refresh (before any attach ever succeeded, so nothing is
    // attached): runDetach() reads local attachment.json first and returns
    // a harmless `not-attached` when there's nothing to clean up. The
    // refresh-buffer window (proactive refresh starts 5min before expiry —
    // see DEFAULT_REFRESH_BUFFER_MS in attach-cmd.ts) means the token used
    // to reach that point is usually still valid for one more request, so
    // this detach call has a real chance of succeeding rather than just
    // failing the same way the refresh did.
    if (result.reason === 'refresh-failed') {
      await runDetach({ commonApiBaseUrl: apiUrl() }).catch(() => undefined);
    }
    return 1;
  }

  if (stopRequested && !localAgentExited) {
    // Local Ctrl+C stop (the agent-exit path above already detached):
    // best-effort tell the server we're leaving too, so the tile flips to
    // stopped promptly instead of waiting out the heartbeat staleness
    // window.
    await runDetach({ commonApiBaseUrl: apiUrl() }).catch(() => undefined);
  }

  process.stdout.write(`yolo-bridge: stopped (${result.reason}).\n`);
  return 0;
}

async function cmdDetach(): Promise<number> {
  const result = await runDetach({ commonApiBaseUrl: apiUrl() });
  if (result.ok) {
    process.stdout.write('Detached.\n');
    return 0;
  }
  process.stderr.write(`yolo-bridge detach: ${result.message}\n`);
  return result.reason === 'not-logged-in' || result.reason === 'not-attached' ? 1 : 1;
}

function cmdStatus(): number {
  process.stdout.write(`${formatStatus(getStatus())}\n`);
  return 0;
}

async function cmdWorkspaces(): Promise<number> {
  const result = await runListWorkspaces({ commonApiBaseUrl: apiUrl() });
  if (!result.ok) {
    if (result.reason === 'not-logged-in') {
      process.stderr.write('yolo-bridge workspaces: not logged in — run `yolo-bridge login` first.\n');
    } else {
      process.stderr.write(`yolo-bridge workspaces: ${result.message}\n`);
    }
    return 1;
  }
  process.stdout.write(`${formatWorkspacesTable(result.workspaces)}\n`);
  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'login':
      return cmdLogin();
    case 'workspaces':
      return cmdWorkspaces();
    case 'attach':
      return cmdAttach(rest);
    case 'detach':
      return cmdDetach();
    case 'status':
      return cmdStatus();
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      return cmd === undefined ? 64 : 0;
    default:
      process.stderr.write(`yolo-bridge: unknown command '${cmd}'\n`);
      printHelp();
      return 64;
  }
}

// Guard direct execution vs. being imported (e.g. by cli.test.ts to reach
// `parseAttachArgs`) — without this, importing this module would run `main`
// against whatever process's argv happened to be doing the importing.
//
// `process.argv[1]` is the RAW path used to invoke node — for a bin entry
// invoked via a symlink (exactly how `npm link` and every real
// `npm install -g` set up a package's bin — never a plain copy), that's the
// symlink's own path, unresolved. `import.meta.url`, on the other hand, is
// resolved by Node's ESM loader THROUGH any symlink to the real underlying
// file. Comparing the two directly therefore NEVER matches under a symlinked
// invocation — this shipped broken: `yolo-bridge` on PATH (via `npm link` or
// a real global install) silently did nothing, exit 0, no output, because
// `main()` never ran. Only `node dist/cli.js <path-to-the-real-file>` (never
// how an installed CLI is actually invoked) happened to pass. Fixed by
// realpath-resolving argv[1] before comparing, so both sides refer to the
// same underlying file regardless of how many symlinks sit in between.
function resolveRealpath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return p; // argv[1] should always exist as a real file when actually running; fall back rather than throw
  }
}
const isMainModule = fileURLToPath(import.meta.url) === resolveRealpath(process.argv[1]);

if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`yolo-bridge: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
