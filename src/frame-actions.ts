/**
 * Pure mapping from a parsed `SseFrame` (sse-frame-parser.ts) to a typed
 * action the attach daemon should take. Kept separate from the actual
 * network/process-lifecycle glue in attach-cmd.ts so the dispatch logic
 * itself — "a `prompt` frame means deliver-then-log, a `read-output`
 * frame means capture-then-reply, a `detached` frame means stop
 * reconnecting" — is unit-testable without a live stream or a real
 * daemon loop.
 */

import type { SseFrame } from './sse-frame-parser.js';

export type DaemonAction =
  | { kind: 'connected'; attachmentId: string; workspaceId: string }
  | { kind: 'ping' }
  | { kind: 'prompt'; attachmentId: string; prompt: string }
  /**
   * Raw keystrokes from a `yolo-bridge console` client, written to the PTY
   * VERBATIM.
   *
   * ⚠️ NOT a prompt. `prompt` is one coherent instruction: it waits for a
   * readiness gate, types the text, pauses, then sends Enter. Input is bytes —
   * a lone `\x03`, half of an arrow-key escape sequence, a character mid-word.
   * Routing it through the prompt path would append an Enter nobody typed and
   * block on a readiness check that never applies.
   */
  | { kind: 'input'; attachmentId: string; data: string }
  /**
   * A screen read. `mode` picks WHICH primitive answers it, and they are not
   * interchangeable:
   *
   *   - `'screen'` (the default, and what an older server sends by omitting
   *     the field) — the serialized headless-terminal buffer. A static text
   *     snapshot: right for `read_tile_output`, where an agent is reading
   *     glyphs, wrong for resuming a live view because it carries no cursor
   *     position, scroll region, alt-screen state or wrap mode.
   *   - `'raw'` — the browser terminal's seed. Answered with the raw PTY byte
   *     tail plus its absolute offsets (local-agent.ts's `takeRawSeed`) so the
   *     viewer's xterm reaches the daemon's state by parsing the same bytes,
   *     with no state reconstruction anywhere. The serialized screen rides
   *     along too, because the viewer's stuck-stream watchdog compares screens.
   */
  | { kind: 'read-output'; attachmentId: string; requestId: string; mode: 'screen' | 'raw' }
  /**
   * DEMAND SIGNAL — "a browser is watching this tile right now, start pushing
   * output" (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming").
   *
   * `leaseMs` is what makes this fail SAFE. The frame is not a latch: it grants
   * permission to stream for a bounded time, and the server re-sends it while
   * demand persists. A daemon whose server replica died, whose SSE went
   * half-open, or that simply never received the matching `output-stream-stop`
   * therefore stops on its own when the lease lapses. The cost of
   * over-streaming is unbounded (every attached laptop uploading its screen
   * forever); the cost of under-streaming is that the tile falls back to the
   * poll that already worked.
   *
   * `streamId` identifies ONE streaming episode. It changes on every start, so
   * a viewer can tell "more of the screen I am already showing" from "a new
   * episode whose first chunk begins mid-screen" and re-seed instead of
   * splicing two sessions' bytes together.
   */
  | { kind: 'output-stream-start'; attachmentId: string; streamId: string; leaseMs: number }
  | { kind: 'output-stream-stop'; attachmentId: string }
  | { kind: 'detached'; attachmentId: string }
  | { kind: 'unknown'; event: string };

/** Lease to assume when a server sends `output-stream-start` without one (or
 *  with a nonsense value). Deliberately short — an unknown lease is a reason to
 *  be conservative, not generous. */
export const FALLBACK_OUTPUT_STREAM_LEASE_MS = 30_000;
/** Upper bound on a server-supplied lease. A buggy or hostile server cannot
 *  talk this daemon into streaming for an hour on one frame. */
export const MAX_OUTPUT_STREAM_LEASE_MS = 5 * 60_000;

export function actionForFrame(frame: SseFrame): DaemonAction {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  switch (frame.event) {
    case 'connected':
      return {
        kind: 'connected',
        attachmentId: String(data.attachmentId ?? ''),
        workspaceId: String(data.workspaceId ?? ''),
      };
    case 'ping':
      return { kind: 'ping' };
    case 'prompt':
      return { kind: 'prompt', attachmentId: String(data.attachmentId ?? ''), prompt: String(data.prompt ?? '') };
    case 'input':
      // No coercion beyond String(): these are the operator's own keystrokes
      // and anything clever here would corrupt a control sequence.
      return { kind: 'input', attachmentId: String(data.attachmentId ?? ''), data: String(data.data ?? '') };
    case 'read-output':
      return {
        kind: 'read-output',
        attachmentId: String(data.attachmentId ?? ''),
        requestId: String(data.requestId ?? ''),
        // Anything unrecognized (including an absent field, which is what a
        // server predating raw seeding sends) means the old screen dump.
        mode: data.mode === 'raw' ? 'raw' : 'screen',
      };
    case 'output-stream-start': {
      const raw = typeof data.leaseMs === 'number' ? data.leaseMs : NaN;
      const leaseMs = Number.isFinite(raw) && raw > 0
        ? Math.min(raw, MAX_OUTPUT_STREAM_LEASE_MS)
        : FALLBACK_OUTPUT_STREAM_LEASE_MS;
      return {
        kind: 'output-stream-start',
        attachmentId: String(data.attachmentId ?? ''),
        streamId: String(data.streamId ?? ''),
        leaseMs,
      };
    }
    case 'output-stream-stop':
      return { kind: 'output-stream-stop', attachmentId: String(data.attachmentId ?? '') };
    case 'detached':
      return { kind: 'detached', attachmentId: String(data.attachmentId ?? '') };
    default:
      return { kind: 'unknown', event: frame.event };
  }
}
