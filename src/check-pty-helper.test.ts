import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPtyHelper, findHelperPath, findHelperCandidates, type HelperProbeFs } from './check-pty-helper.js';

const ROOT = '/g/node_modules/node-pty';
const HELPER = `${ROOT}/build/Release/spawn-helper`;
const PREBUILD_HELPER = `${ROOT}/prebuilds/darwin-arm64/spawn-helper`;

/** `files` are the paths that exist; `nativeDir` is where pty.node lives. */
function io(
  files: Record<string, 'exec' | 'noexec'>,
  nativeDir = `${ROOT}/build/Release`,
): HelperProbeFs {
  return {
    loadsNative: (p) => p === `${nativeDir}/pty.node`,
    existsSync: (p) => p in files || p === `${ROOT}/package.json` || p === `${nativeDir}/pty.node`,
    statSync: () => ({ isFile: () => true }),
    accessSync: (p) => { if (files[p] !== 'exec') throw new Error('EACCES'); },
    constants: { X_OK: 1 },
  };
}

// `resolveFrom` points at a file inside a fake tree; findNodePtyRoot uses the
// real `require.resolve`, which will not find node-pty from there — so these
// exercise the not-applicable path deliberately, and the darwin branches are
// driven through the injected io below.
describe('when the check does not apply', () => {
  it('says nothing on linux, where no spawn-helper exists', () => {
    // ⚠️ Probing on linux would report a missing file on EVERY healthy install.
    const r = checkPtyHelper({ platform: 'linux', io: io({}) });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.reason, 'not-applicable');
  });

  it('stays silent when node-pty cannot be located at all', () => {
    // An inconclusive probe must not manufacture a failure: the cost is
    // sending someone to chmod a file that was never meant to exist.
    const r = checkPtyHelper({ platform: 'darwin', resolveFrom: '/nowhere/x.js', io: io({}) });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.reason, 'not-applicable');
  });
});

