/**
 * Real local prompt-delivery and output-capture for `yolo-bridge attach`.
 *
 * docs/YOLOBRIDGE_PLAN.md's "⚠ Not yet functional" section settled the
 * mechanism (2026-08-19): `node-pty` spawns a genuine PTY running the
 * user's local coding agent (zero external binary dependency — already a
 * proven pattern in this codebase, `containers/services/terminal-mux/server.js`
 * depends on it too, just as an outer viewer around tmux rather than the
 * core mechanism here). `@xterm/headless` mirrors the PTY's raw byte
 * stream into a real screen-buffer model (the same engine xterm.js uses
 * for rendering, without a DOM), giving `captureLocalAgentOutput` direct
 * structured buffer access instead of text-scraping.
 *
 * Ownership model (this is the load-bearing change from the original
 * "reach into an already-running session" framing): `startLocalAgent`
 * SPAWNS the agent — yolo-bridge owns the PTY. The real process's stdin
 * is piped into the PTY and the PTY's raw output is piped to the real
 * process's stdout, so the human running `yolo-bridge attach` sees and
 * can drive the exact same session that remote prompts land in — not a
 * separate shadow copy.
 *
 * Module-level singleton: Decision Q3 in the plan is "one tile per
 * attach" — there is only ever one local agent PTY per daemon process, so
 * a singleton (rather than threading a handle through every call site) is
 * a faithful match for that decision, and it's what keeps
 * `deliverPromptToLocalAgent(prompt)` / `captureLocalAgentOutput()`
 * exactly the same two free functions with the same signatures that
 * attach-cmd.ts (and its test suite) already depend on and inject spies
 * over — see attach-cmd.ts's `AttachDaemonDeps.deliverPrompt` /
 * `.captureOutput`, defaulted to these two exports. Callers that already
 * inject fakes for those two hooks (attach-cmd.test.ts) never touch this
 * module at all, so nothing there needed to change.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Terminal as TerminalType } from '@xterm/headless';
import { splitByUtf8Bytes } from './output-stream.js';

// `@xterm/headless`'s published CJS bundle is a heavily minified/webpacked
// single file — `cjs-module-lexer` (Node ESM's static CJS-named-export
// detector) can't find `Terminal` on it, so a plain
// `import { Terminal } from '@xterm/headless'` fails at runtime with
// "Named export 'Terminal' not found" even though it type-checks fine
// (the package's .d.ts declares named exports). `createRequire` sidesteps
// static detection entirely and reads the real `module.exports` at
// runtime, which does have `Terminal` on it.
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/** Default agent binary: overridable via `--agent` (cli.ts) or this env var. */
export const DEFAULT_AGENT_BIN = process.env.YOLOBRIDGE_AGENT_BIN || 'claude';

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;

/** How recently the PTY must have produced output to be considered "busy". */
const DEFAULT_BUSY_WINDOW_MS = 2_000;

/**
 * Readiness gate defaults — see `isReadyToReceiveInput`'s doc comment below
 * for the reasoning (docs/YOLOBRIDGE_PLAN.md's "[P1] Blind prompt delivery"
 * Codex finding). Distinct from `DEFAULT_BUSY_WINDOW_MS`: that one gates a
 * UX-facing `busy` signal read_tile_output reports to callers (2s, tuned
 * for "does this look like it's still thinking"); this one gates WRITE
 * safety and only needs to rule out active mid-render, so it can be much
 * shorter.
 */
const DEFAULT_READINESS_QUIET_MS = 200;
/** Rows from the bottom of the viewport the cursor must sit within to
 * count as "at the input line", once the terminal has scrolled at least
 * once (see isReadyToReceiveInput). */
const DEFAULT_CURSOR_BOTTOM_SLACK = 2;
/** Bounded wait for readiness before proceeding anyway — see
 * deliverPromptToLocalAgent's doc comment on why this doesn't refuse or
 * hang indefinitely instead. */
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_POLL_MS = 100;

/**
 * Delay between writing the prompt text and writing the Enter keystroke in
 * `deliverPromptToLocalAgent` — see that function's doc comment. 150ms was
 * enough to fix `codex` in manual testing with no observable added latency;
 * not exposed as an option since it's a workaround for target-CLI input
 * handling, not a tunable a caller should need to reason about.
 */
const PASTE_TO_ENTER_DELAY_MS = 150;

/**
 * Delay before Enter for a MULTILINE prompt specifically — see the
 * "multiline delivery" section of `deliverPromptToLocalAgent`'s doc comment.
 * Verified empirically (2026-08-22) against real `claude` (v2.1.240): 150ms
 * and 300ms both left a 3-line prompt sitting unsent in the composer
 * indefinitely (not a premature-split, a SILENT NEVER-SUBMITS); 800ms
 * reliably submitted it. 1000ms is that empirical floor plus headroom, not a
 * tuned-to-the-millisecond value — this only affects the already-rare
 * multiline path, so the extra ~200ms over the verified-working 800ms is
 * immaterial to UX. `codex` and `bash` submit correctly at the original
 * 150ms already; using the longer delay for them too is harmless (just
 * slower), so this applies unconditionally to every multiline delivery
 * rather than trying to detect which target needs it.
 */
const MULTILINE_PASTE_TO_ENTER_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LocalAgentExitInfo {
  exitCode: number;
  signal?: number;
}

