/**
 * `yolo-bridge attach <workspaceId>` — the daemon loop.
 *
 * Calls `POST .../yolobridge/attach`, then holds `GET .../yolobridge/stream`
 * open: parses SSE frames (sse-frame-parser.ts), dispatches them
 * (frame-actions.ts), reconnects with backoff on disconnect
 * (reconnect.ts), and posts a heartbeat every ~10s while connected
 * (heartbeat.ts). All the pure logic lives in those sibling modules and is
 * unit tested there; this file is the network/process glue that wires
 * them together, plus a light structural test below driving it through a
 * fake in-memory SSE stream.
 *
 * Sleep/wake-aware resilience: see reconnect.ts's header comment — plain
 * bounded exponential backoff is implemented; true OS sleep/wake signal
 * detection is NOT, and is called out there and in the final report as a
 * deliberate scope cut.
 */

import { Readable } from 'node:stream';
import * as readline from 'node:readline';
import { SseFrameParser } from './sse-frame-parser.js';
import { actionForFrame } from './frame-actions.js';
import { startHeartbeat, type HeartbeatScheduler, type TimerImpl } from './heartbeat.js';
import { nextBackoffMs, type BackoffOptions } from './reconnect.js';
import { deliverPromptToLocalAgent, captureLocalAgentOutput } from './local-agent.js';
import * as apiClient from './api-client.js';
import { loadAuth, saveAttachment, clearAttachment, type ConfigStoreIO, type StoredAuth } from './config-store.js';

export interface AttachDaemonDeps {
  workspaceId: string;
  commonApiBaseUrl: string;
  hostLabel?: string;
  auth: StoredAuth;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: apiClient.FetchImpl;
  /** Returns true when the caller wants the loop to stop reconnecting (e.g. SIGINT). */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  backoffOpts?: Partial<BackoffOptions>;
  timers?: TimerImpl;
  log?: (line: string) => void;
  deliverPrompt?: (prompt: string) => Promise<void>;
  captureOutput?: () => Promise<{ output: string; busy: boolean }>;
}

