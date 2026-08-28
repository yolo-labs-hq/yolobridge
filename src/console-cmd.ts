/**
 * `yolo-bridge console` — attach a real terminal to a bridged session running on
 * ANOTHER machine.
 *
 * ⚠️ THIS JOINS; IT DOES NOT ATTACH. `attach` CREATES an attachment, spawns the
 * agent and mints a workspace-scoped daemon credential ON THE MACHINE RUNNING
 * THE AGENT. `console` connects to an attachment that already exists, from a
 * different machine, and authenticates as the USER with an ordinary account
 * credential.
 *
 * The daemon's scoped token must never leave the machine it was minted on — it
 * is the credential the whole scoped-credential design exists to confine — so
 * this client neither has it nor needs it. The server enforces the same rule
 * from the other side: the input route REFUSES a scoped token.
 *
 * WHY A TERMINAL AND NOT THE TILE. Modifier handling, IME, clipboard, focus
 * stealing, browser shortcuts colliding with app shortcuts — a local terminal
 * emulator already solves every one of these correctly, and doing raw input in a
 * browser means re-solving all of them badly. It also puts the keyboard on a
 * machine the operator logged in from, rather than inside the cloud surface that
 * also hosts agents reading untrusted content.
 *
 * ⚠️ EXITING THE CONSOLE DOES NOT DETACH THE DAEMON. This is a viewer joining
 * and leaving; the agent keeps running and the attachment survives. Ctrl+C goes
 * to the AGENT, exactly as it does locally; `Ctrl-P Ctrl-Q` leaves the console.
 */

import { createDetachSequenceFilter } from './detach-sequence.js';
import {
  sendConsoleInput,
  resolveAttachmentTile,
  readRawOutputSeed,
  type RawOutputSeed,
  subscribeOutput,
  unsubscribeOutput,
  openWorkspaceEventStream,
  YoloBridgeApiError,
  type ApiClientConfig,
  type FetchImpl,
} from './api-client.js';
import { loadAuth, saveAuth, loadAttachment, type ConfigStoreIO, type StoredAuth } from './config-store.js';
import { refreshAccessToken, type RefreshTokenResult } from './device-auth.js';

const DEFAULT_AUTH_URL = 'https://auth.yololabs.ai';

/**
 * Refresh the account token once it has less than this much life left.
 *
 * The same 5min margin `attach` uses. Production access tokens live 24h, so a
 * console left open overnight — the exact session this command exists for —
 * WILL cross the boundary, and every request after it 401s. Worse, the lease
 * renewal swallows its errors, so the symptom is not an error but the output
 * quietly stopping when the lease lapses. (codex P1.)
 */
const REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * How long keystrokes are gathered before one POST goes out.
 *
 * NOT a latency tax — it is the opposite. A round trip to the API measured ~80ms
 * warm from a real operator machine (2026-08-28), so a POST per character would
 * put a fast typist's keystrokes in a queue behind each other. Coalescing a few
 * milliseconds of typing into ONE request keeps them in step.
 *
 * 8ms is well under human inter-keystroke time (~100ms even when typing fast),
 * so a deliberate keypress is never delayed noticeably, while a burst — a paste,
 * a held arrow key — collapses into a single request.
 */
export const INPUT_COALESCE_MS = 8;

/**
 * Largest payload one input request may carry.
 *
 * ⚠️ MIRRORS A SERVER CONSTANT. `routes/yolobridge.ts` rejects `data.length >
 * 8192` with a 413, and the console reports a failed send but cannot un-drop the
 * bytes — so a paste just over the line vanishes WHOLESALE rather than
 * truncating. Coalescing makes this reachable in ordinary use: a paste, or a
 * burst held back while a slow request is in flight, arrives as one buffer.
 * Kept strictly BELOW the server's number so the two can never be off by one.
 * (codex P1.)
 */
export const MAX_INPUT_CHUNK = 4096;

/**
 * How long teardown waits for already-typed input to reach the agent.
 *
 * Long enough that a healthy link delivers everything anyone could have typed;
 * short enough that a dead one still hands the shell straight back.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3000;

/** How long teardown waits on the best-effort unsubscribe before letting go.
 *  The output lease expires by itself; this only makes it prompt. */
const UNSUBSCRIBE_TIMEOUT_MS = 1500;

/** How many times a seed may immediately chain into another before giving up. */
const MAX_CHAINED_RESEEDS = 5;
const RESYNC_GAVE_UP = '\r\n[console] could not resync the screen \u2014 output below may be misaligned\r\n';

/**
 * Coalesce keystrokes and send them STRICTLY IN ORDER, one request at a time.
 *
 * ⚠️ ORDER IS THE WHOLE POINT. Firing each flush as an independent unawaited
 * POST lets a slower earlier request land after a faster later one, and in a
 * terminal that is not a dropped keystroke — it is `rm -rf` becoming `rm f-r`,
 * or the two halves of an escape sequence arriving inverted. Latency here is
 * recoverable; reordering is not. (codex P1.)
 *
 * Single-flight rather than a queue of requests, because holding the bytes
 * locally while one request is in flight makes the coalescing ADAPTIVE: the
 * worse the network, the more characters ride in each request, so a slow link
 * degrades into fewer-but-fuller round trips instead of a growing backlog.
 */
