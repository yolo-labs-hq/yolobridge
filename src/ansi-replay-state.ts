/**
 * The two things a RAW-BYTE replay cannot get right on its own
 * (docs/YOLOBRIDGE_PLAN.md, "Live terminal streaming").
 *
 * `local-agent.ts`'s ring gives a remote viewer the daemon's last
 * `RAW_RING_MAX_BYTES` of PTY output to replay, and replaying bytes is exact
 * where reconstructing state is not. But a ring is a WINDOW onto a byte
 * stream, and a window has two edges that raw replay alone gets wrong:
 *
 *   1. **The window can open mid-escape-sequence.** The ring's `baseOffset`
 *      (and the stream prime's start point) is wherever the trim happened to
 *      land — an arbitrary byte. Land it inside `ESC [ 3 8 ; 5 ; 1 9 6 m` and
 *      the viewer's xterm parses `8;5;196m` as TEXT, prints it, and carries on
 *      with whatever SGR/mode state that left behind — possibly forever. This
 *      is not a rare case: escapes are a large fraction of a TUI's bytes.
 *
 *      Fixed by `AnsiScanner`, an escape-state machine run over the SAME byte
 *      stream the terminal consumed, which records the absolute offsets at
 *      which the parser is in GROUND state. A replay that starts at a ground
 *      offset starts where a fresh parser and the daemon's parser agree.
 *
 *      Deliberately NOT "scan back to the last `\n`": an OSC string (a window
 *      title, an OSC 8 hyperlink, an OSC 52 clipboard payload) can contain a
 *      newline, so the newline heuristic is wrong in exactly the cases that
 *      matter. This is exact.
 *
 *   2. **The window can have rolled past a STICKY MODE.** The escape that
 *      entered the alternate screen, set the scroll region (DECSTBM), hid the
 *      cursor or turned autowrap off may be older than the oldest retained
 *      byte. Replay cannot restore what it no longer holds, and every one of
 *      those changes where subsequent output LANDS.
 *
 *      Fixed by `TerminalModeTracker`, which watches the same byte stream for
 *      exactly those sticky sequences and can emit a short, idempotent MODE
 *      PROLOGUE ahead of the replay tail. See `buildModePrologue` for the
 *      split between what is read from the daemon's own `Terminal` (the
 *      authority) and what this tracker supplies because the public API does
 *      not expose it.
 *
 * PURE. No terminal, no timers, no I/O — every function here is a fold over a
 * string, which is what makes the whole thing testable byte by byte.
 *
 * ⚠️ UTF-8 BYTE OFFSETS, not UTF-16 code units. Every offset this module
 * produces or consumes is an absolute UTF-8 byte position in the PTY's byte
 * stream, because that is what the ring, the chunk protocol and the viewer's
 * splice arithmetic are all measured in.
 *
 * KNOWN LIMIT, stated rather than hidden: 8-bit C1 control bytes (a bare 0x9B
 * as CSI, 0x9D as OSC) are not recognised. In a UTF-8 PTY — which is what
 * every agent this daemon runs produces — those byte values only ever occur
 * as continuation bytes inside a multi-byte character, where treating them as
 * ordinary text is the correct reading.
 */

/**
 * Where the escape parser is. A subset of the DEC/xterm state machine: the
 * distinctions kept are exactly the ones that change whether a byte boundary
 * is a safe place to start replaying, plus enough structure to hand complete
 * CSI/ESC sequences to a sink.
 */
export type AnsiParserState =
  /** Between sequences. The ONLY state a replay may begin in. */
  | 'ground'
  /** Just consumed ESC; the next byte decides what kind of sequence this is. */
  | 'esc'
  /** ESC followed by intermediate bytes (0x20-0x2F), awaiting a final. */
  | 'esc-intermediate'
  /** Inside `CSI …`, collecting parameter/intermediate bytes. */
  | 'csi'
  /** Inside a string sequence body — OSC, DCS, SOS, PM or APC. */
  | 'string'
  /** Saw ESC inside a string body: `\` makes it ST, anything else starts a
   *  new escape sequence. */
  | 'string-esc'
  /** After SS2/SS3 (`ESC N` / `ESC O`), which shift exactly the NEXT
   *  character out of the current character set. Starting a replay between
   *  the shift and its character would render the wrong glyph, so the
   *  boundary is deliberately not ground. */
  | 'single-shift';

