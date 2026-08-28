#!/usr/bin/env node
/**
 * `yolo-bridge` — YoloBridge local daemon CLI (docs/YOLOBRIDGE_PLAN.md,
 * Implementation Plan → build-order step 5).
 *
 * Subcommands (keep in step with `printHelp` — this list is what a reader of
 * the file sees first, and it silently fell five commands behind before):
 *   yolo-bridge login                 — device-authorization flow (login-cmd.ts)
 *   yolo-bridge workspaces            — list selectable workspaces (workspaces-cmd.ts)
 *   yolo-bridge attach [workspaceId]  — attach + hold the SSE stream (attach-cmd.ts)
 *                                        (omit the id for an interactive picker)
 *   yolo-bridge detach                — DELETE the current attachment (detach-cmd.ts)
 *   yolo-bridge console               — REMOVED in 0.26.0; prints where to go instead
 *   yolo-bridge allow <path>          — approve a path the attached agent may
 *                                        send files from (approved-paths.ts)
 *   yolo-bridge share <path>          — push a local file to the workspace,
 *                                        optionally into a tile (share-cmd.ts)
 *   yolo-bridge deliver <assetId>     — write an ALREADY-shared file into a
 *                                        tile's session (share-cmd.ts)
 *   yolo-bridge status                — print local login/attach state (status-cmd.ts)
 *   yolo-bridge version               — print the installed version (also --version, -v)
 *
 * Base URLs default to this repo's real hostnames (CLAUDE.md → Project
 * Overview): common-api `https://api.yolo.studio`, auth-service
 * `https://auth.yololabs.ai`. Override with YOLOBRIDGE_API_URL /
 * YOLOBRIDGE_AUTH_URL for local dev against a different environment.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { runLogin } from './login-cmd.js';
import { runAttachFromDisk, pickWorkspaceFromDisk } from './attach-cmd.js';
import { runShare, runDeliver } from './share-cmd.js';
import { runAllow } from './approved-paths.js';
import { runDetach } from './detach-cmd.js';
import type { RemoteHostInfo } from './api-client.js';
import { getStatus, formatStatus } from './status-cmd.js';
import { startLocalAgent, stopLocalAgent, DEFAULT_AGENT_BIN } from './local-agent.js';
import { runListWorkspaces, formatWorkspacesTable, type ListWorkspacesResult } from './workspaces-cmd.js';
import { startMcpProxy, mcpUrl, SECRET_ENV_VAR, type McpProxyHandle } from './mcp-proxy.js';
import { startLocalShellServer, type LocalShellServerHandle } from './local-shell-server.js';
import { buildAgentMcpArgs } from './agent-mcp-args.js';

const DEFAULT_API_URL = 'https://api.yolo.studio';
const DEFAULT_WEBAPP_ORIGIN = 'https://yolo.studio';
const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';

/**
 * The ONE browser origin allowed to reach the local terminal server.
 *
 * ⚠️ Never a wildcard: this authorises reaching a shell on the operator's
 * machine, so it is a single exact origin. Overridable only for local
 * development against a different webapp host.
 */