/** Minimal surface of node-pty's spawn() this module relies on — narrowed so tests can inject a fake. */
export type PtySpawnImpl = (
  file: string,
  args: string[],
  opts: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: { [key: string]: string };
  },
) => IPty;

/** A minimal writable-stream surface (matches `process.stdout`, and test doubles). */
export interface AgentOutputSink {
  write(data: string): unknown;
}

/** A minimal readable-stream surface (matches `process.stdin`, and test doubles). */
export interface AgentInputSource {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  removeListener?(event: 'data', listener: (data: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: string): unknown;
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface StartLocalAgentOptions {
  /** Binary to spawn, e.g. `claude`, `codex`. Defaults to `DEFAULT_AGENT_BIN`. */
  agentBin?: string;
  agentArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Terminal size. Defaults to the real terminal's size when interactive, else 120x40. */
  cols?: number;
  rows?: number;
  /** Real process stdio to wire the PTY into. Defaults to `process.stdout` / `process.stdin`. */
  stdout?: AgentOutputSink;
  stdin?: AgentInputSource;
  /** Called once when the spawned agent process exits, however it exits. */
  onExit?: (info: LocalAgentExitInfo) => void;
  /** How recently PTY output must have arrived for `captureLocalAgentOutput` to report `busy: true`. */
  busyWindowMs?: number;
  /** How long the terminal must be quiet before `deliverPromptToLocalAgent`
   * considers a write safe (see `isReadyToReceiveInput`). */
  readinessQuietMs?: number;
  /** Rows from the bottom of the viewport the cursor must sit within,
   * once the terminal has scrolled at least once. */
  cursorBottomSlack?: number;
  /** Bounded wait for readiness before `deliverPromptToLocalAgent` proceeds anyway. */
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  /** Test injection point — swap the real `node-pty` spawn for a fake IPty. */
  spawnImpl?: PtySpawnImpl;
}

export interface LocalAgentHandle {
  /** Kills the PTY process and tears down stdio wiring. Safe to call more than once. */
  stop(): void;
  /** The PTY's column count. Fixed at spawn — the daemon does not handle
   *  SIGWINCH and nothing resizes this PTY, least of all the cloud (the human
   *  at the keyboard is watching the same PTY through `process.stdout`). */
  cols: number;
  /** The PTY's row count. Same fixed-at-spawn contract as `cols`. */
  rows: number;
}

interface LocalAgentState {
  ptyProcess: IPty;
  term: TerminalType;
  cols: number;
  rows: number;
  lastOutputAt: number;
  busyWindowMs: number;
  readinessQuietMs: number;
  cursorBottomSlack: number;
  readinessTimeoutMs: number;
  readinessPollMs: number;
  writeChain: Promise<void>;
  stdin?: AgentInputSource;
  stdinListener?: (data: Buffer | string) => void;
  rawModeEnabled: boolean;
}

let current: LocalAgentState | undefined;

/**
 * Raw-PTY-output taps (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming").
 *
 * MODULE-LEVEL, not per-`LocalAgentState`, on purpose: a tap is owned by the
 * attach daemon's stream controller, which outlives any individual PTY —
 * `startLocalAgent` stops and replaces the previous session (Decision Q3), and
 * a tap registered before that swap must keep working after it rather than
 * silently going deaf. The listener set is therefore keyed to the PROCESS, the
 * same scope `deliverPromptToLocalAgent`/`captureLocalAgentOutput` already use.
 *
 * These see the same bytes the human at the keyboard sees — the unmodified PTY
 * stream, before any serialization. Nothing here writes them anywhere: a tap
 * is a callback, and the one caller (attach-cmd.ts's output-stream controller)
 * relays them in memory only. In particular they must NEVER be routed to
 * `log`/stdout — that stream belongs to the attached agent's TUI (see
 * `AttachDaemonDeps.log`), and echoing its own output back into it would both
 * corrupt the frame and loop.
 */
/**
 * Where a chunk of raw PTY output sits in the session's byte stream.
 *
 * `epoch` names ONE PTY session (a new one on every `startLocalAgent`, since
 * that spawns a fresh agent whose first bytes continue from nothing).
 * `startOffset` is the absolute UTF-8 byte offset of `data[0]` within that
 * epoch. Together they are what lets a remote viewer splice a seed and a live
 * tap together without a gap and without a double-render — see
 * `takeRawSeed` below.
 */
export interface RawChunkMeta {
  epoch: string;
  startOffset: number;
}

type RawDataListener = (data: string, meta: RawChunkMeta) => void;
const rawDataListeners = new Set<RawDataListener>();

/**
 * Register a raw-output tap. Returns an unsubscribe that is safe to call more
 * than once.
 */
export function onLocalAgentData(listener: RawDataListener): () => void {
  rawDataListeners.add(listener);
  return () => {
    rawDataListeners.delete(listener);
  };
}

/** Fan a PTY chunk out to every tap. A throwing tap must never break the
 *  human's own view of the session, which is the very next thing that would
 *  happen if this propagated out of the `onData` handler. */
function fanOutRawData(data: string, meta: RawChunkMeta): void {
  if (rawDataListeners.size === 0) return;
  for (const listener of rawDataListeners) {
    try {
      listener(data, meta);
    } catch {
      // A broken tap degrades the remote view, never the local session.
    }
  }
}

// ─── The raw replay ring (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming")
//
// ⚠️ WHY THIS EXISTS AT ALL, given `serializeTerminalBuffer` already produces a
// perfectly good screen dump.
//
// A line dump is the right primitive for a STATIC snapshot (`read_tile_output`
// still uses it). It is the WRONG primitive for resuming a LIVE stream, and
// the difference is not cosmetic. A dump carries the glyphs and their colours
// and nothing else: not the cursor position, not the scroll region (DECSTBM),
// not whether the alternate screen is active, not the saved cursor, not
// autowrap mode. A real TUI — Claude Code, codex, anything with a spinner or a
// redrawn prompt box — repaints using RELATIVE moves (`\x1b[A`, `\x1b[K`, a
// bare `\r`). Seed a viewer from a dump and every one of those moves is applied
// from the wrong origin, so redraws land on the wrong rows: text drawn on top
// of other text, prompt boxes marching down the screen. That is a state
// reconstruction bug, and the only fix that does not have a next instance is
// to stop reconstructing state.
//
// So: keep the last `RAW_RING_MAX_BYTES` of the RAW PTY byte stream and replay
// those bytes into the viewer's terminal. The viewer's xterm then parses
// exactly what the daemon's terminal parsed and arrives at exactly the same
// state — no cursor inference, no mode inference, no seam to get wrong.
//
// Every byte is stamped with an absolute offset, which is what makes the seed
// and the tap safe to be two independent, racing operations: overlap is
// deduplicated by offset and a hole is detected by offset. Neither is possible
// with `seq`, which only orders what was actually sent.

/**
 * Raw PTY bytes retained for seeding a viewer. 256 KiB.
 *
 * The number is chosen for what it has to CONTAIN, not for memory: a viewer
 * seeded mid-session needs the bytes back to (at least) the TUI's most recent
 * full repaint, and a repainting agent redraws its whole screen many times per
 * minute — a 120×40 full repaint with colour is on the order of 10-30 KiB, so
 * this holds many of them. It is also comfortably under the server's 5 MB JSON
 * body limit, since the whole ring can travel in one seed reply.
 */
export const RAW_RING_MAX_BYTES = 256 * 1024;

/**
 * How much of the ring is replayed into a NEW streaming episode's queue.
 *
 * The tap and the seed are separate round trips, so a viewer's seed can end at
 * an offset slightly before (or after) the point the tap starts at. Priming
 * the episode with a recent tail guarantees the stream covers the seam from
 * below; the viewer trims the duplicate prefix by offset. 64 KiB is ~1000×
 * more than one HTTP round trip's worth of agent output, and a miss is not
 * fatal anyway — it reads as a gap and costs one extra re-seed.
 */
export const RAW_STREAM_PRIME_BYTES = 64 * 1024;

interface RawRing {
  epoch: string;
  chunks: string[];
  bytes: number;
  /** Absolute offset of the first byte still retained. > 0 once the ring has
   *  rolled, which is exactly the "seed may be incomplete" condition. */
  baseOffset: number;
  /** Absolute offset one past the last byte the PTY has produced. */
  endOffset: number;
}

function newRawRing(): RawRing {
  return { epoch: randomUUID(), chunks: [], bytes: 0, baseOffset: 0, endOffset: 0 };
}

let rawRing: RawRing = newRawRing();

/** Append to the ring and return where the chunk landed. Synchronous and
 *  called from `onData`, so a tap and a seed taken in the same tick can never
 *  disagree about the offset. */
function pushRaw(data: string): RawChunkMeta {
  const startOffset = rawRing.endOffset;
  const bytes = Buffer.byteLength(data, 'utf-8');
  rawRing.chunks.push(data);
  rawRing.bytes += bytes;
  rawRing.endOffset += bytes;
  trimRawRing();
  return { epoch: rawRing.epoch, startOffset };
}

/** Drop from the FRONT until the ring is within its cap, advancing
 *  `baseOffset` by exactly what was dropped. Cuts only at code-point
 *  boundaries (`splitByUtf8Bytes`) so a replayed tail is never a lone
 *  surrogate. */
function trimRawRing(): void {
  while (rawRing.bytes > RAW_RING_MAX_BYTES && rawRing.chunks.length > 0) {
    const overflow = rawRing.bytes - RAW_RING_MAX_BYTES;
    const oldest = rawRing.chunks[0];
    const oldestBytes = Buffer.byteLength(oldest, 'utf-8');
    if (oldestBytes <= overflow) {
      rawRing.chunks.shift();
      rawRing.bytes -= oldestBytes;
      rawRing.baseOffset += oldestBytes;
      continue;
    }
    const { head, tail } = splitByUtf8Bytes(oldest, overflow);
    const droppedBytes = Buffer.byteLength(head, 'utf-8');
    if (droppedBytes === 0) {
      // A single code point wider than the overflow — drop the chunk rather
      // than spin.
      rawRing.chunks.shift();
      rawRing.bytes -= oldestBytes;
      rawRing.baseOffset += oldestBytes;
      continue;
    }
    rawRing.chunks[0] = tail;
    rawRing.bytes -= droppedBytes;
    rawRing.baseOffset += droppedBytes;
  }
}

/** A viewer's starting point: raw bytes to replay, and where they end. */
export interface RawSeed {
  epoch: string;
  /** Absolute offset of `data[0]`. Non-zero means the ring has rolled and the
   *  replay does NOT start at the beginning of the session. */
  baseOffset: number;
  /** Absolute offset one past the last byte in `data` — the offset a viewer
   *  that has applied this seed is now positioned at. */
  endOffset: number;
  data: string;
  cols: number;
  rows: number;
  /** `baseOffset > 0` — surfaced explicitly because it is the one case where
   *  replay is not a complete reconstruction. */
  truncated: boolean;
}

/**
 * Take the current replay tail plus the PTY's grid size, as ONE synchronous
 * observation.
 *
 * Atomic by construction: nothing can interleave between reading the ring and
 * reading the offsets, so `endOffset` is exactly the position a viewer reaches
 * by writing `data`. Bytes the PTY produces after this call carry offsets
 * ≥ `endOffset` and are therefore either spliced on cleanly or (if they were
 * already in `data`) trimmed away by the viewer — never lost, never applied
 * twice.
 */
export function takeRawSeed(): RawSeed | undefined {
  if (!current) return undefined;
  return {
    epoch: rawRing.epoch,
    baseOffset: rawRing.baseOffset,
    endOffset: rawRing.endOffset,
    data: rawRing.chunks.join(''),
    cols: current.cols,
    rows: current.rows,
    truncated: rawRing.baseOffset > 0,
  };
}

/** What a new streaming episode starts its queue from (see
 *  `RAW_STREAM_PRIME_BYTES`). */
export interface RawStreamPrime {
  epoch: string;
  startOffset: number;
  data: string;
}

export function primeRawStream(maxBytes: number = RAW_STREAM_PRIME_BYTES): RawStreamPrime {
  const all = rawRing.chunks.join('');
  const total = Buffer.byteLength(all, 'utf-8');
  if (total <= maxBytes) {
    return { epoch: rawRing.epoch, startOffset: rawRing.baseOffset, data: all };
  }
  const { head, tail } = splitByUtf8Bytes(all, total - maxBytes);
  return {
    epoch: rawRing.epoch,
    startOffset: rawRing.baseOffset + Buffer.byteLength(head, 'utf-8'),
    data: tail,
  };
}

/** The PTY's grid, which the tile must render at EXACTLY (it cannot be
 *  resized — the human at the keyboard is watching the same PTY). */
export function getLocalAgentGeometry(): { cols: number; rows: number } | undefined {
  if (!current) return undefined;
  return { cols: current.cols, rows: current.rows };
}

/** The same recent-activity heuristic `captureLocalAgentOutput` reports, without
 *  paying for a buffer serialization. */
export function isLocalAgentBusy(): boolean {
  if (!current) return false;
  return Date.now() - current.lastOutputAt < current.busyWindowMs;
}

/** Test seam: forget the ring and start a fresh epoch. */
export function __resetRawRing(): void {
  rawRing = newRawRing();
}

/**
 * Test seam: the daemon's OWN headless terminal — the thing a remote viewer
 * must end up cell-for-cell identical to. Exposed only so a test can assert
 * that equality directly (glyphs, attributes AND cursor position) instead of
 * eyeballing a serialized dump, which cannot see cursor drift at all.
 */
export function __getLocalAgentTerminal(): TerminalType | undefined {
  return current?.term;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Explicit `cols`/`rows` win. Otherwise, when wiring to the real
 * `process.stdout` (no injected sink — i.e. an actual interactive
 * `attach` run, not a test double), inherit the real terminal's size if
 * it reports one (a non-TTY stdout, e.g. piped/redirected, reports
 * `undefined`). Falls back to the fixed default otherwise.
 */
function resolveCols(opts: StartLocalAgentOptions): number {
  if (opts.cols) return opts.cols;
  if (opts.stdout !== undefined) return DEFAULT_COLS;
  return (process.stdout as unknown as { columns?: number }).columns || DEFAULT_COLS;
}

function resolveRows(opts: StartLocalAgentOptions): number {
  if (opts.rows) return opts.rows;
  if (opts.stdout !== undefined) return DEFAULT_ROWS;
  return (process.stdout as unknown as { rows?: number }).rows || DEFAULT_ROWS;
}

/**
 * A cell's SGR-relevant attribute state, in the shape we need to emit it.
 *
 * Colour MODE is captured as a tag ('default' | 'palette' | 'rgb') rather
 * than the raw `getFgColorMode()` number: the `@xterm/headless` typings
 * (`typings/xterm-headless.d.ts`, `IBufferCell`) document that number as
 * opaque — "can be used to perform quick comparisons of 2 cells" — and
 * explicitly point at `isFgRGB` / `isFgPalette` / `isFgDefault` as the way
 * to ask what mode a cell is in. So we ask via the documented predicates
 * instead of hard-coding constants that the package never promises.
 */
interface CellAttrs {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
  fgMode: 'default' | 'palette' | 'rgb';
  fgColor: number;
  bgMode: 'default' | 'palette' | 'rgb';
  bgColor: number;
}

const DEFAULT_ATTRS: CellAttrs = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strikethrough: false,
  fgMode: 'default',
  fgColor: 0,
  bgMode: 'default',
  bgColor: 0,
};

function attrsAreDefault(a: CellAttrs): boolean {
  return (
    !a.bold &&
    !a.dim &&
    !a.italic &&
    !a.underline &&
    !a.inverse &&
    !a.strikethrough &&
    a.fgMode === 'default' &&
    a.bgMode === 'default'
  );
}

/** `38;…` / `48;…` (or the compact 30-37/90-97/40-47/100-107 forms). */
function colorCodes(mode: CellAttrs['fgMode'], color: number, fg: boolean): string[] {
  if (mode === 'default') return [fg ? '39' : '49'];
  if (mode === 'rgb') {
    // Typings: RGB mode packs the colour as 0xRRGGBB.
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return [`${fg ? 38 : 48};2;${r};${g};${b}`];
  }
  // Palette: 0-255. 0-7 and 8-15 have compact single-code forms; the rest
  // need the indexed form.
  if (color < 8) return [String((fg ? 30 : 40) + color)];
  if (color < 16) return [String((fg ? 90 : 100) + (color - 8))];
  return [`${fg ? 38 : 48};5;${color}`];
}

/**
 * The SGR parameters that move `prev` to `next` — EMPTY when nothing
 * changed, which is what keeps the payload small (see
 * `serializeTerminalBuffer`).
 */
function sgrDiff(prev: CellAttrs, next: CellAttrs): string[] {
  const codes: string[] = [];

  // Bold and dim share one "off" code (22), so turning either off means
  // re-asserting whichever of the two survives.
  if ((prev.bold && !next.bold) || (prev.dim && !next.dim)) {
    codes.push('22');
    if (next.bold) codes.push('1');
    if (next.dim) codes.push('2');
  } else {
    if (!prev.bold && next.bold) codes.push('1');
    if (!prev.dim && next.dim) codes.push('2');
  }
  if (prev.italic !== next.italic) codes.push(next.italic ? '3' : '23');
  if (prev.underline !== next.underline) codes.push(next.underline ? '4' : '24');
  if (prev.inverse !== next.inverse) codes.push(next.inverse ? '7' : '27');
  if (prev.strikethrough !== next.strikethrough) codes.push(next.strikethrough ? '9' : '29');
  if (prev.fgMode !== next.fgMode || prev.fgColor !== next.fgColor) {
    codes.push(...colorCodes(next.fgMode, next.fgColor, true));
  }
  if (prev.bgMode !== next.bgMode || prev.bgColor !== next.bgColor) {
    codes.push(...colorCodes(next.bgMode, next.bgColor, false));
  }
  return codes;
}

/**
 * Serializes the terminal's current buffer (scrollback + viewport) to text
 * that keeps the agent's COLOUR and text styling, as SGR escapes only.
 *
 * Still deliberately not `@xterm/addon-serialize`: that addon reconstructs
 * a fully VT100-replayable stream — cursor moves, scroll regions, mode
 * switches — for re-feeding into another terminal, which is the wrong
 * shape for `read_tile_output`. Its consumers (the browser tile, and an
 * orchestrator/LLM reading the same capture) want the SCREEN as lines,
 * with the styling that makes an agent's output readable, and nothing
 * that repositions a cursor. So we walk `buffer.active` cell by cell and
 * re-emit just the SGR state.
 *
 * Payload discipline is the reason this walks cells rather than emitting
 * per cell: an escape is written ONLY where the attribute state actually
 * changes, so a screen of unstyled text emits ZERO escapes and is
 * byte-identical to what the old `translateToString(true)` produced. That
 * matters — this capture is polled on an interval and crosses the
 * network on every poll.
 *
 * Each line is self-contained: any line that ends with non-default
 * attributes is closed with a reset, so state cannot bleed into the next
 * line (the webapp splits this on `\n` and renders lines independently).
 *
 * NOT preserved, by design: cursor position, the alternate-screen flag,
 * scroll regions, hyperlinks (OSC 8), and blink/invisible/overline — none
 * of them survive into a static, line-split view.
 */
export function serializeTerminalBuffer(term: TerminalType): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) {
      lines.push('');
      continue;
    }