/**
 * Callbacks a scan can raise. All optional — a scan that only wants parser
 * state (the trim path) passes none at all and costs one branch per byte.
 */
export interface AnsiScanSink {
  /** The parser is in ground state at this absolute offset, i.e. a replay
   *  starting here parses identically to the daemon's terminal. */
  ground?(offset: number): void;
  /** A complete CSI sequence: its collected parameter+intermediate bytes and
   *  its final byte (e.g. `('?25', 'l')`, `('1;38;5;196', 'm')`). */
  csi?(params: string, final: string): void;
  /** A complete two-byte ESC sequence's final byte (e.g. `'c'` for RIS). */
  esc?(final: string): void;
}

/** Cap on collected CSI parameter bytes. A real sequence is a few dozen bytes;
 *  this bounds what a hostile or corrupted stream can make us retain. Past the
 *  cap the parameters are truncated, which makes the sequence unrecognised —
 *  the safe failure, since an unrecognised sticky mode is simply not restored
 *  rather than restored wrongly. */
const MAX_CSI_PARAM_CHARS = 256;

/**
 * A resumable escape-state machine over a UTF-8 byte stream.
 *
 * Resumable is the point: the ring's oldest retained byte is not the stream's
 * first byte, so answering "is offset X ground?" requires knowing the parser
 * state at the start of what is retained. `local-agent.ts` keeps one scanner
 * fed with the bytes it TRIMS (giving the state at `baseOffset`) and one fed
 * with every byte it PUSHES (driving the mode tracker).
 */
export class AnsiScanner {
  state: AnsiParserState = 'ground';
  private collected = '';

  /** Start over from a known state — used to fork a scan from a saved
   *  position without replaying the stream that led to it. */
  reset(state: AnsiParserState = 'ground'): void {
    this.state = state;
    this.collected = '';
  }

  /**
   * Consume `text`, whose first byte sits at absolute offset `startOffset`.
   * Returns the absolute offset one past its last byte.
   *
   * Iterates CODE POINTS while accounting in BYTES: every byte that can change
   * parser state is ASCII, so a multi-byte character is always a single
   * indivisible "printable" — which is exactly what makes it safe to walk the
   * JS string the ring actually stores instead of encoding it to a Buffer.
   */
  feed(text: string, startOffset: number, sink?: AnsiScanSink): number {
    let offset = startOffset;
    for (let i = 0; i < text.length; ) {
      const code = text.codePointAt(i)!;
      const units = code > 0xffff ? 2 : 1;
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      // Reported BEFORE consuming: a replay that begins at this offset begins
      // by parsing this code point, which is only safe from ground.
      if (this.state === 'ground') sink?.ground?.(offset);
      this.step(code, sink);
      offset += size;
      i += units;
    }
    // The position after the last byte is a valid start too, when it is ground.
    if (this.state === 'ground') sink?.ground?.(offset);
    return offset;
  }

  private step(code: number, sink?: AnsiScanSink): void {
    switch (this.state) {
      case 'ground':
        if (code === 0x1b) this.enterEsc();
        return;

      case 'esc':
        this.stepEsc(code, sink);
        return;

      case 'esc-intermediate':
        if (code >= 0x20 && code <= 0x2f) return; // more intermediates
        if (code === 0x1b) return this.enterEsc();
        // A final byte (or anything else) ends the sequence. Nothing here is
        // a sticky mode, so no sink callback.
        this.state = 'ground';
        return;

      case 'csi':
        if (code === 0x1b) return this.enterEsc();
        // CAN / SUB abort a sequence in progress, everywhere.
        if (code === 0x18 || code === 0x1a) {
          this.state = 'ground';
          return;
        }
        if (code >= 0x40 && code <= 0x7e) {
          const params = this.collected;
          this.collected = '';
          this.state = 'ground';
          sink?.csi?.(params, String.fromCharCode(code));
          return;
        }
        if (code >= 0x20 && code <= 0x3f) {
          if (this.collected.length < MAX_CSI_PARAM_CHARS) {
            this.collected += String.fromCharCode(code);
          }
          return;
        }
        // A C0 control inside a CSI is EXECUTED and the sequence continues —
        // so this is still not a ground boundary.
        return;

      case 'string':
        if (code === 0x07) {
          this.state = 'ground'; // BEL terminates an OSC
          return;
        }
        if (code === 0x1b) {
          this.state = 'string-esc';
          return;
        }
        if (code === 0x18 || code === 0x1a) {
          this.state = 'ground';
          return;
        }
        // Everything else — INCLUDING `\n` — is string content. This is the
        // whole reason "scan back to the last newline" is not a substitute.
        return;

      case 'string-esc':
        if (code === 0x5c) {
          this.state = 'ground'; // ST (`ESC \`)
          return;
        }
        // The string ended and a fresh escape sequence began.
        this.enterEsc();
        this.stepEsc(code, sink);
        return;

      case 'single-shift':
        // Exactly one character is shifted; whatever it was, we are back.
        this.state = 'ground';
        return;
    }
  }

