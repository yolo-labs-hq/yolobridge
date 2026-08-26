/**
 * The bulletproof property of the live terminal path: **a remote viewer that
 * seeds from the raw ring and then applies the live tap ends up with a buffer
 * cell-for-cell identical to the daemon's own — cursor included.**
 *
 * WHY THIS TEST EXISTS. The tile used to seed from `serializeTerminalBuffer`,
 * a line dump. A dump carries glyphs and colours and nothing else: no cursor
 * position, no scroll region, no alternate-screen flag, no wrap mode. A real
 * TUI (Claude Code, codex) redraws with RELATIVE moves — `ESC[A`, `ESC[K`, a
 * bare `\r` — so after a dump-seed every redraw is applied from the wrong
 * origin: text drawn over other text, prompt boxes marching down the screen.
 * The operator's screenshots showed exactly that. Replaying the RAW BYTES
 * instead means the viewer's terminal parses precisely what the daemon's
 * parsed, so no state has to be reconstructed and there is no seam to get
 * wrong.
 *
 * The tests below drive TUI-shaped output (in-place spinner redraws, cursor-up
 * repaints, `\r` overwrites, an alternate-screen switch, a scroll region) and
 * assert the equality directly against the daemon's live terminal — not
 * against a serialized approximation of it.
 *
 * REAL EVERYTHING, per this package's test rules: a real `@xterm/headless`
 * terminal on both sides, the module's real ring, the real offset arithmetic.
 * The PTY is the module's documented `spawnImpl` seam (a fake IPty), the same
 * one local-agent.test.ts uses — no `node:fs` / `node:child_process` mocks.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
import type { Terminal as TerminalType, IBufferLine } from '@xterm/headless';

import {
  startLocalAgent,
  stopLocalAgent,
  takeRawSeed,
  primeRawStream,
  onLocalAgentData,
  getLocalAgentGeometry,
  __getLocalAgentTerminal,
  RAW_RING_MAX_BYTES,
  type PtySpawnImpl,
  type RawChunkMeta,
} from './local-agent.js';
import { OutputStreamBuffer } from './output-stream.js';

function fakePty() {
  let dataCb: ((d: string) => void) | undefined;
  const ipty = {
    onData: (cb: (d: string) => void) => { dataCb = cb; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    write: () => {},
    kill: () => {},
  };
  return {
    spawnImpl: (() => ipty as unknown as IPty) as PtySpawnImpl,
    emit: (d: string) => dataCb?.(d),
  };
}

afterEach(() => {
  stopLocalAgent();
});

const bytes = (s: string) => Buffer.byteLength(s, 'utf-8');

/** UTF-8-safe "drop the first `n` bytes", the viewer's dedupe primitive. */
function sliceFromUtf8Offset(s: string, byteOffset: number): string {
  if (byteOffset <= 0) return s;
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < byteOffset) {
    const code = s.codePointAt(i)!;
    seen += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  return s.slice(i);
}

function write(term: TerminalType, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, () => resolve()));
}

/**
 * A viewer: a terminal at the daemon's grid, plus the offset bookkeeping the
 * browser sink performs. Mirrors `YoloBridgeStreamSink`'s offset branch — the
 * arithmetic is what is under test, so it is spelled out here rather than
 * imported from the webapp package (a different tree, a different runtime).
 */
class Viewer {
  readonly term: TerminalType;
  epoch: string | null = null;
  nextOffset = 0;
  reseeds = 0;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
  }

  async seed(seed: { epoch: string; endOffset: number; data: string }): Promise<void> {
    this.term.reset();
    this.epoch = seed.epoch;
    this.nextOffset = seed.endOffset;
    await write(this.term, seed.data);
  }

  /** Returns false when the chunk cannot be spliced — the re-seed condition. */
  async apply(chunk: { epoch: string; startOffset: number; data: string }): Promise<boolean> {
    if (chunk.epoch !== this.epoch || chunk.startOffset > this.nextOffset) {
      this.reseeds += 1;
      return false;
    }
    const end = chunk.startOffset + bytes(chunk.data);
    if (end <= this.nextOffset) return true; // wholly duplicate — already applied
    await write(this.term, sliceFromUtf8Offset(chunk.data, this.nextOffset - chunk.startOffset));
    this.nextOffset = end;
    return true;
  }
}

/** Glyph + every attribute that can differ, as a comparable string. */
function describeCell(line: IBufferLine, x: number): string {
  const c = line.getCell(x);
  if (!c) return '<none>';
  return [
    c.getChars(),
    `${c.getFgColorMode()}:${c.getFgColor()}`,
    `${c.getBgColorMode()}:${c.getBgColor()}`,
    `${c.isBold()}${c.isDim()}${c.isItalic()}${c.isUnderline()}${c.isInverse()}${c.isStrikethrough()}`,
    c.getWidth(),
  ].join('|');
}

