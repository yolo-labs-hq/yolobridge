/**
 * Volume control for the daemon→server live output stream
 * (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming").
 *
 * PURE — no timers, no network, no PTY. `attach-cmd.ts` owns the flush tick
 * and the POST; this file owns the only question that is genuinely hard:
 * **what do we send, and what do we refuse to send, when the PTY produces
 * more than the link (or the operator's bandwidth budget) can carry?**
 *
 * PTY output is bursty and can be enormous — a build log, `yes`, a `cat` of a
 * multi-megabyte file. Relaying it verbatim would turn one careless command on
 * the operator's laptop into an unbounded upload and an unbounded fan-out onto
 * the workspace event bus. Three independent bounds, each doing a different
 * job:
 *
 *   1. **`maxQueueBytes`** — the standing backlog. When the producer outruns
 *      the drain the queue is trimmed from the FRONT (oldest first), because
 *      on a terminal the newest bytes are the ones the viewer needs: they are
 *      what is on screen right now. The trimmed byte count is REMEMBERED, not
 *      forgotten (see `droppedBytes`).
 *   2. **`maxBatchBytes`** — the size of any single POST, so one flush can
 *      never produce a request the server has to buffer megabytes for.
 *   3. **`maxBytesPerSecond`** — a token bucket over the whole stream. This is
 *      the one that actually caps sustained cost; the other two bound a single
 *      moment. A full bucket is allowed as a one-second burst, so ordinary
 *      agent output (which is bursty but small) is never throttled at all.
 *
 * **A drop is always MARKED, never silent.** `drain()` returns the number of
 * bytes skipped alongside the data that follows them, and the viewer renders
 * an explicit gap marker and re-seeds from the poll route. That matters
 * specifically because this is a TERMINAL: dropping bytes out of a stream of
 * cursor-addressing escapes does not degrade gracefully into "slightly less
 * text", it produces a screen that is confidently wrong. Telling the viewer
 * "there is a hole here" is what lets it recover instead of lying.
 *
 * Byte lengths are UTF-8 (`Buffer.byteLength`), because that is what actually
 * crosses the wire — not `String.length`, which under-counts every non-ASCII
 * character an agent's box-drawing/emoji output is full of.
 */

/** Default flush cadence, owned by the caller — exported here so the tuning
 *  constants that describe one mechanism live together. Short enough that
 *  output reads as live, long enough that a chatty PTY costs ~12 POSTs/second
 *  rather than one per `onData`. */
export const DEFAULT_FLUSH_INTERVAL_MS = 80;

/**
 * Flush delay after a console keystroke, rather than waiting out the batch
 * window.
 *
 * The 80ms above is right for a passive VIEWER: it trades a little liveness for
 * ~12 POSTs/second instead of one per `onData`. It is wrong for an interactive
 * session, where a single echoed keystroke IS the entire payload and the batch
 * saves nothing while costing up to 80ms of a round trip already near 200ms —
 * measured 2026-08-28, and roughly 40% of the budget that is ours to spend
 * rather than the network's.
 *
 * 5ms is long enough that a burst of keystrokes still coalesces into one POST,
 * short enough to be invisible next to the ~160ms the network costs.
 */
export const INTERACTIVE_ECHO_FLUSH_MS = 5;

/** ~192 KiB/s sustained. Comfortably above a fast agent's real output rate
 *  (a streaming LLM response is a few KiB/s), far below what `cat`ting a
 *  large file would produce. */
export const DEFAULT_MAX_BYTES_PER_SECOND = 192 * 1024;

/** One POST never carries more than this. At the default flush interval this
 *  is also well above the per-tick share of the rate cap, so it only ever
 *  binds on the very first tick after an idle period (when the token bucket
 *  is full). */
export const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;

/** Standing backlog cap. Two seconds of rate-capped output — enough to ride
 *  out one slow POST without dropping anything, small enough that a runaway
 *  producer can never grow the daemon's heap. */
export const DEFAULT_MAX_QUEUE_BYTES = 384 * 1024;

export interface OutputStreamBufferOptions {
  maxQueueBytes?: number;
  maxBatchBytes?: number;
  maxBytesPerSecond?: number;
  /** Injectable clock so the token bucket is testable without real waiting. */
  now?: () => number;
  /**
   * Absolute UTF-8 byte offset, within the PTY session's own byte stream, of
   * the next byte this buffer will be handed (see `setBaseOffset`).
   */
  startOffset?: number;
}