    // Collect first, so trailing blanks can be trimmed before any escape
    // is emitted for them (matching the old `translateToString(true)`).
    const cells: { text: string; attrs: CellAttrs }[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      // Width 0 = the right half of a wide (CJK/emoji) glyph; its content
      // already came out of the width-2 cell before it. Emitting it too
      // would duplicate the character.
      if (cell.getWidth() === 0) continue;
      // An untouched cell has no content at all; it renders as a space.
      const chars = cell.getChars();
      cells.push({
        text: chars === '' ? ' ' : chars,
        attrs: {
          bold: !!cell.isBold(),
          dim: !!cell.isDim(),
          italic: !!cell.isItalic(),
          underline: !!cell.isUnderline(),
          inverse: !!cell.isInverse(),
          strikethrough: !!cell.isStrikethrough(),
          fgMode: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
          // In default mode the colour NUMBER is meaningless (the typings
          // say "should be 0"; the runtime actually reports -1). Normalise
          // it so two default cells compare equal and emit no escape.
          fgColor: cell.isFgDefault() ? 0 : cell.getFgColor(),
          bgMode: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default',
          bgColor: cell.isBgDefault() ? 0 : cell.getBgColor(),
        },
      });
    }

    // Right-trim, as before — but only cells that are blank AND unstyled.
    // A run of spaces carrying a background colour is real, visible output
    // (a status bar, a selection); dropping it would lose the paint.
    while (cells.length > 0) {
      const last = cells[cells.length - 1];
      if (last.text === ' ' && attrsAreDefault(last.attrs)) cells.pop();
      else break;
    }

