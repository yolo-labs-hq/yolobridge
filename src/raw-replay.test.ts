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
  screenDigest,
  __getLocalAgentTerminal,
  RAW_RING_MAX_BYTES,
  type PtySpawnImpl,
  type RawChunkMeta,
  type DigestTerminal,
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

  async seed(seed: { epoch: string; endOffset: number; data: string; prologue?: string }): Promise<void> {
    this.term.reset();
    this.epoch = seed.epoch;
    this.nextOffset = seed.endOffset;
    // Modes first, bytes second — exactly what `YoloBridgeStreamSink.seededRaw`
    // emits, and in the same order, because the prologue describes the canvas
    // the bytes were drawn on.
    if (seed.prologue) await write(this.term, seed.prologue);
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

// ─── Gap 1: a replay must never begin mid-escape-sequence ───────────────────

/**
 * The ring's oldest retained byte is wherever the trim happened to land, and
 * "wherever" is not a boundary any parser respects. Land it inside
 * `ESC[38;5;196m` and a viewer's xterm reads `5;196m` as TEXT — prints it, and
 * carries on WITHOUT the colour the daemon has been drawing in ever since.
 * That is not a transient glitch: nothing in the stream will ever set that
 * attribute again, so the viewer is wrong until something else re-seeds it.
 */
describe('ground-state resolution: a seed never starts inside an escape sequence', () => {
  const PREFIX_BYTES = 100;
  const CSI = `${ESC}[38;5;196m`;      // 11 bytes, at offsets 100..110
  const LINE = `${'z'.repeat(38)}\r\n`; // 40 bytes
  const LINES = 6553;
  /** Chosen so the ring's trim lands exactly 5 bytes INTO the CSI above. */
  const PAD_BYTES = 18;

  /** Every byte the PTY produced, as one ASCII string — so a JS index is also
   *  a UTF-8 byte offset and the test can name exact positions. */
  function fullStream(): string {
    return 'a'.repeat(PREFIX_BYTES) + CSI + LINE.repeat(LINES) + 'y'.repeat(PAD_BYTES);
  }

  /**
   * Emits the whole stream and then SETTLES the daemon's terminal, which is
   * what `attach-cmd.ts` does before every seed (`await captureOutput()`).
   * The ring is written synchronously but the terminal is fed through an async
   * write chain, so a seed taken before it drains would report the modes and
   * the screen of a moment the ring has already left behind.
   */
  async function startFlooded(): Promise<void> {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 40,
      rows: 8,
    });
    pty.emit('a'.repeat(PREFIX_BYTES));
    pty.emit(CSI);
    pty.emit(LINE.repeat(LINES));
    pty.emit('y'.repeat(PAD_BYTES));
    await (await import('./local-agent.js')).captureLocalAgentOutput();
  }

  it('moves the seed start to a GROUND offset when the ring rolled mid-CSI', async () => {
    await startFlooded();
    const full = fullStream();
    const naiveStart = full.length - RAW_RING_MAX_BYTES;

    // The setup is only interesting if the naive start really is inside the
    // sequence — pin that, or the test could pass by accident.
    assert.equal(naiveStart, PREFIX_BYTES + 5, 'the trim lands 5 bytes into the CSI');
    assert.equal(full.slice(naiveStart, naiveStart + 6), '5;196m', 'i.e. mid-parameters');

    const seed = takeRawSeed()!;
    assert.equal(seed.truncated, true);
    assert.equal(
      seed.baseOffset,
      PREFIX_BYTES + CSI.length,
      'the seed begins at the first ground offset, one past the sequence it could not resume',
    );
    assert.equal(
      seed.data.startsWith('z'),
      true,
      'the replay begins with real output, not with the tail of an escape',
    );
    assert.equal(seed.baseOffset + bytes(seed.data), seed.endOffset, 'offsets still describe the window');
  });

  it('…and the viewer is still cell-for-cell identical to the daemon', async () => {
    await startFlooded();
    const seed = takeRawSeed()!;
    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);

    await (await import('./local-agent.js')).captureLocalAgentOutput();
    assertIdenticalBuffers(__getLocalAgentTerminal()!, viewer.term, 'ground-aligned seed');
  });

  /**
   * NEGATIVE CONTROL. Without this the assertion above could be vacuous. A
   * viewer seeded at the RAW ring offset — the arbitrary byte, no ground
   * resolution — must end up WRONG, and specifically wrong in the sticky way:
   * it prints `5;196m` as text and then draws every subsequent character in
   * the DEFAULT colour, because the SGR that set 196 was consumed as garbage.
   */
  it('a seed taken at the arbitrary byte offset does NOT (why this exists)', async () => {
    await startFlooded();
    const full = fullStream();
    const seed = takeRawSeed()!;
    const naiveStart = full.length - RAW_RING_MAX_BYTES;

    const naive = new Viewer(seed.cols, seed.rows);
    // Deliberately no prologue either: this is the previous behaviour end to
    // end, replaying the ring's bytes from the ring's own base offset.
    await naive.seed({ epoch: seed.epoch, endOffset: seed.endOffset, data: full.slice(naiveStart) });

    await (await import('./local-agent.js')).captureLocalAgentOutput();
    const daemon = __getLocalAgentTerminal()!;
    assert.throws(
      () => assertIdenticalBuffers(daemon, naive.term, 'naive seed'),
      /naive seed/,
      'starting mid-escape leaves the viewer in the wrong SGR state',
    );

    // Name the defect precisely rather than settling for "they differ".
    const daemonCell = daemon.buffer.active.getLine(daemon.buffer.active.viewportY)!.getCell(0)!;
    const naiveCell = naive.term.buffer.active.getLine(naive.term.buffer.active.viewportY)!.getCell(0)!;
    assert.equal(daemonCell.getFgColor(), 196, 'the daemon is drawing in colour 196');
    assert.equal(naiveCell.isFgDefault(), true, 'the naive viewer lost the colour, permanently');
  });

  it('backs a stream prime UP to the previous ground offset, losing nothing', async () => {
    // The prime is the milder case and gets the better answer: the bytes
    // before the cut are still retained, so it moves BACKWARDS to ground
    // instead of skipping forward. The few extra bytes are deduplicated by the
    // viewer's offset arithmetic anyway.
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8,
    });
    // 20 bytes total; a 12-byte prime would naively cut at offset 8, which is
    // the middle of `ESC[1;32m` (offsets 6..14).
    pty.emit(`hello!${ESC}[1;32mworld`);
    const prime = primeRawStream(12);
    assert.equal(prime.startOffset, 6, 'backed up to just before the escape');
    assert.equal(prime.data, `${ESC}[1;32mworld`);
    assert.equal(prime.data.includes('1;32m') && !prime.data.startsWith('1'), true);
  });
});

