import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLocalMcpConfig, removeLocalMcpConfig } from './local-mcp-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-mcp-config-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mcpJsonPath(): string {
  return join(dir, '.mcp.json');
}

describe('writeLocalMcpConfig', () => {
  it('creates .mcp.json from scratch with the yolo-studio entry, marked as ours', () => {
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: true });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp', _yolobridge: true } } });
  });

  it('preserves other server entries and top-level keys already in the file, and reports createdFile:false', () => {
    writeFileSync(mcpJsonPath(), JSON.stringify({
      mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } },
      someOtherTopLevelKey: 'kept',
    }));
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      mcpServers: {
        'my-own-server': { type: 'stdio', command: 'foo' },
        'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp', _yolobridge: true },
      },
      someOtherTopLevelKey: 'kept',
    });
  });

  it("refuses to overwrite an EXISTING yolo-studio entry with no ownership marker -- real hand-authored config, including one that happens to use a loopback URL (Codex review, 2026-08-24, round 7)", () => {
    // Round 6 tried a URL-shape heuristic (loopback URL = probably ours).
    // Round 7 correctly pointed out a legitimate hand-authored entry for
    // LOCAL DEVELOPMENT can have that exact shape too -- URL shape alone
    // can't establish ownership. Only the explicit `_yolobridge` marker
    // can, and a hand-authored entry has no reason to carry it, regardless
    // of what URL it points at.
    for (const url of ['https://services.yolo.studio/mcp', 'http://127.0.0.1:9999/mcp']) {
      writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url } } }));
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.deepEqual(result, { ok: false, createdFile: false }, `expected refusal for unmarked url: ${url}`);
      const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
      assert.equal(parsed.mcpServers['yolo-studio'].url, url, 'the existing entry must be left exactly as it was');
    }
  });

  it("overwrites a STALE entry left behind by an uncleanly-terminated previous attach, identified by its _yolobridge marker (Codex review, 2026-08-24, round 6 + round 7)", () => {
    // The entry carries the marker THIS module itself writes -- almost
    // certainly ours, from a session that exited via SIGKILL/crash/reboot
    // and never reached its own removeLocalMcpConfig call, not a
    // hand-authored config. Refusing unconditionally (the original round-2
    // fix) would brick local MCP access on every subsequent attach until
    // the operator manually edited the file.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:9999/mcp', _yolobridge: true } } }));
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed.mcpServers['yolo-studio'], { type: 'http', url: 'http://127.0.0.1:4123/mcp', _yolobridge: true });
  });

  it("does NOT reclaim an entry that still carries the marker but was EDITED to point somewhere non-loopback while an attachment was running (Codex review, 2026-08-24, round 8)", () => {
    // The operator changed the URL to their own real server while attach
    // #1 was still running, without knowing to also strip the marker they
    // don't know exists. A marker-only check would have the NEXT attach
    // overwrite that intentional edit as though it were stale daemon
    // state -- requiring the shape to STILL look loopback-generated closes
    // that gap.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url: 'https://my-own-real-server.example.com/mcp', _yolobridge: true } } }));
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].url, 'https://my-own-real-server.example.com/mcp', "the operator's edit must be left exactly as it was");
  });

  it('returns ok:false and does not overwrite a pre-existing file that is not valid JSON', () => {
    writeFileSync(mcpJsonPath(), 'not json{{{');
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), 'not json{{{');
  });

  it('returns ok:false and does not touch a pre-existing file whose JSON root is an array or other non-object (Codex review, 2026-08-24)', () => {
    // `typeof [] === 'object'` -- a naive `typeof parsed === 'object'` check
    // (the original bug here) would have cast an array straight into
    // Record<string, unknown> and silently corrupted it on write.
    for (const content of ['[1,2,3]', 'null', '42', '"a string"']) {
      writeFileSync(mcpJsonPath(), content);
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.equal(result.ok, false, `expected refusal for root content: ${content}`);
      assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), content, `file must be untouched for root content: ${content}`);
    }
  });

  it('returns ok:false and does not touch a pre-existing file whose mcpServers value is malformed (array or a primitive) (Codex review, 2026-08-24, round 2)', () => {
    // Same class of bug one level deeper: `typeof [] === 'object'` also
    // passed the OLD nested-value check, so an array `mcpServers` would
    // have had SERVER_NAME assigned as a non-index property (silently
    // dropped by JSON.stringify) while still reporting ok:true; a
    // primitive mcpServers (e.g. a string) would have been silently
    // replaced with a fresh {}, discarding it.
    for (const mcpServers of ['[1,2,3]', '"a string"', '42']) {
      writeFileSync(mcpJsonPath(), `{"mcpServers":${mcpServers}}`);
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.equal(result.ok, false, `expected refusal for mcpServers: ${mcpServers}`);
      assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), `{"mcpServers":${mcpServers}}`, `file must be untouched for mcpServers: ${mcpServers}`);
    }
  });
});