    let out = '';
    let state = DEFAULT_ATTRS;
    for (const cell of cells) {
      const codes = sgrDiff(state, cell.attrs);
      if (codes.length > 0) out += `\x1b[${codes.join(';')}m`;
      out += cell.text;
      state = cell.attrs;
    }
    if (!attrsAreDefault(state)) out += '\x1b[0m';
    lines.push(out);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Spawns the local coding agent under a real PTY and wires it up:
 *   - PTY output -> headless Terminal (structured buffer for capture)
 *   - PTY output -> the real process's stdout (live view for the human)
 *   - the real process's stdin -> PTY (human keystrokes reach the agent)
 *
 * Idempotent in the sense that calling this while a previous session is
 * still running stops it first — Decision Q3 (one tile per attach) means
 * there is only ever one local agent per daemon process.
 */
export function startLocalAgent(opts: StartLocalAgentOptions = {}): LocalAgentHandle {
  if (current) stopLocalAgent();

  const agentBin = opts.agentBin ?? DEFAULT_AGENT_BIN;
  const agentArgs = opts.agentArgs ?? [];
  const cols = resolveCols(opts);
  const rows = resolveRows(opts);
  const spawnImpl = opts.spawnImpl ?? (pty.spawn as unknown as PtySpawnImpl);
  const busyWindowMs = opts.busyWindowMs ?? DEFAULT_BUSY_WINDOW_MS;
  const readinessQuietMs = opts.readinessQuietMs ?? DEFAULT_READINESS_QUIET_MS;
  const cursorBottomSlack = opts.cursorBottomSlack ?? DEFAULT_CURSOR_BOTTOM_SLACK;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const readinessPollMs = opts.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;

  const outStream: AgentOutputSink = opts.stdout ?? process.stdout;
  // `'stdin' in opts` (not `opts.stdin ??`) so a test can pass `stdin: undefined`
  // explicitly to disable stdin piping entirely, distinct from omitting the
  // field (which defaults to wiring up the real `process.stdin`).
  const inStream: AgentInputSource | undefined = 'stdin' in opts ? opts.stdin : (process.stdin as unknown as AgentInputSource);

  const ptyProcess = spawnImpl(agentBin, agentArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: sanitizeEnv(opts.env ?? process.env),
  });