  private enterEsc(): void {
    this.state = 'esc';
    this.collected = '';
  }

  private stepEsc(code: number, sink?: AnsiScanSink): void {
    if (code === 0x1b) return this.enterEsc();
    if (code === 0x5b) {
      // `[` — CSI
      this.state = 'csi';
      this.collected = '';
      return;
    }
    // `]` OSC, `P` DCS, `X` SOS, `^` PM, `_` APC — all string sequences.
    if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
      this.state = 'string';
      return;
    }
    if (code === 0x4e || code === 0x4f) {
      // `N` SS2 / `O` SS3
      this.state = 'single-shift';
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.state = 'esc-intermediate';
      return;
    }
    if (code >= 0x30 && code <= 0x7e) {
      this.state = 'ground';
      sink?.esc?.(String.fromCharCode(code));
      return;
    }
    // A control byte (or a stray continuation byte) after ESC: xterm executes
    // it and abandons the sequence.
    this.state = 'ground';
  }
}

/**
 * The absolute offset a replay of `text` should actually start at, given that
 * the caller WANTS to start at `target`.
 *
 * Prefers the greatest ground offset **at or before** `target`, because
 * starting earlier only ever replays a few extra bytes the viewer would have
 * applied anyway. Falls back to the smallest ground offset AFTER `target` when
 * nothing earlier is retained — which is the ring's own case: `baseOffset` is
 * the oldest byte in existence, so a partial escape sitting on it can only be
 * skipped, never completed.
 *
 * Returns the end of `text` when the whole retained window is inside one
 * unterminated sequence (a multi-hundred-kilobyte OSC). An empty replay is the
 * honest answer there: every byte in the window is a fragment of something the
 * viewer cannot parse the same way the daemon did.
 */
export function resolveGroundStart(
  text: string,
  textStartOffset: number,
  stateAtStart: AnsiParserState,
  target: number,
): number {
  const scanner = new AnsiScanner();
  scanner.reset(stateAtStart);
  let before = -1;
  let after = -1;
  const end = scanner.feed(text, textStartOffset, {
    ground(offset: number) {
      // Ground offsets arrive in increasing order, so the first one past the
      // target is the smallest one past it.
      if (offset <= target) before = offset;
      else if (after < 0) after = offset;
    },
  });
  if (before >= 0) return before;
  if (after >= 0) return after;
  return end;
}

// ─── Sticky modes ────────────────────────────────────────────────────────────

/** A DECSTBM scroll region, 1-based and inclusive, as the escape spells it. */
export interface ScrollRegion {
  top: number;
  bottom: number;
}

/**
 * SGR state as a set of flags plus two colour code FRAGMENTS.
 *
 * The colours are kept as the literal parameter text that set them (`'31'`,
 * `'38;5;196'`, `'38;2;10;20;30'`) rather than decoded into a palette index or
 * an RGB triple. That is deliberate: re-emitting the exact fragment the agent
 * sent cannot mis-encode a colour, whereas decode-then-re-encode has a wrong
 * answer for every form we failed to anticipate.
 */
export interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  fg: string | null;
  bg: string | null;
}

export const DEFAULT_SGR: SgrState = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  fg: null,
  bg: null,
};

