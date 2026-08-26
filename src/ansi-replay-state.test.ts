/**
 * The escape-state machine and sticky-mode tracker that make a raw replay
 * durable at its two edges (see `ansi-replay-state.ts`'s header).
 *
 * These are the UNIT tests: they pin the machine's answers byte by byte, on
 * inputs chosen because they are the ones a naive implementation gets wrong —
 * an OSC string containing a newline, a truncated CSI, an SS2 shift, a `38;2`
 * colour whose channel values would read as attributes if the parser lost
 * count. The END-TO-END property (a viewer that ends up cell-for-cell
 * identical to the daemon) lives in `raw-replay.test.ts`, against real
 * terminals; nothing here is a substitute for that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AnsiScanner,
  TerminalModeTracker,
  buildModePrologue,
  resolveGroundStart,
  type AnsiParserState,
  type ObservedTerminalModes,
} from './ansi-replay-state.js';

const ESC = '\x1b';
const BEL = '\x07';

/** Every absolute offset at which a scan of `text` is in ground state. */
function groundOffsets(text: string, from: AnsiParserState = 'ground', startOffset = 0): number[] {
  const scanner = new AnsiScanner();
  scanner.reset(from);
  const seen: number[] = [];
  scanner.feed(text, startOffset, { ground: (o) => seen.push(o) });
  return seen;
}

/** The parser state left behind after consuming `text`. */
function stateAfter(text: string, from: AnsiParserState = 'ground'): AnsiParserState {
  const scanner = new AnsiScanner();
  scanner.reset(from);
  scanner.feed(text, 0);
  return scanner.state;
}

const DEFAULT_OBSERVED: ObservedTerminalModes = {
  altScreen: false,
  wraparound: true,
  origin: false,
  insert: false,
  reverseWraparound: false,
};

describe('AnsiScanner — where a replay may safely begin', () => {
  it('treats every boundary in plain text as ground', () => {
    assert.deepEqual(groundOffsets('abc'), [0, 1, 2, 3]);
  });

  it('marks NO boundary inside a CSI sequence as ground', () => {
    // `ESC [ 3 8 ; 5 ; 1 9 6 m` occupies offsets 1..11. Ground is offered
    // before the `a` (0), before the ESC (1) and after the `m` (12) — and at
    // no offset in between, which is the whole point.
    assert.deepEqual(groundOffsets(`a${ESC}[38;5;196mb`), [0, 1, 12, 13]);
  });

  it('marks NO boundary inside an OSC string as ground — INCLUDING after a newline', () => {
    // The reason "scan back to the last \n" is wrong rather than merely
    // approximate: an OSC payload may contain one, and a replay starting after
    // it feeds the terminal the tail of a string sequence as if it were text.
    const text = `${ESC}]0;my\ntitle${BEL}x`;
    const ground = groundOffsets(text);
    const newlineAt = text.indexOf('\n');
    assert.equal(ground.includes(newlineAt + 1), false, 'the byte after the newline is INSIDE the OSC');
    assert.deepEqual(ground, [0, text.length - 1, text.length]);
  });

  it('ends an OSC on ST (ESC backslash) as well as on BEL', () => {
    const text = `${ESC}]8;;https://example.com${ESC}\\ok`;
    const ground = groundOffsets(text);
    assert.equal(ground[0], 0);
    assert.equal(ground[1], text.indexOf('ok'), 'ground resumes right after the ST');
  });

  it('keeps a DCS/APC/PM/SOS body out of ground until its terminator', () => {
    for (const introducer of ['P', '_', '^', 'X']) {
      const text = `${ESC}${introducer}payload;1;2${ESC}\\z`;
      const ground = groundOffsets(text);
      assert.deepEqual(ground, [0, text.length - 1, text.length], `ESC ${introducer}`);
    }
  });

  it('does not offer the gap between an SS2/SS3 shift and the character it shifts', () => {
    // `ESC N x` — starting at `x` would render it out of the wrong character
    // set, so that boundary is deliberately not ground.
    assert.deepEqual(groundOffsets(`${ESC}Nxy`), [0, 3, 4]);
    assert.deepEqual(groundOffsets(`${ESC}Oxy`), [0, 3, 4]);
  });

  it('counts UTF-8 BYTES, not UTF-16 code units', () => {
    // '╭' is 3 bytes, '🙂' is 4 (and two code units).
    assert.deepEqual(groundOffsets('╭a🙂'), [0, 3, 4, 8]);
  });

  it('resumes from a saved state, which is what makes a rolled ring answerable', () => {
    // Split an OSC across two feeds: the second feed only knows it is inside a
    // string because the first one left the scanner there.
    const scanner = new AnsiScanner();
    const end = scanner.feed(`${ESC}]0;half`, 0);
    assert.equal(scanner.state, 'string');
    const seen: number[] = [];
    scanner.feed(`-title${BEL}z`, end, { ground: (o) => seen.push(o) });
    assert.deepEqual(seen, [end + 7, end + 8]);
  });

  it('leaves the parser exactly where an unterminated sequence stopped', () => {
    assert.equal(stateAfter(`${ESC}[38;5`), 'csi');
    assert.equal(stateAfter(`${ESC}]0;title`), 'string');
    assert.equal(stateAfter(ESC), 'esc');
    assert.equal(stateAfter(`${ESC}(`), 'esc-intermediate');
    assert.equal(stateAfter(`${ESC}[38;5;196m`), 'ground');
  });

  it('lets CAN and SUB abort a sequence, as every VT parser does', () => {
    assert.equal(stateAfter(`${ESC}[38\x18`), 'ground');
    assert.equal(stateAfter(`${ESC}]0;t\x1a`), 'ground');
  });
});

