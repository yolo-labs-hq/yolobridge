import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';

// See local-agent.ts's header comment on this same pattern: `@xterm/headless`'s
// CJS bundle isn't statically analyzable for named exports under Node ESM.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

import {
  startLocalAgent,
  stopLocalAgent,
  deliverPromptToLocalAgent,
  captureLocalAgentOutput,
  getLocalAgentGeometry,
  takeRawSeed,
  computeUsedRows,
  serializeTerminalBuffer,
  onLocalAgentData,
  type PtySpawnImpl,
} from './local-agent.js';

/**
 * A fake node-pty `IPty` for tests that exercise the wiring
 * (deliver/capture/exit/stdin-piping) without depending on a real PTY —
 * only the "real bash" test below goes through an actual `node-pty.spawn`.
 */
function fakePty() {
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let killed = false;

  const ipty = {
    onData: (cb: (d: string) => void) => {
      dataCb = cb;
      return { dispose() {} };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCb = cb;
      return { dispose() {} };
    },
    write: (d: string) => {
      writes.push(d);
    },
    kill: () => {
      killed = true;
    },
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows });
    },
  };

  return {
    spawnImpl: (() => ipty as unknown as IPty) as PtySpawnImpl,
    writes,
    resizes,
    emitData: (d: string) => dataCb?.(d),
    emitExit: (info: { exitCode: number; signal?: number }) => exitCb?.(info),
    get killed() {
      return killed;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// Every test cleans up the module-level singleton, since startLocalAgent
// stops a prior session automatically but a test that throws mid-way
// could otherwise leak a real spawned process into the next test.
afterEach(() => {
  stopLocalAgent();
});

async function screen(write: string, cols = 40, rows = 6): Promise<string> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(write, () => resolve()));
  return serializeTerminalBuffer(term);
}

const ESC = '\x1b';

/** Feed a real `@xterm/headless` terminal and report `computeUsedRows`. Real
 *  parser, real buffer — the whole point is that this is the same engine the
 *  daemon runs, so an escape sequence behaves here exactly as it does live. */
async function usedRowsAfter(write: string, cols = 40, rows = 24): Promise<number> {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(write, () => resolve()));
  return computeUsedRows(term);
}

describe('computeUsedRows', () => {
  it('reports the last row with output on it, not the grid height', () => {
    // The whole point: a 24-row PTY showing three lines is USING three rows,
    // and the viewer scales to that instead of to 21 rows of nothing.
    return usedRowsAfter('one\r\ntwo\r\nthree').then((used) => assert.equal(used, 3));
  });

  it('counts the rows a line WRAPPED onto, because the screen really is using them', async () => {
    // 100 characters at 40 columns is three rows of screen, however few
    // "lines" the writer thought it was emitting.
    assert.equal(await usedRowsAfter('x'.repeat(100), 40, 24), 3);
  });

  it('ignores trailing blank rows even when the cursor walked past them', async () => {
    // Cursor-home after output: rows 4-24 are still empty, so the answer is
    // the content, and the cursor (now at row 1) does not drag it down.
    assert.equal(await usedRowsAfter(`one\r\ntwo\r\nthree${ESC}[H`), 3);
  });

  it('counts a row the CURSOR is sitting on, even with nothing written there yet', async () => {
    // A fresh prompt line is the session's live edge. Cropping above it would
    // hide the row the next keystroke lands on.
    assert.equal(await usedRowsAfter(`hello${ESC}[10;1H`), 10);
  });

  it('counts a row painted with BACKGROUND COLOUR but no glyphs', async () => {
    // A status bar / progress bar is a run of spaces with paint on them. It is
    // visible output, and cropping it off the bottom would lose it.
    const used = await usedRowsAfter(`top${ESC}[5;1H${ESC}[44m${' '.repeat(40)}${ESC}[0m${ESC}[H`);
    assert.equal(used, 5);
  });

  it('never reports 0, even for a screen that has had nothing written to it', async () => {
    // A zero would divide straight through the viewer's scale computation.
    assert.equal(await usedRowsAfter(''), 1);
  });

  it('never reports more than the grid', async () => {
    assert.equal(await usedRowsAfter('line\r\n'.repeat(100), 40, 24), 24);
  });

  it('⚠️ ALTERNATE SCREEN: reports the WHOLE grid, however blank it looks', async () => {
    // THE RULE THAT KEEPS FULL-SCREEN TUIs INTACT. An app on the alternate
    // screen owns every row it was given — a padded pane, an empty list body,
    // the gap above a footer all look blank to the predicate above and are all
    // live UI. Cropping there clips the app, so the alternate screen opts out.
    const rows = 24;
    // Enter the alternate screen and paint two lines at the top.
    const used = await usedRowsAfter(`${ESC}[?1049hheader\r\nbody`, 40, rows);
    assert.equal(used, rows);
  });

  it('goes back to counting content when the app LEAVES the alternate screen', async () => {
    // The rule is about which buffer is active, not a latch: a TUI that exits
    // must not leave every future scale pinned to the whole grid.
    const used = await usedRowsAfter(
      `${ESC}[?1049hfullscreen app${ESC}[?1049l` + 'back\r\nhome',
      40,
      24,
    );
    assert.equal(used, 2);
  });
});