  const term = new Terminal({ cols, rows, allowProposedApi: true });

  // A NEW PTY is a new byte stream: everything retained belongs to a screen
  // that no longer exists, and offsets restart. The fresh `epoch` is what a
  // viewer keyed to the old one sees, and it re-seeds rather than splicing two
  // sessions' bytes together.
  rawRing = newRawRing();

  const state: LocalAgentState = {
    ptyProcess,
    term,
    cols,
    rows,
    lastOutputAt: Date.now(),
    busyWindowMs,
    readinessQuietMs,
    cursorBottomSlack,
    readinessTimeoutMs,
    readinessPollMs,
    writeChain: Promise.resolve(),
    stdin: inStream,
    rawModeEnabled: false,
  };
  current = state;

  ptyProcess.onData((data: string) => {
    state.lastOutputAt = Date.now();
    outStream.write(data);
    state.writeChain = state.writeChain.then(
      () => new Promise<void>((resolve) => term.write(data, () => resolve())),
    );
    // Ring FIRST, then the taps, with the offset the ring assigned — a tap and
    // a `takeRawSeed()` taken in the same tick must agree on where this chunk
    // sits, or the viewer's dedupe/gap logic is reasoning about two different
    // coordinate systems.
    fanOutRawData(data, pushRaw(data));
  });