export interface OutputBatch {
  /** The bytes to relay. May be empty ONLY when `droppedBytes > 0` — i.e. a
   *  batch that exists purely to report a gap. */
  data: string;
  /** How many bytes were skipped IMMEDIATELY BEFORE `data`. 0 on the happy
   *  path. */
  droppedBytes: number;
  /**
   * Absolute UTF-8 byte offset of `data[0]` within the PTY session's byte
   * stream (`RawChunkMeta.startOffset` in local-agent.ts).
   *
   * ⚠️ THIS IS THE CORRECTNESS PRIMITIVE OF THE WHOLE LIVE-TERMINAL PATH, not
   * a diagnostic. `seq` orders only what was actually SENT, so it cannot tell
   * a viewer whether the bytes it holds continue from the screen it seeded, or
   * overlap it, or leave a hole. An absolute offset can: the viewer knows the
   * offset its seed ended at, so it can drop a duplicated prefix, splice an
   * exact continuation, and detect a gap — which is what makes the seed and
   * the tap safe to be two separate, racing operations.
   */
  startOffset: number;
}

/**
 * Longest prefix of `s` whose UTF-8 encoding is at most `maxBytes`, plus the
 * remainder.
 *
 * Never splits a surrogate pair: a JS string is UTF-16, and cutting between
 * the halves of an astral character (an emoji in an agent's output) produces a
 * lone surrogate, which `JSON.stringify` escapes into a value the server
 * decodes back as U+FFFD — a permanently corrupted character rather than one
 * that reassembles on the far side. Splitting only at code-point boundaries
 * makes the two halves concatenate back into exactly the original text.
 *
 * Fast path for pure ASCII (`byteLength === length`), which is the
 * overwhelming majority of terminal output; the walk is only paid for when a
 * chunk actually contains multibyte characters AND is large enough to need
 * splitting.
 */
export function splitByUtf8Bytes(s: string, maxBytes: number): { head: string; tail: string } {
  if (maxBytes <= 0) return { head: '', tail: s };
  const total = Buffer.byteLength(s, 'utf-8');
  if (total <= maxBytes) return { head: s, tail: '' };
  if (total === s.length) {
    // Pure ASCII — one byte per UTF-16 code unit, so the cut is exact.
    return { head: s.slice(0, maxBytes), tail: s.slice(maxBytes) };
  }
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const code = s.codePointAt(i)!;
    const units = code > 0xffff ? 2 : 1;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += units;
  }
  return { head: s.slice(0, i), tail: s.slice(i) };
}

/**
 * Bounded, rate-limited FIFO of PTY output awaiting relay.
 *
 * Holds JS strings rather than Buffers because that is what `node-pty` hands
 * us and what the JSON body carries — converting to bytes and back would add
 * two encodes per chunk for no gain, and the only place byte counts matter
 * (the caps) can measure them on demand.
 */
export class OutputStreamBuffer {
  private readonly maxQueueBytes: number;
  private readonly maxBatchBytes: number;
  private readonly maxBytesPerSecond: number;
  private readonly now: () => number;

  private chunks: string[] = [];
  private queuedBytesValue = 0;
  private droppedBytes = 0;

  /** Absolute offset of the first byte still queued (== `writeOffset` when the
   *  queue is empty). Advanced by everything that LEAVES the queue, whether it
   *  was drained or trimmed, so it always names the next byte a viewer has not
   *  been offered. */
  private headOffset = 0;
  /** Absolute offset one past the last byte ever pushed. */
  private writeOffset = 0;

  /** Token bucket, in bytes. Starts FULL so the first burst after an idle
   *  period (the common case — a viewer opens the tile and the agent starts
   *  talking) is never throttled. */
  private tokens: number;
  private lastRefillAt: number;

  constructor(opts: OutputStreamBufferOptions = {}) {
    this.maxQueueBytes = opts.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.maxBatchBytes = opts.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.maxBytesPerSecond = opts.maxBytesPerSecond ?? DEFAULT_MAX_BYTES_PER_SECOND;
    this.now = opts.now ?? Date.now;
    this.tokens = this.maxBytesPerSecond;
    this.lastRefillAt = this.now();
    this.headOffset = opts.startOffset ?? 0;
    this.writeOffset = this.headOffset;
  }

  /**
   * Rebase this buffer onto a new absolute byte position. Only meaningful on
   * an EMPTY buffer — it is called when a streaming episode starts (priming
   * from local-agent.ts's raw ring) and when the PTY session underneath is
   * replaced, both of which discard whatever was queued first.
   */
  setBaseOffset(offset: number): void {
    this.headOffset = offset;
    this.writeOffset = offset;
  }

  /** Absolute offset of the next byte a viewer has not been offered yet. */
  get nextOffset(): number {
    return this.headOffset;
  }

  get queuedBytes(): number {
    return this.queuedBytesValue;
  }

  /** Bytes skipped so far and not yet reported to the viewer. */
  get pendingDroppedBytes(): number {
    return this.droppedBytes;
  }