describe('removeLocalMcpConfig', () => {
  it('deletes the file entirely if we created it from scratch (no other content)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.ok(existsSync(mcpJsonPath()));
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(existsSync(mcpJsonPath()), false);
  });

  it('leaves the file in place, with only our entry removed, when other servers/keys exist', () => {
    writeFileSync(mcpJsonPath(), JSON.stringify({
      mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } },
    }));
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', false);
    assert.ok(existsSync(mcpJsonPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } } });
  });

  it('is a safe no-op when no .mcp.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true));
  });

  it('leaves an unparseable file alone rather than deleting or rewriting it', () => {
    writeFileSync(mcpJsonPath(), 'not json{{{');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), 'not json{{{');
  });

  it('leaves a file with a non-object JSON root (array/null/scalar) alone too (Codex review, 2026-08-24)', () => {
    writeFileSync(mcpJsonPath(), '[1,2,3]');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), '[1,2,3]');
  });

  it('does NOT delete the entry if its value changed since this attachment wrote it (Codex review, 2026-08-24, round 5)', () => {
    // Simulates a long-running attachment where the operator (or another
    // `claude mcp add`/hand edit) replaced the yolo-studio entry with
    // something else entirely in between attach and detach. Blind deletion
    // keyed only on "did we create this key originally" would destroy that
    // newer, unrelated edit.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'] = { type: 'stdio', command: 'something-else-entirely' };
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);

    const after = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(after.mcpServers['yolo-studio'], { type: 'stdio', command: 'something-else-entirely' });
  });

  it('DOES delete the entry when its value still exactly matches what this attachment wrote', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(existsSync(mcpJsonPath()), false);
  });

  it('does NOT delete when a DIFFERENT proxy URL is passed than what was actually written (a new attach cycle must not clean up a stale one)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp', true);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].url, 'http://127.0.0.1:4123/mcp');
  });

  it('does NOT unlink a pre-existing (createdFile:false) file even when removing our entry leaves it empty (Codex review, 2026-08-24, round 6)', () => {
    // The repo already had an empty .mcp.json (or {"mcpServers":{}}) before
    // this attach ever touched it -- emptiness after removal looks
    // identical to "we created this from scratch," but createdFile:false
    // says otherwise, and the operator's (empty) file must survive.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: {} }));
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: false });
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', result.createdFile);
    assert.ok(existsSync(mcpJsonPath()), 'the pre-existing file must survive, even though it is now empty');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: {} });
  });

  it('does NOT delete an entry that matches the URL but lacks the ownership marker (a foreign entry someone else pointed at the same port coincidentally)', () => {
    // Belt-and-suspenders: even an exact URL match isn't enough by itself
    // (Codex review, 2026-08-24, round 7's reasoning applied symmetrically
    // to the remove path) -- require the marker too.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp' } } }));
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', false);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed.mcpServers['yolo-studio'], { type: 'http', url: 'http://127.0.0.1:4123/mcp' });
  });
});