// ─── Gap 2: a rolled ring loses sticky modes; the prologue restores them ────

/**
 * A raw replay is a WINDOW on a byte stream. When the window has rolled past
 * the escape that entered the alternate screen or set the scroll region, the
 * bytes it does hold are drawn on a canvas the viewer has no way to
 * reconstruct — every one of those modes changes where output LANDS.
 *
 * The prologue is derived from the daemon's own terminal (the authority for
 * alt-screen and wrap) and from the byte-stream tracker (for the scroll
 * region, cursor visibility and SGR, none of which `@xterm/headless` exposes).
 */
describe('mode prologue: a truncated replay lands on the right canvas', () => {
  const REGION_TOP = 3;
  const REGION_BOTTOM = 10;
  const SETUP =
    `${ESC}[?1049h` +                    // alternate screen
    `${ESC}[${REGION_TOP};${REGION_BOTTOM}r` + // scroll region (DECSTBM)
    `${ESC}[?25l` +                      // cursor hidden
    `${ESC}[38;5;33m` +                  // a sticky colour
    `${ESC}[${REGION_BOTTOM};1H`;        // park at the region's last row

  /** 40 bytes each, and each one distinguishable from every other. */
  const line = (i: number) => `L${String(i).padStart(5, '0')}${'z'.repeat(32)}\r\n`;
  const FLOOD_LINES = 6600; // 264,000 bytes — comfortably past the 256 KiB ring

  /** …and settle the terminal afterwards, for the reason spelled out above:
   *  the prologue is read from it, and it lags the ring until its async write
   *  chain drains. `attach-cmd.ts` awaits the same thing before every seed. */
  async function startFlooded(extraSetup = ''): Promise<void> {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl,
      stdout: { write: () => true },
      stdin: undefined,
      cols: 40,
      rows: 12,
    });
    pty.emit(SETUP + extraSetup);
    let batch = '';
    for (let i = 0; i < FLOOD_LINES; i++) {
      batch += line(i);
      if (batch.length > 32 * 1024) { pty.emit(batch); batch = ''; }
    }
    if (batch) pty.emit(batch);
    await (await import('./local-agent.js')).captureLocalAgentOutput();
  }

  it('puts the viewer on the alternate screen, inside the right scroll region', async () => {
    await startFlooded();
    const seed = takeRawSeed()!;
    assert.equal(seed.truncated, true, 'the ring must have rolled for this to be the case under test');
    assert.equal(typeof seed.prologue, 'string');
    assert.ok(seed.prologue!.includes(`${ESC}[?1049h`), 'alternate screen (read from the terminal)');
    assert.ok(seed.prologue!.includes(`${ESC}[${REGION_TOP};${REGION_BOTTOM}r`), 'scroll region (tracked)');
    assert.ok(seed.prologue!.includes(`${ESC}[?25l`), 'cursor hidden (tracked)');
    assert.ok(seed.prologue!.includes('38;5;33'), 'SGR (tracked)');

    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    await (await import('./local-agent.js')).captureLocalAgentOutput();
    const daemon = __getLocalAgentTerminal()!;

    assert.equal(viewer.term.buffer.active.type, 'alternate', 'on the alternate screen');
    assert.equal(daemon.buffer.active.type, 'alternate');
    // The scroll region is what decides which rows moved: rows outside it were
    // never written by either side and must still be blank in both.
    const blankRows = [0, 1, REGION_BOTTOM, REGION_BOTTOM + 1];
    for (const y of blankRows) {
      const l = viewer.term.buffer.active.getLine(y);
      assert.equal(l ? l.translateToString(true) : '', '', `viewer row ${y} is outside the region`);
    }
    // …and every row INSIDE it holds the same lines, in the same order, in the
    // same colour, with the cursor in the same place.
    assertIdenticalBuffers(daemon, viewer.term, 'truncated seed + prologue');
  });

  /**
   * NEGATIVE CONTROL for the prologue specifically: the SAME truncated seed,
   * replayed without it, must be wrong. It draws into the NORMAL buffer with
   * no scroll region, so the rows the daemon left untouched scroll away.
   */
  it('the same seed WITHOUT the prologue lands on the wrong canvas', async () => {
    await startFlooded();
    const seed = takeRawSeed()!;
    const naive = new Viewer(seed.cols, seed.rows);
    await naive.seed({ epoch: seed.epoch, endOffset: seed.endOffset, data: seed.data });

    await (await import('./local-agent.js')).captureLocalAgentOutput();
    assert.equal(naive.term.buffer.active.type, 'normal', 'never entered the alternate screen');
    assert.throws(
      () => assertIdenticalBuffers(__getLocalAgentTerminal()!, naive.term, 'no prologue'),
      /no prologue/,
    );
  });

  it('emits NO prologue when the replay is self-contained', async () => {
    // An untruncated replay sets its own modes on the way through. Re-asserting
    // them would be pure risk: DECOM and DECSTBM both move the cursor.
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 12,
    });
    pty.emit(SETUP + 'a few lines\r\n');
    await (await import('./local-agent.js')).captureLocalAgentOutput();
    const seed = takeRawSeed()!;
    assert.equal(seed.truncated, false);
    assert.equal(seed.prologue, undefined);
  });

  /**
   * ⚠️ WHAT THE PROLOGUE STILL CANNOT DO, asserted rather than glossed over.
   *
   * The prologue restores MODES, not CONTENT. A line painted outside the
   * scroll region before the ring rolled — a status bar, a header — is gone:
   * no byte in the retained window redraws it, and reconstructing it from the
   * daemon's screen dump is exactly the state-reconstruction this whole design
   * removed. So the viewer is right about the canvas and short one header.
   *
   * In practice a real TUI repaints its whole screen many times per 256 KiB
   * (that is what the ring is sized for), so the header comes back on the next
   * repaint. When it does not, the divergence check below is what notices —
   * which is the honest bound: not "this cannot happen", but "this cannot go
   * unnoticed for long".
   */
  it('does NOT restore content painted outside the region before the ring rolled', async () => {
    await startFlooded(`${ESC}[1;1H${ESC}[7m STATUS BAR ${ESC}[27m${ESC}[${REGION_BOTTOM};1H`);
    const seed = takeRawSeed()!;
    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    await (await import('./local-agent.js')).captureLocalAgentOutput();

    const daemon = __getLocalAgentTerminal()!;
    assert.match(
      daemon.buffer.active.getLine(0)!.translateToString(true),
      /STATUS BAR/,
      'the daemon still has it — it was painted once and never scrolled',
    );
    assert.equal(
      viewer.term.buffer.active.getLine(0)!.translateToString(true),
      '',
      'the viewer does not, and no prologue could have given it back',
    );
    // Stated as the limit it is: the modes ARE right, only the stale content
    // is missing.
    assert.equal(viewer.term.buffer.active.type, 'alternate');
    assert.notEqual(screenDigest(daemon as unknown as DigestTerminal),
                    screenDigest(viewer.term as unknown as DigestTerminal),
                    'and the integrity check can SEE the difference, which is the point');
  });
});

