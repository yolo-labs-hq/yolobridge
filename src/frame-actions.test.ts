import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { actionForFrame } from './frame-actions.js';
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

  it('maps read-output', () => {
    const action = actionForFrame(frame('read-output', { attachmentId: 'a1', requestId: 'r1' }));
    assert.deepEqual(action, { kind: 'read-output', attachmentId: 'a1', requestId: 'r1' });
  });

  it('maps detached', () => {
    const action = actionForFrame(frame('detached', { attachmentId: 'a1' }));
    assert.deepEqual(action, { kind: 'detached', attachmentId: 'a1' });
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
