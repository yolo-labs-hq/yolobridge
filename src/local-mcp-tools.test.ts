/**
 * Tools the daemon serves itself. Two properties carry the weight:
 * a local call is NEVER forwarded to the cloud, and the upload opens the
 * RESOLVED path the approval check returned rather than the string the agent
 * passed (an in-tree symlink can be repointed between check and read).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  interceptLocalTools,
  runLocalToolCall,
  isLocalToolCall,
  augmentToolsList,
  SHARE_FILE_TOOL,
  LOCAL_TOOL_DEFINITIONS,
  type LocalToolContext,
} from './local-mcp-tools.js';

function ctx(over: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    workspaceId: 'ws1',
    implicitRoots: ['/project'],
    commonApiBaseUrl: 'https://api.example',
    checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
    shareImpl: (async () => ({ ok: true, assetId: 'asset-7' })) as any,
    ...over,
  };
}

function callBody(args: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: SHARE_FILE_TOOL, arguments: args } });
}

describe('isLocalToolCall', () => {
  it('matches our tool and nothing else', () => {
    assert.equal(isLocalToolCall({ method: 'tools/call', params: { name: SHARE_FILE_TOOL } }), true);
    assert.equal(isLocalToolCall({ method: 'tools/call', params: { name: 'studio_list_tiles' } }), false);
    assert.equal(isLocalToolCall({ method: 'tools/list' }), false);
    assert.equal(isLocalToolCall(null), false);
  });
});

describe('share_file — the resolved-path property', () => {
  it('uploads the RESOLVED path, never the string the agent passed', async () => {
    const seen: string[] = [];
    const c = ctx({
      checkImpl: (() => ({ approved: true, resolvedPath: '/project/real.mp4', root: '/project' })) as any,
      shareImpl: (async (p: string) => { seen.push(p); return { ok: true, assetId: 'a1' }; }) as any,
    });
    await runLocalToolCall(
      { id: 1, params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/link.mp4' } } },
      c,
    );
    assert.deepEqual(seen, ['/project/real.mp4'], 'must open what the check resolved');
    assert.ok(!seen.includes('/project/link.mp4'));
  });

  it('refuses an unapproved path and uploads NOTHING', async () => {
    let called = false;
    const c = ctx({
      checkImpl: (() => ({ approved: false, reason: 'outside every approved path' })) as any,
      shareImpl: (async () => { called = true; return { ok: true, assetId: 'x' }; }) as any,
    });
    const res: any = await runLocalToolCall(
      { id: 1, params: { name: SHARE_FILE_TOOL, arguments: { path: '/etc/passwd' } } }, c,
    );
    assert.equal(called, false, 'no upload may be attempted for a refused path');
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /outside every approved path/);
  });

  it('refuses when the check approves but hands back no resolved path', async () => {
    // Fail closed: an approval without a canonical path is not actionable.
    let called = false;
    const c = ctx({
      checkImpl: (() => ({ approved: true })) as any,
      shareImpl: (async () => { called = true; return { ok: true, assetId: 'x' }; }) as any,
    });
    const res: any = await runLocalToolCall(
      { id: 1, params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/x' } } }, c,
    );
    assert.equal(called, false);
    assert.equal(res.result.isError, true);
  });

  it('reports an upload failure as a tool error, not a protocol fault', async () => {
    const c = ctx({ shareImpl: (async () => { throw new Error('R2 exploded'); }) as any });
    const res: any = await runLocalToolCall(
      { id: 1, params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/x' } } }, c,
    );
    assert.equal(res.result.isError, true);
    assert.equal(res.error, undefined, 'a refused/failed share is a normal answer the agent should read');
  });

  it('requires a path', async () => {
    const res: any = await runLocalToolCall({ id: 1, params: { name: SHARE_FILE_TOOL, arguments: {} } }, ctx());
    assert.equal(res.result.isError, true);
  });
});

describe('interceptLocalTools', () => {
  it('answers a lone local call with NOTHING left to forward', async () => {
    const out = await interceptLocalTools(callBody({ path: '/project/a.mp4' }), ctx());
    assert.ok(out);
    assert.equal(out!.forwardBody, undefined, 'a local call must never reach the cloud');
    assert.ok(out!.localResponse);
  });

  it('passes an ordinary cloud call straight through', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } });
    assert.equal(await interceptLocalTools(body, ctx()), undefined);
  });

  it('ignores a body that is not JSON', async () => {
    assert.equal(await interceptLocalTools('not json', ctx()), undefined);
  });

  it('splits a MIXED batch — neither half may be lost', async () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'studio_list_tiles' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/a' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'studio_read_file' } },
    ]);
    const out = await interceptLocalTools(batch, ctx());
    assert.ok(out);
    const forwarded = JSON.parse(out!.forwardBody!);
    assert.deepEqual(forwarded.map((m: any) => m.id), [1, 3], 'cloud half forwarded');
    const local = JSON.parse(out!.localResponse!);
    assert.deepEqual(local.map((m: any) => m.id), [2], 'local half answered here');
  });

  it('forwards nothing when a batch is entirely local', async () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/a' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/b' } } },
    ]);
    const out = await interceptLocalTools(batch, ctx());
    assert.equal(out!.forwardBody, undefined);
    assert.equal(JSON.parse(out!.localResponse!).length, 2);
  });
});

describe('augmentToolsList', () => {
  const listReq = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' });

  it('adds our tools alongside the cloud ones', () => {
    const upstream = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'studio_list_tiles' }] } });
    const names = JSON.parse(augmentToolsList(listReq, upstream)).result.tools.map((t: any) => t.name);
    assert.ok(names.includes('studio_list_tiles'), 'cloud tools survive');
    assert.ok(names.includes(SHARE_FILE_TOOL));
  });

  it('does not duplicate on a repeated list', () => {
    const upstream = JSON.stringify({
      jsonrpc: '2.0', id: 9, result: { tools: [{ name: SHARE_FILE_TOOL }] },
    });
    const names = JSON.parse(augmentToolsList(listReq, upstream)).result.tools.map((t: any) => t.name);
    assert.equal(names.filter((n: string) => n === SHARE_FILE_TOOL).length, 1);
  });

  it('leaves a non-list reply alone', () => {
    const other = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { ok: true } });
    assert.equal(augmentToolsList(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call' }), other), other);
  });

  it('passes an unparseable or error-shaped upstream reply through untouched', () => {
    assert.equal(augmentToolsList(listReq, '<html>502</html>'), '<html>502</html>');
    const err = JSON.stringify({ jsonrpc: '2.0', id: 9, error: { code: -32000, message: 'nope' } });
    assert.equal(augmentToolsList(listReq, err), err);
  });

  it('every advertised tool declares a schema an agent can call', () => {
    for (const def of LOCAL_TOOL_DEFINITIONS) {
      assert.ok(def.name && def.description);
      assert.equal(def.inputSchema.type, 'object');
      assert.ok(def.inputSchema.required.length > 0);
    }
  });
});

describe('JSON-RPC notifications and paginated discovery', () => {
  it('performs the work but sends NO response for a call with no id', async () => {
    // A message without `id` is a notification: do it, say nothing. Coercing a
    // missing id to null would inject a spurious `id: null` into a batch.
    const shared: string[] = [];
    const c = ctx({ shareImpl: (async (p: string) => { shared.push(p); return { ok: true, assetId: 'a1' }; }) as any });
    const res = await runLocalToolCall(
      { params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/a.mp4' } } } as any, c,
    );
    assert.equal(res, undefined, 'a notification must not be answered');
    assert.deepEqual(shared, ['/project/real.mp4'], 'but the work still happens');
  });

  it('DOES answer an explicit null id — absent and null are different things', async () => {
    const res: any = await runLocalToolCall(
      { id: null, params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/a.mp4' } } } as any, ctx(),
    );
    assert.ok(res, 'an explicit null id is a request, not a notification');
    assert.equal(res.id, null);
  });

  it('leaves nothing to send when a batch is local notifications only', async () => {
    const batch = JSON.stringify([
      { jsonrpc: '2.0', method: 'tools/call', params: { name: SHARE_FILE_TOOL, arguments: { path: '/project/a' } } },
    ]);
    const out = await interceptLocalTools(batch, ctx());
    assert.ok(out);
    assert.equal(out!.forwardBody, undefined);
    assert.equal(out!.localResponse, undefined, 'no body may be produced for notifications');
  });

  it('advertises the local tools on ONE page of a paginated tools/list', async () => {
    const req = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    // A non-final page carries nextCursor — appending here would duplicate the
    // tool once the client aggregates every page.
    const page1 = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'a' }], nextCursor: 'c1' } });
    const out1 = JSON.parse(augmentToolsList(req, page1));
    assert.deepEqual(out1.result.tools.map((t: any) => t.name), ['a'], 'no local tools on a non-final page');

    const last = JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'b' }] } });
    const out2 = JSON.parse(augmentToolsList(req, last));
    assert.ok(out2.result.tools.some((t: any) => t.name === SHARE_FILE_TOOL), 'and exactly once on the final page');
  });
});
