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

import { runLogin } from './login-cmd.js';
import { runAttachFromDisk, pickWorkspaceFromDisk } from './attach-cmd.js';
import { runDetach } from './detach-cmd.js';
import { getStatus, formatStatus } from './status-cmd.js';
import { startLocalAgent, stopLocalAgent, DEFAULT_AGENT_BIN } from './local-agent.js';
import { runListWorkspaces, formatWorkspacesTable } from './workspaces-cmd.js';

const DEFAULT_API_URL = 'https://api.yolo.studio';
const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';

function apiUrl(): string {
  return process.env.YOLOBRIDGE_API_URL || DEFAULT_API_URL;
}

function authUrl(): string {
  return process.env.YOLOBRIDGE_AUTH_URL || DEFAULT_AUTH_URL;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: yolo-bridge <command> [args]',
      '',
      'Commands:',
      '  login                  Device-authorization login against auth-service.',
      '  workspaces             List your own workspaces (id, name, status) that can be attached to.',
      '  attach [workspaceId]   Attach this machine to a workspace and hold the daemon loop open.',
      '                         Omit workspaceId to pick interactively from `yolo-bridge workspaces`.',
      '    [--label <name>]     Operator-facing host label (reported to the workspace).',
      '    [--agent <binary>]   Local coding-agent binary to spawn (default: $YOLOBRIDGE_AGENT_BIN or "claude").',
      '  detach                 Detach the current workspace attachment.',
      '  status                 Print local login/attach state.',
      '  --help                 Print this help.',
      '',
      `API base:   ${apiUrl()} (override: YOLOBRIDGE_API_URL)`,
      `Auth base:  ${authUrl()} (override: YOLOBRIDGE_AUTH_URL)`,
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
}

export interface AttachArgsError {
  error: string;
}

/**
 * Parses `attach`'s argv into its recognized `--label <name>` / `--agent
 * <binary>` flag pairs plus a leftover positional workspaceId — consuming
 * each flag's value together with the flag itself *before* deciding what's
 * left over for the positional, so e.g. `attach --label laptop` doesn't
 * mistake "laptop" for a workspace id (it should still fall through to the
 * interactive picker). An unrecognized `--something` is a hard error rather
 * than being silently swallowed as some other flag's value.
 */
export function parseAttachArgs(args: string[]): AttachArgs | AttachArgsError {
  let workspaceId: string | undefined;
  let hostLabel: string | undefined;
  let agentBin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label' || a === '--agent') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${a} requires a value` };
      }
      if (a === '--label') hostLabel = value;
      else agentBin = value;
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
  return { workspaceId, hostLabel, agentBin };
}

async function cmdAttach(args: string[]): Promise<number> {
  const parsed = parseAttachArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`yolo-bridge attach: ${parsed.error}\n`);
    process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>]\n');
    return 64;
  }
  let workspaceId = parsed.workspaceId;
  const hostLabel = parsed.hostLabel;
  const agentBin = parsed.agentBin;
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
      process.stderr.write('Usage: yolo-bridge attach [workspaceId] [--label <name>] [--agent <binary>]\n');
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

  // Spawns the local coding agent under a real PTY right away — this
  // command is what launches the user's local session (see
  // docs/YOLOBRIDGE_PLAN.md's "⚠ Not yet functional" section). The PTY's
  // output streams live to this process's own stdout and this process's
  // stdin is piped into the PTY, so the terminal running `attach` is a
  // live view onto the exact session remote prompts land in.
  startLocalAgent({
    agentBin,
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

  const result = await runAttachFromDisk({
    workspaceId,
    commonApiBaseUrl: apiUrl(),
    hostLabel,
    shouldStop: () => stopRequested,
  });

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  // Whatever ended the attach loop — local Ctrl+C, a server-initiated
  // `detached` frame, or the agent process exiting on its own — also ends
  // the PTY session `attach` spawned. Safe no-op if it already exited.
  stopLocalAgent();

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
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

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
