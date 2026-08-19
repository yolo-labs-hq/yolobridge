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