/** How many `ESC [ … m` sequences a serialized screen contains. */
function escapeCount(text: string): number {
  return (text.match(/\x1b\[[0-9;]*m/g) || []).length;
}

describe('serializeTerminalBuffer', () => {
  it('emits NO escapes at all for a plain, unstyled screen (the common case stays byte-identical)', async () => {
    const text = await screen('hello\r\nworld');
    assert.equal(text, 'hello\nworld');
    assert.equal(escapeCount(text), 0);
  });

  it('trims trailing blank lines from an otherwise-empty buffer', async () => {
    const text = await screen('only line', 20, 10);
    assert.equal(text, 'only line');
  });

  it('drops cursor-movement and other non-SGR control sequences', async () => {
    // A cursor-forward before "world": the SPACES it skips over survive
    // (that is what the screen looks like), the escape itself does not.
    const text = await screen('hello\r\n\x1b[2Cworld');
    assert.equal(text, 'hello\n  world');
    assert.equal(escapeCount(text), 0);
  });

  it('round-trips a foreground colour, emitting ONE escape for the run, not one per cell', async () => {
    const text = await screen('\x1b[31mhello\x1b[0m');
    // Opening escape + the closing end-of-line reset. Five red cells, two
    // escapes — not ten.
    assert.equal(text, `${ESC}[31mhello${ESC}[0m`);
    assert.equal(escapeCount(text), 2);
  });

  it('round-trips bold and underline', async () => {
    const bold = await screen('\x1b[1;31mhi\x1b[0m');
    assert.equal(bold, `${ESC}[1;31mhi${ESC}[0m`);

    const underline = await screen('\x1b[4mhi\x1b[0m');
    assert.equal(underline, `${ESC}[4mhi${ESC}[0m`);
  });

  it('round-trips a 256-colour palette index', async () => {
    const fg = await screen('\x1b[38;5;208mX\x1b[0m');
    assert.equal(fg, `${ESC}[38;5;208mX${ESC}[0m`);

    const bg = await screen('\x1b[48;5;17mX\x1b[0m');
    assert.equal(bg, `${ESC}[48;5;17mX${ESC}[0m`);
  });

  it('round-trips a truecolor (RGB) foreground and background', async () => {
    const fg = await screen('\x1b[38;2;10;20;30mX\x1b[0m');
    assert.equal(fg, `${ESC}[38;2;10;20;30mX${ESC}[0m`);

    const bg = await screen('\x1b[48;2;200;100;50mX\x1b[0m');
    assert.equal(bg, `${ESC}[48;2;200;100;50mX${ESC}[0m`);
  });

  it('emits escapes only where the attribute state CHANGES', async () => {
    const text = await screen('\x1b[31maaa\x1b[32mbbb\x1b[0mccc');
    // red-open, green-switch, back-to-default — three, for nine cells.
    assert.equal(text, `${ESC}[31maaa${ESC}[32mbbb${ESC}[39mccc`);
    assert.equal(escapeCount(text), 3);
  });

  it('closes every styled line with a reset so state cannot bleed across lines', async () => {
    // No reset is written by the source at all: the terminal itself carries
    // red onto the second row, and each SERIALIZED line must still stand
    // alone rather than depending on the line before it.
    const text = await screen('\x1b[31mred\r\nstill red');
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${ESC}[31mred${ESC}[0m`);
    assert.equal(lines[1], `${ESC}[31mstill red${ESC}[0m`);
  });

  it('does not leak style onto a line that is genuinely unstyled', async () => {
    const text = await screen('\x1b[31mred\x1b[0m\r\nplain');
    const lines = text.split('\n');
    assert.equal(lines[1], 'plain');
  });

  it('emits a wide (CJK) glyph exactly once', async () => {
    const text = await screen('\x1b[32m你好\x1b[0m');
    assert.equal(text, `${ESC}[32m你好${ESC}[0m`);
  });

  it('keeps a background-painted run of spaces but still right-trims unstyled padding', async () => {
    const text = await screen('\x1b[44m   \x1b[0m');
    assert.equal(text, `${ESC}[44m   ${ESC}[0m`);
  });

  it('re-asserts the surviving half when bold or dim is turned off', async () => {
    // 22 clears BOTH bold and dim, so dropping bold while dim stays must
    // re-emit the dim.
    const text = await screen('\x1b[1;2maa\x1b[22;2mbb\x1b[0m');
    assert.equal(text, `${ESC}[1;2maa${ESC}[22;2mbb${ESC}[0m`);
  });
});

describe('startLocalAgent / deliverPromptToLocalAgent / captureLocalAgentOutput (fake PTY)', () => {
  it('writes the prompt text and the carriage return as two SEPARATE writes, matching a real Enter keypress', async () => {
    // Regression guard for a real bug found in manual smoke testing
    // (2026-08-20): a single combined `${prompt}\r` write silently fails
    // to submit against codex's input widget (text lands, Enter never
    // registers) even though it works fine against bash/claude. See
    // deliverPromptToLocalAgent's doc comment.
    const fake = fakePty();
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: fake.spawnImpl });

    await deliverPromptToLocalAgent('do the thing');

    assert.deepEqual(fake.writes, ['do the thing', '\r']);
  });

  it('wraps a MULTILINE prompt in bracketed-paste markers and waits the longer multiline delay before Enter (docs/YOLOBRIDGE_PLAN.md "[P1] Send multiline prompts as a bracketed paste")', async () => {
    // Regression guard for a real bug found via real interop testing
    // (2026-08-22, spawning actual claude/codex/bash under node-pty): at
    // the single-line PASTE_TO_ENTER_DELAY_MS, a multiline prompt was left
    // sitting UNSENT in claude's composer indefinitely — not a premature
    // split, a silent never-submits. See deliverPromptToLocalAgent's doc
    // comment for the full before/after evidence; this test only pins the
    // resulting write shape and that it takes meaningfully longer than the
    // single-line path above (which stays completely unchanged).
    const fake = fakePty();
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: fake.spawnImpl });

    const prompt = 'line one\nline two\nline three';
    const start = Date.now();
    await deliverPromptToLocalAgent(prompt);
    const elapsedMs = Date.now() - start;

    assert.deepEqual(fake.writes, [`\x1b[200~${prompt}\x1b[201~`, '\r']);
    assert.ok(elapsedMs >= 900, `expected the multiline delay (~1000ms) to elapse, got ${elapsedMs}ms`);
  });

  it('mirrors PTY output into both the headless terminal and the injected stdout sink', async () => {
    const fake = fakePty();
    const sunk: string[] = [];
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: (d) => sunk.push(d) },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
    });

    fake.emitData('hello from the agent\r\n');

    const { output, busy } = await captureLocalAgentOutput();
    assert.match(output, /hello from the agent/);
    assert.equal(busy, true, 'output just arrived, should be within the busy window');
    assert.deepEqual(sunk, ['hello from the agent\r\n'], 'the real terminal should see the same bytes');
  });

  it('reports busy: false once the busy window has elapsed with no new output', async () => {
    const fake = fakePty();
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: () => true },
      stdin: undefined,
      busyWindowMs: 30,
      spawnImpl: fake.spawnImpl,
    });

    fake.emitData('some output');
    let captured = await captureLocalAgentOutput();
    assert.equal(captured.busy, true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    captured = await captureLocalAgentOutput();
    assert.equal(captured.busy, false);
  });

  it('pipes injected stdin data into the PTY (the "live view" direction)', async () => {
    const fake = fakePty();
    const listeners: Array<(d: Buffer | string) => void> = [];
    const fakeStdin = {
      on: (_event: 'data', cb: (d: Buffer | string) => void) => {
        listeners.push(cb);
      },
    };
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: fakeStdin, spawnImpl: fake.spawnImpl });

    listeners[0]?.('the user typed this\n');

    assert.deepEqual(fake.writes, ['the user typed this\n']);
  });

  it('pauses stdin on stop -- regression guard for a real hang (found 2026-08-23): a resumed stdin that is never paused keeps the process alive forever, no matter what exitCode is set', async () => {
    // `attach` reported "detaching..." and then never actually exited --
    // reproduced against a real pty (not a redirected /dev/null stdin,
    // which reaches EOF on its own and masks this): the process hung until
    // force-killed on every exit path (attach failure, the agent dying on
    // its own, Ctrl+C), because teardownStdio removed the 'data' listener
    // and restored raw mode but never called stdin.pause() -- a resumed
    // stdin is a standing libuv handle that removing listeners alone does
    // not release.
    const fake = fakePty();
    let paused = false;
    let resumed = false;
    const fakeStdin = {
      on: () => {},
      removeListener: () => {},
      resume: () => { resumed = true; },
      pause: () => { paused = true; },
    };
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: fakeStdin, spawnImpl: fake.spawnImpl });
    assert.equal(resumed, true, 'sanity check: stdin was actually resumed on start');
    assert.equal(paused, false);

    stopLocalAgent();

    assert.equal(paused, true, 'stdin must be paused on stop, or the process never exits on its own');
  });

  it('also pauses stdin when the PTY process exits on its own (not just on an explicit stopLocalAgent call)', async () => {
    const fake = fakePty();
    let paused = false;
    const fakeStdin = {
      on: () => {},
      removeListener: () => {},
      resume: () => {},
      pause: () => { paused = true; },
    };
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: fakeStdin, spawnImpl: fake.spawnImpl });

    fake.emitExit({ exitCode: 0, signal: undefined });

    assert.equal(paused, true);
  });

  it('clears the singleton and invokes onExit when the PTY process exits on its own', async () => {
    const fake = fakePty();
    let exitInfo: { exitCode: number; signal?: number } | undefined;
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: () => true },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
      onExit: (info) => {
        exitInfo = info;
      },
    });

    fake.emitData('goodbye');
    fake.emitExit({ exitCode: 1, signal: undefined });

    assert.deepEqual(exitInfo, { exitCode: 1, signal: undefined });
    // No session left running: captureLocalAgentOutput reflects the
    // "nothing attached" state rather than the old session's buffer.
    const { output, busy } = await captureLocalAgentOutput();
    assert.equal(output, '');
    assert.equal(busy, false);
  });

  it('stopLocalAgent kills the PTY process and is a safe no-op when called twice', async () => {
    const fake = fakePty();
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: fake.spawnImpl });

    stopLocalAgent();
    assert.equal(fake.killed, true);
    assert.doesNotThrow(() => stopLocalAgent());
  });

  it('starting a new session while one is running stops the previous one first (Decision Q3: one per attach)', async () => {
    const first = fakePty();
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: first.spawnImpl });

    const second = fakePty();
    startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: second.spawnImpl });

    assert.equal(first.killed, true);
    assert.equal(second.killed, false);
  });
});

describe('deliverPromptToLocalAgent readiness gate (docs/YOLOBRIDGE_PLAN.md "[P1] Blind prompt delivery")', () => {
  it('delivers immediately once quiet, with no content yet (a fresh session — cursor position is not a meaningful signal on an empty screen)', async () => {
    const fake = fakePty();
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: () => true },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
      readinessQuietMs: 30,
      readinessPollMs: 10,
    });

    await deliverPromptToLocalAgent('hello');

    assert.deepEqual(fake.writes, ['hello', '\r']);
  });

  it('waits while the terminal is still producing output, then delivers once it settles', async () => {
    const fake = fakePty();
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: () => true },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
      readinessQuietMs: 80,
      readinessPollMs: 10,
    });

    fake.emitData('agent is thinking...');
    const pending = deliverPromptToLocalAgent('do the thing');

    // Synchronously right after the call — before any await inside
    // deliverPromptToLocalAgent has had a chance to resolve — nothing
    // should have been written yet: the terminal just produced output, so
    // it's well inside the readinessQuietMs window.
    assert.deepEqual(fake.writes, []);

    await pending;
    assert.deepEqual(fake.writes, ['do the thing', '\r']);
  });

  it('proceeds anyway after readinessTimeoutMs if the terminal never settles (bounded wait, not an indefinite hang or a silent refusal)', async () => {
    const fake = fakePty();
    startLocalAgent({
      agentBin: 'fake',
      cols: 40,
      rows: 10,
      stdout: { write: () => true },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
      // A quiet window longer than the timeout means isReadyToReceiveInput
      // can never return true within the bound — every poll still sees
      // "too recent" relative to a window that outlives the whole wait.
      readinessQuietMs: 10_000,
      readinessTimeoutMs: 100,
      readinessPollMs: 10,
    });

    fake.emitData('still busy');
    const start = Date.now();
    await deliverPromptToLocalAgent('urgent');
    const elapsedMs = Date.now() - start;

    assert.deepEqual(fake.writes, ['urgent', '\r']);
    assert.ok(elapsedMs >= 100, `expected the bounded wait to elapse (~100ms), got ${elapsedMs}ms`);
    assert.ok(elapsedMs < 2000, `expected the wait to be BOUNDED, not runaway — got ${elapsedMs}ms`);
  });

  it('waits for the cursor to reach the input line once the terminal has scrolled, not just for output to go quiet', async () => {
    const fake = fakePty();
    startLocalAgent({
      agentBin: 'fake',
      cols: 20,
      rows: 5,
      stdout: { write: () => true },
      stdin: undefined,
      spawnImpl: fake.spawnImpl,
      readinessQuietMs: 20,
      cursorBottomSlack: 1,
      readinessTimeoutMs: 300,
      readinessPollMs: 20,
    });

    // Push well past 5 rows so the buffer has genuinely scrolled (baseY > 0),
    // then park the cursor near the TOP of the viewport via an explicit
    // cursor-position escape — simulating a dialog/pager holding the cursor
    // away from the live input line while the screen itself is quiet.
    fake.emitData('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\r\nline7\r\nline8\r\n');
    fake.emitData('\x1b[1;1H'); // CSI cursor position: row 1, col 1 (top)

    await new Promise((resolve) => setTimeout(resolve, 25)); // clear readinessQuietMs
    const start = Date.now();
    await deliverPromptToLocalAgent('are you there');
    const elapsedMs = Date.now() - start;

    // Never became ready (cursor stuck at the top of a scrolled buffer) —
    // must have ridden out the full bounded timeout, not delivered early.
    assert.ok(elapsedMs >= 250, `expected the readiness wait to run out (~300ms), got ${elapsedMs}ms`);
    assert.deepEqual(fake.writes, ['are you there', '\r']);
  });
});

describe('startLocalAgent (real node-pty spawn)', () => {
  it('delivers a prompt into a real bash PTY and captures the shell-computed result back out', async () => {
    const sunk: string[] = [];
    startLocalAgent({
      agentBin: 'bash',
      agentArgs: ['--noprofile', '--norc'],
      cols: 80,
      rows: 24,
      stdout: { write: (d) => sunk.push(d) },
      stdin: undefined,
    });

    // Give the shell a moment to start reading before we write to it —
    // the PTY driver buffers input regardless, but this keeps the test
    // from racing the shell's own startup banner/prompt.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // `42` can only appear in the output via real shell execution — the
    // command text itself never contains the literal string "42", so
    // this proves round-trip delivery + execution, not just terminal echo.
    await deliverPromptToLocalAgent('echo $((21 * 2))');

    await waitFor(() => sunk.join('').includes('42'), 5000);

    const { output } = await captureLocalAgentOutput();
    assert.match(output, /42/);
  });
});

describe('onLocalAgentData — the raw PTY tap the live stream reads from', () => {
  it('delivers the PTY bytes VERBATIM, escapes and all', async () => {
    // The whole reason streaming beats the poll: xterm needs the real byte
    // stream (cursor moves, erase-line, alt-screen), not a serialized screen.
    const fake = fakePty();
    const seen: string[] = [];
    const unsubscribe = onLocalAgentData((d) => seen.push(d));
    try {
      startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: fake.spawnImpl });
      fake.emitData('\x1b[2K\r\x1b[32m⠋ working\x1b[0m');
      await waitFor(() => seen.length > 0);
      assert.deepEqual(seen, ['\x1b[2K\r\x1b[32m⠋ working\x1b[0m']);
    } finally {
      unsubscribe();
    }
  });

  it('still receives output after the PTY is replaced (the tap outlives one session)', async () => {
    // `startLocalAgent` stops and replaces any prior session (Decision Q3). A
    // tap registered by the long-lived attach daemon must survive that, or the
    // tile would go permanently blank after any respawn with no error anywhere.
    const seen: string[] = [];
    const unsubscribe = onLocalAgentData((d) => seen.push(d));
    try {
      const first = fakePty();
      startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: first.spawnImpl });
      first.emitData('one');
      await waitFor(() => seen.length === 1);

      const second = fakePty();
      startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: () => true }, stdin: undefined, spawnImpl: second.spawnImpl });
      second.emitData('two');
      await waitFor(() => seen.length === 2);
      assert.deepEqual(seen, ['one', 'two']);
    } finally {
      unsubscribe();
    }
  });

  it('stops delivering once unsubscribed, and a throwing tap never breaks the local session', async () => {
    const fake = fakePty();
    const stdout: string[] = [];
    const good: string[] = [];
    const unsubscribeBad = onLocalAgentData(() => { throw new Error('tap exploded'); });
    const unsubscribeGood = onLocalAgentData((d) => good.push(d));
    try {
      startLocalAgent({ agentBin: 'fake', cols: 40, rows: 10, stdout: { write: (d: string) => { stdout.push(d); return true; } }, stdin: undefined, spawnImpl: fake.spawnImpl });
      fake.emitData('hello');
      await waitFor(() => good.length === 1);
      // The human's own view of the session is unaffected by a broken tap.
      assert.deepEqual(stdout, ['hello']);

      unsubscribeGood();
      fake.emitData('after');
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(good, ['hello'], 'an unsubscribed tap must receive nothing further');
      assert.deepEqual(stdout, ['hello', 'after'], 'the local session keeps running regardless');
    } finally {
      unsubscribeBad();
      unsubscribeGood();
    }
  });
});


describe('local terminal resize (SIGWINCH)', () => {
  /**
   * A fake `process.stdout`-as-resize-source: mutable size plus an emitter.
   */
  function fakeResizeSource(cols: number, rows: number) {
    const listeners: Array<() => void> = [];
    return {
      columns: cols,
      rows,
      on(_event: 'resize', listener: () => void) {
        listeners.push(listener);
      },
      removeListener(_event: 'resize', listener: () => void) {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
      /** Resize the "window" and fire SIGWINCH, the way Node does. */
      resizeTo(nextCols: number, nextRows: number) {
        this.columns = nextCols;
        this.rows = nextRows;
        for (const l of [...listeners]) l();
      },
      fire() {
        for (const l of [...listeners]) l();
      },
      get listenerCount() {
        return listeners.length;
      },
    };
  }

  function start(pty: ReturnType<typeof fakePty>, src: ReturnType<typeof fakeResizeSource>) {
    return startLocalAgent({
      agentBin: 'fake',
      cols: src.columns,
      rows: src.rows,
      stdout: { write: () => {} },
      stdin: undefined,
      resizeSource: src,
      spawnImpl: pty.spawnImpl,
    });
  }

  it('resizes the PTY, our emulator, and the reported geometry', () => {
    const pty = fakePty();
    const src = fakeResizeSource(80, 24);
    start(pty, src);

    assert.deepEqual(
      { cols: getLocalAgentGeometry()?.cols, rows: getLocalAgentGeometry()?.rows },
      { cols: 80, rows: 24 },
    );

    src.resizeTo(120, 40);

    // The child must be told, or it keeps rendering to the old grid — which is
    // precisely the garbling the operator saw.
    assert.deepEqual(pty.resizes, [{ cols: 120, rows: 40 }], 'the PTY child was not resized');
    assert.deepEqual(
      { cols: getLocalAgentGeometry()?.cols, rows: getLocalAgentGeometry()?.rows },
      { cols: 120, rows: 40 },
      'reported geometry still describes a grid that no longer exists',
    );
  });

  it('starts a FRESH EPOCH, because retained bytes cannot replay at a new size', () => {
    const pty = fakePty();
    const src = fakeResizeSource(80, 24);
    start(pty, src);

    pty.emitData('hello');
    const before = takeRawSeed()?.epoch;
    assert.ok(before, 'expected an epoch before the resize');

    src.resizeTo(100, 30);

    const after = takeRawSeed()?.epoch;
    assert.ok(after);
    assert.notEqual(after, before, 'epoch unchanged — a viewer would replay old-grid bytes at the new size');
  });

  it('ignores a SIGWINCH that is not a size change, rather than burning an epoch', () => {
    const pty = fakePty();
    const src = fakeResizeSource(80, 24);
    start(pty, src);
    const before = takeRawSeed()?.epoch;

    src.fire(); // SIGWINCH with identical dimensions

    assert.deepEqual(pty.resizes, [], 'resized the PTY for a no-op SIGWINCH');
    assert.equal(takeRawSeed()?.epoch, before, 'forced a pointless re-seed');
  });

  it('ignores a zero/undefined size, which would wedge the child', () => {
    const pty = fakePty();
    const src = fakeResizeSource(80, 24);
    start(pty, src);

    src.resizeTo(0, 0); // stdout stopped being a TTY

    assert.deepEqual(pty.resizes, [], 'resized the PTY to zero');
    assert.deepEqual(
      { cols: getLocalAgentGeometry()?.cols, rows: getLocalAgentGeometry()?.rows },
      { cols: 80, rows: 24 },
    );
  });

  it('unwires the listener on stop, so a stopped session cannot be resized', () => {
    const pty = fakePty();
    const src = fakeResizeSource(80, 24);
    start(pty, src);
    assert.equal(src.listenerCount, 1);

    stopLocalAgent();

    assert.equal(src.listenerCount, 0, 'listener leaked past stop');
  });
});

describe('the detach sequence is actually MOUNTED on stdin', () => {
  /**
   * The filter itself is unit-tested in `detach-sequence.test.ts`. These prove
   * it is wired into the real stdin path — a correct filter mounted nowhere
   * protects nothing, and the wiring is the half a unit test cannot see.
   */
  function fakeStdin() {
    const listeners: Array<(d: Buffer | string) => void> = [];
    return {
      isTTY: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      setEncoding: () => {},
      on: (_event: 'data', fn: (d: Buffer | string) => void) => { listeners.push(fn); },
      removeListener: () => {},
      type: (text: string) => { for (const l of [...listeners]) l(text); },
    };
  }

  it('Ctrl-P Ctrl-Q typed on stdin detaches, and neither byte reaches the PTY', () => {
    const fake = fakePty();
    const stdin = fakeStdin();
    let detached = 0;
    startLocalAgent({
      agentBin: 'fake', cols: 40, rows: 10,
      stdout: { write: () => true },
      stdin: stdin as any,
      onDetachRequested: () => { detached++; },
      spawnImpl: fake.spawnImpl,
    });

    stdin.type('\x10');
    stdin.type('\x11');

    assert.equal(detached, 1);
    assert.deepEqual(fake.writes, [], 'the sequence must not reach the agent');
  });

  it('⚠️ Ctrl+C typed on stdin still reaches the AGENT and does not detach', () => {
    // Interrupting a runaway agent is worth more than quitting the daemon, so
    // "fixing" the unreachable SIGINT by claiming Ctrl+C would be a regression.
    const fake = fakePty();
    const stdin = fakeStdin();
    let detached = 0;
    startLocalAgent({
      agentBin: 'fake', cols: 40, rows: 10,
      stdout: { write: () => true },
      stdin: stdin as any,
      onDetachRequested: () => { detached++; },
      spawnImpl: fake.spawnImpl,
    });

    stdin.type('\x03');

    assert.deepEqual(fake.writes, ['\x03']);
    assert.equal(detached, 0);
  });

  it('ordinary typing is forwarded unchanged', () => {
    const fake = fakePty();
    const stdin = fakeStdin();
    startLocalAgent({
      agentBin: 'fake', cols: 40, rows: 10,
      stdout: { write: () => true },
      stdin: stdin as any,
      spawnImpl: fake.spawnImpl,
    });

    stdin.type('ls -la\r');

    assert.deepEqual(fake.writes, ['ls -la\r']);
  });
});
