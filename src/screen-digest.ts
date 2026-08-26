/**
 * A cheap, comparable fingerprint of a terminal's VISIBLE SCREEN.
 *
 * ⚠️ MIRRORED IN THE WEBAPP as `webapp/lib/grid/terminal-screen-digest.ts`.
 * The two must produce the SAME string for the same screen or the viewer's
 * integrity check compares apples to oranges and either never fires or fires
 * forever. Change them in the same commit; `screen-digest.test.ts` (here) and
 * `terminal-screen-digest.test.ts` (there) pin the same fixture value from
 * both sides.
 *
 * WHY IT EXISTS. Raw-byte replay makes the viewer's terminal a replica of the
 * daemon's, and the offset arithmetic makes gaps detectable — but neither can
 * PROVE that no byte sequence will ever desync the two parsers. Rather than
 * claim a property that cannot be proved, the design guarantees a weaker one
 * that can: divergence is DETECTED and corrected within a bounded time. This
 * is the detector. The daemon reports the digest of its own screen alongside
 * every poll; the viewer digests its own and compares.
 *
 * DESIGN NOTES, each of which is a bug avoided:
 *
 *   - **Viewport only, addressed from `baseY`.** Not the scrollback: a viewer
 *     seeded from a rolled ring legitimately has less history than the daemon,
 *     and hashing that would report a permanent, uncorrectable mismatch. And
 *     `baseY` rather than `viewportY` so a reader who has scrolled up to read
 *     something does not look like corruption.
 *
 *   - **The documented colour PREDICATES, not `getFgColorMode()`.** The
 *     typings call that number opaque ("can be used to perform quick
 *     comparisons of 2 cells") and point at `isFgRGB`/`isFgPalette`/
 *     `isFgDefault` instead. The two sides of this comparison are two
 *     different xterm builds — `@xterm/headless` in the daemon, `@xterm/xterm`
 *     in the browser — so relying on an opaque constant agreeing across them
 *     is exactly the assumption that would make this detector lie.
 *
 *   - **A 32-bit FNV-1a folded in as we walk**, never a concatenated screen
 *     string. This runs on a poll tick over `cols × rows` cells; building a
 *     ~100 KB string per tick to throw away would be the expensive part.
 *
 *   - **Includes the cursor.** Cursor drift is the defect raw replay was built
 *     to fix and the one a glyph-only comparison cannot see at all.
 *
 * NOT a security primitive: FNV-1a is a hash for detecting accidental
 * divergence between two copies of a screen, not for resisting anyone.
 */

/** The slice of `IBufferCell` this needs. Structural on purpose — it is
 *  satisfied by `@xterm/headless` and `@xterm/xterm` alike, and by a hand-built
 *  fake in a test. */
export interface DigestCell {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): boolean | number;
  isFgPalette(): boolean | number;
  isFgRGB(): boolean | number;
  isBgDefault(): boolean | number;
  isBgPalette(): boolean | number;
  isBgRGB(): boolean | number;
  isBold(): boolean | number;
  isDim(): boolean | number;
  isItalic(): boolean | number;
  isUnderline(): boolean | number;
  isInverse(): boolean | number;
  isStrikethrough(): boolean | number;
}

/** The slice of `IBufferLine` this needs. */
export interface DigestLine {
  readonly length: number;
  getCell(x: number): DigestCell | undefined;
}

/** The slice of `Terminal` this needs. */
export interface DigestTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly baseY: number;
      readonly cursorX: number;
      readonly cursorY: number;
      readonly type: string;
      getLine(y: number): DigestLine | undefined;
    };
  };
}

/**
 * Field separators, spelled as escapes rather than written as raw bytes.
 *
 * They must be characters that CANNOT occur in the data being folded, or a
 * screen could collide with a different screen that happens to contain the
 * separator as a glyph — a space would do exactly that, since a blank cell
 * hashes as `' '`. NUL and SOH are never cell contents, so the field boundaries
 * are unambiguous.
 *
 * ⚠️ Part of the cross-package fixture. Changing either value changes every
 * digest, in both mirrors, and invalidates the pinned test value.
 */
const SEP = '\u0000';
const FIELD = '\u0001';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Fold a string into a running FNV-1a 32-bit hash. Operates on UTF-16 code
 *  units, which is fine: both sides hash the same JS strings. */
function fold(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function flags(cell: DigestCell): number {
  return (
    (cell.isBold() ? 1 : 0) |
    (cell.isDim() ? 2 : 0) |
    (cell.isItalic() ? 4 : 0) |
    (cell.isUnderline() ? 8 : 0) |
    (cell.isInverse() ? 16 : 0) |
    (cell.isStrikethrough() ? 32 : 0)
  );
}

function colorKey(
  isDefault: boolean | number,
  isPalette: boolean | number,
  isRgb: boolean | number,
  color: number,
): string {
  // In default mode the colour NUMBER is meaningless (the typings say "should
  // be 0"; the runtime reports -1), so it is normalised away — otherwise two
  // identically-rendered default cells would hash differently.
  if (isDefault) return 'd';
  if (isRgb) return `r${color}`;
  if (isPalette) return `p${color}`;
  return `?${color}`;
}

/**
 * An 8-hex-character digest of the terminal's visible screen and cursor.
 *
 * Returns a stable string for a stable screen, and (with overwhelming
 * likelihood) a different one for any screen that differs in a glyph, an
 * attribute, a colour, the grid size, the active buffer, or the cursor.
 */
export function screenDigest(term: DigestTerminal): string {
  const buffer = term.buffer.active;
  let h = FNV_OFFSET_BASIS;
  h = fold(h, `${term.cols}x${term.rows}|${buffer.type}|${buffer.cursorX},${buffer.cursorY}`);
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    if (!line) {
      h = fold(h, `${SEP}~${SEP}`);
      continue;
    }
    h = fold(h, SEP);
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell) {
        h = fold(h, '~');
        continue;
      }
      // Width 0 is the right half of a wide glyph; its content already came
      // out of the width-2 cell before it. Hashing it too would double-count
      // every CJK character and emoji.
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      h = fold(h, chars === '' ? ' ' : chars);
      h = fold(h, `${FIELD}${width}${FIELD}${flags(cell)}${FIELD}`);
      h = fold(h, colorKey(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor()));
      h = fold(h, colorKey(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor()));
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
