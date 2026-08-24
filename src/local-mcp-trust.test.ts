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

/** Remove everything this attach added, for tests where the write happened
 *  against an empty/no-conflicting-entries file (both flags true). */
const REMOVE_ALL = { removeServerEntry: true, removePermissionEntry: true, createdFile: true };

describe('writeLocalMcpTrust', () => {
  it('creates .claude/settings.json from scratch with both approval layers', () => {
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: true, addedServerEntry: true, addedPermissionEntry: true, createdFile: true });
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
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
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: true, addedServerEntry: true, addedPermissionEntry: true, createdFile: false });
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server', 'yolo-studio'],
      permissions: { allow: ['Bash(git *)', 'mcp__yolo-studio__*'], deny: ['Bash(rm -rf *)'] },
      someOtherTopLevelKey: 'kept',
    });
  });

  it('is idempotent -- calling it twice does not duplicate entries', () => {
    writeLocalMcpTrust(dir);
    writeLocalMcpTrust(dir);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed.enabledMcpjsonServers, ['yolo-studio']);
    assert.deepEqual(parsed.permissions.allow, ['mcp__yolo-studio__*']);
  });

  it('reports addedServerEntry/addedPermissionEntry as false when those entries already existed, without duplicating them (Codex review, 2026-08-24)', () => {
    // Simulates the operator having already trusted this server themselves
    // (e.g. clicked through the prompt once) before ever running `attach`.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }));
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: true, addedServerEntry: false, addedPermissionEntry: false, createdFile: false });
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    });
  });

  it('returns ok:false and does not overwrite a pre-existing file that is not valid JSON', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json{{{');
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false });
    assert.equal(readFileSync(settingsPath(), 'utf-8'), 'not json{{{');
  });

  it('returns ok:false and does not touch a pre-existing file whose JSON root is an array or other non-object (Codex review, 2026-08-24)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const content of ['[1,2,3]', 'null', '42', '"a string"']) {
      writeFileSync(settingsPath(), content);
      const result = writeLocalMcpTrust(dir);
      assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false }, `expected refusal for root content: ${content}`);
      assert.equal(readFileSync(settingsPath(), 'utf-8'), content, `file must be untouched for root content: ${content}`);
    }
  });

  it('returns ok:false and does not touch a pre-existing file whose enabledMcpjsonServers is not an array (Codex review, 2026-08-24, round 2)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const content = '{"enabledMcpjsonServers":"not-an-array"}';
    writeFileSync(settingsPath(), content);
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false });
    assert.equal(readFileSync(settingsPath(), 'utf-8'), content);
  });

  it('returns ok:false and does not touch a pre-existing file whose permissions value is malformed (array, primitive, or a non-array allow) (Codex review, 2026-08-24, round 2)', () => {
    // Same class of bug one level deeper: `typeof [] === 'object'` also
    // passed the OLD nested-value check, so an array `permissions` would
    // have had `allow` assigned as a non-index property (silently dropped
    // by JSON.stringify) while still reporting addedPermissionEntry:true;
    // a primitive `permissions` (or a non-array `permissions.allow`) would
    // have been silently replaced, discarding whatever was there.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const body of ['[1,2,3]', '"a string"', '{"allow":"not-an-array"}']) {
      const content = `{"permissions":${body}}`;
      writeFileSync(settingsPath(), content);
      const result = writeLocalMcpTrust(dir);
      assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false }, `expected refusal for permissions: ${body}`);
      assert.equal(readFileSync(settingsPath(), 'utf-8'), content, `file must be untouched for permissions: ${body}`);
    }
  });
});

describe('removeLocalMcpTrust', () => {
  it('deletes the file entirely if we created it from scratch (no other content)', () => {
    writeLocalMcpTrust(dir);
    assert.ok(existsSync(settingsPath()));
    removeLocalMcpTrust(dir, REMOVE_ALL);
    assert.equal(existsSync(settingsPath()), false);
  });

  it("leaves the user's own entries in place, with only our two additions removed", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    }));
    writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, { removeServerEntry: true, removePermissionEntry: true, createdFile: false });
    assert.ok(existsSync(settingsPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    });
  });

  it('drops an emptied permissions object entirely rather than leaving {} behind', () => {
    writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, REMOVE_ALL);
    // File was created from scratch by us -> fully deleted, not left as {}.
    assert.equal(existsSync(settingsPath()), false);
  });

  it('is a safe no-op when no settings.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpTrust(dir, REMOVE_ALL));
  });

  it('leaves an unparseable file alone rather than deleting or rewriting it', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json{{{');
    removeLocalMcpTrust(dir, REMOVE_ALL);
    assert.equal(readFileSync(settingsPath(), 'utf-8'), 'not json{{{');
  });

  it('leaves a file with a non-object JSON root (array/null/scalar) alone too (Codex review, 2026-08-24)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '[1,2,3]');
    removeLocalMcpTrust(dir, REMOVE_ALL);
    assert.equal(readFileSync(settingsPath(), 'utf-8'), '[1,2,3]');
  });

  it("does NOT revoke trust the operator granted independently before this attach (Codex review, 2026-08-24)", () => {
    // The exact scenario the P2 finding described: the operator already had
    // both entries; writeLocalMcpTrust correctly reports it added neither;
    // detach must leave them standing, not strip them "by value."
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }));
    const result = writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, { removeServerEntry: result.addedServerEntry, removePermissionEntry: result.addedPermissionEntry, createdFile: result.createdFile });
    assert.ok(existsSync(settingsPath()), 'the operator-granted file must survive detach');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    });
  });

  it('does NOT unlink a pre-existing (createdFile:false) settings.json even when removing our entries leaves it empty (Codex review, 2026-08-24, round 6)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({}));
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.createdFile, false);
    removeLocalMcpTrust(dir, { removeServerEntry: result.addedServerEntry, removePermissionEntry: result.addedPermissionEntry, createdFile: result.createdFile });
    assert.ok(existsSync(settingsPath()), 'the pre-existing file must survive, even though it is now empty');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf-8')), {});
  });
});