describe('resolveGroundStart — the offset a replay actually begins at', () => {
  const text = `abc${ESC}[31mdef`;

  it('backs up to the previous ground boundary when the window still holds it', () => {
    // A cut at offset 5 lands inside `ESC [ 3 1 m` (offsets 3..7).
    assert.equal(resolveGroundStart(text, 0, 'ground', 5), 3);
  });

  it('returns the target unchanged when it is already ground', () => {
    assert.equal(resolveGroundStart(text, 0, 'ground', 8), 8);
    assert.equal(resolveGroundStart(text, 0, 'ground', 0), 0);
  });

  it('skips FORWARD when nothing earlier is retained — the rolled-ring case', () => {
    // The window starts at offset 100 and its first byte is already three
    // bytes into a CSI, so there is no earlier ground offset in existence.
    const window = `1mrest`;
    assert.equal(resolveGroundStart(window, 100, 'csi', 100), 102, 'first ground is after the `m`');
  });

  it('yields an EMPTY replay when the whole window is one unterminated string', () => {
    // Every byte is a fragment of something no parser can resume mid-way, so
    // the honest answer is "start at the end and replay nothing".
    const window = 'still inside an OSC payload';
    assert.equal(resolveGroundStart(window, 10, 'string', 10), 10 + window.length);
  });
});

