import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLocalMcpTrust, removeLocalMcpTrust } from './local-mcp-trust.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-mcp-trust-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(dir, '.claude', 'settings.json');
}

describe('writeLocalMcpTrust', () => {
  it('creates .claude/settings.json from scratch with both approval layers', () => {
    const ok = writeLocalMcpTrust(dir);
    assert.equal(ok, true);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__.*'] },
    });
  });

  it('creates the .claude directory if it does not exist yet', () => {
    assert.equal(existsSync(join(dir, '.claude')), false);
    writeLocalMcpTrust(dir);
    assert.ok(existsSync(join(dir, '.claude')));
  });

  it("preserves the user's own enabledMcpjsonServers entries, permission rules, and unrelated top-level keys", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
      someOtherTopLevelKey: 'kept',
    }));
    const ok = writeLocalMcpTrust(dir);
    assert.equal(ok, true);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server', 'yolo-studio'],
      permissions: { allow: ['Bash(git *)', 'mcp__yolo-studio__.*'], deny: ['Bash(rm -rf *)'] },
      someOtherTopLevelKey: 'kept',
    });
  });

  it('is idempotent -- calling it twice does not duplicate entries', () => {
    writeLocalMcpTrust(dir);
    writeLocalMcpTrust(dir);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed.enabledMcpjsonServers, ['yolo-studio']);
    assert.deepEqual(parsed.permissions.allow, ['mcp__yolo-studio__.*']);
  });

  it('returns false and does not overwrite a pre-existing file that is not valid JSON', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json{{{');
    const ok = writeLocalMcpTrust(dir);
    assert.equal(ok, false);
    assert.equal(readFileSync(settingsPath(), 'utf-8'), 'not json{{{');
  });
});

describe('removeLocalMcpTrust', () => {
  it('deletes the file entirely if we created it from scratch (no other content)', () => {
    writeLocalMcpTrust(dir);
    assert.ok(existsSync(settingsPath()));
    removeLocalMcpTrust(dir);
    assert.equal(existsSync(settingsPath()), false);
  });

  it("leaves the user's own entries in place, with only our two additions removed", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    }));
    writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir);
    assert.ok(existsSync(settingsPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    });
  });

  it('drops an emptied permissions object entirely rather than leaving {} behind', () => {
    writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir);
    // File was created from scratch by us -> fully deleted, not left as {}.
    assert.equal(existsSync(settingsPath()), false);
  });

  it('is a safe no-op when no settings.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpTrust(dir));
  });

  it('leaves an unparseable file alone rather than deleting or rewriting it', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json{{{');
    removeLocalMcpTrust(dir);
    assert.equal(readFileSync(settingsPath(), 'utf-8'), 'not json{{{');
  });
});
