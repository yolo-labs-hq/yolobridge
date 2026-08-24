import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { writeLocalMcpTrust, removeLocalMcpTrust } from './local-mcp-trust.js';

/** Real `git init` in `dir` -- these tests prove the actual `git
 *  check-ignore` behavior, not a mocked guess at it (Codex review,
 *  2026-08-24, round 15's own finding was exactly this kind of assumption
 *  going unverified). No identity config needed; `check-ignore` doesn't
 *  require one. */
function initGitRepo(): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

let dir: string;
let xdgConfigDir: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-mcp-trust-test-'));
  // Isolates `git check-ignore` from THIS machine's own global excludes
  // (found empirically: a real developer machine commonly has
  // `**/.claude/settings.local.json` in `~/.config/git/ignore`, which would
  // make every "not ignored" test below silently pass for the wrong
  // reason). `riskyToCommit` in production code inherits `process.env`
  // (no explicit `env` override), so this flows straight through to it.
  xdgConfigDir = mkdtempSync(join(tmpdir(), 'yolo-bridge-xdg-config-test-'));
  process.env.XDG_CONFIG_HOME = xdgConfigDir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(xdgConfigDir, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

function settingsPath(): string {
  return join(dir, '.claude', 'settings.local.json');
}

/** Threads a writeLocalMcpTrust result straight into removeLocalMcpTrust's
 *  opts, for tests where the write happened against an empty/
 *  no-conflicting-entries file (both remove flags true). */
function removeAllFrom(result: { addedServerEntry: boolean; addedPermissionEntry: boolean; createdFile: boolean; attachId?: string }) {
  return {
    removeServerEntry: result.addedServerEntry,
    removePermissionEntry: result.addedPermissionEntry,
    createdFile: result.createdFile,
    attachId: result.attachId,
  };
}

function sharedSettingsPath(): string {
  return join(dir, '.claude', 'settings.json');
}

describe('writeLocalMcpTrust', () => {
  it('refuses to write when settings.local.json would NOT be git-ignored inside a real repo (Codex review, 2026-08-24, round 15)', () => {
    // Round 14 assumed settings.local.json is gitignored "by convention" --
    // disproved by this repo's OWN root, which genuinely tracks that exact
    // file. Verified with a REAL `git init` + `check-ignore`, not a mock:
    // with no .gitignore at all, the path is definitively NOT ignored.
    initGitRepo();
    const result = writeLocalMcpTrust(dir);
    assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false });
    assert.equal(existsSync(settingsPath()), false, 'must not create the file at all when it would be unsafe to commit');
  });

  it('proceeds normally when settings.local.json IS confirmed git-ignored', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.claude/settings.local.json\n');
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
    assert.ok(existsSync(settingsPath()));
  });

  it('proceeds normally outside a git repo entirely (no commit risk exists)', () => {
    // `dir` here is a plain mkdtemp directory, never git-init'd -- this is
    // also what every OTHER test in this file relies on implicitly.
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
  });

  it('targets settings.local.json, never the SHARED settings.json (Codex review, 2026-08-24, round 14)', () => {
    // This ephemeral, per-attach grant must never land in a file meant to
    // be committed and shared across a team -- a spawned YOLO-mode agent
    // could commit/push it, and a SIGKILL/reboot before cleanup would leave
    // it in every other checkout of the repo. `settings.local.json` is
    // Claude Code's own sanctioned personal/machine-local layer.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(sharedSettingsPath(), JSON.stringify({ someExistingOperatorSetting: true }));
    writeLocalMcpTrust(dir);
    assert.deepEqual(JSON.parse(readFileSync(sharedSettingsPath(), 'utf-8')), { someExistingOperatorSetting: true });
    assert.ok(existsSync(settingsPath()), 'the grant must land in settings.local.json instead');
  });

  it('creates .claude/settings.local.json from scratch with both approval layers, marked as ours with a fresh attachId', () => {
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
    assert.equal(result.addedServerEntry, true);
    assert.equal(result.addedPermissionEntry, true);
    assert.equal(result.createdFile, true);
    assert.equal(typeof result.attachId, 'string');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
      _yolobridge: { attachId: result.attachId, enabledServerEntry: true, permissionEntry: true },
    });
  });

  it("preserves the user's own enabledMcpjsonServers entries, permission rules, and unrelated top-level keys", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
      someOtherTopLevelKey: 'kept',
    }));
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
    assert.equal(result.createdFile, false);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server', 'yolo-studio'],
      permissions: { allow: ['Bash(git *)', 'mcp__yolo-studio__*'], deny: ['Bash(rm -rf *)'] },
      someOtherTopLevelKey: 'kept',
      _yolobridge: { attachId: result.attachId, enabledServerEntry: true, permissionEntry: true },
    });
  });

  it('is idempotent -- calling it twice does not duplicate entries', () => {
    writeLocalMcpTrust(dir);
    writeLocalMcpTrust(dir);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed.enabledMcpjsonServers, ['yolo-studio']);
    assert.deepEqual(parsed.permissions.allow, ['mcp__yolo-studio__*']);
  });

  it('reports addedServerEntry/addedPermissionEntry as false when those entries already existed with NO ownership marker (a genuine operator pre-trust, not ours) (Codex review, 2026-08-24)', () => {
    // Simulates the operator having already trusted this server themselves
    // (e.g. clicked through the prompt once) before ever running `attach`.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }));
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
    assert.equal(result.addedServerEntry, false);
    assert.equal(result.addedPermissionEntry, false);
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
      _yolobridge: { attachId: result.attachId, enabledServerEntry: false, permissionEntry: false },
    });
  });

  it("reclaims entries left behind by an uncleanly-terminated previous attach, identified by the _yolobridge marker, and stamps a FRESH attachId (Codex review, 2026-08-24, round 7 + round 8)", () => {
    // Distinct from the case above: this file ALREADY carries the marker
    // this module itself writes, from a session that exited via
    // SIGKILL/crash/reboot and never reached its own removeLocalMcpTrust
    // call -- not a genuine operator pre-trust. Without reclaiming, cleanup
    // would leave mcp__yolo-studio__* permanently auto-approved forever,
    // since every subsequent attach would see the entries as "already
    // present" and report addedServerEntry/addedPermissionEntry as false.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
      _yolobridge: { attachId: 'stale-crashed-attach-id', enabledServerEntry: true, permissionEntry: true },
    }));
    const result = writeLocalMcpTrust(dir);
    assert.equal(result.ok, true);
    assert.equal(result.addedServerEntry, true);
    assert.equal(result.addedPermissionEntry, true);
    assert.notEqual(result.attachId, 'stale-crashed-attach-id', 'reclaiming must stamp a fresh id, not keep the dead attach\'s');
    removeLocalMcpTrust(dir, removeAllFrom(result));
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {}, 'the reclaimed entries must actually be removable on cleanup, not stuck forever');
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

  it('returns ok:false and does not touch a pre-existing file whose enabledMcpjsonServers/permissions.allow arrays contain a non-string element (Codex review, 2026-08-24, round 19)', () => {
    // The shape checks above only confirm "this is an array" -- not "every
    // element is a string." asStringArray silently filters out anything
    // else, which would PERMANENTLY discard an unrelated value (e.g. `42`)
    // from the operator's own file the moment this module wrote it back.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const content of [
      '{"enabledMcpjsonServers":["real-server",42]}',
      '{"permissions":{"allow":["mcp__real__*",true]}}',
    ]) {
      writeFileSync(settingsPath(), content);
      const result = writeLocalMcpTrust(dir);
      assert.deepEqual(result, { ok: false, addedServerEntry: false, addedPermissionEntry: false, createdFile: false }, `expected refusal for: ${content}`);
      assert.equal(readFileSync(settingsPath(), 'utf-8'), content, `file must be untouched for: ${content}`);
    }
  });
});