export function sgrIsDefault(s: SgrState): boolean {
  return (
    !s.bold && !s.dim && !s.italic && !s.underline && !s.blink &&
    !s.inverse && !s.invisible && !s.strikethrough && s.fg === null && s.bg === null
  );
}

/**
 * Watches the PTY byte stream for the sticky modes the daemon's own
 * `Terminal` does not expose through its PUBLIC API.
 *
 * ⚠️ SCOPE, AND WHY THIS IS NOT "STATE INFERENCE". This does not look at a
 * rendered screen and guess how it got that way — the thing the raw-replay
 * design exists to eliminate. It reads the identical byte stream the
 * authoritative parser read, and understands exactly four sequence families
 * (DECSTBM, DECTCEM, the alternate-screen DEC private modes, and SGR) plus
 * the two resets that clear them. Anything else it sees, it ignores.
 *
 * It exists only because `@xterm/headless`'s `IModes`/`IBuffer` expose neither
 * the scroll region, nor cursor visibility, nor the current SGR attributes.
 * Where the public API DOES expose a mode, `buildModePrologue` reads it from
 * the terminal instead of from here — see that function.
 */
export class TerminalModeTracker {
  private readonly rows: number;
  private normalRegion: ScrollRegion;
  private altRegion: ScrollRegion;
  private altActive = false;
  private cursorHidden = false;
  private sgr: SgrState = { ...DEFAULT_SGR };

  constructor(rows: number) {
    this.rows = Math.max(1, Math.floor(rows) || 1);
    this.normalRegion = this.fullRegion();
    this.altRegion = this.fullRegion();
  }

  /** Feed this to `AnsiScanner.feed`. */
  readonly sink: AnsiScanSink = {
    csi: (params: string, final: string) => this.onCsi(params, final),
    esc: (final: string) => this.onEsc(final),
  };

  /** The scroll region in force on the named buffer. The caller passes the
   *  buffer the TERMINAL reports as active, so the two sources cannot drift
   *  into reporting a region for a screen that is not showing. */
  regionFor(buffer: 'normal' | 'alternate'): ScrollRegion {
    return buffer === 'alternate' ? this.altRegion : this.normalRegion;
  }

  /** DECTCEM: `CSI ? 25 l` hides, `CSI ? 25 h` shows. Default: visible. */
  get isCursorHidden(): boolean {
    return this.cursorHidden;
  }

  /** The SGR attributes the next printed character would be drawn with. */
  get sgrState(): SgrState {
    return this.sgr;
  }

  /** Whether the tracker believes the alternate screen is active. Only used
   *  to route DECSTBM to the right buffer; the PROLOGUE takes the flag itself
   *  from the terminal. */
  get isAltScreen(): boolean {
    return this.altActive;
  }

  isFullRegion(region: ScrollRegion): boolean {
    return region.top === 1 && region.bottom === this.rows;
  }

  private fullRegion(): ScrollRegion {
    return { top: 1, bottom: this.rows };
  }

  private onEsc(final: string): void {
    if (final === 'c') this.hardReset(); // RIS
  }

  private onCsi(params: string, final: string): void {
    // DECSTR (`CSI ! p`) — a soft reset.
    if (final === 'p' && params === '!') {
      this.softReset();
      return;
    }
    const isPrivate = params.charCodeAt(0) === 0x3f; // '?'
    const body = isPrivate ? params.slice(1) : params;

    if (final === 'h' || final === 'l') {
      // Only DEC PRIVATE modes are tracked here. The ANSI ones this prologue
      // cares about (IRM) are readable from the terminal's public `modes`.
      if (!isPrivate) return;
      const on = final === 'h';
      for (const token of body.split(';')) {
        const n = Number(token);
        if (!Number.isFinite(n)) continue;
        if (n === 25) this.cursorHidden = !on;
        else if (n === 1049 || n === 1047 || n === 47) this.setAltScreen(on);
      }
      return;
    }
    if (final === 'r' && !isPrivate) {
      this.setScrollRegion(body);
      return;
    }
    if (final === 'm' && !isPrivate) {
      this.applySgr(body);
    }
  }

  /**
   * Entering OR leaving the alternate screen resets the ALT buffer's scroll
   * region to the full screen, while the normal buffer's survives the round
   * trip. That is xterm's observed behaviour, and it is why the two regions
   * are tracked separately rather than as one value.
   */
  private setAltScreen(on: boolean): void {
    if (this.altActive === on) return;
    this.altActive = on;
    this.altRegion = this.fullRegion();
  }