function webappOrigin(): string {
  return process.env.YOLOBRIDGE_WEBAPP_ORIGIN || DEFAULT_WEBAPP_ORIGIN;
}

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
      '    [--fresh]            Always create a NEW attachment and tile. By default an attach that',
      '                         finds a still-live attachment for this workspace on this machine',
      '                         RESUMES it (same tile) instead of adding a duplicate; --fresh skips',
      '                         that check entirely.',
      '  detach                 Detach the current workspace attachment.',
      '  allow <path>           Let the ATTACHED AGENT send files from this path. You type',
      '                         this; nothing in the cloud can. Also --list and --remove <path>.',
      '                         The daemon\'s own working directory is always allowed.',
      '  console                REMOVED in 0.26.0. Use the YoloBridge tile\'s "open terminal"',
      '                         control, which spawns a terminal tile wired to the session.',
      '  share <path>           Share a local file with the attached workspace, so a cloud',
      '                         agent can see it. Push only — nothing reads your disk remotely.',
      '    [--to <tileId>]      Also write it into that tile\'s session, so its agent can open it.',
      '  deliver <assetId>      Write an ALREADY-shared file into a tile\'s session, without',
      '    --to <tileId>        uploading it again. This is the retry path when a share',
      '                         uploaded fine but the delivery failed.',
      '  status                 Print local login/attach state.',
      '  version                Print the installed yolo-bridge version (also --version, -v).',
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
  /** `--fresh` — never resume a stored attachment; always create a new one.
   *  A bare boolean flag, so unlike the three above it consumes no value. */
  fresh?: boolean;
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
  let fresh = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Boolean — handled before the value-taking flags so it never swallows
    // the following argument (`attach --fresh w1` must still see `w1` as the
    // positional workspace id).
    if (a === '--fresh') {
      fresh = true;
      continue;
    }
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
  return { workspaceId, hostLabel, agentBin, agentId, fresh };
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
 *    string, which agent binary this attach drives, and the daemon's own
 *    version — see `RemoteHostInfo.cliVersion` for why that last one is a
 *    capability signal rather than a nicety.
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
  cliVersion?: string;
}): { hostLabel: string | undefined; remoteHost: RemoteHostInfo } {
  const label = input.label?.trim();
  const cliVersion = input.cliVersion?.trim();
  return {
    hostLabel: label || input.hostname.trim() || undefined,
    remoteHost: {
      cwd: input.cwd,
      platform: input.platform,
      agent: input.agent,
      // Omitted rather than sent as 'unknown': a reader must be able to tell
      // "this daemon does not report a version" from "it reports a version it
      // could not determine", and only the first is a reason to hedge.
      ...(cliVersion && cliVersion !== 'unknown' ? { cliVersion } : {}),
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
    process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>] [--agent-id <registryId>] [--fresh]\n');
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
  // The string actually spawned — and therefore the one whose `--help` is
  // authoritative about which flags it accepts (`buildAgentMcpArgs`).
  // `startLocalAgent` applies the same default, so probing anything else
  // would ask the wrong binary.
  const resolvedAgentBin = agentBin ?? DEFAULT_AGENT_BIN;
  const fresh = parsed.fresh === true;
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
      process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>] [--agent-id <registryId>] [--fresh]\n');
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
    cliVersion: readOwnVersion(),
  });
  let mcpProxyHandle: McpProxyHandle | undefined;
  /**
   * Serves terminals on 127.0.0.1 for the tile's "open terminal".
   *
   * ⚠️ SEPARATE FROM THE AGENT PTY. `startLocalAgent` owns the one agent
   * session; this owns any shells the operator opens from the workspace. They
   * share a lifetime — both die with the attach — and nothing else.
   */
  let shellServerHandle: LocalShellServerHandle | undefined;
  // argv fragment pointing the spawned agent at the local MCP proxy, or
  // `[]` when MCP isn't wired in — see `agent-mcp-args.ts`. Nothing else is
  // tracked for cleanup any more: as of 2026-08-26 `attach` writes NOTHING
  // into the project tree, so there is no `.mcp.json` or trust file to
  // remove on the way out (and, more to the point, nothing a `kill -9`
  // could leave behind for the operator's own next `claude` to trip over).
  let agentMcpArgs: string[] = [];

  let result: Awaited<ReturnType<typeof runAttachFromDisk>>;
  try {
    result = await runAttachFromDisk({
      workspaceId,
      commonApiBaseUrl: apiUrl(),
      hostLabel: attachHostInfo.hostLabel,
      remoteHost: attachHostInfo.remoteHost,
      fresh,
      shouldStop: () => stopRequested,
      // Fires once the real tileId exists (docs/YOLOBRIDGE_PLAN.md's "Local
      // MCP access" section) — starts the local MCP proxy and resolves the
      // agent's MCP argv BEFORE spawning it, since both agents read their
      // MCP configuration once, at process launch. A proxy-start failure is
      // logged and skipped, not fatal — MCP access is an enhancement on a
      // tile that already works without it (send_to_tile/read_tile_output
      // are unaffected either way).
      onAttached: async ({ tileId, getAccessToken, clearScreen }) => {
        // Isolated from `startLocalAgent` below on purpose (Codex review,
        // 2026-08-24): `startMcpProxy` itself never throws, but
        // `buildAgentMcpArgs` spawns a real `<bin> --help` probe, and a
        // synchronous throw there (or from anything else added to this
        // block later) would otherwise propagate out of the WHOLE
        // `onAttached` callback (`runAttachDaemon`'s own best-effort wrapper
        // only logs it), and `startLocalAgent` — later in this same
        // callback — never runs. That leaves a daemon holding a live
        // attachment + SSE stream with no local PTY to ever receive a
        // prompt. MCP access is an enhancement on a tile that already works
        // without it; the local agent spawning is not optional.
        try {
          // The local terminal server. Started BEFORE the agent, like the MCP
          // proxy, so the endpoint exists by the time the tile could ask for
          // it. A failure here must not stop the attach: the agent and its
          // tile are the point, a local terminal is an extra.
          try {
            shellServerHandle = await startLocalShellServer({ allowedOrigin: webappOrigin() });
            // ⚠️ THE URL, NEVER THE SECRET. This line lands in the operator's
            // scrollback, which is exactly where things get copied into bug
            // reports and pasted into chats. The secret authorises spawning a
            // shell on this machine; it reaches the tile over the authenticated
            // workspace channel and is printed nowhere.
            process.stdout.write(`yolo-bridge: local terminals ready at ${shellServerHandle.url} (127.0.0.1 only)\n`);
          } catch (err) {
            process.stdout.write(`yolo-bridge: local terminals unavailable (${err instanceof Error ? err.message : String(err)}) — the attach continues without them.\n`);
          }

          mcpProxyHandle = await startMcpProxy({
            apiUrl: apiUrl(),
            getAccessToken,
            workspaceId,
            agentId: resolvedAgentId,
            // Self-identity for the spawned agent: the tile it is running in.
            // Without it, an agent asked to message "the other tile" has to
            // guess which studio_list_tiles row is itself — and a backwards
            // guess sends the prompt into its OWN input.
            callerTileId: tileId,
            // Tools the proxy serves ITSELF (local-mcp-tools.ts). A cloud tool
            // cannot read this machine's disk, so sharing a local file is the
            // one thing that has to be answered here.
            //
            // `implicitRoots` is the directory the daemon was launched in — the
            // project the agent is already working in and can read anyway.
            // Anything outside needs `yolo-bridge allow`.
            localTools: {
              workspaceId,
              implicitRoots: [process.cwd()],
              commonApiBaseUrl: apiUrl(),
            },
            log: (line) => process.stdout.write(`${line}\n`),
          });
          // Command-line MCP configuration, never a file in the project
          // tree (2026-08-26 — replaces `local-mcp-config.ts` +
          // `local-mcp-trust.ts`, both deleted; see `agent-mcp-args.ts`'s
          // header for the full reasoning). The daemon-spawned agent is
          // the ONLY process that could ever have used that config, and it
          // is configured here directly, at spawn — so a `kill -9` or a
          // crash now leaves nothing behind to break the operator's own
          // standalone `claude` in this same directory afterwards.
          //
          // Keyed on `resolvedAgentId`, NOT the raw spawn string (Codex
          // review, round 5): `--agent-id` exists precisely to assert
          // "this really is claude" even when spawned via a nonstandard
          // path or name (`--agent /opt/bin/claude --agent-id claude`).
          // The BINARY is what gets probed for flag support, though — a
          // nonstandard path is exactly the case where the installed
          // build's own `--help` is the only honest source.
          if (mcpProxyHandle) {
            const mcpArgs = buildAgentMcpArgs({
              agentId: resolvedAgentId,
              agentBin: resolvedAgentBin,
              proxyUrl: mcpProxyHandle.url,
            });
            if (mcpArgs.ok) {
              agentMcpArgs = mcpArgs.args;
              // Exported on THIS process's env before `startLocalAgent`
              // spawns the agent below (which inherits it). The real
              // secret only ever exists in memory — the argv both agents
              // receive carries a REFERENCE to this variable
              // (`${SECRET_ENV_VAR}` for claude, `bearer_token_env_var`
              // for codex), never its value, because argv is
              // world-readable via `ps`/`/proc/<pid>/cmdline` while
              // `/proc/<pid>/environ` is owner-only.
              process.env[SECRET_ENV_VAR] = mcpProxyHandle.secret;
            } else {
              // Deliberately does NOT export the secret: nothing in this
              // launch can consume it, and putting a live full-workspace
              // credential into the environment of a process with no way
              // to use it is pure exposure for no benefit.
              process.stdout.write(`yolo-bridge: local MCP is not wired into the agent (${mcpArgs.message}) — the proxy is running at ${mcpProxyHandle.url}, but the agent starts without it rather than with a flag it would reject.\n`);
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
          // Say where Ctrl+C goes BEFORE the agent takes over the screen.
          // Without this the operator presses it expecting to quit, nothing
          // happens, and there is no way to discover why.
          process.stdout.write('yolo-bridge: Ctrl+C goes to the agent · Ctrl-P Ctrl-Q to detach\n');
          startLocalAgent({
            agentBin,
            // Empty unless the MCP block above successfully resolved argv
            // for THIS agent binary — a probe that came back without the
            // flags leaves this `[]`, i.e. a normal launch with no MCP,
            // never a launch carrying a flag the binary would reject.
            agentArgs: agentMcpArgs,
            cwd: spawnCwd,
            // The daemon's only reachable stop key. `process.on('SIGINT')`
            // above cannot fire from the keyboard: stdin is in raw mode so the
            // tty never turns Ctrl+C into a signal, and Ctrl+C is deliberately
            // forwarded to the AGENT instead (interrupting a runaway agent is
            // worth more than quitting the daemon). Same teardown either way.
            onDetachRequested: () => {
              process.stdout.write('\nyolo-bridge: detaching...\n');
              onSignal();
            },
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
    // proxy: stop the server, which drops the delegated token from memory.
    //
    // That is now the ENTIRE local teardown. There is no `.mcp.json` or
    // `.claude/settings.local.json` to remove any more (2026-08-26): the
    // agent's MCP configuration is passed on its command line and dies with
    // its process. The removal helpers this block used to call were the
    // wrong shape of fix — a `finally` cannot run after `kill -9`, a crash,
    // or a reboot, and every skipped run left a file that broke the
    // operator's own standalone `claude` in that directory. Nothing written
    // is nothing to clean up.
    // Same "nothing left running detached" rule as the MCP proxy: a shell the
    // operator opened from the workspace must not outlive the attach that
    // served it. `close()` kills every session it owns.
    if (shellServerHandle) {
      try {
        await shellServerHandle.close();
      } catch (err) {
        process.stdout.write(`yolo-bridge: local terminal shutdown failed (${err instanceof Error ? err.message : String(err)}).\n`);
      }
    }

    if (mcpProxyHandle) {
      try {
        await mcpProxyHandle.stop();
      } catch (err) {
        process.stdout.write(`yolo-bridge: local MCP proxy shutdown failed (${err instanceof Error ? err.message : String(err)}).\n`);
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
    // `credential-rejected` (2026-08-26) joins it for the same reason: it too
    // fires mid-session, long after the attachment was created, so skipping the
    // cleanup would leave the same stale attachment behind. Best-effort in the
    // strongest sense here — the detach call presents the very credential the
    // server just refused, so it will usually fail too; `.catch` swallows that,
    // and the server's own heartbeat-staleness window is the backstop.
    if (result.reason === 'refresh-failed' || result.reason === 'credential-rejected') {
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

/**
 * REMOVED in 0.26.0 — kept as an explicit notice rather than falling through to
 * "unknown command".
 *
 * A command that vanishes without explanation is worse than one that says why:
 * anyone with it in muscle memory or a shell script gets a dead end and no
 * pointer. This costs a few lines and answers the question.
 */
function cmdConsoleRemoved(): number {
  process.stderr.write(
    [
      'yolo-bridge console was removed in 0.26.0.',
      '',
      'Open a terminal from the workspace instead: the YoloBridge tile has an',
      '"open terminal" control that spawns a terminal tile wired to this session.',
      '',
      'It was built for reaching a session from a DIFFERENT machine\'s terminal,',
      'which turned out not to be a use case anyone had. Nothing replaced it',
      'because the tile does the job from the machine you are already on.',
      '',
      'Need it back? `npm i -g @yolo-labs/yolobridge@0.25.0` still has it.',
      '',
    ].join('\n'),
  );
  return 64;
}

async function cmdDeliver(args: string[]): Promise<number> {
  const assetId = args.find((a) => !a.startsWith('-') && a !== args[args.indexOf('--to') + 1]);
  const toIdx = args.indexOf('--to');
  const targetTileId = toIdx >= 0 ? args[toIdx + 1] : undefined;
  if (!assetId || !targetTileId) {
    process.stderr.write('yolo-bridge deliver: usage — yolo-bridge deliver <assetId> --to <tileId>\n');
    return 64;
  }
  const result = await runDeliver(assetId, targetTileId, { commonApiBaseUrl: apiUrl() });
  if (!result.ok) {
    process.stderr.write(`yolo-bridge deliver: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.path}\n`);
  return 0;
}

function cmdAllow(args: string[]): number {
  const result = runAllow(args);
  if (!result.ok) {
    process.stderr.write(`yolo-bridge allow: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  return 0;
}

async function cmdShare(args: string[]): Promise<number> {
  const rawPath = args[0];
  if (!rawPath || rawPath.startsWith('-')) {
    process.stderr.write('yolo-bridge share: a file path is required.\n\n  yolo-bridge share ./cut.mp4\n');
    return 64;
  }
  // `--to <tileId>` also writes the file into that tile's session pod.
  const toIdx = args.indexOf('--to');
  const targetTileId = toIdx >= 0 ? args[toIdx + 1] : undefined;
  if (toIdx >= 0 && (!targetTileId || targetTileId.startsWith('-'))) {
    process.stderr.write('yolo-bridge share: `--to` needs a tile id.\n');
    return 64;
  }
  const result = await runShare(rawPath, { commonApiBaseUrl: apiUrl(), targetTileId });
  if (!result.ok) {
    // Every one of these is an operator-actionable condition, not a bug, so it
    // prints as a sentence with no stack trace.
    process.stderr.write(`yolo-bridge share: ${result.message}\n`);
    return 1;
  }
  if (result.deliveredPath) process.stdout.write(`${result.deliveredPath}\n`);
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

/**
 * This package's own version, read from the package.json that ships beside
 * `dist/`.
 *
 * Resolved from `import.meta.url`, NOT `process.argv[1]`: the global install
 * puts a symlink on PATH, and argv[1] is that symlink's unresolved path, so
 * walking up from it lands outside the package. Same reasoning as
 * `isMainModule` below.
 *
 * Returns `'unknown'` rather than throwing — a version probe must never be the
 * thing that stops the CLI from starting.
 */
export function readOwnVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/cli.js -> package root. Walk up a couple of levels so this holds
    // whether it is run from `dist/` or from a ts-node-style layout.
    for (const rel of ['..', '../..']) {
      const candidate = path.join(here, rel, 'package.json');
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
      if (parsed.name === '@yolo-labs/yolobridge' && typeof parsed.version === 'string') return parsed.version;
    }
  } catch { /* fall through */ }
  return 'unknown';
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
    case 'allow':
      return cmdAllow(rest);
    case 'console':
      return cmdConsoleRemoved();
    case 'deliver':
      return cmdDeliver(rest);
    case 'share':
      return cmdShare(rest);
    case 'status':
      return cmdStatus();
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${readOwnVersion()}\n`);
      return 0;
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
