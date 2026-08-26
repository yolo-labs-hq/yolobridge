import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  actionForFrame,
  FALLBACK_OUTPUT_STREAM_LEASE_MS,
  MAX_OUTPUT_STREAM_LEASE_MS,
} from './frame-actions.js';
import type { SseFrame } from './sse-frame-parser.js';

function frame(event: string, data: unknown): SseFrame {
  return { event, data, raw: JSON.stringify(data) };
}

describe('actionForFrame', () => {
  it('maps connected', () => {
    const action = actionForFrame(frame('connected', { attachmentId: 'a1', workspaceId: 'w1', timestamp: 't' }));
    assert.deepEqual(action, { kind: 'connected', attachmentId: 'a1', workspaceId: 'w1' });
  });

  it('maps ping', () => {
    assert.deepEqual(actionForFrame(frame('ping', { t: 123 })), { kind: 'ping' });
  });

  it('maps prompt', () => {
    const action = actionForFrame(frame('prompt', { attachmentId: 'a1', prompt: 'hello world' }));
    assert.deepEqual(action, { kind: 'prompt', attachmentId: 'a1', prompt: 'hello world' });
  });

  it('maps read-output with mode: raw', () => {
    const action = actionForFrame(frame('read-output', { attachmentId: 'a1', requestId: 'r1', mode: 'raw' }));
    assert.deepEqual(action, { kind: 'read-output', attachmentId: 'a1', requestId: 'r1', mode: 'raw' });
  });

  it('treats an unrecognized read-output mode as the screen dump', () => {
    const action = actionForFrame(frame('read-output', { attachmentId: 'a1', requestId: 'r1', mode: 'nonsense' }));
    assert.equal(action.kind === 'read-output' && action.mode, 'screen');
  });

  it('maps read-output', () => {
    const action = actionForFrame(frame('read-output', { attachmentId: 'a1', requestId: 'r1' }));
    // No `mode` on the wire is a server that predates raw seeding — the old
    // serialized-screen answer, never the raw one.
    assert.deepEqual(action, { kind: 'read-output', attachmentId: 'a1', requestId: 'r1', mode: 'screen' });
  });

  it('maps detached', () => {
    const action = actionForFrame(frame('detached', { attachmentId: 'a1' }));
    assert.deepEqual(action, { kind: 'detached', attachmentId: 'a1' });
  });

  it('maps output-stream-start, carrying the streamId and the lease', () => {
    const action = actionForFrame(
      frame('output-stream-start', { attachmentId: 'a1', streamId: 's1', leaseMs: 30_000 }),
    );
    assert.deepEqual(action, { kind: 'output-stream-start', attachmentId: 'a1', streamId: 's1', leaseMs: 30_000 });
  });

  it('falls back to a SHORT lease when the server names none — an unknown grant is a reason to be conservative', () => {
    for (const bad of [undefined, 0, -1, 'soon', Number.NaN]) {
      const action = actionForFrame(frame('output-stream-start', { attachmentId: 'a1', streamId: 's1', leaseMs: bad }));
      assert.deepEqual(
        action,
        { kind: 'output-stream-start', attachmentId: 'a1', streamId: 's1', leaseMs: FALLBACK_OUTPUT_STREAM_LEASE_MS },
        `leaseMs=${String(bad)}`,
      );
    }
  });

  it('CLAMPS an absurd lease — no single frame can buy an hour of streaming', () => {
    const action = actionForFrame(
      frame('output-stream-start', { attachmentId: 'a1', streamId: 's1', leaseMs: 24 * 60 * 60_000 }),
    );
    assert.equal(
      (action as { leaseMs: number }).leaseMs,
      MAX_OUTPUT_STREAM_LEASE_MS,
      'a buggy or hostile server must not be able to extend the grant without bound',
    );
  });

  it('maps output-stream-stop', () => {
    const action = actionForFrame(frame('output-stream-stop', { attachmentId: 'a1' }));
    assert.deepEqual(action, { kind: 'output-stream-stop', attachmentId: 'a1' });
  });

  it('maps an unrecognized event to unknown without throwing', () => {
    const action = actionForFrame(frame('something-new', { x: 1 }));
    assert.deepEqual(action, { kind: 'unknown', event: 'something-new' });
  });

  it('tolerates a frame whose data failed to JSON.parse (undefined)', () => {
    const action = actionForFrame({ event: 'prompt', data: undefined, raw: 'not-json' });
    assert.deepEqual(action, { kind: 'prompt', attachmentId: '', prompt: '' });
  });
});
