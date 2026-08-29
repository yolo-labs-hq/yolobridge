import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

import { parseAttachArgs, resolveAttachHostInfo, resolveWorkspaceIdOrName, readOwnVersion } from './cli.js';

describe('parseAttachArgs', () => {
  it('plain workspaceId with no flags', () => {
    const result = parseAttachArgs(['w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('--label before the positional id', () => {
    const result = parseAttachArgs(['--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('positional id before --agent', () => {
    const result = parseAttachArgs(['w1', '--agent', 'codex']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: 'codex', agentId: undefined, fresh: false });
  });

  it('both flags in different order relative to the positional id', () => {
    const result = parseAttachArgs(['--agent', 'codex', '--label', 'laptop', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: 'codex', agentId: undefined, fresh: false });
  });

  it('--label with no id at all leaves workspaceId undefined (picker should trigger)', () => {
    const result = parseAttachArgs(['--label', 'laptop']);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: 'laptop', agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('no args at all leaves everything undefined (picker should trigger)', () => {
    const result = parseAttachArgs([]);
    assert.deepEqual(result, { workspaceId: undefined, hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('--label value that looks like a flag is rejected as a missing value, not consumed', () => {
    const result = parseAttachArgs(['--label', '--agent', 'codex']);
    assert.deepEqual(result, { error: '--label requires a value' });
  });

  it('a trailing flag with no following value is rejected', () => {
    const result = parseAttachArgs(['w1', '--label']);
    assert.deepEqual(result, { error: '--label requires a value' });
  });

  it('an unrecognized flag is a hard error, not silently misparsed', () => {
    const result = parseAttachArgs(['--bogus', 'w1']);
    assert.deepEqual(result, { error: "unrecognized option '--bogus'" });
  });

  it('only the first positional token is taken as the workspaceId', () => {
    const result = parseAttachArgs(['w1', 'w2']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: false });
  });

  it('--agent-id independent of --agent, for a binary whose registry identity differs (Codex review, 2026-08-24, round 4/5)', () => {
    const result = parseAttachArgs(['w1', '--agent', '/opt/bin/qwen', '--agent-id', 'qwen-code']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: '/opt/bin/qwen', agentId: 'qwen-code', fresh: false });
  });

  it('--agent-id alone, with no --agent (defaults the spawn binary elsewhere, only overrides the mint identity)', () => {
    const result = parseAttachArgs(['w1', '--agent-id', 'kiro']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: 'kiro', fresh: false });
  });

  it('a trailing --agent-id with no following value is rejected', () => {
    const result = parseAttachArgs(['w1', '--agent-id']);
    assert.deepEqual(result, { error: '--agent-id requires a value' });
  });

  it('--fresh sets the flag and, being a bare boolean, does not swallow the positional id', () => {
    // The whole hazard of adding a boolean to a parser built around
    // value-taking flags: `--fresh w1` must NOT consume `w1` as its value and
    // send the operator to the interactive picker.
    const result = parseAttachArgs(['--fresh', 'w1']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: undefined, agentBin: undefined, agentId: undefined, fresh: true });
  });

  it('--fresh combines with the value-taking flags in any order', () => {
    const result = parseAttachArgs(['w1', '--label', 'laptop', '--fresh', '--agent', 'codex']);
    assert.deepEqual(result, { workspaceId: 'w1', hostLabel: 'laptop', agentBin: 'codex', agentId: undefined, fresh: true });
  });

  it('--fresh is false when absent, so the default is to resume', () => {
    const result = parseAttachArgs(['w1']);
    assert.equal('error' in result, false);
    assert.equal((result as { fresh?: boolean }).fresh, false);
  });
});

describe('resolveWorkspaceIdOrName', () => {
  const OID = '665f00000000000000000001';
  const OID2 = '665f00000000000000000002';

  it('an id-shaped value is used as-is, with no lookup call at all', async () => {
    let called = false;
    const result = await resolveWorkspaceIdOrName(OID, { commonApiBaseUrl: 'http://x' }, async () => {
      called = true;
      return { ok: true, workspaces: [] };
    });
    assert.deepEqual(result, { ok: true, workspaceId: OID });
    assert.equal(called, false);
  });

  it('resolves a name to its id via a case-insensitive exact match', async () => {
    const result = await resolveWorkspaceIdOrName('Pong', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [{ id: OID, name: 'pong', status: 'creating' }],
    }));
    assert.deepEqual(result, { ok: true, workspaceId: OID });
  });

  it('a name with no match is a clear error, not a fallback to treating it as an id', async () => {
    const result = await resolveWorkspaceIdOrName('nope', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [{ id: OID, name: 'pong', status: 'creating' }],
    }));
    assert.deepEqual(result, {
      ok: false,
      message: 'no workspace named "nope" found (run `yolo-bridge workspaces` to see your workspaces)',
    });
  });

  it('a name matching multiple workspaces errors instead of silently picking the first', async () => {
    const result = await resolveWorkspaceIdOrName('dup', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: true,
      workspaces: [
        { id: OID, name: 'dup', status: 'running' },
        { id: OID2, name: 'dup', status: 'creating' },
      ],
    }));
    assert.deepEqual(result, {
      ok: false,
      message: `multiple workspaces are named "dup" — attach by id instead: ${OID} [running], ${OID2} [creating]`,
    });
  });

  it('propagates a lookup failure (e.g. not logged in) as its own error', async () => {
    const result = await resolveWorkspaceIdOrName('pong', { commonApiBaseUrl: 'http://x' }, async () => ({
      ok: false,
      reason: 'not-logged-in',
      message: 'Not logged in — run `yolo-bridge login` first.',
    }));
    assert.deepEqual(result, { ok: false, message: 'Not logged in — run `yolo-bridge login` first.' });
  });
});