  if (inStream && typeof inStream.on === 'function') {
    const stdinListener = (data: Buffer | string) => {
      ptyProcess.write(typeof data === 'string' ? data : data.toString('utf-8'));
    };
    if (inStream.isTTY && typeof inStream.setRawMode === 'function') {
      inStream.setRawMode(true);
      state.rawModeEnabled = true;
    }
    inStream.resume?.();
    inStream.setEncoding?.('utf-8');
    inStream.on('data', stdinListener);
    state.stdinListener = stdinListener;
  }

  ptyProcess.onExit(({ exitCode, signal }) => {
    teardownStdio(state);
    if (current === state) current = undefined;
    opts.onExit?.({ exitCode, signal });
  });

  return { stop: stopLocalAgent, cols, rows };
}

/**
 * Real bug (found 2026-08-23 chasing a report that `attach` never fully
 * exits on its own — "detaching..." prints, then the process just hangs
 * until force-killed): `startLocalAgent` calls `inStream.resume?.()` to put
 * `process.stdin` into flowing mode so keystrokes reach the PTY. A resumed
 * stdin is a standing libuv handle that keeps Node's event loop alive
 * regardless of `process.exitCode` — removing the `'data'` listener alone
 * does NOT release it; only an explicit `pause()` does. This was missing
 * here, so EVERY `attach` exit path (attach failure, the local agent dying
 * on its own, a server-initiated detach, even a clean Ctrl+C) left stdin
 * resumed and the process wedged. Reproduced against a real pty (`script
 * -qec ... `, not a plain redirected stdin — `/dev/null`-as-stdin reaches
 * EOF on its own and masked this): the process printed its final messages
 * within ~1s but had to be force-killed at a 10s timeout every time,
 * exit code 124. With `stdin.pause()` added below, the same repro exits
 * cleanly on its own well under a second — no timeout/kill needed.
 */