// ─── Gap 3: divergence must be detectable, from any cause ───────────────────

/**
 * Nothing above proves that no byte sequence will ever desync the two
 * parsers — that is not a provable claim. What IS provable is that a viewer
 * which HAS diverged, for any reason at all, can be told so and can converge
 * again. The daemon's screen digest is the evidence; a re-seed is the cure.
 *
 * (The POLICY around this evidence — how long to wait, how many mismatches to
 * require, how hard to rate-limit the cure — lives in the browser, in
 * `webapp/lib/grid/screen-integrity.ts`, and is tested there.)
 */
describe('divergence detection and recovery', () => {
  const digestOf = (t: TerminalType) => screenDigest(t as unknown as DigestTerminal);

  it('agrees on a healthy viewer, disagrees on a corrupted one, and converges after a re-seed', async () => {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 60, rows: 12,
    });
    pty.emit(TUI_PROLOGUE);
    for (let i = 0; i < 3; i++) pty.emit(repaint(`${SPINNER[i]} thinking…`));

    const seed = takeRawSeed()!;
    const viewer = new Viewer(seed.cols, seed.rows);
    await viewer.seed(seed);
    await (await import('./local-agent.js')).captureLocalAgentOutput();
    const daemon = __getLocalAgentTerminal()!;

    assert.equal(digestOf(viewer.term), digestOf(daemon), 'a faithful replica agrees');

    // Corrupt the viewer the way a desynced parser would: bytes the daemon
    // never sent, landing on the screen.
    await write(viewer.term, `${ESC}[6;3Hnot from the daemon`);
    assert.notEqual(digestOf(viewer.term), digestOf(daemon), 'and corruption is visible');

    // The cure: take a fresh seed and replay it, which is exactly what the
    // browser does on the monitor's `reseed` verdict.
    const fresh = takeRawSeed()!;
    await viewer.seed(fresh);
    await (await import('./local-agent.js')).captureLocalAgentOutput();

    assert.equal(digestOf(viewer.term), digestOf(daemon), 'and it converges');
    assertIdenticalBuffers(daemon, viewer.term, 'after recovery');
  });

  it('reports its own screen digest on every seed, so the check costs no extra round trip', () => {
    const pty = fakePty();
    startLocalAgent({
      spawnImpl: pty.spawnImpl, stdout: { write: () => true }, stdin: undefined, cols: 40, rows: 8,
    });
    pty.emit('hello');
    const seed = takeRawSeed()!;
    assert.equal(typeof seed.screenDigest, 'string');
    assert.equal(seed.screenDigest!.length, 8);
  });
});