describe('resolveAttachHostInfo', () => {
  const BASE = { hostname: 'dev-laptop', cwd: '/home/dev/proj', platform: 'linux', agent: 'claude' };

  it('defaults hostLabel to the machine hostname when --label was not given', () => {
    const result = resolveAttachHostInfo(BASE);
    assert.equal(result.hostLabel, 'dev-laptop');
  });

  it('lets an explicit --label win over the hostname', () => {
    const result = resolveAttachHostInfo({ ...BASE, label: 'workshop-pi' });
    assert.equal(result.hostLabel, 'workshop-pi');
  });

  it('falls back to the hostname for a whitespace-only label rather than naming the tile with blanks', () => {
    const result = resolveAttachHostInfo({ ...BASE, label: '   ' });
    assert.equal(result.hostLabel, 'dev-laptop');
  });

  it('leaves hostLabel undefined when there is neither a label nor a usable hostname', () => {
    const result = resolveAttachHostInfo({ ...BASE, hostname: '' });
    assert.equal(result.hostLabel, undefined);
  });

  it('reports exactly the facts the tile shows — and nothing else', () => {
    const result = resolveAttachHostInfo(BASE);
    assert.deepEqual(result.remoteHost, { cwd: '/home/dev/proj', platform: 'linux', agent: 'claude' });
    // Guards the privacy boundary directly: adding an env dump, a username,
    // or a file listing here would fail this assertion, not slip through.
    // `cliVersion` is the one later addition, and it is the daemon's own
    // version rather than a fact about the operator's machine — it appears
    // only when supplied, which is why it is absent here.
    assert.deepEqual(Object.keys(result.remoteHost).sort(), ['agent', 'cwd', 'platform']);
  });

  it('reports its OWN version when given one, and still nothing else', () => {
    // ⚠️ This is a CAPABILITY signal, not telemetry. The daemon binary freezes
    // on the operator's machine while the server and webapp keep deploying, so
    // without it a tile can offer a control this daemon has never heard of —
    // and nothing notices, because an unrecognised frame produces no error and
    // the route still answers 200.
    const result = resolveAttachHostInfo({ ...BASE, cliVersion: '0.25.0' });
    assert.equal(result.remoteHost.cliVersion, '0.25.0');
    assert.deepEqual(Object.keys(result.remoteHost).sort(), ['agent', 'cliVersion', 'cwd', 'platform']);
  });

  it('OMITS the version rather than sending "unknown"', () => {
    // `readOwnVersion()` returns the literal 'unknown' when it cannot find its
    // own package.json. Forwarding that would be indistinguishable from a real
    // version to anything doing a semver compare — and a reader must be able
    // to tell "did not report" from "reported something unusable", because
    // only the first is a reason to hedge.
    assert.equal(resolveAttachHostInfo({ ...BASE, cliVersion: 'unknown' }).remoteHost.cliVersion, undefined);
    assert.equal(resolveAttachHostInfo({ ...BASE, cliVersion: '   ' }).remoteHost.cliVersion, undefined);
    assert.equal(resolveAttachHostInfo({ ...BASE }).remoteHost.cliVersion, undefined);
  });

  it('sends a version that MATCHES the installed package', () => {
    // The whole signal is worthless if it drifts from the binary it describes.
    const result = resolveAttachHostInfo({ ...BASE, cliVersion: readOwnVersion() });
    assert.equal(result.remoteHost.cliVersion, readOwnVersion());
  });

  it('describes the REAL process when handed real values (no mocks — the actual call shape cli.ts uses)', () => {
    const result = resolveAttachHostInfo({
      hostname: hostname(),
      cwd: process.cwd(),
      platform: process.platform,
      agent: 'codex',
    });
    assert.equal(result.remoteHost.cwd, process.cwd());
    assert.equal(result.remoteHost.platform, process.platform);
    assert.equal(typeof result.hostLabel, 'string');
  });
});