describe('TerminalModeTracker — the sticky modes xterm does not expose', () => {
  function track(bytes: string, rows = 10): TerminalModeTracker {
    const tracker = new TerminalModeTracker(rows);
    new AnsiScanner().feed(bytes, 0, tracker.sink);
    return tracker;
  }

  it('follows DECSTBM, and keeps a region per BUFFER', () => {
    const t = track(`${ESC}[3;6r`);
    assert.deepEqual(t.regionFor('normal'), { top: 3, bottom: 6 });
    assert.deepEqual(t.regionFor('alternate'), { top: 1, bottom: 10 });
  });

  it('resets the ALT region on entering and leaving the alternate screen, and keeps the normal one', () => {
    // Matches xterm's observed behaviour — which is the only reason the two
    // regions are tracked separately at all.
    const t = track(`${ESC}[2;9r${ESC}[?1049h${ESC}[3;6r${ESC}[?1049l`);
    assert.deepEqual(t.regionFor('normal'), { top: 2, bottom: 9 }, 'survives the round trip');
    assert.deepEqual(t.regionFor('alternate'), { top: 1, bottom: 10 }, 'reset on the way out');
    assert.equal(t.isAltScreen, false);
  });

  it('clamps a bottom past the last row and IGNORES a degenerate region', () => {
    assert.deepEqual(track(`${ESC}[3;99r`).regionFor('normal'), { top: 3, bottom: 10 });
    // An inverted region leaves the previous one in force rather than
    // resetting it — same as xterm.
    assert.deepEqual(track(`${ESC}[2;9r${ESC}[5;3r`).regionFor('normal'), { top: 2, bottom: 9 });
    assert.deepEqual(track(`${ESC}[2;9r${ESC}[0;0r`).regionFor('normal'), { top: 2, bottom: 9 });
    // A bare `CSI r` means the whole screen.
    assert.deepEqual(track(`${ESC}[2;9r${ESC}[r`).regionFor('normal'), { top: 1, bottom: 10 });
  });

  it('follows DECTCEM', () => {
    assert.equal(track(`${ESC}[?25l`).isCursorHidden, true);
    assert.equal(track(`${ESC}[?25l${ESC}[?25h`).isCursorHidden, false);
    // Bundled with other private modes in one sequence, as real TUIs write it.
    assert.equal(track(`${ESC}[?25;1049l`).isCursorHidden, true);
  });

  it('accumulates SGR, including the indexed and direct colour forms', () => {
    assert.equal(track(`${ESC}[1;31m`).sgrState.fg, '31');
    assert.equal(track(`${ESC}[38;5;196m`).sgrState.fg, '38;5;196');
    assert.equal(track(`${ESC}[48;2;10;20;30m`).sgrState.bg, '48;2;10;20;30');
    assert.equal(track(`${ESC}[38:5:196m`).sgrState.fg, '38;5;196', 'colon sub-parameters');
    assert.equal(track(`${ESC}[48:2::10:20:30m`).sgrState.bg, '48;2;10;20;30');
  });

  it('does not mistake a colour CHANNEL for an attribute', () => {
    // `38;2;1;7;0` is one direct colour. A parser that resumed its loop after
    // the introducer would read the `7` as "inverse on" — visible, wrong, and
    // sticky.
    const t = track(`${ESC}[38;2;1;7;0m`);
    assert.equal(t.sgrState.fg, '38;2;1;7;0');
    assert.equal(t.sgrState.inverse, false);
  });

  it('turns attributes off again, and treats a bare CSI m as a full reset', () => {
    assert.equal(track(`${ESC}[1m${ESC}[22m`).sgrState.bold, false);
    assert.equal(track(`${ESC}[4m${ESC}[24m`).sgrState.underline, false);
    assert.equal(track(`${ESC}[4:3m`).sgrState.underline, true, 'a styled underline is still an underline');
    assert.equal(track(`${ESC}[4:0m`).sgrState.underline, false);
    assert.equal(track(`${ESC}[31m${ESC}[39m`).sgrState.fg, null);
    const reset = track(`${ESC}[1;31m${ESC}[m`).sgrState;
    assert.equal(reset.bold, false);
    assert.equal(reset.fg, null);
  });

  it('clears everything on RIS, and everything but the buffer on DECSTR', () => {
    const ris = track(`${ESC}[3;6r${ESC}[?25l${ESC}[1;31m${ESC}c`);
    assert.deepEqual(ris.regionFor('normal'), { top: 1, bottom: 10 });
    assert.equal(ris.isCursorHidden, false);
    assert.equal(ris.sgrState.bold, false);

    const decstr = track(`${ESC}[?1049h${ESC}[3;6r${ESC}[?25l${ESC}[1m${ESC}[!p`);
    assert.deepEqual(decstr.regionFor('alternate'), { top: 1, bottom: 10 });
    assert.equal(decstr.isCursorHidden, false);
    assert.equal(decstr.sgrState.bold, false);
    assert.equal(decstr.isAltScreen, true, 'a soft reset does not leave the alternate screen');
  });

  it('ignores sequences it does not model rather than half-applying them', () => {
    // Overline (53) and underline-colour (58) are not tracked; a tracker that
    // guessed at them would emit a prologue asserting something it never saw.
    const t = track(`${ESC}[53;58;5;9m`);
    assert.equal(t.sgrState.fg, null);
    assert.equal(t.sgrState.bg, null);
  });
});

