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
  serializeTerminalBuffer,
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
  };

  return {
    spawnImpl: (() => ipty as unknown as IPty) as PtySpawnImpl,
    writes,
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

describe('serializeTerminalBuffer', () => {
  it('produces plain text with ANSI/SGR escapes stripped, not a replayable VT100 stream', async () => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await new Promise<void>((resolve) => {
      // Bold-red "hello" + a cursor move + plain "world" on the next line.
      term.write('[1;31mhello[0m\r\n[2Cworld', () => resolve());
    });
    const text = serializeTerminalBuffer(term);
    assert.ok(!text.includes('['), 'no raw escape sequences should survive');
    assert.match(text, /hello/);
    assert.match(text, /world/);
  });

  it('trims trailing blank lines from an otherwise-empty buffer', async () => {
    const term = new Terminal({ cols: 20, rows: 10, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write('only line', () => resolve()));
    const text = serializeTerminalBuffer(term);
    assert.equal(text, 'only line');
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