describe('the message when the helper is the problem', () => {
  it('reports a MISSING helper and names it', () => {
    const r = checkPtyHelper({ platform: 'darwin', nodePtyRoot: ROOT, io: io({}) });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'missing');
    assert.match(r.ok === false ? r.message : '', /spawn-helper/);
    assert.match(r.ok === false ? r.message : '', /Release\/spawn-helper/);
  });

  it('reports a NON-EXECUTABLE helper separately, and says chmod', () => {
    // A different fault with a different fix. Collapsing it into "missing"
    // sends the operator to reinstall a file that is already there.
    const r = checkPtyHelper({ platform: 'darwin', nodePtyRoot: ROOT, io: io({ [HELPER]: 'noexec' }) });
    assert.equal(r.ok === false && r.reason, 'not-executable');
    assert.match(r.ok === false ? r.message : '', /chmod \+x/);
    assert.match(r.ok === false ? r.message : '', new RegExp(HELPER.replace(/\//g, '\\/')));
  });

  it('says explicitly that this is NOT the agent\'s fault', () => {
    // ⚠️ The whole point. The operator has just been told their agent could
    // not start, and their agent is fine — twice over, in the report that
    // prompted this. Without this sentence they go on debugging `claude`.
    const cases: Record<string, 'exec' | 'noexec'>[] = [{}, { [HELPER]: 'noexec' }];
    for (const files of cases) {
      const r = checkPtyHelper({ platform: 'darwin', nodePtyRoot: ROOT, io: io(files) });
      assert.match(r.ok === false ? r.message : '', /NOT a problem with your agent/);
    }
  });

  it('passes a healthy helper', () => {
    const r = checkPtyHelper({ platform: 'darwin', nodePtyRoot: ROOT, io: io({ [HELPER]: 'exec' }) });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.reason, 'healthy');
  });

  it('never fires on linux, even with the helper absent', () => {
    // The false-alarm direction: linux has no spawn-helper on any install.
    const r = checkPtyHelper({ platform: 'linux', nodePtyRoot: ROOT, io: io({}) });
    assert.equal(r.ok, true);
  });
});

describe('finding where node-pty ACTUALLY loads from', () => {
  // ⚠️ The first version hardcoded build/Release. node-pty 1.1.0 ships
  // prebuilds and never copies them there, so that would have aborted every
  // attach on every healthy Mac — a false reject, the worst direction.

  it('uses the PREBUILD dir when that is where pty.node lives', () => {
    const probe = io({}, `${ROOT}/prebuilds/darwin-arm64`);
    assert.equal(findHelperPath(ROOT, 'darwin', 'arm64', probe), PREBUILD_HELPER);
  });

  it('prefers build/Release when a local source build exists', () => {
    // node-pty's own order: Release, Debug, then the prebuild.
    const probe = io({}, `${ROOT}/build/Release`);
    assert.equal(findHelperPath(ROOT, 'darwin', 'arm64', probe), HELPER);
  });

  it('is architecture-specific', () => {
    const probe = io({}, `${ROOT}/prebuilds/darwin-x64`);
    assert.equal(findHelperPath(ROOT, 'darwin', 'x64', probe), `${ROOT}/prebuilds/darwin-x64/spawn-helper`);
    assert.equal(findHelperPath(ROOT, 'darwin', 'arm64', probe), undefined);
  });

  it('returns undefined when no pty.node can be found anywhere', () => {
    const probe = io({}, '/nowhere');
    assert.equal(findHelperPath(ROOT, 'darwin', 'arm64', probe), undefined);
  });

  it('a healthy PREBUILT mac install is NOT reported as broken', () => {
    // The exact false-positive codex caught: prebuilds present, executable,
    // no build/Release at all.
    const probe = io({ [PREBUILD_HELPER]: 'exec' }, `${ROOT}/prebuilds/darwin-arm64`);
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, true, r.ok === false ? r.message : '');
  });

  it('catches a NON-EXECUTABLE prebuild helper — the real macOS fault', () => {
    // As shipped, prebuilds/darwin-arm64/spawn-helper unpacks 0644.
    const probe = io({ [PREBUILD_HELPER]: 'noexec' }, `${ROOT}/prebuilds/darwin-arm64`);
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok === false && r.reason, 'not-executable');
    assert.match(r.ok === false ? r.message : '', /prebuilds\/darwin-arm64\/spawn-helper/);
    assert.match(r.ok === false ? r.message : '', /chmod \+x/);
  });

  it('follows node-pty\'s order: build type outer, base inner', () => {
    // node-pty tries build/Release under BOTH bases before reaching prebuilds.
    // Base-outer ordering would pick the root prebuild over the bundled
    // lib/build/Release that node-pty actually loads.
    const nativeDirs = new Set([`${ROOT}/lib/build/Release`, `${ROOT}/prebuilds/darwin-arm64`]);
    const probe: HelperProbeFs = {
      loadsNative: (p: string) => p.endsWith('pty.node'),
      existsSync: (p) => [...nativeDirs].some((d) => p === `${d}/pty.node`) || p === `${ROOT}/package.json`,
      statSync: () => ({ isFile: () => true }),
      accessSync: () => {},
      constants: { X_OK: 1 },
    };
    assert.equal(findHelperPath(ROOT, 'darwin', 'arm64', probe), `${ROOT}/lib/build/Release/spawn-helper`);
  });

  it('refuses a DIRECTORY sitting at the helper path', () => {
    // accessSync(dir, X_OK) succeeds for any searchable directory, so an
    // existence+X_OK check alone reports a corrupt install as healthy.
    const probe: HelperProbeFs = {
      loadsNative: (p: string) => p.endsWith('pty.node'),
      existsSync: (p) => p === PREBUILD_HELPER || p === `${ROOT}/prebuilds/darwin-arm64/pty.node` || p === `${ROOT}/package.json`,
      statSync: () => ({ isFile: () => false }),   // it is a directory
      accessSync: () => {},                         // and X_OK succeeds
      constants: { X_OK: 1 },
    };
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.message : '', /not a file/);
  });

  it('does NOT abort when a stale build/Release sits beside a healthy prebuild', () => {
    // ⚠️ node-pty require()s each candidate and skips one that fails to load,
    // so a dead build/Release left over from a source build is not the helper
    // it executes. Reporting a fault from that directory would abort an attach
    // that works perfectly. Any usable candidate means silence.
    const probe: HelperProbeFs = {
      // STALE means it does not LOAD — that is the whole point. node-pty
      // require()s it, catches the failure, and moves on to the prebuild.
      loadsNative: (p: string) => p === `${ROOT}/prebuilds/darwin-arm64/pty.node`,
      existsSync: (p) =>
        p === `${ROOT}/package.json`
        || p === `${ROOT}/build/Release/pty.node`          // present but unloadable
        || p === `${ROOT}/prebuilds/darwin-arm64/pty.node`
        || p === PREBUILD_HELPER,
      statSync: () => ({ isFile: () => true }),
      accessSync: () => {},
      constants: { X_OK: 1 },
    };
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, true, r.ok === false ? r.message : '');
  });

  it('reports a broken helper beside the module that DOES load, even when a complete prebuild sits behind it', () => {
    // ⚠️ The mirror case. node-pty stops at the first module that loads, so a
    // healthy prebuild further down is never reached and cannot excuse a
    // broken helper in front of it.
    const probe: HelperProbeFs = {
      loadsNative: (p: string) => p.endsWith('pty.node'),   // BOTH load
      existsSync: (p) =>
        p === `${ROOT}/package.json`
        || p === `${ROOT}/build/Release/pty.node`           // loads, but no helper beside it
        || p === `${ROOT}/prebuilds/darwin-arm64/pty.node`
        || p === PREBUILD_HELPER,                            // complete, but never reached
      statSync: () => ({ isFile: () => true }),
      accessSync: () => {},
      constants: { X_OK: 1 },
    };
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.message : '', /build\/Release\/spawn-helper/);
  });

  it('still reports when NO candidate has a usable helper', () => {
    // The conservative rule must not become "never report anything".
    const probe: HelperProbeFs = {
      loadsNative: (p: string) => p.endsWith('pty.node'),
      existsSync: (p) =>
        p === `${ROOT}/package.json`
        || p === `${ROOT}/build/Release/pty.node`
        || p === `${ROOT}/prebuilds/darwin-arm64/pty.node`,
      statSync: () => ({ isFile: () => true }),
      accessSync: () => { throw new Error('EACCES'); },
      constants: { X_OK: 1 },
    };
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, false);
  });

  it('lists candidates in node-pty order', () => {
    const probe: HelperProbeFs = {
      loadsNative: (p: string) => p.endsWith('pty.node'),
      existsSync: (p) => p.endsWith('pty.node'),
      statSync: () => ({ isFile: () => true }),
      accessSync: () => {},
      constants: { X_OK: 1 },
    };
    const c = findHelperCandidates(ROOT, 'darwin', 'arm64', probe);
    assert.ok(c[0].includes('build/Release'));
    assert.ok(c.some((x) => x.includes('prebuilds/darwin-arm64')));
    assert.ok(c.indexOf(c.find((x) => x.includes('build/Release'))!) < c.findIndex((x) => x.includes('prebuilds')));
  });

  it('stays silent when node-pty is there but its native dir is not', () => {
    const probe = io({}, '/nowhere');
    const r = checkPtyHelper({ platform: 'darwin', arch: 'arm64', nodePtyRoot: ROOT, io: probe });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.reason, 'not-applicable');
  });
});

describe('locating node-pty', () => {
  it('finds the real package root from this module', async () => {
    const { findNodePtyRoot } = await import('./check-pty-helper.js');
    const root = findNodePtyRoot(import.meta.url);
    // node-pty is a real dependency, so this must resolve on any platform.
    assert.ok(root, 'node-pty package root should resolve');
    assert.match(root ?? '', /node-pty$/);
  });

  it('returns undefined rather than throwing when resolution fails', async () => {
    const { findNodePtyRoot } = await import('./check-pty-helper.js');
    assert.equal(findNodePtyRoot('/definitely/not/a/module.js'), undefined);
  });
});
