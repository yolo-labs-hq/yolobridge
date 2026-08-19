import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SseFrameParser } from './sse-frame-parser.js';

describe('SseFrameParser', () => {
  it('parses a single complete frame', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.event, 'connected');
    assert.deepEqual(frames[0]!.data, { attachmentId: 'a1', workspaceId: 'w1', timestamp: 't' });
  });

  it('parses multiple frames delivered in one chunk', () => {
    const parser = new SseFrameParser();
    const frames = parser.push(
      'event: ping\ndata: {"t":1}\n\n' + 'event: prompt\ndata: {"attachmentId":"a1","prompt":"do the thing"}\n\n',
    );
    assert.equal(frames.length, 2);
    assert.equal(frames[0]!.event, 'ping');
    assert.equal(frames[1]!.event, 'prompt');
    assert.deepEqual(frames[1]!.data, { attachmentId: 'a1', prompt: 'do the thing' });
  });

  it('reassembles a frame split across chunk boundaries (backpressure case)', () => {
    const parser = new SseFrameParser();
    const first = parser.push('event: read-out');
    assert.equal(first.length, 0);
    const second = parser.push('put\ndata: {"attachmentId":"a1","requestId":"r1"}\n');
    assert.equal(second.length, 0);
    const third = parser.push('\n');
    assert.equal(third.length, 1);
    assert.equal(third[0]!.event, 'read-output');
    assert.deepEqual(third[0]!.data, { attachmentId: 'a1', requestId: 'r1' });
  });

  it('splits a single data: line across a chunk boundary too', () => {
    const parser = new SseFrameParser();
    parser.push('event: prompt\ndata: {"attachmentId":"a1","pro');
    const frames = parser.push('mpt":"hello"}\n\n');
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]!.data, { attachmentId: 'a1', prompt: 'hello' });
  });

  it('defaults event to "message" when no event: line is present', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('data: {"x":1}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.event, 'message');
  });

  it('ignores a blank keepalive block with no data: line', () => {
    const parser = new SseFrameParser();
    const frames = parser.push(': keepalive comment\n\n' + 'event: ping\ndata: {"t":2}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.event, 'ping');
  });

  it('sets data to undefined for a non-JSON payload rather than throwing', () => {
    const parser = new SseFrameParser();
    const frames = parser.push('event: detached\ndata: not-json\n\n');
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.data, undefined);
    assert.equal(frames[0]!.raw, 'not-json');
  });

  it('retains an incomplete trailing frame across many small pushes', () => {
    const parser = new SseFrameParser();
    const text = 'event: detached\ndata: {"attachmentId":"a1"}\n\n';
    let total = 0;
    for (const ch of text) {
      total += parser.push(ch).length;
    }
    assert.equal(total, 1);
  });
});