describe('readOwnVersion', () => {
  // WHY THIS TEST EXISTS: `yolo-bridge --version` did not exist at all until a
  // stalled publish left an operator running 0.13.0 with no way to find that
  // out. The failure mode to guard is not "wrong number" — it is the resolver
  // silently returning 'unknown' because the layout moved underneath it. That
  // degrades to a useless answer rather than an error, so nothing else catches
  // it.
  it('reports this package\'s real version, not the unknown fallback', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = (await import('node:path')).default;

    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const expected = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;

    const actual = readOwnVersion();
    assert.notEqual(actual, 'unknown', 'resolver fell back to unknown — the package.json lookup is broken');
    assert.equal(actual, expected);
    assert.match(actual, /^\d+\.\d+\.\d+/);
  });
});

/**
 * The CLI describes itself in THREE places — the file header, `printHelp`, and
 * the dispatch switch — and only the last one is executable. The other two fell
 * five commands behind (`console`, `allow`, `share`, `deliver`, `version` were
 * all added without either being updated), so the first thing a reader of the
 * file saw was a CLI half its real size, and nothing anywhere went red.
 *
 * Documentation drift is invisible by construction, so it needs a test rather
 * than good intentions. The switch is the source of truth here because it is
 * the only one the runtime actually consults.
 */
describe('the CLI describes itself accurately', () => {
  const source = (() => {
    for (const rel of ['./cli.ts', '../src/cli.ts', '../../src/cli.ts']) {
      const url = new URL(rel, import.meta.url);
      if (existsSync(url)) return readFileSync(url, 'utf-8');
    }
    throw new Error('could not locate cli.ts from ' + import.meta.url);
  })();

  /** Command names the dispatch switch actually handles. */
  const dispatched = [...source.matchAll(/^\s{4}case '([a-z-]+)':$/gm)]
    .map((m) => m[1])
    .filter((c) => !c.startsWith('-'));

  it('dispatches the commands we think it does', () => {
    // A canary on the extraction itself: if the switch is refactored into a
    // shape this regex cannot see, every assertion below would pass vacuously.
    assert.ok(dispatched.length >= 9, `only found ${dispatched.length} commands: ${dispatched.join(', ')}`);
    for (const expected of ['login', 'workspaces', 'attach', 'detach', 'console', 'share', 'status']) {
      assert.ok(dispatched.includes(expected), `expected the switch to handle '${expected}'`);
    }
  });

  it('lists every dispatched command in `printHelp`', () => {
    const help = source.slice(source.indexOf('function printHelp'), source.indexOf('function apiUrl') > 0
      ? source.length
      : source.length);
    const helpBlock = help.slice(0, help.indexOf('\n}\n'));
    for (const cmd of dispatched) {
      assert.ok(
        new RegExp(`'\\s*${cmd}[ \\[<']`).test(helpBlock) || helpBlock.includes(`'  ${cmd}`),
        `\`${cmd}\` is dispatched but missing from printHelp — an operator running --help would never learn it exists`,
      );
    }
  });

  it('lists every dispatched command in the file header', () => {
    const header = source.slice(0, source.indexOf(' */'));
    for (const cmd of dispatched) {
      assert.ok(
        header.includes(`yolo-bridge ${cmd}`),
        `\`${cmd}\` is dispatched but missing from the header comment — this is exactly the drift that let the list fall five commands behind`,
      );
    }
  });
});

