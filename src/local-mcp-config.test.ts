import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { writeLocalMcpConfig, removeLocalMcpConfig } from './local-mcp-config.js';
import { SECRET_HEADER, SECRET_ENV_VAR } from './mcp-proxy.js';

const SECRET_HEADER_TEMPLATE = `\${${SECRET_ENV_VAR}}`;

/** Real `git init` in `dir` -- see local-mcp-trust.test.ts's identical
 *  helper for why this must be the real thing, not a mock. */
function initGitRepo(): void {
  spawnSync('git', ['init', '-q'], { cwd: dir });
}

let dir: string;
let xdgConfigDir: string;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-mcp-config-test-'));
  // Isolates `git check-ignore` from THIS machine's own global excludes --
  // see local-mcp-trust.test.ts's identical setup for the empirically-found
  // reason (a real dev machine commonly gitignores `.claude/` globally,
  // which would make a "not ignored" test here pass for the wrong reason
  // too, even though this file is about `.mcp.json` not `.claude/*`).
  xdgConfigDir = mkdtempSync(join(tmpdir(), 'yolo-bridge-xdg-config-test-'));
  process.env.XDG_CONFIG_HOME = xdgConfigDir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(xdgConfigDir, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

function mcpJsonPath(): string {
  return join(dir, '.mcp.json');
}

function sidecarPath(): string {
  return join(dir, '.yolobridge-mcp-state.json');
}

describe('writeLocalMcpConfig', () => {
  it('refuses to write when .mcp.json would NOT be git-ignored inside a real repo (Codex review, 2026-08-24, round 16)', () => {
    // Round 12 already moved the SECRET out of this file, but the entry
    // still carries a per-attach, machine-local loopback URL that's dead
    // the moment this daemon exits. This repo's OWN root tracks .mcp.json
    // (verified with `git cat-file`, not assumed) -- a committed dead entry
    // breaks the shared server definition for every collaborator.
    initGitRepo();
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    assert.equal(existsSync(mcpJsonPath()), false, 'must not create the file at all when it would be unsafe to commit');
  });

  it('proceeds normally when .mcp.json IS confirmed git-ignored', () => {
    initGitRepo();
    writeFileSync(join(dir, '.gitignore'), '.mcp.json\n');
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(result.ok, true);
  });

  it('proceeds normally outside a git repo entirely (no commit risk exists)', () => {
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(result.ok, true);
  });

  it('creates .mcp.json from scratch with a plain yolo-studio entry, and records ownership in the sidecar', () => {
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: true });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, {
      mcpServers: {
        'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp', headers: { [SECRET_HEADER]: SECRET_HEADER_TEMPLATE } },
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(sidecarPath(), 'utf-8')), { proxyUrl: 'http://127.0.0.1:4123/mcp' });
  });

  it('writes an entry with only standard http-transport fields, no custom marker (Codex review, 2026-08-24, round 9)', () => {
    // Round 7-8 embedded an `_yolobridge` marker directly in the entry.
    // Codex review, 2026-08-24, round 9: Claude Code (v2.0.21+) validates
    // mcpServers entries strictly on some releases and rejects unknown
    // fields (anthropics/claude-code#10606) -- an unknown key here can get
    // the WHOLE entry rejected, bricking local MCP access. Ownership now
    // lives entirely in the sidecar. `headers` (round 10) IS a standard
    // field for an http-transport entry, unlike a bespoke `_yolobridge` key.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(Object.keys(parsed.mcpServers['yolo-studio']).sort(), ['headers', 'type', 'url']);
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
        'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp', headers: { [SECRET_HEADER]: SECRET_HEADER_TEMPLATE } },
      },
      someOtherTopLevelKey: 'kept',
    });
  });

  it('refuses to overwrite an EXISTING yolo-studio entry with no matching sidecar record -- real hand-authored config, including one that happens to use a loopback URL', () => {
    // Round 6 tried a URL-shape heuristic (loopback URL = probably ours).
    // Round 7 correctly pointed out a legitimate hand-authored entry for
    // LOCAL DEVELOPMENT can have that exact shape too -- URL shape alone
    // can't establish ownership. Round 9 replaced the in-entry marker with
    // a sidecar record, but the invariant is the same: no sidecar entry
    // recording this exact URL means this module never wrote it.
    for (const url of ['https://services.yolo.studio/mcp', 'http://127.0.0.1:9999/mcp']) {
      writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url } } }));
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.deepEqual(result, { ok: false, createdFile: false }, `expected refusal for unmarked url: ${url}`);
      const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
      assert.equal(parsed.mcpServers['yolo-studio'].url, url, 'the existing entry must be left exactly as it was');
    }
  });

  it('overwrites a STALE entry left behind by an uncleanly-terminated previous attach, identified by the sidecar recording that exact URL (Codex review, 2026-08-24, round 6 + round 9)', () => {
    // The entry's URL matches what the sidecar recorded THIS module writing
    // -- almost certainly ours, from a session that exited via
    // SIGKILL/crash/reboot and never reached its own removeLocalMcpConfig
    // call, not a hand-authored config. Refusing unconditionally would
    // brick local MCP access on every subsequent attach until the operator
    // manually edited the file.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp'); // simulates the prior attach's write
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.deepEqual(result, { ok: true, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed.mcpServers['yolo-studio'], { type: 'http', url: 'http://127.0.0.1:4123/mcp', headers: { [SECRET_HEADER]: SECRET_HEADER_TEMPLATE } });
  });

  it('does NOT reclaim an entry that was EDITED to point somewhere else while an attachment was running, even though the sidecar still records the old URL (Codex review, 2026-08-24, round 8 + round 9)', () => {
    // The operator changed the URL to their own real server while attach #1
    // was still running, without knowing a sidecar exists. A sidecar-only
    // check would have the NEXT attach overwrite that intentional edit as
    // though it were stale daemon state -- requiring the CURRENT entry to
    // still equal the recorded URL closes that gap.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'] = { type: 'http', url: 'https://my-own-real-server.example.com/mcp' };
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

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

  it('leaves .mcp.json completely untouched if the sidecar write fails (Codex review, 2026-08-24, round 10)', () => {
    // The sidecar is now written BEFORE the `.mcp.json` entry (round 10's
    // fix for a real gap round 9 introduced): the OLD order wrote the entry
    // first, so a sidecar failure here would have left a `yolo-studio`
    // entry already persisted with no sidecar record -- unrecoverable by
    // either this attach's own cleanup (never runs, since `ok` was never
    // `true`) or any later attach's reclaim check (no matching sidecar).
    // Simulates the failure with a directory at the sidecar's path, forcing
    // `writeFileSync` to throw EISDIR.
    mkdirSync(sidecarPath());
    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(result.ok, false);
    assert.equal(existsSync(mcpJsonPath()), false, '.mcp.json must not have been created');
  });

  it('writes .mcp.json with owner-only (0600) permissions -- the entry now carries a live full-workspace credential (Codex review, 2026-08-24, round 11)', () => {
    // `writeFileSync`'s default mode only applies at file CREATION -- an
    // EXISTING file keeps whatever it already had, commonly 0644/0664 under
    // a typical umask, readable by any other local account on a multi-user
    // machine. Checked here for the from-scratch case; the next test covers
    // an existing, looser-permissioned file.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(statSync(mcpJsonPath()).mode & 0o777, 0o600);
  });

  it('tightens permissions to 0600 even when overwriting a pre-existing, looser-permissioned file', () => {
    writeFileSync(mcpJsonPath(), '{}');
    chmodSync(mcpJsonPath(), 0o644);
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(statSync(mcpJsonPath()).mode & 0o777, 0o600);
  });

  it('also writes the sidecar with owner-only (0600) permissions (Codex review, 2026-08-24, round 12)', () => {
    // Round 11 chmod'd `.mcp.json` but missed this sidecar file, which is
    // exactly as readable-by-any-local-account under a typical umask.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.equal(statSync(sidecarPath()).mode & 0o777, 0o600);
  });

  it('does NOT corrupt an existing valid sidecar record when a later sidecar write fails during a RECLAIM (Codex review, 2026-08-24, round 14)', () => {
    // A plain (non-atomic) writeFileSync on an EXISTING sidecar opens with
    // O_TRUNC, emptying the file BEFORE writing a single new byte -- an
    // ENOSPC or crash right there would leave a truncated/corrupt sidecar,
    // which readSidecar treats as absent. During a reclaim, that "absent"
    // read then permanently misclassifies the UNCHANGED (still genuinely
    // ours) .mcp.json entry as foreign on every later attach. Forces the
    // failure with a read-only directory, which blocks creating the atomic
    // write's temp file, proving the sidecar write is atomic (leaves the
    // ORIGINAL content intact) rather than a direct truncate-and-write.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    const beforeSidecar = readFileSync(sidecarPath(), 'utf-8');
    chmodSync(dir, 0o555);
    try {
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.equal(result.ok, false);
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(readFileSync(sidecarPath(), 'utf-8'), beforeSidecar, 'the sidecar must be byte-for-byte unchanged, not truncated');
  });

  it("writes the secret header as a '\\${VAR}' TEMPLATE, never the raw secret, since .mcp.json is often a git-tracked file (Codex review, 2026-08-24, round 12)", () => {
    // Round 10/11 wrote the actual per-attach random secret straight into
    // the entry -- safe against another local OS user reading the file
    // (round 11's chmod), but not against Git: a spawned coding agent
    // running with YOLO-mode autonomy could commit/push a live
    // full-workspace credential without anyone reviewing the diff. The
    // real secret now lives only in `mcp-proxy.ts`'s in-memory server and
    // the env var `cli.ts` sets on itself before spawning the local agent --
    // never in any file this module writes.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].headers[SECRET_HEADER], SECRET_HEADER_TEMPLATE);
  });

  it("rolls back the sidecar to its PRIOR state when the .mcp.json write fails during a RECLAIM (Codex review, 2026-08-24, round 11)", () => {
    // Round 10 fixed sidecar-then-entry ordering for the "no prior entry"
    // case, reasoning a failure there is harmless since nothing gates on a
    // stale sidecar yet. That reasoning does NOT hold for reclaiming an
    // ALREADY-owned stale entry: the sidecar held a valid record matching
    // the entry still on disk. Overwriting it with the new url and then
    // failing the .mcp.json write would strand that valid record too,
    // permanently misclassifying the (unchanged) on-disk entry as foreign
    // on every later attach. Forces the failure with a chmod'd-read-only
    // DIRECTORY (real fs permission enforcement, not a mock) -- round 13's
    // atomic-write fix means a read-only .mcp.json itself no longer blocks
    // the write (a fresh temp file is created alongside it, unaffected by
    // the target's own permissions; only the rename touches the original
    // path). A non-writable directory blocks creating that temp file at all.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    const beforeEntry = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    chmodSync(dir, 0o555);
    try {
      const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
      assert.equal(result.ok, false);
      assert.deepEqual(
        JSON.parse(readFileSync(sidecarPath(), 'utf-8')),
        { proxyUrl: 'http://127.0.0.1:9999/mcp' },
        'sidecar must be rolled back to what it recorded before this failed call',
      );
    } finally {
      chmodSync(dir, 0o755); // restore writability so afterEach's rmSync can clean up
    }
    const afterEntry = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(afterEntry, beforeEntry, '.mcp.json itself was never actually written, since the temp-file write failed');
  });

  it('does NOT reclaim an entry whose secret header was tampered with, even though type/url still match the sidecar (Codex review, 2026-08-24, round 11)', () => {
    // Comparing only `url` (round 9/10) missed an edit to `headers` alone --
    // `type`/`url` still matched, so the entry was still treated as ours to
    // overwrite despite this module's own "only ever touch exactly what we
    // wrote" guarantee.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'].headers['x-yolobridge-proxy-secret'] = 'tampered';
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].headers['x-yolobridge-proxy-secret'], 'tampered', 'the tampered entry must be left exactly as it was');
  });

  it('does NOT reclaim an entry with an EXTRA header added, even though type/url/secret-header still match exactly (Codex review, 2026-08-24, round 13)', () => {
    // Comparing individual field VALUES (rounds 9-11) missed an ADDITION --
    // an operator augmenting the entry with an extra header while leaving
    // type/url/the secret header untouched still passed every check. A
    // later attach would then silently drop that addition on reclaim.
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'].headers['x-my-own-header'] = 'kept-by-the-operator';
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].headers['x-my-own-header'], 'kept-by-the-operator', "the operator's addition must be left exactly as it was");
  });

  it('does NOT reclaim an entry with an EXTRA top-level field added (Codex review, 2026-08-24, round 13)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'].timeout = 5000;
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    const result = writeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp');
    assert.deepEqual(result, { ok: false, createdFile: false });
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.equal(parsed.mcpServers['yolo-studio'].timeout, 5000, "the operator's addition must be left exactly as it was");
  });
});

