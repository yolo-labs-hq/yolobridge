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
  it('creates .mcp.json from scratch with the yolo-studio entry', () => {
    const ok = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(ok, true);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp' } } });
  });

  it('preserves other server entries and top-level keys already in the file', () => {
    writeFileSync(mcpJsonPath(), JSON.stringify({
      mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } },
      someOtherTopLevelKey: 'kept',
    }));
    const ok = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(ok, true);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      mcpServers: {
        'my-own-server': { type: 'stdio', command: 'foo' },
        'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp' },
      },
      someOtherTopLevelKey: 'kept',
    });
  });

  it("refuses to overwrite an EXISTING yolo-studio entry, even a stale one from a crashed previous attach (Codex review, 2026-08-24)", () => {
    // A `.mcp.json` shape gives no way to tell "yolo-bridge wrote this
    // last time" apart from "the operator hand-authored their own
    // yolo-studio server" -- they're byte-identical. Overwriting on that
    // ambiguity (the original behavior here) meant a hand-authored entry
    // got silently replaced, AND later deleted by removeLocalMcpConfig on
    // detach, since that function only ever knows "delete the yolo-studio
    // key," not "was this ours." Refusing to touch ANY pre-existing entry
    // trades a rare, self-explaining failure mode (an attach after an
    // earlier crash leaves local MCP access unconfigured until the stale
    // entry is removed by hand) for never silently destroying a user's own
    // config -- the same trade-off local-mcp-trust.ts makes.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:9999/mcp' } } }));
    const ok = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(ok, false);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].url, 'http://127.0.0.1:9999/mcp', 'the existing entry must be left exactly as it was');
  });

  it('returns false and does not overwrite a pre-existing file that is not valid JSON', () => {
    writeFileSync(mcpJsonPath(), 'not json{{{');
    const ok = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(ok, false);
    assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), 'not json{{{');
  });
});

describe('removeLocalMcpConfig', () => {
  it('deletes the file entirely if we created it from scratch (no other content)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.ok(existsSync(mcpJsonPath()));
    removeLocalMcpConfig(dir);
    assert.equal(existsSync(mcpJsonPath()), false);
  });

  it('leaves the file in place, with only our entry removed, when other servers/keys exist', () => {
    writeFileSync(mcpJsonPath(), JSON.stringify({
      mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } },
    }));
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    removeLocalMcpConfig(dir);
    assert.ok(existsSync(mcpJsonPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } } });
  });

  it('is a safe no-op when no .mcp.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpConfig(dir));
  });

  it('leaves an unparseable file alone rather than deleting or rewriting it', () => {
    writeFileSync(mcpJsonPath(), 'not json{{{');
    removeLocalMcpConfig(dir);
    assert.equal(readFileSync(mcpJsonPath(), 'utf-8'), 'not json{{{');
  });
});