function teardownStdio(state: LocalAgentState): void {
  const { stdin, stdinListener } = state;
  if (stdin && stdinListener && typeof stdin.removeListener === 'function') {
    stdin.removeListener('data', stdinListener);
  }
  if (state.rawModeEnabled && stdin?.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(false);
  }
  if (stdin && typeof stdin.pause === 'function') {
    stdin.pause();
  }
}

/**
 * Stops the local agent session. Kills the PTY process (SIGTERM via
 * node-pty's default `kill()`) and unwires stdio.
 *
 * Decision on detach lifecycle: `yolo-bridge attach` is what SPAWNED this
 * process (see module header), so whatever ends the attach loop — local
 * Ctrl+C, or a server-initiated `detached` frame — also ends the PTY
 * session it owns. Nothing is left "running detached with no owner":
 * cli.ts calls this unconditionally after `runAttachFromDisk` resolves,
 * regardless of which of those two paths triggered the stop. If the
 * agent process already exited on its own, this is a safe no-op (`current`
 * is already cleared by the `onExit` handler above).
 */
export function stopLocalAgent(): void {
  if (!current) return;
  const state = current;
  current = undefined;
  teardownStdio(state);
  try {
    state.ptyProcess.kill();
  } catch {
    // already dead
  }
}

/**
 * Best-effort readiness check before `deliverPromptToLocalAgent` writes
 * into the PTY — docs/YOLOBRIDGE_PLAN.md's "[P1] Blind prompt delivery can
 * hit a permission dialog or partial input" Codex finding. Writing
 * text+Enter with no regard for what's on screen could accidentally
 * confirm a highlighted permission-dialog choice, or concatenate onto
 * something the user was mid-typing.
 *
 * Mirrors the SHAPE of the pod side's own confidence-scored injection gate
 * (`containers/services/terminal-mux/server.js`'s "marker + stability +
 * cursor"), adapted to what this module actually has: direct structured
 * `@xterm/headless` buffer access (no capture-pane text-scraping needed),
 * but no per-agent marker set — building an equivalent of that file's
 * `readiness-markers.js` for arbitrary local CLIs (claude, codex, and
 * whatever `--agent` names) is out of scope for this fix, an acknowledged
 * scope cut, not an oversight. No verify-after-inject retry either (the pod
 * side's second defense layer, comparing before/after screen state once the
 * text is written) — this check only gates BEFORE the write.
 *
 * Two signals:
 *   - STABLE: no PTY output for `readinessQuietMs`. Rules out writing into
 *     a screen that's still actively repainting — a streaming response, a
 *     busy spinner, a dialog mid-animation. This is the primary signal and
 *     directly addresses both halves of the finding: an active permission
 *     dialog is normally still rendering (its highlight/spinner), and
 *     "partial input" concern is really "is something being typed right
 *     now" — both are "was there recent activity" questions.
 *   - CURSOR AT THE INPUT LINE, but ONLY once the terminal has scrolled at
 *     least once (`buffer.baseY > 0`): the cursor sits within
 *     `cursorBottomSlack` rows of the viewport bottom. JUDGMENT CALL: this
 *     is gated on `baseY` rather than being an unconditional requirement —
 *     a short session whose content still fits in one screen (baseY === 0,
 *     e.g. a freshly-spawned agent's first prompt, or the real-bash test
 *     below) legitimately has its cursor wherever the last line landed,
 *     which is often nowhere near the physical bottom row; requiring the
 *     bonus signal there would stall every delivery to a short/compact
 *     session for no real safety benefit. Once the terminal HAS scrolled,
 *     though, a cursor that isn't near the bottom is a real signal we're
 *     looking at scrolled-away history or a fixed-position dialog/pager
 *     rather than the live input line — the pod side's own cursor check
 *     has this exact same "assumes bottom" property, it just doesn't need
 *     the `baseY` guard because tmux's `cursor_y`/`pane_height` are already
 *     relative to the live pane, not a headless buffer that can start at
 *     row 0 with nothing rendered yet.
 */
function isReadyToReceiveInput(state: LocalAgentState): boolean {
  const quietForMs = Date.now() - state.lastOutputAt;
  if (quietForMs < state.readinessQuietMs) return false;
  const buffer = state.term.buffer.active;
  if (buffer.baseY === 0) return true;
  const rows = state.term.rows;
  return rows - 1 - buffer.cursorY <= state.cursorBottomSlack;
}

/**
 * Polls `isReadyToReceiveInput` until it's true or `readinessTimeoutMs`
 * elapses. Never rejects — a timeout just means the caller proceeds
 * without the extra confidence (see `deliverPromptToLocalAgent`).
 */
async function waitForReadiness(state: LocalAgentState): Promise<boolean> {
  const deadline = Date.now() + state.readinessTimeoutMs;
  while (!isReadyToReceiveInput(state)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(state.readinessPollMs, remaining));
  }
  return true;
}

