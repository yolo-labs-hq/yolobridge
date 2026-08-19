import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runAttachDaemon, pickWorkspaceFromDisk } from './attach-cmd.js';
import { loadAttachment, saveAuth, type ConfigStoreIO, type StoredAuth } from './config-store.js';

const ENV = { HOME: '/home/yolo' };
const AUTH: StoredAuth = { accessToken: 'at', refreshToken: 'rt', tokenType: 'Bearer', expiresAtMs: Date.now() + 3600_000 };

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p) => files.get(p),
    writeFile: (p, contents) => { files.set(p, contents); },
    removeFile: (p) => { files.delete(p); },
  };
}

function sseStreamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('runAttachDaemon', () => {
  it('attaches, delivers a prompt frame, and exits cleanly on a server-initiated detach', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: prompt\ndata: {"attachmentId":"a1","prompt":"hello there"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    const requests: string[] = [];
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      requests.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, { tileId: 'tile-1', attachmentId: 'a1' });
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) return jsonResponse(200, { recorded: true });
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const io = fakeIO();
    const delivered: string[] = [];
    const logs: string[] = [];

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io,
      fetchImpl,
      log: (line) => logs.push(line),
      deliverPrompt: async (prompt) => { delivered.push(prompt); },
      captureOutput: async () => ({ output: 'unused', busy: false }),
      shouldStop: () => false,
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(delivered, ['hello there']);
    assert.equal(loadAttachment(ENV, io), undefined, 'attachment record should be cleared after server-initiated detach');
    assert.ok(requests.some((r) => r.startsWith('POST') && r.includes('/yolobridge/attach')));
    assert.ok(requests.some((r) => r.includes('/yolobridge/stream?attachmentId=a1')));
  });

  it('returns attach-failed without opening a stream when attach itself fails', async () => {
    const fetchImpl = (async (url: any) => {
      if (String(url).endsWith('/yolobridge/attach')) {
        return jsonResponse(403, { error: 'Workspace access denied', code: 'FORBIDDEN' });
      }
      throw new Error('should not reach the stream endpoint');
    }) as any;

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'attach-failed');
      assert.match(result.message, /Workspace access denied/);
    }
  });

  it('answers a read-output frame by posting a read-output-reply with the stub capture', async () => {
    const sse =
      'event: connected\ndata: {"attachmentId":"a1","workspaceId":"w1","timestamp":"t"}\n\n' +
      'event: read-output\ndata: {"attachmentId":"a1","requestId":"req-1"}\n\n' +
      'event: detached\ndata: {"attachmentId":"a1"}\n\n';

    let replyBody: any;
    const fetchImpl = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/yolobridge/attach')) return jsonResponse(201, { tileId: 'tile-1', attachmentId: 'a1' });
      if (u.includes('/yolobridge/stream')) return sseStreamResponse(sse);
      if (u.endsWith('/yolobridge/events')) {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        if (parsed.type === 'read-output-reply') replyBody = parsed;
        return jsonResponse(200, { recorded: true, resolved: true });
      }
      throw new Error(`unexpected request: ${u}`);
    }) as any;

    const result = await runAttachDaemon({
      workspaceId: 'w1',
      commonApiBaseUrl: 'https://api.example.com',
      auth: AUTH,
      env: ENV,
      io: fakeIO(),
      fetchImpl,
      log: () => {},
      captureOutput: async () => ({ output: 'stub output', busy: true }),
    });

    assert.deepEqual(result, { ok: true, reason: 'detached-by-server' });
    assert.deepEqual(replyBody, { attachmentId: 'a1', type: 'read-output-reply', requestId: 'req-1', output: 'stub output', busy: true });
  });
});

describe('pickWorkspaceFromDisk', () => {
  it('fails fast when not logged in, without ever calling the fake prompt', async () => {
    const io = fakeIO();
    let promptCalled = false;
    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      prompt: async () => { promptCalled = true; return '1'; },
    });
    assert.deepEqual(result, { ok: false, reason: 'not-logged-in' });
    assert.equal(promptCalled, false);
  });

  it('lists selectable workspaces, prompts, and resolves the chosen index to a workspaceId', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async (url: any) => {
      assert.equal(String(url), 'https://api.example.com/v1/workspaces/selectable');
      return jsonResponse(200, {
        workspaces: [
          { id: 'w1', name: 'Alpha', status: 'running' },
          { id: 'w2', name: 'Beta', status: 'paused' },
        ],
      });
    }) as any;

    const logs: string[] = [];
    const questions: string[] = [];
    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: (line) => logs.push(line),
      prompt: async (q) => { questions.push(q); return '2'; },
    });

    assert.deepEqual(result, { ok: true, workspaceId: 'w2' });
    assert.equal(questions.length, 1);
    assert.ok(logs.some((l) => l.includes('Alpha') && l.includes('running') && l.includes('w1')));
    assert.ok(logs.some((l) => l.includes('Beta') && l.includes('paused') && l.includes('w2')));
  });

  it('reports no-workspaces without prompting when the list is empty', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [] })) as any;
    let promptCalled = false;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => { promptCalled = true; return '1'; },
    });

    assert.deepEqual(result, { ok: false, reason: 'no-workspaces' });
    assert.equal(promptCalled, false);
  });

  it('rejects an out-of-range or non-numeric selection as no-selection', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(200, { workspaces: [{ id: 'w1', name: 'Alpha', status: 'running' }] })) as any;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => 'not-a-number',
    });

    assert.deepEqual(result, { ok: false, reason: 'no-selection' });
  });

  it('surfaces a list failure as list-failed with the underlying message', async () => {
    const io = fakeIO();
    saveAuth(AUTH, ENV, io);
    const fetchImpl = (async () => jsonResponse(500, { error: 'boom' })) as any;

    const result = await pickWorkspaceFromDisk({
      commonApiBaseUrl: 'https://api.example.com',
      env: ENV,
      io,
      fetchImpl,
      log: () => {},
      prompt: async () => '1',
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'list-failed');
      assert.match((result as any).message, /boom/);
    }
  });
});