describe('buildModePrologue — an honest, minimal restoration', () => {
  function tracker(bytes: string, rows = 10): TerminalModeTracker {
    const t = new TerminalModeTracker(rows);
    new AnsiScanner().feed(bytes, 0, t.sink);
    return t;
  }

  it('emits NOTHING when the daemon is in a wholly default state', () => {
    // The viewer's terminal was just reset(), so it is already here. Emitting
    // the defaults anyway is not free: `CSI ? 6 l` homes the cursor.
    assert.equal(buildModePrologue(DEFAULT_OBSERVED, tracker('')), '');
  });

  it('restores the alternate screen BEFORE the scroll region', () => {
    // Ordering is load-bearing: DECSTBM is per-buffer, so a region set before
    // the switch would land on the buffer that is about to be left.
    const out = buildModePrologue(
      { ...DEFAULT_OBSERVED, altScreen: true },
      tracker(`${ESC}[?1049h${ESC}[3;6r`),
    );
    assert.equal(out.indexOf(`${ESC}[?1049h`), 0);
    assert.ok(out.indexOf(`${ESC}[3;6r`) > 0);
  });

  it('reads alt-screen/wrap/origin/insert from the TERMINAL and region/cursor/SGR from the tracker', () => {
    const out = buildModePrologue(
      { altScreen: false, wraparound: false, origin: true, insert: true, reverseWraparound: true },
      tracker(`${ESC}[2;9r${ESC}[?25l${ESC}[1;38;5;196m`),
    );
    assert.equal(out.includes(`${ESC}[?1049h`), false, 'not on the alternate screen');
    assert.ok(out.includes(`${ESC}[2;9r`), 'scroll region');
    assert.ok(out.includes(`${ESC}[?7l`), 'autowrap off');
    assert.ok(out.includes(`${ESC}[?6h`), 'origin mode');
    assert.ok(out.includes(`${ESC}[?45h`), 'reverse wraparound');
    assert.ok(out.includes(`${ESC}[4h`), 'insert mode');
    assert.ok(out.includes(`${ESC}[?25l`), 'cursor hidden');
    assert.ok(out.includes(`${ESC}[0;1;38;5;196m`), 'SGR, re-asserted from a known-default baseline');
  });

  it('puts SGR last, so no mode set can disturb it', () => {
    const out = buildModePrologue(
      { ...DEFAULT_OBSERVED, altScreen: true },
      tracker(`${ESC}[?1049h${ESC}[31m`),
    );
    assert.ok(out.endsWith(`${ESC}[0;31m`));
  });

  it('is idempotent — applying it twice is applying it once', () => {
    // The raw tail that follows may legitimately re-assert any of these, and
    // mode sets have to tolerate that.
    const t = tracker(`${ESC}[?1049h${ESC}[3;6r${ESC}[?25l${ESC}[1;31m`);
    const observed = { ...DEFAULT_OBSERVED, altScreen: true };
    const once = buildModePrologue(observed, t);

    const replayed = new TerminalModeTracker(10);
    const scanner = new AnsiScanner();
    scanner.feed(once, 0, replayed.sink);
    scanner.feed(once, once.length, replayed.sink);
    assert.equal(
      buildModePrologue({ ...DEFAULT_OBSERVED, altScreen: replayed.isAltScreen }, replayed),
      once,
    );
  });
});