/**
 * Writes `prompt` into the owned PTY the same way the user's own
 * keystrokes would land, followed by a carriage return so the target CLI
 * actually submits it. `\r` (not `\n`) matches what a real terminal sends
 * on Enter.
 *
 * **Waits (bounded) for `isReadyToReceiveInput` before writing anything.**
 * JUDGMENT CALL on what happens if the terminal never settles within
 * `readinessTimeoutMs`: this proceeds and writes anyway, rather than
 * hanging indefinitely or silently refusing. A hard refusal would have no
 * safe fallback — `yolobridge-service.ts`'s `publishPrompt` has a
 * retry-on-RECONNECT loop (Decision Q5) for an OFFLINE daemon, but no
 * retry-on-BUSY loop for a target that's merely slow to settle, so a
 * refusal here would silently drop the prompt with no path to ever resend
 * it. A timeout is therefore "proceed with reduced confidence, own the
 * risk", not "give up" — the readiness check reduces the odds of a bad
 * write, it does not (and, without the pod side's verify-after-inject
 * layer, cannot) guarantee one never happens.
 *
 * **The text and the Enter are two SEPARATE writes, with a short delay
 * between them — not one combined `${prompt}\r` write.** Verified
 * empirically against real CLIs (2026-08-20, manual smoke test): a single
 * combined write works for `bash` and `claude`, but silently fails to
 * submit against `codex` — the text lands in its input box but Enter is
 * never registered, so nothing is ever sent. Splitting into two writes
 * with `PASTE_TO_ENTER_DELAY_MS` between them fixed `codex` with no
 * regression on `claude`/`bash`. This mirrors the pod side's own proven
 * two-step pattern (`containers/services/terminal-mux/server.js`:
 * `tmux paste-buffer` followed by a SEPARATE `tmux send-keys Enter`, not
 * one combined operation) — the same shape turned out to matter here too,
 * not just there.
 *
 * If no session has been started yet (misuse, or a test that didn't call
 * `startLocalAgent` first), lazily starts one with defaults rather than
 * throwing — keeps this function's contract matching the original stub's
 * "always succeeds, delivery is attempted" shape.
 *
 * **Multiline delivery (docs/YOLOBRIDGE_PLAN.md's "[P1] Send multiline
 * prompts as a bracketed paste" Codex finding, fixed 2026-08-22).** A
 * prompt containing embedded `\n` is wrapped in bracketed-paste markers
 * (`\x1b[200~`/`\x1b[201~`) and waits `MULTILINE_PASTE_TO_ENTER_DELAY_MS`
 * (not `PASTE_TO_ENTER_DELAY_MS`) before the Enter write. **The bracketed
 * markers turned out NOT to be the load-bearing part of this fix** — real
 * interop testing (spawning actual `claude`/`codex`/`bash` under `node-pty`,
 * the same rigor as the codex-write-timing fix above) showed `codex`
 * already correctly composes and submits a multiline prompt as ONE message
 * at the original 150ms delay, no markers needed; `bash` is unaffected by
 * markers either way (a multi-statement shell script legitimately runs each
 * line once submitted — that's normal shell semantics, not a delivery bug,
 * and `bash` is only this module's sanity-check fallback, not a primary
 * agent target). The REAL bug was `claude` (v2.1.240): at the original
 * 150ms delay, a multiline prompt was left sitting UNSENT in the composer
 * indefinitely — not a premature partial-submit, a silent no-op that
 * `send_to_tile` would have reported as `delivered: true` while the agent
 * never saw it. Confirmed via the headless-buffer screen capture this
 * module already uses for `read_tile_output`: 150ms/300ms (bracketed or
 * not) left the 3-line prompt in the composer with no response ever
 * starting; 800ms reliably submitted it and the model began responding.
 * Bracketed-paste markers are kept anyway as cheap defense-in-depth (every
 * target tested renders them correctly with no visible artifacts) for
 * whatever agent binary is named next via `--agent` that wasn't tested
 * here — but the delay is what actually closes the finding.
 */
export async function deliverPromptToLocalAgent(prompt: string): Promise<void> {
  if (!current) startLocalAgent();
  const state = current!;
  await waitForReadiness(state);
  const ptyProcess = state.ptyProcess;
  const isMultiline = prompt.includes('\n');
  ptyProcess.write(isMultiline ? `\x1b[200~${prompt}\x1b[201~` : prompt);
  await sleep(isMultiline ? MULTILINE_PASTE_TO_ENTER_DELAY_MS : PASTE_TO_ENTER_DELAY_MS);
  ptyProcess.write('\r');
}

/**
 * Serializes the current headless-terminal buffer to plain text and
 * reports a `busy` heuristic: has the PTY produced output within the
 * last `busyWindowMs` (default 2s)? Mirrors the spirit of the pod side's
 * own busy-detection (recent-activity-based) without depending on any
 * pod-only primitive.
 */
export async function captureLocalAgentOutput(): Promise<{
  output: string;
  busy: boolean;
  cols?: number;
  rows?: number;
}> {
  if (!current) return { output: '', busy: false };
  await current.writeChain;
  const output = serializeTerminalBuffer(current.term);
  const busy = Date.now() - current.lastOutputAt < current.busyWindowMs;
  // The grid the screen above was laid out FOR. A viewer that renders it at
  // any other width re-wraps every long line — the dump has no width of its
  // own, only the one the PTY composed it at.
  return { output, busy, cols: current.cols, rows: current.rows };
}