  /**
   * Enqueue raw PTY output, trimming the OLDEST bytes if that pushes the
   * backlog past `maxQueueBytes`.
   *
   * A single chunk larger than the whole cap is itself trimmed from its front,
   * so `push` can never leave the queue over the bound no matter what one
   * `onData` delivers.
   */
  push(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    const pushed = Buffer.byteLength(chunk, 'utf-8');
    this.queuedBytesValue += pushed;
    this.writeOffset += pushed;
    this.trim();
  }

  /**
   * Record bytes that were LOST rather than queued — today, a batch whose POST
   * failed after `drain()` had already handed the bytes over. Reporting them
   * as a gap is the honest outcome: they are gone, and the viewer's screen is
   * missing them either way. Re-queueing them instead would reorder the stream
   * behind whatever arrived while the POST was in flight, which on a terminal
   * is worse than an acknowledged hole.
   */
  noteDropped(bytes: number): void {
    if (bytes > 0) this.droppedBytes += bytes;
  }

  private trim(): void {
    while (this.queuedBytesValue > this.maxQueueBytes && this.chunks.length > 0) {
      const overflow = this.queuedBytesValue - this.maxQueueBytes;
      const oldest = this.chunks[0];
      const oldestBytes = Buffer.byteLength(oldest, 'utf-8');
      if (oldestBytes <= overflow) {
        this.chunks.shift();
        this.queuedBytesValue -= oldestBytes;
        this.droppedBytes += oldestBytes;
        this.headOffset += oldestBytes;
        continue;
      }
      // Partially trim the oldest chunk: drop exactly the overflow off its
      // front (at a code-point boundary) and keep the rest.
      const { head } = splitByUtf8Bytes(oldest, overflow);
      const dropped = Buffer.byteLength(head, 'utf-8');
      const kept = oldest.slice(head.length);
      this.chunks[0] = kept;
      this.queuedBytesValue -= dropped;
      this.droppedBytes += dropped;
      this.headOffset += dropped;
      // `splitByUtf8Bytes` can stop just SHORT of `overflow` when the next
      // code point straddles the boundary; loop again rather than assuming one
      // pass is enough.
      if (dropped === 0) {
        // Cannot make progress (a single code point wider than the overflow):
        // drop the whole chunk rather than spin.
        this.chunks.shift();
        this.queuedBytesValue -= oldestBytes;
        this.droppedBytes += oldestBytes;
        this.headOffset += oldestBytes;
      }
    }
  }

  private refill(): void {
    const at = this.now();
    const elapsedMs = at - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    this.lastRefillAt = at;
    this.tokens = Math.min(
      this.maxBytesPerSecond,
      this.tokens + (this.maxBytesPerSecond * elapsedMs) / 1000,
    );
  }

  /**
   * Take the next batch to relay, or `null` when there is nothing to send
   * right now (empty queue with no gap to report, or the rate cap is spent).
   *
   * Spending the rate cap is deliberately NOT an error and does not itself
   * drop anything: the bytes stay queued and go out on a later tick. They are
   * only dropped if the producer keeps running long enough to overflow
   * `maxQueueBytes` — which is exactly the "genuinely more output than we will
   * ever relay" case, and is reported as a gap when it happens.
   */
  drain(): OutputBatch | null {
    this.refill();
    const allowance = Math.min(this.maxBatchBytes, Math.floor(this.tokens));
    if (allowance <= 0) return null;

    const startOffset = this.headOffset;
    let taken = '';
    let takenBytes = 0;
    while (this.chunks.length > 0 && takenBytes < allowance) {
      const chunk = this.chunks[0];
      const chunkBytes = Buffer.byteLength(chunk, 'utf-8');
      if (takenBytes + chunkBytes <= allowance) {
        taken += chunk;
        takenBytes += chunkBytes;
        this.chunks.shift();
        this.queuedBytesValue -= chunkBytes;
        continue;
      }
      const { head, tail } = splitByUtf8Bytes(chunk, allowance - takenBytes);
      if (!head) break; // next code point doesn't fit — leave it for the next tick
      const headBytes = Buffer.byteLength(head, 'utf-8');
      taken += head;
      takenBytes += headBytes;
      this.chunks[0] = tail;
      this.queuedBytesValue -= headBytes;
      break;
    }

    const droppedBytes = this.droppedBytes;
    if (takenBytes === 0 && droppedBytes === 0) return null;
    this.droppedBytes = 0;
    this.tokens -= takenBytes;
    this.headOffset += takenBytes;
    return { data: taken, droppedBytes, startOffset };
  }

  /** Forget everything queued. Used when a stream ends — those bytes belong to
   *  a `streamId` that no longer exists, and carrying them into the next
   *  stream would splice one session's screen into another's. */
  reset(): void {
    this.chunks = [];
    this.queuedBytesValue = 0;
    this.droppedBytes = 0;
    this.headOffset = this.writeOffset;
  }
}
