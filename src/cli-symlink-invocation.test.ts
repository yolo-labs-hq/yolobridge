/**
 * Regression test for a real bug: `cli.ts`'s main-module guard compared
 * `import.meta.url` (resolved BY NODE'S ESM LOADER through any symlink to the
 * real underlying file) against the raw, unresolved `process.argv[1]`. That
 * comparison can only ever match when the script is invoked by its own real
 * path — which is NEVER how an installed CLI is actually run: `npm link` and
 * every real `npm install -g` set up a package's bin entry as a SYMLINK. So
 * `yolo-bridge` on PATH silently did nothing (exit 0, no output) for every
 * real install, and only `node dist/cli.js` (the direct, unlinked path)
 * happened to work — which is exactly how every prior test/manual smoke test
 * invoked it, so nothing caught this until testing the actual symlinked
 * invocation here.
 *
 * This test reproduces the real installation shape directly: create a
 * symlink to `dist/cli.js` (mirroring what `npm link`/`npm install -g`
 * produce) and invoke THROUGH the symlink, not the real path. Before the
 * fix, this failed (empty stdout). Runs against the BUILT output
 * (`npm run build` must precede `npm test`, already the house convention —
 * see package.json's `test` script) since the symlink-vs-realpath behavior
 * being tested is specific to the compiled ESM `import.meta.url` mechanics,
 * not something a source-level unit test on `parseAttachArgs` can see.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const realCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

describe('cli.js invoked through a symlink (the real npm-link / global-install shape)', () => {
  it('prints the usage banner via --help, not silently exiting 0 with no output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yolo-bridge-symlink-test-'));
    const linkPath = join(dir, 'yolo-bridge');
    try {
      symlinkSync(realCliPath, linkPath);
      const stdout = execFileSync(process.execPath, [linkPath, '--help'], { encoding: 'utf-8' });
      assert.match(stdout, /Usage: yolo-bridge <command> \[args\]/);
      assert.match(stdout, /login\s+Device-authorization login/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still works when invoked via the real (non-symlinked) path, unchanged from before', () => {
    const stdout = execFileSync(process.execPath, [realCliPath, '--help'], { encoding: 'utf-8' });
    assert.match(stdout, /Usage: yolo-bridge <command> \[args\]/);
  });
});