  /**
   * DECSTBM. Absent parameters mean "the whole screen"; a bottom past the last
   * row is clamped; a degenerate or inverted region is IGNORED and leaves the
   * previous one in force — all three matching what xterm does with the same
   * bytes.
   */
  private setScrollRegion(body: string): void {
    const parts = body.split(';');
    const rawTop = parts[0] ? Number(parts[0]) : 1;
    const rawBottom = parts.length > 1 && parts[1] ? Number(parts[1]) : this.rows;
    if (!Number.isFinite(rawTop) || !Number.isFinite(rawBottom)) return;
    const top = rawTop < 1 ? 1 : Math.floor(rawTop);
    const bottom = Math.floor(rawBottom > this.rows ? this.rows : rawBottom);
    if (bottom <= top) return;
    const region = { top, bottom };
    if (this.altActive) this.altRegion = region;
    else this.normalRegion = region;
  }

  /** RIS (`ESC c`) — everything back to power-on. */
  private hardReset(): void {
    this.normalRegion = this.fullRegion();
    this.altRegion = this.fullRegion();
    this.altActive = false;
    this.cursorHidden = false;
    this.sgr = { ...DEFAULT_SGR };
  }

  /** DECSTR (`CSI ! p`) — scroll region, cursor visibility and SGR reset; the
   *  active buffer is NOT switched. */
  private softReset(): void {
    this.normalRegion = this.fullRegion();
    this.altRegion = this.fullRegion();
    this.cursorHidden = false;
    this.sgr = { ...DEFAULT_SGR };
  }

  private applySgr(body: string): void {
    const tokens = body === '' ? ['0'] : body.split(';');
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // Colon sub-parameters (`4:3` for curly underline, `38:5:196` for an
      // indexed colour) are a single parameter as far as `;` splitting is
      // concerned, so they are unpacked here rather than in the loop below.
      if (token.includes(':')) {
        this.applySgrSubParam(token);
        continue;
      }
      const n = Number(token === '' ? '0' : token);
      if (!Number.isFinite(n)) continue;
      if (n === 38 || n === 48) {
        i = this.applyExtendedColor(tokens, i, n === 38);
        continue;
      }
      this.applySgrCode(n);
    }
  }

  private applySgrCode(n: number): void {
    switch (true) {
      case n === 0: this.sgr = { ...DEFAULT_SGR }; return;
      case n === 1: this.sgr = { ...this.sgr, bold: true }; return;
      case n === 2: this.sgr = { ...this.sgr, dim: true }; return;
      case n === 3: this.sgr = { ...this.sgr, italic: true }; return;
      // 21 is doubly-underlined in xterm, not "bold off".
      case n === 4 || n === 21: this.sgr = { ...this.sgr, underline: true }; return;
      case n === 5 || n === 6: this.sgr = { ...this.sgr, blink: true }; return;
      case n === 7: this.sgr = { ...this.sgr, inverse: true }; return;
      case n === 8: this.sgr = { ...this.sgr, invisible: true }; return;
      case n === 9: this.sgr = { ...this.sgr, strikethrough: true }; return;
      case n === 22: this.sgr = { ...this.sgr, bold: false, dim: false }; return;
      case n === 23: this.sgr = { ...this.sgr, italic: false }; return;
      case n === 24: this.sgr = { ...this.sgr, underline: false }; return;
      case n === 25: this.sgr = { ...this.sgr, blink: false }; return;
      case n === 27: this.sgr = { ...this.sgr, inverse: false }; return;
      case n === 28: this.sgr = { ...this.sgr, invisible: false }; return;
      case n === 29: this.sgr = { ...this.sgr, strikethrough: false }; return;
      case n === 39: this.sgr = { ...this.sgr, fg: null }; return;
      case n === 49: this.sgr = { ...this.sgr, bg: null }; return;
      case (n >= 30 && n <= 37) || (n >= 90 && n <= 97):
        this.sgr = { ...this.sgr, fg: String(n) };
        return;
      case (n >= 40 && n <= 47) || (n >= 100 && n <= 107):
        this.sgr = { ...this.sgr, bg: String(n) };
        return;
      default:
        // Deliberately unhandled: 10-20 (fonts), 26/50-55 (proportional,
        // framed, overlined), 58/59 (underline colour), 73-75 (super/sub).
        // Not restoring an attribute we do not model is honest; restoring a
        // guessed one is not. Divergence from an unmodelled attribute is what
        // the viewer's integrity check exists to catch.
        return;
    }
  }

  /** `38:5:196`, `48:2::10:20:30`, `4:3`, … */
  private applySgrSubParam(token: string): void {
    const parts = token.split(':');
    const head = Number(parts[0]);
    if (!Number.isFinite(head)) return;
    if (head === 4) {
      // `4:0` is underline off; every other sub-value is some underline style.
      this.sgr = { ...this.sgr, underline: parts[1] !== '0' };
      return;
    }
    if (head === 38 || head === 48) {
      // Re-spell in the semicolon form, dropping the colon form's empty
      // colour-space slot (`38:2::r:g:b`).
      const rest = parts.slice(1).filter((p) => p !== '');
      if (rest.length === 0) return;
      const fragment = `${head};${rest.join(';')}`;
      this.sgr = head === 38 ? { ...this.sgr, fg: fragment } : { ...this.sgr, bg: fragment };
      return;
    }
    this.applySgrCode(head);
  }

  /**
   * `38;5;n` (indexed) / `38;2;r;g;b` (direct), and the same for `48`.
   * Returns the index of the LAST token consumed so the caller's loop resumes
   * after the whole colour, never re-reading a channel value as a new
   * attribute (which is how `38;2;1;7;0` would silently turn on inverse).
   */
  private applyExtendedColor(tokens: string[], i: number, isFg: boolean): number {
    const kind = Number(tokens[i + 1]);
    let consumed: number;
    if (kind === 5) consumed = 2;
    else if (kind === 2) consumed = 4;
    else return i; // malformed — ignore the introducer and keep parsing
    const slice = tokens.slice(i, i + consumed + 1);
    if (slice.length < consumed + 1) return tokens.length; // truncated
    const fragment = slice.join(';');
    this.sgr = isFg ? { ...this.sgr, fg: fragment } : { ...this.sgr, bg: fragment };
    return i + consumed;
  }
}