/** Every cell of both buffers, plus the cursor. The whole point. */
function assertIdenticalBuffers(a: TerminalType, b: TerminalType, what: string): void {
  assert.equal(a.cols, b.cols, `${what}: cols`);
  assert.equal(a.rows, b.rows, `${what}: rows`);
  const ba = a.buffer.active;
  const bb = b.buffer.active;
  assert.equal(ba.cursorX, bb.cursorX, `${what}: cursorX`);
  assert.equal(ba.cursorY, bb.cursorY, `${what}: cursorY`);
  for (let y = 0; y < a.rows; y++) {
    const la = ba.getLine(ba.viewportY + y);
    const lb = bb.getLine(bb.viewportY + y);
    assert.equal(Boolean(la), Boolean(lb), `${what}: row ${y} existence`);
    if (!la || !lb) continue;
    for (let x = 0; x < a.cols; x++) {
      assert.equal(describeCell(la, x), describeCell(lb, x), `${what}: cell (${x},${y})`);
    }
  }
}

const ESC = '\x1b';

/**
 * TUI-shaped output: an alternate-screen switch, a scroll region, a box that is
 * repainted in place with cursor-up, a spinner overwritten with bare `\r`, and
 * colour. Every construct a line dump silently loses.
 */
const TUI_PROLOGUE =
  `${ESC}[?1049h` +          // alternate screen — invisible to a line dump
  `${ESC}[?7l` +             // autowrap OFF — invisible to a line dump
  `${ESC}[1;12r` +           // scroll region (DECSTBM) — invisible to a line dump
  `${ESC}[H${ESC}[2J` +
  `${ESC}[1;36m╭──────────────────────────╮${ESC}[0m\r\n` +
  `${ESC}[1;36m│${ESC}[0m improvising…             ${ESC}[1;36m│${ESC}[0m\r\n` +
  `${ESC}[1;36m╰──────────────────────────╯${ESC}[0m\r\n` +
  `\r\n` +
  `keep\r\n`;               // …and the cursor rests on the EMPTY row below

/**
 * One in-place repaint, expressed the way a real TUI expresses it: purely
 * RELATIVE moves from wherever the cursor happens to be. Up four rows to the
 * box's middle line, erase it, rewrite it, and return to the resting row.
 * Nothing here says where on the screen anything is — which is exactly why a
 * seed that gets the cursor wrong turns every one of these into an overwrite
 * of live text.
 */