describe('removeLocalMcpConfig', () => {
  it('deletes the file entirely if we created it from scratch (no other content), and clears the sidecar', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    assert.ok(existsSync(mcpJsonPath()));
    assert.ok(existsSync(sidecarPath()));
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(existsSync(mcpJsonPath()), false);
    assert.equal(existsSync(sidecarPath()), false);
  });

  it('leaves the file in place, with only our entry removed, when other servers/keys exist, and clears the sidecar', () => {
    writeFileSync(mcpJsonPath(), JSON.stringify({
      mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } },
    }));
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', false);
    assert.ok(existsSync(mcpJsonPath()), 'file should survive since it had other content');
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed, { mcpServers: { 'my-own-server': { type: 'stdio', command: 'foo' } } });
    assert.equal(existsSync(sidecarPath()), false);
  });

  it('is a safe no-op when no .mcp.json exists at all', () => {
    assert.doesNotThrow(() => removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true));
  });

  it('cleans up a leftover sidecar when .mcp.json is already gone (matching URL)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    unlinkSync(mcpJsonPath()); // simulates the operator deleting a stray .mcp.json externally
    assert.ok(existsSync(sidecarPath()));
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    assert.equal(existsSync(sidecarPath()), false);
  });

  it('leaves a leftover sidecar alone when .mcp.json is gone but the URL does not match (a different attach cycle)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    unlinkSync(mcpJsonPath());
    removeLocalMcpConfig(dir, 'http://127.0.0.1:9999/mcp', true);
    assert.ok(existsSync(sidecarPath()), 'sidecar recording a different URL must not be cleared');
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
    assert.ok(existsSync(sidecarPath()), 'sidecar recording the real URL must not be cleared by a mismatched detach');
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

  it('does NOT delete an entry that matches the URL but has no matching sidecar record (a foreign entry someone else pointed at the same port coincidentally)', () => {
    // Belt-and-suspenders: even an exact URL match isn't enough by itself
    // (Codex review, 2026-08-24, round 7's reasoning applied symmetrically
    // to the remove path, now via the sidecar instead of an in-entry
    // marker) -- require a sidecar record too.
    writeFileSync(mcpJsonPath(), JSON.stringify({ mcpServers: { 'yolo-studio': { type: 'http', url: 'http://127.0.0.1:4123/mcp' } } }));
    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', false);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.deepEqual(parsed.mcpServers['yolo-studio'], { type: 'http', url: 'http://127.0.0.1:4123/mcp' });
  });

  it('does NOT delete an entry whose secret header was tampered with, even though the URL still matches (Codex review, 2026-08-24, round 11)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'].headers['x-yolobridge-proxy-secret'] = 'tampered';
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.ok(parsed.mcpServers['yolo-studio'], 'the tampered entry must survive, not be deleted');
  });

  it('does NOT delete an entry with an EXTRA header added, even though type/url/secret-header still match exactly (Codex review, 2026-08-24, round 13)', () => {
    writeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp');
    const config = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    config.mcpServers['yolo-studio'].headers['x-my-own-header'] = 'kept-by-the-operator';
    writeFileSync(mcpJsonPath(), JSON.stringify(config));

    removeLocalMcpConfig(dir, 'http://127.0.0.1:4123/mcp', true);
    const parsed = JSON.parse(readFileSync(mcpJsonPath(), 'utf-8'));
    assert.ok(parsed.mcpServers['yolo-studio'], "the operator's addition must survive, not be deleted");
  });
});