/**
 * The sticky modes read from the daemon's OWN terminal — the authoritative
 * parser that consumed every byte of the session, including the bytes the ring
 * has since dropped.
 *
 * Every field here comes from `@xterm/headless`'s PUBLIC API
 * (`Terminal.buffer.active.type`, `Terminal.modes`). Nothing in this interface
 * is derived, guessed, or read out of xterm internals.
 */
export interface ObservedTerminalModes {
  /** `Terminal.buffer.active.type === 'alternate'`. */
  altScreen: boolean;
  /** `Terminal.modes.wraparoundMode` (DECAWM). Default ON. */
  wraparound: boolean;
  /** `Terminal.modes.originMode` (DECOM). Default OFF. */
  origin: boolean;
  /** `Terminal.modes.insertMode` (IRM). Default OFF. */
  insert: boolean;
  /** `Terminal.modes.reverseWraparoundMode`. Default OFF. */
  reverseWraparound: boolean;
}

const ESC = '\x1b';

/**
 * A short escape prologue that puts a fresh terminal into the daemon's sticky
 * mode state, to be written IMMEDIATELY BEFORE a truncated raw replay tail.
 *
 * ⚠️ EMIT THIS ONLY WHEN THE REPLAY IS TRUNCATED. When the ring still holds
 * the whole session the replay is self-contained by construction and a
 * prologue is pure risk for no gain — it would be re-asserting state the tail
 * is about to set anyway, and two of these sequences (DECOM, DECSTBM) move the
 * cursor as a side effect.
 *
 * ONLY NON-DEFAULT MODES ARE EMITTED, for that same reason: a viewer's
 * terminal has just been `reset()`, so it is already at power-on defaults, and
 * `CSI ? 6 l` on an already-unset origin mode is not a no-op — it homes the
 * cursor. When the daemon is in a wholly default state this returns `''`.
 *
 * WHAT IS RESTORED, and from where:
 *   - alternate screen        ← the terminal (`buffer.active.type`)
 *   - autowrap (DECAWM)       ← the terminal (`modes.wraparoundMode`)
 *   - origin mode (DECOM)     ← the terminal (`modes.originMode`)
 *   - insert mode (IRM)       ← the terminal (`modes.insertMode`)
 *   - reverse wraparound      ← the terminal (`modes.reverseWraparoundMode`)
 *   - scroll region (DECSTBM) ← `TerminalModeTracker` (NOT on the public API)
 *   - cursor visibility       ← `TerminalModeTracker` (NOT on the public API)
 *   - current SGR             ← `TerminalModeTracker` (NOT on the public API)
 *
 * WHAT IS NOT RESTORED, deliberately:
 *   - the daemon's CURRENT cursor position. The tail replays bytes the daemon
 *     emitted in the PAST, from a cursor position that is also in the past;
 *     homing to where the cursor is NOW would put the tail's first relative
 *     move in the wrong place. The tail's own moves re-establish it.
 *   - the saved cursor (DECSC), character sets (SCS), tab stops, the palette
 *     (OSC 4), and the input-affecting modes (DECCKM, bracketed paste, mouse
 *     reporting) — the last group because this tile has no input path at all.
 *
 * ⚠️ THE ONE CURSOR MOVE THAT IS EMITTED, and why it is not the above. When a
 * SCROLL REGION is in force, the replay must not begin OUTSIDE it. A region
 * confines scrolling to a band of rows; the rows outside that band are static,
 * so anything the replay writes there before it converges stays there
 * FOREVER — the tail will never scroll it away or paint over it. And a fresh
 * terminal starts at row 1, which under a region like `3;10` is exactly one of
 * those static rows.
 *
 * So the prologue parks the cursor at the region's bottom-left. That is not a
 * guess at where the cursor WAS: it is the one thing actually known about it —
 * the output being replayed scrolled within this region, so it was produced
 * with the cursor inside it. Bottom-left is the position from which the first
 * line feed scrolls rather than descending through rows the daemon was not
 * writing to. With no region in force (the common full-screen TUI) nothing is
 * emitted, because then every row scrolls and residue cannot persist.
 *
 * Ordering is load-bearing: the alternate-screen switch comes FIRST because
 * DECSTBM is per-buffer; DECOM comes before the cursor park because setting it
 * homes the cursor; SGR comes LAST because no mode set touches it.
 */