export type AttachDaemonResult =
  | { ok: true; reason: 'detached-by-server' | 'stopped' }
  | { ok: false; reason: 'attach-failed'; message: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runAttachDaemon(deps: AttachDaemonDeps): Promise<AttachDaemonResult> {
  const {
    workspaceId,
    commonApiBaseUrl,
    hostLabel,
    auth,
    env,
    io,
    fetchImpl,
  } = deps;
  const shouldStop = deps.shouldStop ?? (() => false);
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deliverPrompt = deps.deliverPrompt ?? deliverPromptToLocalAgent;
  const captureOutput = deps.captureOutput ?? captureLocalAgentOutput;

  const cfg: apiClient.ApiClientConfig = { commonApiBaseUrl, accessToken: auth.accessToken, fetchImpl };

  let attachmentId: string;
  let tileId: string;
  try {
    const result = await apiClient.attach(cfg, workspaceId, hostLabel);
    attachmentId = result.attachmentId;
    tileId = result.tileId;
  } catch (err) {
    return { ok: false, reason: 'attach-failed', message: err instanceof Error ? err.message : String(err) };
  }

  saveAttachment({ workspaceId, tileId, attachmentId, attachedAt: new Date().toISOString() }, env, io);
  log(`Attached. tileId=${tileId} attachmentId=${attachmentId}`);

  let heartbeat: HeartbeatScheduler | undefined;
  let attempt = 0;

  try {
    while (!shouldStop()) {
      let sawDetached = false;
      try {
        const res = await apiClient.openStream(cfg, workspaceId, attachmentId);
        attempt = 0; // reset backoff on a successful connect

        const parser = new SseFrameParser();
        const nodeStream = Readable.fromWeb(res.body as any);

        for await (const chunk of nodeStream) {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
          for (const frame of parser.push(text)) {
            const action = actionForFrame(frame);
            switch (action.kind) {
              case 'connected':
                log('Stream connected.');
                heartbeat?.stop();
                heartbeat = startHeartbeat(
                  () => apiClient.postHeartbeat(cfg, workspaceId, attachmentId).then(() => undefined),
                  (err) => log(`heartbeat error: ${err instanceof Error ? err.message : String(err)}`),
                  undefined,
                  deps.timers,
                );
                // Send one immediately so status isn't stale for the first ~10s.
                apiClient.postHeartbeat(cfg, workspaceId, attachmentId).catch((err) =>
                  log(`initial heartbeat error: ${err instanceof Error ? err.message : String(err)}`),
                );
                break;
              case 'ping':
                break;
              case 'prompt':
                await deliverPrompt(action.prompt);
                break;
              case 'read-output': {
                const captured = await captureOutput();
                await apiClient
                  .postReadOutputReply(cfg, workspaceId, attachmentId, action.requestId, captured.output, captured.busy)
                  .catch((err) => log(`read-output reply failed: ${err instanceof Error ? err.message : String(err)}`));
                break;
              }
              case 'detached':
                log('Detached by server.');
                sawDetached = true;
                break;
              case 'unknown':
                log(`Unrecognized frame type: ${action.event}`);
                break;
            }
            if (sawDetached) break;
          }
          if (sawDetached) break;
        }
      } catch (err) {
        log(`Stream error: ${err instanceof Error ? err.message : String(err)}`);
      }

      heartbeat?.stop();
      heartbeat = undefined;

      if (sawDetached) {
        clearAttachment(env, io);
        return { ok: true, reason: 'detached-by-server' };
      }
      if (shouldStop()) break;

      attempt += 1;
      const delay = nextBackoffMs(attempt, deps.backoffOpts);
      log(`Reconnecting in ${delay}ms (attempt ${attempt})...`);
      await sleep(delay);
    }
  } finally {
    heartbeat?.stop();
  }

  return { ok: true, reason: 'stopped' };
}

/** Convenience wrapper: loads auth from disk first (used by cli.ts). */
export async function runAttachFromDisk(
  opts: Omit<AttachDaemonDeps, 'auth'>,
): Promise<AttachDaemonResult | { ok: false; reason: 'not-logged-in' }> {
  const auth = loadAuth(opts.env, opts.io);
  if (!auth) return { ok: false, reason: 'not-logged-in' };
  return runAttachDaemon({ ...opts, auth });
}

/**
 * Interactive workspace picker for `yolo-bridge attach` when it's run with
 * no positional workspaceId (--help previously documented it as required;
 * this is an ADDED path, the explicit-ID call site is unchanged). Fetches
 * the caller's own `GET .../workspaces/selectable` list, prints a numbered
 * menu, and reads one line of input for the selection.
 *
 * `prompt` is the injection point that keeps this testable without a real
 * TTY: it defaults to a real `node:readline` prompt over process
 * stdin/stdout, but tests pass a fake that returns a canned answer —
 * same shape as this file's other injected IO (`fetchImpl`, `log`, `io`).
 */
export interface PickWorkspaceDeps {
  commonApiBaseUrl: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: apiClient.FetchImpl;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export type PickWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: 'not-logged-in' }
  | { ok: false; reason: 'list-failed'; message: string }
  | { ok: false; reason: 'no-workspaces' }
  | { ok: false; reason: 'no-selection' };

function defaultPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function pickWorkspaceFromDisk(deps: PickWorkspaceDeps): Promise<PickWorkspaceResult> {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) return { ok: false, reason: 'not-logged-in' };

  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const prompt = deps.prompt ?? defaultPrompt;
  const cfg: apiClient.ApiClientConfig = {
    commonApiBaseUrl: deps.commonApiBaseUrl,
    accessToken: auth.accessToken,
    fetchImpl: deps.fetchImpl,
  };

  let workspaces: apiClient.SelectableWorkspace[];
  try {
    workspaces = await apiClient.listSelectableWorkspaces(cfg);
  } catch (err) {
    return { ok: false, reason: 'list-failed', message: err instanceof Error ? err.message : String(err) };
  }
  if (workspaces.length === 0) return { ok: false, reason: 'no-workspaces' };

  log('Select a workspace to attach:');
  workspaces.forEach((ws, i) => {
    log(`  ${i + 1}. ${ws.name || '(unnamed)'} [${ws.status}]  ${ws.id}`);
  });

  const answer = (await prompt('Enter a number: ')).trim();
  const index = Number.parseInt(answer, 10);
  if (!Number.isInteger(index) || index < 1 || index > workspaces.length) {
    return { ok: false, reason: 'no-selection' };
  }
  return { ok: true, workspaceId: workspaces[index - 1].id };
}