function repaint(frame: string): string {
  return `${ESC}[4A\r${ESC}[K${ESC}[1;36m│${ESC}[0m ${frame}${ESC}[4B\r`;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸'];

describe('raw replay: a viewer ends up cell-for-cell identical to the daemon', () => {
  it('seed-then-stream reproduces the daemon buffer exactly for in-place TUI redraws', async () => {
    const pty = fakePty();
    const handle = startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 60,
      rows: 12,
    });

    // The daemon's screen before anybody is watching.
    pty.emit(TUI_PROLOGUE);
    for (let i = 0; i < 3; i++) pty.emit(repaint(`${SPINNER[i]} thinking…`));

    // The viewer opens: one atomic take of the ring, and the tap.
    const seed = takeRawSeed()!;
    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((data: string, meta: RawChunkMeta) => {
      chunks.push({ epoch: meta.epoch, startOffset: meta.startOffset, data });
    });

    // …and the agent keeps drawing.
    for (let i = 0; i < 4; i++) pty.emit(repaint(`${SPINNER[i % 4]} still going…`));
    pty.emit(`\r${ESC}[Kdone.\r\n`);
    unsubscribe();

    assert.equal(seed.cols, 60);
    assert.equal(seed.rows, 12);
    assert.equal(seed.truncated, false, 'the ring has not rolled in this test');

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    for (const chunk of chunks) {
      assert.equal(await viewer.apply(chunk), true, 'no chunk should force a re-seed');
    }
    assert.equal(viewer.reseeds, 0);

    // Let the daemon's own async write chain settle before comparing.
    await (await import('./local-agent.js')).captureLocalAgentOutput();
    assertIdenticalBuffers(__getLocalAgentTerminal()!, viewer.term, 'seed+stream');
    handle.stop();
  });

  /**
   * NEGATIVE CONTROL. Without this the equality assertions above could be
   * vacuous — passing because the property is easy rather than because raw
   * replay earns it. Seeding the SAME viewer from `serializeTerminalBuffer`
   * (what the tile used to do) and applying the SAME chunks must produce a
   * DIFFERENT buffer: that difference is the reported defect.
   */
  it('a line-dump seed does NOT reproduce the daemon buffer (why raw replay exists)', async () => {
    const { serializeTerminalBuffer, captureLocalAgentOutput } = await import('./local-agent.js');
    const pty = fakePty();
    startLocalAgent({ spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 60, rows: 12 });
    pty.emit(TUI_PROLOGUE);
    for (let i = 0; i < 3; i++) pty.emit(repaint(`${SPINNER[i]} thinking…`));

    const captured = await captureLocalAgentOutput();
    const seed = takeRawSeed()!;
    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((d: string, m: RawChunkMeta) => {
      chunks.push({ epoch: m.epoch, startOffset: m.startOffset, data: d });
    });
    for (let i = 0; i < 4; i++) pty.emit(repaint(`${SPINNER[i % 4]} still going…`));
    unsubscribe();

    // The old path: reset, write the SERIALIZED SCREEN, then stream.
    const dumpViewer = new Viewer(seed.cols, seed.rows);
    dumpViewer.epoch = seed.epoch;
    dumpViewer.nextOffset = seed.endOffset;
    dumpViewer.term.reset();
    await write(dumpViewer.term, captured.output.replace(/\r?\n/g, '\r\n'));
    for (const chunk of chunks) await dumpViewer.apply(chunk);

    await captureLocalAgentOutput();
    const daemon = __getLocalAgentTerminal()!;
    assert.notEqual(
      dumpViewer.term.buffer.active.cursorY,
      -1,
      'sanity: the dump viewer has a buffer',
    );
    assert.throws(
      () => assertIdenticalBuffers(daemon, dumpViewer.term, 'line-dump seed'),
      /line-dump seed/,
      'a line dump loses cursor/mode state, so the redraws land in the wrong place',
    );
    assert.equal(serializeTerminalBuffer(dumpViewer.term) !== serializeTerminalBuffer(daemon), true);
  });

  it('does NOT march the TUI down the screen (the defect a line-dump seed produced)', async () => {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 60,
      rows: 12,
    });
    pty.emit(TUI_PROLOGUE);
    const seed = takeRawSeed()!;
    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((d: string, m: RawChunkMeta) => {
      chunks.push({ epoch: m.epoch, startOffset: m.startOffset, data: d });
    });
    for (let i = 0; i < 12; i++) pty.emit(repaint(`${SPINNER[i % 4]} frame ${i}`));
    unsubscribe();

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    for (const chunk of chunks) await viewer.apply(chunk);

    // The box was repainted 12 times IN PLACE: it must still occupy rows 0-2
    // and there must be exactly one of it on screen.
    const active = viewer.term.buffer.active;
    const rowText = (y: number) => {
      const line = active.getLine(active.viewportY + y);
      return line ? line.translateToString(true) : '';
    };
    assert.match(rowText(0), /╭─+╮/, 'the box top stays on row 0');
    assert.match(rowText(1), /frame 11/, 'the latest frame replaced the previous one in place');
    assert.match(rowText(2), /╰─+╯/, 'the box bottom stays on row 2');
    let boxTops = 0;
    for (let y = 0; y < viewer.term.rows; y++) if (/╭─+╮/.test(rowText(y))) boxTops += 1;
    assert.equal(boxTops, 1, 'exactly one prompt box — no downward drift');
  });

  it('applies bytes emitted DURING the seed round trip exactly once', async () => {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 40,
      rows: 8,
    });
    pty.emit(`${ESC}[H${ESC}[2Jbefore\r\n`);

    // The tap starts BEFORE the seed is taken — the real ordering, since the
    // stream lease and the seed fetch are independent round trips. Bytes in
    // this window are in the ring AND in the stream.
    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((d: string, m: RawChunkMeta) => {
      chunks.push({ epoch: m.epoch, startOffset: m.startOffset, data: d });
    });
    pty.emit('during-1\r\n');
    pty.emit('during-2\r\n');
    const seed = takeRawSeed()!;   // covers before + during-1 + during-2
    pty.emit('after\r\n');
    unsubscribe();

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    for (const chunk of chunks) {
      assert.equal(await viewer.apply(chunk), true, 'an overlapping chunk is trimmed, never a gap');
    }
    assert.equal(viewer.reseeds, 0, 'overlap must not look like a gap');

    await (await import('./local-agent.js')).captureLocalAgentOutput();
    assertIdenticalBuffers(__getLocalAgentTerminal()!, viewer.term, 'overlap');

    const rows: string[] = [];
    const active = viewer.term.buffer.active;
    for (let y = 0; y < viewer.term.rows; y++) {
      const line = active.getLine(active.viewportY + y);
      if (line) rows.push(line.translateToString(true));
    }
    assert.equal(rows.filter((r) => r === 'during-1').length, 1, 'exactly once, not twice');
    assert.equal(rows.filter((r) => r === 'during-2').length, 1, 'exactly once, not twice');
    assert.equal(rows.filter((r) => r === 'after').length, 1);
  });

  it('a lost relay is a detectable gap, not a silent splice', async () => {
    const pty = fakePty();
    startLocalAgent({ spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    pty.emit('start\r\n');
    const seed = takeRawSeed()!;
    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((d: string, m: RawChunkMeta) => {
      chunks.push({ epoch: m.epoch, startOffset: m.startOffset, data: d });
    });
    pty.emit('lost-in-transit\r\n');
    pty.emit('arrives\r\n');
    unsubscribe();

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    // Drop the first chunk on the floor, as a lost SSE frame would.
    assert.equal(await viewer.apply(chunks[1]), false, 'a hole must be refused');
    assert.equal(viewer.reseeds, 1);
  });

  it('a respawned agent is a new epoch, which forces a re-seed rather than a splice', async () => {
    const pty1 = fakePty();
    startLocalAgent({ spawnImpl: pty1.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    pty1.emit('session one\r\n');
    const seed = takeRawSeed()!;

    const chunks: Array<{ epoch: string; startOffset: number; data: string }> = [];
    const unsubscribe = onLocalAgentData((d: string, m: RawChunkMeta) => {
      chunks.push({ epoch: m.epoch, startOffset: m.startOffset, data: d });
    });
    const pty2 = fakePty();
    startLocalAgent({ spawnImpl: pty2.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    pty2.emit('session two\r\n');
    unsubscribe();

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    assert.notEqual(chunks[0].epoch, seed.epoch, 'a respawn starts a new byte stream');
    assert.equal(await viewer.apply(chunks[0]), false);
    assert.equal(viewer.reseeds, 1);
  });
});

describe('raw ring bounds', () => {
  it('never retains more than RAW_RING_MAX_BYTES, and reports the truncation', async () => {
    const pty = fakePty();
    startLocalAgent({ spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    const block = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 24; i++) pty.emit(block); // 384 KiB through a 256 KiB ring

    const seed = takeRawSeed()!;
    assert.ok(bytes(seed.data) <= RAW_RING_MAX_BYTES, 'ring stays within its cap');
    assert.equal(seed.truncated, true, 'a rolled ring says so');
    assert.ok(seed.baseOffset > 0);
    assert.equal(seed.baseOffset + bytes(seed.data), seed.endOffset, 'offsets describe the retained window');
  });

  it('an overflowed ring reads as a gap to a viewer positioned before it', async () => {
    const pty = fakePty();
    startLocalAgent({ spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    pty.emit('early\r\n');
    const early = takeRawSeed()!;

    const viewer = new Viewer(early.cols, early.rows);
    await viewer.seed(early);

    // The producer runs away and rolls the ring completely past the viewer.
    for (let i = 0; i < 24; i++) pty.emit('y'.repeat(16 * 1024));
    const prime = primeRawStream();
    assert.equal(
      await viewer.apply({ epoch: prime.epoch, startOffset: prime.startOffset, data: prime.data }),
      false,
      'a stream that starts past the viewer must trigger a re-seed, not splice',
    );
    assert.equal(viewer.reseeds, 1);
  });

  it('primeRawStream hands a new episode a recent tail with the right offset', async () => {
    const pty = fakePty();
    startLocalAgent({ spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8 });
    pty.emit('abcdefghij');
    const prime = primeRawStream(4);
    assert.equal(prime.data, 'ghij');
    assert.equal(prime.startOffset, 6);

    // Primed into a real stream buffer, the first batch carries that offset.
    const buffer = new OutputStreamBuffer();
    buffer.setBaseOffset(prime.startOffset);
    buffer.push(prime.data);
    assert.deepEqual(buffer.drain(), { data: 'ghij', droppedBytes: 0, startOffset: 6 });
  });
});

describe('daemon geometry', () => {
  it('reports the PTY grid the screen was composed at', () => {
    const pty = fakePty();
    const handle = startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 132,
      rows: 43,
    });
    assert.deepEqual(getLocalAgentGeometry(), { cols: 132, rows: 43 });
    assert.equal(handle.cols, 132);
    assert.equal(handle.rows, 43);
    assert.equal(takeRawSeed()!.cols, 132);
  });
});
