#!/usr/bin/env node
/**
 * `yolo-bridge` — YoloBridge local daemon CLI (docs/YOLOBRIDGE_PLAN.md,
 * Implementation Plan → build-order step 5).
 *
 * Subcommands:
 *   yolo-bridge login                 — device-authorization flow (login-cmd.ts)
 *   yolo-bridge attach <workspaceId>  — attach + hold the SSE stream (attach-cmd.ts)
 *   yolo-bridge detach                — DELETE the current attachment (detach-cmd.ts)
 *   yolo-bridge status                — print local login/attach state (status-cmd.ts)
 *
 * Base URLs default to this repo's real hostnames (CLAUDE.md → Project
 * Overview): common-api `https://api.yolo.studio`, auth-service
 * `https://auth.yololabs.ai`. Override with YOLOBRIDGE_API_URL /
 * YOLOBRIDGE_AUTH_URL for local dev against a different environment.
 */

import { runLogin } from './login-cmd.js';
import { runAttachFromDisk } from './attach-cmd.js';
import { runDetach } from './detach-cmd.js';
import { getStatus, formatStatus } from './status-cmd.js';

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
      '  attach <workspaceId>   Attach this machine to a workspace and hold the daemon loop open.',
      '    [--label <name>]     Operator-facing host label (reported to the workspace).',
      '  detach                 Detach the current workspace attachment.',
      '  status                 Print local login/attach state.',
      '  --help                 Print this help.',
      '',
      `API base:  ${apiUrl()} (override: YOLOBRIDGE_API_URL)`,
      `Auth base: ${authUrl()} (override: YOLOBRIDGE_AUTH_URL)`,
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

async function cmdAttach(args: string[]): Promise<number> {
  const workspaceId = args.find((a) => !a.startsWith('--'));
  let hostLabel: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label') hostLabel = args[++i];
  }
  if (!workspaceId) {
    process.stderr.write('yolo-bridge attach: a workspaceId is required\n');
    process.stderr.write('Usage: yolo-bridge attach <workspaceId> [--label <name>]\n');
    return 64;
  }

  let stopRequested = false;
  const onSignal = () => {
    if (stopRequested) return;
    stopRequested = true;
    process.stdout.write('\nyolo-bridge: caught interrupt, detaching...\n');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const result = await runAttachFromDisk({
    workspaceId,
    commonApiBaseUrl: apiUrl(),
    hostLabel,
    shouldStop: () => stopRequested,
  });

  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  if (!result.ok) {
    if (result.reason === 'not-logged-in') {
      process.stderr.write('yolo-bridge attach: not logged in — run `yolo-bridge login` first.\n');
    } else {
      process.stderr.write(`yolo-bridge attach: ${result.message}\n`);
    }
    return 1;
  }

  if (stopRequested) {
    // Local Ctrl+C stop: best-effort tell the server we're leaving too, so
    // the tile flips to stopped promptly instead of waiting out the
    // heartbeat staleness window.
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

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'login':
      return cmdLogin();
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

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`yolo-bridge: unexpected error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 1;
  });
