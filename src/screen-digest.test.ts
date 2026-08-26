/**
 * The daemon half of the divergence detector (`screen-digest.ts`).
 *
 * Two things are under test and they are different in kind:
 *
 *   1. **Sensitivity.** The digest has to change for every difference that
 *      would be visible — a glyph, an attribute, a colour, the grid, the
 *      active buffer, and (the one a screen dump cannot see at all) the
 *      CURSOR. A detector that misses the failure mode raw replay was built to
 *      fix would be worse than none, because it would license trusting the
 *      screen.
 *   2. **Agreement with the webapp mirror.** The fixture below is asserted
 *      byte-for-byte in `webapp/lib/grid/terminal-screen-digest.test.ts`
 *      against a real `@xterm/xterm` terminal fed the identical bytes. If the
 *      two implementations ever drift, one of the two tests goes red — which
 *      is the only mechanism keeping a cross-package mirror honest.
 *
 * REAL `@xterm/headless`, per this package's test rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
import type { Terminal as TerminalType } from '@xterm/headless';

import { screenDigest, type DigestTerminal } from './screen-digest.js';

function write(term: TerminalType, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

async function terminal(data: string, cols = 12, rows = 4): Promise<TerminalType> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await write(term, data);
  return term;
}

const digest = (t: TerminalType) => screenDigest(t as unknown as DigestTerminal);

/**
 * ⚠️ THE CROSS-PACKAGE PIN. The same bytes, the same expected digest, asserted
 * from the browser side in `webapp/lib/grid/terminal-screen-digest.test.ts`.
 * Changing the algorithm means changing BOTH files and this literal in the
 * same commit — a digest that only one side computes correctly is a detector
 * that fires forever or never.
 */
export const DIGEST_FIXTURE_BYTES = 'hi \x1b[1;38;5;196mred\x1b[0m\r\nplain 日本\r\n';
export const DIGEST_FIXTURE_VALUE = '3c06d971';

describe('screenDigest', () => {
  it('matches the value the webapp mirror must produce for the same bytes', async () => {
    assert.equal(digest(await terminal(DIGEST_FIXTURE_BYTES)), DIGEST_FIXTURE_VALUE);
  });

  it('is stable — the same screen digests the same every time', async () => {
    const a = await terminal('hello\r\nworld');
    const b = await terminal('hello\r\nworld');
    assert.equal(digest(a), digest(b));
  });

  it('changes when a GLYPH changes', async () => {
    assert.notEqual(digest(await terminal('hello')), digest(await terminal('hellp')));
  });

  it('changes when only an ATTRIBUTE or COLOUR changes', async () => {
    const plain = await terminal('word');
    assert.notEqual(digest(plain), digest(await terminal(`${'\x1b'}[1mword`)), 'bold');
    assert.notEqual(digest(plain), digest(await terminal(`${'\x1b'}[31mword`)), 'palette fg');
    assert.notEqual(
      digest(await terminal(`${'\x1b'}[38;5;9mword`)),
      digest(await terminal(`${'\x1b'}[38;2;255;0;0mword`)),
      'indexed and direct red are different cells',
    );
  });

  it('changes when only the CURSOR moves', async () => {
    // The defect raw replay exists to fix, and the one a glyph comparison is
    // blind to: identical text, wrong origin for the next relative redraw.
    const a = await terminal('abc');
    const b = await terminal('abc\x1b[H');
    assert.equal(a.buffer.active.getLine(0)!.translateToString(true), 'abc');
    assert.equal(b.buffer.active.getLine(0)!.translateToString(true), 'abc');
    assert.notEqual(digest(a), digest(b));
  });

  it('changes when the ALTERNATE SCREEN is active', async () => {
    assert.notEqual(
      digest(await terminal('abc')),
      digest(await terminal('\x1b[?1049habc')),
    );
  });

  it('changes when the GRID changes', async () => {
    assert.notEqual(digest(await terminal('abc', 12, 4)), digest(await terminal('abc', 13, 4)));
    assert.notEqual(digest(await terminal('abc', 12, 4)), digest(await terminal('abc', 12, 5)));
  });

  it('ignores SCROLLBACK depth, so a truncated replay is not permanently "diverged"', async () => {
    // A viewer seeded from a rolled ring legitimately holds less history than
    // the daemon. Hashing the scrollback would report that as corruption on
    // every single poll, forever, and no re-seed could ever clear it.
    const short = await terminal('a\r\nb\r\nc\r\n', 12, 4);
    const long = await terminal('x\r\ny\r\nz\r\nw\r\nv\r\na\r\nb\r\nc\r\n', 12, 4);
    assert.ok(long.buffer.active.length > short.buffer.active.length, 'sanity: deeper history');
    assert.equal(digest(short), digest(long));
  });

  it('does not double-count the trailing half of a wide glyph', async () => {
    // A width-0 cell carries no content of its own; hashing it would make
    // every CJK character and emoji contribute twice.
    const term = await terminal('日本語', 12, 4);
    assert.equal(typeof digest(term), 'string');
    assert.equal(digest(term).length, 8);
  });
});
