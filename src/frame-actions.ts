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
  | { kind: 'read-output'; attachmentId: string; requestId: string }
  | { kind: 'detached'; attachmentId: string }
  | { kind: 'unknown'; event: string };

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
    case 'read-output':
      return {
        kind: 'read-output',
        attachmentId: String(data.attachmentId ?? ''),
        requestId: String(data.requestId ?? ''),
      };
    case 'detached':
      return { kind: 'detached', attachmentId: String(data.attachmentId ?? '') };
    default:
      return { kind: 'unknown', event: frame.event };
  }
}