export function buildModePrologue(
  observed: ObservedTerminalModes,
  tracker: TerminalModeTracker,
): string {
  let out = '';
  if (observed.altScreen) out += `${ESC}[?1049h`;

  const region = tracker.regionFor(observed.altScreen ? 'alternate' : 'normal');
  const scoped = !tracker.isFullRegion(region);
  if (scoped) out += `${ESC}[${region.top};${region.bottom}r`;

  if (!observed.wraparound) out += `${ESC}[?7l`;
  if (observed.origin) out += `${ESC}[?6h`;
  if (observed.reverseWraparound) out += `${ESC}[?45h`;
  if (observed.insert) out += `${ESC}[4h`;
  if (tracker.isCursorHidden) out += `${ESC}[?25l`;
  if (scoped) {
    // Bottom-left OF THE REGION — see the header. Under origin mode a CUP row
    // is region-relative, so the same row has two spellings and using the
    // wrong one would park the cursor outside the very band this exists to
    // stay inside.
    const row = observed.origin ? region.bottom - region.top + 1 : region.bottom;
    out += `${ESC}[${row};1H`;
  }

  const sgr = tracker.sgrState;
  if (!sgrIsDefault(sgr)) {
    const codes = ['0'];
    if (sgr.bold) codes.push('1');
    if (sgr.dim) codes.push('2');
    if (sgr.italic) codes.push('3');
    if (sgr.underline) codes.push('4');
    if (sgr.blink) codes.push('5');
    if (sgr.inverse) codes.push('7');
    if (sgr.invisible) codes.push('8');
    if (sgr.strikethrough) codes.push('9');
    if (sgr.fg) codes.push(sgr.fg);
    if (sgr.bg) codes.push(sgr.bg);
    out += `${ESC}[${codes.join(';')}m`;
  }
  return out;
}