describe('removeLocalMcpTrust', () => {
  it('deletes the file entirely if we created it from scratch (no other content)', () => {
    const result = writeLocalMcpTrust(dir);
    assert.ok(existsSync(settingsPath()));
    removeLocalMcpTrust(dir, removeAllFrom(result));
    assert.equal(existsSync(settingsPath()), false);
  });

  it("leaves the user's own entries in place, with only our two additions removed", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    }));
    const result = writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, { removeServerEntry: true, removePermissionEntry: true, createdFile: false, attachId: result.attachId });
    assert.ok(existsSync(settingsPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      enabledMcpjsonServers: ['my-own-server'],
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
    });
  });

  it('drops an emptied permissions object entirely rather than leaving {} behind', () => {
    const result = writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, removeAllFrom(result));
    // File was created from scratch by us -> fully deleted, not left as {}.
    assert.equal(existsSync(settingsPath()), false);
  });

  it('is a safe no-op when no settings.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpTrust(dir, { removeServerEntry: true, removePermissionEntry: true, createdFile: true, attachId: 'whatever' }));
  });

  it('leaves an unparseable file alone rather than deleting or rewriting it', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json{{{');
    removeLocalMcpTrust(dir, { removeServerEntry: true, removePermissionEntry: true, createdFile: true, attachId: 'whatever' });
    assert.equal(readFileSync(settingsPath(), 'utf-8'), 'not json{{{');
  });

  it('leaves a file with a non-object JSON root (array/null/scalar) alone too (Codex review, 2026-08-24)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '[1,2,3]');
    removeLocalMcpTrust(dir, { removeServerEntry: true, removePermissionEntry: true, createdFile: true, attachId: 'whatever' });
    assert.equal(readFileSync(settingsPath(), 'utf-8'), '[1,2,3]');
  });

  it("does NOT revoke trust the operator granted independently before this attach (Codex review, 2026-08-24)", () => {
    // The exact scenario the P2 finding described: the operator already had
    // both entries with no ownership marker; writeLocalMcpTrust correctly
    // reports it added neither; detach must leave them standing, not strip
    // them "by value."
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }));
    const result = writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, removeAllFrom(result));
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
    removeLocalMcpTrust(dir, removeAllFrom(result));
    assert.ok(existsSync(settingsPath()), 'the pre-existing file must survive, even though it is now empty');
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf-8')), {});
  });

  it('always removes the ownership marker itself, even on a genuine operator pre-trust where nothing else is removed', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }));
    const result = writeLocalMcpTrust(dir);
    removeLocalMcpTrust(dir, removeAllFrom(result));
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.equal('_yolobridge' in parsed, false, 'internal bookkeeping must never linger in the operator-visible file');
  });

  it('does NOT touch anything if the marker was removed mid-session -- the operator explicitly signaled "keep trusting this" (Codex review, 2026-08-24, round 8)', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const result = writeLocalMcpTrust(dir);
    // Simulate the operator hand-editing settings.json while attached:
    // they stripped the marker but kept the grants -- an explicit choice
    // to keep trusting yolo-studio beyond this attach's lifetime.
    const edited = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    delete edited._yolobridge;
    writeFileSync(settingsPath(), JSON.stringify(edited));

    removeLocalMcpTrust(dir, removeAllFrom(result));

    const after = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(after, {
      enabledMcpjsonServers: ['yolo-studio'],
      permissions: { allow: ['mcp__yolo-studio__*'] },
    }, 'the operator\'s edit (marker removed, grants kept) must be left completely alone');
  });

  it("does NOT touch anything if a DIFFERENT attach's marker is now on disk -- protects a concurrent attach's grants from being deleted by a sibling (Codex review, 2026-08-24, round 8)", () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const resultA = writeLocalMcpTrust(dir);
    // A second, concurrent attach in the same directory overwrites the
    // marker with its own id (its own writeLocalMcpTrust call would do
    // this for real; simulated directly here for a deterministic test).
    const currentOnDisk = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    currentOnDisk._yolobridge = { attachId: 'sibling-attach-b-id', enabledServerEntry: true, permissionEntry: true };
    writeFileSync(settingsPath(), JSON.stringify(currentOnDisk));

    // Attach A detaches first, using ITS OWN (now-stale) attachId.
    removeLocalMcpTrust(dir, removeAllFrom(resultA));

    const after = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    assert.deepEqual(after, currentOnDisk, "attach A must not delete attach B's still-live grants");
  });

  it('does NOT touch the file when enabledMcpjsonServers/permissions/permissions.allow were hand-edited to a NON-ARRAY value entirely (Codex review, 2026-08-24, round 22)', () => {
    // Round 19's content check only catches a WRONG-SHAPE ARRAY (a
    // non-string element) -- it never fires when the value isn't an array
    // AT ALL. Without the shape check this test proves, asStringArray would
    // silently coerce each of these to `[]`, and this function would then
    // `delete` the operator's field entirely -- the exact "cleanup destroys
    // something it doesn't provably still own" failure this module exists
    // to prevent.
    for (const corrupt of [
      { enabledMcpjsonServers: 'not-an-array' },
      { permissions: 'not-an-object' },
      { permissions: { allow: 'not-an-array' } },
    ]) {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      const result = writeLocalMcpTrust(dir);
      const onDisk = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
      const corrupted = { ...onDisk, ...corrupt };
      writeFileSync(settingsPath(), JSON.stringify(corrupted));

      removeLocalMcpTrust(dir, removeAllFrom(result));

      assert.deepEqual(
        JSON.parse(readFileSync(settingsPath(), 'utf-8')),
        corrupted,
        `expected the file untouched for: ${JSON.stringify(corrupt)}`,
      );
      unlinkSync(settingsPath());
    }
  });
});