export function createOrderedInputSender(deps: {
  send: (payload: string) => Promise<unknown>;
  onError?: (err: unknown) => void;
  coalesceMs?: number;
  maxChunk?: number;
}): {
  push: (chunk: string) => void;
  /**
   * Stop accepting new input, then deliver what is already queued.
   * Resolves with however many characters could NOT be delivered in time.
   */
  drain: (timeoutMs?: number) => Promise<{ undelivered: number }>;
  dispose: () => void;
} {
  const coalesceMs = deps.coalesceMs ?? INPUT_COALESCE_MS;
  const maxChunk = Math.max(1, deps.maxChunk ?? MAX_INPUT_CHUNK);
  let pending = '';
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** Set by `drain`: refuse new keystrokes, but keep sending the queued ones. */
  let closing = false;
  let settled: Promise<unknown> = Promise.resolve();

  const flush = () => {
    timer = undefined;
    // Already sending: leave the bytes in `pending`. The settle handler below
    // picks up everything that accumulated, preserving order.
    if (inFlight || disposed) return;
    let cut = Math.min(pending.length, maxChunk);
    // Never split a surrogate pair: half of one is not a character, and it
    // would go over the wire as a replacement byte the agent never typed.
    if (cut < pending.length) {
      const c = pending.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    const payload = pending.slice(0, cut);
    pending = pending.slice(cut);
    if (!payload) return;
    inFlight = true;
    settled = Promise.resolve(deps.send(payload))
      .catch((err) => deps.onError?.(err))
      .finally(() => {
        inFlight = false;
        if (pending && !disposed) flush();
      });
    void settled;
  };

  return {
    push(chunk: string) {
      if (disposed || closing || !chunk) return;
      pending += chunk;
      if (!timer) {
        timer = setTimeout(flush, coalesceMs);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    /**
     * Deliver what is already queued, refusing anything new.
     *
     * ⚠️ THE LAST KEYSTROKE IS USUALLY THE IMPORTANT ONE. A command typed and
     * then followed straight away by the detach chord sits inside the 8ms
     * coalescing window, or behind one in-flight request, and `dispose()` alone
     * throws it away silently -- while the operator watched themselves type it.
     * (codex P2.)
     */
    async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
      closing = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      // ⚠️ BOUNDED BY TIME, NOT BY COUNT. A count is a silent DATA cap (it
      // discards the tail of a big paste); no bound at all means a server that
      // stops answering hangs the process forever with the terminal already
      // restored — the operator pressed the detach chord and never got their
      // shell back. Time bounds the wait without bounding the data: a healthy
      // link drains far more than anyone can type in a fraction of this.
      // (codex P2, both directions.)
      const deadline = Date.now() + timeoutMs;
      // ⚠️ NO ITERATION CAP. A fixed count is a silent data cap: at MAX_INPUT_CHUNK
      // per pass, 64 rounds quietly discarded everything past ~256KiB of a paste
      // followed by the detach chord. This terminates without one — `push` is
      // closed, so nothing can extend `pending`, and every pass removes a chunk
      // from it BEFORE the send (so even a send that always throws makes
      // progress). The no-progress guard is belt-and-braces, not the bound.
      // (codex P2.)
      while (!disposed && (pending || inFlight)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        const before = pending.length;
        if (!inFlight) flush();
        // Racing a timer, not just awaiting: a send that never settles must not
        // hold this loop open past the deadline.
        await Promise.race([
          settled.catch(() => {}),
          new Promise((r) => { const t = setTimeout(r, left); (t as { unref?: () => void }).unref?.(); }),
        ]);
        if (!inFlight && pending.length >= before && before > 0) break;
      }
      // In-flight bytes are gone either way — they were handed to fetch and we
      // will never learn the outcome — so only what never left counts.
      return { undelivered: pending.length };
    },
    dispose() {
      disposed = true;
      closing = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
    },
  };
}

/**
 * UTF-8 byte length. The daemon measures every offset and cut in UTF-8 BYTES;
 * `String.length` is UTF-16 code units and under-counts every box-drawing
 * character and emoji an agent prints.
 *
 * (Same contract as webapp's `yolobridge-stream-sink.ts`, which is the fuller
 * implementation — it also re-seeds on a lost relay or a daemon-side drop. This
 * package cannot import from the webapp, and the console's needs are narrower:
 * seed once at join, then follow. Keep the OFFSET SEMANTICS identical; that is
 * the part both sides must agree on.)
 */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  return bytes;
}

/** Drop the first `byteOffset` UTF-8 bytes. The daemon only cuts chunks at
 *  code-point boundaries, so this lands on one too. */
export function sliceFromUtf8Offset(s: string, byteOffset: number): string {
  if (byteOffset <= 0) return s;
  let bytes = 0;
  let i = 0;
  while (i < s.length && bytes < byteOffset) {
    const code = s.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  return s.slice(i);
}

/** One live chunk, as it arrives on the workspace event stream. */
export interface ConsoleChunk {
  data: string;
  epoch?: string;
  startOffset?: number;
}

/**
 * Reconcile a raw seed with the live chunks that arrived while it was in
 * flight, and emit exactly the bytes the terminal should receive.
 *
 * ⚠️ WHY A CONSOLE MUST SEED AT ALL. Joining an already-running session and
 * consuming only FUTURE chunks shows a blank screen — for an idle shell,
 * forever, because an idle terminal emits nothing. The operator reads that as
 * broken. Worse, a TUI's live chunks are cursor moves and erase-lines relative
 * to a screen this viewer never received, so they draw onto an empty canvas and
 * render confidently wrong rather than merely empty. (codex P1.)
 *
 * ⚠️ AND WHY THE STREAM OPENS FIRST. The seed and the tap are two independent
 * round trips that genuinely overlap: subscribing before listening loses the
 * chunks in between, and seeding before listening loses the ones after the
 * snapshot. Opening the stream first and holding what arrives means the only
 * remaining case is DUPLICATION, which absolute offsets resolve exactly —
 * unlike a hole, which nothing can.
 */
export type ReseedReason = 'lost-output' | 'new-epoch';

/**
 * The inline banner marking a discontinuity.
 *
 * Deliberately loud and deliberately IN the stream: it marks the exact point
 * the screen stopped being trustworthy, which nothing outside the terminal can
 * do. A viewer that quietly showed a corrupted screen would be worse than one
 * that showed nothing. `\r\n` (not `\n`) because a terminal needs the carriage
 * return — a bare newline staircases the banner off the previous cursor column.
 */
export function gapMarker(reason: ReseedReason): string {
  const what = reason === 'new-epoch'
    ? 'the session restarted — resyncing the screen'
    : 'output was skipped — resyncing the screen';
  return `\r\n\u001b[33m── ${what} ──\u001b[0m\r\n`;
}

/**
 * How much output may pile up while a seed is in flight. A seed is one HTTP
 * round trip, so this is generous; the bound exists so a seed that never lands
 * — a sleeping laptop, a wedged daemon — cannot grow memory without limit.
 */
const MAX_HELD_CHARS = 512 * 1024;

/**
 * Full terminal reset (RIS), written immediately before a raw replay.
 *
 * ⚠️ A REPLAY IS NOT APPENDABLE OUTPUT. It is the daemon's screen, and its
 * bytes — newlines, cursor moves, scrolling — are interpreted relative to
 * wherever the cursor already is. Written onto whatever this terminal happens
 * to hold (the console's own banner at join; the PREVIOUS rendering of the
 * session on a resync) the replay lands shifted, and a resync that was supposed
 * to repair the screen doubles it instead. RIS puts the cursor home and clears
 * the screen, scroll region, SGR and modes, which is exactly the clean state a
 * replay assumes — and the seed's `prologue` then restores the sticky modes
 * that genuinely were set. (codex P1.)
 */
const TERMINAL_RESET = '\u001bc';

export function createOutputReconciler(): {
  /** Bytes to write for the seed plus everything held while it was in flight. */
  applySeed: (seed: RawOutputSeed | undefined) => string;
  /** Bytes to write for one live chunk — '' while a seed is in flight. */
  push: (chunk: ConsoleChunk) => string;
  /** Non-undefined once a discontinuity needs a fresh seed; clears on read. */
  takeReseedRequest: () => ReseedReason | undefined;
} {
  const held: ConsoleChunk[] = [];
  let heldChars = 0;
  let seeded = false;
  let reseed: ReseedReason | undefined;
  let cursor: number | undefined;
  let epoch: string | undefined;

  /**
   * Apply one chunk against the current position.
   *
   * ⚠️ A DISCONTINUITY IS NOT SOMETHING TO WRITE THROUGH. A terminal stream is
   * not a log: its bytes are cursor moves and erase-lines interpreted RELATIVE
   * to what is already on screen. So splicing bytes that do not continue this
   * screen — because output was dropped under the rate cap, because a relay
   * frame never arrived, or because the daemon started a whole new PTY — does
   * not produce slightly-wrong text. It produces a screen that is confidently,
   * permanently wrong, and nothing later in the stream repairs it. Both cases
   * therefore demand a fresh seed, with the loss MARKED rather than silent.
   * (codex P1.)
   */
  const apply = (chunk: ConsoleChunk): string => {
    if (!chunk.data) return '';
    if (epoch !== undefined && chunk.epoch !== undefined && chunk.epoch !== epoch) {
      return requestReseed('new-epoch', chunk);
    }
    if (cursor === undefined || chunk.startOffset === undefined) {
      // ⚠️ ADOPT THE POSITION FROM THE FIRST CHUNK THAT CARRIES ONE. When the
      // seed was unavailable — a briefly unreachable daemon, a 409 — the
      // console still streams, but with no cursor and no epoch it can never
      // afterwards notice dropped output or a restarted PTY. A recoverable seed
      // failure would silently disable corruption detection for the WHOLE
      // session. The live frames carry everything needed to bootstrap it.
      // (codex P2.)
      if (chunk.startOffset !== undefined) {
        cursor = chunk.startOffset + utf8Length(chunk.data);
        if (epoch === undefined) epoch = chunk.epoch;
      }
      return chunk.data;
    }
    const len = utf8Length(chunk.data);
    const overlap = cursor - chunk.startOffset;
    // A NEGATIVE overlap is a HOLE: these bytes start past where we are, so
    // something between never arrived.
    if (overlap < 0) return requestReseed('lost-output', chunk);
    if (overlap >= len) return '';                       // wholly inside what we already have
    cursor = chunk.startOffset + len;
    return overlap > 0 ? sliceFromUtf8Offset(chunk.data, overlap) : chunk.data;
  };

  /** Stop trusting the screen: hold this chunk and everything after it until a
   *  fresh seed lands, and mark the gap where it actually happened. */
  const requestReseed = (reason: ReseedReason, chunk: ConsoleChunk): string => {
    seeded = false;
    reseed = reason;
    cursor = undefined;
    epoch = undefined;
    hold(chunk);
    return gapMarker(reason);
  };

  const hold = (chunk: ConsoleChunk): void => {
    // Drop the OLDEST when the bound is hit: a seed will replace the screen
    // anyway, so the recent bytes are the ones worth keeping.
    heldChars += chunk.data.length;
    held.push(chunk);
    while (heldChars > MAX_HELD_CHARS && held.length > 1) {
      heldChars -= held.shift()!.data.length;
    }
  };

  return {
    applySeed(seed) {
      seeded = true;
      reseed = undefined;
      const out: string[] = [];
      if (seed?.raw !== undefined) {
        // Reset FIRST — see TERMINAL_RESET. Only when there is actually a
        // replay to write: resetting with nothing to put back would wipe the
        // screen for no reason.
        out.push(TERMINAL_RESET);
        // The prologue restores sticky modes — alt screen, scroll region, wrap
        // — set by escapes older than the oldest retained byte. Without it a
        // truncated replay draws on the wrong canvas from its first byte.
        if (seed.prologue) out.push(seed.prologue);
        out.push(seed.raw);
        epoch = seed.epoch;
        cursor = seed.endOffset ?? (seed.baseOffset !== undefined
          ? seed.baseOffset + utf8Length(seed.raw)
          : undefined);
      }
      // Draining, not iterating: `apply` can request ANOTHER reseed partway
      // through (a second epoch change inside the backlog), and the chunks
      // after that point must stay held rather than be written blind.
      const backlog = held.splice(0, held.length);
      heldChars = 0;
      for (const chunk of backlog) {
        if (!seeded) { hold(chunk); continue; }
        out.push(apply(chunk));
      }
      return out.join('');
    },
    push(chunk) {
      // ⚠️ HOLD, do not drop and do not write. Writing before the seed lands
      // puts bytes on screen that the seed is about to overwrite; dropping
      // leaves a hole nothing can recover.
      if (!seeded) { hold(chunk); return ''; }
      return apply(chunk);
    },
    takeReseedRequest() {
      const r = reseed;
      reseed = undefined;
      return r;
    },
  };
}

/** Convenience wrapper for the join case, and the shape the tests exercise. */
export function reconcileSeed(seed: RawOutputSeed | undefined, held: ConsoleChunk[]): string {
  const r = createOutputReconciler();
  for (const c of held) r.push(c);
  return r.applySeed(seed);
}

export interface ConsoleDeps {
  commonApiBaseUrl: string;
  env?: Record<string, string | undefined>;
  io?: ConfigStoreIO;
  fetchImpl?: FetchImpl;
  /** Defaults to the real stdin/stdout. */
  stdin?: NodeJS.ReadStream;
  stdout?: { write: (s: string) => unknown };
  /** Defaults to `process`; injectable so tests do not install real handlers. */
  signals?: {
    on?: (sig: NodeJS.Signals, fn: () => void) => unknown;
    off?: (sig: NodeJS.Signals, fn: () => void) => unknown;
    kill?: (pid: number, sig: NodeJS.Signals) => unknown;
  };
  /** Defaults to the production auth-service; injectable for tests. */
  authBaseUrl?: string;
  refreshAccessTokenImpl?: (
    authBaseUrl: string,
    refreshToken: string,
    fetchImpl?: FetchImpl,
  ) => Promise<RefreshTokenResult>;
  /** Explicit target; otherwise taken from the stored attachment. */
  workspaceId?: string;
  attachmentId?: string;
  tileId?: string;
}

export type ConsoleResult =
  | { ok: true; reason: 'detached' | 'stream-ended' }
  | { ok: false; reason: 'not-logged-in' | 'no-target' | 'error'; message: string };

/**
 * Resolve what to connect to.
 *
 * ⚠️ Uses the ACCOUNT credential from `auth.json`, never `attachment.scopedToken`
 * — see this file's header. The stored attachment is consulted only for the
 * workspace/attachment/tile IDENTIFIERS, which are not secrets, and only as a
 * convenience when the operator did not pass them explicitly.
 */
export function resolveConsoleTarget(deps: ConsoleDeps):
  | { ok: true; cfg: ApiClientConfig; auth: StoredAuth; workspaceId: string; attachmentId: string; tileId?: string }
  | { ok: false; reason: 'not-logged-in' | 'no-target'; message: string } {
  const auth = loadAuth(deps.env, deps.io);
  if (!auth) {
    return { ok: false, reason: 'not-logged-in', message: 'Not logged in — run `yolo-bridge login` first.' };
  }

  const stored = loadAttachment(deps.env, deps.io);
  const workspaceId = deps.workspaceId ?? stored?.workspaceId;
  // ⚠️ THE STORED RECORD IS A MATCHED SET, not three independent defaults.
  // Falling back to the local attachment id under an explicitly-named DIFFERENT
  // workspace assembles a target out of two unrelated sessions: `yolo-bridge
  // console other-workspace` would go looking for THIS machine's attachment
  // over there. Saying "--attachment is required" is the honest answer.
  // (codex P2.)
  const attachmentId = deps.attachmentId
    ?? (stored && stored.workspaceId === workspaceId ? stored.attachmentId : undefined);
  // ⚠️ The stored tileId describes THIS machine's own attachment. Inheriting it
  // for a DIFFERENT attachment — the entire point of the command — would
  // subscribe to and filter on the wrong tile, so the console would connect and
  // then show another session's screen, or nothing at all. Only carry it when
  // the attachment genuinely matches; otherwise it is resolved from the server.
  // (codex P1.)
  const tileId = deps.tileId
    ?? (stored && stored.attachmentId === attachmentId ? stored.tileId : undefined);

  if (!workspaceId || !attachmentId) {
    return {
      ok: false,
      reason: 'no-target',
      message:
        'Nothing to connect to. Pass the workspace and attachment explicitly:\n'
        + '  yolo-bridge console <workspaceId> --attachment <attachmentId>\n'
        + 'The workspace tile offers "Open in terminal…", which copies that command for you.',
    };
  }

  return {
    ok: true,
    // ⚠️ auth.accessToken — the USER's credential. Never the daemon's.
    cfg: { commonApiBaseUrl: deps.commonApiBaseUrl, accessToken: auth.accessToken, fetchImpl: deps.fetchImpl },
    auth,
    workspaceId,
    attachmentId,
    tileId,
  };
}

/**
 * Pull `yolobridge.output.chunk` payloads for one tile out of the workspace
 * event stream.
 *
 * Exported for testing because the parsing is the part that silently does
 * nothing when it is wrong: a mismatched event name or tile filter produces a
 * console that connects, accepts typing, and shows a blank screen forever.
 */
export function extractOutputChunks(sseText: string, tileId: string | undefined): string[] {
  return extractOutputFrames(sseText, tileId).map((c) => c.data);
}

/**
 * The same parse, keeping the `epoch`/`startOffset` the reconciler needs.
 *
 * `seq` only orders what was SENT, so it cannot say whether a chunk continues
 * the seeded screen, repeats part of it, or skips past it. An ABSOLUTE offset
 * answers all three.
 */
export function extractOutputFrames(sseText: string, tileId: string | undefined): ConsoleChunk[] {
  const out: ConsoleChunk[] = [];
  for (const line of sseText.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    try {
      const evt = JSON.parse(m[1]!) as { type?: string; data?: Record<string, unknown> };
      if (evt.type !== 'yolobridge.output.chunk') continue;
      const d = evt.data;
      if (!d) continue;
      // A workspace can host more than one bridged tile; without this filter a
      // console would render another session's screen into this one.
      if (tileId && d.tileId !== tileId) continue;
      if (typeof d.data === 'string' && d.data) {
        out.push({
          data: d.data,
          ...(typeof d.epoch === 'string' ? { epoch: d.epoch } : {}),
          ...(typeof d.startOffset === 'number' ? { startOffset: d.startOffset } : {}),
        });
      }
    } catch {
      /* keepalives and non-JSON frames are not errors */
    }
  }
  return out;
}

/**
 * Run an interactive console session until the operator detaches or the stream
 * ends.
 *
 * ⚠️ THE TERMINAL MUST BE RESTORED ON EVERY EXIT PATH — clean detach, dropped
 * stream, thrown error, signal. A raw-mode terminal left behind after the
 * process dies is worse than any failure this function can report, because the
 * operator's shell stops echoing and they have to blindly type `reset`.
 */
export async function runConsole(deps: ConsoleDeps): Promise<ConsoleResult> {
  const target = resolveConsoleTarget(deps);
  if (!target.ok) return target;

  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const { cfg, workspaceId, attachmentId } = target;
  let auth = target.auth;
  let tileId = target.tileId;
  const subscriptionId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let rawModeSet = false;
  let stream: Response | undefined;
  // Held out here so BOTH the detach chord and the teardown can reach it.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  /** Set when a mid-session refresh fails, so the exit reports WHY. */
  let authFailure: string | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let stdinListener: ((chunk: Buffer | string) => void) | undefined;
  const signals = deps.signals ?? process;
  // Hoisted so TEARDOWN owns them. Cleaning them up at the end of the happy
  // path is not cleanup at all: a rejected `read()` jumps straight to catch,
  // and a coalescing timer or an in-flight send would then deliver keystrokes
  // AFTER the console reported failure and handed the shell back. (codex P2.)
  let filter: { push: (c: string) => void; dispose: () => void } | undefined;
  let sender: ReturnType<typeof createOrderedInputSender> | undefined;
  /** Latched in teardown so a late-landing seed cannot draw on a restored shell. */
  let finished = false;
  /** The renewal tick currently running, so teardown can let it finish first. */
  let renewInFlight: Promise<void> | undefined;
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  /** Idempotent, and called from every exit path. */
  const restore = () => {
    if (renewTimer) { clearInterval(renewTimer); renewTimer = undefined; }
    if (stdinListener && typeof stdin.off === 'function') stdin.off('data', stdinListener);
    stdinListener = undefined;
    if (rawModeSet && stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(false);
      rawModeSet = false;
    }
    try { stdin.pause?.(); } catch { /* already gone */ }
    for (const [sig, fn] of signalHandlers) signals.off?.(sig, fn);
    signalHandlers.length = 0;
  };

  // ⚠️ A SIGNAL MUST NOT LEAVE THE TERMINAL IN RAW MODE. `restore()` otherwise
  // runs only on normal completion, so an external `kill` — a supervisor, a
  // window manager, an impatient operator in another pane — kills this process
  // while their SHELL survives, and that shell stops echoing until they blindly
  // type `reset`. This file's header calls that worse than any error it can
  // report, so it has to hold for the signal path too. (codex P2.)
  //
  // NOT SIGINT: raw mode disables the tty's own SIGINT generation, so Ctrl+C
  // reaches the agent as a byte and no signal is raised here at all.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    const fn = () => {
      restore();
      // Re-raise with the handler already removed, so the exit status is the
      // honest one for the signal rather than a synthesized code.
      try { signals.kill?.(process.pid, sig); } catch { /* nothing left to signal */ }
    };
    signalHandlers.push([sig, fn]);
    signals.on?.(sig, fn);
  }

  /**
   * Rotate the account credential in place when it is close to expiry.
   *
   * ⚠️ MUTATES `cfg.accessToken`. api-client reads it at call time, so every
   * later input POST and lease renewal picks the new token up with no
   * re-plumbing. It also writes auth.json, so a `status` or a restart sees the
   * fresh token rather than the one this process rotated past.
   *
   * NOT applied to the already-open SSE stream: its token went into the URL at
   * connect time and cannot be swapped without reopening. That is why this runs
   * BEFORE connecting — a console must never start on a token that is already
   * dead — and why an expiry mid-stream surfaces as the stream ending, which
   * exits the command visibly, rather than as a silent freeze.
   */
  const ensureFreshToken = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (Date.now() < auth.expiresAtMs - REFRESH_BUFFER_MS) return { ok: true };
    if (!auth.refreshToken) {
      return {
        ok: false,
        message: 'Your session has expired and no refresh token is stored here — run `yolo-bridge login`.',
      };
    }
    const doRefresh = deps.refreshAccessTokenImpl ?? refreshAccessToken;
    const result = await doRefresh(deps.authBaseUrl ?? DEFAULT_AUTH_URL, auth.refreshToken, deps.fetchImpl);
    if (result.status !== 'ok') {
      return { ok: false, message: `Could not refresh your session (${result.message}) — run \`yolo-bridge login\`.` };
    }
    auth = {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      tokenType: auth.tokenType,
      expiresAtMs: result.tokens.expiresAtMs,
    };
    cfg.accessToken = auth.accessToken;
    try { saveAuth(auth, deps.env, deps.io); } catch { /* a read-only config dir must not kill the session */ }
    return { ok: true };
  };

  try {
    const fresh = await ensureFreshToken();
    if (!fresh.ok) return { ok: false, reason: 'not-logged-in', message: fresh.message };

    // Resolve the tile when it was not inherited — a remote attachment has no
    // local record, and WITHOUT a tile there is no subscription, so output
    // streaming (which is demand-driven) never starts and the console is blank.
    if (!tileId) {
      tileId = await resolveAttachmentTile(cfg, workspaceId, attachmentId);
      if (!tileId) {
        return {
          ok: false,
          reason: 'error',
          message: `No bridged tile found for attachment ${attachmentId} in that workspace.`,
        };
      }
    }

    // ⚠️ ORDER IS LOAD-BEARING: LISTEN → SUBSCRIBE → SEED.
    //
    // Output streaming is demand-driven, so nothing flows until the subscribe.
    // But the subscribe and the seed are independent round trips, and whichever
    // of the three happens first decides which failure you get:
    //   subscribe before listening → the first chunks are emitted to nobody;
    //   seed before listening      → the chunks after the snapshot are lost.
    // Opening the stream first leaves only DUPLICATION, and absolute offsets
    // resolve that exactly. A hole, nothing can. (codex P1.)
    stream = await openWorkspaceEventStream(cfg, workspaceId);

    if (tileId) {
      // Captured so the renewal closure below cannot see it widen back to
      // undefined — a `let` loses its narrowing across a closure boundary.
      const subscribedTileId = tileId;
      const lease = await subscribeOutput(cfg, workspaceId, subscribedTileId, subscriptionId);
      const everyMs = Math.max(1000, Math.floor((lease.renewWithinMs ?? lease.leaseMs ?? 20_000) / 2));
      // ⚠️ setInterval does NOT wait for the previous tick. A slow auth-service
      // call would overlap two renewals, and near expiry BOTH would present the
      // same refresh token — with rotation, one succeeds and the other fails,
      // setting `authFailure` and killing a console whose credential is
      // perfectly fine. A single in-flight tick removes the race entirely.
      // (codex P2.)
      let renewing = false;
      renewTimer = setInterval(() => {
        if (renewing || finished) return;
        renewing = true;
        renewInFlight = (async () => {
          // Refresh FIRST, and STOP if it fails. The renewal below swallows its
          // errors by design, so continuing on a dead token means the lease
          // silently lapses and an overnight console just stops receiving
          // output — no error, no exit, a frozen screen the operator reads as a
          // hung agent. Ending the session with a message is the honest
          // failure. (codex P1.)
          const fresh = await ensureFreshToken();
          if (!fresh.ok) {
            authFailure = fresh.message;
            if (renewTimer) { clearInterval(renewTimer); renewTimer = undefined; }
            // Wake the blocked read so the loop exits now rather than at the
            // next heartbeat — the same reason detach cancels it.
            void reader?.cancel().catch(() => {});
            return;
          }
          // ⚠️ CHECK AGAIN AFTER THE AWAIT. Clearing the interval does not stop
          // a callback already running, so a renewal begun just before the
          // operator detached could land AFTER teardown unsubscribed —
          // recreating the subscription and leaving the daemon streaming to
          // nobody until the fresh lease expired. (codex P2.)
          if (finished) return;
          await subscribeOutput(cfg, workspaceId, subscribedTileId, subscriptionId).catch(() => {});
        })().finally(() => { renewing = false; });
        void renewInFlight;
      }, everyMs);
      (renewTimer as { unref?: () => void }).unref?.();
    }

    stdout.write(
      `yolo-bridge console — attached to ${attachmentId}\r\n`
      + 'Ctrl+C goes to the agent · Ctrl-P Ctrl-Q to leave (the agent keeps running)\r\n\r\n',
    );

    // Created before the input filter, which cancels it on detach.
    reader = stream.body!.getReader();

    // The seed lands asynchronously; every chunk that arrives first is HELD by
    // the reconciler and replayed in order once it does.
    const reconciler = createOutputReconciler();

    /**
     * Fetch a raw seed and apply it, with the chunks held meanwhile.
     *
     * Runs at join AND on every later discontinuity. Single-flight: a second
     * request while one is in flight is pointless — the in-flight seed is
     * already newer than the gap that triggered it.
     */
    let seeding: Promise<void> | undefined;
    /** Bounds a reseed that keeps finding a gap, so it cannot spin forever. */
    let reseedAttempts = 0;
    const seedNow = (announceFailure: boolean): Promise<void> => {
      if (seeding) return seeding;
      seeding = (tileId
        ? readRawOutputSeed(cfg, workspaceId, tileId).catch(() => undefined)
        : Promise.resolve(undefined)
      ).then((seed) => {
        // ⚠️ NEVER DRAW ON A RESTORED SHELL. A stalled raw-output fetch can
        // land long after the operator detached; writing then scribbles into
        // whatever they are doing now. And it must not be AWAITED on the way
        // out either -- that put terminal restoration behind a request with no
        // bound, leaving the shell in RAW MODE for its whole duration.
        // (codex P1.)
        if (finished) return;
        const bytes = reconciler.applySeed(seed);
        if (bytes) stdout.write(bytes);
        if (!seed && announceFailure) {
          // Not fatal — live output still works. But say so, because a blank
          // screen that is ABOUT to fill looks the same as one that never will.
          stdout.write('\r\n[console] could not read the current screen — showing new output only\r\n');
        }
      }).finally(() => {
        seeding = undefined;
        // ⚠️ THE BACKLOG DRAIN CAN ITSELF FIND A GAP. The stream loop already
        // checked `takeReseedRequest()` for those chunks when they arrived, so
        // nothing looks again -- and on an idle session nothing else ever runs.
        // The reconciler would then hold EVERY later byte forever: a console
        // frozen with no error anywhere. (codex P1.)
        if (reconciler.takeReseedRequest()) {
          if (reseedAttempts < MAX_CHAINED_RESEEDS) {
            reseedAttempts += 1;
            void seedNow(false);
          } else {
            // Stop re-syncing rather than spin: show live output and say the
            // screen may be wrong. Honest, and still usable.
            stdout.write(RESYNC_GAVE_UP);
            const rest = reconciler.applySeed(undefined);
            if (rest) stdout.write(rest);
          }
        } else {
          reseedAttempts = 0;
        }
      });
      return seeding;
    };
    // Deliberately NOT awaited anywhere on the exit path — see the `finished`
    // guard inside. A stalled seed must never hold the terminal in raw mode.
    void seedNow(true);

    // ── input ────────────────────────────────────────────────────────────────
    let detached = false;
    sender = createOrderedInputSender({
      send: (payload) => sendConsoleInput(cfg, workspaceId, attachmentId, payload),
      onError: (err) => {
        const msg = err instanceof YoloBridgeApiError ? err.message : String(err);
        stdout.write(`\r\n[console] input not delivered: ${msg}\r\n`);
      },
    });

    // The SAME filter the local `attach` uses, so the detach chord behaves
    // identically in both places rather than being two implementations that
    // drift.
    filter = createDetachSequenceFilter({
      emit: (chunk) => sender?.push(chunk),
      onDetach: () => {
        detached = true;
        // ⚠️ CANCEL THE READ, do not merely set the flag. The loop below is
        // blocked in `reader.read()`, and on a quiet agent nothing wakes it
        // until the next chunk or heartbeat — up to ~30s of a terminal stuck in
        // RAW MODE after the operator asked to leave. That is precisely the
        // outcome this command treats as worse than any error it can report.
        // (codex P1.)
        void reader?.cancel().catch(() => { /* already closed */ });
      },
    });

    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
      rawModeSet = true;
    }
    stdin.resume?.();
    stdin.setEncoding?.('utf-8');
    stdinListener = (chunk) => filter?.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    stdin.on('data', stdinListener);

    // ── output ───────────────────────────────────────────────────────────────
    const decoder = new TextDecoder();
    const activeReader = reader;
    let buf = '';
    while (!detached) {
      const { value, done } = await activeReader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Frames are blank-line separated; keep any partial tail for next read.
      const lastBreak = buf.lastIndexOf('\n\n');
      if (lastBreak === -1) continue;
      const complete = buf.slice(0, lastBreak);
      buf = buf.slice(lastBreak + 2);
      for (const chunk of extractOutputFrames(complete, tileId)) {
        const bytes = reconciler.push(chunk);
        if (bytes) stdout.write(bytes);
      }
      // A gap or a restarted PTY: the screen is no longer trustworthy and every
      // further chunk is held until a fresh seed replaces it.
      if (reconciler.takeReseedRequest()) void seedNow(false);
    }

    if (authFailure) return { ok: false, reason: 'not-logged-in', message: authFailure };
    return { ok: true, reason: detached ? 'detached' : 'stream-ended' };
  } catch (err) {
    const message = err instanceof YoloBridgeApiError ? err.message : (err as Error)?.message || 'console failed';
    return { ok: false, reason: 'error', message };
  } finally {
    finished = true;
    // restore() FIRST: it un-raws the terminal and unhooks stdin, so no new
    // keystroke can enter the sender. Then drain what was ALREADY typed — the
    // command someone entered a moment before the chord is theirs, not ours to
    // discard — and only then let go.
    filter?.dispose();
    restore();
    const drained = await sender?.drain().catch(() => ({ undelivered: 0 }));
    sender?.dispose();
    if (drained && drained.undelivered > 0) {
      // Say it. Input the operator typed and did not send is exactly the thing
      // they must not have to guess about.
      stdout.write(`[console] ${drained.undelivered} character(s) of input could not be delivered\r\n`);
    }
    // Let an in-flight renewal finish BEFORE unsubscribing, so the two cannot
    // land in the wrong order. Bounded for the same reason everything else here
    // is: teardown must not depend on the API answering.
    if (renewInFlight) {
      await Promise.race([
        renewInFlight.catch(() => {}),
        new Promise((r) => {
          const t = setTimeout(r, UNSUBSCRIBE_TIMEOUT_MS);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    }

    // Best-effort, and BOUNDED. `fetch` has no timeout of its own, so awaiting
    // this against a stalled API left the terminal restored but the process
    // alive — the operator never gets their shell prompt back. The lease
    // expires on its own anyway; this only makes it prompt. (codex P2.)
    if (tileId) {
      await Promise.race([
        unsubscribeOutput(cfg, workspaceId, tileId, subscriptionId).catch(() => {}),
        new Promise((r) => {
          const t = setTimeout(r, UNSUBSCRIBE_TIMEOUT_MS);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
    }
    // ⚠️ Cancel the READER, not the body. Once `getReader()` has been called the
    // body is LOCKED, and `body.cancel()` then returns a REJECTED promise — which
    // a `try/catch` cannot catch, so it surfaces as an unhandledRejection and, on
    // Node's default, kills the process on an otherwise clean detach. Awaiting
    // the reader's own cancel is the supported way to release it.
    try {
      if (reader) await reader.cancel();
      else await stream?.body?.cancel();
    } catch { /* already closed */ }
    stdout.write('\r\n');
  }
}
