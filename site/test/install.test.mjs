import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

// Runs install.sh under /bin/sh with a PATH holding only stubs, so no real node,
// npm or global install is touched. npm records its argv; `npm install` drops a
// yolo-bridge stub into the prefix's bin, like the real package would.
function run({node = '20.11.1', npm = true, writable = true, fresh = false, env = {}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yolobridge-sh-'));
  const bin = join(root, 'stubs'), prefix = join(root, 'prefix');
  mkdirSync(bin);
  if (fresh) mkdirSync(prefix); // a brand-new prefix: npm creates lib/ and bin/ itself
  else { mkdirSync(join(prefix, 'lib', 'node_modules'), {recursive: true}); mkdirSync(join(prefix, 'bin')); }
  if (!writable) { chmodSync(join(prefix, 'lib', 'node_modules'), 0o555); chmodSync(join(prefix, 'bin'), 0o555); }
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  for (const tool of ['cat']) stub(tool, `exec /bin/${tool} "$@"`);
  stub('dirname', 'exec /usr/bin/dirname "$@"');
  stub('uname', 'echo Linux');
  if (node) stub('node', `echo ${node}`);
  if (npm) stub('npm', `
if [ "$1 $2" = "prefix -g" ]; then echo "${prefix}"; exit 0; fi
echo "$@" > "${root}/npm-args"
/bin/mkdir -p "${prefix}/bin"; printf '#!/bin/sh\\necho 0.32.1\\n' > "${prefix}/bin/yolo-bridge"; /bin/chmod +x "${prefix}/bin/yolo-bridge"`);
  const result = spawnSync('/bin/sh', [installer], {
    encoding: 'utf8', env: {PATH: `${bin}:${prefix}/bin`, HOME: root, NO_COLOR: '1', ...env},
  });
  const npmArgs = existsSync(join(root, 'npm-args')) ? readFileSync(join(root, 'npm-args'), 'utf8').trim() : null;
  return {...result, npmArgs};
}

test('installs the latest package globally without sudo and prints next steps', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.npmArgs, 'install --global --no-fund --no-audit @yolo-labs/yolobridge@latest');
  assert.match(r.stdout, /Installed yolo-bridge 0\.32\.1\./);
  assert.match(r.stdout, /yolo-bridge login/);
  assert.match(r.stdout, /yolo-bridge attach/);
});

test('installs into a brand-new npm prefix that has no lib/ or bin/ yet', () => {
  const r = run({fresh: true});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.npmArgs, 'install --global --no-fund --no-audit @yolo-labs/yolobridge@latest');
});

test('YOLOBRIDGE_VERSION pins a release', () => {
  assert.equal(run({env: {YOLOBRIDGE_VERSION: '0.32.1'}}).npmArgs, 'install --global --no-fund --no-audit @yolo-labs/yolobridge@0.32.1');
});

test('rejects a malformed YOLOBRIDGE_VERSION before running npm', () => {
  for (const bad of ['--registry=evil', '../x', '1.0.0;rm', '']) {
    const r = run({env: {YOLOBRIDGE_VERSION: bad}});
    if (bad === '') { assert.equal(r.status, 0); continue; } // empty means latest
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /Invalid YOLOBRIDGE_VERSION/);
    assert.equal(r.npmArgs, null);
  }
});

test('explains a missing Node.js instead of installing one', () => {
  const r = run({node: null});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs Node\.js 20 or newer/);
  assert.equal(r.npmArgs, null);
});

test('refuses Node older than 20', () => {
  const r = run({node: '18.19.0'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node\.js 18\.19\.0 found; yolo-bridge needs 20 or newer/);
});

test('refuses a root-owned npm prefix instead of using sudo', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, () => {
  const r = run({writable: false});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs sudo\. This script won't use sudo/);
  assert.match(r.stderr, /npm config set prefix/);
  assert.equal(r.npmArgs, null);
});

test('refuses unsupported platforms', () => {
  const r = run({env: {}});
  assert.equal(r.status, 0);
  const root = mkdtempSync(join(tmpdir(), 'yolobridge-sh-'));
  writeFileSync(join(root, 'uname'), '#!/bin/sh\necho MINGW64_NT\n'); chmodSync(join(root, 'uname'), 0o755);
  const w = spawnSync('/bin/sh', [installer], {encoding: 'utf8', env: {PATH: `${root}:/bin`, NO_COLOR: '1'}});
  assert.equal(w.status, 1);
  assert.match(w.stderr, /macOS and Linux/);
});
