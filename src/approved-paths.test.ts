/**
 * The approval list that bounds what the ATTACHED AGENT may send.
 *
 * The containment tests below are the reason this file exists. A naive
 * `startsWith` on an UNRESOLVED path accepts a symlink sitting inside an
 * approved directory and pointing at `~/.ssh/id_rsa` — which is exactly the
 * shape of the attack this list is supposed to stop, and it passes every
 * happy-path test you could write.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  approvePath,
  revokePath,
  listApprovals,
  checkPathApproved,
  isWithinRoot,
  runAllow,
  defaultResolver,
} from './approved-paths.js';
import { type ConfigStoreIO } from './config-store.js';

const ENV = { HOME: '/home/yolo' };
const WS = 'ws-1';
const OTHER_WS = 'ws-2';

function fakeIO(): ConfigStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (p: string) => files.get(p),
    writeFile: (p: string, c: string) => { files.set(p, c); },
    removeFile: (p: string) => { files.delete(p); },
  };
}

function scratch(): string {
  // realpath: on macOS /tmp is itself a symlink, which would make every
  // containment comparison below wrong for the wrong reason.
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'yb-allow-')));
}

describe('isWithinRoot', () => {
  it('accepts the root itself and anything under it', () => {
    assert.equal(isWithinRoot('/a/b', '/a/b'), true);
    assert.equal(isWithinRoot('/a/b/c.mp4', '/a/b'), true);
  });

  it('rejects a SIBLING sharing a name prefix', () => {
    // Without a separator-aware compare, an approval of /a/proj also covers
    // /a/proj-secrets.
    assert.equal(isWithinRoot('/a/proj-secrets/creds', '/a/proj'), false);
  });

  it('rejects a path outside the root', () => {
    assert.equal(isWithinRoot('/other/x', '/a/b'), false);
  });
});

describe('approvePath', () => {
  it('stores the RESOLVED path, so the record cannot be re-pointed later', () => {
    const dir = scratch();
    try {
      const real = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      const io = fakeIO();

      const res = approvePath(link, WS, ENV, io);
      assert.equal(res.ok, true);
      if (res.ok) {
        assert.equal(res.approved.path, real, 'must store the realpath, not the symlink');
        assert.equal(res.approved.raw, link);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a path that does not exist, at approval time', () => {
    const io = fakeIO();
    const res = approvePath('/definitely/not/here', WS, ENV, io);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /No such path/);
  });

  it('is idempotent', () => {
    const dir = scratch();
    try {
      const io = fakeIO();
      approvePath(dir, WS, ENV, io);
      const again = approvePath(dir, WS, ENV, io);
      assert.equal(again.ok, true);
      if (again.ok) assert.equal(again.alreadyPresent, true);
      assert.equal(listApprovals(WS, ENV, io).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkPathApproved', () => {
  it('approves a file under an approved root', () => {
    const dir = scratch();
    try {
      const io = fakeIO();
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      approvePath(dir, WS, ENV, io);
      assert.equal(checkPathApproved(f, WS, [], ENV, io).approved, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('REFUSES a symlink inside an approved root that resolves outside it', () => {
    // The whole point of the module.
    const dir = scratch();
    const secretDir = scratch();
    try {
      const secret = path.join(secretDir, 'id_rsa');
      writeFileSync(secret, 'PRIVATE KEY');
      const project = path.join(dir, 'project');
      mkdirSync(project);
      const trap = path.join(project, 'innocent.mp4');
      symlinkSync(secret, trap);

      const io = fakeIO();
      approvePath(project, WS, ENV, io);

      const check = checkPathApproved(trap, WS, [], ENV, io);
      assert.equal(check.approved, false, 'a symlink escaping the approved root must be refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('refuses a `..` escape', () => {
    const dir = scratch();
    try {
      const project = path.join(dir, 'project');
      mkdirSync(project);
      const outside = path.join(dir, 'outside.txt');
      writeFileSync(outside, 'x');
      const io = fakeIO();
      approvePath(project, WS, ENV, io);
      assert.equal(checkPathApproved(path.join(project, '..', 'outside.txt'), WS, [], ENV, io).approved, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a sibling directory sharing a name prefix', () => {
    const dir = scratch();
    try {
      const project = path.join(dir, 'proj');
      const sibling = path.join(dir, 'proj-secrets');
      mkdirSync(project); mkdirSync(sibling);
      const secret = path.join(sibling, 'creds');
      writeFileSync(secret, 'x');
      const io = fakeIO();
      approvePath(project, WS, ENV, io);
      assert.equal(checkPathApproved(secret, WS, [], ENV, io).approved, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does NOT honour an approval made for a different workspace', () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      const io = fakeIO();
      approvePath(dir, OTHER_WS, ENV, io);
      assert.equal(checkPathApproved(f, WS, [], ENV, io).approved, false);
      assert.equal(checkPathApproved(f, OTHER_WS, [], ENV, io).approved, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('honours the implicit working-directory root without any stored approval', () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      const io = fakeIO();
      assert.equal(checkPathApproved(f, WS, [dir], ENV, io).approved, true);
      assert.equal(listApprovals(WS, ENV, io).length, 0, 'implicit roots are not stored');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a symlink escaping the IMPLICIT root too', () => {
    const dir = scratch();
    const secretDir = scratch();
    try {
      const secret = path.join(secretDir, 'id_rsa');
      writeFileSync(secret, 'x');
      const trap = path.join(dir, 'innocent.mp4');
      symlinkSync(secret, trap);
      assert.equal(checkPathApproved(trap, WS, [dir], ENV, fakeIO()).approved, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('fails closed on a nonexistent path and on a broken symlink', () => {
    const dir = scratch();
    try {
      const broken = path.join(dir, 'broken');
      symlinkSync(path.join(dir, 'gone'), broken);
      const io = fakeIO();
      assert.equal(checkPathApproved(path.join(dir, 'nope'), WS, [dir], ENV, io).approved, false);
      assert.equal(checkPathApproved(broken, WS, [dir], ENV, io).approved, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats a CORRUPT approval file as empty, never as permissive', () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      const io = fakeIO();
      approvePath(dir, WS, ENV, io);
      for (const [k] of io.files) io.files.set(k, '{ not json');
      assert.equal(checkPathApproved(f, WS, [], ENV, io).approved, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('revokePath', () => {
  it('removes an approval so the path stops being sendable', () => {
    const dir = scratch();
    try {
      const f = path.join(dir, 'cut.mp4');
      writeFileSync(f, 'x');
      const io = fakeIO();
      approvePath(dir, WS, ENV, io);
      assert.equal(checkPathApproved(f, WS, [], ENV, io).approved, true);

      assert.equal(revokePath(dir, WS, ENV, io).removed, 1);
      assert.equal(checkPathApproved(f, WS, [], ENV, io).approved, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not touch another workspace\'s approval of the same path', () => {
    const dir = scratch();
    try {
      const io = fakeIO();
      approvePath(dir, WS, ENV, io);
      approvePath(dir, OTHER_WS, ENV, io);
      revokePath(dir, WS, ENV, io);
      assert.equal(listApprovals(WS, ENV, io).length, 0);
      assert.equal(listApprovals(OTHER_WS, ENV, io).length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('runAllow', () => {
  const attached = () => ({ workspaceId: WS });

  it('refuses when not attached — an approval must name a workspace', () => {
    const res = runAllow(['/tmp'], { env: ENV, io: fakeIO(), loadAttachmentImpl: () => undefined });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, 'not-attached');
      assert.match(res.message, /yolo-bridge attach/);
    }
  });

  it('adds, lists and removes', () => {
    const dir = scratch();
    try {
      const io = fakeIO();
      const deps = { env: ENV, io, loadAttachmentImpl: attached };

      const added = runAllow([dir], deps);
      assert.equal(added.ok, true);

      const listed = runAllow(['--list'], deps);
      assert.equal(listed.ok, true);
      if (listed.ok) assert.ok(listed.lines.join('\n').includes(dir));

      const removed = runAllow(['--remove', dir], deps);
      assert.equal(removed.ok, true);

      const empty = runAllow(['--list'], deps);
      assert.equal(empty.ok, true);
      if (empty.ok) assert.match(empty.lines.join('\n'), /No approved paths/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports a removal that matched nothing rather than claiming success', () => {
    const res = runAllow(['--remove', '/tmp/never-approved-xyz'], {
      env: ENV, io: fakeIO(), loadAttachmentImpl: attached,
    });
    assert.equal(res.ok, false);
  });
});

describe('defaultResolver', () => {
  it('follows symlinks and reports missing paths as undefined', () => {
    const dir = scratch();
    try {
      const real = path.join(dir, 'real.txt');
      writeFileSync(real, 'x');
      const link = path.join(dir, 'link.txt');
      symlinkSync(real, link);
      assert.equal(defaultResolver.realpath(link), real);
      assert.equal(defaultResolver.realpath(path.join(dir, 'gone')), undefined);
      assert.equal(defaultResolver.isDirectory(dir), true);
      assert.equal(defaultResolver.isDirectory(real), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('status visibility', () => {
  it('shows approved paths, so a standing grant is never invisible', async () => {
    const { getStatus, formatStatus } = await import('./status-cmd.js');
    const { saveAuth, saveAttachment } = await import('./config-store.js');
    const dir = scratch();
    try {
      const io = fakeIO();
      saveAuth({ accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresAtMs: Date.now() + 1e6 }, ENV, io);
      saveAttachment({ workspaceId: WS, tileId: 't', attachmentId: 'att', attachedAt: new Date().toISOString() }, ENV, io);
      approvePath(dir, WS, ENV, io);

      const rendered = formatStatus(getStatus({ env: ENV, io }));
      assert.ok(rendered.includes(dir), 'the approved path must appear in status output');
      assert.match(rendered, /may send files from/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('shellQuote — the removal hint is a line the operator may paste', () => {
  it('quotes a path with spaces so it stays one argument', async () => {
    const { shellQuote } = await import('./approved-paths.js');
    assert.equal(shellQuote('/home/yolo/My Footage'), `'/home/yolo/My Footage'`);
  });

  it('neutralises shell metacharacters rather than emitting a runnable command', async () => {
    const { shellQuote } = await import('./approved-paths.js');
    const nasty = '/tmp/a; rm -rf ~';
    const quoted = shellQuote(nasty);
    // The `;` must be inside the quotes, i.e. literal.
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    assert.ok(quoted.includes('; rm -rf ~'));
    assert.equal(quoted.indexOf("'", 1), quoted.length - 1, 'no unbalanced quote can end the string early');
  });

  it("escapes an embedded single quote", async () => {
    const { shellQuote } = await import('./approved-paths.js');
    // A directory can legitimately be named "Ben's clips".
    assert.equal(shellQuote("/a/Ben's clips"), `'/a/Ben'\\''s clips'`);
  });

  it('the removal hint printed by `allow` is quoted', async () => {
    const dir = scratch();
    const spaced = path.join(dir, 'My Footage');
    mkdirSync(spaced);
    try {
      const io = fakeIO();
      const res = runAllow([spaced], { env: ENV, io, loadAttachmentImpl: () => ({ workspaceId: WS }) });
      assert.equal(res.ok, true);
      if (res.ok) {
        const hint = res.lines.find((l) => l.includes('--remove'))!;
        assert.ok(hint.includes(`'${spaced}'`), `hint must quote the path: ${hint}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('revokePath — one removal must not take unrelated grants with it', () => {
  it('does NOT revoke a second approval that shared the same relative spelling', async () => {
    // codex P2: approving `output` from two different working directories
    // stores two distinct resolved paths with an identical `raw`. Matching on
    // `raw` deleted both.
    const a = scratch();
    const b = scratch();
    try {
      const outA = path.join(a, 'output');
      const outB = path.join(b, 'output');
      mkdirSync(outA); mkdirSync(outB);
      const io = fakeIO();

      const cwdA = process.cwd();
      process.chdir(a);
      approvePath('output', WS, ENV, io);
      process.chdir(b);
      approvePath('output', WS, ENV, io);
      process.chdir(cwdA);

      assert.equal(listApprovals(WS, ENV, io).length, 2);

      // Revoke by the RELATIVE spelling — this is what triggers the bug. Doing
      // it by absolute path does not, which is how the first version of this
      // test managed to stay green with the defect re-introduced.
      process.chdir(a);
      const removed = revokePath('output', WS, ENV, io).removed;
      process.chdir(cwdA);
      assert.equal(removed, 1);
      const left = listApprovals(WS, ENV, io);
      assert.equal(left.length, 1, 'the other workspace-mate approval must survive');
      assert.equal(left[0]!.path, outB);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('can still revoke a grant whose directory has since been deleted', async () => {
    const dir = scratch();
    const doomed = path.join(dir, 'gone-later');
    mkdirSync(doomed);
    try {
      const io = fakeIO();
      approvePath(doomed, WS, ENV, io);
      rmSync(doomed, { recursive: true, force: true });
      // realpath now fails; the operator must not be stuck with a dangling grant.
      assert.equal(revokePath(doomed, WS, ENV, io).removed, 1);
      assert.equal(listApprovals(WS, ENV, io).length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkPathApproved — hands back the canonical path to open', () => {
  it('returns the RESOLVED path so a consumer never re-opens the name it checked', async () => {
    // Checking one path and opening another is how symlink containment is
    // defeated: the link can be repointed in between.
    const dir = scratch();
    try {
      const real = path.join(dir, 'real.mp4');
      writeFileSync(real, 'x');
      const link = path.join(dir, 'link.mp4');
      symlinkSync(real, link);

      const check = checkPathApproved(link, WS, [dir], ENV, fakeIO());
      assert.equal(check.approved, true);
      assert.equal(check.resolvedPath, real, 'must hand back the target, not the link');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries no path when it refuses, so there is nothing to open by mistake', () => {
    const dir = scratch();
    const secretDir = scratch();
    try {
      const secret = path.join(secretDir, 'id_rsa');
      writeFileSync(secret, 'x');
      const trap = path.join(dir, 'innocent.mp4');
      symlinkSync(secret, trap);
      const check = checkPathApproved(trap, WS, [dir], ENV, fakeIO());
      assert.equal(check.approved, false);
      assert.equal(check.resolvedPath, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });
});
